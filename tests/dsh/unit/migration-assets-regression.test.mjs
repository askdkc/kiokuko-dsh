import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
test('declared module assets contain every authoritative migration exactly once', () => {
  const root = process.cwd()
  const declared = JSON.parse(readFileSync(join(root, 'scripts/module-compatibility-assets.json'), 'utf8')).migrations
  const actual = readdirSync(join(root, 'migrations')).filter(name => /^\d+_.+\.sql$/.test(name)).sort().map(name => `migrations/${name}`)
  assert.equal(new Set(declared).size, declared.length)
  assert.deepEqual(declared, actual)
})
