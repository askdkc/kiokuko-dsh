import nativeTest, { type TestOptions } from 'node:test'
import { withRepeatedReport, recordRepeatedStage } from '../helpers/repeated-memory-report.js'
// @ts-expect-error Shared runner manifest is an ESM script.
import { repeatedMemoryScenarios } from '../../../scripts/repeated-memory-scenarios.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { execFile, execFileSync, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRepeatedWorkspace, repeatedNativeHost, fixtureData, type RoundReport } from '../helpers/repeated-memory-native.js'
import { readEntry, updateCandidateEntry } from '../../../src/memory/entries.js'
import { configureEvolution } from '../../../src/memory/evolution/store.js'
import { repeatedDeepHost, completeDeepRound } from '../helpers/repeated-deep-native.js'
import { openConnection } from '../../../src/db/connection.js'

const requestedScenario = process.env.KIOKUKO_REPEATED_SCENARIO
if (requestedScenario && !repeatedMemoryScenarios.includes(requestedScenario)) throw new Error('Unknown required lifecycle scenario')
const registered = new Set<string>()
const test = (title: string, options: TestOptions, operation: () => Promise<void>) => {
  const name = title.replace('repeated memory lifecycle: ', '')
  registered.add(name)
  return nativeTest(title, options, () => withRepeatedReport(name, operation))
}

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packages) throw new Error('Repeated lifecycle requires the pinned published DSH runtime')

for (const [kind, mode] of [['evolution','prefix_reuse'],['evolution','bounded_evidence'],['deep','dedicated']] as const) {
  const name = kind === 'deep' ? 'deep/dispatched-interruption' : `normal/${mode}/dispatched-interruption`
  if (process.env.KIOKUKO_REPEATED_SCENARIO && process.env.KIOKUKO_REPEATED_SCENARIO !== name) continue
  test(`repeated memory lifecycle: ${name}`, { skip: packages ? false : 'requires pinned native DSH', timeout: 300_000 }, async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(),'repeated-interruption-')))
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
    const args = (round: number) => ['--import','tsx','tests/dsh/helpers/repeated-interruption-process.ts',root,kind,mode,String(round)]
    try {
      if (kind === 'evolution') await prepareRepeatedWorkspace(root)
      await promisify(execFile)(process.execPath, args(1), { env, timeout: 60000, maxBuffer: 1024 * 1024 })
      const dispatched = await new Promise<{runId:string;jobId?:string}>((resolve, reject) => {
        const child = fork('tests/dsh/helpers/repeated-interruption-process.ts', [root,kind,mode,'2'], { execArgv: ['--import','tsx'], env, stdio: ['ignore','pipe','pipe','ipc'] })
        let notification: {runId:string;jobId?:string} | undefined, output = ''
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Dispatched interruption stage exceeded 60 seconds')) }, 60000)
        child.stderr?.on('data', data => { output = (output + String(data)).slice(-4096) })
        child.on('message', (message: any) => {
          if (message?.kind !== 'dispatched') return
          notification = message; child.kill('SIGKILL')
        })
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          if (notification && signal === 'SIGKILL') resolve(notification)
          else reject(new Error(`The fixture did not stop after dispatch: ${code}/${signal}: ${output}`))
        })
      })
      const dbPath = kind === 'deep' ? join(root,'.git','deep-state','state.sqlite3') : join(root,'.git','state.sqlite3')
      const before = openConnection(dbPath)
      try {
        const state = kind === 'deep' ? before.prepare('SELECT status FROM dsh_deep_finalizations WHERE run_id=?').get<{status:string}>(dispatched.runId)?.status
          : before.prepare('SELECT state AS status FROM memory_evolution_jobs WHERE id=?').get<{status:string}>(dispatched.jobId!)?.status
        assert.equal(state, 'processing', 'kill occurs strictly after dispatch and before result adoption')
      } finally { before.close() }
      await promisify(execFile)(process.execPath, args(3), { env, timeout: 60000, maxBuffer: 1024 * 1024 })
      recordRepeatedStage(JSON.parse(await readFile(join(root,'.git','interruption-1.json'),'utf8')))
      recordRepeatedStage({ round: 2, stage: 'durable-dispatch-before-kill', actual: 'processing', expected: 'processing', runId: dispatched.runId })
      recordRepeatedStage(JSON.parse(await readFile(join(root,'.git','interruption-3.json'),'utf8')))
      const db = openConnection(dbPath)
      try {
        if (kind === 'deep') {
          const job = db.prepare('SELECT status,error FROM dsh_deep_finalizations WHERE run_id=?').get<{status:string;error:string}>(dispatched.runId)!
          recordRepeatedStage({ round: 2, stage: 'restart-recovery', actual: job.status, expected: 'uncertain', automaticResends: 0 })
          assert.equal(job.status,'uncertain'); assert.match(job.error,/no automatic resend/u)
          assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_deep_finalizations').get<{n:number}>()!.n,3)
          assert.equal(db.prepare('SELECT count(*) AS n FROM memory_episodes').get<{n:number}>()!.n,0)
        } else {
          const job = db.prepare('SELECT state,reason,claim_token,lease_until FROM memory_evolution_jobs WHERE id=?').get<{state:string;reason:string;claim_token:string|null;lease_until:string|null}>(dispatched.jobId!)!
          recordRepeatedStage({ round: 2, stage: 'restart-recovery', actual: job.state, expected: 'held', reason: job.reason, automaticResends: 0 })
          assert.equal(job.state,'held'); assert.equal(job.reason,'expired_dispatched_claim'); assert.equal(job.claim_token,null); assert.equal(job.lease_until,null)
          assert.equal(db.prepare('SELECT count(*) AS n FROM memory_evolution_calls WHERE job_id=?').get<{n:number}>(dispatched.jobId!)!.n,1)
          assert.equal(db.prepare("SELECT count(*) AS n FROM dsh_memory_finalizations WHERE status='completed'").get<{n:number}>()!.n,4)
        }
      } finally { db.close() }
    } finally { await rm(root,{recursive:true,force:true}) }
  })
}

