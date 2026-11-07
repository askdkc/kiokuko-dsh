// CI dependency installation may defer only this package's duplicate build.
// Dependency lifecycle scripts still run; the selected verifier builds from source.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.env.CI === 'true' && process.env.KIOKUKO_CI_DEFER_PREPARE === '1') {
  console.log('Deferring package prepare build to the selected verifier clean build.')
} else {
  const runner=process.env.npm_execpath
  if (!runner) throw new Error('Run prepare through npm or pnpm.')
  const result=spawnSync(process.execPath,[runner,'run','build'],{stdio:'inherit'})
  if (result.error) throw result.error
  process.exitCode=result.status ?? 1
  if (process.exitCode === 0) {
    const lisp = spawnSync(process.execPath, [fileURLToPath(new URL('./install-lisp.mjs', import.meta.url)), '--optional'], { stdio: 'inherit' })
    if (lisp.error) throw lisp.error
    process.exitCode = lisp.status ?? 1
  }
}
