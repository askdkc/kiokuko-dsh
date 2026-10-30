import './run-tests.test.mjs'
import './repair-catalog-selection.test.mjs'
import './prepublish.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { verificationPlan, validateNodeResult, evidenceCurrent } from './verification-contract.mjs';
const check={id:'suite',argv:['node','test.mjs'],profiles:['main'],expected:'required assertions',dependsOn:[]};
const contract={package:'fixture',profiles:['full','main'],checks:[check]};
const result=(names=['required'])=>({schema:'verification-node-v1',complete:true,summaryCount:1,counts:{tests:names.length,passed:names.length,failed:0,cancelled:0,skipped:0,todo:0},tests:names.map(name=>({id:name,name,file:'test.mjs',type:'test:pass',skipped:false,todo:false})),suites:[]});
test('the DSH runtime fixture lockfile is portable to a clean checkout',()=>{
 const fixture=new URL('../tests/fixtures/dsh-runtime/',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('package.json',fixture)));
 const lock=JSON.parse(readFileSync(new URL('package-lock.json',fixture)));
 assert.deepEqual(lock.packages[''].dependencies,manifest.dependencies);
 assert.equal(lock.packages['node_modules/@deepseek-ai/dsh']?.version,manifest.dependencies['@deepseek-ai/dsh']);
 for(const [name,entry] of Object.entries(lock.packages))if(name){
  assert.match(name,/^node_modules\//u,`fixture lockfile contains an external package path: ${name}`);
  assert.notEqual(entry.link,true,`fixture lockfile contains an external dependency link: ${name}`);
 }
});
test('the same profile has an identical plan locally and in CI',()=>{
 const local=verificationPlan(contract,'main','darwin');process.env.CI='true';try{assert.deepEqual(verificationPlan(contract,'main','darwin'),local);}finally{delete process.env.CI;}
 assert.equal(local.completeScope,false);assert.equal(verificationPlan(contract,'full','darwin').completeScope,true);
});
test('empty or unknown scopes and missing dependencies are rejected before execution',()=>{
 assert.throws(()=>verificationPlan({...contract,checks:[]},'main'),/empty/);
 assert.throws(()=>verificationPlan(contract,'fast'),/Unknown/);
 assert.throws(()=>verificationPlan({...contract,checks:[{...check,dependsOn:['missing']}]},'main'),/Missing dependency/);
});
test('zero execution, unfinished output, todo and unexpected skips are non-success',()=>{
 assert.equal(validateNodeResult(result([])),false);
 const r=result();r.tests[0].skipped=true;r.counts.passed=0;r.counts.skipped=1;assert.equal(validateNodeResult(r),false);
 r.tests[0].skipped=false;r.tests[0].todo=true;r.counts.skipped=0;r.counts.todo=1;assert.equal(validateNodeResult(r),false);
 assert.equal(validateNodeResult({...result(),complete:false}),false);
});
test('only predeclared platform-specific exclusions permit a skip',()=>{
 const r=result(['posix','required']);r.tests[0].skipped=true;r.counts.passed=1;r.counts.skipped=1;
 const rules=[{file:'test.mjs',name:'^posix$',platforms:['win32'],reason:'POSIX-only contract'}];
 assert.equal(validateNodeResult(r,rules,'win32'),true);assert.equal(validateNodeResult(r,rules,'darwin'),false);
 const p=verificationPlan({...contract,checks:[{...check,platforms:['linux'],exclusionReason:'Linux isolation contract'}]},'full','darwin');assert.equal(p.checks[0].status,'platform-excluded');
});
test('a new failure is rejected even when the aggregate failure count is unchanged',()=>{
 const a=result(['old-failure','new-failure']);a.tests[0].type='test:fail';a.counts.failed=1;a.counts.passed=1;
 const b=structuredClone(a);b.tests[0].type='test:pass';b.tests[1].type='test:fail';
 assert.equal(validateNodeResult(a),false);assert.equal(validateNodeResult(b),false);
});
test('source, runtime, verification contract, archive or built artifact changes invalidate saved success',()=>{
 const report={status:'passed',sourceDigest:'source',runtime:'node',contractDigest:'contract',artifact:{hash:'archive',distDigest:'build'}};
 const state={sourceDigest:'source',runtime:'node',contractDigest:'contract',artifactHash:'archive',distDigest:'build'};
 assert.equal(evidenceCurrent(report,state),true);
 for(const key of Object.keys(state))assert.equal(evidenceCurrent(report,{...state,[key]:'changed'}),false,key);
});
function fixture(checks, declaration = {}){
 const root=mkdtempSync(path.join(tmpdir(),'verify-contract-fixture-'));mkdirSync(path.join(root,'scripts'));
 for(const f of ['verify.mjs','verification-contract.mjs','verification-reporter.mjs','verification-test-environment.mjs','verification-completion.mjs'])cpSync(new URL(f,import.meta.url),path.join(root,'scripts',f));
 writeFileSync(path.join(root,'package.json'),'{"private":true,"type":"module"}');
 writeFileSync(path.join(root,'scripts/verification.json'),JSON.stringify({package:'fixture',profiles:['full'],checks,testExclusions:[],...declaration}));
 execFileSync('git',['init','-q'],{cwd:root});return root;
}
function execute(root){
 const output=mkdtempSync(path.join(tmpdir(),'verify-contract-results-'));
 // Each synthetic checkout owns its runtime identity, independently of the live CI host.
 const env={...process.env};
 for(const key of ['KIOKUKO_EXPECTED_DSH_SHA','KIOKUKO_DSH_RUNTIME_MODE','KIOKUKO_EXPECTED_DSH_VERSION','KIOKUKO_DSH_SOURCE_ROOT','KIOKUKO_DSH_PACKAGE_ROOT','DSH_BIN'])delete env[key];
 const child=spawnSync(process.execPath,['scripts/verify.mjs','--output',output],{cwd:root,encoding:'utf8',env});
 return {child,report:JSON.parse(readFileSync(path.join(output,'result.json')))};
}
test('the real entry reports missing required native capability as prerequisite-missing',()=>{
 const root=fixture([{...check,requires:['required-native-that-is-absent'],result:'command'}]);const {child,report}=execute(root);
 assert.equal(child.status,1);assert.equal(report.checks[0].status,'prerequisite-missing');assert.equal(report.completionReady,false);
});
function nativeFixture(checks) {
 const root=fixture(checks,{native:true,nativeScopeExclusions:[],testAliases:[]});
 const declarationPath=path.join(root,'scripts/verification.json');
 const declaration=JSON.parse(readFileSync(declarationPath));
 const packageRoot=path.join(root,'tests/fixtures/dsh-runtime/node_modules');
 declaration.environment={KIOKUKO_DSH_RUNTIME_MODE:'historical',KIOKUKO_DSH_PACKAGE_ROOT:packageRoot,DSH_BIN:path.join(packageRoot,'.bin/dsh')};
 writeFileSync(declarationPath,JSON.stringify(declaration));
 for(const file of ['run-ci-native.mjs','dsh-fixture-identity.mjs', 'stage-dsh-upstream.mjs','repeated-memory-scenarios.mjs'])cpSync(new URL(file,import.meta.url),path.join(root,'scripts',file));
 mkdirSync(path.join(root,'tests/dsh/unit'),{recursive:true});
 writeFileSync(path.join(root,'tests/dsh/unit/probe.test.ts'),'// suite discovery only\n');
 return root;
}
function selectedNativeMetadata(root) {
 const packageRoot=path.join(root,'tests/fixtures/dsh-runtime/node_modules');
 mkdirSync(path.join(packageRoot,'@deepseek-ai/dsh'),{recursive:true});
 const manifest={dependencies:{'@deepseek-ai/dsh':'test-fixture'}};
 writeFileSync(path.join(packageRoot,'..','package.json'),JSON.stringify(manifest));
 writeFileSync(path.join(packageRoot,'..','package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':manifest,'node_modules/@deepseek-ai/dsh':{version:'test-fixture'}}}));
 writeFileSync(path.join(packageRoot,'@deepseek-ai/dsh/package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'test-fixture'}));
 return packageRoot;
}
test('native-enabled verification does not import the native planner for independent or excluded checks',()=>{
 const root=fixture([{...check,argv:['node','--eval',''],result:'command'},
  {...check,id:'excluded-native',requires:['dsh-native'],optIn:true,exclusionReason:'explicit optional scope'}],{native:true});
 // No native planner or installed runtime exists in this checkout.
 const {child,report}=execute(root);
 assert.equal(child.status,0,child.stderr);assert.equal(report.checks[0].status,'passed');
 assert.equal(report.checks[1].status,'scope-excluded');assert.equal(report.completionReady,true);
});
test('required DSH fixture failures are recorded without running the native check',()=>{
 for(const capabilityKey of ['requires','testCapabilities'])for(const state of ['missing','invalid','stale','lock-mismatch','agent-loop-missing']){
  const root=nativeFixture([{...check,id:'independent',argv:['node','--eval',''],result:'command'},
   {...check,argv:['node','must-not-run.mjs'],result:'command',[capabilityKey]:['dsh-native']}]);
  if(state!=='missing'){
   const packageRoot=selectedNativeMetadata(root);
   if(state==='invalid')writeFileSync(path.join(packageRoot,'@deepseek-ai/dsh/package.json'),'{}');
   if(state==='stale')writeFileSync(path.join(packageRoot,'@deepseek-ai/dsh/package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'old-fixture'}));
   if(state==='lock-mismatch')writeFileSync(path.join(packageRoot,'..','package-lock.json'),JSON.stringify({packages:{}}));
  }
  writeFileSync(path.join(root,'must-not-run.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('executed','unexpected');");
  const {child,report}=execute(root);
  assert.equal(child.status,1,child.stderr);assert.equal(report.checks[0].status,'passed');
  assert.equal(report.checks[1].status,'prerequisite-missing',state);
  assert.deepEqual(report.checks[1][capabilityKey==='requires'?'missing':'missingTestCapabilities'],['dsh-native']);
  assert.match(report.checks[1].reason,/dsh-native.*(?:fixture|agent-loop)/i);
  if(state==='stale')assert.match(report.checks[1].reason,/node_modules is stale.*npm ci --prefix/);
  if(state==='lock-mismatch')assert.match(report.checks[1].reason,/declaration\/lock mismatch.*Reconcile/);
  if(state==='agent-loop-missing')assert.match(report.checks[1].reason,/agent-loop/);
  assert.equal(report.completionReady,false);assert.equal(existsSync(path.join(root,'executed')),false);
 }
});
test('required native checks retain the selected fixture environment and CLI path',()=>{
 for(const capabilityKey of ['requires','testCapabilities']){
  const root=nativeFixture(['first','second'].map(id=>({...check,id,argv:['node','assert-native.mjs'],result:'command',[capabilityKey]:['dsh-native']})));
  const packageRoot=selectedNativeMetadata(root);
  mkdirSync(path.join(packageRoot,'@deepseek-ai/dsh-agent-loop/lib'),{recursive:true});
  writeFileSync(path.join(packageRoot,'@deepseek-ai/dsh-agent-loop/lib/index.js'),'// capability presence only\n');
  writeFileSync(path.join(root,'assert-native.mjs'),`import assert from 'node:assert/strict';import path from 'node:path';
   const root=${JSON.stringify(packageRoot)};assert.equal(process.env.KIOKUKO_DSH_PACKAGE_ROOT,root);
   assert.equal(process.env.KIOKUKO_EXPECTED_DSH_VERSION,'test-fixture');
   for(const key of ['KIOKUKO_REQUIRE_DSH_NATIVE','KIOKUKO_REQUIRE_LISP_RUNTIME','KIOKUKO_REQUIRE_DSH_CLI'])assert.equal(process.env[key],'1');
   const searchPath=process.env.PATH.split(path.delimiter);
   assert.equal(searchPath[0],path.join(root,'.bin'));
   assert.equal(searchPath.filter(entry=>entry===path.join(root,'.bin')).length,1);
   assert.equal(process.env.DSH_BIN,path.join(root,'.bin/dsh'));`);
  const {child,report}=execute(root);
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.ok(report.checks.every(check=>check.status==='passed'));assert.equal(report.completionReady,true);
 }
});
test('the real entry rejects an exit-zero Node suite with no tests',()=>{
 const root=fixture([{...check,argv:['node','--test','empty.test.mjs'],result:'node'}]);writeFileSync(path.join(root,'empty.test.mjs'),'// no tests\n');
 const {child,report}=execute(root);assert.equal(child.status,1);assert.equal(report.checks[0].status,'failed');
});
test('fresh final archive installs and imports without optional peers; later archive or source changes revoke success',()=>{
 const root=fixture([{...check,id:'consumer',argv:['node','consumer.mjs'],result:'script',packed:true}]);
 const manifest={name:'verification-fixture',version:'1.0.0',private:true,type:'module',exports:'./dist/index.js',files:['dist'],scripts:{build:'node build.mjs'},peerDependencies:{'verification-absent-optional-peer':'1.0.0'},peerDependenciesMeta:{'verification-absent-optional-peer':{optional:true}}};
 writeFileSync(path.join(root,'package.json'),JSON.stringify(manifest));
 const definition=JSON.parse(readFileSync(path.join(root,'scripts/verification.json')));definition.package=manifest.name;writeFileSync(path.join(root,'scripts/verification.json'),JSON.stringify(definition));
 mkdirSync(path.join(root,'dist'));writeFileSync(path.join(root,'dist/index.js'),"export const result='stale';\n");
 writeFileSync(path.join(root,'build.mjs'),"import{rmSync,mkdirSync,writeFileSync}from'node:fs';rmSync('dist',{recursive:true,force:true});mkdirSync('dist');writeFileSync('dist/index.js',\"export const result='fresh';\\n\");\n");
 // Generated build output is deliberately excluded from the source fingerprint, as in the real repos.
 writeFileSync(path.join(root,'.gitignore'),'dist/\n');
 writeFileSync(path.join(root,'consumer.mjs'),`import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,existsSync}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';import{execFileSync}from'node:child_process';const dir=mkdtempSync(path.join(tmpdir(),'verification-empty-consumer-'));writeFileSync(path.join(dir,'package.json'),'{}');execFileSync(process.platform==='win32'?process.execPath:'npm',[...(process.platform==='win32'?[process.env.npm_execpath??path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')]:[]),'install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',process.env.KIOKUKO_VERIFY_TARBALL],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,npm_config_cache:path.join(dir,'cache'),npm_config_offline:'true'},stdio:'pipe'});assert.equal(existsSync(path.join(dir,'node_modules/verification-absent-optional-peer')),false);writeFileSync(path.join(dir,'check.mjs'),\"import assert from 'node:assert/strict';import{result}from'verification-fixture';assert.equal(result,'fresh');\");execFileSync(process.execPath,['check.mjs'],{cwd:dir,stdio:'pipe'});console.log('fresh installed assertion passed');const {completeVerification}=await import('./scripts/verification-completion.mjs');completeVerification({installed:true});`);
 const {child,report}=execute(root);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(report.completionReady,true);
 const output=path.dirname(report.artifact.path),saved=path.join(output,'result.json');
 const status=()=>spawnSync(process.execPath,['scripts/verify.mjs','--status',saved],{cwd:root,encoding:'utf8'});
 assert.equal(status().status,0);
 const buildSource=readFileSync(path.join(root,'build.mjs'));writeFileSync(path.join(root,'build.mjs'),"console.log('no-op build');");assert.equal(status().status,1);
 const noBuild=execute(root);assert.equal(noBuild.child.status,1,'old dist must not rescue a no-op build');assert.equal(noBuild.report.completionReady,false);
 writeFileSync(path.join(root,'build.mjs'),buildSource);
 writeFileSync(report.artifact.path,'changed archive');assert.equal(status().status,1);
});

test('arbitrary stdout, missing or wrong completion identities never satisfy a script check',()=>{
 for(const code of ["console.log('starting assertions')","import{writeFileSync}from'node:fs';writeFileSync(process.env.KIOKUKO_VERIFY_COMPLETION_FILE,JSON.stringify({schema:'verification-completion-v1',id:'other-check',nonce:process.env.KIOKUKO_VERIFY_NONCE,status:'passed',evidence:{}}));"]){
 const root=fixture([{...check,argv:['node','script.mjs'],result:'script'}]);writeFileSync(path.join(root,'script.mjs'),code);const {child,report}=execute(root);assert.equal(child.status,1);assert.equal(report.completionReady,false);}
});
test('only this invocation\'s clean unchanged build is reused for its final archive',()=>{
 for(const mutation of ['unchanged','bytes','mode']){
  const root=fixture([
   {...check,id:'build',argv:['npm','run','build'],result:'command'},
   {...check,id:'intervening',argv:['node','intervening.mjs'],dependsOn:['build'],result:'command'},
   {...check,id:'consumer',argv:['node','consumer.mjs'],dependsOn:['build'],result:'script',packed:true},
  ]);
  writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'verification-build-reuse',version:'1.0.0',type:'module',files:['dist'],scripts:{build:'node build.mjs'}}));
  const definition=JSON.parse(readFileSync(path.join(root,'scripts/verification.json')));definition.package='verification-build-reuse';writeFileSync(path.join(root,'scripts/verification.json'),JSON.stringify(definition));
  writeFileSync(path.join(root,'.gitignore'),'dist/\nbuild-count\n');
  mkdirSync(path.join(root,'dist'));writeFileSync(path.join(root,'dist/stale.js'),'old');
  writeFileSync(path.join(root,'build.mjs'),"import{mkdirSync,writeFileSync,readFileSync,existsSync}from'node:fs';import assert from'node:assert/strict';assert.equal(existsSync('dist/stale.js'),false);const count=existsSync('build-count')?Number(readFileSync('build-count')):0;mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','fresh');writeFileSync('build-count',String(count+1));");
  writeFileSync(path.join(root,'intervening.mjs'),mutation==='bytes'?"import{writeFileSync}from'node:fs';writeFileSync('dist/index.js','changed');":mutation==='mode'?"import{chmodSync}from'node:fs';chmodSync('dist/index.js',0o755);":'');
  writeFileSync(path.join(root,'consumer.mjs'),"import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{completeVerification}from'./scripts/verification-completion.mjs';assert.equal(readFileSync('dist/index.js','utf8'),'fresh');completeVerification({});");
  const {child,report}=execute(root);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(report.status,'passed');
  assert.equal(Number(readFileSync(path.join(root,'build-count'))),mutation==='unchanged'?1:2,mutation);
 }
});
test('a missing terminal result or progress array is incomplete, never successful',()=>{
 const root=fixture([check]);const file=path.join(tmpdir(),'verification-progress-'+Date.now()+'.json');writeFileSync(file,JSON.stringify([{id:'suite',status:'passed'}]));
 const r=spawnSync(process.execPath,['scripts/verify.mjs','--status',file],{cwd:root,encoding:'utf8'});assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).status,'incomplete');
});

