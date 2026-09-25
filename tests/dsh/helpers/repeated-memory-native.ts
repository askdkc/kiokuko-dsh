import { recordRepeatedStage } from './repeated-memory-report.js'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { nativeMock } from './native-mock.js'
import { mockModelRoutes, modelSelectionAnswer, openaiModels } from './model-selection.js'
import type { FinalizationInputMode } from '../../../src/dsh/efficiency.js'
import type { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'
import { readContextDelivery } from '../../../src/context/delivery.js'
import { reportEnnoWork } from '../../../src/enno-oduno/service.js'

export const PROCEDURE = 'validate schema before migrating'
export const APPLICABILITY = 'SQLITE_BUSY in fixture-store fixture-v1 only'
export const BOUNDARY = 'Do not apply to production or fixture-v2'
export const UNRESOLVED = 'Concurrent writers remain untested'
export const VERIFICATION = 'The fixture schema and row checksum were verified'
export type RepeatedRoute = 'normal' | 'enno'
export interface RoundFault { saveFailure?: boolean; duplicateCompletion?: boolean; forbiddenIds?: readonly string[]; staleAuthority?: 'revision' | 'lease' }
export interface RoundReport { round: number; runId: string; session: string; start: number; end: number; mainCalls: number; auxiliaryCalls: number; planReviewCalls: number; toolExecutions: number; suppliedIds: string[]; finalizations: number; episodes: number; lessons: number; stages: string[] }
export const fixtureData = ['account rows: Ada, Ken; schema accounts(email)', 'inventory rows: bolt, nut, washer; schema parts(sku, quantity)', 'audit rows: created, revised, reviewed, approved; schema events(actor, action, time)']
const applicationPaths = fixtureData.map((_, index) => `fixtures/${index}.txt`)
const applicationCommand = `${process.execPath} fixtures/verify.mjs`

export async function prepareRepeatedWorkspace(root: string, migrationsDirectory?: string): Promise<void> {
  execFileSync('git', ['init', '-q', root])
  await mkdir(join(root, 'fixtures'), { recursive: true })
  for (const [index, data] of fixtureData.entries()) await writeFile(join(root, 'fixtures', `${index}.txt`), data)
  await writeFile(join(root, 'fixtures', 'verify.mjs'), `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nconst expected = ${JSON.stringify(fixtureData)};\nfor (const [index, value] of expected.entries()) assert.equal(readFileSync(new URL(index + '.txt', import.meta.url), 'utf8'), value);\n`)
  const databasePath = join(root, '.git', 'state.sqlite3')
  await initializeDatabase({ databasePath, ...(migrationsDirectory ? { migrationsDirectory } : {}) })
  const db = openConnection(databasePath)
  try { registerRepositoryAndLocation(db, { repositoryId: 'repeated-memory', workspace: 'repeated-memory', displayName: 'Repeated lifecycle', canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 }) }
  finally { db.close() }
}

export async function deadline<T>(promise: PromiseLike<T>, label: string, milliseconds = 60_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Stage deadline exceeded: ${label}`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const expires = Date.now() + 60_000
  while (!await check()) {
    if (Date.now() >= expires) throw new Error(`Stage deadline exceeded: ${label}`)
    // Poll authoritative state; elapsed time is never evidence of completion.
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export async function repeatedNativeHost(root: string, inputMode: FinalizationInputMode, route: RepeatedRoute, options: { now?: () => string } = {}) {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT!
  const [cordis,llm,session,projection,systemPrompt,tools,agents,loop,skills] = await Promise.all(
    ['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill'].map(name => import(pathToFileURL(join(packages,'@deepseek-ai',name === 'cordis' ? name : `dsh-${name}`,'lib/index.js')).href)))
  const ctx = new cordis.Context(), fibers: any[] = [], script: any[] = []
  const nativeErrors: string[] = []
  ctx.on('agent/error', (event: any) => { nativeErrors.push(String(event.error?.stack ?? event.error ?? 'native agent failed')) })
  const mock = nativeMock(llm), provider = new mock.MockAdapter(script, ['mock', ...openaiModels])
  provider.resolveModel = async (provider: string, model: string) => ({ provider, id: model, name: model, context: { contextWindow: 100000 } })
  let auxiliaryCalls = 0, planReviewCalls = 0, toolExecutions = 0, activeRound = 0
  let auxiliaryHook: ((request: any) => Promise<void>) | undefined
  let activeFault: RoundFault = {}, activeSession = ''
  for (const plugin of [llm,session,projection,systemPrompt,tools,agents,skills]) fibers.push(await ctx.plugin(plugin.default, plugin === systemPrompt ? { persona: '' } : undefined))
  fibers.push(await ctx.plugin(loop.default, { agents: [] }))
  ctx.llm.registerAdapter(['mock'], provider)
  const disposeApplicationVerifier = ctx.tools.register(tools.defineTool({ name: 'Bash', description: 'Run only the disposable fixture regression verifier.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => {
      assert.equal(args.command, applicationCommand)
      await promisify(execFile)(process.execPath, ['fixtures/verify.mjs'], { cwd: root, timeout: 5000 })
      return { exitCode: 0 }
    } }))
  const disposeTool = ctx.tools.register(tools.defineTool({ name: 'verify_migration', description: 'Validate a disposable fixture schema and checksum.',
    parameters: { fixture: { type: 'number', required: true }, procedure: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true }, observation: { type: 'string', required: true } } },
      render: (_args: unknown, result: any) => [{ type: 'text', text: result.observation }] },
    execute: async (args: any) => {
      assert.equal(args.procedure, PROCEDURE)
      assert.ok(Number.isSafeInteger(args.fixture) && args.fixture >= 0 && args.fixture < fixtureData.length)
      const content = await readFile(join(root, 'fixtures', `${args.fixture}.txt`), 'utf8')
      assert.equal(content, fixtureData[args.fixture])
      const checksum = createHash('sha256').update(content).digest('hex').slice(0, 16)
      const observation = `${VERIFICATION}: ${content}; checksum ${checksum}; ${APPLICABILITY}`
      await writeFile(join(root, 'fixtures', `${args.fixture}.verified`), observation)
      toolExecutions++
      if (activeFault.staleAuthority) {
        const agent = liveAgents.get(activeSession)!
        const binding = await adapter.host.toolHost!.bind({ callId: `late-report-${activeRound}`, name: 'enno_work_report', arguments: {}, signal: new AbortController().signal, agent: { dshSessionId: activeSession, nativeSession: agent.session } })
        assert.ok(binding.revision > 1 && binding.leaseToken && binding.workUnitId)
        await database(async db => {
          const before = db.prepare('SELECT * FROM enno_contracts WHERE run_id=?').get(binding.runId)
          const calls = db.prepare('SELECT count(*) AS n FROM enno_verifier_runs').get<{n:number}>()!.n
          await assert.rejects(reportEnnoWork(db, { runId: binding.runId, workspace: binding.workspace, orchestrationId: binding.orchestrationId,
            expectedRevision: activeFault.staleAuthority === 'revision' ? binding.revision - 1 : binding.revision,
            routeEpoch: binding.routeEpoch, leaseToken: activeFault.staleAuthority === 'lease' ? `expired-${binding.leaseToken}` : binding.leaseToken,
            workUnitId: binding.workUnitId, idempotencyKey: `stale-${activeRound}`, result: { outcome: 'completed', summary: VERIFICATION, mutated: false, changedPaths: [] } }),
          (error: any) => error.code === 'CONFLICT')
          assert.deepEqual(db.prepare('SELECT * FROM enno_contracts WHERE run_id=?').get(binding.runId), before)
          assert.equal(db.prepare('SELECT count(*) AS n FROM enno_verifier_runs').get<{n:number}>()!.n, calls)
        })
        recordRepeatedStage({ round: activeRound, stage: `enno-stale-${activeFault.staleAuthority}`, expected: 'rejected-without-mutation', actual: 'rejected-without-mutation', extraVerifierCalls: 0 })
      }
      return { exitCode: 0, observation }
    } }))
  fibers.push(await ctx.plugin({ name: 'repeated-memory-questions', apply(context: any) {
    return context.provide('userQuestions', { async ask(request: any) {
      return { answers: request.questions.map((question: any) => {
        if (/^(boundary-|loop-|effect-)/u.test(question.id)) throw new Error(`Unexpected workflow hold: ${question.id}: ${question.detail}`)
        const selected = question.id === 'kioku-orca-recording' ? '記録しない' : question.id === 'kiokuko-plan-confirmation' ? 'approve'
          : modelSelectionAnswer(question) ?? 'debug'
        return { id: question.id, selected: [selected] }
      }) }
    } })
  } }))
  const adapter = createDshHostAdapter(ctx, { repositoryRoot: root, databasePath: join(root, '.git', 'state.sqlite3'),
    ...options,
    modelRoutes: mockModelRoutes, orca: { enabled: false }, efficiency: { observe: true }, finalization: { inputMode },
    advisory: { verifyReadOnly: () => true, execute: async call => ({ slotId: call.slotId, outcome: 'completed', summary: 'Reviewed the immutable fixture contract.', recommendations: [], risks: [], evidence: [] }) },
    llm: { async *stream(request) {
      auxiliaryCalls++
      const review = fixturePlanReview(request)
      if (review) {
        planReviewCalls++
        yield { type: 'text-delta', text: JSON.stringify(review) }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      await auxiliaryHook?.(request)
      const last = (request.messages.at(-1) as any).content[0].text as string
      const reconciliation=last.startsWith('{"reconciliation"')?JSON.parse(last).reconciliation:undefined
      const prompt = reconciliation ? (request.messages.at(-2) as any).content[0].text as string : last
      let response: unknown
      if (request.system?.startsWith('Select a conservative reusable lesson')) {
        const input = JSON.parse(prompt)
        const episodes = Array.isArray(input) ? input : input.episodes
        const draft = episodes[0].draft
        response = { applicability: draft.applicability, procedure: draft.procedure, verification: draft.verification, boundary: draft.boundary, evidence: episodes.map((episode: any) => episode.runId), conflict: false }
      } else {
        const evidence = prompt.includes('schemaVersion:2') ? JSON.parse(prompt.split('\n\n').at(-1)!) as any[] : []
        const action = evidence.find(item => item.kind === 'action' && item.text.includes(PROCEDURE))
        const result = evidence.find(item => item.kind === 'result' && item.outcome === 'passed' && (item.actionSeq === undefined || item.actionSeq === action?.seq))
        const episode = action && result ? { goal: 'Validate a fixture migration', applicability: APPLICABILITY,
          anchors: { error: 'SQLITE_BUSY', tool: 'verify_migration', target: 'fixture-store', version: 'fixture-v1' },
          events: [{ kind: 'action', description: action.text, evidence: [action.seq] }, { kind: 'verification', description: result.text, evidence: [result.seq] }],
          procedure: PROCEDURE, verification: VERIFICATION, boundary: BOUNDARY, unresolved: [UNRESOLVED], avoidance: null } : evidence.length ? {
          goal: 'Read previous observations', applicability: 'Read-only probe', anchors: { error: 'unknown', tool: 'unknown', target: 'unknown', version: 'unknown' },
          events: [], procedure: 'No procedure executed', verification: 'No new verification', boundary: BOUNDARY, unresolved: [UNRESOLVED], avoidance: null,
        } : undefined
        response = { schemaVersion: episode ? 2 : 1, memories: [{ kind: 'reference', title: `Fixture observation ${activeRound}`,
          body: result?.text ?? `Read-only lifecycle check ${activeRound}`, summary: null, tags: ['fixture-v1'], confidence: 0.5 }], ...(episode ? { episode } : {}) }
      }
      if(reconciliation){const capsule=response as any;response={schemaVersion:3,memoryOperations:capsule.memories.map((m:any)=>({action:'add',kind:m.kind,title:m.title,body:m.body,evidenceIds:[reconciliation.evidence.at(-1).id]})),...(capsule.episode?{episode:capsule.episode}:{})}}
      yield { type: 'text-delta', text: JSON.stringify(response) }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } })
  const composition = await mountDshComposition(ctx, adapter.host)
  const liveAgents = new Map<string, any>()
  const database = <T>(operation: (db: import('../../../src/db/adapter.js').SqliteDatabase) => T) => adapter.host.runtime!.withDatabase(operation)

  // Scripted agents must use the same native disposition protocol as real agents.
  // Inspect the tool result delivered to the model, never write review rows directly.
  let applicationCall = 0
  const withMemoryReview = (step: any, readonly: boolean, verifyNow: boolean): any => {
    let resultId = '', verified = false, reviews = 0
    const call = (name: string, args: object) => mock.toolCallResponse(resultId = `application-${activeRound}-${++applicationCall}`, name, args)
    const start = () => { script.unshift(inspect); return call('task_memory_review', { action: 'status' }) }
    const inspect = (request: any): any => {
      const result = request.messages.flatMap((message: any) => message.role === 'tool' && message.toolCallId === resultId
        ? [message]
        : (message.content ?? []).filter((block: any) => block.type === 'tool-result' && block.toolCallId === resultId))
        .at(-1)
      assert.ok(result && !result.isError, `Native memory review failed: ${JSON.stringify(result)}`)
      const status = JSON.parse(result.content.find((block: any) => block.type === 'text').text)
      const unresolved = status.items.find((item: any) => item.problem && item.problem !== 'verification_missing_failed_or_stale')
      if (unresolved) {
        assert.ok(++reviews <= 128, 'memory disposition did not converge')
        script.unshift(inspect)
        return call('task_memory_review', { action: 'review', review: {
          generation: status.generation, entryId: unresolved.entryId, entryRevision: unresolved.revision, expectedRevision: unresolved.reviewRevision,
          decision: readonly ? 'not_applicable' : 'adopted', paths: [...applicationPaths, 'fixtures/verify.mjs'],
          basis: readonly ? 'This request only inspects stored observations; no migration procedure is executed.' : 'The current fixture schema and rows are defined by the three fixture source files.',
          ...(readonly ? {} : { invariant: 'Each fixture retains its expected schema and row contents.', counterexample: 'Changing a fixture schema or row must fail verification.',
            method: 'Execute the fixture verifier against all current source files.', command: applicationCommand }),
        } })
      }
      if (!status.ready && verifyNow) {
        assert.equal(verified, false, `Native verification did not satisfy the obligation: ${JSON.stringify(status)}`)
        verified = true
        script.unshift(start)
        return call('Bash', { command: applicationCommand })
      }
      return typeof step === 'function' ? step(request) : step
    }
    return start
  }

  const executeRound = async (number: number, sessionId: string, readonly = false, expectLesson = number === 4, fault: RoundFault = {}): Promise<RoundReport> => {
    activeRound = number
    activeFault = fault; activeSession = sessionId
    let agent = liveAgents.get(sessionId)
    if (!agent) { agent = await ctx.agentLoop.create(session.SessionId(sessionId), { provider: 'mock', model: 'mock' }, { cwd: root }); liveAgents.set(sessionId, agent) }
    const beforeMain = provider.requests.length, beforeAux = auxiliaryCalls, beforeReview = planReviewCalls, beforeTools = toolExecutions
    const prior = await database(db => db.prepare('SELECT run_id FROM ledger_runs').all<{run_id:string}>())
    if (fault.saveFailure) await database(db => db.exec(`CREATE TEMP TRIGGER repeated_fail_before_commit BEFORE UPDATE OF status ON dsh_memory_finalizations
      WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'injected memory commit failure'); END;`))
    const response = `Completed fixture lifecycle ${number}.`
    const task = `${route === 'normal' ? '通常実行で' : '役小角を使って'}、${APPLICABILITY}。${readonly ? '読み取りのみで過去の観測を確認' : `fixtures/${(number - 1) % 3}.txt を検証`}してください。${BOUNDARY}。依頼 ${number}。`
    if (route === 'enno') script.push(...ennoScript(mock, number, readonly).map(step => {
      const name = step.find((chunk: any) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block.name
      return ['enno_ideal_submit', 'enno_work_report', 'enno_finish', 'enno_meditation_submit'].includes(name) ? withMemoryReview(step, readonly, false) : step
    }))
    else {
      if (!readonly) script.push(withMemoryReview(mock.toolCallResponse(`verify-${number}`, 'verify_migration', { fixture: (number - 1) % 3, procedure: PROCEDURE }), false, false))
    }
    script.push(route === 'normal' ? withMemoryReview(mock.textResponse(response), readonly, true) : mock.textResponse(response))
    agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }))
    await waitFor(() => {
      if (nativeErrors.length) throw new Error(`${nativeErrors.join('\n')}\nRecent tool results: ${JSON.stringify(agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result').slice(-8).map((event: any) => event.data))}`)
      return agent.status === 'idle' && agent.session.snapshotEvents().some((event: any) => event.type === 'assistant/message' && event.data.message.content.some((block: any) => block.text === response))
    }, 'native final response')
    await deadline(ctx.sessions.flush(agent.session), 'native log flush')
    await adapter.host.checkpointSessionMirror!(agent.session)
    const close = await adapter.host.resolveSessionClose!(agent.session.id, agent.session)
    if (close) await adapter.host.lifecycle!.closeTurn({ ...close, sourceEndSeq: agent.session.snapshotEvents().findLast((event: any) => event.type === 'turn/end').seq })
    await deadline(adapter.host.memoryFinalizer!.whenIdle(), 'memory and evolution workers')
    if (fault.saveFailure) {
      const failed = await database(db => {
        const row = db.prepare("SELECT run_id,attempt_count FROM dsh_memory_finalizations WHERE status='failed'").get<{run_id:string;attempt_count:number}>()
        assert.ok(row, 'the injected pre-commit failure must be observed'); assert.equal(row.attempt_count, 1)
        assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_memory_finalization_entries WHERE run_id=?').get<{n:number}>(row.run_id)!.n, 0)
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_episodes WHERE run_id=?').get<{n:number}>(row.run_id)!.n, 0)
        assert.equal(db.prepare("SELECT count(*) AS n FROM entry_revisions WHERE json_extract(provenance_json,'$.runId')=?").get<{n:number}>(row.run_id)!.n, 0)
        db.exec('DROP TRIGGER repeated_fail_before_commit')
        return row.run_id
      })
      await (adapter.host.memoryFinalizer as DshMemoryFinalizer).retryFailed(failed)
      await deadline(adapter.host.memoryFinalizer!.whenIdle(), 'explicit finalization retry')
      assert.equal(auxiliaryCalls - beforeAux - (planReviewCalls - beforeReview), 2, 'one failed extraction plus one authorized retry')
    }
    const state = await database(db => {
      const runs = db.prepare('SELECT run_id,status,dsh_session_id FROM ledger_runs').all<{run_id:string;status:string;dsh_session_id:string}>().filter(run => !prior.some(old => old.run_id === run.run_id))
      assert.equal(runs.length, 1, 'one logical request must create exactly one run')
      const run = runs[0]!
      assert.equal(run.status, 'completed', JSON.stringify({number,run,results:agent.session.snapshotEvents().filter((event:any)=>event.type==='tool/result').slice(-8).map((event:any)=>event.data)})); assert.equal(run.dsh_session_id, sessionId)
      const job = db.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get<any>(run.run_id)
      assert.equal(job?.status, 'completed', JSON.stringify(job))
      assert.equal(job.episode_error, null, JSON.stringify(job))
      assert.equal(job.input_mode, inputMode); assert.equal(job.evidence_selection_version, 2)
      assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_memory_finalization_entries WHERE run_id=?').get<{n:number}>(run.run_id)!.n, 1)
      assert.equal(db.prepare("SELECT count(*) AS n FROM dsh_memory_finalizations WHERE status IN ('pending','processing')").get<{n:number}>()!.n, 0)
      assert.equal(db.prepare("SELECT count(*) AS n FROM memory_evolution_jobs WHERE state IN ('pending','processing')").get<{n:number}>()!.n, 0)
      const episodes = db.prepare('SELECT episode_json FROM memory_episodes').all<{episode_json:string}>()
      const lessons = db.prepare("SELECT entry_id FROM memory_derivations WHERE kind='positive'").all<{entry_id:string}>()
      if (!readonly) assert.ok(episodes.some(row => JSON.parse(row.episode_json).runId === run.run_id), 'native execution must create its episode')
      return { run, job, episodes, lessons, finalizations: db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get<{n:number}>()!.n }
    })
    const requests = provider.requests.slice(beforeMain)
    assert.equal(planReviewCalls - beforeReview, route === 'enno' ? 3 : 0, 'each Enno plan must complete all three check-model review slots')
    // Old disposition calls retain entry IDs as native audit history, not fresh
    // memory delivery. Keep checking all other content and this round's status.
    const currentMemoryRequests = JSON.stringify(requests, (_key, value) => {
      const id = value?.type === 'tool-call' ? value.id : value?.type === 'tool-result' || value?.role === 'tool' ? value.toolCallId : undefined
      return typeof id === 'string' && id.startsWith('application-') && !id.startsWith(`application-${number}-`) ? undefined : value
    })
    for (const id of fault.forbiddenIds ?? []) assert.ok(!currentMemoryRequests.includes(id), 'invalidated or disabled derived memory reached a current native model request')
    if (fault.duplicateCompletion) {
      const calls = auxiliaryCalls
      await adapter.host.lifecycle!.closeTurn({ runId: state.run.run_id, status: 'completed', sourceEndSeq: state.job.source_end_seq })
      await deadline(adapter.host.memoryFinalizer!.whenIdle(), 'duplicate completion settlement')
      assert.equal(auxiliaryCalls, calls, 'duplicate completion must not dispatch an extraction')
      assert.equal(await database(db => db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get<{n:number}>()!.n), state.finalizations)
    }
    const suppliedIds = new Set<string>()
    for (const request of requests) for (const message of request.messages) {
      for (const section of message.source?.sections ?? []) if (section.name.startsWith('memory:memory:')) suppliedIds.add(section.name.slice('memory:memory:'.length))
    }
    if (expectLesson) {
      assert.ok(state.lessons.length > 0, `three independent native observations must generate a positive lesson: ${JSON.stringify(await database(db=>({jobs:db.prepare('SELECT state,reason,model_json FROM memory_evolution_jobs').all(),skips:db.prepare('SELECT reason FROM memory_evolution_skips').all(),signals:state.episodes.map(row=>{const e=JSON.parse(row.episode_json);return {signature:e.signature,digest:e.evidenceDigest,successful:e.successful,procedureSupported:e.procedureSupported}})})))}`)
      const requestText = JSON.stringify(requests)
      for (const text of [PROCEDURE, APPLICABILITY, BOUNDARY, UNRESOLVED, VERIFICATION]) assert.ok(requestText.includes(text), `native request lost ${text}`)
      assert.match(requestText, /Unverified|未検証/u)
      assert.ok(state.lessons.some(lesson => requestText.includes(lesson.entry_id)), 'the actual native model request must contain the lesson source')
    }
    // Receipts are checked against the actual message text, never synthetic byte estimates.
    await database(db => {
      for (const row of db.prepare('SELECT delivery_id FROM context_deliveries WHERE run_id=?').all<{delivery_id:string}>(state.run.run_id)) {
        const delivery = readContextDelivery(db, { workspace: 'repeated-memory', deliveryId: row.delivery_id })
        assert.ok(delivery.charCount <= delivery.charBudget)
        for (const item of delivery.items) {
          assert.equal(item.projection?.sourceRevision, item.entryRevision)
          assert.ok(item.projection?.textDigest)
          assert.ok(requests.some(request => request.messages.some((message: any) => message.content?.some((block: any) => block.type === 'text' && createHash('sha256').update(block.text).digest('hex') === item.projection!.textDigest))), `delivery receipt must match actual native request text (round ${number}, entry ${item.entryId})`)
        }
      }
    })
    assert.equal(script.length, 0, 'no unconsumed or repeated main model requests')
    assert.equal(toolExecutions - beforeTools, readonly ? 0 : 1)
    const report = { round: number, runId: state.run.run_id, session: sessionId, start: state.job.source_start_seq, end: state.job.source_end_seq,
      mainCalls: requests.length, auxiliaryCalls: auxiliaryCalls - beforeAux, planReviewCalls: planReviewCalls - beforeReview, toolExecutions: toolExecutions - beforeTools,
      suppliedIds: [...suppliedIds], finalizations: state.finalizations, episodes: state.episodes.length, lessons: state.lessons.length,
      stages: ['admission', 'native-execution', 'final-response', 'log-flush', 'memory-finalization', 'episode/evolution', 'durable-state', 'model-request'] }
    recordRepeatedStage(report)
    return report
  }
  const round = (...args: Parameters<typeof executeRound>) => deadline(executeRound(...args), `complete lifecycle ${args[0]}`)
  return { round, database, adapter, provider, setAuxiliaryHook: (hook: typeof auxiliaryHook) => { auxiliaryHook = hook },
    close: async () => { composition.stopIngress(); await adapter.dispose(); await composition.dispose(); disposeTool(); disposeApplicationVerifier(); for (const fiber of fibers.reverse()) await fiber?.dispose?.() } }
}

