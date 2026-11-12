import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDshDatabasePath } from '../../../src/dsh/paths.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { fixtureDefinition, interpretedPreparation, toolValue } from '../helpers/coding-script.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT

for (const forceColor of [false, true])
for (const explicit of [false, true]) for (const unavailable of [false, true]) test(
  `native coding record (${explicit ? 'adapter' : 'public'}, ${unavailable ? 'initial record unavailable' : 'no plan'}, FORCE_COLOR ${forceColor ? 'on' : 'unset'}): failure and repair`,
  { timeout: 60000 }, async () => {
  const f = await nativeSkillFixture({ startupChoice: 'decision OFF / Lisp OFF', packages,
    ...(packageRoot ? { packageRoot } : {}), explicit, mode: 'compiled', extra: {
      lisp: { enabled: false }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
      memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
      deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' },
    } })
  const request = 'Implement src/parser.mjs so the command prints 42. 通常実行で。'
  const command = 'node --test --test-reporter=tap parser-output.test.mjs'
  const repairedSource = "console.log('42')\n"
  const legacy = fixtureDefinition()
  legacy.items[0]!.criterionIds.push(legacy.goal.criterionIds[0]!)
  legacy.items[0]!.goalCriterionIds = []
  const path = explicit ? join(f.dir, 'state.sqlite3') : getDshDatabasePath()
  const changeRecordAvailability = (sql: string) => {
    const db = openConnection(path)
    try { db.exec(sql) } finally { db.close() }
  }
  try {
    await writeFile(join(f.dir, 'parser-output.test.mjs'), `
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

test('parser prints 42', () => {
  const env = { ...process.env }
  delete env.FORCE_COLOR
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  if (${forceColor}) env.FORCE_COLOR = '1'
  const output = execFileSync(process.execPath, ['src/parser.mjs'], { encoding: 'utf8', env })
  assert.equal(output.trim(), '42', 'parser output mismatch')
})
`)
    if (unavailable) changeRecordAvailability(`CREATE TRIGGER test_record_unavailable
      BEFORE INSERT ON dsh_coding_workflows BEGIN SELECT RAISE(ABORT, 'test record unavailable'); END`)
    const call = (id: string, name: string, args: object) => f.mock.toolCallResponse(id, name, args)
    f.responses.push(
      interpretedPreparation(f.mock, 'prepare', 'new', 'change'),
      call('initial-write', 'kioku_write', { path: 'src/parser.mjs', content: "console.log('41')\n" }),
      call('failed-check', 'kioku_exec', { command }),
      (request: any) => {
        const failed = toolValue(request, 'failed-check')
        assert.equal(failed.exitCode, 1, failed.output)
        assert.match(failed.output, /parser output mismatch/u)
        return call('repair', 'kioku_write', { path: 'src/parser.mjs', content: repairedSource })
      },
      (request: any) => {
        assert.equal(toolValue(request, 'repair').applied, true)
        return call('passed-check', 'kioku_exec', { command })
      },
      (request: any) => {
        const passed = toolValue(request, 'passed-check')
        assert.equal(passed.exitCode, 0, passed.output)
        return call('observed', 'coding_workflow', { action: 'status' })
      },
      (request: any) => {
        const state = toolValue(request, 'observed')
        assert.equal(state.definition, undefined)
        assert.notEqual(state.assessment?.verified, true, 'observed executions are not formal verification on their own')
        assert.equal(state.applicable, !unavailable)
        const failedRef = toolValue(request, 'failed-check').receipt.evidenceRef
        assert.ok(state.observations.some((entry: any) =>
          entry.ref === failedRef && entry.tool === 'kioku_exec' && entry.exitCode === 1), JSON.stringify(state.observations))
        assert.ok(state.observations.some((entry: any) => entry.tool === 'kioku_write' && entry.ref.startsWith('native:')),
          'status projects the current turn’s native tool events as well as durable owned receipts')
        const ref = toolValue(request, 'passed-check').receipt.evidenceRef
        assert.ok(state.observations.some((entry: any) =>
          entry.ref === ref && entry.tool === 'kioku_exec' && entry.exitCode === 0), JSON.stringify(state.observations))
        if (unavailable) changeRecordAvailability('DROP TRIGGER test_record_unavailable')
        return call('note', 'coding_workflow_apply', { action: 'annotate', notes: 'The command passed after fixing the output.', evidenceRefs: [ref] })
      },
      call('noted', 'coding_workflow', { action: 'status' }),
      (request: any) => {
        const note = toolValue(request, 'note')
        assert.equal(note.recorded, true)
        assert.equal(note.annotation.evidenceRefs.length, 1)
        return call('legacy', 'coding_workflow_apply', { action: 'propose', expectedRevision: toolValue(request, 'noted').revision, definition: legacy })
      },
      (request: any) => {
        assert.deepEqual(nativeToolResults(request.messages).filter(result => result.isError && result.toolCallId !== 'failed-check'), [])
        const state = toolValue(request, 'legacy')
        assert.deepEqual(state.definition.items[0].goalCriterionIds, [])
        assert.equal(state.annotation.id, toolValue(request, 'note').annotation.id)
        assert.equal(state.assessment.verified, false)
        return f.mock.textResponse('The command now prints 42. The formal checks in the optional record are unbound.')
      },
    )
    let providerCalls=0
    const stopCounting=f.ctx.on('llm/stream',async function*(options:any,next:any){if(f.llm.isAgentLoopRequest(options))providerCalls++;yield*next()})
    await f.turn(request)
    const executionEvents=()=>f.agent.session.snapshotEvents().filter((event:any)=>['turn/start','turn/end','step/start','step/end','request/header','tool/result'].includes(event.type))
    const completedEvents=executionEvents().length,completedCalls=providerCalls
    await new Promise(resolve=>setTimeout(resolve,40))
    await f.agent.whenIdle()
    stopCounting()
    assert.ok(completedCalls>0)
    assert.equal(providerCalls,completedCalls,'finished coding must not restart the provider')
    assert.equal(executionEvents().length,completedEvents,'finished coding must not create another turn or tool effect')
    assert.equal(f.agent.status,'idle')
    assert.equal(f.agent.inbox.nextTurn.length+f.agent.inbox.nextStep.length,0)
    assert.equal(f.agent.session.snapshotEvents().filter((e:any)=>e.type==='turn/end').at(-1).data.reason.kind,'completed')
    assert.equal(await readFile(join(f.dir, 'src/parser.mjs'), 'utf8'), repairedSource)
    const db = openConnection(path)
    try {
      const run = db.prepare('SELECT status FROM ledger_runs').get<{status: string}>()
      assert.equal(run?.status, 'active', 'repair is usable, but its declared completion checks remain unverified')
      const snapshot = JSON.parse(db.prepare('SELECT snapshot_json FROM dsh_coding_workflows').get<{snapshot_json: string}>()!.snapshot_json)
      assert.equal(snapshot.request, request)
      assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_owned_operations').get()?.n, 4)
      assert.equal(db.prepare("SELECT evidence_required FROM dsh_completion_runs WHERE mode='shadow'").get()?.evidence_required, 1)
    } finally { db.close() }
  } finally { await f.close() }
})