test('completion schema, identity, nonce and evidence are independently required',async()=>{
 const {validCompletion}=await import('./verification-completion.mjs');const good={schema:'verification-completion-v1',id:'suite',nonce:'fresh',status:'passed',evidence:{installed:true}};
 assert.equal(validCompletion(good,'suite','fresh',{installed:true}),true);
 for(const change of [{schema:'other'},{id:'other'},{nonce:'old'},{status:'running'},{evidence:[]},{evidence:{installed:false}}])assert.equal(validCompletion({...good,...change},'suite','fresh',{installed:true}),false);
});
test('SIGTERM preserves an interrupted terminal result with no completion success',async()=>{
 const root=fixture([{...check,argv:['node','waiting.mjs'],result:'script'}]);writeFileSync(path.join(root,'waiting.mjs'),"console.log('waiting');setInterval(()=>{},1000)");
 const output=mkdtempSync(path.join(tmpdir(),'verify-interrupt-'));const child=(await import('node:child_process')).spawn(process.execPath,['scripts/verify.mjs','--output',output],{cwd:root,stdio:['ignore','pipe','pipe']});
 let stdout='';const completed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('waiting'))child.kill('SIGTERM');});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 await completed;clearTimeout(timer);const report=JSON.parse(readFileSync(path.join(output,'result.json')));assert.equal(report.status,'interrupted');assert.equal(report.completionReady,false);
});

 test('missing required test capability stops the suite before any test process runs',()=>{
  const root=fixture([{...check,argv:['node','must-not-run.mjs'],testCapabilities:['verification-fixture-absent-tool'],result:'script'}]);
  writeFileSync(path.join(root,'must-not-run.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('executed','unexpected');");
  const {child,report}=execute(root);assert.equal(child.status,1);assert.equal(report.checks[0].status,'prerequisite-missing');assert.equal(existsSync(path.join(root,'executed')),false);
 });
 test('evidence from another platform or architecture cannot certify this consumer',()=>{
  const root=fixture([{...check,argv:['node','script.mjs'],result:'script'}]);writeFileSync(path.join(root,'script.mjs'),"import{completeVerification}from'./scripts/verification-completion.mjs';completeVerification({assertions:true});");
  const {child,report}=execute(root);assert.equal(child.status,0);
  const file=path.join(mkdtempSync(path.join(tmpdir(),'verification-platform-')),'result.json');
  writeFileSync(file,JSON.stringify(report));assert.equal(spawnSync(process.execPath,['scripts/verify.mjs','--status',file],{cwd:root,encoding:'utf8'}).status,0);
  for(const change of [{platform:'foreign-platform'},{architecture:'foreign-architecture'}]){
   writeFileSync(file,JSON.stringify({...report,...change}));const observed=spawnSync(process.execPath,['scripts/verify.mjs','--status',file],{cwd:root,encoding:'utf8'});assert.equal(observed.status,1);assert.equal(JSON.parse(observed.stdout).completionReady,false);
  }
 });

test('the actual Python capability delegates FD4, terminal errors and cleanup to the production supervisor',()=>{
 for(const kind of ['passed','nonzero','missing-command','missing-filter','output-limit']){
  const root=mkdtempSync(path.join(tmpdir(),'verification-filter-fixture-'));mkdirSync(path.join(root,'scripts'));mkdirSync(path.join(root,'lisp'));mkdirSync(path.join(root,'dist/dsh/lisp'),{recursive:true});
  writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  cpSync(new URL('verify-protected-python-capability.mjs',import.meta.url),path.join(root,'scripts/probe.mjs'));
  for(const file of ['supervisor.mjs','repository-owner.mjs','process-identity.mjs'])
   cpSync(new URL('../lisp/'+file,import.meta.url),path.join(root,'lisp',file));
  const expected='exact seccomp fixture bytes';
  const childCode="const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync(4,'utf8'),"+JSON.stringify(expected)+");"+(kind==='nonzero'?"process.exit(7)":kind==='output-limit'?"process.stdout.write('x'.repeat(32768))":"console.log('protected-python:3')");
  writeFileSync(path.join(root,'dist/dsh/lisp/sandbox.js'),`
import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
export async function prepareLayout(base,library){await mkdir(path.join(base,'scratch'));await writeFile(${JSON.stringify(path.join(root,'layout.txt'))},base);return {base,library,scratch:path.join(base,'scratch')};}
export async function sandboxLaunch(layout){assert.equal(layout.protected,true);const filter=path.join(layout.base,'filter');${kind==='missing-filter'?'':`await writeFile(filter,${JSON.stringify(expected)});`}
 return {command:${JSON.stringify(kind==='missing-command'?path.join(root,'absent'):process.execPath)},args:['--eval',${JSON.stringify(childCode)}],cwd:layout.scratch,env:{},seccompPath:filter};}
`);
  const observed=spawnSync(process.execPath,['scripts/probe.mjs'],{cwd:root,encoding:'utf8',timeout:20000});
  if(kind==='passed'){assert.equal(observed.status,0,observed.stderr);assert.equal(observed.stdout.trim(),'protected-python:3');}
  else assert.equal(observed.status,1,kind+' must remain non-success');
  const layout=readFileSync(path.join(root,'layout.txt'),'utf8');assert.equal(existsSync(layout),false,kind+' must remove its layout only after terminal child completion');
 }
});

test('CI main source partition has exact coverage union and a single Linux owner per omitted file', async () => {
  const { nativeCiPlan } = await import('./run-ci-native.mjs');
  // Partition coverage is a source plan contract, not an installed-runtime check.
  const packageRoot = selectedNativeMetadata(mkdtempSync(path.join(tmpdir(),'verification-native-plan-')));
  const environment = { KIOKUKO_DSH_PACKAGE_ROOT: packageRoot, KIOKUKO_DSH_RUNTIME_MODE: 'historical' };
  const actual = JSON.parse(readFileSync(new URL('./verification.json', import.meta.url)));
  const lisp = nativeCiPlan('lisp', environment).args.slice(1);
  const owned = actual.checks.find(check => check.id === 'owned-native').argv.slice(2);
  const modules = actual.checks.find(check => check.id === 'modules').sourceFiles;
  const skills = actual.checks.find(check => check.id === 'skill-delivery').sourceFiles;
  const owners = [...lisp, ...owned, ...modules, ...skills];
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.scripts['test:modules'], `node scripts/run-tests.mjs ${modules.join(' ')} && node scripts/verify-module-packages.mjs`);
  const skillRunner = readFileSync(new URL('./run-skill-delivery.mjs', import.meta.url), 'utf8');
  for (const file of skills) assert.ok(skillRunner.includes(`'${file}'`), 'the Skill owner must execute ' + file);
  assert.equal(new Set(owners).size, owners.length, 'source ownership must be disjoint');
  const original = [], partitioned = [];
  for (const suite of ['unit', 'integration', 'e2e']) {
    const full = nativeCiPlan(suite, environment), ci = nativeCiPlan('ci-' + suite, environment);
    original.push(...full.args.slice(1)); partitioned.push(...ci.args.slice(1));
    assert.ok(ci.args.length > 1, 'partition must not become empty');
    assert.ok(ci.args.slice(1).every(file => full.args.includes(file)), 'no invented tests');
    assert.equal(ci.env.KIOKUKO_TEST_CONCURRENCY, full.args.some(file => file.includes('/lisp/')) ? '2' : '4');
    assert.equal(nativeCiPlan('ci-' + suite, { ...environment, KIOKUKO_TEST_CONCURRENCY: '1' }).env.KIOKUKO_TEST_CONCURRENCY, '1');
    for (const key of ['KIOKUKO_DSH_PACKAGE_ROOT', 'KIOKUKO_EXPECTED_DSH_VERSION', 'KIOKUKO_REQUIRE_DSH_NATIVE'])
      assert.equal(ci.env[key], full.env[key], key + ' must retain the same fixture');
  }
  const omitted = original.filter(file => !partitioned.includes(file));
  assert.deepEqual([...omitted].sort(), [...owners].sort());
  assert.deepEqual([...new Set([...partitioned, ...owners])].sort(), [...new Set(original)].sort());
  assert.equal(new Set([...partitioned, ...owners]).size, partitioned.length + owners.length);
});

test('CI-only profile preserves all main checks through Linux ownership and leaves local main/full complete', () => {
  const actual = JSON.parse(readFileSync(new URL('./verification.json', import.meta.url)));
  const main = verificationPlan(actual, 'main', 'linux').checks;
  const ci = verificationPlan(actual, 'ci-main', 'linux').checks;
  const lisp = verificationPlan(actual, 'lisp', 'linux').checks;
  const canonical = check => check.id.startsWith('ci-native-') ? check.id.slice(3) : check.id;
  const removed = main.filter(check => !ci.some(candidate => canonical(candidate) === check.id));
  assert.deepEqual(removed.map(check => check.id).sort(), ['pack-check', 'skill-delivery']);
  for (const check of removed) {
    const owner = lisp.find(candidate => candidate.id === check.id);
    assert.equal(owner.status, 'required');
    assert.deepEqual(owner.argv, check.argv);
    assert.deepEqual(owner.env, check.env);
    assert.equal(owner.packed, true, 'installed/source variants stay under the original script');
  }
  assert.deepEqual([...new Set([...ci.map(canonical), ...removed.map(check => check.id)])].sort(), main.map(check => check.id).sort());
  for (const suite of ['unit', 'integration', 'e2e']) {
    const original = main.find(check => check.id === 'native-' + suite);
    const replacement = ci.find(check => check.id === 'ci-native-' + suite);
    assert.equal(original.argv.at(-1), suite);
    assert.equal(replacement.argv.at(-1), 'ci-' + suite);
    for (const key of ['requires', 'result', 'expected', 'dependsOn', 'env'])
      assert.deepEqual(replacement[key], original[key], suite + ': ' + key);
  }
  for (const platform of ['linux', 'darwin']) {
    const full = verificationPlan(actual, 'full', platform);
    for (const check of main) assert.equal(full.checks.find(candidate => candidate.id === check.id).status, 'required');
    for (const check of ci.filter(check => check.id.startsWith('ci-native-')))
      assert.equal(full.checks.find(candidate => candidate.id === check.id).status, 'scope-excluded');
    const protection = verificationPlan(actual, 'lisp', platform);
    for (const id of ['lisp-native', 'owned-native', 'modules', 'pack-check', 'skill-delivery'])
      assert.equal(protection.checks.find(check => check.id === id).status, 'required');
  }
});

test('CI workflow schedules the explicit selected plan and retains blocking full coverage', async () => {
  const {requiredJobs}=await import('./verify-ci-results.mjs');
  const {createCiPlan}=await import('./ci-plan.mjs');
  const actual=JSON.parse(readFileSync(new URL('./verification.json',import.meta.url)));
  const text=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const workflow=createRequire(import.meta.url)('yaml').parse(text),jobs=workflow.jobs;
  assert.deepEqual(Object.keys(jobs),['select','micro-judge-native','checks','verify']);
  assert.ok(jobs.select.steps.some(s=>s.run?.includes('scripts/ci-plan.mjs')));
  assert.ok(jobs.select.steps.some(s=>s.with?.['fetch-depth']===0));
  assert.equal(jobs['micro-judge-native'].strategy.matrix.include,'${{ fromJSON(needs.select.outputs.native) }}');
  assert.equal(jobs.checks.strategy.matrix.include,'${{ fromJSON(needs.select.outputs.lanes) }}');
  assert.equal(jobs.checks['runs-on'],'${{ matrix.runner }}');assert.equal(jobs.checks['timeout-minutes'],'${{ matrix.timeout }}');
  for(const job of [jobs.checks,jobs['micro-judge-native']]){assert.equal(job['continue-on-error'],undefined);assert.equal(job.strategy['fail-fast'],false)}
  assert.ok(jobs.checks.if.includes('always()'));assert.ok(jobs.checks.if.includes("needs.select.result == 'success'"));assert.ok(jobs.checks.if.includes("needs.micro-judge-native.result == 'success'"));
  assert.ok(jobs.checks.steps.some(s=>s.run?.includes('scripts/verify.mjs --ci-plan')&&s.run.includes('--lane')));
  const prep=jobs.checks.steps.find(s=>s.run==='npm ci --prefix tests/fixtures/dsh-runtime');assert.ok(prep);assert.equal(prep.if,'matrix.fixture');
  assert.doesNotMatch(text,/--legacy-peer-deps|--force|--package-lock=false|npm install.*fixtures/);
  const fixture=JSON.parse(readFileSync(new URL('../tests/fixtures/dsh-runtime/package.json',import.meta.url))),lock=JSON.parse(readFileSync(new URL('../tests/fixtures/dsh-runtime/package-lock.json',import.meta.url)));
  assert.ok(fixture.dependencies['@deepseek-ai/dsh']);
  assert.deepEqual(lock.packages[''].dependencies,fixture.dependencies);assert.equal(lock.packages['node_modules/@askdkc/dsh-cli'].version,'0.14.11');assert.ok(lock.packages['node_modules/@deepseek-ai/cordis-plugin-group'].version);
  assert.equal(jobs.select.steps.find(s=>s.id==='dsh').run,'node scripts/resolve-dsh-upstream.mjs');
  const checkout=jobs.checks.steps.find(s=>s.with?.repository==='deepseek-ai/deepseek-harness');
  assert.equal(checkout.with.ref,'${{ needs.select.outputs.dsh_sha }}');
  const upstreamBuild=jobs.checks.steps.find(s=>s.name==='Build current official DSH from its frozen dependency graph');
  assert.match(upstreamBuild.run,/pnpm install --frozen-lockfile/);assert.match(upstreamBuild.run,/pnpm run build:artifacts/);
  assert.ok(jobs.checks.steps.some(s=>s.run?.includes('scripts/stage-dsh-upstream.mjs')));
  assert.equal(jobs.checks.steps.find(s=>s.run?.includes('scripts/verify.mjs --ci-plan')).env.KIOKUKO_EXPECTED_DSH_SHA,'${{ needs.select.outputs.dsh_sha }}');
  const cli=actual.checks.find(c=>c.id==='dsh-cli-profile');assert.equal(cli.argv[1],'scripts/verify-cli-profile.mjs');assert.equal(cli.argv.at(-1),'source');
  assert.deepEqual(cli.completionEvidence,{profile:'dsh-cli',interactive:true,cliVersion:'0.14.11',sourceEntry:true});
  assert.ok(actual.checks.find(c=>c.id==='verification-contract').profiles.includes('semantic'));
  const complete=createCiPlan(actual,{full:true},{});assert.equal(complete.jobCount,27);assert.equal(complete.lanes.length,22);
  const ordinary=createCiPlan(actual,{available:true,changes:[{status:'M',path:'src/dsh/task-state.ts'}]},{});assert.equal(ordinary.jobCount,5);assert.equal(ordinary.lanes.length,2);
  const aggregate=jobs.verify;assert.deepEqual(aggregate.needs,requiredJobs);assert.equal(aggregate.if,'always()');
  const gate=aggregate.steps.find(s=>s.run?.includes('scripts/verify-ci-results.mjs'));assert.equal(gate.env.NEEDS_JSON,'${{ toJSON(needs) }}');assert.ok(gate.run.includes('--ci-plan'));
  assert.ok(aggregate.steps.some(s=>s.with?.pattern==='verification-ci-*'));assert.ok(aggregate.steps.some(s=>s.run?.includes('merge-micro-judge-artifacts.mjs')&&s.run.includes('--ci-plan')));
  const candidate=jobs.checks.steps.find(s=>s.with?.name==='multi-platform-package-${{ github.sha }}');assert.equal(candidate.if,"needs.select.outputs.full == 'true' && matrix.release");assert.equal(candidate.with.path,'${{ runner.temp }}/verification/*.tgz');
  assert.ok(!jobs.checks.steps.some(s=>s.run?.includes('npm pack')),'release review uses the already tested complete archive');
});

await import('./ci-partitions.test.mjs');
await import('./stage-dsh-upstream.test.mjs');

test('request-intent evaluation covers exact change scopes and writes a check-bound completion receipt', async () => {
  const { validCompletion } = await import('./verification-completion.mjs');
  const directory = mkdtempSync(path.join(tmpdir(), 'intent-evaluation-contract-'));
  const completion = path.join(directory, 'completion.json');
  const observed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-request-intent-evaluation.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, KIOKUKO_VERIFY_COMPLETION_FILE: completion,
      KIOKUKO_VERIFY_CHECK_ID: 'intent-evaluation', KIOKUKO_VERIFY_NONCE: 'intent-evaluation-regression' },
  });
  assert.equal(observed.status, 0, observed.stdout + '\n' + observed.stderr);
  const report = JSON.parse(observed.stdout);
  assert.equal(report.mode, 'fixture-oracle');
  assert.equal(report.attempted, 12);
  assert.equal(report.correct, 12);
  const implementation = new Set(['ja-proposal', 'ja-noun', 'en-continue', 'en-scope']);
  for (const row of report.rows) {
    assert.equal(row.correct, true, row.id);
    assert.equal(row.changeScope, implementation.has(row.id) ? 'implementation' : 'unknown', row.id);
    assert.ok(!row.unresolvedReason?.startsWith('DECISION_'), row.id);
  }
  assert.equal(validCompletion(JSON.parse(readFileSync(completion, 'utf8')),
    'intent-evaluation', 'intent-evaluation-regression'), true);
});

