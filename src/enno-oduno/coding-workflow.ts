import type { CodingDefinition } from '../dsh/coding-workflow/contracts.js'
import { canonicalContentHash } from '../serialization/validate.js'
import type { EnnoRunSnapshot } from './types.js'

/** A projection of the existing ideal and plan, never a second Enno authority. */
export function ennoCodingProjection(snapshot: EnnoRunSnapshot) {
  const { ideal, contract } = snapshot
  if (!ideal || !contract.workPlan.units.length || !contract.finalVerifiers.length
    || contract.workPlan.units.some(unit => !unit.focusedVerifiers.length)) return
  const stable = (kind: string, id: string) => `${kind}-${canonicalContentHash(id).slice(0,24)}`
  const goals = contract.finalVerifiers.map(verifier => stable('goal-check',verifier.id))
  const bindings: { criterionId:string; verifierId:string; workUnitId?:string }[] = []
  const criteria: CodingDefinition['criteria'] = []
  for (const verifier of contract.finalVerifiers) {
    const criterionId = stable('goal-check',verifier.id)
    bindings.push({ criterionId, verifierId:verifier.id })
    criteria.push({ criterionId, revision:contract.revision, evidence:'enno', outcome:contract.acceptanceCriteria.map(item=>item.description).join('; ') || ideal.successSignals.join('; '),
      procedure:`After all WorkUnits: ${verifier.executable} ${verifier.args.join(' ')} (${verifier.cwd})`, expected:'All selected user-entry assertions pass without skips' })
  }
  const items = contract.workPlan.units.map(unit => {
    const ids = unit.focusedVerifiers.map(verifier => {
      const criterionId = stable('item-check',`${unit.id}:${verifier.id}`)
      bindings.push({ criterionId, verifierId:verifier.id, workUnitId:unit.id })
      criteria.push({ criterionId, revision:contract.revision, evidence:'enno', outcome:unit.acceptanceCriteria.join('; '),
        procedure:`${verifier.executable} ${verifier.args.join(' ')} (${verifier.cwd})`, expected:'All selected item assertions pass without skips' })
      return criterionId
    })
    return { itemId:stable('item',unit.id), change:unit.objective, dependsOn:unit.dependencies.map(id=>stable('item',id)), goalCriterionIds:goals, criterionIds:ids }
  })
  const definition: CodingDefinition = { goal:{ goalId:'enno-goal', revision:contract.revision, ideal:ideal.objective,
    target:contract.scope.join('; '), outOfScope:contract.exclusions, constraints:ideal.principles,
    requestBasis:snapshot.handoff.objective, criterionIds:goals }, items, criteria }
  return { definition, bindings, approved:['approved','not_required'].includes(snapshot.confirmationState), completed:snapshot.status === 'completed' }
}
