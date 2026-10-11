import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import {providerDeclaration} from './code-provider-declaration.mjs'
const exec = promisify(execFile), root=resolve(import.meta.dirname,'..')
const directory=join(root,'.artifacts/code-intelligence/dsh-lsp-server')
const metadata=JSON.parse(await readFile(join(root,'patches/code-intelligence/upstream.json'),'utf8'))
const run=(program,args,cwd=directory)=>exec(program,args,{cwd,timeout:120000,maxBuffer:8*1024*1024})
await mkdir(join(root,'.artifacts/code-intelligence'),{recursive:true})
try{await access(join(directory,'.git'))}catch{
  await run('git',['clone','--no-checkout',metadata.repository,directory],root)
  await run('git',['checkout','--detach',metadata.baseRevision])
}
assert.equal((await run('git',['remote','get-url','origin'])).stdout.trim(),metadata.repository,'Provider origin differs from the reviewed upstream')
assert.equal((await run('git',['rev-parse','HEAD'])).stdout.trim(),metadata.baseRevision,'Provider checkout has a different base; review it instead of resetting it')
const patch=join(root,'patches/code-intelligence/provider.patch')
try { await run('git',['apply','--reverse','--check',patch]) }
catch { await run('git',['apply','--check',patch]); await run('git',['apply',patch]) }
const contract=await readFile(join(directory,'src/code-intelligence-contracts.ts'),'utf8')
const expected=providerDeclaration(contract)
assert.equal(await readFile(join(root,'src/dsh/lisp/code-intelligence-provider.d.ts'),'utf8'),expected,'Provider/consumer contract drift')
await run('npm',['ci','--ignore-scripts','--legacy-peer-deps'])
console.log('Prepared local V1 provider; no active DSH profile was changed.')
