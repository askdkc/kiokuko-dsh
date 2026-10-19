import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { acceptanceSummary, nativeTargets, sourceDigest, validateNativeArtifact } from './micro-judge-artifacts.mjs'
const root=resolve(import.meta.dirname,'..')
test('every native package consumer requires four actual native build results before dependency prepare',async()=>{
  const workflow=parse(await readFile(join(root,'.github/workflows/ci.yml'),'utf8'))
  const native=workflow.jobs['micro-judge-native']
  assert.deepEqual(native.strategy.matrix.include.map(item=>item.platform).sort(),Object.keys(nativeTargets).sort())
  assert.equal(new Set(native.strategy.matrix.include.map(item=>item.runner)).size,4)
  assert.ok(native.steps.some(step=>step.run?.includes('build-verify-micro-judge.mjs')))
  for(const name of ['verify-main','lisp-runtime','shortcut-browser','dsh-runtime-macos','semantic-platform-smoke']){
    const job=workflow.jobs[name];assert.equal(job.needs,'micro-judge-native')
    const merge=job.steps.findIndex(step=>step.run?.includes('merge-micro-judge-artifacts.mjs'))
    assert.ok(merge>=0&&merge<job.steps.findIndex(step=>step.run==='npm ci'))
  }
  assert.ok(workflow.jobs.verify.needs.includes('micro-judge-native'))
  assert.ok(workflow.jobs.verify.needs.includes('shortcut-browser'))
})
test('native acceptance rejects skipped, incomplete, empty and forged count-only logs',()=>{
  for(const text of ['', '# tests 0\n# pass 0\n', '# tests 18\n# pass 18\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'])assert.throws(()=>acceptanceSummary(text))
})
test('actual native receipt transport detects stale source, byte corruption and log tampering',async t=>{
  const manifest=JSON.parse(await readFile(join(root,'micro-judge/manifest.json'),'utf8'))
  const entry=manifest.artifacts.find(a=>a.platform===process.platform&&a.arch===process.arch)
  assert.ok(entry,'This acceptance requires a built native artifact')
  const directory=await mkdtemp(join(tmpdir(),'micro-transport-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const bundle=join(directory,'micro-judge');await cp(join(root,'micro-judge'),bundle,{recursive:true})
  const digest=await sourceDigest(root),result=await validateNativeArtifact(bundle,entry,digest)
  await assert.rejects(validateNativeArtifact(bundle,entry,'0'.repeat(64)),/stale source/)
  const binaryPath=join(bundle,entry.file)
  await writeFile(binaryPath,Buffer.from('not the native binary'))
  await assert.rejects(validateNativeArtifact(bundle,entry,digest))
  await writeFile(binaryPath,result.binary)
  await writeFile(join(bundle,result.receipt.log),'# tests 18\n# pass 18\n')
  await assert.rejects(validateNativeArtifact(bundle,entry,digest))
})
