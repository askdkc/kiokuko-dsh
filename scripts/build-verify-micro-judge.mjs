// Existing absolute compiler only. Native tests must finish before publishing a verified artifact.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { acceptanceSummary, compilerIdentity, nativeTargets, sha256, validateNativeArtifact } from './micro-judge-artifacts.mjs'
const root = resolve(import.meta.dirname, '..'), rustc = process.argv[2]
const output = process.argv.find(a => a.startsWith('--output='))?.slice(9)
const selectedFile = process.argv.find(a => a.startsWith('--ci-plan='))?.slice(10)
const selection = selectedFile ? (await import('./ci-plan.mjs')).readCiPlan(root, selectedFile) : undefined
assert.ok(rustc && isAbsolute(rustc), 'Pass the absolute path to an existing native Rust compiler')
const key = `${process.platform}-${process.arch}`, target = nativeTargets[key]
assert.ok(target, `Unsupported native build target: ${key}`)
const compiler = spawnSync(rustc, ['-vV'], { encoding:'utf8' })
assert.equal(compiler.status, 0, 'Cannot inspect the existing Rust compiler')
const identity = compilerIdentity(compiler.stdout.split('\n')[0])
if(selection)assert.equal(identity,selection.identity.toolchain.rust,'Selected Rust toolchain mismatch')
assert.ok(compiler.stdout.split('\n').includes(`host: ${target}`), 'Native compiler host mismatch')
const build = spawnSync(process.execPath, ['scripts/build-micro-judge.mjs', rustc], { cwd:root, stdio:'inherit' })
assert.equal(build.status, 0, 'Rust build failed')
const manifestPath = join(root,'micro-judge/manifest.json'), manifest = JSON.parse(await readFile(manifestPath,'utf8'))
const entry = manifest.artifacts.find(a => `${a.platform}-${a.arch}` === key)
assert.equal(entry.nativeVerified, false)
assert.equal(entry.compiler, identity, 'Compiler identity changed during the build')
// This job owns exactly one target, including when crate sources changed.
manifest.artifacts=[entry]
await writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`)
const test = spawnSync(process.execPath, ['--import','./tests/dsh/helpers/offline-skill-catalog.mjs','--import','tsx','--test','--test-reporter=tap','tests/dsh/integration/micro-judge.test.ts'], {
  cwd:root, encoding:'utf8', timeout:120000, maxBuffer:8*1024**2,
  env:{...process.env, KIOKUKO_REQUIRE_MICRO_JUDGE:'1', KIOKUKO_SKILL_PACKAGE_ROOT:root},
})
const tap = `${test.stdout ?? ''}${test.stderr ?? ''}`, log = `native-acceptance-${key}.tap`
await writeFile(join(root,'micro-judge',log),tap)
assert.equal(test.status,0,`Native acceptance failed (${test.error ?? ''}):\n${tap.slice(-12000)}`)
const summary = acceptanceSummary(tap)
const receipt = {schemaVersion:1, platform:process.platform, arch:process.arch, target, binarySha256:entry.sha256,
  sourceDigest:entry.sourceDigest, compiler:entry.compiler, exitCode:test.status, summary, log, logSha256:sha256(tap)}
await writeFile(join(root,`micro-judge/native-verification-${key}.json`),`${JSON.stringify(receipt,null,2)}\n`)
entry.nativeVerified=true
await validateNativeArtifact(join(root,'micro-judge'),entry,entry.sourceDigest)
await writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`)
const probe = spawnSync(process.execPath,['scripts/verify-micro-judge.mjs','--execute'],{cwd:root,stdio:'inherit'})
assert.equal(probe.status,0,'Verified bundle native probe failed')
if(output) {
  if(selection)assert.equal((await import('./ci-plan.mjs')).readCiPlan(root,selectedFile).digest,selection.digest)
  const destination=resolve(output); await mkdir(destination,{recursive:false})
  for(const file of [entry.file,log,`native-verification-${key}.json`]) {
    await mkdir(resolve(destination,file,'..'),{recursive:true}); await cp(join(root,'micro-judge',file),join(destination,file))
  }
  await writeFile(join(destination,'manifest.json'),`${JSON.stringify({version:manifest.version,artifacts:[entry]},null,2)}\n`)
  if(selection)await writeFile(join(destination,'selection.json'),JSON.stringify((await import('./ci-plan.mjs')).nativeSelection(selection,entry),null,2)+'\n')
}
console.log(JSON.stringify({platform:key,target,actualExecution:true,summary,binarySha256:entry.sha256,output}))
