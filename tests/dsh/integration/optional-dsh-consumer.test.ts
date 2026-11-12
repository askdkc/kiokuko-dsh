import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const exec = promisify(execFile)
test('packed public entrypoints and efficiency load without optional DSH peers', {timeout: 30000}, async () => {
  const root = process.cwd(), temporary = await mkdtemp('/tmp/kiokuko-optional-dsh-')
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const packed = JSON.parse((await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {cwd:root, env:{...process.env,npm_config_cache:join(temporary,'npm-cache')}, timeout:15000})).stdout)
    const modules = join(temporary, 'node_modules')
    await mkdir(modules)
    await exec('tar', ['-xzf', join(temporary, packed[0].filename), '-C', modules])
    await rename(join(modules, 'package'), join(modules, 'kiokuko-dsh'))
    // Reuse installed required dependencies only; do not expose the development
    // node_modules tree or optional DSH peers to this consumer.
    const requiredPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => !manifest.peerDependenciesMeta?.[name]?.optional)
    for (const name of [...Object.keys(manifest.dependencies), ...requiredPeers]) {
      const destination = join(modules, name)
      await mkdir(dirname(destination), {recursive:true})
      await symlink(await realpath(join(root, 'node_modules', name)), destination, 'dir')
    }
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
    await writeFile(join(temporary, 'verify.mjs'), `
      import assert from 'node:assert/strict';
      await assert.rejects(import('@deepseek-ai/dsh-llm'), {code:'ERR_MODULE_NOT_FOUND'});
      const root=await import('kiokuko-dsh'), direct=await import('kiokuko-dsh/dsh');
      assert.deepEqual(Object.keys(root),Object.keys(direct));
      for(const name of Object.keys(root))assert.equal(root[name],direct[name]);
      const core=await import('kiokuko-dsh/core'), lisp=await import('kiokuko-dsh/modules/lisp');
      assert.equal(typeof core.createConfiguredPlugin,'function');assert.equal(lisp.lispModule.id,'lisp');
      const {requestSize}=await import(new URL('./efficiency.js',import.meta.resolve('kiokuko-dsh/dsh')));
      const marker={role:'user',source:{kind:'plugin:kiokuko-dsh',form:'snapshot',sections:[]},content:[{type:'text',text:'[Superseded runtime context]'}]};
      const size=requestSize({messages:[marker,{...marker,source:{kind:'user'}}]});
      assert.equal(size.runtimeContextMarkerCopies,1);assert.equal(size.runtimeContextCopies,0);
      assert.equal(size.runtimeContextMarkerBytes,Buffer.byteLength(JSON.stringify(marker),'utf8'));
      console.log('public exports and marker metrics passed without optional DSH');
    `)
    const child = await exec(process.execPath, ['verify.mjs'], {cwd:temporary, timeout:10000})
    assert.match(child.stdout, /passed without optional DSH/)
  } finally { await rm(temporary, {recursive:true, force:true}) }
})
