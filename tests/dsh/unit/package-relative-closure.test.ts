import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { assertRelativeClosure } from '../../../scripts/package-relative-closure.mjs'

test('packed declaration references follow TypeScript resolution without admitting missing runtime imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-type-closure-'))
  try {
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist/client.d.ts'), 'export interface ClientContext { id: string }')
    const declaration = join(root, 'dist/recovery-client.d.ts')
    await writeFile(declaration, "import type { ClientContext } from './client.js'; export declare function recover(ctx: ClientContext): void;")
    const resolved = ts.resolveModuleName('./client.js', declaration, { moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule
    assert.equal(resolved?.resolvedFileName, join(root, 'dist/client.d.ts'), 'TypeScript itself resolves the published declaration')
    await assertRelativeClosure(root, [{ path: 'dist/recovery-client.d.ts' }, { path: 'dist/client.d.ts' }])

    await writeFile(join(root, 'dist/recovery-client.js'), "export { recover } from './client.js'")
    await assert.rejects(assertRelativeClosure(root, [{ path: 'dist/recovery-client.js' }]), /missingRelativeImports/,
      'a declaration never substitutes for an executable dependency')
    await writeFile(declaration, "export type { Missing } from './missing.js'")
    await assert.rejects(assertRelativeClosure(root, [{ path: 'dist/recovery-client.d.ts' }]), /missingRelativeImports/,
      'missing declaration dependencies still fail packaging')
  } finally { await rm(root, { recursive: true, force: true }) }
})
