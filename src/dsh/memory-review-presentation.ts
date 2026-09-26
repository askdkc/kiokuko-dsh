import type { DshCoreRuntime } from './core-runtime.js'
import { memoryApplicationDecisionsPending, memoryApplicationStatus } from '../memory/application.js'

/** PTC can execute Node code, so unresolved memory decisions need a direct native review tool. */
export function createMemoryReviewPresentation(agent: { ctx?: unknown }, runtime: DshCoreRuntime) {
  let release: (() => void) | undefined
  let activeRunId: string | undefined
  const dispose = () => { release?.(); release = undefined; activeRunId = undefined }
  return { dispose, async sync(runId: string | undefined): Promise<void> {
    if (!runId) { dispose(); return }
    if (activeRunId !== runId) dispose()
    const pending = await runtime.withDatabase(db => memoryApplicationDecisionsPending(memoryApplicationStatus(db, runId)))
    if (!pending) { dispose(); return }
    if (release) return
    const scopedTools = (agent.ctx as { get?(name: string): unknown } | undefined)?.get?.('tools') as {
      modeFor(scope: unknown): string; presentAs(mode: 'native'): () => void
    } | undefined
    if (scopedTools?.modeFor(agent) !== 'ptc') return
    release = scopedTools.presentAs('native')
    activeRunId = runId
  } }
}
