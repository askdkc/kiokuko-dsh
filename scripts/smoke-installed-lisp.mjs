import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2])
const load = name => import(pathToFileURL(join(root, `dist/dsh/lisp/${name}.js`)).href)
const [{ installedLispRuntime }, { LispWorker }, { prepareLayout }, { LispConfig }] = await Promise.all(
  ['installed-runtime', 'worker', 'sandbox', 'contracts'].map(load))
const library = join(root, 'lisp'), runtime = await installedLispRuntime(library)
assert.ok(runtime, 'npm lifecycle must produce a verified executable')
const base = await mkdtemp(join(tmpdir(), 'packed-lisp-image-'))
let worker
try {
  const layout = await prepareLayout(base, library)
  layout.compiled = runtime.path; layout.runtimeExecutable = runtime.executable
  worker = new LispWorker(layout, LispConfig.parse({ sbclPath: '/external-sbcl-must-not-be-used', startupTimeoutMs: 60000 }))
  await worker.start()
  const result = await worker.request('eval', { code: '(funcall (compile nil (lambda (x) (+ x 1))) 41)' }, 10000)
  assert.equal(result.ok, true); assert.equal(result.value.printed, '(42)')
  console.log('Installed package: standalone Lisp starts and compiles new code without external SBCL.')
} finally { await worker?.stop(); await rm(base, { recursive: true, force: true }) }
