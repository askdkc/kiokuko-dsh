import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { executionCommand, shellArguments, hasShellPipeline, mayRepeatCommand } from '../../../src/dsh/execution-command.js'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { assessTaskCompletion, beginTaskCompletionExecution, bindTaskCriterion, finishTaskCompletionExecution } from '../../../src/dsh/task-completion.js'
import { applicationSourceDigest } from '../../../src/memory/application.js'
import { runOwnedProcess } from '../../../src/dsh/owned-execution.js'

const collisions = [
  ['AUDIT_X=1 printf ok', "'AUDIT_X=1' printf ok"],
  ['! false', "'!' false"],
  [String.raw`printf '%s' 'a\\b'`, String.raw`printf '%s' "a\\b"`],
  ["printf '%s' ~", "printf '%s' '~'"],
  ["printf '%s' # ignored", "printf '%s' '#' ignored"],
  ['printf a\u00a0b', 'printf a b'],
]
test('shell-sensitive commands never share a normalized execution identity', () => {
  for (const [approved, actual] of collisions) {
    assert.notEqual(executionCommand(approved!), executionCommand(actual!))
    const left=spawnSync('bash',['-c',approved!],{encoding:'utf8'}),right=spawnSync('bash',['-c',actual!],{encoding:'utf8'})
    assert.notDeepEqual([left.stdout,left.status],[right.stdout,right.status],'real shell distinguishes the regression pair')
  }
  for (const command of ['echo ~', 'echo # x', 'echo a\u00a0b']) assert.equal(shellArguments(command), undefined)
  assert.deepEqual(shellArguments(String.raw`r\m file`), ['rm', 'file'], 'preserve destructive-command recognition')
  assert.deepEqual(shellArguments(String.raw`echo "a\\b"`), ['echo', String.raw`a\b`])
  assert.deepEqual(shellArguments(`node 'test file.mjs'`), ['node', 'test file.mjs'])
  assert.notEqual(executionCommand(`node 'test.mjs'`), executionCommand('node test.mjs'), 'no inferred shell equivalence even for benign quoting')
  assert.equal(mayRepeatCommand('AUDIT_X=1 printf ok', "'AUDIT_X=1' printf ok"),false,'correcting an assignment is not an unchanged retry')
  assert.equal(mayRepeatCommand('! false', "'!' false"),false,'correcting a reserved word is not an unchanged retry')
  assert.notEqual(executionCommand('node test.mjs'), 'node test.mjs', 'old persisted identity must not be reused')
})

