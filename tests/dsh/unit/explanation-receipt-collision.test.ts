import assert from 'node:assert/strict'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { explanationProof } from '../../../src/dsh/explanation-provenance.js'
import { retiredExplanationCalls } from '../../../src/dsh/request-memory.js'

test('a stale DB receipt with the same session/call ID cannot retire a new explanation', () => {
  const db=openConnection(':memory:')
  db.exec(`CREATE TABLE memory_explain_receipts(session_id TEXT,call_id TEXT,entry_id TEXT,revision INTEGER);
    CREATE TABLE memory_forget_tombstones(entry_id TEXT);
    INSERT INTO memory_explain_receipts VALUES('reused-session','same','old-entry',1);
    INSERT INTO memory_forget_tombstones VALUES('old-entry');`)
  const events:any[]=[{seq:0,type:'tool/call',data:{callId:'same',name:'memory_explain'}}]
  const session={id:'reused-session',header:{id:'reused-session',createdAt:2},snapshotEvents:()=>events}
  const proof=explanationProof(session,'same','new-registration')
  events.push({seq:1,type:'tool/result',data:{message:{source:{callId:'same'}},meta:{kiokukoExplanation:{...proof,entryId:'new-entry',revision:2}}}})
  try {
    assert.equal(retiredExplanationCalls(db,session).size,0)
    db.prepare('INSERT INTO memory_forget_tombstones VALUES(?)').run('new-entry')
    assert.deepEqual([...retiredExplanationCalls(db,session)],['same'])
  }finally{db.close()}
})
