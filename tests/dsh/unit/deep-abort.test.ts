import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { withDeepAbort } from '../../../src/deep-thinker/abortable-stream.js'

for(const [name,path,symbol] of [['Deep','../../../src/deep-thinker/abortable-stream.ts','withDeepAbort'],['boundary','../../../src/dsh/boundary-worker.ts','abortable']])test(`pre-cancelled ${name} wait still observes the rejected operation`, () => {
  const source = new URL(path!, import.meta.url).href
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {${symbol} as withDeepAbort} from ${JSON.stringify(source)};
    let unhandled=0; process.on('unhandledRejection',()=>unhandled++);
    const c=new AbortController();c.abort(new Error('cancelled'));
    try {await withDeepAbort(Promise.reject(new Error('late failure')),c.signal)} catch(e) {if(e!==c.signal.reason)throw e}
    await new Promise(resolve=>setImmediate(resolve));console.log(JSON.stringify({unhandled}));
  `], { encoding: 'utf8', timeout: 5000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout.trim()).unhandled, 0)
})

test('Deep cancellation rejects promptly and observes a later operation failure', async () => {
  const c = new AbortController()
  let reject!: (error: Error) => void
  const pending = withDeepAbort(new Promise((_resolve, fail) => { reject = fail }), c.signal)
  c.abort(new Error('explicit Stop'))
  await assert.rejects(pending, error => error === c.signal.reason)
  reject(new Error('later failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await withDeepAbort(Promise.resolve(42), new AbortController().signal), 42)
})
