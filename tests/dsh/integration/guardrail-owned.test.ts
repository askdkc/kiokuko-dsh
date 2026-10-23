import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeCodingWorkflow, readCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { answerCodingChoice, proposeCodingWorkflow, synchronizeCodingWorkflow, codingStatus, nextCodingWork } from '../../../src/dsh/coding-workflow/service.js'
import { bindTaskCriterion, assessTaskCompletion } from '../../../src/dsh/task-completion.js'
import { OwnedExecutionService } from '../../../src/dsh/owned-execution.js'
import { readTaskSnapshot, requestTaskStop } from '../../../src/dsh/task-state.js'

const failingTest = "import test from 'node:test';import assert from 'node:assert/strict';import {a} from '../src/a.mjs';import {b} from '../src/b.mjs';test('declared two-file unit',()=>assert.equal(a+b,2));\n"
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'guardrail-owned-')))
  await mkdir(join(root, '.git')); await mkdir(join(root, 'src')); await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'src/a.mjs'), 'export const a=0;\n'); await writeFile(join(root, 'src/b.mjs'), 'export const b=0;\n')
  await writeFile(join(root, 'tests/unit.test.mjs'), '// Tests will be written through the owned route.\n')
  let db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const prepared = await prepareAgentTask(db, { requestId: 'protocol-request', dshSessionId: 'session', cwd: root,
    task: 'Implement the declared two-file unit', profileHints: { taskType: 'build', target: 'src/a.mjs src/b.mjs', expected: 'The selected test passes', constraints: 'Do not change tests after RED' }, capabilities: [], skillDiscoveryMode: 'off', sessionOwnership: true })
  const identity = { runId: prepared.run.runId, sessionId: 'session', repositoryRoot: root }
  initializeCodingWorkflow(db, { ...identity, requestId: 'protocol-request', task: 'Implement the declared two-file unit' })
  const definition = { goal: { goalId: 'goal', revision: 1, ideal: 'The unit works', target: 'src', outOfScope: [], constraints: [], requestBasis: 'Implement the unit', criterionIds: ['goal-check'] },
    items: [{ itemId: 'unit', change: 'Implement two files', dependsOn: [], criterionIds: ['unit-check'], goalCriterionIds: ['goal-check'] }],
    criteria: [{ criterionId: 'unit-check', revision: 1, outcome: 'The unit works', procedure: 'Run assertions', expected: 'Pass', evidence: 'selected_tests' }, { criterionId: 'goal-check', revision: 1, outcome: 'Public entry works', procedure: 'Run final assertions', expected: 'Pass', evidence: 'selected_tests' }] }
  const workflow = proposeCodingWorkflow(db, identity, 'propose', 1, definition)
  answerCodingChoice(db, identity, { callId: 'choice', expectedRevision: workflow.revision, workflowId: workflow.workflowId, scopeVersion: workflow.scopeVersion, questionId: workflow.choice.questionId, questionRevision: workflow.choice.revision, answerRef: 'human:yes', choice: 'yes' })
  const agent = { id: 'agent' }; let beforeDatabase: (() => void) | undefined
  const runtime: any = { withDatabase: async (fn: any) => { beforeDatabase?.(); return fn(db) } }
  const host = { runtime, resolve: (execution: any) => execution.agent === agent ? { ...identity, agent, workspace: prepared.project.workspace, generation: 'owner-generation' } : undefined }
  let service = new OwnedExecutionService(host)
  const execute = (name: string, args: any, callId: string, signal = new AbortController().signal) => service.execute(name, args, { name, arguments: args, callId, agent, signal }) as Promise<any>
  const command = 'node --test --test-reporter=tap tests/unit.test.mjs'
  const protocol = { kind: 'bounded-tdd-v1', unitId: 'unit', implementationPaths: ['src/a.mjs', 'src/b.mjs'], testPaths: ['tests/unit.test.mjs'] }
  const bind = () => bindTaskCriterion(db, { runId: identity.runId, callId: 'bind-protocol', criterionId: `coding:${workflow.workflowId}:unit-check`, method: { kind: 'native_command', command, cwd: '.', sourcePaths: [...protocol.implementationPaths, ...protocol.testPaths], assertion: 'selected_tests_pass', protocol }, approved: true })
  const phase = () => (readCodingWorkflow(db, identity.runId) as any)?.protocol?.phase
  return { root, identity, execute, command, bind, phase, protocol, bindGoal: () => bindTaskCriterion(db, {runId:identity.runId,callId:'bind-goal',criterionId:`coding:${workflow.workflowId}:goal-check`,method:{kind:'native_command',command,cwd:'.',sourcePaths:[...protocol.implementationPaths,...protocol.testPaths],assertion:'selected_tests_pass'},approved:true}), rebind: (overrides: Record<string, unknown>, callId = 'replacement') => bindTaskCriterion(db, { runId: identity.runId, callId, criterionId: `coding:${workflow.workflowId}:unit-check`, method: JSON.parse(JSON.stringify({ kind: 'native_command', command, cwd: '.', sourcePaths: [...protocol.implementationPaths, ...protocol.testPaths], assertion: 'selected_tests_pass', protocol, ...overrides })), approved: true }), get db() { return db }, hook: (fn?: () => void) => { beforeDatabase = fn },
    async red(source = failingTest) { await execute('kioku_write', { path: 'tests/unit.test.mjs', content: source }, 'write-tests'); return execute('kioku_exec', { command }, 'red') },
    async restart() { await service.close(); db.close(); db = openConnection(join(root, 'state.sqlite3')); service = new OwnedExecutionService(host) },
    async close() { beforeDatabase = undefined; await service.close(); db.close(); await rm(root, { recursive: true, force: true }) } }
}
async function denied(work: () => Promise<any>, pattern: RegExp) {
  let value
  try { value = await work() }
  catch (error) { assert.match(String(error), pattern); return }
  assert.match(value?.receipt?.error ?? '', pattern, 'The effect must fail closed')
}

