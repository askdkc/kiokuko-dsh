import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '..')
const native = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(root, 'tests/fixtures/dsh-runtime/node_modules')
await access(join(native, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
const env = {...process.env, KIOKUKO_DSH_PACKAGE_ROOT:native, KIOKUKO_REQUIRE_DSH_NATIVE:'1', KIOKUKO_REQUIRE_LISP_RUNTIME:'1', KIOKUKO_TEST_COMPILED_SKILLS:'1'}
delete env.KIOKUKO_SKILL_PACKAGE_ROOT
delete env.KIOKUKO_DSH_SOURCE_ROOT
delete env.NODE_TEST_CONTEXT
async function verify(packageRoot) {
  const options={cwd:root,env:{...env,...(packageRoot?{KIOKUKO_SKILL_PACKAGE_ROOT:packageRoot}:{})},maxBuffer:16*1024*1024}
  for (const args of [
    ['--import','tsx','--test','tests/dsh/e2e/skill-delivery.test.ts'],
    ['--import','tsx','--test','--test-name-pattern=\\(text\\)|Japanese Skill reaches','tests/dsh/e2e/native-agent-loop.test.ts','tests/dsh/e2e/deep-planning-native.test.ts'],
  ]) {
    try { const result=await exec(process.execPath,args,options);process.stdout.write(result.stdout);process.stderr.write(result.stderr) }
    catch(error) { process.stdout.write(error.stdout??'');process.stderr.write(error.stderr??'');throw new Error(`Skill delivery failed (${packageRoot?'packed':'source'}, exit ${error.code})`) }
  }
}
await verify()
const work=await mkdtemp(join(tmpdir(),'skill-delivery-pack-'))
try {
  const packed=JSON.parse((await exec('npm',['pack','--json','--ignore-scripts','--pack-destination',work],{cwd:root,env:{...env,npm_config_cache:join(work,'cache')},maxBuffer:16*1024*1024})).stdout)
  await exec('tar',['-xzf',join(work,packed[0].filename),'-C',work])
  const packageRoot=join(work,'package')
  await symlink(join(root,'node_modules'),join(packageRoot,'node_modules'),'dir')
  await verify(packageRoot)
  console.log(JSON.stringify({status:'passed',source:true,packed:true,nativeRuntime:true,protectedLisp:true,wireSerializer:'dsh-llm-deepseek',liveModelQuality:'unmeasured'}))
} finally { await rm(work,{recursive:true,force:true}) }
