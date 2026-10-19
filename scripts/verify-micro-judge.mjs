// Verify packaged identities without compiling, downloading or changing state.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root=resolve(process.argv.find(a=>a.startsWith('--root='))?.slice(7)??resolve(import.meta.dirname,'..'))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const manifest=JSON.parse(await readFile(join(root,'micro-judge/manifest.json'),'utf8'))
assert.equal(manifest.version,'kiokuko-fd-v1');assert.ok(Array.isArray(manifest.artifacts)&&manifest.artifacts.length<=6)
const platforms=new Set();let executedNative=false
let sourceDigest
try {sourceDigest=hash(Buffer.concat(await Promise.all(['Cargo.toml','src/main.rs','src/digest.rs'].map(file=>readFile(join(root,'crates/micro-judge',file))))))}catch(error){if(error.code!=='ENOENT')throw error}
const licenses=JSON.parse(await readFile(join(root,'micro-judge/licenses/manifest.json'),'utf8'))
assert.deepEqual(Object.keys(licenses).sort(),['COPYRIGHT-Rust-1.85.0.txt','LICENSE-APACHE','LICENSE-MIT'])
for(const [name,digest]of Object.entries(licenses))assert.equal(hash(await readFile(join(root,'micro-judge/licenses',name))),digest)
for(const entry of manifest.artifacts){
  const key=`${entry.platform}-${entry.arch}`;assert.ok(!platforms.has(key));platforms.add(key)
  assert.ok(['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-arm64','win32-x64'].includes(key))
  assert.equal(entry.file,`${key}/kiokuko-micro-judge${entry.platform==='win32'?'.exe':''}`)
  for(const path of [join(root,'micro-judge'),join(root,'micro-judge',key)]){const stat=await lstat(path);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink())}
  const file=join(root,'micro-judge',entry.file),stat=await lstat(file)
  assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<8000000);assert.equal(stat.size,entry.bytes)
  const bytes=await readFile(file);assert.equal(hash(bytes),entry.sha256);if(sourceDigest)assert.equal(entry.sourceDigest,sourceDigest,'Artifact source digest must match current crate')
  assert.equal(entry.nativeVerified,true,'Only artifacts with native acceptance evidence may be packaged')
  const receipt=JSON.parse(await readFile(join(root,`micro-judge/native-verification-${key}.json`),'utf8'))
  assert.equal(receipt.binarySha256,entry.sha256);assert.equal(receipt.sourceDigest,entry.sourceDigest)
  if(receipt.schemaVersion===1){
    assert.equal(receipt.platform,entry.platform);assert.equal(receipt.arch,entry.arch);assert.equal(receipt.compiler,entry.compiler);assert.equal(receipt.exitCode,0)
    assert.equal(receipt.log,`native-acceptance-${key}.tap`)
    const logPath=join(root,'micro-judge',receipt.log),info=await lstat(logPath);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<8000000)
    const log=await readFile(logPath);assert.equal(hash(log),receipt.logSha256)
    assert.ok(receipt.summary.tests>=18);assert.equal(receipt.summary.tests,receipt.summary.pass)
    for(const name of ['tests','pass','fail','cancelled','skipped','todo']){
      const matches=[...log.toString().matchAll(new RegExp(`^# ${name} (\\d+)$`,'gm'))];assert.equal(matches.length,1);assert.equal(Number(matches[0][1]),receipt.summary[name]);if(!['tests','pass'].includes(name))assert.equal(receipt.summary[name],0)
    }
  }
  if(entry.platform==='darwin'){assert.equal(bytes.subarray(0,4).toString('hex'),'cffaedfe');assert.equal(bytes.readUInt32LE(4),entry.arch==='arm64'?0x100000c:0x1000007)}
  if(entry.platform==='linux'){assert.equal(bytes.subarray(0,4).toString('hex'),'7f454c46');assert.equal(bytes[4],2);assert.equal(bytes[5],1);assert.equal(bytes.readUInt16LE(18),entry.arch==='arm64'?183:62)}
  if(entry.platform===process.platform&&entry.arch===process.arch&&process.argv.includes('--execute')){
    const version=spawnSync(file,['--version'],{encoding:'utf8',timeout:1500,maxBuffer:16384,env:{}})
    assert.equal(version.status,0);assert.equal(version.stdout.trim(),'kiokuko-micro-judge 0.1.0 kiokuko-fd-v1')
    const payload='2000 1 0 b 2 0 1 @0',id=hash(Buffer.from('packaged-probe')),digest=hash(Buffer.from(payload))
    const executed=spawnSync(file,[],{input:`kiokuko-fd-v1\t${id}\t${digest}\t${payload}\n`,encoding:'utf8',timeout:1500,maxBuffer:16384,env:{}})
    assert.equal(executed.status,0);const result=JSON.parse(executed.stdout)
    assert.equal(result.version,manifest.version);assert.equal(result.inputDigest,digest);assert.equal(result.inputId,id);assert.equal(result.status,'undetermined');assert.equal(result.complete,true)
    executedNative=true
    console.log(JSON.stringify({platform:key,binarySha256:entry.sha256,version:version.stdout.trim(),actualExecution:true}))
  }
}
if(!manifest.artifacts.length)throw new Error('No verified micro-judge artifacts bundled')

if(process.argv.includes('--execute')&&!executedNative){console.log(JSON.stringify({platform:`${process.platform}-${process.arch}`,actualExecution:false,reason:'unsupported_platform'}));process.exitCode=2}
