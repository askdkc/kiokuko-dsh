import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase} from '../../../src/db/migrate.js'
import {resolveProjectWorkspace} from '../../../src/memory/workspaces.js'
import {recordEntry} from '../../../src/memory/entries.js'
import {CoreTasks} from '../../../src/dsh/core/tasks.js'

test('ordinary execution intake retrieves a stored correction without saving memory or asking another intake question',async()=>{
  const root=realpathSync(await mkdtemp(join(tmpdir(),'correction-entry-')))
  await mkdir(join(root,'.git'));await writeFile(join(root,'package.json'),'{"name":"correction-entry","private":true}')
  const db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  try {
    const project=(await resolveProjectWorkspace(db,root))!
    const correction=recordEntry(db,{workspace:project.workspace,kind:'lesson',title:'Rust compiler compatibility',body:'Do not reject a compiler only because its version differs. Verify actual Rust compiler capabilities and native acceptance.',scope:{visibility:'project'},provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
    const runtime={withDatabase:async(fn:any)=>fn(db)} as any
    const tasks=new CoreTasks(runtime)
    const task=await tasks.prepare({requestId:'correction-build',sessionId:'session',turn:1,task:'Fix Rust compiler compatibility',cwd:root,
      profileHints:{taskType:'build',target:'Rust compiler compatibility',expected:'Build and native acceptance pass',constraints:'Preserve release provenance'},
      capabilities:['kiokuko-soul','memory-reasoning'].map(name=>({kind:'skill' as const,name})),signal:new AbortController().signal})
    assert.equal(task.admitted,true)
    assert.ok(task.context?.items.some(item=>item.entryId===correction.id),'the stored correction must reach the ordinary admitted task')
    assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1,'read-only retrieval must not capture new memories')
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_memory_reviews').get()?.n,0,'retrieval is not an application claim')
  } finally {db.close();await rm(root,{recursive:true,force:true})}
})
