import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveGuardrail } from '../../../scripts/guardrail-artifacts.mjs'

test('Node and packaged Rust consume the same schema2 contract fixture',()=>{
  const runtime=resolveGuardrail(process.cwd())
  const fixture=path.join(process.cwd(),'crates/guardrail/tests/fixtures/schema2-green.lisp')
  const text=execFileSync(runtime.binary,['check',runtime.protocol,'verify-green',fixture],{encoding:'utf8'})
  assert.match(text,/:allow t/)
  const directory=mkdtempSync(path.join(tmpdir(),'guardrail-schema2-'))
  try {
    const target=path.join(directory,'evidence.lisp'),original=readFileSync(fixture,'utf8')
    for(const changed of [original.replace(':schema 2',':schema 1'),original.replace(':route :owned',':route :native'),original.replace(':outcome :succeeded',':outcome :failed'),original.replace(':complete t',':complete nil')]){
      writeFileSync(target,changed)
      assert.throws(()=>execFileSync(runtime.binary,['check',runtime.protocol,'verify-green',target],{encoding:'utf8',stdio:'pipe'}))
    }
  } finally {rmSync(directory,{recursive:true,force:true})}
})
