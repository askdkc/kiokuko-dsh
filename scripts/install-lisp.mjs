import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const optional = process.argv.includes('--optional')
async function exists(path) { try { await access(path); return true } catch { return false } }

// Source installs run postinstall before prepare. prepare invokes us after building JS.
if (optional && process.env.CI === 'true' && process.env.KIOKUKO_CI_DEFER_PREPARE === '1') {
  console.error('Deferring Lisp image build to the selected verifier.')
} else if (optional && !await exists(join(root, 'dist/dsh/lisp/installed-runtime.js')) && await exists(join(root, 'tsconfig.build.json'))) {
  console.error('Lisp image will be built after package preparation.')
} else {
  try {
    const { buildInstalledLisp } = await import(pathToFileURL(join(root, 'dist/dsh/lisp/installed-runtime.js')).href)
    const runtime = await buildInstalledLisp(join(root, 'lisp'), process.env.KIOKUKO_LISP_SBCL ?? 'sbcl')
    // prepare can run under npm pack --json; leave stdout for its JSON result.
    console.error(`Standalone Lisp executable ${runtime.reused ? 'verified' : 'built'} (${process.platform}/${process.arch}). Runtime use does not require external SBCL.`)
  } catch (error) {
    const unavailable = ['RUNTIME_MISSING', 'UNSUPPORTED_OS'].includes(error?.code)
    console.error(`Lisp executable build ${optional && unavailable ? 'unavailable' : 'failed'}: ${error?.message ?? error}`)
    console.error('Building Lisp requires SBCL (and bwrap on Linux). After installing these, run npm run lisp:build in the kiokuko-dsh package directory. No runtime was downloaded.')
    if (!optional || !unavailable) process.exitCode = 1
  }
}
