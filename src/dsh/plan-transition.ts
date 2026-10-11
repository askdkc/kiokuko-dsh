/** Only current human messages can authorize an implementation transition. */
function instructionLines(text:string):string[] {
  const lines:string[]=[];let fence:string|undefined
  for(const line of text.split('\n')) {
    const marker=line.match(/^\s*(`{3,}|~{3,})/u)?.[1]
    if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=undefined;continue}
    if(!fence&&!/^\s*>/u.test(line))lines.push(line)
  }
  return lines
}
export function implementationRequested(messages: readonly any[]): boolean {
  return messages.some(message => message?.role === 'user' && (!message.source || message.source.kind === 'user')
    && (typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter((block:any)=>block.type==='text').map((block:any)=>block.text))
      .some((text:string) => instructionLines(text).some(line=>
        /^(?:\s*)(?:please\s+)?(?:implement(?:\s+(?:this|the|it|plan))?|go ahead(?:\s+and\s+implement)?|実装(?:して|しろ|せよ|を開始|を進め)|(?:この|その)?(?:プラン|計画)(?:を)?(?:実装|承認)|承認(?:する|した))\b/iu.test(line)
        || /^(?:\s*)(?:実装して|実装しろ|実装を開始|実装を進め|(?:この|その)?(?:プラン|計画)を(?:実装|承認)|承認する)/u.test(line))))
}
export function mountPlanTransition(ctx:{on(name:string,handler:(...args:any[])=>unknown,options?:any):()=>void},plan:any):()=>void {
  return ctx.on('agent/pre-step',async(payload:any,next:()=>Promise<any>)=>{
    if(plan?.get(payload.agent)?.active && implementationRequested(payload.messages??[]))plan.set(payload.agent,false)
    // Native Plan commits pending changes at an accepted boundary. Never reject
    // this step merely because get().active still reflects the old state.
    return next()
  },{prepend:true})
}
