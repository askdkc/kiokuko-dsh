import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConnection } from '../src/db/connection.ts'
import { migrateDatabase } from '../src/db/migrate.ts'
import { recordEntryInTransaction } from '../src/memory/entries.ts'
import { ordinaryContextSelectionStateHash, contextRetrievalStateHash, contextSelectionStateHashes } from '../src/context/selection-state.ts'
import { queryScopedContextGated } from '../src/context/scoped-broker.ts'
import { resolveProjectWorkspace } from '../src/memory/workspaces.ts'
import { renderMemoryFields } from '../src/context/memory-projection.ts'
import { measureDatabase } from './evolution-evaluation-metrics.mjs'

const percentile = values => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95) - 1]
const root = await mkdtemp(join(tmpdir(), 'selection-state-benchmark-'))
const results = []
try {
  for (const size of [20,1000]) {
    const location = join(root,String(size)); await mkdir(join(location,'.git'),{recursive:true})
    const db = openConnection(join(location,'state.sqlite3')); migrateDatabase(db)
    try {
      const project = await resolveProjectWorkspace(db,location)
      const fixture = []
      db.exec('BEGIN IMMEDIATE')
      for (let i=0;i<size;i++) {
        const entry = {workspace:project.workspace,kind:'reference',title:`SQLITE_BUSY fixture-${i}`,summary:`Condition ${i % 7}`,body:`Validate fixture ${i} before migration. Never apply to production. ${'Preserve all source rows. '.repeat(8)}`,scope:{visibility:'project'},createdBy:'benchmark'}
        fixture.push(entry)
        recordEntryInTransaction(db,entry,{idFactory:()=>`state-${String(i).padStart(5,'0')}`,now:'2026-09-10T00:00:00.000Z'})
      }
      db.exec('COMMIT')
      const workspaces=[project.workspace,'global'], samples={baseline:[],prototype:[]}, counts={}
      let expected
      for(let repetition=0;repetition<34;repetition++) for(const kind of repetition%2 ? ['prototype','baseline'] : ['baseline','prototype']) {
        const measured=measureDatabase(db), input=measured.database
        const start=performance.now()
        db.exec('SAVEPOINT coherent_selection_read')
        let hashes
        try { hashes=kind==='prototype'?Object.values(contextSelectionStateHashes(input,workspaces,{includeEcosystem:true})):[ordinaryContextSelectionStateHash(input,workspaces,{includeEcosystem:true}),contextRetrievalStateHash(input,workspaces,{includeEcosystem:true})] }
        finally { db.exec('RELEASE coherent_selection_read') }
        const elapsed=performance.now()-start
        expected??=hashes; assert.deepEqual(hashes,expected)
        if(repetition>=3) samples[kind].push(elapsed)
        counts[kind]={...measured.counters}
      }
      const query={project,task:'SQLITE_BUSY fixture-7',taskProfile:{taskType:'debug',target:'fixture',expected:'validate',constraints:null},characterBudget:4000}
      const measured=measureDatabase(db), start=performance.now()
      const packed=(await queryScopedContextGated(measured.database,query,value=>({persist:false,value}))).value
      const supplied=packed.items.map(renderMemoryFields).filter(Boolean)
      results.push({size,fixtureDigest:createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
        hashes:expected,baseline:{p95Ms:percentile(samples.baseline),...counts.baseline},prototype:{p95Ms:percentile(samples.prototype),...counts.prototype},
        collectionThroughSupply:{milliseconds:performance.now()-start,...measured.counters,packedIds:packed.items.map(item=>item.entryId),suppliedBytes:supplied.reduce((sum,text)=>sum+Buffer.byteLength(text),0),omissions:packed.omissions?.length??0,modelRequest:'unmeasured'}})
    } finally { db.close() }
  }
  const small=results[0],large=results[1]
  const performanceGate=large.prototype.p95Ms<=large.baseline.p95Ms*.85 && small.prototype.p95Ms<=small.baseline.p95Ms*1.05
  const report={version:1,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),nodeVersion:process.version,runs:31,results,performanceGate,
    adoption:performanceGate?'performance_eligible':'not_eligible',reason:performanceGate?'Timing gate passed; adoption also requires the losslessness tests.':'The shared-read implementation failed the required performance gate.',realTokens:'unmeasured',realCost:'unmeasured'}
  const output=process.argv[2]
  if(output) await writeFile(output,JSON.stringify(report,null,2)+'\n')
  process.stdout.write(JSON.stringify(report,null,2)+'\n')
} finally { await rm(root,{recursive:true,force:true}) }