test('actual Rust RED opens one multi-file unit; frozen tests, GREEN and restart preserve non-replay', async () => {
  const f = await fixture()
  try {
    f.bind(); assert.equal(f.phase(), 'write-tests')
    await denied(() => f.execute('kioku_write', { path: 'src/a.mjs', content: 'export const a=1;\n' }, 'early'), /RED|phase|protocol/i)
    assert.equal(await readFile(join(f.root, 'src/a.mjs'), 'utf8'), 'export const a=0;\n')
    const red = await f.red(); assert.equal(red.receipt.processStopped,true,`actual protocol child termination must be observed: ${JSON.stringify(red.receipt)}`); assert.equal(red.exitCode, 1); assert.equal(f.phase(), 'implement')
    const before = await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8')
    await denied(() => f.execute('kioku_write', { path: 'tests/unit.test.mjs', content: '// bypass' }, 'change-tests'), /frozen|test|protocol/i)
    const a = await f.execute('kioku_write', { path: 'src/a.mjs', content: 'export const a=1;\n' }, 'edit-a'); assert.equal(a.applied, true)
    const b = await f.execute('kioku_write', { path: 'src/b.mjs', content: 'export const b=1;\n' }, 'edit-b'); assert.equal(b.applied, true)
    assert.equal(f.phase(), 'implement'); assert.equal(await readFile(join(f.root, 'tests/unit.test.mjs'), 'utf8'), before)
    const green = await f.execute('kioku_exec', { command: f.command }, 'green'); assert.equal(green.exitCode, 0); assert.equal(f.phase(), 'report')
    const proof=readCodingWorkflow(f.db,f.identity.runId)!.protocol!
    assert.equal(proof.schema,2);assert.equal(proof.red!.outcome,'assertion-failure');assert.equal(proof.green!.outcome,'passed')
    const {ManagedOperationJournal}=await import('../../../src/dsh/managed-operation-journal.js')
    const audit=new ManagedOperationJournal(f.db)
    assert.equal(audit.readSnapshot(proof.red!.snapshot.snapshotId).operations[0]!.outcome,'failed','valid RED remains a failed execution in immutable audit')
    assert.equal(audit.readSnapshot(proof.green!.snapshot.snapshotId).operations[0]!.outcome,'succeeded')
    await f.restart()
    const replay = await f.execute('kioku_write', { path: 'src/a.mjs', content: 'export const a=1;\n' }, 'edit-a')
    assert.equal(replay.replayed, true); assert.equal(f.phase(), 'report')
    await denied(() => f.execute('kioku_write', { path: 'src/b.mjs', content: 'export const b=5;\n' }, 'after-green'), /phase|GREEN|protocol/i)
  } finally { await f.close() }
})