export function ennoScript(mock: ReturnType<typeof nativeMock>, round: number, readonly = false): any[] {
  const dispositions = (slots: string[]) => slots.map(slotId => ({ slotId, disposition: 'adopted', rationale: 'Applied the fixture evidence.' }))
  const ideal = dispositions(['constraint_guardian','skill_trust_analyst','success_signal_critic'])
  const planning = dispositions(['workunit_architect','protocol_risk_reviewer','verification_designer'])
  const final = dispositions(['acceptance_auditor','regression_adversary','evidence_freshness_reviewer'])
  const verifier = { id: 'fixture-check', kind: 'test', executable: process.execPath, args: ['fixtures/verify.mjs'], cwd: '.', timeoutMs: 5000 }
  const plan = {
    executionHints: [], scope: ['fixtures'], exclusions: [], acceptanceCriteria: [{ id: 'verified', description: VERIFICATION }],
    workPlan: { objective: PROCEDURE, units: [{ id: 'verify-fixture', objective: PROCEDURE, scope: ['fixtures'], dependencies: [], routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'], expertRefs: [{ id: 'code.verification.v1', reason: 'Verify source evidence.' }], acceptanceCriteria: [VERIFICATION], focusedVerifiers: [verifier] }] },
    skillRequirements: [], finalVerifiers: [verifier], maxAttempts: 3,
    provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'inferred' } }
  return [mock.textResponse('The ideal is ready.'), mock.toolCallResponse(`ideal-${round}`, 'enno_ideal_submit', {
    ideal: { objective: 'Validate the requested disposable fixture.', principles: ['Preserve the source data.'], skillContributions: [], successSignals: [VERIFICATION] }, advisoryDisposition: ideal }),
  mock.textResponse('The plan is ready.'), mock.toolCallResponse(`review-${round}`, 'enno_plan_review', plan),
  mock.toolCallResponse(`plan-${round}`, 'enno_plan_submit', { ...plan, advisoryDisposition: planning }),
  ...(readonly ? [] : [mock.toolCallResponse(`verify-${round}`, 'verify_migration', { fixture: (round - 1) % 3, procedure: PROCEDURE })]),
  mock.toolCallResponse(`work-${round}`, 'enno_work_report', { result: { outcome: 'completed', summary: VERIFICATION, mutated: false, changedPaths: [] } }),
  mock.toolCallResponse(`finish-${round}`, 'enno_finish', { advisoryDisposition: final, review: { decision: 'accept', summary: VERIFICATION } }),
  mock.toolCallResponse(`meditate-${round}`, 'enno_meditation_submit', { meditation: { summary: 'All fixture evidence remains applicable only to fixture-v1.', inspectedPaths: ['fixtures'], deletionCandidates: [] } })]
}

/** Answer only the real no-tool plan-review protocol; memory extraction uses its own fixture. */
export function fixturePlanReview(request: Parameters<import('../../../src/dsh/session-memory-finalizer.js').DshLlm['stream']>[0]) {
  if (!request.system?.startsWith('Review the entire candidate plan')) return undefined
  assert.equal(request.provider, 'mock')
  assert.equal(request.model, 'gpt-6-astra')
  assert.deepEqual(request.tools, [])
  const payload = JSON.parse((request.messages[0] as { content: { text: string }[] }).content[0]!.text)
  assert.ok(['workunit_architect', 'protocol_risk_reviewer', 'verification_designer'].includes(payload.slotId))
  assert.equal(payload.context.phase, 'planning')
  assert.ok(payload.context.candidate.workPlan.units.length > 0)
  return { slotId: payload.slotId, outcome: 'completed', summary: 'Reviewed the complete fixture plan.', recommendations: [], risks: [], evidence: [] }
}
