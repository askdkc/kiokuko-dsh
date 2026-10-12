import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)

test('published full and core entry points load without optional native model peers', async () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const unavailable = new Set(['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai']);
    registerHooks({ resolve(specifier, context, nextResolve) {
      if ([...unavailable].some(name => specifier === name || specifier.startsWith(name + '/'))) throw new Error('Public entry attempted to load unavailable host peer: ' + specifier);
      return nextResolve(specifier, context);
    }});
    for (const specifier of ['kiokuko-dsh/dsh', 'kiokuko-dsh/core']) {
      const entry = await import(specifier);
      assert.equal(typeof entry.apply, 'function');
      assert.equal(entry.Config.safeParse({}).success, true);
    }
    console.log('public entries available without native peers');
  `
  const result = await exec(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(), timeout: 30_000,
  })
  assert.match(result.stdout, /public entries available without native peers/)
})
