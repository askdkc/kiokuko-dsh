import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeEvidence } from '../../../src/dsh/runtime-evidence.js'

test('runtime evidence follows the actual launcher, preserving unknown host identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-runtime-evidence-'))
  try {
    const entry = join(root, 'bin/host.js'), link = join(root, 'launcher')
    await mkdir(join(root, 'bin')); await writeFile(entry, ''); await symlink(entry, link)
    const manifest = join(root, 'package.json')
    for (const version of ['0.3.0', '1.0.0-next.7']) {
      await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
      assert.deepEqual(runtimeEvidence(link), { nodeVersion: process.version, dshVersion: version, launcher: { name: '@deepseek-ai/dsh', version } })
    }
    await writeFile(manifest, JSON.stringify({ name: '@askdkc/dsh-cli', version: '2.0.0' }))
    assert.equal(runtimeEvidence(link).dshVersion, null, 'CLI metadata is not the DSH runtime version')
    assert.deepEqual(runtimeEvidence(link).launcher, { name: '@askdkc/dsh-cli', version: '2.0.0' })
    for (const metadata of ['null', '{', JSON.stringify({ name: 'kiokuko-dsh', version: '99.0.0' }), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'PRIVATE=VALUE' })]) {
      await writeFile(manifest, metadata)
      assert.deepEqual(runtimeEvidence(link), { nodeVersion: process.version, dshVersion: null, launcher: null })
    }
    await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
    const nested = join(root, 'nested'); await mkdir(nested)
    await writeFile(join(nested, 'package.json'), 'null'); await writeFile(join(nested, 'entry.js'), '')
    assert.equal(runtimeEvidence(join(nested, 'entry.js')).dshVersion, null, 'invalid nearest metadata must not borrow an outer host version')
    assert.equal(runtimeEvidence(join(root, 'missing')).dshVersion, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
