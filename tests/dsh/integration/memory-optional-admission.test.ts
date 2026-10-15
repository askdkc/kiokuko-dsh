import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { createLifecycle } from '../../../src/dsh/host-adapter/lifecycle.js'
import { DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { memoryApplicationStatus, recordMemoryApplicationReview } from '../../../src/memory/application.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { readTaskSnapshot, captureTaskLease, authorizeTaskLease, requestTaskStop, recordTaskEvidence, transitionTask } from '../../../src/dsh/task-state.js'
import { assessTaskCompletion } from '../../../src/dsh/task-completion.js'
import { saveExecutionFrame, updateExecutionFrame } from '../../../src/dsh/execution-frame.js'
import { runMemoryAwareVerifiers } from '../../../src/enno-oduno/memory-verification.js'
import { RepositoryAuditError } from '../../../src/enno-oduno/verifier.js'


import { DshIntakeGate } from '../../../src/dsh/intake-gate.js'
import { createDshCapabilityCatalog } from '../../../src/dsh/capability-catalog.js'
import { STANDARD_SKILL_MANIFESTS } from '../../../src/dsh/standard-skills.js'
const unavailableMemory=/\b(?:task_memory_[a-z_]+|dsh_memory_[a-z_]+|memory_[a-z_]+|entries|entry_[a-z_]+|context_delivery[a-z_]*)\b/u
for(const entry of ['core','full-gate'] as const)test(`owned ${entry} admission survives unavailable optional memory but retains authority failure`,async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'optional-admission-'))),root=join(base,'repo');await mkdir(root);execFileSync('git',['init','-q',root]);await writeFile(join(root,'check.mjs'),'console.log("observed")')
 const db=openConnection(join(base,'db.sqlite3'));migrateDatabase(db,join(process.cwd(),'migrations'));await resolveProjectWorkspace(db,root)
 let rejectAuthority=false;const attempts:string[]=[]
 const check=(sql:string)=>{if(unavailableMemory.test(sql)){attempts.push(sql);throw Error('Optional memory unavailable')}if(rejectAuthority&&/ledger_runs/u.test(sql))throw Error('Native authority unavailable')}
 const gated:SqliteDatabase={filePath:db.filePath,close(){},exec(sql){check(sql);db.exec(sql)},prepare(sql){check(sql);return db.prepare(sql)}}
 const runtime={withDatabase:async<T>(op:(db:SqliteDatabase)=>T|Promise<T>)=>op(gated)}
 const capabilities=STANDARD_SKILL_MANIFESTS.map(({name})=>({kind:'skill' as const,name})),profileHints={taskType:'research' as const,target:'check.mjs',expected:'Report output',constraints:null}
 const run=async(id:string)=>entry==='core'?new CoreTasks(runtime as any).prepare({requestId:id,sessionId:id,turn:1,task:'Inspect check.mjs without modifying it.',cwd:root,capabilities,profileHints,signal:new AbortController().signal}):new DshIntakeGate(runtime as any).prepare({agent:{id},sessionId:id,turn:1,step:1,sourceStartSeq:1,task:'Inspect check.mjs without modifying it.',cwd:root,profileHints,capabilities:createDshCapabilityCatalog(capabilities),skillDiscoveryMode:'off',signal:new AbortController().signal})
 try{const task=await run('allowed');assert.equal(task.admitted,true);assert.deepEqual(attempts,[],'admission does not touch optional memory');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get()!.n,0);rejectAuthority=true;await assert.rejects(run('blocked'),/Native authority unavailable/)}finally{db.close();await rm(base,{recursive:true,force:true})}
})