for (const scenario of ['same-session','restart'] as const) {
  const name = `deep/${scenario}`
  if (process.env.KIOKUKO_REPEATED_SCENARIO && process.env.KIOKUKO_REPEATED_SCENARIO !== name) continue
  test(`repeated memory lifecycle: ${name}`, { skip: packages ? false : 'requires pinned native DSH', timeout: 300_000 }, async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'repeated-deep-')))
    let f: Awaited<ReturnType<typeof repeatedDeepHost>> | undefined
    try {
      if (scenario === 'same-session') f = await repeatedDeepHost(root, [1,2,3], 'deep-repeated-session')
      const reports = []
      for (let round = 1; round <= 3; round++) {
        if (f) reports.push(await completeDeepRound(f, round))
        else {
          const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
          await promisify(execFile)(process.execPath, ['--import','tsx','tests/dsh/helpers/repeated-deep-process.ts',root,String(round)], { env, timeout: 60000, maxBuffer: 1024 * 1024 })
          const report = JSON.parse(await readFile(join(root,'.git',`deep-round-${round}.json`),'utf8'))
          reports.push(report); recordRepeatedStage(report)
        }
      }
      assert.equal(new Set(reports.map(report => report.runId)).size, 3)
      assert.equal(new Set(reports.map(report => report.memory)).size, 3)
    } finally { await f?.close(); await rm(root, { recursive: true, force: true }) }
  })
}

