import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { prepareLayout } from '../../../../src/dsh/lisp/sandbox.js'
import { checkedDirectory } from '../../../../src/dsh/lisp/files.js'

test('sandbox layout binds an aliased state directory once and still rejects a replaced scratch root', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-layout-alias-')))
  try {
    const state = join(base, 'state'), alias = join(base, 'alias'), outside = join(base, 'outside')
    await mkdir(state); await mkdir(outside)
    await symlink(state, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const layout = await prepareLayout(join(alias, 'worker'), base)
    assert.equal(layout.base, join(state, 'worker'))
    for (const path of [layout.scratch, layout.inputs, layout.cache]) assert.equal(path, await realpath(path))
    assert.equal((await checkedDirectory(layout.scratch)).path, join(state, 'worker/scratch'))
    await rename(layout.scratch, join(layout.base, 'old-scratch'))
    await symlink(outside, layout.scratch, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(checkedDirectory(layout.scratch), { code: 'ROOT_CHANGED' })
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('protected launch pins relocated host Node without trusting adjacent executables or PATH overrides', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-host-node-')))
  const bin = join(base, 'runtime', 'bin'), override = join(base, 'override')
  await mkdir(bin, { recursive: true }); await mkdir(override)
  const node = join(bin, 'node'), other = join(bin, 'other'), fakeNode = join(override, 'node')
  try {
    // Launch planning does not execute bwrap; make this unit test independent
    // of whether a native Linux sandbox is installed (integration tests do).
    for (const target of [node, other, fakeNode, join(bin, 'bwrap')]) await copyFile(process.execPath, target)
    // Homebrew's executable loads libnode relative to its runtime directory.
    await symlink(join(dirname(dirname(process.execPath)), 'lib'), join(base, 'runtime', 'lib'))
    const module = new URL('../../../../src/dsh/lisp/sandbox.ts', import.meta.url).href
    const source = `
      import assert from 'node:assert/strict';
      import {dirname} from 'node:path';
      import {prepareLayout,sandboxLaunch} from ${JSON.stringify(module)};
      const layout=await prepareLayout(${JSON.stringify(join(base, 'layout'))},${JSON.stringify(base)});
      layout.protected=true;
      const launch=await sandboxLaunch(layout,'node',['--version'],'fixture');
      assert.equal(launch.args.at(-2),process.execPath);
      assert.equal(launch.env.PATH.split(':')[0],dirname(process.execPath));
      assert.equal(launch.env.OPENSSL_CONF,'/dev/null');
      await assert.rejects(sandboxLaunch(layout,${JSON.stringify(other)},[],'fixture'),e=>e.code==='EXECUTABLE_SCOPE');
      await assert.rejects(sandboxLaunch(layout,${JSON.stringify(fakeNode)},[],'fixture'),e=>e.code==='EXECUTABLE_SCOPE');
      layout.protected=false;
      assert.equal((await sandboxLaunch(layout,'node',[],'fixture')).command,${JSON.stringify(fakeNode)});
      console.log('relocated-host-only');
    `
    const result = await promisify(execFile)(node, ['--import', 'tsx', '--input-type=module', '-e', source], {
      env: { ...process.env, PATH: [override, bin, process.env.PATH].join(delimiter) }, timeout: 30000,
    })
    assert.match(result.stdout, /relocated-host-only/u)
  } finally { await rm(base, { recursive: true, force: true }) }
})
