import assert from 'node:assert/strict'
import test from 'node:test'
import {join,dirname} from 'node:path'
import {openConnection} from '../../../src/db/connection.js'
import {nativeSkillFixture} from '../helpers/skill-native.js'
import {nativeToolResults} from '../helpers/native-mock.js'
import {interpretedPreparation} from '../helpers/coding-script.js'
import {isolateSkillHome} from '../helpers/skill-home.js'
import {DshSkillPrompts} from '../../../src/dsh/skill-prompts.js'

isolateSkillHome()
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const extra={lisp:{enabled:false},typedDecisions:{mode:'off'},modelHandoff:{mode:'off'},answerReview:{mode:'off'},memoryReview:{mode:'off'},
  memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}}

for(const mode of ['full','compiled'] as const)test(`native ${mode}: feedback and compaction persist locally, then reach the next model request and public tag search`,async()=>{
  const f=await nativeSkillFixture({packages,explicit:true,mode,extra,prompts:new DshSkillPrompts({mode})})
  try{
    f.responses.push(f.mock.textResponse('Public parser explanation.'))
    await f.turn('parser の仕組みを説明してください。')
    const session=f.agent.session,start=session.seq
    session.append('model/selection',{provider:'mock',model:'another-model'})
    session.append('compaction/start',{compactionId:'memory-native-compact',turn:null})
    session.append('compaction/summary',{compactionId:'memory-native-compact',summary:[{type:'text',text:'Preserve parser error boundaries.'}],
      shadowedRange:{start:start,end:start},shadowedSeqs:[start],shadowedTokenCount:1,provider:'mock',model:'another-model'})
    session.append('compaction/end',{compactionId:'memory-native-compact',turn:null})
    session.append('feedback/message-put',{sessionId:session.id,item:{messageId:'public-answer',rating:'negative',note:'Parser regression needs explicit assertions',version:'feedback-v1',createdAt:1,updatedAt:1}})
    f.responses.push(...f.mock.prepareWork([(request:any)=>{
      const text=JSON.stringify(request.messages.filter((message:any)=>message.source?.sections?.some((section:any)=>section.name==='memory:lifecycle')))
      assert.match(text,/Parser regression needs explicit assertions/)
      assert.match(text,/Preserve parser error boundaries/)
      assert.match(text,/Untrusted project memory/)
      assert.match(text,/When a procedure or method is unclear, search memory_context/)
      assert.match(request.messages.flatMap((message:any)=>message.content??[]).map((block:any)=>block.text??'').join('\n'),/"scope":"global"/)
      return f.mock.toolCallResponse('local-context','memory_context',{cwd:f.dir,tags:['complaint'],query:'Parser'})
    },(request:any)=>{
      const result=nativeToolResults(request.messages).find(value=>value.toolCallId==='local-context')
      assert.ok(result&&!result.isError,JSON.stringify(result))
      const context=JSON.parse(result.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join(''))
      assert.equal(context.workMayContinue,true);assert.equal(context.cautions.length,1)
      assert.equal(context.cautions[0].verification,'unknown')
      return f.mock.textResponse('Recorded source-backed caution was read.')
    }],'research','memory-prepare',interpretedPreparation(f.mock,'memory-prepare','new','research','research')))
    await f.turn('parser のやり方が分からないので、保存した注意事項と手順を検索してください。')
    const terminal= session.snapshotEvents().filter((event:any)=>event.type==='turn/end').at(-1)
    const beforeClose=openConnection(join(dirname(f.dir),'state.sqlite3'))
    let runId:string
    try {
      const run=beforeClose.prepare("SELECT run_id FROM ledger_runs WHERE dsh_session_id=? AND status='active' ORDER BY started_at DESC LIMIT 1").get<{run_id:string}>(session.id)
      assert.ok(run,'the public preparation must have admitted a real run');runId=run.run_id
    }finally{beforeClose.close()}
    await f.adapter!.host.lifecycle!.closeTurn({runId,status:'completed',sourceEndSeq:terminal.seq,terminalTurn:terminal.data.turn})
    session.append('feedback/message-delete',{sessionId:session.id,messageId:'public-answer'})
    f.responses.push((request:any)=>{
      const text=JSON.stringify(request.messages.filter((message:any)=>message.source?.sections?.some((section:any)=>section.name==='memory:lifecycle')))
      assert.ok(!text.includes('Parser regression needs explicit assertions'),'withdrawn feedback must not be projected on the next request')
      assert.ok(!JSON.stringify(request.messages).includes('Parser regression needs explicit assertions'),'old memory_context tool results must also be retired')
      return f.mock.textResponse('Withdrawal respected.')
    })
    await f.turn('次の説明をお願いします。')
    const db=openConnection(join(dirname(f.dir),'state.sqlite3'))
    try{
      const observations=db.prepare('SELECT observation_json,tombstone FROM dsh_memory_observations').all<{observation_json:string;tombstone:number}>()
      assert.ok(observations.some(row=>JSON.parse(row.observation_json).kind==='model_switch'))
      assert.ok(observations.some(row=>JSON.parse(row.observation_json).kind==='compaction'))
      assert.ok(observations.some(row=>row.tombstone===1))
      const completion=observations.map(row=>JSON.parse(row.observation_json)).find(row=>row.kind==='completion'&&row.source.runId===runId)
      assert.ok(completion,'the committed host close must be saved by the local observer')
      assert.equal(completion.verification,'unknown','a read-only task ending is not a verified implementation result')
    }finally{db.close()}
  }finally{await f.close()}
})
