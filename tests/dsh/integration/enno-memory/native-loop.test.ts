import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareRepeatedWorkspace, ennoScript, fixturePlanReview, waitFor } from '../../helpers/repeated-memory-native.js'
import { nativeMock } from '../../helpers/native-mock.js'
import { modelSelectionAnswer, mockModelRoutes, openaiModels } from '../../helpers/model-selection.js'
import { createDshHostAdapter } from '../../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../../src/dsh/composition.js'
import { openConnection } from '../../../../src/db/connection.js'
import { recordEntry } from '../../../../src/memory/entries.js'
import { resolveProjectWorkspace } from '../../../../src/memory/workspaces.js'
import { readRefreshMetadata } from '../../../../src/dsh/enno-memory-refresh-store.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packages) throw new Error('ennoMemory native coverage requires the pinned DSH package runtime')
for (const mode of ['off', 'observe', 'active'] as const) test(`native preStep and boundary worker: ${mode}, new failure, repeated call, compaction, invalidation and terminal`, {
  skip: packages ? false : 'requires pinned DSH packages', timeout: 60000,
}, async t => {
  const modules = await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href)))
  const [cordis, llm, session, projection, systemPrompt, tools, agents, loop, skills] = modules
  const root = await realpath(await mkdtemp(join(tmpdir(), 'enno-refresh-native-')))
  await prepareRepeatedWorkspace(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'enno-memory-fixture', version: '1.0.0', devDependencies: { typescript: '5.9.3' } }))
  const db = openConnection(join(root, '.git/state.sqlite3'))
  const a = recordEntry(db, { workspace: 'repeated-memory', kind: 'reference', title: 'QUEUE_TEST_BASELINE', body: 'General verification reference.', createdBy: 'fixture', scope: { visibility: 'project' } })
  const b = recordEntry(db, { workspace: 'repeated-memory', kind: 'lesson', title: 'E_LOCK_TIMEOUT', body: 'FIFO_ONLY: release latch after quiescence. DO_NOT_APPLY_TO_DAMAGE.', createdBy: 'fixture', scope: { visibility: 'project' } })
  const global = recordEntry(db, { workspace: 'global', kind: 'lesson', title: 'E_LOCK_TIMEOUT global guidance', body: 'GLOBAL_FIFO_ONLY: inspect contention.', createdBy: 'fixture',
    scope: { schemaVersion: 3, visibility: 'global', retrievalScope: 'global', portableReason: 'General runtime diagnostic' } })
  const otherRoot = await mkdtemp(join(tmpdir(), 'enno-refresh-neighbor-'))
  const other = (await resolveProjectWorkspace(db, otherRoot, { allowDirectory: true }))!
  const ecosystem = recordEntry(db, { workspace: other.workspace, kind: 'lesson', title: 'E_LOCK_TIMEOUT ecosystem guidance', body: 'ECOSYSTEM_FIFO_ONLY: verify queue assumptions.', createdBy: 'fixture',
    scope: { schemaVersion: 3, visibility: 'project', retrievalScope: 'ecosystem', applicability: { runtimes: ['Node.js'] }, signals: { errors: ['E_LOCK_TIMEOUT'] } } })
  const privateEntry = recordEntry(db, { workspace: other.workspace, kind: 'lesson', title: 'E_LOCK_TIMEOUT', body: 'PRIVATE_MUST_NEVER_APPEAR', createdBy: 'fixture', scope: { visibility: 'project' } })
  const ctx = new cordis.Context(), fibers: any[] = [], errors: string[] = [], script: any[] = []
  ctx.on('agent/error', (event: any) => errors.push(String(event.error?.stack ?? event.error)))
  for (const plugin of [llm,session,projection,systemPrompt,tools,agents,skills]) fibers.push(await ctx.plugin(plugin.default, plugin === systemPrompt ? { persona: '' } : undefined))
  fibers.push(await ctx.plugin(loop.default, { agents: [] }))
  const mock = nativeMock(llm), provider = new mock.MockAdapter(script, ['mock', ...openaiModels])
  ctx.llm.registerAdapter(['mock'], provider)
  let calls = 0, beforeFull = 0, runId = '', agent: any, invalidationBlocked = false
  const disposeTool = ctx.tools.register(tools.defineTool({ name: 'fail_queue', description: 'Return a deterministic fixture failure.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true }, stderr: { type: 'string', required: true } } }, render: (_: unknown, value: any) => [{ type: 'text', text: value.stderr }] },
    execute: async () => { calls++; beforeFull = readRefreshMetadata(db, runId)?.fullCount ?? 0; return { exitCode: 1, stderr: 'E_LOCK_TIMEOUT' } } }))
  fibers.push(await ctx.plugin({ name: 'refresh-fixture-questions', apply(context: any) { return context.provide('userQuestions', { async ask(request: any) {
    return { answers: request.questions.map((q: any) => {
      if (/^(boundary-|loop-|effect-)/u.test(q.id)) throw new Error(`Unexpected workflow hold: ${q.id}: ${q.detail}`)
      return { id: q.id, selected: [q.id === 'kiokuko-plan-confirmation' ? 'approve' : modelSelectionAnswer(q) ?? 'debug'] }
    }) }
  } }) } }))
  const adapter = createDshHostAdapter(ctx, { repositoryRoot: root, databasePath: join(root, '.git/state.sqlite3'), orca: { enabled: false },
    modelRoutes: mockModelRoutes, efficiency: { observe: true }, ennoMemory: { mode, localBudgetMs: 1000 },
    advisory: { verifyReadOnly: () => true, execute: async call => ({ slotId: call.slotId, outcome: 'completed', summary: 'Reviewed fixture contract.', recommendations: [], risks: [], evidence: [] }) },
    llm: { async *stream(request) {
      const review = fixturePlanReview(request)
      if (!review) throw new Error('Finalization is outside this refresh fixture')
      yield { type: 'text-delta', text: JSON.stringify(review) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } })
  const composition = await mountDshComposition(ctx, adapter.host)
  const memory = (request: any, id: string) => request.messages.filter((message: any) => message.source?.kind === 'plugin:kiokuko-dsh'
    && message.source.sections?.some((section: any) => section.name === `memory:memory:${id}`))
  const checkedRequest = (request: any, expected: boolean) => {
    assert.equal(memory(request, b.id).length, expected ? 1 : 0, JSON.stringify({ b: b.id, memory: request.messages.filter((m: any) => m.source?.kind === 'plugin:kiokuko-dsh' && m.source.sections?.some((s: any) => s.name.startsWith('memory:'))), observations: adapter.host.efficiency!.snapshot().ennoMemory.slice(-2) }))
    assert.equal(memory(request, privateEntry.id).length, 0)
    if (expected) {
      assert.match(JSON.stringify(memory(request, b.id)), /FIFO_ONLY.*DO_NOT_APPLY_TO_DAMAGE/s)
      assert.equal(memory(request, global.id).length, 1, 'global origin delivery')
      assert.equal(memory(request, ecosystem.id).length, 1, 'ecosystem origin delivery')
    }
  }
  const controls = ennoScript(mock, 1, true)
  let reviewCall = 0
  const reviewBefore = (step: any): any => {
    let resultId = '', attempts = 0
    const call = (args: object) => mock.toolCallResponse(resultId = `memory-review-${++reviewCall}`, 'task_memory_review', args)
    const inspect = (request: any): any => {
      const result = request.messages.flatMap((message: any) => message.content ?? [])
        .findLast((block: any) => block.type === 'tool-result' && block.toolCallId === resultId)
      assert.ok(++attempts <= 64, 'memory disposition must converge within the bounded refresh budget')
      if (result?.isError && /Memory delivery changed/.test(JSON.stringify(result))) {
        script.unshift(inspect)
        return call({ action: 'status' })
      }
      assert.ok(result && !result.isError, JSON.stringify(result))
      const status = JSON.parse(result.content.find((block: any) => block.type === 'text').text)
      const missing = status.items.find((item: any) => item.problem && item.problem !== 'entry_changed')
      if (missing) {
        script.unshift(inspect)
        return call({ action: 'review', review: { generation: status.generation, entryId: missing.entryId, entryRevision: missing.revision,
          expectedRevision: missing.reviewRevision, decision: 'not_applicable', paths: ['fixtures'],
          basis: 'This fixture returns fixed diagnostic failures and does not execute the recalled queue repair procedures.' } })
      }
      return typeof step === 'function' ? step(request) : step
    }
    return () => { script.unshift(inspect); return call({ action: 'status' }) }
  }
  script.push((request: any) => { checkedRequest(request, false); return controls[0] }, ...controls.slice(1, 5),
    (request: any) => {
      runId = db.prepare("SELECT run_id AS id FROM ledger_runs WHERE status='active' AND dsh_session_id='refresh-parent'").get<{id:string}>()!.id
      checkedRequest(request, false)
      return mock.toolCallResponse('failure-1', 'fail_queue', {})
    },
    (request: any) => {
      checkedRequest(request, mode === 'active')
      assert.equal(readRefreshMetadata(db, runId)?.fullCount ?? 0, beforeFull + (mode === 'active' ? 1 : 0))
      return mock.toolCallResponse('failure-2', 'fail_queue', {})
    },
    (request: any) => {
      checkedRequest(request, mode === 'active'); assert.equal(readRefreshMetadata(db, runId)?.fullCount ?? 0, beforeFull)
      for (const seq of [...agent.session.surface.nodes]) {
        const event = agent.session.eventAt(seq)
        if (!event?.data?.source?.sections?.some((s: any) => s.name === `memory:memory:${b.id}`)) continue
        const replacement = llm.createUserMessage({ content: [{ type: 'text', text: 'Compacted.' }], source: { kind: 'plugin:test-compaction' } })
        agent.session.append('user/message', replacement, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
      return mock.toolCallResponse('failure-3', 'fail_queue', {})
    },
    (request: any) => {
      checkedRequest(request, mode === 'active'); assert.equal(readRefreshMetadata(db, runId)?.fullCount ?? 0, beforeFull)
      db.prepare("UPDATE entries SET status='superseded',superseded_by=? WHERE id=?").run(a.id, b.id)
      return mock.toolCallResponse('failure-4', 'fail_queue', {})
    },
    (request: any) => {
      checkedRequest(request, false)
      if (mode === 'active') {
        const result = request.messages.flatMap((message: any) => message.content ?? [])
          .findLast((block: any) => block.type === 'tool-result' && block.toolCallId === 'failure-4')
        assert.equal(result?.isError, true, 'a superseded delivered memory must block further execution')
        assert.match(JSON.stringify(result), /resolve memory decisions/)
        invalidationBlocked = true
        agent.cancel({ kind: 'user' })
        return mock.textResponse('Invalidated memory requires a new review before further execution.')
      }
      return controls[5]
    }, ...controls.slice(6), mock.textResponse('REFRESH_FIXTURE_COMPLETE'))
  // Read-only disposition calls preserve the native effect and completion gates.
  for (let index = 1; index < script.length - 1; index++) script[index] = reviewBefore(script[index])
  try {
    agent = await ctx.agentLoop.create(session.SessionId('refresh-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const task = '役小角を使って QUEUE_TEST_BASELINE のテストを修正してください。read paths: fixtures\nwrite paths: fixtures\n完了条件: 検証して報告'
    agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }))
    await waitFor(() => {
      if (errors.length) throw new Error(errors.join('\n'))
      return agent.status === 'idle' && (invalidationBlocked || agent.session.snapshotEvents().some((e: any) => e.type === 'assistant/message' && JSON.stringify(e.data).includes('REFRESH_FIXTURE_COMPLETE')))
    }, 'enno memory native completion')
    assert.equal(calls, mode === 'active' ? 3 : 4)
    const observations = adapter.host.efficiency!.snapshot().ennoMemory
    assert.ok(observations.every(o => o.embeddingCalls === 0 && o.remoteCalls === 0 && o.llmCalls === 0))
    assert.equal(db.prepare("SELECT status FROM enno_contracts WHERE run_id=?").get(runId)?.status, mode === 'active' ? 'goki_executing' : 'completed')
    assert.ok(db.prepare("SELECT 1 FROM dsh_boundary_jobs WHERE run_id=? AND kind='context' AND status='completed'").get(runId), 'actual persistent worker context stage ran')
    assert.ok(agent.session.snapshotEvents().some((e: any) => e.type === 'user/message' && e.data?.source?.kind === 'user' && e.data.content[0]?.text === task))
    if (mode === 'active') assert.ok(observations.some(o => o.reason === 'focus_changed' && o.decision === 'full'))
    if (mode === 'off') assert.equal(observations.length, 0)
    t.diagnostic(JSON.stringify({ mode, calls, requests: provider.requests.length, observations: observations.map(o => ({ decision: o.decision, reason: o.reason, fullSearchCount: o.fullSearchCount, totalMs: o.totalMs })) }))
  } finally {
    composition.stopIngress(); await adapter.dispose(); await composition.dispose(); disposeTool()
    for (const fiber of fibers.reverse()) await fiber?.dispose?.()
    db.close(); await rm(otherRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true })
  }
})
