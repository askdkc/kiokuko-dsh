import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const cache = await mkdtemp(join(tmpdir(), 'kiokuko-pack-check-'))

try {
  const result = await exec('npm', ['pack', '--dry-run'], {
    cwd: process.cwd(),
    env: { ...process.env, npm_config_cache: cache },
    maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
} catch (error) {
  if (typeof error?.stdout === 'string') process.stdout.write(error.stdout)
  if (typeof error?.stderr === 'string') process.stderr.write(error.stderr)
  process.exitCode = typeof error?.code === 'number' ? error.code : 1
} finally {
  await rm(cache, { recursive: true, force: true })
}