for (const route of ['normal', 'enno'] as const) for (const mode of ['prefix_reuse', 'bounded_evidence'] as const) for (const scenario of ['same-session', 'new-session', 'restart'] as const) {
  const name = `${route}/${mode}/${scenario}`
  if (process.env.KIOKUKO_REPEATED_SCENARIO && process.env.KIOKUKO_REPEATED_SCENARIO !== name) continue
  test(`repeated memory lifecycle: ${name}`, { skip: packages ? false : 'requires pinned native DSH', timeout: 300_000 }, async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'repeated-memory-')))
    let host: Awaited<ReturnType<typeof repeatedNativeHost>> | undefined
    const rounds: RoundReport[] = []
    try {
      await prepareRepeatedWorkspace(root)
      if (scenario !== 'restart') host = await repeatedNativeHost(root, mode, route)
      for (let round = 1; round <= 4; round++) {
        if (scenario === 'restart') {
          const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
          await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/dsh/helpers/repeated-memory-process.ts', root, mode, route, String(round)], { env, timeout: 60_000, maxBuffer: 1024 * 1024 })
          const report = JSON.parse(await readFile(join(root, '.git', `round-${round}.json`), 'utf8'))
          rounds.push(report); recordRepeatedStage(report)
        } else rounds.push(await host!.round(round, scenario === 'same-session' ? 'repeated-session' : `repeated-${round}`, round === 4))
        assert.equal(new Set(rounds.map(value => value.runId)).size, round)
        for (const prior of rounds.slice(0, -1)) if (prior.session === rounds.at(-1)!.session) assert.ok(prior.end < rounds.at(-1)!.start, 'log ranges overlap in one session')
      }
      assert.equal(rounds[2]!.episodes, 3)
      assert.equal(rounds[2]!.lessons, 1)
      assert.equal(rounds[3]!.finalizations, 4)
      assert.equal(rounds[3]!.auxiliaryCalls, 1, 'read-only retrieval must not generate extra model calls')
      if (host) {
        const derivedIds = await host.database(db => db.prepare('SELECT DISTINCT entry_id FROM memory_derivations').all<{entry_id:string}>().map(row => row.entry_id))
        for (const [index, setting] of ['observe', 'off'].entries()) {
          await host.database(db => configureEvolution(db, setting as 'observe' | 'off'))
          await host.round(5 + index, scenario === 'same-session' ? 'repeated-session' : `negative-${setting}`, true, false, { forbiddenIds: derivedIds })
        }
      }
    } finally {
      await host?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const mode of ['prefix_reuse','bounded_evidence'] as const) for (const scenario of ['duplicate-completion','save-failure','correction','adoption-source','adoption-mode','adoption-lease'] as const) {
  const name = `normal/${mode}/${scenario}`
  if (process.env.KIOKUKO_REPEATED_SCENARIO && process.env.KIOKUKO_REPEATED_SCENARIO !== name) continue
  test(`repeated memory lifecycle: ${name}`, { skip: packages ? false : 'requires pinned native DSH', timeout: 300_000 }, async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'repeated-memory-fault-')))
    let host: Awaited<ReturnType<typeof repeatedNativeHost>> | undefined
    try {
      await prepareRepeatedWorkspace(root); host = await repeatedNativeHost(root, mode, 'normal')
      let offset = 0
      let forbiddenIds: string[] = []
      if (scenario === 'correction') {
        for (let n = 1; n <= 3; n++) await host.round(n, 'correction-prelude', false, false)
        offset = 3
        forbiddenIds = await host.database(db => db.prepare("SELECT entry_id FROM memory_derivations WHERE kind='positive'").all<{entry_id:string}>().map(row => row.entry_id))
        assert.equal(forbiddenIds.length, 1, 'correction prelude must generate its lesson through native execution')
        await host.round(4, 'correction-probe', true, true)
        offset = 4
      } else if (scenario.startsWith('adoption-')) {
        await host.round(1, 'adoption-prelude', false, false); offset = 1
      }
      const rounds: RoundReport[] = []
      const reviseSource = () => host!.database(db => {
        const source = db.prepare('SELECT entry_id FROM dsh_memory_finalization_entries ORDER BY rowid LIMIT 1').get<{entry_id:string}>()!
        const entry = readEntry(db, { workspace: 'repeated-memory', entryId: source.entry_id })
        updateCandidateEntry(db, { workspace: entry.workspace, entryId: entry.id, expectedRevision: entry.revision, kind: entry.kind, title: entry.title,
          body: 'The prior source was corrected: this procedure is inapplicable.', summary: null, scope: entry.scope, provenance: entry.provenance, tags: entry.tags })
      })
      for (let n = 1; n <= 3; n++) {
        if (n === 2 && scenario === 'correction') await reviseSource()
        if (n === 2 && scenario.startsWith('adoption-')) host.setAuxiliaryHook(async request => {
          if (!request.system?.startsWith('Select a conservative reusable lesson')) return
          if (scenario === 'adoption-source') await reviseSource()
          if (scenario === 'adoption-mode') await host!.database(db => configureEvolution(db, 'observe'))
          if (scenario === 'adoption-lease') await host!.database(db => db.prepare("UPDATE memory_evolution_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE state='processing'").run())
        })
        rounds.push(await host.round(offset + n, 'fault-session', false, false, {
          saveFailure: n === 2 && scenario === 'save-failure', duplicateCompletion: n === 2 && scenario === 'duplicate-completion',
          ...(n >= 2 && scenario === 'correction' ? { forbiddenIds } : {}),
        }))
        if (n === 2 && scenario.startsWith('adoption-')) {
          const job: {state:string;reason:string} | undefined = await host.database(db => db.prepare('SELECT state,reason FROM memory_evolution_jobs').get<{state:string;reason:string}>())
          assert.equal(job?.state, 'held')
          assert.equal(job?.reason, scenario === 'adoption-source' ? 'evolution_stale_or_conflicting' : 'evolution_stale_claim')
          assert.equal(await host.database(db => db.prepare("SELECT count(*) AS n FROM memory_derivations WHERE kind='positive'").get<{n:number}>()!.n), 0)
          host.setAuxiliaryHook(undefined)
          await host.database(db => configureEvolution(db, 'active'))
        }
      }
      assert.equal(new Set(rounds.map(round => round.runId)).size, 3)
      for (let n = 1; n < rounds.length; n++) assert.ok(rounds[n - 1]!.end < rounds[n]!.start)
      if (scenario === 'correction') await host.round(offset + 4, 'fault-session', true, false, { forbiddenIds })
      if (scenario === 'duplicate-completion' || scenario === 'save-failure') await host.round(4, 'fault-session', true, true)
    } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
  })
}