// Keep safe failure observations in the ordinary verification contract lane.
await import('./verification-diagnostics.test.mjs');


test('SIGTERM forwards through a cooperating runner to its detached test group', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, async () => {
 const root=fixture([{...check,argv:['node','bridge.mjs'],result:'script'}]);
 writeFileSync(path.join(root,'.gitignore'),'leaf-pid\nleaf-exited\n');
 writeFileSync(path.join(root,'leaf.mjs'),"import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{writeFileSync('leaf-exited','stopped');process.exit(0)});console.log('leaf-ready');setInterval(()=>{},1000)");
 writeFileSync(path.join(root,'bridge.mjs'),"import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const leaf=spawn(process.execPath,['leaf.mjs'],{detached:true,stdio:['ignore','inherit','inherit']});writeFileSync('leaf-pid',String(leaf.pid));process.on('SIGTERM',()=>{try{process.kill(-leaf.pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}});leaf.on('exit',()=>process.exit(1));");
 const output=mkdtempSync(path.join(tmpdir(),'verify-nested-interrupt-'));
 const child=(await import('node:child_process')).spawn(process.execPath,['scripts/verify.mjs','--output',output],{cwd:root,stdio:['ignore','pipe','pipe']});
 let stdout='',signalled=false,timer;const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});child.stderr.resume();
 child.stdout.on('data',chunk=>{stdout+=chunk;if(!signalled&&stdout.includes('leaf-ready')){signalled=true;child.kill('SIGTERM')}});
 try {
  await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('verifier did not drain its detached test group')),3000)})]);
  assert.equal(readFileSync(path.join(root,'leaf-exited'),'utf8'),'stopped','graceful forwarding must reach the detached child');
  const report=JSON.parse(readFileSync(path.join(output,'result.json')));assert.equal(report.status,'interrupted');assert.equal(report.completionReady,false);
 } finally {
  clearTimeout(timer);child.kill('SIGKILL');
  if(existsSync(path.join(root,'leaf-pid')))try{process.kill(-Number(readFileSync(path.join(root,'leaf-pid'),'utf8')),'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
  await closed;
 }
});

