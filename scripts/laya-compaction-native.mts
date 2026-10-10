import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeMock } from '../tests/dsh/helpers/native-mock.js'
import { SemanticCompactionCoordinator } from '../src/dsh/semantic-compaction/coordinator.js'
import { selectCandidates, worthwhile } from '../src/dsh/semantic-compaction/policy.js'
import { verifyLosslessCandidate } from '../src/dsh/semantic-compaction/lossless.js'
import type { DecisionService } from '../src/dsh/decisions/service.js'

export interface EvaluationFixture { id: string; family: string; language: 'en' | 'ja'; task: string; body: string; tool: string; constraints: string }

/** Actual native services; scripted generation captures requests and is never graded as quality. */
export async function captureCompactionArm(fixture: EvaluationFixture, arm: 'original' | 'deterministic' | 'laya', service: DecisionService, signal: AbortSignal) {
  // The evaluation contract pins its own fixture, independently of a CI matrix's runtime override.
  const packages = join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href)
  const [cordis, llm, sessions, projection, prompt, tools, registry, loop, meter, compaction] = await Promise.all(
    ['cordis', 'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'token-meter', 'compaction-basic'].map(load))
  const version = JSON.parse(await readFile(join(packages, '@deepseek-ai/dsh-compaction-basic/package.json'), 'utf8')).version
  const expected = JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/dsh-runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
  if (version !== expected) throw new Error(`Native evaluation runtime mismatch: expected ${expected}, got ${version}`)
  const ctx = new cordis.Context(), fibers: any[] = [], mock = nativeMock(llm)
  class Capture extends mock.MockAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 16000 } } }
  }
  const provider = new Capture([mock.textResponse('Request capture only; task quality is unmeasured.')])
  let handle: any, coordinator: SemanticCompactionCoordinator | undefined
  try {
    for (const plugin of [llm, sessions, projection, prompt, tools, registry, meter]) fibers.push(await ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined))
    fibers.push(await ctx.plugin(loop.default, { agents: [] }))
    // Fixed native configuration across arms, below summary pressure so summaries cannot inflate savings.
    fibers.push(await ctx.plugin(compaction.default, { thresholdRatio: .8, retainTokens: 150 }))
    ctx.llm.registerAdapter(['capture'], provider)
    handle = await ctx.agents.create({ sessionId: sessions.SessionId(`evaluation-${fixture.id}`), agentOptions: { provider: 'capture', model: 'mock' }, meta: { cwd: process.cwd() } })
    const session = handle.agent.session
    const user = (id: string, text: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    for (let index = 0; index < 6; index++) session.append('user/message', user(`initial-${index}`, 'Pinned requirements.'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'call', role: 'assistant', source: { kind: 'model', provider: 'capture', model: 'mock' }, content: [{ type: 'tool-call', id: 'read-1', name: fixture.tool, arguments: '{"path":"frozen.log"}' }] } }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn: 1, step: 1, callId: 'read-1', name: fixture.tool, arguments: '{"path":"frozen.log"}' })
    session.append('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'read-1' }, content: [{ type: 'tool-result', toolCallId: 'read-1', content: [{ type: 'text', text: fixture.body }], isError: false }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    for (let index = 0; index < 6; index++) session.append('user/message', user(`recent-${index}`, 'Pinned recent evidence.'), { surfaceOp: 'append' })
    for (let index = 0; index < 2; index++) session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: `exposed-${index}`, role: 'assistant', source: { kind: 'model', provider: 'capture', model: 'mock' }, content: [{ type: 'text', text: 'Completed exposure before TODO boundary.' }] } }, { surfaceOp: 'append' })
    session.append('todo/write', { todos: [{ content: 'Inspect frozen log', status: 'in_progress' }, { content: fixture.task, status: 'pending' }] })
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('request/header', { header: { config: { provider: 'capture', model: 'mock' } }, reason: 'initial' })
    const requestNativeEstimated: number[] = []
    ctx.on('llm/stream', (_request: unknown, next: () => AsyncIterable<unknown>) => { requestNativeEstimated.push(ctx.tokenMeter.measure(session).totalTokens); return next() })
    const originalHistory = structuredClone(session.snapshotEvents())
    const completeRequest = `${fixture.task}\n${fixture.constraints}`
    const pending = user('pending', completeRequest)
    const before = ctx.tokenMeter.measure(session).totalTokens + ctx.tokenMeter.estimateMessage(pending)
    const candidates = selectCandidates(session.surface.nodes.map((seq: number) => session.eventAt(seq)), ctx.tokenMeter, new Map(), (seq: number) => session.eventAt(seq), 'laya-coreml')
    const savings = candidates.reduce((total, candidate) => total + candidate.savings, 0)
    if (arm === 'deterministic' && worthwhile(before, savings, 12800)) {
      // Evaluation-only D: exact production candidate codec and native append operations, no model call/config change.
      for (const candidate of candidates) verifyLosslessCandidate(candidate)
      const prepared = candidates.map(candidate => ({ candidate, message: structuredClone(candidate.replacement) }))
      for (const { candidate, message } of prepared) {
        signal.throwIfAborted()
        const seq = candidate.event.seq
        if (session.eventAt(seq) !== candidate.event || !session.surface.nodes.includes(seq)) throw new Error('Evaluation source changed')
        session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: ctx.tokenMeter.estimateMessage(candidate.original) })
        session.append('tool/result', { ...candidate.event.data, message }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
    }
    {
      coordinator = new SemanticCompactionCoordinator(ctx, service, realpathSync(process.cwd()), { mode: 'off' })
      coordinator.attach(handle.agent, async () => ({ sessionId: session.id, taskEvidence: { currentRequest: completeRequest, constraints: fixture.constraints } }))
    }
    session.append('todo/write', { todos: [{ content: 'Inspect frozen log', status: 'completed' }, { content: fixture.task, status: 'pending' }] })
    handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: completeRequest }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    signal.throwIfAborted()
    const events = session.snapshotEvents()
    const requests = provider.requests.map(request => structuredClone(request))
    if (events.some((event: any) => event.type === 'compaction/summary')) throw new Error('Native summary contaminated primary comparison')
    return { arm, nativeRuntime: version, nativeEstimated: { before, after: ctx.tokenMeter.measure(session).totalTokens },
      requestBytes: requests.map(request => Buffer.byteLength(JSON.stringify(request))), requestNativeEstimated, requests,
      originalHistoryIntact: JSON.stringify(events.slice(0, originalHistory.length)) === JSON.stringify(originalHistory),
      originalHistory, finalSurface: session.surface.nodes.map((seq: number) => session.eventAt(seq)),
      appendedEvents: events.slice(originalHistory.length), candidateCount: candidates.length,
      candidateNativeEstimatedSavings: savings, coordinatorOutcome: arm === 'laya' ? (service.status() as any).semanticCompaction.last : null,
      targetExact: { unsupported: 'capture_route_has_no_target_tokenizer' }, downstreamQuality: 'UNVERIFIED_scripted_capture',
      layaMutation: 'shadow_no_commit' }
  } finally {
    coordinator?.stop(); await coordinator?.drain(); await handle?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}
