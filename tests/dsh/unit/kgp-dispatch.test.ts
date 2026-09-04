import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { kgpDispatch, type KgpGenericName, type KgpStateKind } from '../../../src/dsh/generated/kgp-dispatch.js'

interface Vector {
  readonly id: number
  readonly generic: KgpGenericName
  readonly state: KgpStateKind
  readonly expected: { readonly action: string; readonly effect: string; readonly next: string }
}

test('SBCL-generated KGP dispatch satisfies all 66 fixed counterexample vectors', async () => {
  const path = resolve(import.meta.dirname, '../../fixtures/kgp-vectors.json')
  const vectors = JSON.parse(await readFile(path, 'utf8')) as Vector[]
  assert.equal(vectors.length, 66)
  for (const vector of vectors) {
    assert.deepEqual(kgpDispatch(vector.generic, vector.state), vector.expected, `KGP vector ${vector.id}`)
  }
})
