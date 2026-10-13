import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '..')
const native = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(root, 'tests/fixtures/dsh-runtime/node_modules')
await access(join(native, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
const env = {...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(join(root,'tests/dsh/helpers/offline-skill-catalog.mjs')).href}`, KIOKUKO_DSH_PACKAGE_ROOT:native, KIOKUKO_REQUIRE_DSH_NATIVE:'1', KIOKUKO_REQUIRE_LISP_RUNTIME:'1', KIOKUKO_TEST_COMPILED_SKILLS:'1'}
delete env.KIOKUKO_SKILL_PACKAGE_ROOT
delete env.KIOKUKO_DSH_SOURCE_ROOT
delete env.NODE_TEST_CONTEXT
async function verify(packageRoot) {
  const options={cwd:root,env:{...env,...(packageRoot?{KIOKUKO_SKILL_PACKAGE_ROOT:packageRoot}:{})},maxBuffer:16*1024*1024}
  for (const args of [
    ['--import','tsx','--test','--test-concurrency=1','tests/dsh/skill-delivery/skill-delivery.test.ts', 'tests/dsh/unit/skill-startup-native.test.ts', ...(!packageRoot ? ['tests/dsh/skill-delivery/prototype-evaluation.test.ts'] : [])],
    ['--import','tsx','--test','--test-name-pattern=\\(text\\)|Japanese Skill reaches','tests/dsh/e2e/native-agent-loop.test.ts','tests/dsh/e2e/deep-planning-native.test.ts'],
  ]) {
    try { const result=await exec(process.execPath,[...(process.env.KIOKUKO_VERIFY_REPORT_DIR?['--import='+join(root,'scripts/verification-test-environment.mjs'),'--test-reporter=tap','--test-reporter-destination=stdout','--test-reporter='+join(root,'scripts/verification-reporter.mjs'),'--test-reporter-destination='+join(process.env.KIOKUKO_VERIFY_REPORT_DIR,'skill-reporter.txt')]:[]),'--import',join(root,'tests/dsh/helpers/offline-skill-catalog.mjs'),...args],options);process.stdout.write(result.stdout);process.stderr.write(result.stderr) }
    catch(error) { process.stdout.write(error.stdout??'');process.stderr.write(error.stderr??'');throw new Error(`Skill delivery failed (${packageRoot?'packed':'source'}, exit ${error.code})`) }
  }
}
await verify()
const work=await mkdtemp(join(tmpdir(),'skill-delivery-pack-'))
try {
  const packed=process.env.KIOKUKO_VERIFY_TARBALL?JSON.parse(await readFile(process.env.KIOKUKO_VERIFY_PACK_METADATA,'utf8')):JSON.parse((await exec('npm',['pack','--json','--ignore-scripts','--pack-destination',work],{cwd:root,env:{...env,npm_config_cache:join(work,'cache')},maxBuffer:16*1024*1024})).stdout)
  const archive=process.env.KIOKUKO_VERIFY_TARBALL??join(work,packed[0].filename)
  const consumer=join(work,'consumer');await mkdir(consumer);await writeFile(join(consumer,'package.json'),'{"private":true,"type":"module"}')
  await exec('npm',['install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',archive],{cwd:consumer,env:{PATH:process.env.PATH,HOME:work,npm_config_cache:join(work,'cache')},timeout:180000,maxBuffer:16*1024*1024})
  const packageRoot=join(consumer,'node_modules','kiokuko-dsh')
  await verify(packageRoot)
  console.log(JSON.stringify({status:'passed',source:true,packed:true,nativeRuntime:true,protectedLisp:true,wireSerializer:'dsh-llm-deepseek',liveModelQuality:'unmeasured'}))
} finally { await rm(work,{recursive:true,force:true}) }
