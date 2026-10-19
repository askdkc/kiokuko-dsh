/** Process-local telemetry identity must never enter an authority fingerprint, wire value or cache key. */
const identities=new WeakMap<object,string>()
export function correlateRequestIntent(value:object,decisionId:string):void { identities.set(value,decisionId) }
export function requestIntentDiagnosticId(value:unknown):string|undefined {
  return value && typeof value==='object' ? identities.get(value) : undefined
}
