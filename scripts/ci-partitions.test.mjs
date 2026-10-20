import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { partitionPlans, partitionPlan, verificationPlan, digest, sourceDigest } from './verification-contract.mjs';
import { nativeCiPlan, shardNativePlan } from './run-ci-native.mjs';
import { repeatedMemoryScenarios, selectedRepeatedScenarios } from './repeated-memory-scenarios.mjs';
import { ciTargets, requiredJobs, requiredJobsSucceeded, validateCiEvidence } from './verify-ci-results.mjs';
const root=path.resolve(import.meta.dirname,'..');
const contractBytes=readFileSync(path.join(root,'scripts/verification.json')),contract=JSON.parse(contractBytes);
const plans=()=>Object.entries(ciTargets).flatMap(([profile,targets])=>targets.flatMap(target=>(contract.ciPartitions?.[profile] ? partitionPlans(contract,profile,target.platform) : [verificationPlan(contract,profile,target.platform)]).map(plan=>({...target,...plan}))));
const state={sourceDigest:'source',contractDigest:'contract',commit:'commit',runtime:process.version};
function goodEntries(identity=state){return plans().map(plan=>({report:{schema:'verification-result-v1',package:contract.package,...identity,
  profile:plan.profile,partition:plan.partition,platform:plan.platform,architecture:plan.architecture,status:'passed',completeScope:false,completionReady:false,
  checks:plan.checks.map(check=>({id:check.id,status:'passed'})),
  ...(plan.checks.some(check=>check.packed)?{artifact:{path:'/original/tested.tgz',hash:'archive',distDigest:'dist'}}:{})},
  ...(plan.checks.some(check=>check.packed)?{artifactHash:'archive',artifactReceipt:{hash:'archive',distDigest:'dist',sourceDigest:identity.sourceDigest,buildExecution:{exitCode:0},packExecution:{exitCode:0}}}:{})}));}

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
  function visit(index,needs){if(index===requiredJobs.length){assert.equal(requiredJobsSucceeded(needs),requiredJobs.every(id=>needs[id].result==='success'));return;}
    for(const result of outcomes)visit(index+1,{...needs,[requiredJobs[index]]:{result}});}
  visit(0,{});
  assert.equal(requiredJobsSucceeded(null),false);
  for(const id of requiredJobs){const needs=Object.fromEntries(requiredJobs.map(key=>[key,{result:'success'}]));delete needs[id];assert.equal(requiredJobsSucceeded(needs),false);}
});

test('CI evidence requires each complete, fresh OS/lane and rejects altered archives or build receipts',()=>{
  const entries=goodEntries();assert.equal(entries.length,18);assert.equal(validateCiEvidence(contract,entries,state),true);
  assert.equal(validateCiEvidence(contract,[],state),false);
  for(let i=0;i<entries.length;i++){
    assert.equal(validateCiEvidence(contract,entries.filter((_,n)=>n!==i),state),false,'missing lane '+i);
    for(const status of ['failed','cancelled','interrupted','skipped','stale','']){
      const bad=structuredClone(entries);bad[i].report.status=status;assert.equal(validateCiEvidence(contract,bad,state),false,status);
    }
    for(const mutation of [
      r=>{r.checks=[]},r=>{r.checks.pop()},r=>{r.checks.push(r.checks[0])},r=>{r.checks[0].status='skipped'},
      r=>{r.sourceDigest='old'},r=>{r.contractDigest='old'},r=>{r.commit='old'},r=>{r.runtime='old'},
      r=>{r.architecture='foreign'},r=>{r.partition='unknown'},r=>{r.completeScope=true},r=>{r.completionReady=true},
    ]){const bad=structuredClone(entries);mutation(bad[i].report);assert.equal(validateCiEvidence(contract,bad,state),false);}
  }
  const duplicate=structuredClone(entries);duplicate[0]=duplicate[1];assert.equal(validateCiEvidence(contract,duplicate,state),false);
  const packed=entries.findIndex(entry=>entry.report.artifact);
  for(const mutation of [
    e=>{delete e.report.artifact},e=>{e.artifactHash='changed'},e=>{e.artifactReceipt.hash='changed'},
    e=>{e.artifactReceipt.sourceDigest='old'},e=>{e.artifactReceipt.distDigest='changed'},
    e=>{e.artifactReceipt.buildExecution.exitCode=1},e=>{e.artifactReceipt.packExecution.timedOut=true},e=>{e.artifactReceipt.packExecution.signal='SIGTERM'},
  ]){const bad=structuredClone(entries);mutation(bad[packed]);assert.equal(validateCiEvidence(contract,bad,state),false);}
});

test('the actual aggregate CLI rejects missing jobs, missing reports and tarball corruption',()=>{
  const identity={sourceDigest:sourceDigest(root),contractDigest:digest(contractBytes),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),runtime:process.version};
  const directory=mkdtempSync(path.join(tmpdir(),'ci-evidence-cli-'));
  try{
    const entries=goodEntries(identity);
    entries.forEach((entry,i)=>{
      const folder=path.join(directory,String(i));mkdirSync(folder);
      if(entry.report.artifact){entry.report.artifact.hash=digest('test archive');entry.artifactReceipt.hash=entry.report.artifact.hash;writeFileSync(path.join(folder,'tested.tgz'),'test archive');writeFileSync(path.join(folder,'artifact.json'),JSON.stringify(entry.artifactReceipt));}
      writeFileSync(path.join(folder,'result.json'),JSON.stringify(entry.report));
    });
    const success=Object.fromEntries(requiredJobs.map(id=>[id,{result:'success'}]));
    const run=needs=>spawnSync(process.execPath,['scripts/verify-ci-results.mjs',directory],{cwd:root,env:{...process.env,NEEDS_JSON:JSON.stringify(needs)},encoding:'utf8'});
    const observed=run(success);assert.equal(observed.status,0,observed.stderr);
    for(const id of requiredJobs){const missing=structuredClone(success);delete missing[id];assert.equal(run(missing).status,1);}
    for(const result of ['failure','cancelled','skipped',''])assert.equal(run({...success,[requiredJobs[0]]:{result}}).status,1);
    const packed=entries.findIndex(entry=>entry.report.artifact);writeFileSync(path.join(directory,String(packed),'tested.tgz'),'corrupted');assert.equal(run(success).status,1);
    writeFileSync(path.join(directory,String(packed),'tested.tgz'),'test archive');
    rmSync(path.join(directory,'0','result.json'));assert.equal(run(success).status,1);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('repeated lifecycle selection rejects empty, malformed, duplicate, unknown or conflicting scopes',()=>{
  assert.deepEqual(selectedRepeatedScenarios({}),[...repeatedMemoryScenarios]);
  assert.deepEqual(selectedRepeatedScenarios({KIOKUKO_REPEATED_SCENARIO:repeatedMemoryScenarios[0]}),[repeatedMemoryScenarios[0]]);
  for(const value of ['', '[]','null','{}','["unknown"]',JSON.stringify([repeatedMemoryScenarios[0],repeatedMemoryScenarios[0]])])
    assert.throws(()=>selectedRepeatedScenarios({KIOKUKO_REPEATED_SCENARIOS:value}));
  assert.throws(()=>selectedRepeatedScenarios({KIOKUKO_REPEATED_SCENARIO:'',KIOKUKO_REPEATED_SCENARIOS:'[]'}));
});
