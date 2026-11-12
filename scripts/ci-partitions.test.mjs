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

test('CI fixture install recovers one npm internal exit and retains setup failures without secrets', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const step = workflow.jobs.checks.steps.find(step => step.name === 'Install locked CLI and terminal test support');
  const depot = parse(readFileSync(path.join(root, '.depot/workflows/ci.yml'), 'utf8'));
  for (const name of [step.name, 'Retain exact official DSH identity with verification evidence'])
    assert.deepEqual(depot.jobs.checks.steps.find(step => step.name === name), workflow.jobs.checks.steps.find(step => step.name === name));
  const temporary = mkdtempSync(path.join(tmpdir(), 'ci-install-contract-'));
  try {
    const bin = path.join(temporary, 'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs=require('node:fs'),p=process.env.CI_TEST_COUNT;
const n=fs.existsSync(p)?Number(fs.readFileSync(p))+1:1;fs.writeFileSync(p,String(n));
if(process.env.CI_TEST_MODE==='success'||process.env.CI_TEST_MODE==='recover'&&n===2)process.exit(0);
console.error(process.env.CI_TEST_MODE==='ordinary'?'npm error code ERESOLVE':'npm error Exit handler never called!');
console.error('Authorization: Bearer DO_NOT_PERSIST_CI_SECRET');process.exit(1);
`, { mode: 0o755 });
    for (const [mode, exit, attempts] of [['recover', 0, 2], ['persistent', 1, 2], ['ordinary', 1, 1], ['success', 0, 1]]) {
      const directory = path.join(temporary, mode); mkdirSync(directory);
      const count = path.join(directory, 'count');
      const command = step.run.replaceAll('${{ runner.temp }}', directory);
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], { cwd: root,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CI_TEST_MODE: mode, CI_TEST_COUNT: count }, encoding: 'utf8' });
      assert.equal(result.status, exit, `${mode}: ${result.stderr}`);
      assert.equal(Number(readFileSync(count)), attempts, mode);
      const report = JSON.parse(readFileSync(path.join(directory, 'ci-setup/fixture-install.json')));
      assert.equal(report.status, exit === 0 ? 'passed' : 'failed');
      assert.equal(report.attempts.length, attempts);
      assert.ok(!JSON.stringify(report).includes('DO_NOT_PERSIST_CI_SECRET'));
      const retain = workflow.jobs.checks.steps.find(step => step.name === 'Retain exact official DSH identity with verification evidence');
      const retained = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', retain.run
        .replaceAll('${{ runner.temp }}', directory)
        .replaceAll('tests/fixtures/dsh-runtime/node_modules/.kiokuko-dsh-upstream.json', path.join(directory, 'not-staged.json'))],
      { cwd: root, encoding: 'utf8' });
      assert.equal(retained.status, 0, retained.stderr);
      assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'verification/setup/fixture-install.json'))), report);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
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
      const full=nativeCiPlan(suite,{KIOKUKO_DSH_PACKAGE_ROOT:directory,KIOKUKO_DSH_RUNTIME_MODE:'historical'}),shards=['1/2','2/2'].map(shard=>shardNativePlan(full,shard));
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
  const entries=goodEntries();assert.equal(entries.length,19);assert.equal(validateCiEvidence(contract,entries,state,full),true);
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

test('the aggregate CLI reports failed selection before trying to read its absent plan',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'missing-ci-plan-'));
  try{
    const needs={select:{result:'failure'},'micro-judge-native':{result:'skipped'},'dsh-build':{result:'skipped'},checks:{result:'skipped'}};
    const run=()=>spawnSync(process.execPath,[path.join(root,'scripts/verify-ci-results.mjs'),'--ci-plan',path.join(directory,'selected.json'),directory],{cwd:root,env:{...process.env,NEEDS_JSON:JSON.stringify(needs)},encoding:'utf8'});
    const failed=run();assert.equal(failed.status,1);assert.match(failed.stderr,/job select: failure \(expected success\)/);
    needs.select.result='success';const missing=run();assert.equal(missing.status,1);assert.match(missing.stderr,/Selected CI plan artifact is missing/);
  }finally{rmSync(directory,{recursive:true,force:true})}
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
      const observed=run(success);assert.equal(observed.status,0,observed.stderr);assert.equal(observed.stderr,'');
      for(const id of requiredJobs){const bad=structuredClone(success);delete bad[id];const failed=run(bad);assert.equal(failed.status,1);assert.ok(failed.stderr.includes(`job ${id}: missing`),failed.stderr)}
      for(const result of ['failure','cancelled','skipped','']){const failed=run({...success,checks:{result}});assert.equal(failed.status,1);assert.ok(failed.stderr.includes(`job checks: ${result||'unknown'}`),failed.stderr)}
      const failedIndex=entries.findIndex(e=>e.report.partition==='lisp-linux-x64-native-1');
      assert.ok(failedIndex>=0);
      const failedFile=path.join(evidence,String(failedIndex),'result.json'),originalReport=readFileSync(failedFile);
      const failedReport=structuredClone(entries[failedIndex].report);failedReport.status='failed';
      const failedCheck=failedReport.checks.find(c=>c.id==='lisp-native-1');assert.ok(failedCheck);failedCheck.status='failed';failedCheck.exitCode=1;
      failedCheck.reportFiles=['node.json'];
      const nodeDirectory=path.join(evidence,String(failedIndex),failedCheck.id);mkdirSync(nodeDirectory);
      writeFileSync(path.join(nodeDirectory,'node.json'),JSON.stringify({schema:'verification-node-v1',tests:[{type:'test:fail',file:'repository-ownership.test.ts',name:'supervisor loss retains live ownership'}]}));
      writeFileSync(failedFile,JSON.stringify(failedReport));
      const failed=run({...success,checks:{result:'failure'}});assert.equal(failed.status,1);
      assert.match(failed.stderr,/lisp-linux-x64-native.*lisp-native-1.*failed.*exitCode=1/);
      assert.ok(failed.stderr.includes(failedFile),failed.stderr);
      assert.match(failed.stderr,/failed test: .*repository-ownership.test.ts.*supervisor loss retains live ownership/);
      writeFileSync(failedFile,originalReport);
      const packed=entries.findIndex(e=>e.report.artifact),archive=path.join(evidence,String(packed),'tested.tgz');writeFileSync(archive,'corrupted');assert.equal(run(success).status,1);writeFileSync(archive,'test archive');
      const saved=path.join(evidence,'0','result.json'),bytes=readFileSync(saved);rmSync(saved);
      const setupFolder=path.join(evidence,'0','setup');mkdirSync(setupFolder);
      writeFileSync(path.join(setupFolder,'fixture-install.json'),JSON.stringify({schema:'ci-install-v1',status:'failed',attempts:[{exitCode:1,internalExit:true,elapsedMs:359000}]}));
      const missing=run(success);assert.equal(missing.status,1);assert.ok(missing.stderr.includes(`lane ${entries[0].report.partition}: missing report`));
      assert.match(missing.stderr,/CI setup failed: fixture-install/);assert.match(missing.stderr,/exitCode=1; internalExit=true; elapsedMs=359000/);
      writeFileSync(saved,bytes);rmSync(setupFolder,{recursive:true});
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
  assert.equal(full.jobCount,25);assert.equal(representative.jobCount,8);assert.equal(ui.jobCount,9);
  for (const selection of [full, ui]) {
    const sidebar = lanePlan(contract, selection, 'browser').checks.find(check => check.id === 'memory-sidebar-web');
    assert.equal(sidebar?.packed, true);
    assert.deepEqual(sidebar?.completionEvidence, { packedWeb: true, nativeSidebar: true, reuseFreshness: true });
  }
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
  // Upstream can change even when this repository changes only prose.
  for(const file of ['docs/guide.md','src/dsh/task-state.ts']){
    const current=createCiPlan(contract,{...request(file),dshSha:'a'.repeat(40)},selectionIdentity);
    assert.equal(current.mode,'full','latest DSH is an independent compatibility input');
    assert.deepEqual(current.lanes,full.lanes);
    const next=createCiPlan(contract,{...request(file),dshSha:'b'.repeat(40)},selectionIdentity);
    assert.notEqual(current.digest,next.digest,'a new upstream revision cannot reuse the previous plan identity');
  }
  for(const dshSha of ['', 'master', 'a'.repeat(39)])assert.throws(()=>createCiPlan(contract,{...request('docs/guide.md'),dshSha},selectionIdentity));
  for(const [file,count,reports]of [['docs/guide.md',2,0],['src/dsh/task-state.ts',8,4],['src/client.ts',9,5],['src/dsh/lisp/sandbox.darwin.ts',13,7],['src/dsh/lisp/sandbox.ts',13,7]]){
    const p=createCiPlan(contract,request(file),selectionIdentity);assert.equal(p.jobCount,count,file);assert.equal(p.lanes.length,reports,file);
    assert.equal(validateCiEvidence(contract,goodEntries(state,p),state,p),true,file);
    const jobs=Object.fromEntries(requiredJobs.map(id=>[id,{result:id==='select'||(id==='checks'?p.lanes.length:id==='dsh-build'?p.dshTargets.length:p.nativeTargets.length)?'success':'skipped'}]));assert.equal(requiredJobsSucceeded(jobs,p),true);
    for(const id of requiredJobs){const bad=structuredClone(jobs);bad[id].result='cancelled';assert.equal(requiredJobsSucceeded(bad,p),false)}
    for(const entry of goodEntries(state,p)){const missing=goodEntries(state,p).filter(x=>x.report.partition!==entry.report.partition);assert.equal(validateCiEvidence(contract,missing,state,p),false)}
  }
  for(const r of [request('unknown/new-file.ts'),request('skills/kiokuko/SKILL.md'),request('src/serialization/validate.ts'),request('package-lock.json'),request('scripts/verify.mjs'),request('tests/fixtures/dsh-runtime/package.json'),request('docs/guide.md','D'),request('src/dsh/task-state.ts','R100'),{available:false,changes:[]},{available:true,changes:[]},{...request('docs/guide.md'),full:true}])assert.equal(createCiPlan(contract,r,selectionIdentity).mode,'full');
  assert.equal(full.jobCount,25);assert.equal(full.lanes.length,19);
  for(const [key,target]of Object.entries(ciPlatforms)){
    for(const plan of partitionPlans(contract,'lisp',target.platform)){const lane=full.lanes.find(l=>l.key===key&&l.selectors[0].profile==='lisp'&&l.selectors[0].partition===plan.partition);assert.deepEqual(lanePlan(contract,full,lane.id).checks,plan.checks);if(key==='darwin-arm64')assert.equal(lane.runner,'macos-latest')}
    const lane=full.lanes.find(l=>l.key===key&&l.selectors[0].profile==='semantic');assert.deepEqual(lanePlan(contract,full,lane.id).checks,verificationPlan(contract,'semantic',target.platform).checks);
  }
  for(const plan of partitionPlans(contract,'ci-main','linux'))assert.deepEqual(lanePlan(contract,full,'main-'+plan.partition).checks,plan.checks);
  for(const [profile,id,platform]of [['runtime','runtime-darwin-arm64','darwin'],['browser','browser','linux']])assert.deepEqual(lanePlan(contract,full,id).checks,verificationPlan(contract,profile,platform).checks);
  const representative=createCiPlan(contract,request('src/dsh/task-state.ts'),selectionIdentity),core=lanePlan(contract,representative,'core-linux-x64').checks;
  assert.equal(core.filter(c=>c.id==='build').length,1);for(const id of ['ci-native-unit','ci-native-integration-1','ci-native-integration-2'])assert.ok(core.some(c=>c.id===id),id);
  const nativeChecks=representative.lanes.filter(l=>l.id.startsWith('lisp-')).flatMap(l=>lanePlan(contract,representative,l.id).checks);
  for(const id of ['lisp-native-1','lisp-native-2','owned-native'])assert.ok(nativeChecks.some(c=>c.id===id),id);
  for(const id of ['consumer-npm','consumer-pnpm','dsh-cli-profile'])assert.ok(lanePlan(contract,representative,'consumer-linux-x64').checks.some(c=>c.id===id),id);
});
test('Depot CI selects one Linux native producer instead of relabeling unsupported macOS work',()=>{
  const selection=createCiPlan(contract,{full:true},{...selectionIdentity,ciPlatform:'linux-x64'});
  assert.equal(selection.mode,'representative');
  assert.match(selection.reason,/linux-x64-only CI host/);
  assert.deepEqual(selection.nativeTargets.map(target=>target.key),['linux-x64']);
  assert.ok(selection.lanes.length>0);
  assert.ok(selection.lanes.every(lane=>lane.key==='linux-x64'&&lane.runner==='ubuntu-24.04'));
  assert.ok(selection.lanes.every(lane=>lane.release===false));
  const docs=createCiPlan(contract,{available:true,changes:[{status:'M',path:'docs/guide.md'}],dshSha:'a'.repeat(40)},{...selectionIdentity,ciPlatform:'linux-x64'});
  assert.deepEqual(docs.lanes,selection.lanes,'latest DSH must still run on the supported Depot host for docs changes');
  assert.throws(()=>createCiPlan(contract,{full:true},{...selectionIdentity,ciPlatform:'darwin-arm64'}),/Only the Linux x64 Depot CI platform is supported/);
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

test('CI schedules Linux x64 and macOS ARM64 while runtime native target support stays independent',async()=>{
  assert.deepEqual(Object.keys(ciPlatforms).sort(),['darwin-arm64','linux-x64']);
  assert.deepEqual(full.nativeTargets.map(target=>target.key).sort(),['darwin-arm64','linux-x64']);
  assert.ok(full.lanes.every(lane=>lane.key!=='linux-arm64'&&lane.runner!=='ubuntu-24.04-arm'));
  for(const lane of full.lanes)assert.equal(lanePlan(contract,full,lane.id).checks.filter(check=>check.id==='build').length,1,'each lane retains its fresh source build');

  const linux=createCiPlan(contract,{available:true,changes:[{status:'M',path:'src/dsh/lisp/sandbox.linux.ts'}]},selectionIdentity);
  assert.deepEqual(linux.platforms,['linux-x64']);
  const {nativeTargets}=await import('./micro-judge-artifacts.mjs');
  assert.ok(Object.hasOwn(nativeTargets,'linux-arm64'),'CI scope does not remove runtime/native-build support');
});

test('official DSH builds once per platform and Lisp shards run in independent lanes without losing checks',()=>{
  const selection=createCiPlan(contract,{full:true,dshSha:'a'.repeat(40)},selectionIdentity);
  assert.deepEqual(selection.dshTargets?.map(target=>target.key).sort(),['darwin-arm64','linux-x64']);
  for(const platform of ['linux','darwin']) {
    const lanes=plans(selection).filter(lane=>lane.platform===platform && lane.selectors.some(s=>s.profile==='lisp'));
    const shards=lanes.filter(lane=>lane.checks.some(check=>/^lisp-native-\d+$/.test(check.id)));
    assert.equal(shards.length,2,'the two shards must be independent matrix jobs');
    assert.ok(shards.every(lane=>lane.checks.filter(check=>/^lisp-native-\d+$/.test(check.id)).length===1));
    const observed=lanes.flatMap(lane=>lane.checks.filter(check=>check.id!=='build').map(check=>check.id));
    const expected=verificationPlan(contract,'lisp',platform).checks.filter(check=>check.id!=='build').flatMap(check=>
      check.id==='lisp-native'?['lisp-native-1','lisp-native-2']:check.id==='skill-delivery'?['skill-delivery-source','skill-delivery-packed']:[check.id]);
    assert.deepEqual(observed.sort(),expected.sort(),'all checks still have exactly one owner per OS');
  }
});