test('SIGTERM terminates a non-cooperating check with an interrupted result', async () => {
 const root=fixture([{...check,argv:['node','stubborn.mjs'],result:'script'}]);
 writeFileSync(path.join(root,'.gitignore'),'check-pid\n');
 writeFileSync(path.join(root,'stubborn.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('check-pid',String(process.pid));process.on('SIGTERM',()=>{});console.log('stubborn-ready');setInterval(()=>{},1000)");
 const output=mkdtempSync(path.join(tmpdir(),'verify-stubborn-interrupt-'));
 const child=(await import('node:child_process')).spawn(process.execPath,['scripts/verify.mjs','--output',output],{cwd:root,stdio:['ignore','pipe','pipe']});
 let stdout='',signalled=false,timer;const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});child.stderr.resume();
 child.stdout.on('data',chunk=>{stdout+=chunk;if(!signalled&&stdout.includes('stubborn-ready')){signalled=true;child.kill('SIGTERM')}});
 try {
  await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('verifier did not escalate its stubborn check')),12000)})]);
  const report=JSON.parse(readFileSync(path.join(output,'result.json')));assert.equal(report.status,'interrupted');assert.equal(report.completionReady,false);assert.equal(report.checks[0].signal,process.platform==='win32'?'SIGTERM':'SIGKILL');
 } finally {
  clearTimeout(timer);child.kill('SIGKILL');
  if(existsSync(path.join(root,'check-pid')))try{const pid=Number(readFileSync(path.join(root,'check-pid'),'utf8'));if(process.platform==='win32')process.kill(pid,'SIGKILL');else process.kill(-pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
  await closed;
 }
});


