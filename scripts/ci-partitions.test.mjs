import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { partitionPlans, partitionPlan, verificationPlan, digest, sourceDigest } from './verification-contract.mjs';
import { nativeCiPlan, shardNativePlan } from './run-ci-native.mjs';
import { repeatedMemoryScenarios, selectedRepeatedScenarios } from './repeated-memory-scenarios.mjs';
import { requiredJobs, requiredJobsSucceeded, validateCiEvidence } from './verify-ci-results.mjs';
import { createCiPlan, lanePlan, checkoutIdentity, ciPlatforms, ciToolchain, selectChanges, readChangedFiles, nativeSelection } from './ci-plan.mjs';
import { sourceDigest as nativeDigest, sha256, acceptanceSummary } from './micro-judge-artifacts.mjs';
const root=path.resolve(import.meta.dirname,'..');
const contractBytes=readFileSync(path.join(root,'scripts/verification.json')),contract=JSON.parse(contractBytes);
const selectionIdentity={commit:'commit',sourceDigest:'selection-source',contractDigest:'contract',toolchain:ciToolchain};
const full=createCiPlan(contract,{full:true},selectionIdentity);
const plans=(selection=full)=>selection.lanes.map(lane=>({...lane,...lanePlan(contract,selection,lane.id)}));
const state={sourceDigest:'source',contractDigest:'contract',commit:'commit',runtime:process.version,selectionIdentity};
function goodEntries(identity=state,selection=full){return plans(selection).map(plan=>({report:{schema:'verification-result-v1',package:contract.package,
  commit:identity.commit,sourceDigest:identity.sourceDigest,contractDigest:identity.contractDigest,runtime:identity.runtime,
  selectionDigest:selection.digest,bundleScope:selection.bundleScope,
  profile:plan.profile,partition:plan.partition,platform:plan.platform,architecture:plan.architecture,status:'passed',completeScope:false,completionReady:false,
  checks:plan.checks.map(check=>({id:check.id,status:'passed'})),
  ...(plan.checks.some(check=>check.packed)?{artifact:{path:'/original/tested.tgz',hash:'archive',distDigest:'dist'}}:{})},
  ...(plan.checks.some(check=>check.packed)?{artifactHash:'archive',artifactReceipt:{hash:'archive',distDigest:'dist',sourceDigest:identity.sourceDigest,
    selectionDigest:selection.digest,bundleScope:selection.bundleScope,buildExecution:{exitCode:0},packExecution:{exitCode:0}}}:{})}));}

test('partition ownership rejects empty, duplicate, missing, unknown and dependency-free lanes',()=>{
  for(const mutation of [
    c=>{c.ciPartitions.lisp.lanes.distribution=[]},
    c=>{delete c.ciPartitions.lisp.lanes.distribution},
    c=>{c.ciPartitions.lisp.lanes.distribution.push('owned-native')},
    c=>{c.ciPartitions.lisp.lanes.distribution.push('invented')},
    c=>{c.ciPartitions.lisp.shared=['verification-contract']},
    c=>{c.ciPartitions.lisp.splits['lisp-native'].count=0},
    c=>{c.ciPartitions.lisp.splits.invented={kind:'native',count:2}},
    c=>{c.ciPartitions.lisp.shared.push('build')},
    c=>{c.checks.push({...c.checks.find(check=>check.id==='typecheck'),id:'new-unowned-check',profiles:['lisp']})},
  ]){const changed=structuredClone(contract);mutation(changed);assert.throws(()=>partitionPlans(changed,'lisp'));}
  assert.throws(()=>partitionPlan(contract,'lisp','missing'));
  assert.throws(()=>partitionPlan(contract,'main','unit'));
});

