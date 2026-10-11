import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
const root=resolve(import.meta.dirname,'..'),base=join(root,'.artifacts/code-intelligence'),profile=join(base,'profile'),exec=promisify(execFile)
// npm run exports CLI configuration; allow-scripts is invalid as a project-install CLI flag.
// This owned fixture permits no dependency lifecycle scripts and keeps --ignore-scripts.
const installEnvironment={...process.env};delete installEnvironment.npm_config_allow_scripts
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
const provider=await pack(join(base,'dsh-lsp-server'),'provider'),suite=await pack(root,'suite')
// Pin the physically installed, canonical host ecosystem, including its peer-only services.
const hostDependencies={}
const hostDirectory=join(root,'tests/fixtures/dsh-runtime/node_modules/@deepseek-ai')
for(const packageName of await readdir(hostDirectory)){
 const manifest=JSON.parse(await readFile(join(hostDirectory,packageName,'package.json'),'utf8'))
 hostDependencies[manifest.name]=manifest.version
}
await writeFile(join(profile,'package.json'),JSON.stringify({private:true,type:'module',allowScripts:{},dependencies:{...hostDependencies,
 '@deepseek-ai/cordis-plugin-group':'1.0.5-alpha.1','@deepseek-ai/cordis-plugin-loader':'1.0.6-alpha.1','@deepseek-ai/cordis-plugin-include':'1.0.10-alpha.1',
 '@deepseek-ai/dsh':'0.2.1-alpha.2','@deepseek-ai/cordis':'4.0.5-alpha.1','@askdkc/dsh-cli':'0.14.4',
 '@askdkc/dsh-lsp-server':`file:${provider}`,'kiokuko-dsh':`file:${suite}`},
 dsh:{profile:{bundles:['@askdkc/dsh-lsp-server','kiokuko-dsh']}},
},null,2)+'\n')
await run('npm',['install','--ignore-scripts','--legacy-peer-deps'],profile)
for(const [name,version] of [['@deepseek-ai/dsh','0.2.1-alpha.2'],['@askdkc/dsh-cli','0.14.4'],['kiokuko-dsh','0.2.1']])assert.equal(JSON.parse(await readFile(join(profile,'node_modules',name,'package.json'),'utf8')).version,version)
console.log('Installed packed provider and Kiokuko in the isolated CLI 0.14.4 profile fixture.')
