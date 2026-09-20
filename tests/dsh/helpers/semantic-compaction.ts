import { realpathSync } from 'node:fs'
import { SemanticCompactionCoordinator } from '../../../src/dsh/semantic-compaction/coordinator.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { SemanticCompactionConfig, type SurfaceEvent, type SurfaceMessage } from '../../../src/dsh/semantic-compaction/contracts.js'
import type { DecisionBatch, DecisionBatchResult } from '../../../src/dsh/decisions/contracts.js'

export function message(id: string, text: string): SurfaceMessage { return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
export function history(text = 'stale log '.repeat(1400), tool = 'read'): SurfaceEvent[] {
  const events: SurfaceEvent[] = []
  const push = (type: string, data: any) => events.push({ seq: events.length, type, data })
  push('user/message', message('task', 'Keep the acceptance criteria and continue with the next file.'))
  for (let i = 1; i < 6; i++) push('user/message', message(`initial-${i}`, 'Initial requirements remain protected.'))
  push('assistant/message', { message: { id: 'call', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock', replayState: { private: 'replay-only' } }, content: [{ type: 'tool-call', id: 'call-1', name: tool, arguments: '{"path":"old.log"}' }] } })
  push('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text }], isError: false }] } })
  for (let i = 0; i < 6; i++) push('user/message', message(`recent-${i}`, 'Required recent evidence.'))
  return events
}
export function decisions(options: { configured?: boolean; typesafeModel?: string; mode?: 'auto' | 'off'; budgetMs?: number; store?: import('../../../src/dsh/decisions/service.js').DecisionStore; evaluate?: (batch: DecisionBatch, signal: AbortSignal) => Promise<DecisionBatchResult> } = {}) {
  const calls: DecisionBatch[] = []
  const result = (batch: DecisionBatch): DecisionBatchResult => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : q.id === 'timing' ? 'compact' : 'shorten' })) })
  const service = new DecisionService(TypedDecisionsConfig.parse(options.typesafeModel ? { typesafe: { model: options.typesafeModel } } : {}), () => ({ capabilities: { maxQuestions: 64, maxChoices: 256, maxBytes: 262144 }, evaluate: async (batch, signal) => { calls.push(batch); return options.evaluate ? options.evaluate(batch, signal) : result(batch) } }), options.store,
    { configurationCheck: async () => options.configured !== false, semanticCompaction: SemanticCompactionConfig.parse({ mode: options.mode ?? 'auto', budgetMs: options.budgetMs ?? 5000 }) })
  return { service, calls, result }
}
export function fixture(options: Parameters<typeof decisions>[0] & { events?: SurfaceEvent[]; thresholdRatio?: number; overhead?: number } = {}) {
  const events = options.events ?? history(), nodes = events.map(e => e.seq)
  const handlers: Function[] = [], created: Function[] = []
  const session: any = { id: 'semantic-session', header: { version: 3, cwd: realpathSync(process.cwd()) }, surface: { nodes }, get seq() { return events.length },
    eventAt: (seq: number) => events[seq], requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }),
    append(type: string, data: any, intent?: any) { const event = { seq: events.length, type, data, ...(intent ?? {}) }; events.push(event); if (intent) nodes[nodes.indexOf(intent.surfaceOp.startSeq)] = event.seq; return event } }
  const agent: any = { id: 'semantic-agent', session, ctx: { on(name: string, handler: Function) { if (name !== 'agent/pre-step') return () => {}; handlers.unshift(handler); return () => { handlers.splice(handlers.indexOf(handler), 1) } } } }
  const meter = { estimateMessage: (m: any) => Math.ceil(JSON.stringify(m).length / 4), measure: () => { const measured = nodes.map(seq => { const e = events[seq]!; const tokens = meter.estimateMessage(e.type === 'user/message' ? e.data : e.data.message); return { seq, tokens, heuristicTokens: tokens } }); return { totalTokens: measured.reduce((s, n) => s + n.tokens, options.overhead ?? 100), logRevision: events.length, nodes: measured } } }
  const services: any = { tokenMeter: meter, compaction: { config: { auto: true, thresholdRatio: options.thresholdRatio ?? .8, retainRatio: .16, modelPolicies: [] } }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 3000 } }) }, agents: { get: () => agent, list: () => [agent] }, sessions: { get: () => session } }
  const ctx: any = { get: (name: string) => services[name], on(name: string, handler: Function) { if (name !== 'agent/created') return () => {}; created.push(handler); return () => { created.splice(created.indexOf(handler), 1) } } }
  const d = decisions(options), coordinator = new SemanticCompactionCoordinator(ctx, d.service, realpathSync(process.cwd()))
  let next = 0
  const step = (signal = new AbortController().signal, pending: SurfaceMessage[] = []) => handlers[0]?.({ agent, messages: pending, signal }, async () => { next++; return 'native' })
  return { ...d, events, nodes, session, agent, meter, services, ctx, coordinator, handlers, created, step, next: () => next }
}
