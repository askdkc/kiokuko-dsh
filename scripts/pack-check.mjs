import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.cwd()
const cache = await mkdtemp(join(tmpdir(), 'kiokuko-pack-check-cache-'))

const requiredFiles = [
  'LICENSE',
  'README.md',
  'README.ja.md',
  'README.zh-CN.md',
  'README.ko.md',
  'PERMISSIONS.md',
  'dsh/cordis.patch.yml',
  'dist/bin/kiokuko.js',
  'dist/dsh/index.js',
]
const requiredDirectories = ['dist/', 'migrations/', 'skills/', 'docs/', 'templates/']
const forbiddenPrefixes = [
  'src/',
  'tests/',
  'node_modules/',
  '.git/',
  '.codex/',
  '.agents/',
  '.claude/',
  '.opencode/',
  'PLAN.md',
]

function parsePackJson(stdout) {
  const start = stdout.indexOf('[')
  if (start < 0) throw new Error('npm pack did not return JSON metadata')
  return JSON.parse(stdout.slice(start))
}

try {
  await access(join(root, 'dist/bin/kiokuko.js'))
  await access(join(root, 'dist/dsh/index.js'))
  const result = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache },
    maxBuffer: 16 * 1024 * 1024,
  })
  const metadata = parsePackJson(result.stdout)[0]
  const files = metadata?.files ?? []
  const paths = new Set(files.map((entry) => entry.path))
  const missing = requiredFiles.filter((file) => !paths.has(file))
  const missingDirectories = requiredDirectories.filter((directory) => !files.some((entry) => entry.path.startsWith(directory)))
  const forbidden = files.map((entry) => entry.path).filter((file) => forbiddenPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)))
  if (missing.length > 0 || missingDirectories.length > 0 || forbidden.length > 0) {
    throw new Error(JSON.stringify({ missing, missingDirectories, forbidden }, null, 2))
  }
  const binary = files.find((entry) => entry.path === 'dist/bin/kiokuko.js')
  if (binary?.mode !== 0o755) throw new Error(`dist/bin/kiokuko.js is not executable (mode ${binary?.mode ?? 'missing'})`)

  process.stdout.write(`${JSON.stringify({
    name: metadata.name,
    version: metadata.version,
    fileCount: files.length,
    packageSize: metadata.size,
    unpackedSize: metadata.unpackedSize,
    requiredFiles,
    sizePolicy: 'reported-only; DSH STORE automatic 2 MiB source bound is not a package gate',
  }, null, 2)}\n`)
} catch (error) {
  if (typeof error?.stdout === 'string') process.stdout.write(error.stdout)
  if (typeof error?.stderr === 'string') process.stderr.write(error.stderr)
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = typeof error?.code === 'number' ? error.code : 1
} finally {
  await rm(cache, { recursive: true, force: true })
}
