// Gather distinct native jobs. Missing, duplicate, stale or unverified targets fail the release gate.
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { nativeTargets, regular, sourceDigest, validateNativeArtifact } from './micro-judge-artifacts.mjs'
const root=resolve(import.meta.dirname,'..'), input=process.argv[2]
const selectedFile=process.argv.find(arg=>arg.startsWith('--ci-plan='))?.slice(10)
const selectedModule=selectedFile?await import('./ci-plan.mjs'):undefined
const selection=selectedModule?.readCiPlan(root,selectedFile)
assert.ok(input,'Pass the downloaded native artifact directory')
const source=await sourceDigest(root), gathered=new Map()
for(const folder of await readdir(input,{withFileTypes:true})) {
  assert.ok(folder.isDirectory()&&!folder.isSymbolicLink(),'Expected distinct artifact directories')
  const path=join(input,folder.name), manifest=JSON.parse(await regular(join(path,'manifest.json')))
  assert.equal(manifest.version,'kiokuko-fd-v1');assert.equal(manifest.artifacts.length,1)
  const entry=manifest.artifacts[0], result=await validateNativeArtifact(path,entry,source)
  if(selection)assert.deepEqual(JSON.parse(await regular(join(path,'selection.json'))),selectedModule.nativeSelection(selection,entry),'Native artifact belongs to another selection/source/toolchain')
  assert.ok(!gathered.has(result.key),`Duplicate native target: ${result.key}`)
  gathered.set(result.key,{entry,...result})
}
assert.deepEqual([...gathered.keys()].sort(),selection?selection.nativeTargets.map(target=>target.key).sort():Object.keys(nativeTargets).sort(),selection?'Exactly the selected native targets are required':'All supported native targets are required')
// Validate everything before replacing the bundle manifest.
const destination=join(root,'micro-judge')
for(const key of Object.keys(nativeTargets))if(!gathered.has(key)){
  await rm(join(destination,key),{recursive:true,force:true})
  await rm(join(destination,`native-acceptance-${key}.tap`),{force:true})
  await rm(join(destination,`native-verification-${key}.json`),{force:true})
}
for(const {entry,key,binary,receipt,tap}of gathered.values()) {
  await mkdir(join(destination,key),{recursive:true})
  await writeFile(join(destination,entry.file),binary);await chmod(join(destination,entry.file),0o755)
  await writeFile(join(destination,receipt.log),tap)
  await writeFile(join(destination,`native-verification-${key}.json`),`${JSON.stringify(receipt,null,2)}\n`)
}
const manifest=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'))
manifest.artifacts=[...gathered.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(value=>value.entry)
await writeFile(join(destination,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`)
if(selection)await writeFile(join(destination,'selection.json'),JSON.stringify({planDigest:selection.digest,identity:selection.identity,bundleScope:selection.bundleScope,targets:[...gathered.keys()].sort()},null,2)+'\n')
else await rm(join(destination,'selection.json'),{force:true})
console.log(JSON.stringify({supportedTargets:[...gathered.keys()].sort(),sourceDigest:source,nativeReceipts:true,bundleScope:selection?.bundleScope??'release-review'}))