test('SIGTERM never stops an unrelated process', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, async () => {
 const root=fixture([{...check,argv:['node','waiting.mjs'],result:'script'}]);
 writeFileSync(path.join(root,'waiting.mjs'),"console.log('check-ready');setInterval(()=>{},1000)");
 writeFileSync(path.join(root,'bystander.mjs'),"process.on('SIGTERM',()=>console.log('BYSTANDER_SIGNAL'));process.stdin.on('data',()=>console.log('PONG'));process.stdin.on('end',()=>process.exit(0));console.log('BYSTANDER_READY')");
 const {spawn}=await import('node:child_process');
 // This separate group is owned by this test, not by the verifier. It stands
 // in for an unrelated user process without touching any real user process.
 const bystander=spawn(process.execPath,['bystander.mjs'],{cwd:root,detached:true,stdio:['pipe','pipe','pipe']});
 const bystanderClosed=new Promise(resolve=>bystander.once('close',resolve));let bystanderText='';bystander.stderr.resume();bystander.stdout.on('data',chunk=>{bystanderText+=chunk});
 const observe=token=>new Promise((resolve,reject)=>{let timer;const check=()=>{if(bystanderText.includes(token)){clearTimeout(timer);bystander.stdout.off('data',check);resolve()}};timer=setTimeout(()=>{bystander.stdout.off('data',check);reject(new Error('bystander did not respond'))},2000);bystander.stdout.on('data',check);check()});
 let child,closed,timer;
 try {
  await observe('BYSTANDER_READY');
  const output=mkdtempSync(path.join(tmpdir(),'verify-owned-interrupt-'));
  child=spawn(process.execPath,['scripts/verify.mjs','--output',output],{cwd:root,stdio:['ignore','pipe','pipe']});
  let stdout='',signalled=false;closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});child.stderr.resume();
  child.stdout.on('data',chunk=>{stdout+=chunk;if(!signalled&&stdout.includes('check-ready')){signalled=true;child.kill('SIGTERM')}});
  await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned verifier did not stop')),3000)})]);
  const report=JSON.parse(readFileSync(path.join(output,'result.json')));assert.equal(report.status,'interrupted');assert.equal(report.completionReady,false);
  assert.equal(bystander.exitCode,null);assert.equal(bystander.signalCode,null);
  bystander.stdin.write('ping\n');await observe('PONG');
  assert.equal(bystanderText.includes('BYSTANDER_SIGNAL'),false,'verifier cancellation must not signal a different process group');
 } finally {
  clearTimeout(timer);child?.kill('SIGKILL');if(closed)await closed;
  bystander.stdin.end();const cleanup=setTimeout(()=>bystander.kill('SIGKILL'),1000);await bystanderClosed;clearTimeout(cleanup);
 }
});


