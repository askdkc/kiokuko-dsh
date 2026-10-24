import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { stageDshUpstream, upstreamRepository } from './stage-dsh-upstream.mjs'
import { selectedDshRuntime, dshRuntimeMode } from './dsh-fixture-identity.mjs'
import { parseUpstreamResolution, upstreamRef } from './resolve-dsh-upstream.mjs'
import { selectedCodeHost, stageCodeHost, assertCodeHost, assertCodeConsumerHost, codeProfileHostDependencies, codeRuntimeEnvironment } from './code-intelligence-host.mjs'
const source = file => readFileSync(new URL(file, import.meta.url), 'utf8')

test('official resolution accepts only one full master SHA, not a tag or release label', () => {
 const sha='a'.repeat(40)
 assert.equal(parseUpstreamResolution(`${sha}\t${upstreamRef}\n`),sha)
 for(const value of ['',`master\t${upstreamRef}`,`${sha}\trefs/tags/v1`,`${sha}\t${upstreamRef}\n${sha}\t${upstreamRef}`,`${sha}\t${upstreamRef}\textra`])assert.throws(()=>parseUpstreamResolution(value))
})
function assertOptionalWorkflow(workflow) {
 const jobs=workflow.jobs
 assert.equal(jobs.select.steps.find(step=>step.id==='dsh').run,'node scripts/resolve-dsh-upstream.mjs')
 assert.equal(jobs.select.outputs.dsh_sha,'${{ steps.dsh.outputs.sha }}')
 for(const name of ['macos','linux']){
  const job=jobs[name],steps=job.steps
  assert.equal(job.needs,'select');assert.equal(job.env.KIOKUKO_EXPECTED_DSH_SHA,'${{ needs.select.outputs.dsh_sha }}')
  const checkout=steps.find(step=>step.with?.repository==='deepseek-ai/deepseek-harness')
  assert.equal(checkout.with.ref,'${{ needs.select.outputs.dsh_sha }}')
  assert.equal(checkout.with['persist-credentials'],false)
  assert.ok(steps.some(step=>step.with?.package_json_file==='.artifacts/official-dsh/package.json'))
  assert.ok(steps.some(step=>step.run?.includes('pnpm install --frozen-lockfile')&&step.run.includes('pnpm run build:artifacts')))
  const stage=steps.findIndex(step=>step.run?.startsWith('node scripts/stage-dsh-upstream.mjs'))
  assert.ok(stage>=0);assert.ok(steps[stage].run.includes('"${{ needs.select.outputs.dsh_sha }}" .'))
  assert.ok(stage<steps.findIndex(step=>step.run==='node scripts/prepare-code-provider.mjs'))
  const evidence=steps.find(step=>step.uses?.startsWith('actions/upload-artifact'))
  assert.equal(evidence.if,'always()');assert.equal(evidence.with['include-hidden-files'],true);assert.ok(evidence.with.path.includes('.kiokuko-dsh-upstream.json'))
 }
}
test('both workflows share current-master resolution; optional source and packed lanes stage exact SHA', () => {
 const parse=createRequire(import.meta.url)('yaml').parse
 const workflow=parse(source('../.github/workflows/code-intelligence.yml'))
 assertOptionalWorkflow(workflow)
 assert.equal(parse(source('../.github/workflows/ci.yml')).jobs.select.steps.find(step=>step.id==='dsh').run,'node scripts/resolve-dsh-upstream.mjs')
 const mutated=structuredClone(workflow)
 mutated.jobs.linux.steps=mutated.jobs.linux.steps.filter(step=>!step.run?.startsWith('node scripts/stage-dsh-upstream.mjs'))
 assert.throws(()=>assertOptionalWorkflow(mutated),'a historical-only lane must fail the config regression')
})
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'code-host-')),official=join(base,'official'),root=join(base,'project'),runtime=join(root,'tests/fixtures/dsh-runtime')
 mkdirSync(official,{recursive:true});mkdirSync(runtime,{recursive:true});writeFileSync(join(root,'package.json'),'{}')
 const git=(...args)=>execFileSync('git',['-C',official,...args],{encoding:'utf8'}).trim()
 git('init','-q');git('remote','add','origin',upstreamRepository)
 writeFileSync(join(official,'package.json'),JSON.stringify({workspaces:['apps/*','packages/*']}));writeFileSync(join(official,'.gitignore'),'lib/\n')
 for(const name of ['dsh','cordis','dsh-tools','dsh-agent-loop','dsh-session','dsh-llm']){
  const directory=join(official,name==='dsh'?'apps/cli':`packages/${name}`)
  mkdirSync(join(directory,'lib'),{recursive:true});writeFileSync(join(directory,'package.json'),JSON.stringify({name:`@deepseek-ai/${name}`,version:'unpublished-head',main:'lib/index.js'}))
  writeFileSync(join(directory,'lib/index.js'),'// synthetic compiled module\n');if(name==='dsh')writeFileSync(join(directory,'lib/bin.js'),'// synthetic CLI\n')
 }
 git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','test fixture')
 const sha=git('rev-parse','HEAD');stageDshUpstream(official,runtime,sha,root)
 return{base,official,root,runtime,sha,env:{KIOKUKO_EXPECTED_DSH_SHA:sha},close(){rmSync(base,{recursive:true,force:true})}}
}
test('provider, packed profile and nested consumers resolve the exact selected source and reject mixed graphs', () => {
 const f=fixture()
 try{
  const selected=selectedCodeHost(f.root,f.env)
  assert.equal(selected.sha,f.sha)
  const provider=join(f.root,'.artifacts/code-intelligence/dsh-lsp-server'),profile=join(f.root,'.artifacts/code-intelligence/profile')
  for(const directory of [provider,profile,join(profile,'node_modules/kiokuko-dsh'),join(profile,'node_modules/@askdkc/dsh-lsp-server')]){
   mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'package.json'),'{}');stageCodeHost(directory,selected);assertCodeConsumerHost(directory,selected)
   assert.equal(realpathSync(join(directory,'node_modules/@deepseek-ai/dsh-tools')),realpathSync(join(f.official,'packages/dsh-tools')))
  }
  assert.throws(()=>selectedCodeHost(f.root,{KIOKUKO_EXPECTED_DSH_SHA:'b'.repeat(40)}),/exact official DSH SHA/)
  assert.throws(()=>selectedCodeHost(f.root,{...f.env,KIOKUKO_DSH_PACKAGE_ROOT:join(provider,'node_modules')}),/development graph/)
  assert.throws(()=>assertCodeHost(profile,{...selected,sha:'b'.repeat(40)}),/SHA differs/)
  const target=join(provider,'node_modules/@deepseek-ai/dsh-tools');rmSync(target);symlinkSync(join(f.official,'packages/dsh-llm'),target,'dir')
  assert.throws(()=>assertCodeConsumerHost(provider,selected),/mapping is stale/)
 }finally{f.close()}
})
test('current packed installation never substitutes registry versions; historical identities remain explicit', () => {
 const versions={'@deepseek-ai/dsh':'same-release-label','@deepseek-ai/cordis':'old-label'}
 assert.deepEqual(codeProfileHostDependencies(versions,{sha:'a'.repeat(40)}),{})
 assert.deepEqual(codeProfileHostDependencies(versions,undefined),versions)
 const f=fixture();try{rmSync(join(f.runtime,'node_modules/.kiokuko-dsh-upstream.json'));assert.throws(()=>selectedCodeHost(f.root,f.env),/staged official SHA/)}finally{f.close()}
})
test('native optional runner retains selected source graph or validated packed graph, never historical CLI injection', () => {
 const root=resolve('/fixture'),selected={sha:'a'.repeat(40)},env={KIOKUKO_DSH_PACKAGE_ROOT:'/selected/node_modules',KIOKUKO_CODE_CLI_HOST:'1'}
 const sourceEnv=codeRuntimeEnvironment(root,false,selected,env),packedEnv=codeRuntimeEnvironment(root,true,selected,env)
 assert.equal(sourceEnv.KIOKUKO_DSH_PACKAGE_ROOT,env.KIOKUKO_DSH_PACKAGE_ROOT)
 assert.equal(packedEnv.KIOKUKO_DSH_PACKAGE_ROOT,join(root,'.artifacts/code-intelligence/profile/node_modules'))
 for(const value of [sourceEnv,packedEnv]){assert.equal(value.KIOKUKO_EXPECTED_DSH_SHA,selected.sha);assert.equal(value.KIOKUKO_CODE_CLI_HOST,undefined)}
 assert.equal(codeRuntimeEnvironment(root,true,undefined,{KIOKUKO_DSH_RUNTIME_MODE:'historical'}).KIOKUKO_CODE_CLI_HOST,'1')
})
test('provider preparation, execution, packed install and benchmark all wire current graph checks', () => {
 assert.match(source('prepare-code-provider.mjs'),/stageCodeHost\(directory,selected\)/)
 assert.match(source('run-code-intelligence.mjs'),/codeRuntimeEnvironment\(root,packed,selected\)/)
 assert.match(source('run-code-intelligence.mjs'),/assertCodeHost\(resolve\(nativeEnvironment.KIOKUKO_DSH_PACKAGE_ROOT,'\.\.'\),selected\)/)
 const installer=source('install-code-profile.mjs')
 assert.match(installer,/codeProfileHostDependencies\(installedVersions,selected\)/)
 assert.match(installer,/node_modules\/@askdkc\/dsh-lsp-server/);assert.match(installer,/node_modules\/kiokuko-dsh/)
 assert.match(installer,/stageCodeHost\(directory,selected\);assertCodeConsumerHost\(directory,selected\)/)
 assert.match(source('benchmark-code-intelligence.mjs'),/assertCodeConsumerHost\(provider,selected\)/)
 assert.match(source('benchmark-code-intelligence.mjs'),/join\(provider,'node_modules\/@deepseek-ai'\)/)
 const baseline=JSON.parse(source('../patches/code-intelligence/upstream.json'))
 assert.equal(baseline.protocol,'code-intelligence/v1');assert.equal(baseline.baseRevision,'e7c92d33d60f4c340b99f6a7a6bf8f23b4f085a4')
})
test('harness evidence labels the selected installed host and SHA rather than historical fixture declaration', () => {
 const script=source('run-harness-evaluation.mjs')
 assert.match(script,/selectedDshRuntime\(root\)/)
 assert.match(script,/const packageJson = selected.manifest/);assert.match(script,/dshVersion: packageJson.version/);assert.match(script,/dshRevision:.*upstream.sha/)
 assert.doesNotMatch(script,/packageJson.dependencies\[/)
})


test('default current acceptance needs marker even without expected SHA; historical is explicit and disjoint', () => {
 const f=fixture()
 try {
  const selected=selectedDshRuntime(f.root,{})
  assert.equal(selected.mode,'current');assert.equal(selected.environment.KIOKUKO_EXPECTED_DSH_SHA,f.sha)
  assert.throws(()=>selectedDshRuntime(f.root,{DSH_BIN:'/unrelated/old-dsh'}),/CLI must come from/)
  assert.throws(()=>selectedCodeHost(f.root,{KIOKUKO_DSH_RUNTIME_MODE:'historical'}),/separate historical fixture/)
  assert.throws(()=>dshRuntimeMode({KIOKUKO_DSH_RUNTIME_MODE:'historical',KIOKUKO_EXPECTED_DSH_SHA:f.sha}),/cannot satisfy/)
  for(const mode of ['', 'legacy', 'unknown'])assert.throws(()=>dshRuntimeMode({KIOKUKO_DSH_RUNTIME_MODE:mode}),/must be current or historical/)
  rmSync(join(f.runtime,'node_modules/.kiokuko-dsh-upstream.json'))
  assert.throws(()=>selectedCodeHost(f.root,{}),/staged official SHA identity/)
  assert.throws(()=>selectedCodeHost(f.root,{KIOKUKO_EXPECTED_DSH_SHA:f.sha}),/staged official SHA identity/)
  // A standalone historical checkout is labelled explicitly and cannot assert current SHA.
  assert.equal(selectedCodeHost(f.root,{KIOKUKO_DSH_RUNTIME_MODE:'historical',KIOKUKO_DSH_PACKAGE_ROOT:join(f.root,'node_modules')}),undefined)
  assert.throws(()=>codeRuntimeEnvironment(f.root,true,undefined,{}),/requires staged official identity/)
 } finally {f.close()}
})

test('default provider setup checks runtime before cloning or installing historical dependencies', () => {
 const preparation=source('prepare-code-provider.mjs'),runner=source('run-code-intelligence.mjs')
 assert.ok(preparation.indexOf('selectedCodeHost(root)') < preparation.indexOf("await mkdir("))
 assert.ok(preparation.indexOf('selectedCodeHost(root)') < preparation.indexOf("await run('npm'"))
 assert.ok(runner.indexOf('selectedCodeHost(root)') < runner.indexOf("try{await access("))
 const typesafe=source('../tests/dsh/integration/lisp/typesafe-command.test.ts')
 assert.match(typesafe,/credentials.describe\('TYPESAFE_API_KEY'\)/)
 assert.doesNotMatch(typesafe,/nativeVersion|0\.2\.1-alpha/)
})


test('standalone setup, browser and evaluation entries reject unmarked runtime before native work', () => {
 const directory=mkdtempSync(join(tmpdir(),'unmarked-operational-host-'))
 try {
  const packages=join(directory,'node_modules');mkdirSync(join(packages,'@deepseek-ai/dsh'),{recursive:true})
  writeFileSync(join(packages,'@deepseek-ai/dsh/package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'historical-fixture'}))
  const env={...process.env,KIOKUKO_DSH_PACKAGE_ROOT:packages,KIOKUKO_HARNESS_REPORT:join(directory,'report.json')}
  for(const key of ['KIOKUKO_EXPECTED_DSH_SHA','KIOKUKO_DSH_RUNTIME_MODE','KIOKUKO_DSH_SOURCE_ROOT','DSH_BIN'])delete env[key]
  const scripts=['prepare-code-provider.mjs','run-code-intelligence.mjs','benchmark-code-intelligence.mjs','install-code-profile.mjs','verify-code-profile.mjs','run-skill-delivery.mjs','verify-module-packages.mjs','run-harness-evaluation.mjs','verify-lisp-approval-web.mjs','verify-shortcuts-web.mjs','verify-coding-workflow-web.mjs','verify-diff-review-web.mjs','verify-models-web.mjs','verify-lisp-web.mjs','verify-head-worker-settings-web.mjs','verify-lisp-plan-web.mjs','verify-correction-product-pair.ts','run-enno-dsh-e2e.mjs']
  for(const script of scripts){
   const child=spawnSync(process.execPath,['--import','tsx',join('scripts',script)],{cwd:resolve(import.meta.dirname,'..'),env,encoding:'utf8',timeout:10000})
   assert.equal(child.status,1,script+' must fail closed before setup')
   assert.match(child.stderr,/Current DSH acceptance requires a staged official SHA identity/,script)
  }
  for(const expression of [
   "import {captureCompactionArm} from './scripts/laya-compaction-native.mts';await captureCompactionArm({},'original',undefined,new AbortController().signal)",
   "import {runPrototypeEvaluation} from './scripts/lisp-prototype-evaluation.mjs';await runPrototypeEvaluation({})",
   "import {nativeSession} from './scripts/skill-coding/native.mjs';await nativeSession({})",
  ]){
   const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',expression],{cwd:resolve(import.meta.dirname,'..'),env,encoding:'utf8',timeout:10000})
   assert.equal(child.status,1);assert.match(child.stderr,/Current DSH acceptance requires a staged official SHA identity/)
  }
 }finally{rmSync(directory,{recursive:true,force:true})}
})