for (const [name, source] of Object.entries({
  'exit-one': 'process.exitCode=1;\n',
  'printed-TAP': "console.log('not ok 1 - fake\\n# tests 1\\n# pass 0\\n# fail 1\\n# cancelled 0\\n# skipped 0\\n# todo 0');console.log(JSON.stringify({code:'ERR_ASSERTION',failed:1}));process.exitCode=1;\n",
  syntax: 'import ???;\n', setup: "import './absent.mjs';\n",
  'non-assertion': "import test from 'node:test';test('throw',()=>{throw Error('failure')});\n",
  skip: "import test from 'node:test';test.skip('skip',()=>{});\n",
})) test(`${name} cannot mint a trusted RED observation`, async () => {
  const f = await fixture()
  try { f.bind(); await f.red(source); assert.notEqual(f.phase(), 'implement'); await denied(() => f.execute('kioku_write', { path: 'src/a.mjs', content: 'bypass' }, 'denied'), /RED|phase|protocol/i) }
  finally { await f.close() }
})

test('unbound command, out-of-unit path and source/test changes cannot reuse RED', async () => {
  const f = await fixture()
  try {
    f.bind(); await f.red()
    await denied(() => f.execute('kioku_exec', { command: 'node -e "process.exit(0)"' }, 'unbound'), /bound|protocol|command/i)
    await denied(() => f.execute('kioku_write', { path: 'outside.mjs', content: 'bypass' }, 'outside'), /scope|path|protocol/i)
    await writeFile(join(f.root, 'tests/unit.test.mjs'), failingTest + '// externally changed\n')
    await denied(() => f.execute('kioku_write', { path: 'src/a.mjs', content: 'bypass' }, 'stale-tests'), /changed|stale|amend|protocol/i)
    assert.equal(await readFile(join(f.root, 'src/a.mjs'), 'utf8'), 'export const a=0;\n')
  } finally { await f.close() }
})

test('stop after an implementation reservation is observed before the final effect', async () => {
  const f = await fixture()
  try {
    f.bind(); await f.red(); let stopped = false
    f.hook(() => {
      const protocol = (readCodingWorkflow(f.db, f.identity.runId) as any)?.protocol
      if (!stopped && protocol?.pending?.kind === 'file') {
        stopped = true; const identity = { taskId: f.identity.runId, sessionId: f.identity.sessionId, repositoryRoot: f.root }
        const task = readTaskSnapshot(f.db, identity)
        requestTaskStop(f.db, identity, { operation: 'wait', operationId: 'concurrent-stop', expectedRevision: task.revision, reason: 'Cancel before final effect' })
      }
    })
    await denied(() => f.execute('kioku_write', { path: 'src/a.mjs', content: 'bypass' }, 'racing-write'), /stale|stopped|authority|protocol/i)
    assert.equal(stopped, true); assert.equal(await readFile(join(f.root, 'src/a.mjs'), 'utf8'), 'export const a=0;\n')
  } finally { await f.close() }
})

for (const reverse of [false,true]) test(`GREEN requires a net source delta from RED (${reverse?'change then revert':'identical write'})`, async () => {
  const f=await fixture()
  try {
    f.bind();await f.red()
    if(reverse)assert.equal((await f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'temporary-change')).applied,true)
    assert.equal((await f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=0;\n'},'no-net-change')).applied,true)
    const retryAt=Math.max(0,...Object.values(readCodingWorkflow(f.db,f.identity.runId)!.attempts).map(attempt=>attempt.retryAt))
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,retryAt-Date.now())+20))
    const result=await f.execute('kioku_exec',{command:f.command},'false-green').catch(error=>({rejection:String(error)}))
    assert.notEqual(result.receipt?.processStarted,true,'No-op implementation must be rejected before spawning tests')
    assert.match(result.receipt?.error??result.rejection??'',/changed|delta|implementation/i)
    assert.equal(f.phase(),'implement')
  } finally {await f.close()}
})

