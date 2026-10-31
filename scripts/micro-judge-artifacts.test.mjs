import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { acceptanceSummary, compilerIdentity, nativeTargets, sourceDigest, validateNativeArtifact } from './micro-judge-artifacts.mjs'
const root=resolve(import.meta.dirname,'..')
test('selected native consumers merge CI targets while preserving the supported runtime registry',async()=>{
  const workflow=parse(await readFile(join(root,'.github/workflows/ci.yml'),'utf8'));
  const {createCiPlan}=await import('./ci-plan.mjs');const c=JSON.parse(await readFile(join(root,'scripts/verification.json'),'utf8'));
  assert.deepEqual(Object.keys(nativeTargets).sort(),['darwin-arm64','linux-arm64','linux-x64']);
  const full=createCiPlan(c,{full:true},{});assert.deepEqual(full.nativeTargets.map(t=>t.key).sort(),['darwin-arm64','linux-x64']);
  const native=workflow.jobs['micro-judge-native'];assert.equal(native.strategy.matrix.include,'${{ fromJSON(needs.select.outputs.native) }}');
  assert.ok(native.steps.some(s=>s.run?.includes('build-verify-micro-judge.mjs')&&s.run.includes('--ci-plan=')));
  const job=workflow.jobs.checks;assert.deepEqual(job.needs,['select','micro-judge-native']);const merge=job.steps.findIndex(s=>s.run?.includes('merge-micro-judge-artifacts.mjs'));assert.ok(merge>=0&&merge<job.steps.findIndex(s=>s.run==='npm ci'));
  assert.ok(workflow.jobs.verify.needs.includes('micro-judge-native'));assert.ok(workflow.jobs.verify.steps.some(s=>s.run?.includes('merge-micro-judge-artifacts.mjs')));
});

