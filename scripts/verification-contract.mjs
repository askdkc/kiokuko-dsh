// Repository-owned verification rules. CI and local execution use the same plan.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function sourceDigest(root, { nativeTransport = true } = {}) {
  const generatedNative = /^micro-judge\/(?:manifest\.json|selection\.json|(?:darwin-arm64|linux-arm64|linux-x64)\/kiokuko-micro-judge|native-acceptance-(?:darwin-arm64|linux-arm64|linux-x64)\.tap|native-verification-(?:darwin-arm64|linux-arm64|linux-x64)\.json)$/;
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))].filter(file => nativeTransport || !generatedNative.test(file)).sort();
  return digest(JSON.stringify(files.map(file => {
    try { const p=path.join(root,file),s=lstatSync(p);return [file,s.mode,s.isSymbolicLink()?readlinkSync(p):s.isFile()?digest(readFileSync(p)):'directory']; }
    catch(e) {if(e.code==='ENOENT')return [file,'missing'];throw e;}
  })));
}
export function treeDigest(root) {
  const files=[];
  function visit(dir) {for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {const p=path.join(dir,item.name);if(item.isDirectory())visit(p);else files.push([path.relative(root,p),lstatSync(p).mode&0o777,item.isSymbolicLink()?readlinkSync(p):digest(readFileSync(p))]);}}
  visit(root);return digest(JSON.stringify(files));
}
export function verificationPlan(contract, profile='full', platform=process.platform) {
  if(!contract.profiles.includes(profile))throw new Error(`Unknown verification profile: ${profile}`);
  const selected=contract.checks.filter(c=>profile==='full'||c.profiles.includes(profile));
  if(!selected.length)throw new Error('Verification profile is empty');
  const ids=new Set(selected.map(c=>c.id));
  if(ids.size!==selected.length)throw new Error('Duplicate verification check');
  for(const check of selected) {
    if(!Array.isArray(check.argv)||!check.argv.length||!check.expected)throw new Error(`No execution contract: ${check.id}`);
    for(const dep of check.dependsOn??[])if(!ids.has(dep))throw new Error(`Missing dependency ${dep}: ${check.id}`);
    if((check.platforms||check.optIn) && !check.exclusionReason)throw new Error(`Missing platform exclusion declaration: ${check.id}`);
  }
  return {schema:'verification-plan-v1',package:contract.package,profile,platform,completeScope:profile==='full',checks:selected.map(c=>({...c,status:profile==='full'&&c.optIn?'scope-excluded':c.profileExclusions?.[profile]?.platforms.includes(platform)?'scope-excluded':c.platforms&&!c.platforms.includes(platform)?'platform-excluded':'required',exclusionReason:c.profileExclusions?.[profile]?.platforms.includes(platform)?c.profileExclusions[profile].reason:c.exclusionReason}))};
}
// CI partitions change scheduling only. Validate the entire ownership map before
// selecting one lane, so a typo, duplicate or newly added unowned check fails closed.
export function partitionPlans(contract, profile, platform=process.platform) {
  const plan=verificationPlan(contract,profile,platform), declaration=contract.ciPartitions?.[profile];
  if(!declaration)throw new Error(`No CI partitions: ${profile}`);
  const {shared, splits={}, lanes}=declaration;
  if(!Array.isArray(shared)||!shared.length||new Set(shared).size!==shared.length||!lanes||!Object.keys(lanes).length)throw new Error('Empty or invalid CI partition declaration');
  const expanded=plan.checks.flatMap(check=>{
    const split=splits[check.id];
    if(!split)return [check];
    if(split.kind==='native'&&Number.isSafeInteger(split.count)&&split.count>=2) {
      if(check.argv[0]!=='node'||check.argv[1]!=='scripts/run-ci-native.mjs')throw new Error('Native shard requires the native runner');
      return Array.from({length:split.count},(_,i)=>({...check,id:`${check.id}-${i+1}`,argv:[...check.argv,'--shard',`${i+1}/${split.count}`]}));
    }
    if(split.kind==='skill-phases'&&check.argv.join(' ')==='node scripts/run-skill-delivery.mjs')return ['source','packed'].map(phase=>({...check,id:`${check.id}-${phase}`,argv:[...check.argv,'--phase',phase],packed:phase==='packed',completionEvidence:{source:phase==='source',packed:phase==='packed'}}));
    throw new Error(`Invalid CI split: ${check.id}`);
  });
  const ids=new Set(expanded.map(check=>check.id));
  if(ids.size!==expanded.length||Object.keys(splits).some(id=>!plan.checks.some(c=>c.id===id))||shared.some(id=>!ids.has(id)||splits[id]))throw new Error('Unknown or duplicate CI check');
  const ownership=Object.values(lanes).flat();
  if(Object.values(lanes).some(ids=>!Array.isArray(ids)||!ids.length)||new Set(ownership).size!==ownership.length||ownership.some(id=>!ids.has(id)||shared.includes(id))||expanded.some(check=>!shared.includes(check.id)&&!ownership.includes(check.id)))throw new Error('CI partitions must cover every check exactly once');
  return Object.entries(lanes).map(([partition,owned])=>{
    const selected=expanded.filter(check=>shared.includes(check.id)||owned.includes(check.id));
    if(selected.some(check=>(check.dependsOn??[]).some(id=>!selected.some(c=>c.id===id))))throw new Error('CI partition dependency is missing');
    return {...plan,partition,completeScope:false,checks:selected};
  });
}
export function partitionPlan(contract,profile,partition,platform=process.platform) {
  const plan=partitionPlans(contract,profile,platform).find(plan=>plan.partition===partition);
  if(!plan)throw new Error(`Unknown CI partition: ${profile}/${partition}`);
  return plan;
}
export function validateNodeResult(report, exclusions=[], platform=process.platform) {
  if(report?.schema!=='verification-node-v1'||report.complete!==true||report.summaryCount!==1||!Array.isArray(report.tests)||!report.tests.length||!Array.isArray(report.suites))return false;
  const seen=new Set();let passed=0,skipped=0,failed=0,todo=0;
  for(const event of report.tests) {
    if(!event||event.fileOnly||typeof event.skipped!=='boolean'||typeof event.todo!=='boolean'||typeof event.id!=='string'||seen.has(event.id))return false;seen.add(event.id);
    if(event.todo)todo++;else if(event.skipped){skipped++;if(!exclusions.some(rule=>rule.platforms.includes(platform)&&event.file===rule.file&&new RegExp(rule.name).test(event.name)&&rule.reason))return false;}
    else if(event.type==='test:pass')passed++;else failed++;
  }
  const counts=report.counts;
  return passed>0&&failed===0&&todo===0&&counts?.tests===report.tests.length&&counts.passed===passed&&counts.skipped===skipped&&counts.failed===0&&counts.cancelled===0&&counts.todo===0
    && report.suites.every(s=>s.type==='test:pass'&&!s.skipped&&!s.todo);
}
export function evidenceCurrent(report, state) {
  return report.status==='passed'&&report.sourceDigest===state.sourceDigest&&report.runtime===state.runtime
    && report.contractDigest===state.contractDigest&&(!report.artifact||report.artifact.hash===state.artifactHash&&report.artifact.distDigest===state.distDigest);
}