test('removing protocol from the current completion binding invalidates the old RED lease',async()=>{
  const f=await fixture()
  try {
    f.bind();await f.red();f.rebind({protocol:undefined})
    await denied(()=>f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'old-binding-effect'),/binding|replaced|protocol/i)
    assert.equal(await readFile(join(f.root,'src/a.mjs'),'utf8'),'export const a=0;\n')
  } finally {await f.close()}
})

test('a same-scope amendment cannot broaden the previously admitted editable unit',async()=>{
  const f=await fixture()
  try {
    f.bind();await f.red()
    assert.throws(()=>f.rebind({protocol:{...f.protocol,implementationPaths:[...f.protocol.implementationPaths,'src/new.mjs']},sourcePaths:[...f.protocol.implementationPaths,...f.protocol.testPaths,'src/new.mjs']}),/scope|broaden|amend|path/i)
    assert.equal(f.phase(),'implement')
    assert.equal(fs.existsSync(join(f.root,'src/new.mjs')),false)
  } finally {await f.close()}
})

for(const asset of ['guardrail/node-runner.mjs','lisp/supervisor.mjs'])test(`runtime identity remains pinned across RED and GREEN: ${asset}`,async()=>{
  const f=await fixture(),original=fs.readFileSync
  try {
    f.bind();await f.red()
    await f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'edit-a')
    await f.execute('kioku_write',{path:'src/b.mjs',content:'export const b=1;\n'},'edit-b')
    fs.readFileSync=((file:any,...args:any[])=>{const result=(original as any)(file,...args);return typeof file==='string'&&file.endsWith(asset)?(Buffer.isBuffer(result)?Buffer.concat([result,Buffer.from('\n// changed observed runtime')]):result+'\n// changed observed runtime'):result}) as typeof fs.readFileSync
    syncBuiltinESMExports()
    const result=await f.execute('kioku_exec',{command:f.command},'changed-runtime').catch(error=>({rejection:String(error)}))
    assert.notEqual(result.receipt?.processStarted,true,'Runtime change must be rejected before GREEN starts')
    assert.match(result.receipt?.error??result.rejection??'',/runtime/i)
    assert.notEqual(f.phase(),'report')
  } finally {fs.readFileSync=original;syncBuiltinESMExports();await f.close()}
})

test('second-connection cancellation during launch preparation prevents the selected test process',async()=>{
  const f=await fixture(),original=fs.mkdirSync
  let other:ReturnType<typeof openConnection>|undefined,stopped=false
  try {
    f.bind();await f.red("import {appendFileSync} from 'node:fs';appendFileSync('calls','x');"+failingTest)
    await f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'edit-a')
    await f.execute('kioku_write',{path:'src/b.mjs',content:'export const b=1;\n'},'edit-b')
    other=openConnection(join(f.root,'state.sqlite3'))
    fs.mkdirSync=((file:any,...args:any[])=>{
      if(!stopped&&String(file).includes('kiokuko-protocol-env-')){
        const identity={taskId:f.identity.runId,sessionId:f.identity.sessionId,repositoryRoot:f.root},task=readTaskSnapshot(other!,identity)
        requestTaskStop(other!,identity,{operation:'wait',operationId:'second-connection-stop',expectedRevision:task.revision,reason:'Cancel during launch preparation'});stopped=true
      }
      return (original as any)(file,...args)
    }) as typeof fs.mkdirSync;syncBuiltinESMExports()
    const result=await f.execute('kioku_exec',{command:f.command},'cancelled-green').catch(error=>({rejection:String(error)}))
    assert.equal(stopped,true,'A distinct SQLite connection must commit cancellation')
    assert.notEqual(result.receipt?.processStarted,true,'Cancellation must be rechecked under the final writer transaction')
    assert.equal(await readFile(join(f.root,'calls'),'utf8'),'x','The selected test body must not run after committed cancellation')
  } finally {fs.mkdirSync=original;syncBuiltinESMExports();other?.close();await f.close()}
})