test('native acceptance rejects skipped, incomplete, empty and forged count-only logs',()=>{
  for(const text of ['', '# tests 0\n# pass 0\n', '# tests 18\n# pass 18\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'])assert.throws(()=>acceptanceSummary(text))
})
test('compiler metadata accepts different Rust releases without an exact-version or upper-version gate',()=>{
  // Metadata parsing is not evidence that a compiler can build or execute the crate.
  for(const identity of ['rustc 1.85.0 (baseline)', 'rustc 1.85.1 (patch)', 'rustc 1.99.1 (installed)', 'rustc 2.0.0 (future)', 'rustc 1.100.0-nightly (development)'])assert.equal(compilerIdentity(identity),identity)
  for(const identity of [undefined,null,1,'','gcc 1.99.1','rustc unknown','rustc 1.99','rustc 1.99.1\n','rustc 1.99.1\rforged','rustc 1.99.1\tforged','rustc 1.99.1 '+'x'.repeat(244)])assert.throws(()=>compilerIdentity(identity),/Invalid Rust compiler identity/)
  const bounded='rustc 1.99.1 '+'x'.repeat(243)
  assert.equal(bounded.length,256);assert.equal(compilerIdentity(bounded),bounded)
})
test('native build entry reaches compilation for other releases and rejects failed builds, invalid identities and foreign hosts',async t=>{
  // Deliberately failing compiler fixture: this exercises the real CLI boundary,
  // never substitutes a fabricated successful native build or acceptance run.
  const {mkdir,access}=await import('node:fs/promises'),{spawnSync}=await import('node:child_process')
  const directory=await mkdtemp(join(tmpdir(),'micro-build-boundary-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  await mkdir(join(directory,'scripts'));await mkdir(join(directory,'micro-judge'))
  for(const file of ['micro-judge-artifacts.mjs','build-micro-judge.mjs','build-verify-micro-judge.mjs'])await cp(join(root,'scripts',file),join(directory,'scripts',file))
  const sentinel='{"version":"kiokuko-fd-v1","artifacts":[]}\n',manifest=join(directory,'micro-judge/manifest.json')
  await writeFile(manifest,sentinel)
  const config=join(directory,'compiler.json'),called=join(directory,'compiled'),compiler=join(directory,'fixture-rustc'),output=join(directory,'export')
  await writeFile(compiler,`#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst c=JSON.parse(readFileSync(${JSON.stringify(config)},'utf8'));\nif(process.argv.includes('-vV')){console.log(c.identity+'\\nhost: '+c.host);process.exit(c.inspectExit??0)}\nwriteFileSync(${JSON.stringify(called)},'attempted');process.exit(42);\n`,{mode:0o755})
  const invoke=()=>spawnSync(process.execPath,[join(directory,'scripts/build-verify-micro-judge.mjs'),compiler,`--output=${output}`],{encoding:'utf8'})
  for(const identity of ['rustc 1.85.0 fixture','rustc 1.99.1 fixture','rustc 2.0.0 fixture']){
    await rm(called,{force:true});await writeFile(config,JSON.stringify({identity,host:nativeTargets[`${process.platform}-${process.arch}`]}))
    const result=invoke();assert.notEqual(result.status,0);assert.match(result.stderr,/Rust build failed/)
    assert.equal(await readFile(called,'utf8'),'attempted');assert.equal(await readFile(manifest,'utf8'),sentinel)
    await assert.rejects(access(output),{code:'ENOENT'})
  }
  for(const [values,pattern]of [[{identity:'rustc 1.99.1 fixture',host:'foreign-target'},/Native compiler host mismatch/],[{identity:'rustc unknown',host:nativeTargets[`${process.platform}-${process.arch}`]},/Invalid Rust compiler identity/],[{identity:'rustc 1.99.1 fixture',host:nativeTargets[`${process.platform}-${process.arch}`],inspectExit:42},/Cannot inspect the existing Rust compiler/]]){
    await rm(called,{force:true});await writeFile(config,JSON.stringify(values))
    const result=invoke();assert.notEqual(result.status,0);assert.match(result.stderr,pattern)
    await assert.rejects(access(called),{code:'ENOENT'});await assert.rejects(access(output),{code:'ENOENT'})
    assert.equal(await readFile(manifest,'utf8'),sentinel)
  }
})
test('actual native receipt transport detects stale source, byte corruption and log tampering',async t=>{
  const manifest=JSON.parse(await readFile(join(root,'micro-judge/manifest.json'),'utf8'))
  const entry=manifest.artifacts.find(a=>a.platform===process.platform&&a.arch===process.arch)
  assert.ok(entry,'This acceptance requires a built native artifact')
  const directory=await mkdtemp(join(tmpdir(),'micro-transport-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const bundle=join(directory,'micro-judge');await cp(join(root,'micro-judge'),bundle,{recursive:true})
  const digest=await sourceDigest(root),result=await validateNativeArtifact(bundle,entry,digest)
  await assert.rejects(validateNativeArtifact(bundle,entry,'0'.repeat(64)),/stale source/)
  const receiptPath=join(bundle,`native-verification-${entry.platform}-${entry.arch}.json`)
  // Compiler text remains bound to the receipt, independent of the release used.
  for(const compiler of ['rustc 1.85.1 fixture','rustc 1.99.1 fixture','rustc 2.0.0 fixture']){
    const candidate={...entry,compiler},receipt={...result.receipt,compiler}
    await writeFile(receiptPath,JSON.stringify(receipt))
    await validateNativeArtifact(bundle,candidate,digest)
    await writeFile(receiptPath,JSON.stringify({...receipt,compiler:compiler+' altered'}))
    await assert.rejects(validateNativeArtifact(bundle,candidate,digest),/compiler identity mismatch/)
  }
  for(const compiler of ['', 'rustc unknown', 'rustc 1.99.1\nforged']){
    await writeFile(receiptPath,JSON.stringify({...result.receipt,compiler}))
    await assert.rejects(validateNativeArtifact(bundle,{...entry,compiler},digest),/Invalid Rust compiler identity/)
  }
  await writeFile(receiptPath,JSON.stringify(result.receipt))
  const binaryPath=join(bundle,entry.file)
  await writeFile(binaryPath,Buffer.from('not the native binary'))
  await assert.rejects(validateNativeArtifact(bundle,entry,digest))
  await writeFile(binaryPath,result.binary)
  await writeFile(join(bundle,result.receipt.log),'# tests 18\n# pass 18\n')
  await assert.rejects(validateNativeArtifact(bundle,entry,digest))
})

test('removed Intel native transport is rejected before artifact access', async()=>{
  await assert.rejects(validateNativeArtifact('/nonexistent-test-fixture', {
    platform:'darwin', arch:'x64', file:'darwin-x64/kiokuko-micro-judge', bytes:1,
    compiler:'rustc 1.85.0 fixture', nativeVerified:true, sha256:'0'.repeat(64), sourceDigest:'0'.repeat(64),
  }, '0'.repeat(64)), /Unsupported native target: darwin-x64/)
})

test('synthetic transport fixtures require exactly three targets and reject missing, duplicate, stale, corrupt and Intel inputs',async t=>{
  // Structural transport fixtures only: these headers/logs are not executable or native acceptance evidence.
  const {mkdir}=await import('node:fs/promises'),{spawnSync}=await import('node:child_process')
  const {sha256}=await import('./micro-judge-artifacts.mjs')
  const directory=await mkdtemp(join(tmpdir(),'micro-merge-contract-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  await mkdir(join(directory,'scripts'));await mkdir(join(directory,'micro-judge'));await mkdir(join(directory,'crates/micro-judge/src'),{recursive:true})
  for(const file of ['micro-judge-artifacts.mjs','merge-micro-judge-artifacts.mjs'])await cp(join(root,'scripts',file),join(directory,'scripts',file))
  for(const file of ['Cargo.toml','src/main.rs','src/digest.rs'])await cp(join(root,'crates/micro-judge',file),join(directory,'crates/micro-judge',file))
  const digest=await sourceDigest(directory),input=join(directory,'input');await mkdir(input)
  const tap=Buffer.from('actual Rust agrees with an independent exhaustive oracle on 200 deterministic small problems\nactual Rust MRV 8 queens has 92 solutions\nmissing or unsupported binary is explicit unavailable, never an allow\n# tests 18\n# pass 18\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n')
  async function artifact(key,folder=key){
    const [platform,arch]=key.split('-'),base=join(input,folder);await mkdir(join(base,key),{recursive:true})
    const binary=Buffer.alloc(64);if(platform==='linux'){binary.write('7f454c46',0,'hex');binary[4]=2;binary[5]=1;binary.writeUInt16LE(arch==='arm64'?183:62,18)}else{binary.write('cffaedfe',0,'hex');binary.writeUInt32LE(arch==='arm64'?0x100000c:0x1000007,4)}
    const entry={platform,arch,file:`${key}/kiokuko-micro-judge`,bytes:binary.length,sha256:sha256(binary),compiler:'rustc 1.85.0 synthetic-transport-fixture',sourceDigest:digest,nativeVerified:true}
    const receipt={schemaVersion:1,target:nativeTargets[key]??'x86_64-apple-darwin',platform,arch,binarySha256:entry.sha256,sourceDigest:digest,compiler:entry.compiler,exitCode:0,log:`native-acceptance-${key}.tap`,logSha256:sha256(tap),summary:acceptanceSummary(tap.toString())}
    await writeFile(join(base,entry.file),binary);await writeFile(join(base,receipt.log),tap);await writeFile(join(base,`native-verification-${key}.json`),JSON.stringify(receipt));await writeFile(join(base,'manifest.json'),JSON.stringify({version:'kiokuko-fd-v1',artifacts:[entry]}))
  }
  for(const key of Object.keys(nativeTargets))await artifact(key)
  await writeFile(join(directory,'micro-judge/manifest.json'),JSON.stringify({version:'kiokuko-fd-v1',artifacts:[]}))
  const invoke=()=>spawnSync(process.execPath,[join(directory,'scripts/merge-micro-judge-artifacts.mjs'),input],{encoding:'utf8'})
  assert.equal(invoke().status,0)
  assert.deepEqual(JSON.parse(await readFile(join(directory,'micro-judge/manifest.json'),'utf8')).artifacts.map(a=>`${a.platform}-${a.arch}`).sort(),['darwin-arm64','linux-arm64','linux-x64'])
  const before=await readFile(join(directory,'micro-judge/manifest.json'))
  async function rejected(pattern){const result=invoke();assert.notEqual(result.status,0);assert.match(result.stderr,pattern);assert.deepEqual(await readFile(join(directory,'micro-judge/manifest.json')),before)}
  await rm(join(input,'linux-arm64'),{recursive:true});await rejected(/All supported native targets/);await artifact('linux-arm64')
  await artifact('linux-x64','duplicate');await rejected(/Duplicate native target/);await rm(join(input,'duplicate'),{recursive:true})
  const path=join(input,'linux-x64/manifest.json'),original=await readFile(path),manifest=JSON.parse(original);manifest.artifacts[0].sourceDigest='0'.repeat(64);await writeFile(path,JSON.stringify(manifest));await rejected(/stale source/);await writeFile(path,original)
  await writeFile(join(input,'linux-x64/linux-x64/kiokuko-micro-judge'),'corrupt');await rejected(/AssertionError/);await artifact('linux-x64')
  await artifact('darwin-x64');await rejected(/Unsupported native target: darwin-x64/)
  await rm(join(input,'darwin-x64'),{recursive:true});
  for(const file of ['ci-plan.mjs','verification-contract.mjs','verification.json'])await cp(join(root,'scripts',file),join(directory,'scripts',file));
  const external=await mkdtemp(join(tmpdir(),'micro-selected-input-'));t.after(()=>rm(external,{recursive:true,force:true}));
  for(const key of Object.keys(nativeTargets))await cp(join(input,key),join(external,key),{recursive:true});await rm(input,{recursive:true});
  const {createCiPlan,checkoutIdentity,nativeSelection,ciToolchain}=await import('./ci-plan.mjs');
  const previous={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE};process.env.GIT_DIR=join(root,'.git');process.env.GIT_WORK_TREE=directory;
  try{
    const contract=JSON.parse(await readFile(join(directory,'scripts/verification.json'),'utf8')),selection=createCiPlan(contract,{available:true,changes:[{status:'M',path:'src/dsh/task-state.ts'}]},checkoutIdentity(directory));
    const planFile=join(external,'..',`selected-${external.split('/').at(-1)}.json`);t.after(()=>rm(planFile,{force:true}));await writeFile(planFile,JSON.stringify(selection));
    for(const key of Object.keys(nativeTargets)){
      const base=join(external,key),manifest=JSON.parse(await readFile(join(base,'manifest.json'),'utf8'));manifest.artifacts[0].compiler=ciToolchain.rust;await writeFile(join(base,'manifest.json'),JSON.stringify(manifest));
      const receiptFile=join(base,`native-verification-${key}.json`),receipt=JSON.parse(await readFile(receiptFile,'utf8'));receipt.compiler=ciToolchain.rust;await writeFile(receiptFile,JSON.stringify(receipt));
      await writeFile(join(base,'selection.json'),JSON.stringify(key==='linux-x64'?nativeSelection(selection,manifest.artifacts[0]):{unselected:true}));
    }
    const selected=()=>spawnSync(process.execPath,[join(directory,'scripts/merge-micro-judge-artifacts.mjs'),external,`--ci-plan=${planFile}`],{encoding:'utf8'});
    assert.notEqual(selected().status,0,'extra native targets are not silently accepted');await rm(join(external,'linux-arm64'),{recursive:true});await rm(join(external,'darwin-arm64'),{recursive:true});
    const good=selected();assert.equal(good.status,0,good.stderr);const narrow=JSON.parse(await readFile(join(directory,'micro-judge/manifest.json'),'utf8'));assert.equal(narrow.artifacts.length,1);assert.equal(narrow.artifacts[0].arch,'x64');
    assert.equal(JSON.parse(await readFile(join(directory,'micro-judge/selection.json'),'utf8')).bundleScope,'representative');
    await assert.rejects(readFile(join(directory,'micro-judge/darwin-arm64/kiokuko-micro-judge')),'unselected stale binaries are removed');
    assert.notEqual(spawnSync(process.execPath,[join(directory,'scripts/merge-micro-judge-artifacts.mjs'),external],{encoding:'utf8'}).status,0,'narrow test bundle is not complete release input');
    const wrapper=join(external,'linux-x64/selection.json'),saved=await readFile(wrapper,'utf8');const bad=JSON.parse(saved);bad.bundleScope='release-review';await writeFile(wrapper,JSON.stringify(bad));assert.notEqual(selected().status,0);await writeFile(wrapper,saved);
    const changed=JSON.parse(saved);changed.planDigest='old';await writeFile(wrapper,JSON.stringify(changed));assert.notEqual(selected().status,0);
  }finally{for(const key of Object.keys(previous)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]}}
})
