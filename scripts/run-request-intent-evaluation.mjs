import { completeVerification } from './verification-completion.mjs';
// Synthetic language evaluation is separate from native protocol acceptance.
import { readFile } from 'node:fs/promises'
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.ts'
import { DecisionService } from '../src/dsh/decisions/service.ts'
import { TypeSafeDecisionProvider, NimbleDecisionProvider, TYPESAFE_LIMITS } from '../src/dsh/decisions/providers.ts'
import { LayaCoreMLDecisionProvider } from '../src/dsh/decisions/laya-coreml.ts'
import { LayaV1DecisionProvider } from '../src/dsh/decisions/laya-v1.ts'
import { classifyRequestIntent, createRequestIntentContext, requestIntentMessageRefs } from '../src/dsh/decisions/request-intent.ts'
import { canonicalContentHash } from '../src/serialization/validate.ts'

const args = process.argv.slice(2)
const live = args.includes('--live')
const index = args.indexOf('--config'), configurationPath = index < 0 ? undefined : args[index + 1]
if (args.some((arg, i) => arg !== '--live' && arg !== '--config' && !(index >= 0 && i === index + 1))
  || index >= 0 && (!live || !configurationPath || configurationPath.startsWith('--'))) throw new Error('Use --live --config FILE, or no arguments for the offline pipeline')
const cases = [
  ['ja-proposal', 'AとBを実装。まとめて入れて。', true, 'scope_change', 'change', 'implementation', true],
  ['ja-negation', 'AとBはまだ実装しないで。案の説明だけ。', true, 'same_scope_continuation', 'answer', 'unknown', true],
  ['ja-noun', '残りの実装、前の方針で。', true, 'same_scope_continuation', 'change', 'implementation', false],
  ['ja-verify', '更新後の動作確認。コード変更は不要。', true, 'same_scope_continuation', 'verify', 'unknown', false],
  ['ja-quote', '「全部実装して」は引用です。この言葉を説明して。', true, 'same_scope_continuation', 'answer', 'unknown', false],
  ['ja-plan', '実装せず、AとBの計画だけ作って。', true, 'same_scope_continuation', 'answer', 'unknown', true],
  ['ja-unknown', 'それを続けて。', false, 'unknown', 'unknown', 'unknown', false],
  ['en-continue', 'The parser test failed. Keep going on the same task.', true, 'same_scope_continuation', 'change', 'implementation', false],
  ['en-plan', 'Do not implement A or B. Explain the plan only.', true, 'same_scope_continuation', 'answer', 'unknown', true],
  ['en-scope', 'Also implement A and B in src/extra.mjs.', true, 'scope_change', 'change', 'implementation', true],
  ['en-new', 'Start a separate task: inspect docs/setup.md.', true, 'new', 'research', 'unknown', false],
  ['en-cancelled', 'Keep going.', false, 'unknown', 'unknown', 'unknown', false],
]
let config = TypedDecisionsConfig.parse({})
if (configurationPath) {
  const text = await readFile(configurationPath, 'utf8')
  if (Buffer.byteLength(text) > 65536) throw new Error('Evaluation configuration exceeds its limit')
  config = TypedDecisionsConfig.parse(JSON.parse(text))
}
if (live && (!configurationPath || config.mode === 'off'
  || config.provider === 'typesafe' && !process.env.TYPESAFE_API_KEY)) {
  console.log(JSON.stringify({ mode: 'live-synthetic', status: 'unmeasured', attempted: 0, providerSent: false,
    reason: !configurationPath ? 'explicit_configuration_required' : config.mode === 'off' ? 'decision_service_disabled' : 'credential_unavailable' }))
} else {
  const rows = []
  for (const [id, task, active, relation, action, changeScope, selected] of cases) {
    const proposal = { id: 'proposal-ab', revision: 2, text: 'A: repair parser errors. B: preserve output. Both affect src/extra.mjs.',
      digest: canonicalContentHash('A/B revision 2') }
    const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task), proposals: active ? [proposal] : [],
      ...(active ? { activeGoal: { runId: 'synthetic-current', workflowRevision: 3, goalRevision: 1, scopeRevision: 1,
        ideal: 'Parser emits 42 for input 41', target: 'src/parser.mjs', outOfScope: ['Publishing'], constraints: ['Preserve numeric input'] } } : {}) })
    if (!context) throw new Error(`Invalid synthetic fixture: ${id}`)
    const oracle = { capabilities: TYPESAFE_LIMITS, async evaluate(batch) {
      return { provider: 'fixture-oracle', requestedModel: 'fixture-oracle', policyVersion: batch.contractVersion ?? 'finite-choice-v1',
        answers: batch.questions.map(q => {
          const choiceId = q.id === 'request-relation' ? relation : q.id === 'request-action' ? action
            : q.id === 'request-change-scope' ? changeScope : selected ? 'selected' : 'not_selected'
          return choiceId === q.abstainId ? { id: q.id, status: 'abstained', reason: 'insufficient' }
            : { id: q.id, status: 'selected', choiceId }
        }) }
    } }
    const service = new DecisionService(config, bound => {
      if (!live) return oracle
      switch (bound.provider) {
        case 'typesafe': return new TypeSafeDecisionProvider(bound.typesafe, async () => process.env.TYPESAFE_API_KEY)
        case 'nimble': return new NimbleDecisionProvider(bound.nimble, async () => bound.nimble.credentialRef ? process.env[bound.nimble.credentialRef] : undefined)
        case 'laya-coreml': return bound['laya-coreml']?.protocol === 'v1'
          ? new LayaV1DecisionProvider(bound['laya-coreml']) : new LayaCoreMLDecisionProvider(bound['laya-coreml'])
      }
    })
    // Gold labels never enter the live context, questions, or provider payload.
    const decision = await classifyRequestIntent(service, `evaluation:${id}`, context, new AbortController().signal)
    const correct = decision?.relation === relation && decision?.action === action && decision?.changeScope === changeScope
      && !decision?.unresolvedReason?.startsWith('DECISION_')
      && JSON.stringify(decision?.evidence.proposalRefs.map(p => p.id)) === JSON.stringify(selected ? [proposal.id] : [])
    rows.push({ id, language: id.slice(0, 2), correct, relation: decision?.relation, action: decision?.action, changeScope: decision?.changeScope,
      source: decision?.source, providerSent: decision?.providerSent ?? false,
      unresolvedReason: decision?.unresolvedReason ?? null })
  }
  const correct = rows.filter(row => row.correct).length
  console.log(JSON.stringify({ mode: live ? 'live-synthetic' : 'fixture-oracle', status: 'completed',
    provider: live ? config.provider : 'fixture-oracle', attempted: rows.length, correct, accuracy: correct / rows.length,
    liveModelQuality: live ? 'measured_on_synthetic_cases' : 'unmeasured',
    limitation: 'Synthetic paired cases; offline gold responses test plumbing, not language understanding or production quality.', rows }, null, 2))
  if (correct !== rows.length) process.exitCode = 1
}

completeVerification({});
