/** Test-only transport. Each response is chosen live by the executing assistant. */
import {mkdirSync,writeFileSync,realpathSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {tmpdir} from 'node:os'
let sequence=0
export async function* liveAssistantStream(directory,options) {
  const requested=resolve(directory)
  // A private OS temporary directory is the Mac developer path. Canonicalize
  // before accepting it so a symlink cannot redirect requests outside it.
  const roots=[realpathSync(tmpdir()),realpathSync('/tmp'),'/workspace']
  const within=(parent,child)=>{const r=relative(parent,child);return r!==''&&!r.startsWith('..')&&!isAbsolute(r)}
  if(![...roots,resolve(tmpdir()),'/tmp'].some(parent=>within(parent,requested)))throw new Error('Live acceptance bridge must be inside a private temporary or cloud workspace directory')
  mkdirSync(requested,{recursive:true,mode:0o700})
  const root=realpathSync(requested)
  if(!roots.some(parent=>within(parent,root)))throw new Error('Live acceptance bridge escaped its private directory')
  const id=`${process.pid}-${++sequence}`
  const messages=options.messages.map(message=>({role:message.role,...(message.id?{id:message.id}:{}),content:message.content,
    ...(message.toolCallId?{toolCallId:message.toolCallId}:{}),...(message.isError?{isError:true}:{}),
    ...(message.source?{source:{kind:message.source.kind,...(message.source.form?{form:message.source.form}:{}),...(message.source.sections?{sections:message.source.sections}:{})}}:{})}))
  writeFileSync(join(root,`request-${id}.json`),JSON.stringify({transport:'live-assistant-in-loop; no external provider authentication',id,provider:options.provider,model:options.model,sessionId:options.sessionId,purpose:options.purpose,system:options.system,messages,tools:options.tools??[]},null,2),{flag:'wx',mode:0o600})
  const deadline=Date.now()+120000
  let answer
  while(answer===undefined){options.signal?.throwIfAborted();if(Date.now()>deadline)throw new Error('Live assistant response deadline reached')
    try{answer=JSON.parse(await readFile(join(root,`response-${id}.json`),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,25))}}
  if(answer.calls){for(const [index,call] of answer.calls.entries()){yield{type:'block-start',index,blockType:'tool-call'};yield{type:'block-end',index,block:{type:'tool-call',id:call.id,name:call.name,arguments:JSON.stringify(call.arguments)}}}yield{type:'finish',reason:{kind:'tool-calls'}}}
  else {if(typeof answer.text!=='string')throw new Error('Live assistant response needs text or calls');yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:answer.text};yield{type:'block-end',index:0,block:{type:'text',text:answer.text}};yield{type:'finish',reason:{kind:'stop'}}}
}
