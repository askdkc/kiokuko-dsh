import { createHash } from 'node:crypto'
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.cwd()
const workspace = await mkdtemp(join(tmpdir(), 'kiokuko-prepare-repro-'))
const userConfig = join(workspace, 'npmrc')
await writeFile(userConfig, '')

async function copySource(destination) {
  await cp(root, destination, {
    recursive: true,
    filter(source) {
      const rel = relative(root, source)
      if (!rel) return true
      const first = rel.split('/')[0]
      return !['.git', 'node_modules', 'dist', '.kiokuko-dev', '.codex', '.agents', '.claude', '.opencode'].includes(first)
    },
  })
}

async function digestDirectory(directory) {
  const entries = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) entries.push(path)
    }
  }
  await visit(directory)
  entries.sort()
  const digest = createHash('sha256')
  for (const path of entries) {
    const bytes = await readFile(path)
    const mode = (await stat(path)).mode & 0o777
    digest.update(`${relative(directory, path)}\0${mode}\0${bytes.length}\0`)
    digest.update(bytes)
  }
  let bytes = 0
  for (const path of entries) bytes += (await stat(path)).size
  return { hash: digest.digest('hex'), fileCount: entries.length, bytes }
}

async function buildOnce(index) {
  const checkout = join(workspace, `checkout-${index}`)
  const cache = join(workspace, `npm-cache-${index}`)
  await copySource(checkout)
  const npmEnvironment = { ...process.env, npm_config_cache: cache, npm_config_userconfig: userConfig, NPM_CONFIG_USERCONFIG: userConfig }
  delete npmEnvironment.npm_config_allow_scripts
  delete npmEnvironment.NPM_CONFIG_ALLOW_SCRIPTS
  await exec('npm', ['ci', '--ignore-scripts'], {
    cwd: checkout,
    env: npmEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  })
  await exec('npm', ['run', 'prepare'], {
    cwd: checkout,
    env: npmEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  })
  const digest = await digestDirectory(join(checkout, 'dist'))
  return { checkout, digest }
}

try {
  const first = await buildOnce(1)
  const second = await buildOnce(2)
  if (first.digest.hash !== second.digest.hash || first.digest.fileCount !== second.digest.fileCount || first.digest.bytes !== second.digest.bytes) {
    throw new Error(`prepare output is not reproducible: ${JSON.stringify({ first: first.digest, second: second.digest }, null, 2)}`)
  }
  process.stdout.write(`${JSON.stringify({
    status: 'reproducible',
    output: 'dist/',
    ...first.digest,
  }, null, 2)}\n`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