test('prepare reproducibility installs its build dependencies even under NODE_ENV production', async () => {
 const require=createRequire(import.meta.url),ts=require('typescript');
 const source=readFileSync(new URL('./verify-prepare-reproducibility.mjs',import.meta.url),'utf8');
 const parsed=ts.createSourceFile('prepare.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const functions=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='buildOnce');assert.equal(functions.length,1);
 const calls=[],copies=[],workspace=path.join(tmpdir(),'prepare-build-contract'),userConfig=path.join(workspace,'npmrc');
 const exec=async(command,args,options)=>{
  calls.push({command,args,options});assert.equal(command,'npm');assert.ok(options.cwd.startsWith(workspace+path.sep));
  assert.equal(options.env.NODE_ENV,'production','retain the requested production build mode');
  if(args[0]==='ci'){
   assert.ok(args.includes('--include=dev'),'a source build needs its declared dev dependencies even when npm defaults to omitting them');
   assert.ok(args.includes('--include=optional'));assert.ok(args.includes('--ignore-scripts'));
  }
  assert.equal(options.env.npm_config_userconfig,userConfig);assert.equal(options.env.NPM_CONFIG_USERCONFIG,userConfig);
  assert.equal(options.env.npm_config_allow_scripts,undefined);assert.equal(options.env.NPM_CONFIG_ALLOW_SCRIPTS,undefined);
  return {stdout:'',stderr:''};
 };
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const execute=new AsyncFunction('workspace','join','copySource','exec','process','digestDirectory','userConfig',functions[0].getText(parsed)+';return [await buildOnce(1),await buildOnce(2)];');
 const builds=await execute(workspace,path.join,async target=>copies.push(target),exec,{env:{NODE_ENV:'production',npm_config_omit:'dev',npm_config_allow_scripts:'fixture',NPM_CONFIG_ALLOW_SCRIPTS:'fixture'}},async()=>({hash:'same',fileCount:1,bytes:1}),userConfig);
 assert.equal(copies.length,2);assert.notEqual(copies[0],copies[1]);assert.deepEqual(calls.map(call=>call.args[0]),['ci','run','ci','run']);
 assert.notEqual(calls[0].options.env.npm_config_cache,calls[2].options.env.npm_config_cache,'each reproducibility build owns its cache');
 assert.deepEqual(builds[0].digest,builds[1].digest);
});

import './code-intelligence-host.test.mjs';
