// Explicit offline native build. Never downloads a compiler or changes shell configuration.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { compilerIdentity } from './micro-judge-artifacts.mjs'
const root=resolve(import.meta.dirname,'..'),rustc=process.argv[2]
if(!rustc || !isAbsolute(rustc))throw new Error('Pass the absolute path to an existing rustc; no automatic install')
const triples={ 'darwin-arm64':'aarch64-apple-darwin','linux-x64':'x86_64-unknown-linux-gnu','linux-arm64':'aarch64-unknown-linux-gnu' }
const key=`${process.platform}-${process.arch}`,target=triples[key]
if(!target)throw new Error(`Unsupported native build platform ${key}`)
const version=spawnSync(rustc,['-vV'],{encoding:'utf8'})
if(version.status!==0 || !version.stdout.split('\n').includes(`host: ${target}`))throw new Error('Compiler host must match this native platform')
const compiler=compilerIdentity(version.stdout.split('\n')[0])
const folder=join(root,'micro-judge',key);await mkdir(folder,{recursive:true})
const file=`${key}/kiokuko-micro-judge`,binary=join(root,'micro-judge',file)
const built=spawnSync(rustc,['--edition=2021','-C','opt-level=3','-C','panic=abort','-C','strip=symbols',join(root,'crates/micro-judge/src/main.rs'),'-o',binary],{stdio:'inherit'})
if(built.status!==0)throw new Error('Native Rust build failed')
const sourceDigest=createHash('sha256').update(await readFile(join(root,'crates/micro-judge/Cargo.toml'))).update(await readFile(join(root,'crates/micro-judge/src/main.rs'))).update(await readFile(join(root,'crates/micro-judge/src/digest.rs'))).digest('hex')
const bytes=await readFile(binary),manifestPath=join(root,'micro-judge/manifest.json')
const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
manifest.artifacts=manifest.artifacts.filter(a=>a.platform!==process.platform||a.arch!==process.arch)
manifest.artifacts.push({platform:process.platform,arch:process.arch,file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,sourceDigest,compiler,nativeVerified:false})
await writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`)
console.log(JSON.stringify({target,file,sha256:manifest.artifacts.at(-1).sha256,nativeVerified:false}))
