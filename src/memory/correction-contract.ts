import {canonicalContentHash} from '../serialization/validate.js'

/** Same source contract in Kiokuko and DSH. A source identity is not proof of use. */
export interface CorrectionSource {
  entryId:string;revision:number;workspace:string;origin:string;sourceDigest:string
  rule:'capability_compatibility'|'reference'
}
export type CorrectionRetrieval='not_requested'|'no_correction'|'retrieved'|'unavailable'
export interface CorrectionEntry {
  id:string;revision:number;workspace:string;title:string;body:string;summary?:string|null
  provenance:Record<string,unknown>
}
export function correctionSource(entry:CorrectionEntry,origin:string):CorrectionSource {
  const text=[entry.title,entry.summary??entry.body].join('\n')
  const version=/version|compiler|版数|バージョン|版番号/iu.test(text)
  const capability=/capabilit|only because|solely|不要.*固定|決め打ち|能力|互換性.*確認|版.*だけ/iu.test(text)
  return {entryId:entry.id,revision:entry.revision,workspace:entry.workspace,origin,
    sourceDigest:canonicalContentHash({title:entry.title,body:entry.body,summary:entry.summary,provenance:entry.provenance}),
    rule:version&&capability?'capability_compatibility':'reference'}
}
export function compatibilityDecisionConflicts(sources:readonly CorrectionSource[],decision:{kind:string;basis:string;requiredVersion?:string;observedVersion?:string}):boolean {
  return sources.some(source=>source.rule==='capability_compatibility')&&decision.kind==='compatibility'
    &&decision.basis==='version_only'&&decision.requiredVersion!==decision.observedVersion
}