for (const mode of ['prefix_reuse','bounded_evidence'] as const) for (const scenario of ['stale-revision','stale-lease'] as const) {
  const name = `enno/${mode}/${scenario}`
  if (requestedScenario && requestedScenario !== name) continue
  test(`repeated memory lifecycle: ${name}`, { skip: packages ? false : 'requires pinned native DSH', timeout: 300_000 }, async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'repeated-enno-fence-')))
    let host: Awaited<ReturnType<typeof repeatedNativeHost>> | undefined
    try {
      await prepareRepeatedWorkspace(root); host = await repeatedNativeHost(root, mode, 'enno')
      for (let round = 1; round <= 4; round++) await host.round(round, 'enno-fence-session', round === 4, round === 4,
        round === 2 ? { staleAuthority: scenario === 'stale-revision' ? 'revision' : 'lease' } : {})
    } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
  })
}

for (const mode of ['prefix_reuse','bounded_evidence'] as const) {
  const name = `normal/${mode}/upgrade`
  if (requestedScenario && requestedScenario !== name) continue
  test(`repeated memory lifecycle: ${name}`, { skip: packages ? false : 'requires pinned native DSH', timeout: 300_000 }, async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'repeated-upgrade-')))
    let host: Awaited<ReturnType<typeof repeatedNativeHost>> | undefined
    try {
      const { upgradeRepeatedWorkspace } = await import('../helpers/repeated-memory-upgrade.js')
      const deliveryId = await upgradeRepeatedWorkspace(root, mode)
      host = await repeatedNativeHost(root, mode, 'normal')
      const rounds = []
      for (let round = 1; round <= 4; round++) rounds.push(await host.round(round, 'upgraded-session', round === 4))
      assert.equal(new Set(rounds.map(round => round.runId)).size, 4)
      assert.equal(rounds[2]!.episodes, 3); assert.equal(rounds[2]!.lessons, 1)
      assert.equal(await host.database(db => db.prepare('SELECT policy_version FROM context_deliveries WHERE delivery_id=?').get<{policy_version:string}>(deliveryId)!.policy_version), 'context-ranking-v6')
    } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
  })
}

assert.deepEqual([...registered].sort(), (requestedScenario ? [requestedScenario] : [...repeatedMemoryScenarios]).sort(), 'every required scenario must be registered exactly once')
