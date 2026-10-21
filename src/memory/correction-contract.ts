import {z} from 'zod'
import {canonicalContentHash} from '../serialization/validate.js'

export const CORRECTION_POLICY_VERSION='correction-meaning-v1'
export const CorrectionRuleSchema=z.enum(['capability_compatibility','reference','uncertain'])
export type CorrectionRule=z.infer<typeof CorrectionRuleSchema>
export type CorrectionMode='off'|'shadow'|'auto'
const digest=z.string().regex(/^[a-f0-9]{64}$/u)
const identifier=z.string().regex(/^[a-zA-Z0-9_.:/@+-]{1,256}$/u)
export const CorrectionClassificationSchema=z.object({
  schema:z.literal('correction-classification-v1'),policyVersion:z.literal(CORRECTION_POLICY_VERSION),
  inputDigest:digest,entryRevision:z.number().int().positive(),configurationDigest:digest,
  state:z.enum(['classified','abstained','unavailable','stale','unclassified']),rule:CorrectionRuleSchema,
  reason:z.enum(['semantic','uncertain','provider_unavailable','timeout','malformed','unsupported','entry_changed','unclassified','mode_off','storage_unavailable']),
  attested:z.boolean(),provider:identifier.optional(),requestedModel:identifier.optional(),returnedModel:identifier.optional(),
  providerRevision:identifier.optional(),providerPolicyVersion:identifier.optional(),
  elapsedMs:z.number().finite().nonnegative(),inputTokens:z.number().int().nonnegative().optional(),outputTokens:z.number().int().nonnegative().optional(),
}).strict().refine(c=>(c.state==='classified')===(c.rule!=='uncertain'),'Only classified results have a semantic rule')
export type CorrectionClassification=z.infer<typeof CorrectionClassificationSchema>
export const CorrectionSourceSchema=z.object({
  entryId:z.string(),revision:z.number().int().positive(),workspace:z.string(),origin:z.string(),sourceDigest:digest,
  rule:CorrectionRuleSchema,classification:CorrectionClassificationSchema.safeExtend({mode:z.enum(['off','shadow','auto'])}).optional(),
}).strict()
export type CorrectionSource=z.infer<typeof CorrectionSourceSchema>
export type CorrectionRetrieval='not_requested'|'no_correction'|'retrieved'|'unavailable'
export interface CorrectionEntry {
  id:string;revision:number;workspace:string;title:string;body:string;summary?:string|null
  provenance:Record<string,unknown>
}
/** The body remains evidence even when a short or contradictory summary exists. */
export function correctionSemanticInput(entry:Pick<CorrectionEntry,'title'|'body'|'summary'>){
  return {title:entry.title,body:entry.body,summary:entry.summary??null}
}
export const correctionInputDigest=(entry:CorrectionEntry)=>canonicalContentHash(correctionSemanticInput(entry))
export const correctionEvidenceDigest=(entry:CorrectionEntry)=>canonicalContentHash({...correctionSemanticInput(entry),provenance:entry.provenance})
export function unclassifiedCorrection(entry:CorrectionEntry,reason:CorrectionClassification['reason']='unclassified',configurationDigest=canonicalContentHash('no-semantic-provider')):CorrectionClassification {
  return {schema:'correction-classification-v1',policyVersion:CORRECTION_POLICY_VERSION,inputDigest:correctionInputDigest(entry),entryRevision:entry.revision,
    configurationDigest,state:reason==='entry_changed'?'stale':reason==='unclassified'?'unclassified':'unavailable',rule:'uncertain',reason,attested:false,elapsedMs:0}
}
/** A semantic label is neither an execution permission nor machine verification. */
export function correctionSource(entry:CorrectionEntry,origin:string,classification?:CorrectionClassification,mode:CorrectionMode='shadow'):CorrectionSource {
  const parsed=CorrectionClassificationSchema.safeParse(classification)
  const current=parsed.success&&parsed.data.inputDigest===correctionInputDigest(entry)&&parsed.data.entryRevision===entry.revision
    ?parsed.data:unclassifiedCorrection(entry)
  return {entryId:entry.id,revision:entry.revision,workspace:entry.workspace,origin,sourceDigest:correctionEvidenceDigest(entry),
    rule:mode==='auto'&&current.attested&&current.state==='classified'?current.rule:'uncertain',classification:{...current,mode}}
}
export function compatibilityDecisionConflicts(sources:readonly CorrectionSource[],decision:{kind:string;basis:string;requiredVersion?:string;observedVersion?:string}):boolean {
  return sources.some(source=>source.rule==='capability_compatibility')&&decision.kind==='compatibility'
    &&decision.basis==='version_only'&&decision.requiredVersion!==decision.observedVersion
}
