import { canonicalContentHash } from '../../serialization/validate.js'
import { advisorySlotDefinitions } from '../../enno-oduno/advisory.js'
import type { AdvisoryContext, AdvisoryContribution, AdvisorySlotId } from '../../enno-oduno/types.js'
import type { PlanReviewResult } from '../../enno-oduno/service.js'
import { DshAdvisoryRunner, type DshAdvisoryCall } from '../advisory-runner.js'
import { abortable } from '../http-json.js'
import { DecisionError, type DecisionQuestion } from './contracts.js'
import type { DecisionService } from './service.js'

interface Check { id: string; slot: AdvisorySlotId; text: string }
function checksFor(context: AdvisoryContext): Check[] {
  if (context.phase !== 'planning' || !context.candidate) throw new Error('Review requires the actual plan candidate')
  const candidate = context.candidate as { acceptanceCriteria: { id: string }[]; workPlan: { units: { id: string }[] } }
  const checks: Check[] = [
    { id: 'scope', slot: 'workunit_architect', text: 'The complete scope and exclusions match the objective and constraints without unrelated work.' },
    { id: 'protocol', slot: 'protocol_risk_reviewer', text: 'The complete plan preserves permissions, identities, revisions, cancellation and lease boundaries.' },
    { id: 'verification', slot: 'verification_designer', text: 'The final verifiers cover the complete acceptance criteria with observable results.' },
  ]
  for (const c of candidate.acceptanceCriteria) checks.push({ id: `criterion:${c.id}`, slot: 'verification_designer', text: `Acceptance criterion ${c.id} has adequate WorkUnit coverage and concrete verifiers.` })
  for (const u of candidate.workPlan.units) {
    checks.push({ id: `unit:${u.id}:scope`, slot: 'workunit_architect', text: `WorkUnit ${u.id} has one cohesive responsibility, bounded scope and correct dependencies.` },
      { id: `unit:${u.id}:skills`, slot: 'protocol_risk_reviewer', text: `WorkUnit ${u.id} uses available declared Skills and appropriate expert references while preserving host safety invariants.` },
      { id: `unit:${u.id}:verification`, slot: 'verification_designer', text: `WorkUnit ${u.id} has executable focused verifiers covering its acceptance criteria.` })
  }
  return checks
}
/** All checks must be selected. Any abstention invalidates typed review coverage. */
export async function reviewPlanDecisions(input: { service: DecisionService; requestId: string; context: AdvisoryContext; signal: AbortSignal;
  check: { execute(call: DshAdvisoryCall): Promise<unknown>; verifyReadOnly(call: DshAdvisoryCall): boolean | PromiseLike<boolean>; identity: Record<string, unknown> } }): Promise<PlanReviewResult> {
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 30000)
  const signal = AbortSignal.any([input.signal, timeout.signal])
  const started = Date.now()
  try {
    const checks = checksFor(input.context)
    const questions: DecisionQuestion[] = checks.map(c => ({ id: c.id, instructions: c.text,
      choices: [{ id: 'satisfied', description: 'Supported by this complete candidate' }, { id: 'finding', description: 'Concrete gap or inconsistency in this candidate' }, { id: 'abstain', description: 'Cannot assess from complete evidence' }], abstainId: 'abstain' }))
    const outcome = await input.service.evaluate(input.requestId, { purpose: 'enno-check', state: input.context, questions }, signal,
      input.context.phase === 'planning' ? input.context.catalogDigest : '')
    signal.throwIfAborted()
    if (outcome.status === 'completed' && outcome.result.answers.every(a => a.status === 'selected')) {
      const contributions: AdvisoryContribution[] = advisorySlotDefinitions('planning').map(slot => {
        const owned = checks.filter(c => c.slot === slot.slotId)
        const findings = owned.filter(c => outcome.result.answers[checks.indexOf(c)]?.status === 'selected' && (outcome.result.answers[checks.indexOf(c)] as { choiceId: string }).choiceId === 'finding')
        return { slotId: slot.slotId, outcome: 'completed', summary: `${owned.length} atomic checks reviewed. ${findings.length} findings.`,
          recommendations: findings.map(c => `${c.id}: ${c.text}`), risks: [], evidence: [] }
      })
      // Do not omit findings to fit the advisory envelope; review the full plan with check instead.
      if (contributions.every(c => c.recommendations!.length <= 32 && Buffer.byteLength(JSON.stringify(c)) <= 8192)) {
        const { answers: _answers, ...backend } = outcome.result
        return { contributions, backend }
      }
    }
    const remaining = 30000 - (Date.now() - started)
    if (remaining <= 0) throw new DecisionError('TIMEOUT')
    const runner = new DshAdvisoryRunner({ execute: input.check.execute, verifyReadOnly: input.check.verifyReadOnly, timeoutMs: remaining })
    const round = await abortable(runner.run({ directive: { protocolVersion: 1, phase: 'planning', policyVersion: 1, readOnlyRequired: true, hostMustVerifyIsolation: true,
      context: input.context, slots: advisorySlotDefinitions('planning') }, signal }), signal)
    signal.throwIfAborted()
    if (round.contributions.some(c => c.outcome !== 'completed')) throw new DecisionError('UNAVAILABLE')
    return { contributions: round.contributions, backend: { ...input.check.identity, reviewInputDigest: canonicalContentHash(input.context) } }
  } catch (error) {
    if (input.signal.aborted) throw new DecisionError('CANCELLED')
    if (timeout.signal.aborted) throw new DecisionError('TIMEOUT')
    throw error
  } finally { clearTimeout(timer) }
}
