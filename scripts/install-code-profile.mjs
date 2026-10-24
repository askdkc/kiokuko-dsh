import { dshRuntimeMode } from './dsh-fixture-identity.mjs'
import { selectedCodeHost, stageCodeHost, assertCodeConsumerHost, codeProfileHostDependencies } from './code-intelligence-host.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
const root=resolve(import.meta.dirname,'..'),base=join(root,'.artifacts/code-intelligence'),profile=join(base,'profile'),exec=promisify(execFile)
const historical=process.argv.includes('--historical')||dshRuntimeMode(process.env)==='historical'
assert.ok(!historical||!process.env.KIOKUKO_EXPECTED_DSH_SHA,'Historical profile cannot satisfy current official CI')
const selected=historical?undefined:selectedCodeHost(root)
assert.ok(!selected||!process.env.KIOKUKO_CODE_CLI_ROOT,'Current official profile cannot inject a different vendor CLI')
assert.ok(process.argv.slice(2).every(arg=>arg==='--historical'),'Unknown code-profile installer option')
// npm run exports CLI configuration; allow-scripts is invalid as a project-install CLI flag.
// This owned fixture permits no dependency lifecycle scripts and keeps --ignore-scripts.
const installEnvironment={...process.env,...(historical?{KIOKUKO_DSH_RUNTIME_MODE:'historical'}:{})};delete installEnvironment.npm_config_allow_scripts
const run=(program,args,cwd)=>exec(program,args,{cwd,env:installEnvironment,timeout:180000,maxBuffer:8*1024*1024})
await mkdir(base,{recursive:true})
try{await access(profile);await access(join(profile,'.code-intelligence-fixture'));await rm(profile,{recursive:true})}catch(error){if(error.code!=='ENOENT')throw error;try{await access(profile);throw new Error('Refusing to replace an unowned profile fixture')}catch(missing){if(missing.code!=='ENOENT')throw missing}}
await mkdir(profile);await writeFile(join(profile,'.code-intelligence-fixture'),'Disposable acceptance fixture\n')
const pack=async(directory,label)=>{
 const destination=join(base,`pack-${label}`);await mkdir(destination,{recursive:true})
 for(const file of await readdir(destination))if(file.endsWith('.tgz'))await rm(join(destination,file))
 await run('npm',['pack','--ignore-scripts','--pack-destination',destination],directory)
 const archives=(await readdir(destination)).filter(file=>file.endsWith('.tgz'));assert.equal(archives.length,1);return join(destination,archives[0])
}
const expectedPackageVersion=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version
const provider=await pack(join(base,'dsh-lsp-server'),'provider'),suite=await pack(root,'suite')
// Reproduce the selected installed host graph, not a named historical release.
const installedVersions={}
const packageRoot=resolve(process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(root,'tests/fixtures/dsh-runtime/node_modules'))
const hostDirectory=join(packageRoot,'@deepseek-ai')
for(const packageName of await readdir(hostDirectory)){
 const manifest=JSON.parse(await readFile(join(hostDirectory,packageName,'package.json'),'utf8'))
 assert.ok(typeof manifest.name==='string'&&typeof manifest.version==='string')
 installedVersions[manifest.name]=manifest.version
}
const hostDependencies=codeProfileHostDependencies(installedVersions,selected)
const historicalDependencies=historical?JSON.parse(await readFile(join(root,'scripts/code-profile-historical.json'),'utf8')):{}
const cli=!historical&&process.env.KIOKUKO_CODE_CLI_ROOT?`file:${await pack(resolve(process.env.KIOKUKO_CODE_CLI_ROOT),'cli')}`:'latest'
await writeFile(join(profile,'package.json'),JSON.stringify({private:true,type:'module',allowScripts:{},dependencies:{...hostDependencies,
 ...(selected?{}:{'@askdkc/dsh-cli':cli}),...historicalDependencies,
 '@askdkc/dsh-lsp-server':`file:${provider}`,'kiokuko-dsh':`file:${suite}`},
 dsh:{profile:{bundles:['@askdkc/dsh-lsp-server','kiokuko-dsh']}},
},null,2)+'\n')
await run('npm',['install','--ignore-scripts','--legacy-peer-deps'],profile)
for(const [name,version] of Object.entries({...hostDependencies,...historicalDependencies,'kiokuko-dsh':expectedPackageVersion}))assert.equal(JSON.parse(await readFile(join(profile,'node_modules',name,'package.json'),'utf8')).version,version)
if(selected){
 for(const directory of [profile,join(profile,'node_modules/@askdkc/dsh-lsp-server'),join(profile,'node_modules/kiokuko-dsh')]){stageCodeHost(directory,selected);assertCodeConsumerHost(directory,selected)}
 console.log(`Installed packed provider and Kiokuko against official DSH ${selected.sha}.`)
}else{
const installedCli=JSON.parse(await readFile(join(profile,'node_modules/@askdkc/dsh-cli/package.json'),'utf8'))
assert.equal(installedCli.name,'@askdkc/dsh-cli');assert.ok(typeof installedCli.version==='string'&&installedCli.version!=='latest')
console.log(`Installed packed provider and Kiokuko in the isolated ${historical?'historical regression':'selected host'} CLI ${installedCli.version} profile fixture.`)
}