test('AssertionError name and ERR_ASSERTION code alone do not establish assertion provenance',async()=>{
  const f=await fixture()
  try {
    f.bind();await f.red("import test from 'node:test';test('fabricated error',()=>{const error=new Error('fake');error.name='AssertionError';error.code='ERR_ASSERTION';throw error});\n")
    assert.notEqual(f.phase(),'implement','A renamed ordinary Error must not open implementation')
    await denied(()=>f.execute('kioku_write',{path:'src/a.mjs',content:'bypass'},'forged-assertion-effect'),/RED|phase|protocol/i)
    assert.equal(await readFile(join(f.root,'src/a.mjs'),'utf8'),'export const a=0;\n')
  } finally {await f.close()}
})

test('a SQLite commit retry cannot repeat a launched selected-test process',async()=>{
  const f=await fixture(),originalSpawn=childProcess.spawn,originalExec=f.db.exec.bind(f.db)
  const children:ReturnType<typeof childProcess.spawn>[]=[]
  let launches=0,injected=false
  try {
    f.bind();await f.red()
    await f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'edit-a')
    await f.execute('kioku_write',{path:'src/b.mjs',content:'export const b=1;\n'},'edit-b')
    childProcess.spawn=((...args:any[])=>{
      const child=(originalSpawn as any)(...args)
      if(Array.isArray(args[1])&&String(args[1][0]).endsWith('/lisp/supervisor.mjs')){launches++;children.push(child)}
      return child
    }) as typeof childProcess.spawn;syncBuiltinESMExports()
    f.db.exec=(sql:string)=>{
      if(!injected&&launches>0&&sql==='COMMIT'){
        injected=true
        const error=Object.assign(new Error('Injected SQLite commit contention after real spawn'),{code:'ERR_SQLITE_ERROR',errcode:5})
        throw error
      }
      return originalExec(sql)
    }
    const result=await f.execute('kioku_exec',{command:f.command},'commit-contention')
    assert.equal(injected,true,'The database fault must occur after an actual child spawn')
    assert.equal(launches,1,'Retrying the SQLite callback must never spawn a second child')
    assert.equal(result.receipt?.processStarted,true,'An uncertain spawned operation cannot be represented as not started')
    assert.notEqual(result.receipt?.outputComplete,true)
    assert.equal(f.phase(),'blocked')
    await denied(()=>f.execute('kioku_exec',{command:f.command},'automatic-retry'),/pending|blocked|protocol|reconcil/i)
    assert.equal(launches,1,'A new call ID cannot replay an uncertain effect')
  } finally {
    f.db.exec=originalExec;childProcess.spawn=originalSpawn;syncBuiltinESMExports()
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')
    await f.close()
  }
})

test('trusted RED receipts reject altered issuer, task, generation and input identities',async()=>{
  const f=await fixture()
  try {
    f.bind();await f.red()
    const original=readCodingWorkflow(f.db,f.identity.runId)!.protocol!.red!
    const cases:Record<string,unknown>={schema:1,workerGeneration:'foreign-worker',snapshot:{...original.snapshot,digest:'0'.repeat(64)},issuer:'model:caller',id:'reused-other-receipt',generation:original.generation+1,sourceDigest:'0'.repeat(64),testDigest:'0'.repeat(64),commandDigest:'0'.repeat(64),runtimeDigest:'0'.repeat(64),task:{...original.task,revision:original.task.revision+1}}
    for(const [field,value]of Object.entries(cases)){
      f.db.prepare("UPDATE dsh_coding_workflows SET snapshot_json=json_set(snapshot_json,'$.protocol.red',json(?)) WHERE run_id=?").run(JSON.stringify({...original,[field]:value}),f.identity.runId)
      await denied(()=>f.execute('kioku_write',{path:'src/a.mjs',content:'bypass'},`tampered-${field}`),/receipt|issuer|binding|protocol|rebind-required/i)
      assert.equal(await readFile(join(f.root,'src/a.mjs'),'utf8'),'export const a=0;\n')
    }
    f.db.prepare("UPDATE dsh_coding_workflows SET snapshot_json=json_set(snapshot_json,'$.protocol.red',json(?)) WHERE run_id=?").run(JSON.stringify(original),f.identity.runId)
    f.db.prepare('DELETE FROM ledger_task_evidence WHERE run_id=? AND evidence_ref=?').run(f.identity.runId,`protocol-observation:${original.id}`)
    await denied(()=>f.execute('kioku_write',{path:'src/a.mjs',content:'bypass'},'missing-host-witness'),/receipt|binding|protocol/i)
    assert.equal(await readFile(join(f.root,'src/a.mjs'),'utf8'),'export const a=0;\n')
  } finally {await f.close()}
})

