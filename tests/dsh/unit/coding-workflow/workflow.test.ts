import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { CodingDefinitionSchema, type CodingDefinition } from '../../../../src/dsh/coding-workflow/contracts.js'
import { codingControlOrRead, codingIntent, codingContinuation, documentEditIntent, documentContinuation } from '../../../../src/dsh/coding-workflow/intent.js'
import { initializeCodingWorkflow, readCodingWorkflow } from '../../../../src/dsh/coding-workflow/store.js'
import { answerCodingChoice, assertCodingDispatch, codingItems, codingStatus, nextCodingWork, proposeCodingWorkflow,
  recordCodingAttempt, stopCodingWorkflow, synchronizeCodingWorkflow } from '../../../../src/dsh/coding-workflow/service.js'
import { assessTaskCompletion, bindTaskCriterion, taskCompletionBlocksClose, beginTaskCompletionExecution, finishTaskCompletionExecution } from '../../../../src/dsh/task-completion.js'
import { OwnedExecutionService, runOwnedProcess } from '../../../../src/dsh/owned-execution.js'
import { parseCodingChoice, mountCodingWorkflow } from '../../../../src/dsh/coding-workflow/host.js'
import { bindMainModelRequestIntent, createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds } from '../../../../src/dsh/decisions/request-intent.js'