test('native file shards are nonempty, disjoint and exactly cover the same source/runtime',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'ci-native-metadata-'));
  try{
    mkdirSync(path.join(directory,'@deepseek-ai/dsh'),{recursive:true});
    writeFileSync(path.join(directory,'@deepseek-ai/dsh/package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'fixture'}));
    for(const suite of ['ci-integration','ci-e2e','lisp']){
      const full=nativeCiPlan(suite,{KIOKUKO_DSH_PACKAGE_ROOT:directory}),shards=['1/2','2/2'].map(shard=>shardNativePlan(full,shard));
      const files=shards.flatMap(shard=>shard.args.slice(1));
      const repeated='tests/dsh/e2e/repeated-memory-lifecycle.test.ts';
      assert.equal(files.length-new Set(files).size,suite==='ci-e2e'?1:0);
      assert.deepEqual([...new Set(files)].sort(),full.args.slice(1).sort());
      for(const shard of shards){assert.ok(shard.args.length>1);const env={...shard.env};delete env.KIOKUKO_REPEATED_SCENARIOS;assert.deepEqual(env,full.env);assert.equal(shard.cwd,full.cwd);}
      if(suite==='ci-e2e'){
        assert.ok(shards.every(shard=>shard.args.includes(repeated)));
        const scenarios=shards.flatMap(shard=>selectedRepeatedScenarios(shard.env));
        assert.equal(new Set(scenarios).size,scenarios.length);
        assert.deepEqual(scenarios.sort(),[...repeatedMemoryScenarios].sort());
      }
      for(const invalid of ['','0/2','3/2','1/0','1/999999','1.5/2','1/2/3'])assert.throws(()=>shardNativePlan(full,invalid));
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('all required job outcomes are checked without spawning a shell for each truth-table row',()=>{
  const outcomes=['success','failure','cancelled','skipped',''];
  function visit(index,needs){if(index===requiredJobs.length){assert.equal(requiredJobsSucceeded(needs,full),requiredJobs.every(id=>needs[id].result==='success'));return;}
    for(const result of outcomes)visit(index+1,{...needs,[requiredJobs[index]]:{result}});}
  visit(0,{});
  assert.equal(requiredJobsSucceeded(null,full),false);
  for(const id of requiredJobs){const needs=Object.fromEntries(requiredJobs.map(key=>[key,{result:'success'}]));delete needs[id];assert.equal(requiredJobsSucceeded(needs,full),false);}
});

test('CI evidence requires each complete, fresh OS/lane and rejects altered archives or build receipts',()=>{
  const entries=goodEntries();assert.equal(entries.length,22);assert.equal(validateCiEvidence(contract,entries,state,full),true);
  assert.equal(validateCiEvidence(contract,[],state,full),false);
  for(let i=0;i<entries.length;i++){
    assert.equal(validateCiEvidence(contract,entries.filter((_,n)=>n!==i),state,full),false,'missing lane '+i);
    for(const status of ['failed','cancelled','interrupted','skipped','stale','']){
      const bad=structuredClone(entries);bad[i].report.status=status;assert.equal(validateCiEvidence(contract,bad,state,full),false,status);
    }
    for(const mutation of [
      r=>{r.checks=[]},r=>{r.checks.pop()},r=>{r.checks.push(r.checks[0])},r=>{r.checks[0].status='skipped'},
      r=>{r.sourceDigest='old'},r=>{r.contractDigest='old'},r=>{r.commit='old'},r=>{r.runtime='old'},
      r=>{r.selectionDigest='foreign'},r=>{r.bundleScope='representative'},r=>{r.architecture='foreign'},r=>{r.partition='unknown'},r=>{r.completeScope=true},r=>{r.completionReady=true},
    ]){const bad=structuredClone(entries);mutation(bad[i].report);assert.equal(validateCiEvidence(contract,bad,state,full),false);}
  }
  const duplicate=structuredClone(entries);duplicate[0]=duplicate[1];assert.equal(validateCiEvidence(contract,duplicate,state,full),false);
  const packed=entries.findIndex(entry=>entry.report.artifact);
  for(const mutation of [
    e=>{delete e.report.artifact},e=>{e.artifactHash='changed'},e=>{e.artifactReceipt.hash='changed'},
    e=>{e.artifactReceipt.sourceDigest='old'},e=>{e.artifactReceipt.distDigest='changed'},e=>{e.artifactReceipt.selectionDigest='changed'},e=>{e.artifactReceipt.bundleScope='representative'},
    e=>{e.artifactReceipt.buildExecution.exitCode=1},e=>{e.artifactReceipt.packExecution.timedOut=true},e=>{e.artifactReceipt.packExecution.signal='SIGTERM'},
  ]){const bad=structuredClone(entries);mutation(bad[packed]);assert.equal(validateCiEvidence(contract,bad,state,full),false);}
});

test('the actual aggregate CLI rejects missing jobs/reports, stale selection and tarball corruption',async()=>{
  // Structural transport fixtures only; these headers do not claim native execution.
  const directory=mkdtempSync(path.join(tmpdir(),'ci-evidence-cli-')),repo=path.join(directory,'repo'),evidence=path.join(directory,'evidence');mkdirSync(repo);mkdirSync(evidence);
  try{
    for(const rel of ['scripts/verify-ci-results.mjs','scripts/verification-contract.mjs','scripts/verification-completion.mjs','scripts/ci-plan.mjs','scripts/micro-judge-artifacts.mjs','scripts/verify.mjs','scripts/verification.json','crates/micro-judge/Cargo.toml','crates/micro-judge/src/main.rs','crates/micro-judge/src/digest.rs']){
      mkdirSync(path.dirname(path.join(repo,rel)),{recursive:true});cpSync(path.join(root,rel),path.join(repo,rel));
    }
    // Read real Git identity from the source checkout, never mutate its index.
    const previous={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE};
    process.env.GIT_DIR=path.join(root,'.git');process.env.GIT_WORK_TREE=repo;
    try{
      const identity=checkoutIdentity(repo),selection=createCiPlan(contract,{full:true},identity),selectedFile=path.join(directory,'selected.json');writeFileSync(selectedFile,JSON.stringify(selection));
      const folder=path.join(repo,'micro-judge');mkdirSync(folder);const nativeSource=await nativeDigest(repo),artifacts=[];
      const tap='actual Rust agrees with an independent exhaustive oracle on 200 deterministic small problems\nactual Rust MRV 8 queens has 92 solutions\nmissing or unsupported binary is explicit unavailable, never an allow\n# tests 18\n# pass 18\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
      for(const target of selection.nativeTargets){const binary=Buffer.alloc(64),key=target.key;
        if(target.platform==='linux'){binary.write('7f454c46',0,'hex');binary[4]=2;binary[5]=1;binary.writeUInt16LE(target.architecture==='arm64'?183:62,18)}else{binary.write('cffaedfe',0,'hex');binary.writeUInt32LE(0x100000c,4)}
        const entry={platform:target.platform,arch:target.architecture,file:key+'/kiokuko-micro-judge',bytes:binary.length,sha256:sha256(binary),sourceDigest:nativeSource,nativeVerified:true,compiler:ciToolchain.rust};
        mkdirSync(path.join(folder,key));writeFileSync(path.join(folder,entry.file),binary);writeFileSync(path.join(folder,'native-acceptance-'+key+'.tap'),tap);
        writeFileSync(path.join(folder,'native-verification-'+key+'.json'),JSON.stringify({schemaVersion:1,target:{'linux-x64':'x86_64-unknown-linux-gnu','linux-arm64':'aarch64-unknown-linux-gnu','darwin-arm64':'aarch64-apple-darwin'}[key],platform:entry.platform,arch:entry.arch,binarySha256:entry.sha256,sourceDigest:nativeSource,compiler:entry.compiler,exitCode:0,log:'native-acceptance-'+key+'.tap',logSha256:sha256(tap),summary:acceptanceSummary(tap)}));artifacts.push(entry);
      }
      writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({version:'kiokuko-fd-v1',artifacts}));
      const marker={planDigest:selection.digest,identity:selection.identity,bundleScope:selection.bundleScope,targets:selection.nativeTargets.map(t=>t.key).sort()};writeFileSync(path.join(folder,'selection.json'),JSON.stringify(marker));
      const current={...state,commit:identity.commit,sourceDigest:sourceDigest(repo),contractDigest:digest(contractBytes),selectionIdentity:identity},entries=goodEntries(current,selection);
      entries.forEach((entry,i)=>{const out=path.join(evidence,String(i));mkdirSync(out);
        if(entry.report.artifact){entry.report.artifact.hash=digest('test archive');entry.artifactReceipt.hash=entry.report.artifact.hash;writeFileSync(path.join(out,'tested.tgz'),'test archive');writeFileSync(path.join(out,'artifact.json'),JSON.stringify(entry.artifactReceipt))}
        writeFileSync(path.join(out,'result.json'),JSON.stringify(entry.report));
      });
      const success=Object.fromEntries(requiredJobs.map(id=>[id,{result:'success'}]));
      const run=needs=>spawnSync(process.execPath,[path.join(repo,'scripts/verify-ci-results.mjs'),'--ci-plan',selectedFile,evidence],{cwd:repo,env:{...process.env,NEEDS_JSON:JSON.stringify(needs)},encoding:'utf8'});
      const observed=run(success);assert.equal(observed.status,0,observed.stderr);
      for(const id of requiredJobs){const bad=structuredClone(success);delete bad[id];assert.equal(run(bad).status,1)}
      for(const result of ['failure','cancelled','skipped',''])assert.equal(run({...success,checks:{result}}).status,1);
      const packed=entries.findIndex(e=>e.report.artifact),archive=path.join(evidence,String(packed),'tested.tgz');writeFileSync(archive,'corrupted');assert.equal(run(success).status,1);writeFileSync(archive,'test archive');
      const saved=path.join(evidence,'0','result.json'),bytes=readFileSync(saved);rmSync(saved);assert.equal(run(success).status,1);writeFileSync(saved,bytes);
      const narrow=structuredClone(marker);narrow.bundleScope='representative';writeFileSync(path.join(folder,'selection.json'),JSON.stringify(narrow));assert.equal(run(success).status,1);writeFileSync(path.join(folder,'selection.json'),JSON.stringify(marker));
      // The saved-result status path reconstructs this exact selected lane.
      const localCore=entries.find(e=>e.report.platform===process.platform&&e.report.architecture===process.arch&&!e.report.artifact);assert.ok(localCore);
      const statusFolder=path.join(directory,'status');mkdirSync(statusFolder);const statusFile=path.join(statusFolder,'result.json');writeFileSync(statusFile,JSON.stringify(localCore.report));writeFileSync(path.join(statusFolder,'selection.json'),JSON.stringify(selection));
      const status=()=>spawnSync(process.execPath,[path.join(repo,'scripts/verify.mjs'),'--status',statusFile],{cwd:repo,env:process.env,encoding:'utf8'});
      assert.equal(status().status,0,status().stderr);const badReport=structuredClone(localCore.report);badReport.selectionDigest='old';writeFileSync(statusFile,JSON.stringify(badReport));assert.equal(status().status,1);writeFileSync(statusFile,JSON.stringify(localCore.report));
      writeFileSync(path.join(repo,'scripts/ci-plan.mjs'),readFileSync(path.join(repo,'scripts/ci-plan.mjs'),'utf8')+'\n// changed source\n');assert.equal(run(success).status,1);assert.equal(status().status,1);
    }finally{for(const key of Object.keys(previous)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]}}
  }finally{rmSync(directory,{recursive:true,force:true})}
});

// Selection risks are tested here with the existing coverage/aggregate contracts.
test('pnpm prerequisites provision full main and representative core lanes',()=>{
  for(const id of ['publint','native-integration','ci-native-integration'])
    assert.ok(contract.checks.find(check=>check.id===id)?.requires.includes('pnpm'),id);
  const request=path=>({available:true,changes:[{status:'M',path}]});
  const representative=createCiPlan(contract,request('src/dsh/task-state.ts'),selectionIdentity);
  const ui=createCiPlan(contract,request('src/client.ts'),selectionIdentity);
  assert.equal(full.jobCount,27);assert.equal(representative.jobCount,5);assert.equal(ui.jobCount,6);
  for(const [selection,id,required] of [
    [full,'main-unit-evaluations',['publint']],
    [full,'main-integration',['ci-native-integration-1','ci-native-integration-2']],
    [representative,'core-linux-x64',['publint','ci-native-integration-1','ci-native-integration-2']],
  ]){
    const lane=selection.lanes.find(lane=>lane.id===id);
    assert.equal(lane.pnpm,true,id);assert.equal(lane.pnpmVersion,'11.7.0',id);
    const checks=lanePlan(contract,selection,id).checks;
    for(const check of required)assert.ok(checks.find(entry=>entry.id===check)?.requires.includes('pnpm'),`${id}/${check}`);
  }
});
test('selected coverage fails safe and retains the complete inventory in full mode',()=>{
  const request=(file,status='M')=>({available:true,changes:[{status,path:file}]});
  for(const [file,count,reports]of [['docs/guide.md',2,0],['src/dsh/task-state.ts',5,2],['src/client.ts',6,3],['src/dsh/lisp/sandbox.darwin.ts',7,3],['src/dsh/lisp/sandbox.ts',9,4]]){
    const p=createCiPlan(contract,request(file),selectionIdentity);assert.equal(p.jobCount,count,file);assert.equal(p.lanes.length,reports,file);
    assert.equal(validateCiEvidence(contract,goodEntries(state,p),state,p),true,file);
    const jobs=Object.fromEntries(requiredJobs.map(id=>[id,{result:id==='select'||(id==='checks'?p.lanes.length:p.nativeTargets.length)?'success':'skipped'}]));assert.equal(requiredJobsSucceeded(jobs,p),true);
    for(const id of requiredJobs){const bad=structuredClone(jobs);bad[id].result='cancelled';assert.equal(requiredJobsSucceeded(bad,p),false)}
    for(const entry of goodEntries(state,p)){const missing=goodEntries(state,p).filter(x=>x.report.partition!==entry.report.partition);assert.equal(validateCiEvidence(contract,missing,state,p),false)}
  }
  for(const r of [request('unknown/new-file.ts'),request('skills/kiokuko/SKILL.md'),request('src/serialization/validate.ts'),request('package-lock.json'),request('scripts/verify.mjs'),request('tests/fixtures/dsh-runtime/package.json'),request('docs/guide.md','D'),request('src/dsh/task-state.ts','R100'),{available:false,changes:[]},{available:true,changes:[]},{...request('docs/guide.md'),full:true}])assert.equal(createCiPlan(contract,r,selectionIdentity).mode,'full');
  assert.equal(full.jobCount,27);assert.equal(full.lanes.length,22);
  for(const [key,target]of Object.entries(ciPlatforms)){
    for(const plan of partitionPlans(contract,'lisp',target.platform)){const lane=full.lanes.find(l=>l.key===key&&l.selectors[0].profile==='lisp'&&l.selectors[0].partition===plan.partition);assert.deepEqual(lanePlan(contract,full,lane.id).checks,plan.checks);if(key==='darwin-arm64')assert.equal(lane.runner,'macos-latest')}
    const lane=full.lanes.find(l=>l.key===key&&l.selectors[0].profile==='semantic');assert.deepEqual(lanePlan(contract,full,lane.id).checks,verificationPlan(contract,'semantic',target.platform).checks);
  }
  for(const plan of partitionPlans(contract,'ci-main','linux'))assert.deepEqual(lanePlan(contract,full,'main-'+plan.partition).checks,plan.checks);
  for(const [profile,id,platform]of [['runtime','runtime-darwin-arm64','darwin'],['browser','browser','linux']])assert.deepEqual(lanePlan(contract,full,id).checks,verificationPlan(contract,profile,platform).checks);
  const representative=createCiPlan(contract,request('src/dsh/task-state.ts'),selectionIdentity),core=lanePlan(contract,representative,'core-linux-x64').checks;
  assert.equal(core.filter(c=>c.id==='build').length,1);for(const id of ['ci-native-unit','ci-native-integration-1','ci-native-integration-2','lisp-native-1','lisp-native-2','owned-native'])assert.ok(core.some(c=>c.id===id),id);
  for(const id of ['consumer-npm','consumer-pnpm','dsh-lifecycle','dsh-cli-profile'])assert.ok(lanePlan(contract,representative,'consumer-linux-x64').checks.some(c=>c.id===id),id);
});
test('PR merge-base and push-before diff parsing preserve rename/deletion and unavailable fail-safe',()=>{
  const before='a'.repeat(40),ancestor='b'.repeat(40);
  for(const pr of [true,false]){const calls=[];const parsed=readChangedFiles(root,pr?{pull_request:{base:{sha:before}}}:{before},args=>{calls.push(args);if(args[0]==='merge-base')return ancestor+'\n';if(args[0]==='cat-file')return '';return 'M\0src/dsh/task-state.ts\0R100\0docs/old.md\0docs/new.md\0D\0docs/deleted.md\0'});
    assert.equal(calls.some(args=>args[0]==='merge-base'),pr);assert.equal(calls.at(-1).at(-2),pr?ancestor:before);assert.deepEqual(parsed.changes.map(c=>c.status),['M','R100','D']);assert.equal(selectChanges(parsed).mode,'full');
  }
  assert.equal(readChangedFiles(root,{before:'0'.repeat(40)}).available,false);assert.equal(readChangedFiles(root,{before},()=>{throw new Error('missing base')}).available,false);
});

test('repeated lifecycle selection rejects empty, malformed, duplicate, unknown or conflicting scopes',()=>{
  assert.deepEqual(selectedRepeatedScenarios({}),[...repeatedMemoryScenarios]);
  assert.deepEqual(selectedRepeatedScenarios({KIOKUKO_REPEATED_SCENARIO:repeatedMemoryScenarios[0]}),[repeatedMemoryScenarios[0]]);
  for(const value of ['', '[]','null','{}','["unknown"]',JSON.stringify([repeatedMemoryScenarios[0],repeatedMemoryScenarios[0]])])
    assert.throws(()=>selectedRepeatedScenarios({KIOKUKO_REPEATED_SCENARIOS:value}));
  assert.throws(()=>selectedRepeatedScenarios({KIOKUKO_REPEATED_SCENARIO:'',KIOKUKO_REPEATED_SCENARIOS:'[]'}));
});