test('a receipt from another enrolled task cannot authorize this task',async()=>{
  const first=await fixture(),second=await fixture()
  try {
    first.bind();second.bind();await first.red();await second.red()
    const receipt=readCodingWorkflow(first.db,first.identity.runId)!.protocol!.red!
    second.db.prepare("UPDATE dsh_coding_workflows SET snapshot_json=json_set(snapshot_json,'$.protocol.red',json(?)) WHERE run_id=?").run(JSON.stringify(receipt),second.identity.runId)
    await denied(()=>second.execute('kioku_write',{path:'src/a.mjs',content:'bypass'},'cross-task-receipt'),/receipt|issuer|task|binding|protocol/i)
    assert.equal(await readFile(join(second.root,'src/a.mjs'),'utf8'),'export const a=0;\n')
  } finally {await first.close();await second.close()}
})

test('enrolled test environments omit undeclared host values and replayed RED cannot reopen GREEN',async()=>{
  const f=await fixture(),prior=process.env.KIOKUKO_SYNTHETIC_ENV_TOKEN,token='not-a-secret-guardrail-fixture'
  process.env.KIOKUKO_SYNTHETIC_ENV_TOKEN=token
  try {
    f.bind()
    const source=failingTest.replace("()=>assert.equal(a+b,2)","()=>{assert.equal(process.env.KIOKUKO_SYNTHETIC_ENV_TOKEN,undefined);assert.equal(a+b,2)}")
    const red=await f.red(source);assert.equal(f.phase(),'implement');assert.equal(JSON.stringify(red).includes(token),false)
    await f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'edit-a')
    await f.execute('kioku_write',{path:'src/b.mjs',content:'export const b=1;\n'},'edit-b')
    const green=await f.execute('kioku_exec',{command:f.command},'green');assert.equal(green.exitCode,0);assert.equal(f.phase(),'report')
    await f.restart()
    const replay=await f.execute('kioku_exec',{command:f.command},'red')
    assert.equal(replay.replayed,true);assert.equal(f.phase(),'report')
    await denied(()=>f.execute('kioku_write',{path:'src/a.mjs',content:'bypass'},'reopened-by-replay'),/phase|GREEN|protocol/i)
    assert.equal(await readFile(join(f.root,'src/a.mjs'),'utf8'),'export const a=1;\n')
  } finally {if(prior===undefined)delete process.env.KIOKUKO_SYNTHETIC_ENV_TOKEN;else process.env.KIOKUKO_SYNTHETIC_ENV_TOKEN=prior;await f.close()}
})


test('completion status separates protocol, owned effects and isolation capabilities',async()=>{
  const f=await fixture()
  try {
    f.bind()
    const status=assessTaskCompletion(f.db,f.identity.runId) as any
    assert.deepEqual(status.coding?.protocol?.capabilities,{validation:'bounded-cl-v1',evidence:'schema-2',managedAudit:'journal-v1',ownedEffects:'lease-transactional-v1',nodeTests:'process-only',lispEffects:'protected-required',rollback:false,heapRestoration:false})
    assert.equal(status.coding.protocol.phase,'write-tests')
    assert.equal(status.coding.protocol.kind,'bounded-tdd-v1')
  } finally {await f.close()}
})


