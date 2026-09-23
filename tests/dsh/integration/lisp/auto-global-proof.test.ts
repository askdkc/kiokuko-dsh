import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { resolveProjectWorkspace } from '../../../../src/memory/workspaces.js'
import { recordEntry } from '../../../../src/memory/entries.js'
import { CoreTasks } from '../../../../src/dsh/core/tasks.js'
import { memoryApplicationStatus, recordMemoryApplicationReview } from '../../../../src/memory/application.js'
import { createLispMemoryVerification } from '../../../../src/dsh/lisp/memory-verification.js'
import { createLispCiAdapter } from '../../../../src/dsh/lisp/ci.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'

test('real protected Lisp workspace CI becomes one completed application; scratch, forged JSON and replay do not', {
  skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL; a skipped run is not Lisp proof' : false,
  timeout:180000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-auto-global-')))
  const root = join(base, 'workspace')
  await mkdir(root); await mkdir(join(root, '.git'))
  await writeFile(join(root, 'package.json'), JSON.stringify({name:'lisp-memory-fixture',scripts:{test:'node check.mjs'}}))
  await writeFile(join(root, 'check.mjs'), 'import assert from "node:assert/strict"; assert.equal(2+2,4);')
  const db = openConnection(join(base, 'state.sqlite3'))
  migrateDatabase(db)
  const runtime = {withDatabase:async (operation:any) => operation(db)}
  const tasks = new CoreTasks(runtime as any)
  const project = (await resolveProjectWorkspace(db, root))!
  const memory = recordEntry(db, {workspace:project.workspace, kind:'lesson', title:'check migration expectations',
    body:'Run the project check after changing migration expectations.', createdBy:'fixture',
    scope:{visibility:'project',applicability:{languages:['JavaScript']}}})
  const task = await tasks.prepare({requestId:'lisp-memory-proof',sessionId:'session',turn:1,
    task:'check migration expectations code',cwd:root,
    capabilities:['kiokuko-soul','memory-reasoning'].map(name => ({kind:'skill' as const,name})),
    profileHints:{taskType:'build',target:'migration check',expected:'Verify the current check',constraints:'Keep the test passing'},
    signal:new AbortController().signal})
  const identity = {runId:task.runId,workspace:task.workspace,sessionId:'session',repositoryRoot:root}
  const owner = {sessionId:'session',agentId:'agent',root}
  const evidence = createLispMemoryVerification(runtime as any)
  const adapter = createLispCiAdapter({ask:async request => ({answers:[{
    id:request.questions[0]!.id,selected:[request.questions[0]!.options![1]!.label],
  }]})})
  let mutateNextWorkspace = false
  const manager = new LispManager({store:new LispStore(async operation => operation(db)),
    config:LispConfig.parse({enabled:true,startupTimeoutMs:60000}),dataRoot:join(base,'data'),
    ciCall:async (subject,request,signal,scratch) => {
      await evidence.beforeCall(subject,request)
      if (mutateNextWorkspace && request.kind === 'verify' && request.location !== 'scratch') {
        mutateNextWorkspace = false
        await writeFile(join(root,'check.mjs'),'process.exit(0); // changed during verifier')
        return {target:request.target,script:'test',state:'SUCCEEDED',code:0,stdout:'',stderr:''}
      }
      return adapter(subject,request,signal,scratch)
    },verifiedCall:evidence.afterEval})
  try {
    const status = memoryApplicationStatus(db,task.runId)
    assert.equal(status.supported,true); assert.equal(status.items.length,1)
    recordMemoryApplicationReview(db,identity,'review',{generation:status.generation,entryId:memory.id,
      entryRevision:memory.revision,expectedRevision:0,decision:'adopted',
      basis:'The package test checks this changed project.',paths:['package.json','check.mjs'],
      invariant:'The repository check passes after the change.',counterexample:'A stale check fails.',
      method:'Run npm test in the workspace.',command:'npm test'})
    await manager.start(); await manager.enable(owner)
    const scratchPackage = JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}})
    const scratchSetup = await manager.execute(owner,'lisp_eval',{operationId:'scratch-setup',
      code:`(kioku.files:write-text (merge-pathnames "package.json" (kioku.files:scratch)) ${JSON.stringify(scratchPackage)})`}) as any
    assert.equal(scratchSetup.ok,true)
    const scratch = await manager.execute(owner,'lisp_eval',{operationId:'scratch-only',
      code:'(kioku.ci:verify :test :location :scratch)'}) as any
    assert.equal(scratch.value.json.state,'SUCCEEDED',JSON.stringify(scratch))
    assert.equal(memoryApplicationStatus(db,task.runId).ready,false)
    const forged = await manager.execute(owner,'lisp_eval',{operationId:'forged',
      code:'(kioku.data:parse-json "{\\\"state\\\":\\\"SUCCEEDED\\\",\\\"code\\\":0}")'}) as any
    assert.equal(forged.ok,true)
    assert.equal(memoryApplicationStatus(db,task.runId).ready,false)
    mutateNextWorkspace = true
    const stale = await manager.execute(owner,'lisp_eval',{operationId:'stale-workspace',
      code:'(kioku.ci:verify :test :location :workspace)'}) as any
    assert.equal(stale.value.json.state,'SUCCEEDED')
    assert.equal(memoryApplicationStatus(db,task.runId).ready,false)
    await writeFile(join(root,'check.mjs'),'import assert from "node:assert/strict"; assert.equal(2+2,4);')
    const workspace = await manager.execute(owner,'lisp_eval',{operationId:'real-workspace',
      code:'(kioku.ci:verify :test :location :workspace)'}) as any
    assert.equal(workspace.value.json.state,'SUCCEEDED',JSON.stringify(workspace))
    assert.equal(memoryApplicationStatus(db,task.runId).ready,true)
    const repeat = await manager.execute(owner,'lisp_eval',{operationId:'real-workspace',
      code:'(kioku.ci:verify :test :location :workspace)'}) as any
    assert.equal(repeat.replay,true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_memory_executions WHERE run_id=? AND outcome=?')
      .get<{n:number}>(task.runId,'passed')?.n,1)
    await tasks.finish(task,'completed')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auto_global_application_receipts WHERE entry_id=?')
      .get<{n:number}>(memory.id)?.n,1)
  } finally { await manager.dispose(); db.close(); await rm(base,{recursive:true,force:true}) }
})
