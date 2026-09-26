import type { Context } from '@deepseek-ai/cordis'
import { injectDshContext, selectDshDirectiveSources } from '../context-injection.js'
import { projectDshContext } from '../context-projection.js'
import { projectDshDirective } from '../directive-projection.js'
import { refreshDshSkillSnapshots } from '../skill-snapshot.js'
import { inapplicableEnnoState, stateForSnapshot } from '../../enno-oduno/service.js'
import { readEnnoSnapshot } from '../../enno-oduno/store.js'
import type { EnnoOdunoState } from '../../enno-oduno/types.js'
import type { DshPreStepEvent } from '../intake-gate.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { DeepPlanningController } from '../../deep-thinker/controller.js'
import type { DshExecutionSupport, ExecutionBinding } from '../execution-support.js'
import type { StoredExecutionSelection } from '../execution-selection.js'
import type { DshSessionEventSource } from '../session-memory-finalizer.js'
import type { DshAdvisoryRoundResult } from '../advisory-runner.js'
import type { TurnRecord } from './turn-state.js'

interface ContextDependencies {
  readonly ctx: Context
  readonly runtime: DshCoreRuntime
  readonly deepPlanning: DeepPlanningController
  readonly executionSupport: DshExecutionSupport
  readonly continuityMode: 'off' | 'shadow' | 'active'
  readonly getSkillPrompts: () => DshSkillPrompts
  readonly systemSkillsFor: (agent: object) => ReadonlySet<string> | undefined
  readonly getSelection: (runId: string) => StoredExecutionSelection | undefined
  readonly currentForAgentEvent: (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object) => TurnRecord | undefined
  readonly advisoryEvidenceFor: (item: TurnRecord, state: EnnoOdunoState) => Promise<{ readonly phase: DshAdvisoryRoundResult['phase']; readonly contributions: DshAdvisoryRoundResult['contributions'] } | undefined>
  readonly executionBinding: (item: TurnRecord) => ExecutionBinding
  readonly sessionEventSource: (value: object | undefined) => DshSessionEventSource
}

export function createContextMessages({
  ctx, runtime, deepPlanning, executionSupport, continuityMode, getSkillPrompts,
  systemSkillsFor, getSelection, currentForAgentEvent, advisoryEvidenceFor,
  executionBinding, sessionEventSource,
}: ContextDependencies) {
  const contextMessages = async (event: DshPreStepEvent, pending: readonly unknown[]): Promise<readonly unknown[]> => {
    const item = currentForAgentEvent(event.agent.id, event.sessionId, event.turn, event.nativeSession, event.nativeAgent)
    if (item === undefined || item.sessionId !== event.sessionId) throw new Error('kiokuko-dsh turn identity is not bound')
    if (event.nativeSession !== undefined && item.nativeSession !== event.nativeSession) throw new Error('kiokuko-dsh native session identity is not bound')
    // The intake cache is intentionally stable for the logical turn, while
    // Enno operations advance item.prepared after each tool result. Always
    // inject from that current host state instead of replaying the intake-time
    // directive from the cached gate result.
    const discussion = getSelection(item.runId)?.value.discussion
    const prepared = discussion ? { ...item.prepared, ennoOduno: inapplicableEnnoState() } : item.prepared
    const directive = projectDshDirective(prepared.ennoOduno)
    const selection = directive === null ? { routeSkillNames: [], expertRefs: [] } : selectDshDirectiveSources(directive)
    const advisoryEvidence = await advisoryEvidenceFor(item, prepared.ennoOduno)
    const messages = await injectDshContext({
      skillPrompts: getSkillPrompts(),
      systemSkillNames: systemSkillsFor(event.nativeAgent ?? event.agent) ?? new Set(),
      prepared,
      task: event.task,
      routeSkillNames: selection.routeSkillNames,
      expertRefs: selection.expertRefs,
      ...(directive === null ? {} : { directive }),
      ...(advisoryEvidence === undefined ? {} : { advisoryEvidence }),
      runtime,
      soulInSystemPrompt: ctx.get('systemPrompt', false) !== undefined,
      userTaskInConversation: true,
    })
    const previousReport = await deepPlanning.previousReport(event.sessionId)
    if (continuityMode !== 'off' && prepared.ennoOduno.applicable && !executionBinding(item).terminal && !executionSupport.paused(event.sessionId)) {
      // One service read at the request boundary; reuse its verdict without running verifiers.
      try {
        const snapshot = await runtime.withDatabase(db => readEnnoSnapshot(db, {
          runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
        }))
        if (item.prepared === prepared) executionSupport.ennoSource(event.sessionId, snapshot, stateForSnapshot(snapshot))
      } catch { /* Optional projection is unavailable; existing authority guards still apply. */ }
    }
    const executionSelection = getSelection(item.runId)?.value
    const discussionText = discussion
      ? `実行方式・モデル選択の質問（${discussion.questionId}）に対するユーザーの自由入力:\n\n${discussion.text}\n\n実行方式・モデル構成はまだ承認されていません。まずこの発言に会話として回答してください。ツールを使った作業や同じ選択質問の繰り返しは行わないでください。`
      : executionSelection?.status === 'ready'
        ? '実行方式・モデル構成の選択が確定しました。自由入力への会話のみという制限は解除されています。直近のユーザーの依頼と現在の実行指示に従ってください。'
        : undefined
    const discussionMessages = discussionText ? [{
      role: 'user' as const, source: 'user-task' as const, name: 'execution-selection-discussion',
      content: discussionText,
    }] : []
    refreshDshSkillSnapshots(messages, sessionEventSource(event.nativeSession), systemSkillsFor(event.nativeAgent ?? event.agent))
    return projectDshContext([...messages, ...previousReport, ...discussionMessages], sessionEventSource(event.nativeSession), pending)
  }

  return contextMessages
}
