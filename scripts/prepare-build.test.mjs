import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root=path.resolve(import.meta.dirname,'..')
const subject=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'))
function fixture(env={}){
  const directory=mkdtempSync(path.join(tmpdir(),'ci-prepare-'))
  mkdirSync(path.join(directory,'scripts'))
  for (const script of ['prepare-build.mjs', 'install-lisp.mjs']) {
    cpSync(path.join(root, 'scripts', script), path.join(directory, 'scripts', script))
  }
  const lispModule = path.join(directory, 'dist/dsh/lisp')
  mkdirSync(lispModule, { recursive: true })
  writeFileSync(path.join(lispModule, 'installed-runtime.js'), `
    import { accessSync, writeFileSync } from 'node:fs'
    export function buildInstalledLisp() {
      accessSync('built.json')
      writeFileSync('lisp-built.json', '{}')
      return { reused: false }
    }
  `)
  writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'prepare-fixture',version:'1.0.0',type:'module',private:true,scripts:{prepare:subject.scripts.prepare,build:'node build.mjs'}}))
  writeFileSync(path.join(directory,'build.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('built.json',JSON.stringify({built:true}));process.exit(Number(process.env.KIOKUKO_FIXTURE_BUILD_EXIT??0))")
  writeFileSync(path.join(directory,'npmrc'),'')
  const environment={...process.env,npm_config_userconfig:path.join(directory,'npmrc'),NPM_CONFIG_USERCONFIG:path.join(directory,'npmrc'),npm_config_cache:path.join(directory,'cache'),npm_config_ignore_scripts:'false',CI:'',KIOKUKO_CI_DEFER_PREPARE:'',...env}
  const run=spawnSync('npm',['run','prepare'],{cwd:directory,env:environment,encoding:'utf8',timeout:15000})
  return {run,built:existsSync(path.join(directory,'built.json')),lispBuilt:existsSync(path.join(directory,'lisp-built.json')),dispose:()=>rmSync(directory,{recursive:true,force:true})}
}
test('only an explicitly deferred CI prepare omits the duplicate build',()=>{
  const f=fixture({CI:'true',KIOKUKO_CI_DEFER_PREPARE:'1'})
  try{assert.equal(f.run.status,0,f.run.stderr);assert.equal(f.built,false,'the selected verifier owns the fresh build');assert.equal(f.lispBuilt,false)}finally{f.dispose()}
})
for(const env of [{},{CI:'true'},{KIOKUKO_CI_DEFER_PREPARE:'1'},{CI:'true',KIOKUKO_CI_DEFER_PREPARE:'0'}])
  test('ordinary prepare still builds '+JSON.stringify(env),()=>{
    const f=fixture(env)
    try{assert.equal(f.run.status,0,f.run.stderr);assert.equal(f.built,true);assert.equal(f.lispBuilt,true)}finally{f.dispose()}
  })
test('ordinary prepare propagates build failure',()=>{
  const f=fixture({KIOKUKO_FIXTURE_BUILD_EXIT:'13'})
  try{assert.equal(f.built,true);assert.equal(f.lispBuilt,false);assert.equal(f.run.status,13,'a failed build must retain its exit status')}finally{f.dispose()}
})
