import { access, mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const dsh = process.env.DSH_BIN ?? 'dsh'
const profile = 'kiokuko-e2e'

async function run(command, args, env = {}) {
  return exec(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
  })
}

async function runCordisComposition() {
  await run(process.execPath, ['scripts/run-tests.mjs', 'tests/dsh/e2e/kiokuko-dsh.test.ts'])
}

async function runCliLifecycle() {
  const home = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-home-'))
  const output = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-pack-'))
  const cache = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-cache-'))
  const env = { DSH_HOME: home, npm_config_cache: cache }
  try {
    try {
      await run(dsh, ['--help'], env)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        process.stdout.write(JSON.stringify({ cli: 'unsupported', reason: 'dsh executable is not installed' }) + '\n')
        return
      }
      throw error
    }
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', output], env)).stdout)
    const filename = packed[0]?.filename
    if (typeof filename !== 'string') throw new Error('npm pack did not return a tarball')
    const tarball = join(output, filename)
    await access(tarball)
    await run(dsh, ['plugin', '--profile', profile, 'add', tarball], env)
    const dumped = await run(dsh, ['--profile', profile, '--dump-config'], env)
    if ((dumped.stdout.match(/kiokuko-dsh\/dsh/g) ?? []).length !== 1) {
      throw new Error('dsh dump-config did not contain exactly one Kiokuko bundle')
    }
    await run(dsh, ['plugin', '--profile', profile, 'remove', 'kiokuko-dsh'], env)
    const afterRemove = await run(dsh, ['--profile', profile, '--dump-config'], env)
    if ((afterRemove.stdout.match(/kiokuko-dsh\/dsh/g) ?? []).length !== 0) {
      throw new Error('dsh bundle remained after removal')
    }
    process.stdout.write(JSON.stringify({ cli: 'complete', profile }) + '\n')
  } finally {
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
      rm(cache, { recursive: true, force: true }),
    ])
  }
}

await access(join(root, 'dist/dsh/index.js'))
await access(join(root, 'dsh/cordis.patch.yml'))
await runCordisComposition()
await runCliLifecycle()
