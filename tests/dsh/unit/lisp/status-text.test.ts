import assert from 'node:assert/strict'
import test from 'node:test'
import {formatLispStatus,type LispStatusView} from '../../../../src/dsh/lisp/status-text.js'

test('human status summarizes successful history and retains exact unresolved diagnostics',()=>{
  const history=Array.from({length:150},(_,i)=>({id:'completed-'+i,state:'SUCCEEDED',kind:'lisp_eval'}))
  const status:LispStatusView={enabled:true,state:'RECOVERY_REQUIRED',operations:[...history,{id:'unresolved-evaluation',state:'UNKNOWN',kind:'lisp_eval'}],
    operationCount:151,pendingCount:1,error:{message:'Evaluation timed out'},hot:{tools:[]}}
  const before=JSON.stringify(status),text=formatLispStatus(status)
  assert.match(text,/151件.*未解決: 1件/);assert.match(text,/UNKNOWN/)
  assert.match(text,/\/kioku-lisp diagnostics unresolved-evaluation/);assert.match(text,/\/kioku-lisp recover/)
  assert.doesNotMatch(text,/completed-/);assert.doesNotMatch(text,/\/kioku-lisp status で/)
  assert.ok(text.split('\n').length<20);assert.equal(JSON.stringify(status),before)
})

test('managed unknowns remain visible and are never presented as cleared by Lisp recovery',()=>{
  const status:LispStatusView={enabled:true,state:'RECONCILIATION_REQUIRED',managedReconciliationRequired:true,
    managedOperationCount:125,managedOperationsTruncated:true,managedOperations:[
      {id:'running-child',route:'native',kind:'process',state:'running'},
      ],managedUnknownOperations:[{id:'unknown-child',route:'native',kind:'process',state:'unknown'}],operations:[{id:'unknown-eval',state:'UNKNOWN',kind:'lisp_eval'}],operationCount:100,pendingCount:1}
  const text=formatLispStatus(status)
  assert.match(text,/外部処理の未解決: 125件/);assert.match(text,/\/kioku-lisp diagnostics unknown-child/)
  assert.match(text,/外部処理を確定できません/);assert.match(text,/自動再実行はしません/)
  assert.ok(text.indexOf('unknown-child')<text.indexOf('running-child'))
  assert.doesNotMatch(text,/recover で再開できます/)
})

test('status keeps pending counts beyond the page and bounds rendered operation IDs',()=>{
  const text=formatLispStatus({enabled:true,state:'STOP_UNCONFIRMED',operationCount:200,pendingCount:20,
    operations:Array.from({length:10},(_,i)=>({id:'pending-'+i,state:'UNKNOWN'}))})
  assert.match(text,/未解決: 20件/);assert.match(text,/ほかに17件/)
  assert.equal((text.match(/diagnostics pending-/g)??[]).length,3)
  assert.match(text,/\/kioku-lisp cancel/);assert.doesNotMatch(text,/利用できます/)
})

test('ready, disabled and suspended status offer the actual supported next action',()=>{
  assert.match(formatLispStatus({enabled:true,state:'READY',operations:[]}),/利用できます/)
  assert.match(formatLispStatus({enabled:false,state:'DISABLED'}),/\/kioku-lisp enable/)
  assert.match(formatLispStatus({enabled:true,state:'SUSPENDED'}),/変数・関数定義は保持されません/)
})

test('error excerpts cannot turn normal status into another unbounded transcript',()=>{
  const text=formatLispStatus({enabled:true,state:'RECOVERY_REQUIRED',error:{message:'diagnostic line\n'.repeat(2000)}})
  assert.ok(text.length<600);assert.ok(text.split('\n').length<10);assert.match(text,/…/)
})
