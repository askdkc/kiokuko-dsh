import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve,join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root=resolve(import.meta.dirname,'..'),provider=join(root,'.artifacts/code-intelligence/dsh-lsp-server')
const mode=process.argv[2]
if(!mode){
 const measurements={}
 for(const candidate of ['read-grep-lsp','code'])measurements[candidate]=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[import.meta.filename,candidate],{cwd:root,stdio:['ignore','pipe','inherit']});let output=''
  child.stdout.on('data',chunk=>output+=chunk);child.once('error',reject);child.once('exit',code=>code===0?resolve(JSON.parse(output)):reject(new Error(`Benchmark ${candidate} failed (${code})`)))
 })
 const report={schemaVersion:1,scenario:'Five disk TS files, 200 declarations each: locate first declaration, retrieve selected source and hover; cold provider in a separate process for each route.',runtime:process.version,platform:process.platform,measurements,
  limitations:['Serialized fixture payload bytes are measured; no tokenizer or model request is involved.','Host peak RSS excludes separate language-server process RSS.','This fixture returns full source for the read baseline; ordinary read limits and compaction may change the comparison.','No general latency, memory or token reduction claim.']}
 await mkdir(join(root,'.artifacts/code-intelligence'),{recursive:true});await writeFile(join(root,'.artifacts/code-intelligence/benchmark.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}else{
 assert.ok(['read-grep-lsp','code'].includes(mode))
 const modules=join(provider,'node_modules/@deepseek-ai')
 const [cordis,fs,subprocess,lsp,plugin]=await Promise.all(['cordis','dsh-fs-local','dsh-subprocess-local','dsh-lsp'].map(name=>import(pathToFileURL(join(modules,name,'lib/index.js')).href)).concat([import(pathToFileURL(join(provider,'lib/provider.js')).href)]))
 const workspace=await mkdtemp(join(tmpdir(),'code-benchmark-')),ctx=new cordis.Context();let lease
 let calls=0,bytes=0;const start=performance.now(),cpu=process.cpuUsage()
 try{
  for(let i=0;i<5;i++)await writeFile(join(workspace,`file${i}.ts`),Array.from({length:200},(_,j)=>`export function f${j}() {\n // ${'documentation '.repeat(10)}\n return ${j}\n}`).join('\n'))
  await ctx.plugin(fs.default,{cwd:workspace});await ctx.plugin(subprocess.default);await ctx.plugin(lsp.default);await ctx.plugin(plugin,{servers:{phpantom:{enabled:false}},tailwind:{enabled:false}})
  const signal=AbortSignal.timeout(30000)
  if(mode==='code')lease=await ctx.get('codeIntelligence').bind({owner:{agentId:'benchmark',sessionId:'benchmark'},workspaceRoot:workspace,scope:ctx,context:ctx,assertCurrent(){signal.throwIfAborted()}},signal)
  for(let i=0;i<5;i++){
   const file=`file${i}.ts`
   if(lease){
    const opened=await lease.request({method:'snapshot.open',path:file},signal);calls++;assert.equal(opened.status,'ok')
    const handle=opened.data.handle,outline=await lease.request({method:'structure.outline',handle,limit:5},signal);calls++;assert.ok(['ok','partial'].includes(outline.status),JSON.stringify(outline))
    const selected=outline.data.items[0],span=await lease.request({method:'structure.span',nodeHandle:selected.handle,maxChars:1000},signal);calls++
    const hover=await lease.request({method:'semantic.query',handle,kind:'hover',position:{line:0,character:20}},signal);calls++;assert.equal(hover.status,'ok')
    bytes+=Buffer.byteLength(JSON.stringify({outlineStatus:outline.status,omitted:outline.omitted,selected,span,hover}))
    await lease.request({method:'snapshot.release',handle},signal)
   }else{
    const target=await ctx.fs.resolve(file,{cwd:workspace});let source='';for await(const chunk of await ctx.fs.streamText(target,signal))source+=chunk;calls++
    const grep=source.split('\n').filter(line=>line.includes('export function'));calls++
    const hover=await ctx.lsp.query({workspaceRoot:workspace,filePath:file,operation:'hover',position:{line:0,character:20}},signal);calls++
    bytes+=Buffer.byteLength(JSON.stringify({source,grep,hover}))
   }
  }
  const used=process.cpuUsage(cpu)
  console.log(JSON.stringify({wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,serializedPayloadBytes:bytes,chargedRoundTrips:calls,cleanupRoundTrips:lease?5:0,hostPeakRssKiB:process.resourceUsage().maxRSS,languageServerPeakRssKiB:null}))
 }finally{await lease?.dispose();await ctx.fiber.dispose();await rm(workspace,{recursive:true,force:true})}
}