export const definition: CodingDefinition = {
  goal: { goalId: 'goal', revision: 1, ideal: 'The user can run the parser and get the expected result', target: 'src/parser.mjs',
    outOfScope: ['Publishing'], constraints: ['Preserve the input format'], requestBasis: 'Implement the parser', criterionIds: ['goal-check'] },
  items: [{ itemId: 'parser', change: 'Implement the parser', dependsOn: [], criterionIds: ['parser-check'], goalCriterionIds: ['goal-check'] }],
  criteria: [{ criterionId: 'parser-check', revision: 1, outcome: 'Parser handles the input', procedure: 'Run selected parser assertions', expected: 'One actual assertion passes', evidence: 'selected_tests' as const },
    { criterionId: 'goal-check', revision: 1, outcome: 'Run the public parser entry', procedure: 'Run the user-entry assertions after item checks', expected: 'One actual assertion passes', evidence: 'selected_tests' as const }],
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coding-workflow-')))
  await mkdir(join(root, 'src')); await mkdir(join(root, '.git'))
  await writeFile(join(root, 'src/check.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';test('user entry',()=>assert.equal(2+2,4));\n")
  let db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const prepared = await prepareAgentTask(db, { requestId: 'coding-request', dshSessionId: 'session', cwd: root,
    task: 'Implement the parser in src/parser.mjs', profileHints: { taskType: 'build', target: 'src/parser.mjs', expected: 'The parser works', constraints: 'Preserve the input format' },
    capabilities: [], skillDiscoveryMode: 'off', completionMode: 'shadow' })
  const identity = { runId: prepared.run.runId, sessionId: 'session', repositoryRoot: root }
  initializeCodingWorkflow(db, { ...identity, requestId: 'coding-request', task: 'Implement the parser in src/parser.mjs' })
  const agent = { id: 'agent' }, runtime: any = { withDatabase: async (fn: any) => fn(db) }
  let service = new OwnedExecutionService({ runtime, resolve: execution => execution.agent === agent ? { ...identity, agent, workspace: prepared.project.workspace, generation: 'generation' } : undefined })
  const execute = (name: string, args: any, callId: string) => service.execute(name, args, { name, arguments: args, callId, agent, signal: new AbortController().signal }) as Promise<any>
  const propose = () => proposeCodingWorkflow(db, identity, 'propose', 1, definition)
  const choose = (choice: 'yes' | 'no' | 'cancelled' = 'no') => {
    const value = readCodingWorkflow(db, identity.runId)!
    return answerCodingChoice(db, identity, { callId: 'choice-'+value.scopeVersion, expectedRevision: value.revision, workflowId: value.workflowId,
      scopeVersion: value.scopeVersion, questionId: value.choice.questionId, questionRevision: value.choice.revision, answerRef: 'human:card', choice })
  }
  const command = 'node --test --test-reporter=tap src/check.test.mjs'
  const bind = (id: string, check = command) => bindTaskCriterion(db, { runId: identity.runId, callId: 'bind-'+id,
    criterionId: assessTaskCompletion(db, identity.runId).criteria.find(item => item.criterionId.endsWith(':'+id))!.criterionId,
    method: { kind: 'native_command', command: check, cwd: '.', sourcePaths: ['src/check.test.mjs'], assertion: 'selected_tests_pass' }, approved: true })
  return { root, identity, get db() { return db }, execute, propose, choose, command, bind,
    async restart() { await service.close(); db.close(); db = openConnection(join(root, 'state.sqlite3')); service = new OwnedExecutionService({ runtime, resolve: execution => execution.agent === agent ? { ...identity, agent, workspace: prepared.project.workspace, generation: 'generation' } : undefined }) },
    async close() { await service.close(); db.close(); await rm(root, { recursive: true, force: true }) } }
}

test('strict definition rejects empty criteria, unknown IDs, disconnected Goal and cycles', () => {
  assert.equal(CodingDefinitionSchema.safeParse(definition).success, true)
  for (const alter of [(v:any)=>v.goal.ideal='', (v:any)=>v.items[0].criterionIds=[], (v:any)=>v.items[0].dependsOn=['missing'],
    (v:any)=>v.items[0].dependsOn=['parser'], (v:any)=>v.items[0].goalCriterionIds=['missing'], (v:any)=>v.criteria.push({...v.criteria[0]})]) {
    const value = structuredClone(definition); alter(value); assert.equal(CodingDefinitionSchema.safeParse(value).success, false)
  }
})
test('human coding intent is independent of labels, quotations, examples and negations', () => {
  for (const text of ['Implement the parser.', 'Fix the overflow in src/parser.ts', 'Can you update the config to persist values?', 'この不具合を修正して']) assert.equal(codingIntent(text), true, text)
  for (const text of ['Explain how the parser works.', 'Should we fix this?', '修正すべき？', 'Do not implement this.', '> Implement the parser', '```\nImplement this\n```', 'この計画だけ作って', 'Fix it', 'fix or explain, I have not decided']) assert.equal(codingIntent(text), false, text)
})
test('README text edits preserve the document path without admitting quoted or forbidden edits', () => {
  for (const task of ['README.mdを修正してください。', 'README.mdの追記も実装してください。', 'Fix the typo in README.md.']) {
    assert.equal(documentEditIntent(task), true, task); assert.equal(codingIntent(task), false, task)
  }
  for (const task of ['Should we fix README.md?', 'Do not modify README.md.', '> Fix README.md', 'README.mdを修正しないで。']) assert.equal(documentEditIntent(task), false, task)
  for (const task of ['Fix src/parser.ts and update README.md.', 'README.mdと設定の挙動を修正してください。']) assert.equal(codingIntent(task), true, task)
  assert.equal(documentContinuation('続けてください。'), true)
  for (const task of ['Continue and delete another file.', '続けて、APIも修正して。', 'Do not continue.']) assert.equal(documentContinuation(task), false)
})
test('only clear human choices are accepted; closure, empty or discussion remain pending', () => {
  for (const text of ['使う','yes','1']) assert.equal(parseCodingChoice({custom:text}), 'yes')
  for (const text of ['使わない','no','2']) assert.equal(parseCodingChoice({custom:text}), 'no')
  assert.equal(parseCodingChoice({selected:['取消・作業を保持']}), 'cancelled')
  for (const answer of [{selected:[]},{custom:'What is Lisp?'},{selected:['使う','使わない']}]) assert.equal(parseCodingChoice(answer), undefined)
})
test('continuation cannot silently reuse a Lisp answer for an appended scope-changing request', () => {
  for (const text of ['Continue the current task.', 'Resume the same task without changing its scope.', 'このタスクを再開してください。']) assert.equal(codingContinuation(text), true)
  for (const text of ['Continue the current task and implement another API.', 'Resume the current task. Also change its scope.', 'このタスクを再開して、新しいAPIも追加して']) assert.equal(codingContinuation(text), false)
})
test('Goal and choice gate effects, preserve reads and survive restart with exact replay', async () => {
  const f = await fixture()
  try {
    assert.equal(taskCompletionBlocksClose(assessTaskCompletion(f.db,f.identity.runId)), true, 'empty workflow must enforce completion')
    await assert.rejects(f.execute('kioku_write',{path:'output',content:'bad'},'before-goal'),/Goal/)
    const proposed = f.propose()
    assert.deepEqual(f.propose(),proposed)
    assert.throws(()=>proposeCodingWorkflow(f.db,f.identity,'propose',1,{...definition,goal:{...definition.goal,ideal:'different'}}),/reused/)
    await assert.rejects(f.execute('kioku_exec',{command:'touch must-not-exist'},'before-choice'),/Lisp choice/)
    assert.ok(await f.execute('kioku_read',{path:'src/check.test.mjs'},'read'))
    await f.restart(); assert.equal(readCodingWorkflow(f.db,f.identity.runId)!.choice.state,'pending')
    f.choose(); assert.equal(assertCodingDispatch(f.db,f.identity,'kioku_write')!.choice.state,'no')
    assert.throws(()=>assertCodingDispatch(f.db,f.identity,'lisp_eval'),/not selected/)
    await f.execute('kioku_write',{path:'output',content:'ok'},'write')
    await f.restart(); const replay=await f.execute('kioku_write',{path:'output',content:'ok'},'write')
    assert.equal(replay.replayed,true); assert.equal(await readFile(join(f.root,'output'),'utf8'),'ok')
  } finally { await f.close() }
})
test('host evidence must verify items before a fresh final Goal command; source changes become stale', async () => {
  const f=await fixture()
  try {
    f.propose();f.choose();f.bind('parser-check');f.bind('goal-check')
    await f.execute('kioku_exec',{command:f.command},'items')
    let assessment=assessTaskCompletion(f.db,f.identity.runId)
    assert.equal(assessment.criteria[0]!.state,'satisfied');assert.equal(assessment.criteria[1]!.state,'unknown');assert.equal(assessment.verified,false)
    const next = nextCodingWork(f.db,f.identity); assert.ok(next.applicable); assert.equal(next.next,'verify_final_goal')
    await f.execute('kioku_exec',{command:f.command},'final-goal')
    assessment=assessTaskCompletion(f.db,f.identity.runId);assert.equal(assessment.verified,true)
    assert.equal(synchronizeCodingWorkflow(f.db,f.identity.runId)!.state,'completed')
    await writeFile(join(f.root,'src/check.test.mjs'),'changed source')
    assert.ok(assessTaskCompletion(f.db,f.identity.runId).criteria.every(item=>item.state==='stale'))
  }finally{await f.close()}
})
test('zero tests, skips, failing child process and fake success output do not complete checks', async () => {
  for(const source of ["console.log('passed:true')", "import test from 'node:test';test.skip('skip',()=>{});", "import test from 'node:test';test('failure',()=>{throw Error('actual failure')})"]){
    const f=await fixture();try{f.propose();f.choose();await writeFile(join(f.root,'src/check.test.mjs'),source);f.bind('parser-check');await f.execute('kioku_exec',{command:f.command},'bad');assert.notEqual(assessTaskCompletion(f.db,f.identity.runId).criteria[0]!.state,'satisfied')}finally{await f.close()}
  }
})
test('revisions preserve reordered IDs, require changed-condition revisions and reject old scope answers', async()=>{
  const f=await fixture();try{
    f.propose();f.choose();let value=readCodingWorkflow(f.db,f.identity.runId)!
    const reordered={...definition,criteria:[...definition.criteria].reverse()}
    value=proposeCodingWorkflow(f.db,f.identity,'reorder',value.revision,reordered,true);assert.equal(value.scopeVersion,1);assert.equal(value.choice.state,'no')
    assert.throws(()=>proposeCodingWorkflow(f.db,f.identity,'bad-revision',value.revision,{...definition,criteria:[{...definition.criteria[0],expected:'changed'},definition.criteria[1]]},true),/revision/)
    value=proposeCodingWorkflow(f.db,f.identity,'scope',value.revision,{...definition,goal:{...definition.goal,revision:2,target:'another target'}},true)
    assert.equal(value.scopeVersion,2);assert.equal(value.choice.state,'pending')
    assert.throws(()=>answerCodingChoice(f.db,f.identity,{callId:'old-answer',expectedRevision:value.revision,workflowId:value.workflowId,scopeVersion:1,questionId:`coding-lisp-${value.workflowId}-1`,questionRevision:1,answerRef:'old-human',choice:'yes'}),/pending coding task/)
    assert.throws(()=>proposeCodingWorkflow(f.db,{...f.identity,sessionId:'other'},'other',value.revision,definition,true),/owner/)
  }finally{await f.close()}
})
test('dependencies select only satisfied predecessors and cancellation refuses late dispatch',async()=>{
  const f=await fixture();try{
    const expanded=structuredClone(definition);expanded.items.push({itemId:'consumer',change:'Connect the consumer',dependsOn:['parser'],criterionIds:['consumer-check'],goalCriterionIds:['goal-check']})
    expanded.criteria.push({...definition.criteria[0]!,criterionId:'consumer-check'})
    proposeCodingWorkflow(f.db,f.identity,'graph',1,expanded);f.choose()
    const items=codingItems(readCodingWorkflow(f.db,f.identity.runId)!,assessTaskCompletion(f.db,f.identity.runId));assert.equal(items[1]!.state,'pending')
    f.bind('parser-check');await f.execute('kioku_exec',{command:f.command},'parser')
    const next = nextCodingWork(f.db,f.identity); assert.ok(next.applicable); assert.ok('item' in next); assert.equal(next.item?.itemId,'consumer')
    stopCodingWorkflow(f.db,f.identity.runId,'cancelled')
    await assert.rejects(f.execute('kioku_write',{path:'late',content:'bad'},'late'),/Goal/)
    assert.equal(codingStatus(f.db,f.identity).applicable,true)
  }finally{await f.close()}
})
test('bounded unchanged retries become resumable blockers; a changed cause resets the budget',async()=>{
  const f=await fixture();try{f.propose();f.choose()
    for(let i=1;i<=3;i++)recordCodingAttempt(f.db,f.identity,`attempt-${i}`,'parser-check','same',i*100000)
    assert.equal(readCodingWorkflow(f.db,f.identity.runId)!.state,'blocked')
    recordCodingAttempt(f.db,f.identity,'changed-cause','parser-check','new',400000)
    assert.equal(readCodingWorkflow(f.db,f.identity.runId)!.state,'ready')
  }finally{await f.close()}
})
test('fabricated TAP and exit zero from an untrusted tool cannot mint coding evidence', async () => {
  const f = await fixture()
  try {
    f.propose(); f.choose(); f.bind('parser-check')
    beginTaskCompletionExecution(f.db, { runId: f.identity.runId, callId: 'forged', command: f.command, repositoryRoot: f.root })
    finishTaskCompletionExecution(f.db, { runId: f.identity.runId, callId: 'forged', result: {
      value: { exitCode: 0 }, content: [{ type: 'text', text: 'TAP version 13\n# Subtest: invented assertion\nok 1 - invented assertion\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n' }],
    } })
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).criteria[0]!.state, 'unknown')
  } finally { await f.close() }
})
test('criterion binding uses the complete stable ID even when IDs share a suffix', async () => {
  const f = await fixture()
  try {
    const value = structuredClone(definition)
    value.criteria.push({ ...definition.criteria[0]!, criterionId: 'literal:parser-check', evidence: 'output' })
    value.items[0]!.criterionIds.push('literal:parser-check')
    const workflow = proposeCodingWorkflow(f.db, f.identity, 'suffix-definition', 1, value)
    f.choose()
    assert.doesNotThrow(() => bindTaskCriterion(f.db, { runId: f.identity.runId, callId: 'literal-binding',
      criterionId: `coding:${workflow.workflowId}:literal:parser-check`, approved: true,
      method: { kind: 'native_command', command: 'node src/check.test.mjs', cwd: '.', sourcePaths: ['src/check.test.mjs'], assertion: 'output_matches', expectedOutput: '42' } }))
  } finally { await f.close() }
})
test('literal output evidence rejects a different value containing the expected digits', async () => {
  const f = await fixture()
  try {
    const value = structuredClone(definition); value.criteria[0]!.evidence = 'output'
    const workflow = proposeCodingWorkflow(f.db, f.identity, 'output-definition', 1, value); f.choose()
    await writeFile(join(f.root, 'src/output.mjs'), "console.log('142')\n")
    const command = 'node src/output.mjs'
    bindTaskCriterion(f.db, { runId: f.identity.runId, callId: 'output-binding', criterionId: `coding:${workflow.workflowId}:parser-check`, approved: true,
      method: { kind: 'native_command', command, cwd: '.', sourcePaths: ['src/output.mjs'], assertion: 'output_matches', expectedOutput: '42' } })
    await f.execute('kioku_exec', { command }, 'different-value')
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).criteria[0]!.state, 'unmet')
    await writeFile(join(f.root, 'src/output.mjs'), "console.log('42')\n")
    await f.execute('kioku_exec', { command }, 'expected-value')
    assert.equal(assessTaskCompletion(f.db, f.identity.runId).criteria[0]!.state, 'satisfied')
  } finally { await f.close() }
})
function mounted(f: Awaited<ReturnType<typeof fixture>>, overrides: any = {}) {
  const tools = new Map<string, any>(), hooks = new Map<string, any>()
  const agent = { id: 'native-agent' }, identity = { ...f.identity, agent, task: 'Implement the parser' }
  const unmount = mountCodingWorkflow({ tools: { register(tool: any) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get(name: string) { return tools.get(name) } },
    on(name: string, handler: any) { hooks.set(name, handler); return () => hooks.delete(name) } }, {
    runtime: { withDatabase: async (fn: any) => fn(f.db) } as any, resolve: execution => execution.agent === agent ? identity : undefined, lisp: () => undefined, ...overrides,
  })
  return { tools, hooks, agent, unmount }
}
test('public apply schema, minimum example and validation errors agree with execution', async () => {
  const f = await fixture(), host = mounted(f)
  try {
    const apply = host.tools.get('coding_workflow_apply')
    assert.ok(apply.parameters.required.includes('expectedRevision'))
    const execution = (callId: string) => ({ name: 'coding_workflow_apply', callId, agent: host.agent, signal: new AbortController().signal })
    await assert.rejects(apply.execute({ action: 'propose', definition }, execution('missing-revision')), /expectedRevision.*current revision/s)
    const invalid = structuredClone(definition); invalid.items[0]!.itemId = invalid.goal.goalId
    await assert.rejects(apply.execute({ action: 'propose', expectedRevision: 1, definition: invalid }, execution('duplicate')), /Duplicate IDs: goal.*unique/s)
    const status = codingStatus(f.db, f.identity) as any
    const example = status.minimumValidInput
    assert.equal(example.tool, 'coding_workflow_apply')
    const result = await host.tools.get(example.tool).execute(example.arguments, execution('valid-example'))
    assert.equal(result.applicable, true)
    await assert.rejects(apply.execute({ ...example.arguments, action: 'revise' }, execution('stale')), /revision/i)
  } finally { host.unmount(); await f.close() }
})
test('execution consumes the bound action: verification Bash is allowed, direct writes are not', async () => {
  const f = await fixture()
  const task = 'パッケージを更新した。動作を見てくれ。'
  const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task) })!
  const requestIntent = bindMainModelRequestIntent({ relation: 'new', action: 'verify', evidenceRefs: requestIntentReferenceIds(context) }, context)!
  const agent = { id: 'verification-agent' }
  const host = mounted(f, { resolve: (execution: any) => execution.agent === agent
    ? { ...f.identity, agent, task, requestIntent, requestIntentContext: context } : undefined })
  try {
    // This request is verification even if an old task's coding workflow remains.
    const run = (name: string) => host.hooks.get('tools/pre-execute')({ name, agent, callId: name, arguments: {}, signal: new AbortController().signal }, async () => 'native')
    assert.equal(await run('bash'), 'native')
    assert.equal((await run('kioku_write')).kind, 'deny')
    assert.equal(await run('read'), 'native')
    assert.equal(codingControlOrRead('enno_work_report'), true, 'host-bound Enno reports do not need a human tool-action interpretation on each worker turn')
    assert.equal(await run('enno_work_report'), 'native')
  } finally { host.unmount(); await f.close() }
})
test('opaque implementation shorthand still requires Goal and choice; forged intent cannot authorize effects', async () => {
  const f = await fixture(), task = 'A/B/C をまとめて入れて'
  const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task), proposals: [
    { id: 'proposal', revision: 1, digest: 'a'.repeat(64), text: 'A/B/C: repair the three parser defects' },
  ] })!
  const requestIntent = bindMainModelRequestIntent({ relation: 'new', action: 'change', evidenceRefs: requestIntentReferenceIds(context) }, context)!
  const agent = { id: 'change-agent' }
  const identity = { ...f.identity, agent, task, requestIntent, requestIntentContext: context }
  const host = mounted(f, { resolve: (execution: any) => execution.agent === agent ? identity : undefined })
  try {
    const run = () => host.hooks.get('tools/pre-execute')({ name: 'kioku_write', agent, callId: 'write', arguments: {}, signal: new AbortController().signal }, async () => 'native')
    assert.equal((await run()).kind, 'deny')
    f.propose(); f.choose()
    assert.equal(await run(), 'native')
    identity.requestIntent = { ...requestIntent, evidence: { ...requestIntent.evidence, requestDigest: 'b'.repeat(64) } }
    assert.equal((await run()).kind, 'deny')
  } finally { host.unmount(); await f.close() }
})
test('missing native question service preserves the Goal and pending choice, while effects remain denied', async () => {
  const f = await fixture(), host = mounted(f)
  try {
    f.propose()
    const execution = { name: 'coding_workflow', callId: 'reopen', agent: host.agent, arguments: { action: 'next' }, signal: new AbortController().signal }
    const status = await host.tools.get('coding_workflow').execute(execution.arguments, execution)
    assert.equal(status.choice.state, 'pending'); assert.equal(status.definition.goal.goalId, 'goal')
    const denied = await host.hooks.get('tools/pre-execute')({ ...execution, name: 'kioku_write', callId: 'blocked-write' }, async () => ({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny'); assert.match(denied.reason, /Lisp choice/)
  } finally { host.unmount(); await f.close() }
})
test('durable task cancellation aborts an already running process before its delayed write', async () => {
  const f = await fixture(), host = mounted(f)
  try {
    f.propose(); f.choose()
    host.tools.set('kioku_exec', { execute() {} })
    const execution = { name: 'kioku_exec', callId: 'running', agent: host.agent, arguments: { command: 'sleep 30' }, signal: new AbortController().signal }
    await host.hooks.get('tools/pre-execute')(execution, async () => ({ kind: 'allow' }))
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const result = runOwnedProcess('sleep 30; touch delayed-write', f.root, 'bash', execution.signal, 40000, started)
    await running
    stopCodingWorkflow(f.db, f.identity.runId, 'cancelled')
    assert.equal((await result).value.aborted, true)
    await assert.rejects(readFile(join(f.root, 'delayed-write')), { code: 'ENOENT' })
  } finally { host.unmount(); await f.close() }
})
test('a saved yes survives startup failure and retries the recovered runtime without another human question', async () => {
  const f = await fixture(); let asks = 0, starts = 0, recovered = false
  const host = mounted(f, { questions: { async ask(request: any) { asks++; return { answers: [{ id: request.questions[0].id, selected: ['使う'] }] } } },
    lisp: () => ({ async activate() { starts++; assert.equal(readCodingWorkflow(f.db, f.identity.runId)!.choice.state, 'yes', 'save answer before startup'); if (!recovered) throw Error('SBCL temporarily unavailable') } }) })
  try {
    f.propose()
    const next = (id: string) => host.tools.get('coding_workflow').execute({ action: 'next' }, { name: 'coding_workflow', callId: id, agent: host.agent, signal: new AbortController().signal })
    const failed = await next('failed-start'); assert.equal(failed.choice.state, 'yes'); assert.equal(failed.blocker.kind, 'runtime')
    await assert.rejects(f.execute('kioku_write', { path: 'blocked-startup', content: 'bad' }, 'blocked-startup'), /blocker/)
    recovered = true
    const resumed = await next('recovered-start'); assert.equal(resumed.choice.state, 'yes'); assert.equal(resumed.state, 'ready')
    assert.equal(asks, 1); assert.equal(starts, 2)
    await f.execute('kioku_write', { path: 'recovered', content: 'ok' }, 'recovered-write')
    assert.equal(await readFile(join(f.root, 'recovered'), 'utf8'), 'ok')
  } finally { host.unmount(); await f.close() }
})
test('scope revision during native approval invalidates the queued effect and the previous answer', async () => {
  const f = await fixture(), host = mounted(f)
  try {
    f.propose(); f.choose(); host.tools.set('kioku_write', { execute() {} })
    const execution = { name: 'kioku_write', callId: 'approved-old-scope', agent: host.agent, arguments: { path: 'late', content: 'bad' }, signal: new AbortController().signal }
    await host.hooks.get('tools/pre-execute')(execution, async () => ({ kind: 'allow' }))
    const value = readCodingWorkflow(f.db, f.identity.runId)!
    const changed = { ...definition, goal: { ...definition.goal, revision: 2, target: 'another target' } }
    await host.tools.get('coding_workflow').execute({ action: 'revise', expectedRevision: value.revision, definition: changed },
      { name: 'coding_workflow', callId: 'scope-change', agent: host.agent, signal: new AbortController().signal })
    await assert.rejects(host.hooks.get('tools/execute')(execution, async () => { throw Error('Old effect must never execute') }), /approval/)
    assert.equal(readCodingWorkflow(f.db, f.identity.runId)!.choice.state, 'pending')
    await assert.rejects(readFile(join(f.root, 'late')), { code: 'ENOENT' })
  } finally { host.unmount(); await f.close() }
})
