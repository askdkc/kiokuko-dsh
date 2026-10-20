import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, sourceDigest, partitionPlans, verificationPlan } from './verification-contract.mjs';

export const requiredJobs=['verify-main','lisp-runtime','semantic-platform-smoke','micro-judge-native','shortcut-browser','dsh-runtime-macos'];
export const ciTargets={
  'ci-main':[{runner:'ubuntu-24.04',platform:'linux',architecture:'x64'}],
  runtime:[{runner:'macos-15',platform:'darwin',architecture:'arm64'}],
  lisp:[{runner:'ubuntu-24.04',platform:'linux',architecture:'x64'},
    {runner:'ubuntu-24.04-arm',platform:'linux',architecture:'arm64'},
    {runner:'macos-latest',platform:'darwin',architecture:'arm64'}],
};
export const requiredJobsSucceeded=needs=>requiredJobs.every(id=>needs?.[id]?.result==='success');
const key=r=>[r.profile,r.partition,r.platform,r.architecture].join('/');

// The matrix result alone cannot detect an accidentally omitted lane. Require
// one current, nonempty, complete report for every declared lane and OS as well.
export function validateCiEvidence(contract,entries,state) {
  const expected=Object.entries(ciTargets).flatMap(([profile,targets])=>targets.flatMap(target=>
    (contract.ciPartitions?.[profile] ? partitionPlans(contract,profile,target.platform) : [verificationPlan(contract,profile,target.platform)]).map(plan=>({...target,...plan}))));
  if(entries.length!==expected.length||new Set(entries.map(entry=>key(entry.report??{}))).size!==expected.length)return false;
  return expected.every(plan=>{
    const entry=entries.find(entry=>key(entry.report??{})===key(plan)),report=entry?.report;
    if(!report||report.schema!=='verification-result-v1'||report.package!==contract.package||report.status!=='passed'
      ||report.completeScope!==false||report.completionReady!==false||report.commit!==state.commit
      ||report.sourceDigest!==state.sourceDigest||report.contractDigest!==state.contractDigest||report.runtime!==state.runtime
      ||!Array.isArray(report.checks)||report.checks.length!==plan.checks.length||new Set(report.checks.map(c=>c.id)).size!==plan.checks.length
      ||!plan.checks.every(check=>report.checks.some(observed=>observed.id===check.id&&(observed.status==='passed'||observed.status===check.status&&['scope-excluded','platform-excluded'].includes(check.status)))))return false;
    if(!plan.checks.some(check=>check.packed))return !report.artifact;
    const receipt=entry.artifactReceipt;
    return !!(report.artifact&&entry.artifactHash===report.artifact.hash&&receipt?.hash===entry.artifactHash
      &&receipt.sourceDigest===state.sourceDigest&&receipt.distDigest===report.artifact.distDigest
      &&[receipt.buildExecution,receipt.packExecution].every(command=>command?.exitCode===0&&!command.timedOut&&!command.signal));
  });
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try {
    if(process.argv.length!==3)throw new Error('Usage: verify-ci-results.mjs downloaded-report-directory');
    if(!requiredJobsSucceeded(JSON.parse(process.env.NEEDS_JSON??'null')))throw new Error('A required job failed, was cancelled/skipped, or is missing');
    const root=path.resolve(import.meta.dirname,'..'),directory=path.resolve(process.argv[2]);
    const entries=readdirSync(directory,{withFileTypes:true}).map(item=>{
      if(!item.isDirectory())throw new Error('Unexpected CI evidence entry');
      const folder=path.join(directory,item.name),report=JSON.parse(readFileSync(path.join(folder,'result.json')));
      if(!report.artifact)return {report};
      const archive=path.join(folder,path.basename(report.artifact.path));
      if(!existsSync(archive))throw new Error('Tested archive is missing');
      return {report,artifactHash:digest(readFileSync(archive)),artifactReceipt:JSON.parse(readFileSync(path.join(folder,'artifact.json')))};
    });
    const contractBytes=readFileSync(path.join(root,'scripts/verification.json')),contract=JSON.parse(contractBytes);
    const state={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDigest:sourceDigest(root),contractDigest:digest(contractBytes),runtime:process.version};
    if(!validateCiEvidence(contract,entries,state))throw new Error('CI partition evidence is incomplete, unsuccessful, stale, or altered');
    console.log(JSON.stringify({status:'passed',partitions:entries.length,...state}));
  } catch(error){console.error(error.message);process.exitCode=1;}
}
