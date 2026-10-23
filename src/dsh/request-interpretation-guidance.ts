import { rebindRequestIntentDecision, requestIntentRequiredReferenceIds, type RequestIntentContext, type RequestIntentDecision } from './decisions/request-intent.js'

/** Recovery describes the current source contract; it never selects intent or grants permission. */
export function requestInterpretationRecovery(decision:RequestIntentDecision|undefined,context:RequestIntentContext|undefined,prepared=false) {
  const bound=context&&decision?rebindRequestIntentDecision(decision,context):undefined
  const missingFields:string[]=[]
  if(!context)missingFields.push('current_request_context')
  if(!bound||bound.relation==='unknown')missingFields.push('requestIntent.relation')
  if(!bound||bound.action==='unknown')missingFields.push('requestIntent.action')
  if(bound?.action==='change'&&bound.changeScope==='unknown')missingFields.push('requestIntent.changeScope')
  if(!bound)missingFields.push('requestIntent.evidenceRefs')
  const currentReferences=context?requestIntentRequiredReferenceIds(context):[]
  return {
    code:prepared?'REQUEST_INTERPRETATION_ALREADY_PREPARED':'REQUEST_INTERPRETATION_REQUIRED',state:'required',executed:false,
    permissions:'unchanged_native_policy',missingFields,currentReferences,evidenceTools:['read','glob','grep'],
    nextAction:prepared?'fresh_native_turn':context?'submit_current_request_intent':'refresh_native_context',
    recovery:[
      'Use the original request and current host-bound context to establish the concrete target. Native read/glob/grep remain subject to their existing permissions; do not substitute cwd for an unresolved target.',
      'If the action or target is still unclear, ask the user a concrete clarification. Otherwise submit prepare_requested_work with requestIntent.relation, action and exact current evidenceRefs; implementation changes also need changeScope.',
      'A taskType label is advisory preparation, not effect authority. Changing or repeating Bash commands cannot repair missing interpretation.',
      prepared?'This turn is already prepared and its interpretation is immutable. Preserve the error and unfinished work. Obtain fresh native input for the original request, then bind its new current references before preparation; do not forge user input or reuse stale references.'
        :'Submit interpretation before preparing. If a turn is already prepared, preserve it and recover through fresh native input rather than replacing its interpretation.',
    ],
    examples:context?[{condition:'Only when the original request explicitly asks for a new review or verification of a concrete target; use same_scope_continuation instead only when supported by the current context.',
      tool:'prepare_requested_work',arguments:{requestIntent:{relation:'new',action:'verify',evidenceRefs:currentReferences}}}]:[],
  }
}
export function requestInterpretationError(message:string,decision:RequestIntentDecision|undefined,context:RequestIntentContext|undefined,prepared=false):Error {
  return new Error(`${message}\nRecovery: ${JSON.stringify(requestInterpretationRecovery(decision,context,prepared))}`)
}
