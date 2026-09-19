import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixture,createRun,NOW } from '../evolution/fixture.js'
import { admitReview,configureReview,reserveReview,claimReview,dispatchReview,reviewSettings } from '../../../../src/memory/review/store.js'
import { collectReviewEvidence,reviewManifest } from '../../../../src/memory/review/evidence.js'
import { MemoryReviewConfig } from '../../../../src/memory/review/contracts.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
const events=[{type:'turn/start',seq:1,time:1,data:{turn:1}},{type:'user/message',seq:2,time:2,data:{id:'input',source:{kind:'user'},content:'Use Japanese for project answers'}},{type:'turn/end',seq:3,time:3,data:{turn:1,reason:{kind:'completed'}}}]
async function seed(db:ReturnType<typeof fixture>['db'],runId:string){
 createRun(db,runId)
 const range={workspace:'project:test',runId,sessionId:`session-${runId}`,sourceGeneration:'generation',startSeq:1,endSeq:3}
 const evidence=await collectReviewEvidence((async function*(){yield*events})(),32768)
 return withImmediateTransaction(db,()=>{
  configureReview(db,range.workspace,MemoryReviewConfig.parse({dailyCalls:1}),NOW);admitReview(db,range)
  return reserveReview(db,range,{evidence:reviewManifest(evidence),existing:[],lookupIncomplete:false,model:{provider:'fixture',model:'fixed',contextWindow:100000}},'manual',NOW)
 })
}
test('T13: two processes sharing SQLite start the same job/provider exactly once',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-processes-')),path=join(root,'state.sqlite3'),f=fixture(path)
 try{
  await seed(f.db,'concurrent')
  const source=join(root,'source.json'),calls=join(root,'calls.txt');await writeFile(source,JSON.stringify(events));await writeFile(calls,'')
  const run=()=>promisify(execFile)(process.execPath,['--import','tsx','tests/dsh/integration/memory-review/worker-process.ts',path,source,calls])
  await Promise.all([run(),run()])
  assert.equal((await readFile(calls,'utf8')).trim(),'provider reached')
  assert.equal(f.db.prepare('SELECT state FROM memory_review_jobs').get()?.state,'completed')
 }finally{f.db.close();await rm(root,{recursive:true,force:true})}
})
test('T12/T17: sent claims expire to held; budget-deferred work becomes claimable on the next UTC day',async()=>{
 const f=fixture()
 try{
  await seed(f.db,'one');await seed(f.db,'two')
  let one=withImmediateTransaction(f.db,()=>claimReview(f.db,'project:test',NOW))!
  assert.ok(withImmediateTransaction(f.db,()=>dispatchReview(f.db,one,NOW)))
  let two=withImmediateTransaction(f.db,()=>claimReview(f.db,'project:test',NOW))!
  assert.equal(withImmediateTransaction(f.db,()=>dispatchReview(f.db,two,NOW)),false)
  assert.equal(f.db.prepare('SELECT state FROM memory_review_jobs WHERE id=?').get(two.id)?.state,'deferred')
  const next='2026-09-11T00:00:00.000Z'
  two=withImmediateTransaction(f.db,()=>claimReview(f.db,'project:test',next))!
  assert.equal(f.db.prepare('SELECT state FROM memory_review_jobs WHERE id=?').get(one.id)?.state,'held')
  assert.ok(withImmediateTransaction(f.db,()=>dispatchReview(f.db,two,next)))
  assert.equal(reviewSettings(f.db,'project:test')!.generation,1)
 }finally{f.db.close()}
})
