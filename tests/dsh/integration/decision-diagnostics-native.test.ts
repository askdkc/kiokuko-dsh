import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { interpretedPreparation,toolValue } from '../helpers/coding-script.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const packageRoot=process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const extra={lisp:{enabled:false},typedDecisions:{mode:'off'},answerReview:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}}

for(const explicit of [false,true])for(const fault of [false,true])test(`native diagnostics ${explicit?'adapter':'public'}: ${fault?'recording failure preserves real read':'actual admission and read-only display'}`,async()=>{
  const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),explicit,extra})
  try{
    await writeFile(join(f.dir,'note.txt'),'ACTUAL_NATIVE_READ_RESULT\n')
    const db=openConnection(join(f.dir,explicit?'state.sqlite3':'kiokuko-dsh.sqlite3'))
    try{
      if(fault)db.exec("CREATE TRIGGER native_diagnostic_fault BEFORE INSERT ON dsh_diagnostic_events BEGIN SELECT RAISE(ABORT,'PRIVATE_PROVIDER_ERROR'); END;")
      f.responses.push(interpretedPreparation(f.mock,'prepare-inspection','new','research','research'),
        f.mock.toolCallResponse('native-read','kioku_read',{path:'note.txt'}),
        (request:any)=>{
          // The ordinary host produced a successful native file result despite a diagnostic fault.
          assert.match(JSON.stringify(toolValue(request,'native-read')),/ACTUAL_NATIVE_READ_RESULT/)
          return f.mock.textResponse('The requested file was inspected.')
        })
      await f.turn('Inspect note.txt and report its contents. REQUEST_BODY_DO_NOT_DUPLICATE')
      const before=JSON.stringify(db.prepare('SELECT * FROM dsh_diagnostic_attempts').all())
      const displayed=(await f.ctx.commands.execute(f.agent,'/kioku-decisions diagnostics',[],new AbortController().signal)).result
      assert.equal(displayed.kind,'success',displayed.text)
      const view=JSON.parse(displayed.text)
      assert.equal(view.metrics.falseStopRate,null)
      if(fault)assert.ok(view.completeness.persistedGaps>0)
      else{
        assert.ok(view.attempts.some((a:any)=>a.events.some((e:any)=>e.kind==='admission')))
        assert.equal(view.completeness.persistedGaps,0)
        assert.ok(view.attempts.every((a:any)=>a.stages.semanticMatch==='not_run' && a.stages.detector==='not_run'))
      }
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM dsh_diagnostic_attempts').all()),before)
      assert.doesNotMatch(before+JSON.stringify(db.prepare('SELECT * FROM dsh_diagnostic_events').all())+JSON.stringify(db.prepare('SELECT * FROM dsh_diagnostic_gaps').all()),/REQUEST_BODY_DO_NOT_DUPLICATE|PRIVATE_PROVIDER_ERROR|ACTUAL_NATIVE_READ_RESULT/)
    }finally{db.close()}
  }finally{await f.close()}
})