test('pipeline diagnostic distinguishes literal pipes and boolean OR',()=>{
  assert.equal(hasShellPipeline(`printf '%s' 'a|b'`),false)
  assert.equal(hasShellPipeline('false || true'),false)
  assert.equal(hasShellPipeline(String.raw`printf a\|b`),false)
  assert.equal(hasShellPipeline('false | cat'),true)
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'command-identity-'))
  const root = join(base, 'repo'); await mkdir(root); await writeFile(join(root, 'check.mjs'), 'source')
  const db = openConnection(join(base, 'state.sqlite3')); migrateDatabase(db, join(process.cwd(), 'migrations'))
  const prepared = await prepareAgentTask(db, { requestId: 'identity', cwd: root, task: '調査する\n完了条件: 検査成功',
    dshSessionId: 'identity-session', completionMode: 'enforce', profileHints: { taskType: 'research', target: 'repo', expected: 'report', constraints: null }, capabilities: [], skillDiscoveryMode: 'off' })
  const runId=prepared.run.runId, criterionId=assessTaskCompletion(db,runId).criteria[0]!.criterionId
  return {root,db,runId,criterionId,close: async()=>{db.close();await rm(base,{recursive:true,force:true})}}
}
test('completion consumer rejects colliding command and invalidates old source evidence', async()=>{
  const f=await fixture()
  try {
    for(const [i,pair] of collisions.entries()) {
      bindTaskCriterion(f.db,{runId:f.runId,criterionId:f.criterionId,callId:`bind-${i}`,approved:true,
        method:{kind:'native_command',command:pair[0],cwd:'.',sourcePaths:['check.mjs'],assertion:'exit_zero'}})
      assert.equal(beginTaskCompletionExecution(f.db,{runId:f.runId,callId:`wrong-${i}`,command:pair[1]!,repositoryRoot:f.root}),false)
    }
    bindTaskCriterion(f.db,{runId:f.runId,criterionId:f.criterionId,callId:'plain',approved:true,
      method:{kind:'native_command',command:'true',cwd:'.',sourcePaths:['check.mjs'],assertion:'exit_zero'}})
    assert.equal(beginTaskCompletionExecution(f.db,{runId:f.runId,callId:'old',command:'true',repositoryRoot:f.root}),true)
    finishTaskCompletionExecution(f.db,{runId:f.runId,callId:'old',result:{value:{exitCode:0},content:[]}})
    assert.equal(assessTaskCompletion(f.db,f.runId).verified,true)
    f.db.prepare('UPDATE dsh_completion_executions SET source_digest=? WHERE call_id=?').run(applicationSourceDigest(f.root,['check.mjs']),'old')
    assert.equal(assessTaskCompletion(f.db,f.runId).verified,false,'historical command evidence must not complete a task')
  } finally {await f.close()}
})
test('aggregate pipeline success is not verification; ordinary shell semantics stay unchanged', async()=>{
  const f=await fixture()
  try {
    bindTaskCriterion(f.db,{runId:f.runId,criterionId:f.criterionId,callId:'pipeline',approved:true,
      method:{kind:'native_command',command:'false | cat',cwd:'.',sourcePaths:['check.mjs'],assertion:'exit_zero'}})
    assert.equal(beginTaskCompletionExecution(f.db,{runId:f.runId,callId:'pipe-run',command:'false | cat',repositoryRoot:f.root}),true)
    const result=await runOwnedProcess('false | cat',f.root,'bash',new AbortController().signal,5000)
    assert.equal(result.value.exitCode,0,'not global pipefail')
    finishTaskCompletionExecution(f.db,{runId:f.runId,callId:'pipe-run',result})
    assert.equal(assessTaskCompletion(f.db,f.runId).verified,false)
    assert.equal(assessTaskCompletion(f.db,f.runId).criteria[0]!.reason,'pipeline_stage_status_unknown_use_direct_verifier')
    assert.equal(f.db.prepare('SELECT outcome FROM dsh_completion_executions WHERE call_id=?').get('pipe-run')?.outcome,'unknown')
  }finally{await f.close()}
})

test('Lisp quote-all command composition requires exact rebind and then supports fresh selected-test proof',async()=>{
  const f=await fixture()
  try{
    await writeFile(join(f.root,'check.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('actual selected case',()=>assert.equal(2+2,4));\n")
    const argv=['node','--test','--test-reporter=tap','check.mjs']
    // Same quote-all encoding used by surface.ts native run and manager.ts owned fallback.
    const generated=argv.map(value=>"'"+value.replaceAll("'","'\\''")+"'").join(' ')
    const method={kind:'native_command',command:argv.join(' '),cwd:'.',sourcePaths:['check.mjs'],assertion:'selected_tests_pass'}
    bindTaskCriterion(f.db,{runId:f.runId,criterionId:f.criterionId,callId:'plain-tests',approved:true,method})
    assert.equal(beginTaskCompletionExecution(f.db,{runId:f.runId,callId:'before-rebind',command:generated,repositoryRoot:f.root}),false)
    bindTaskCriterion(f.db,{runId:f.runId,criterionId:f.criterionId,callId:'lisp-tests',approved:true,method:{...method,command:generated}})
    assert.equal(beginTaskCompletionExecution(f.db,{runId:f.runId,callId:'after-rebind',command:generated,repositoryRoot:f.root}),true)
    const result=await runOwnedProcess(generated,f.root,'bash',new AbortController().signal,5000)
    assert.equal(result.value.exitCode,0)
    finishTaskCompletionExecution(f.db,{runId:f.runId,callId:'after-rebind',result})
    assert.equal(assessTaskCompletion(f.db,f.runId).verified,true,'exact quote-all shell source can establish fresh selected-test proof')
  }finally{await f.close()}
})