test('an enrolled item GREEN can be followed by separately observed final Goal completion',async()=>{
  const f=await fixture()
  try {
    f.bind();f.bindGoal();await f.red()
    await f.execute('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'edit-a')
    await f.execute('kioku_write',{path:'src/b.mjs',content:'export const b=1;\n'},'edit-b')
    assert.equal((await f.execute('kioku_exec',{command:f.command},'item-green')).exitCode,0)
    assert.equal(f.phase(),'report')
    const before=assessTaskCompletion(f.db,f.identity.runId)
    assert.equal(before.criteria.find(item=>item.criterionId.endsWith(':unit-check'))!.state,'satisfied')
    assert.equal(before.verified,false)
    assert.equal((await f.execute('kioku_exec',{command:f.command},'final-goal')).exitCode,0)
    const after=assessTaskCompletion(f.db,f.identity.runId)
    assert.equal(after.verified,true,'The final Goal needs its own observed method receipt after item success')
    assert.equal(after.criteria.every(item=>item.state==='satisfied'),true)
    assert.notEqual(after.criteria[0]!.evidenceRef,after.criteria[1]!.evidenceRef)
    assert.equal(f.phase(),'report')
    assert.equal(synchronizeCodingWorkflow(f.db,f.identity.runId)!.state,'completed')
    const status=codingStatus(f.db,f.identity)
    assert.equal(status.applicable&&status.assessment.verified,true,'Completed workflow reporting must retain current observed evidence')
    assert.equal(assessTaskCompletion(f.db,f.identity.runId).verified,true)
    const next=nextCodingWork(f.db,f.identity)
    assert.equal('next' in next?next.next:undefined,'completed')
  } finally {await f.close()}
})

test('protocol cancellation retains observed process stop without granting RED',async()=>{
  const f=await fixture(),abort=new AbortController(),original=childProcess.spawn
  try{
    f.bind();await f.execute('kioku_write',{path:'tests/unit.test.mjs',content:failingTest},'cancel-tests')
    childProcess.spawn=((...args:any[])=>{
      const child=(original as any)(...args)
      if(Array.isArray(args[1])&&String(args[1][0]).endsWith('/lisp/supervisor.mjs'))child.stdio[4]?.on('data',(chunk:Buffer)=>{if(chunk.toString().includes('"processStarted":true'))abort.abort()})
      return child
    }) as typeof childProcess.spawn;syncBuiltinESMExports()
    const result=await f.execute('kioku_exec',{command:f.command},'cancel-protocol',abort.signal)
    assert.equal(result.receipt.processStarted,true);assert.equal(result.receipt.processStopped,true)
    assert.equal(result.receipt.cancelled,true);assert.notEqual(f.phase(),'implement')
  }finally{childProcess.spawn=original;syncBuiltinESMExports();await f.close()}
})

test('legacy schema 1 is retained read-only and blocks only the enrolled unit pending rebind',async()=>{
  const f=await fixture()
  try {
    f.bind()
    f.db.prepare("UPDATE dsh_coding_workflows SET snapshot_json=json_set(snapshot_json,'$.protocol.schema',1) WHERE run_id=?").run(f.identity.runId)
    const {readProtocol,protocolCompletionReady}=await import('../../../src/dsh/guardrail/service.js')
    assert.match(readProtocol(f.db,f.identity.runId)!.reason!,/rebind-required/)
    const status=codingStatus(f.db,f.identity)
    assert.ok(status.applicable);if(status.applicable)assert.match(status.protocol!.reason!,/rebind-required/)
    assert.equal(readCodingWorkflow(f.db,f.identity.runId)!.protocol!.schema,1,'the legacy original is not silently migrated')
    assert.equal(protocolCompletionReady(f.db,f.identity.runId),false)
    const read=await f.execute('kioku_read',{path:'src/a.mjs'},'legacy-read')
    assert.equal(read.content,'export const a=0;\n')
    await denied(()=>f.execute('kioku_write',{path:'tests/unit.test.mjs',content:failingTest},'legacy-write'),/rebind-required/)
    assert.equal(await readFile(join(f.root,'tests/unit.test.mjs'),'utf8'),'// Tests will be written through the owned route.\n')
  } finally {await f.close()}
})

test('an unknown sibling operation cannot be hidden by a new test ID, rebind or completion',async()=>{
  const f=await fixture()
  try {
    f.bind();await f.red()
    const {ManagedOperationJournal}=await import('../../../src/dsh/managed-operation-journal.js')
    const journal=new ManagedOperationJournal(f.db)
    const scope=journal.createScope({sessionId:f.identity.sessionId,parentId:'uncertain-sibling',runtimeIdentity:'fixture',binding:{taskId:f.identity.runId}})
    const operation=journal.prepare(scope.scopeId,{route:'owned',kind:'process',request:{command:'fixture'}})
    assert.equal(journal.claim(operation.operationId),true)
    journal.transition(operation.operationId,{state:'unknown',cause:'timeout'})
    journal.seal(scope.scopeId)
    await denied(()=>f.execute('kioku_write',{path:'src/a.mjs',content:'bypass'},'after-unknown'),/unresolved|reconciliation/i)
    assert.throws(()=>f.rebind({},'rebind-unknown'),/unresolved|reconciliation/i)
    const {protocolCompletionReady}=await import('../../../src/dsh/guardrail/service.js')
    assert.equal(protocolCompletionReady(f.db,f.identity.runId),false)
    assert.equal(journal.readOperation(operation.operationId).state,'unknown')
    assert.equal(await readFile(join(f.root,'src/a.mjs'),'utf8'),'export const a=0;\n')
  } finally {await f.close()}
})

test('nested owned bridge uses sealed child proof without prematurely sealing its evaluation',async()=>{
  const f=await fixture()
  try {
    f.bind()
    const {ManagedOperationJournal}=await import('../../../src/dsh/managed-operation-journal.js')
    const {runManagedOperation}=await import('../../../src/dsh/managed-operation-runner.js')
    const {protocolCompletionReady}=await import('../../../src/dsh/guardrail/service.js')
    const journal=new ManagedOperationJournal(f.db),database=async <T>(fn:(db:typeof f.db)=>T)=>fn(f.db)
    const evaluation=journal.createScope({sessionId:f.identity.sessionId,parentId:'evaluation',runtimeIdentity:'fixture'})
    const bridge=(name:string,args:any,id:string)=>runManagedOperation({database,scopeId:evaluation.scopeId},{route:'owned',kind:name==='kioku_exec'?'process':'file',request:{name,args}},()=>f.execute(name,args,id)) as Promise<any>
    await bridge('kioku_write',{path:'tests/unit.test.mjs',content:failingTest},'nested-tests')
    assert.equal((await bridge('kioku_exec',{command:f.command},'nested-red')).exitCode,1)
    assert.equal(f.phase(),'implement')
    await bridge('kioku_write',{path:'src/a.mjs',content:'export const a=1;\n'},'nested-a')
    await bridge('kioku_write',{path:'src/b.mjs',content:'export const b=1;\n'},'nested-b')
    assert.equal((await bridge('kioku_exec',{command:f.command},'nested-green')).exitCode,0)
    assert.equal(f.phase(),'report')
    assert.equal(journal.snapshot(evaluation.scopeId).sealed,false,'a child cannot seal its containing evaluation')
    assert.equal(protocolCompletionReady(f.db,f.identity.runId),false,'an open task-bound collector is not complete')
    const proof=readCodingWorkflow(f.db,f.identity.runId)!.protocol!.green!
    const child=journal.readSnapshot(proof.snapshot.snapshotId)
    assert.equal(child.sealed,true);assert.notEqual(child.scopeId,evaluation.scopeId)
    assert.equal(journal.readOperation(child.scope.parentId).scopeId,evaluation.scopeId)
    journal.seal(evaluation.scopeId)
    assert.equal(protocolCompletionReady(f.db,f.identity.runId),true)
  } finally {await f.close()}
})
