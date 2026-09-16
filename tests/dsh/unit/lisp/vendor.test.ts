import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyLispVendor } from '../../../../src/dsh/lisp/integrity.js'

const exec = promisify(execFile)
test('vendor manifest and npm omit optional generated test data while requiring runtime tables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lisp-vendor-')), library = join(root, 'lisp')
  const vendor = join(library, 'vendor/cl-unicode'), script = join(root, 'scripts/verify-lisp-vendor.mjs')
  await mkdir(join(vendor, 'test'), { recursive: true }); await mkdir(join(root, 'scripts'))
  await copyFile(new URL('../../../../scripts/verify-lisp-vendor.mjs', import.meta.url), script)
  await copyFile(new URL('../../../../lisp/vendor/cl-unicode/.npmignore', import.meta.url), join(vendor, '.npmignore'))
  const runtime = ['lists.lisp', 'hash-tables.lisp', 'methods.lisp']
  const generated = ['derived-properties', 'normalization-forms']
  try {
    for (const file of runtime) await writeFile(join(vendor, file), '; runtime fixture\n')
    for (const file of generated) await writeFile(join(vendor, 'test', file), 'optional generated test data\n')
    await exec(process.execPath, [script, '--write'])
    const withGenerated = await readFile(join(library, 'vendor-manifest.json'), 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(withGenerated).files).sort(), runtime.map(file => `cl-unicode/${file}`).sort())
    await exec(process.execPath, [script]); await verifyLispVendor(library)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'lisp-vendor-fixture', version: '1.0.0', files: ['lisp/'] }))
    const packed = JSON.parse((await exec('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root, env: { ...process.env, npm_config_cache: join(root, 'npm-cache') }, maxBuffer: 1024 * 1024,
    })).stdout)
    const paths = packed[0].files.map((file: { path: string }) => file.path)
    for (const file of runtime) assert.ok(paths.includes(`lisp/vendor/cl-unicode/${file}`))
    for (const file of generated) {
      assert.ok(!paths.includes(`lisp/vendor/cl-unicode/test/${file}`))
      await rm(join(vendor, 'test', file))
    }
    await exec(process.execPath, [script]); await verifyLispVendor(library)
    await exec(process.execPath, [script, '--write'])
    assert.equal(await readFile(join(library, 'vendor-manifest.json'), 'utf8'), withGenerated)
    await writeFile(join(vendor, 'lists.lisp'), '; changed runtime\n')
    await assert.rejects(exec(process.execPath, [script]), /differs from the reviewed manifest/)
    await assert.rejects(verifyLispVendor(library), { code: 'BUNDLE_INTEGRITY' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
