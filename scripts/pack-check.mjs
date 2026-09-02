import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.cwd()
const cache = await mkdtemp(join(tmpdir(), 'kiokuko-pack-check-cache-'))
const work = await mkdtemp(join(tmpdir(), 'kiokuko-pack-check-'))

const requiredFiles = [
  'LICENSE',
  'README.md',
  'README.ja.md',
  'README.zh-CN.md',
  'README.ko.md',
  'PERMISSIONS.md',
  'dsh/cordis.patch.yml',
  'dist/dsh/index.js',
  'dist/dsh/index.d.ts',
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

function relativeModuleSpecifiers(source) {
  const specs = []
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\bexport\s+(?:\*|\{[^}]*\})\s+from\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier?.startsWith('.')) specs.push(specifier)
  }
  return specs
}

async function assertRelativeClosure(packageRoot, files) {
  const sourceFiles = files
    .map((entry) => entry.path)
    .filter((file) => file.startsWith('dist/') && /\.(?:[cm]?js|d\.ts)$/.test(file))
  const missing = []
  for (const file of sourceFiles) {
    const absolute = join(packageRoot, file)
    const source = await readFile(absolute, 'utf8')
    for (const specifier of relativeModuleSpecifiers(source)) {
      const target = resolve(dirname(absolute), specifier)
      const candidates = [target]
      if (extname(target) === '') {
        candidates.push(`${target}.js`, `${target}.mjs`, `${target}.cjs`, `${target}.json`, join(target, 'index.js'))
      }
      let found = false
      for (const candidate of candidates) {
        try {
          await access(candidate)
          found = true
          break
        } catch {
          // Try the next Node/TypeScript output representation.
        }
      }
      if (!found) missing.push({ file, specifier })
    }
  }
  if (missing.length > 0) throw new Error(JSON.stringify({ missingRelativeImports: missing }, null, 2))
}

async function createAndSmokeTestTarball() {
  const packageOutput = join(work, 'package-output')
  const extractRoot = join(work, 'extract')
  const consumerRoot = join(work, 'consumer')
  await Promise.all([mkdir(packageOutput), mkdir(extractRoot), mkdir(consumerRoot)])
  const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', packageOutput, '--ignore-scripts'], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache },
    maxBuffer: 16 * 1024 * 1024,
  })).stdout)
  const filename = packed[0]?.filename
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('npm pack did not produce a tarball')
  const tarball = join(packageOutput, filename)
  await exec('tar', ['-xzf', tarball, '-C', extractRoot])
  const packageRoot = join(extractRoot, 'package')
  await symlink(join(root, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')
  await assertRelativeClosure(packageRoot, packed[0]?.files ?? [])

  const smokeCode = "const plugin = await import('kiokuko-dsh/dsh'); if (plugin.name !== 'kiokuko-dsh') throw new Error('unexpected plugin name'); if ('default' in plugin) throw new Error('unexpected default export');"
  const smokePath = join(consumerRoot, 'import-smoke.mjs')
  await mkdir(join(consumerRoot, 'node_modules'))
  await symlink(packageRoot, join(consumerRoot, 'node_modules', 'kiokuko-dsh'), 'dir')
  await writeFile(smokePath, smokeCode, 'utf8')
  await exec(process.execPath, [smokePath], { cwd: consumerRoot, maxBuffer: 1024 * 1024 })
  return { filename, fileCount: packed[0]?.files?.length ?? 0, packageSize: packed[0]?.size, unpackedSize: packed[0]?.unpackedSize }
}

try {
  await access(join(root, 'dist/dsh/index.js'))
  await access(join(root, 'dist/dsh/index.d.ts'))
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
  if (metadata?.name !== 'kiokuko-dsh') throw new Error('packed package has an unexpected name')
  if (metadata?.version === undefined) throw new Error('packed package has no version')
  const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (packageManifest.bin !== undefined) throw new Error('generic CLI binary must not be public')
  const exportsKeys = Object.keys(packageManifest.exports ?? {})
  if (exportsKeys.length !== 1 || exportsKeys[0] !== './dsh') throw new Error('public exports must contain only ./dsh')
  const smoke = await createAndSmokeTestTarball()
  process.stdout.write(`${JSON.stringify({
    name: metadata.name,
    version: metadata.version,
    fileCount: smoke.fileCount,
    packageSize: metadata.size,
    unpackedSize: metadata.unpackedSize,
    requiredFiles,
    importSmoke: 'passed',
    relativeClosure: 'passed',
  }, null, 2)}\n`)
} catch (error) {
  if (typeof error?.stdout === 'string') process.stdout.write(error.stdout)
  if (typeof error?.stderr === 'string') process.stderr.write(error.stderr)
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = typeof error?.code === 'number' ? error.code : 1
} finally {
  await Promise.all([
    rm(cache, { recursive: true, force: true }),
    rm(work, { recursive: true, force: true }),
  ])
}
