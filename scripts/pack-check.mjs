import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Script } from 'node:vm'
import { satisfies } from 'semver'

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
  'dist/index.js',
  'dist/index.d.ts',
  'dist/client.cjs',
  'dist/client.d.ts',
  'dist/dsh/index.js',
  'dist/dsh/index.d.ts',
  'skills/japanese-translation-for-oss-models/SKILL.md',
]
const requiredDirectories = ['dist/', 'migrations/', 'skills/', 'docs/']
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
  'dist/bin/',
  'dist/commands/',
  'dist/mcp/',
  'dist/web/',
  'dist/server/',
  'dist/setup/',
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

async function assertDshClientArtifact(packageRoot) {
  const source = await readFile(join(packageRoot, 'dist/client.cjs'), 'utf8')
  const registrations = []
  const window = {
    __ModuleLoader__: {
      load(handoff) {
        registrations.push(handoff)
      },
    },
  }
  new Script(source, { filename: 'dist/client.cjs' }).runInNewContext({ window }, { timeout: 5_000 })
  if (registrations.length !== 1 || registrations[0]?.id !== 'kiokuko-dsh' || typeof registrations[0]?.factory !== 'function') {
    throw new Error('dist/client.cjs is not one Kiokuko DSH lazy-CJS registration')
  }
  const requested = []
  const client = registrations[0].factory((specifier) => {
    requested.push(specifier)
    return {}
  })
  if (typeof client?.apply !== 'function' || typeof client?.downloadDshSessionLog !== 'function') {
    throw new Error('Kiokuko DSH client factory did not expose its browser surface')
  }
  const expected = [
    '@deepseek-ai/dsh-client-store',
    'react/jsx-runtime',
    'react',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  if (JSON.stringify(requested) !== JSON.stringify(expected)) {
    throw new Error(`Kiokuko DSH client factory requested an unexpected module set: ${JSON.stringify(requested)}`)
  }
}

async function createAndSmokeTestTarball() {
  const packageOutput = join(work, 'package-output')
  const extractRoot = join(work, 'extract')
  const consumerRoot = join(work, 'consumer')
  await Promise.all([mkdir(packageOutput), mkdir(extractRoot), mkdir(consumerRoot)])
  const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', packageOutput, '--ignore-scripts'], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache, npm_config_dry_run: 'false' },
    maxBuffer: 16 * 1024 * 1024,
  })).stdout)
  const filename = packed[0]?.filename
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('npm pack did not produce a tarball')
  const tarball = join(packageOutput, filename)
  await exec('tar', ['-xzf', tarball, '-C', extractRoot])
  const packageRoot = join(extractRoot, 'package')
  await symlink(join(root, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')
  await assertRelativeClosure(packageRoot, packed[0]?.files ?? [])
  await assertDshClientArtifact(packageRoot)

  const smokeCode = `
    const root = await import('kiokuko-dsh');
    const plugin = await import('kiokuko-dsh/dsh');
    if (plugin.name !== 'kiokuko-dsh') throw new Error('unexpected plugin name');
    if (typeof root.DshSessionLogExportService !== 'function') throw new Error('missing root export service');
    if ('default' in plugin) throw new Error('unexpected default export');
    const japanese = await import(new URL('./japanese-output-skill.js', import.meta.resolve('kiokuko-dsh/dsh')));
    const skill = await japanese.loadJapaneseOutputSkill();
    const prompt = await japanese.applyJapaneseOutputSkill({sections:[],variables:{model:'qwen3-coder'}});
    if (skill.name !== 'natural-japanese-output' || !prompt.variables.kiokuko_natural_japanese_output.includes(skill.content)) throw new Error('packed Japanese Skill delivery failed');
    const { createStandardSkillProvider } = await import(new URL('./standard-skill-provider.js', import.meta.resolve('kiokuko-dsh/dsh')));
    const { buildDshMessageSources } = await import(new URL('./message-sources.js', import.meta.resolve('kiokuko-dsh/dsh')));
    const provider = createStandardSkillProvider();
    try {
      const { candidates } = await provider.list({});
      if (!candidates.some(candidate => candidate.name === 'veteran-programmer-skill')) throw new Error('packed veteran Skill is missing');
    const sources = await buildDshMessageSources({
        task: 'Continue the approved plan.', intakeStatus: 'ready', nextAction: 'proceed', context: null,
        memoryPolicy: { memoryReasoningRequired: true, contextWithheld: false },
        routeSkillNames: candidates.map(candidate => candidate.name),
      });
      for (const candidate of candidates) {
        const definition = await provider.get(candidate, {});
        if (!definition || !sources.some(source => source.name === candidate.name && source.text.includes(definition.content))) {
          throw new Error('packed Skill route delivery failed: ' + candidate.name);
        }
      }
    } finally { provider.dispose(); }
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = (await import('node:os')).default;
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.resolve('kiokuko-dsh/dsh'));
    const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
    const { loadStandardSkillParity } = await import(new URL('./standard-skill-integrity.js', import.meta.resolve('kiokuko-dsh/dsh')));
    const parity = await loadStandardSkillParity();
    const home = path.join(process.cwd(), 'skill-home');
    const deployed = path.join(home, '.agents', 'skills');
    const soul = parity.files.find(file => file.skillName === 'kiokuko-soul');
    const soulPath = path.join(deployed, soul.skillName, soul.relativePath);
    await fs.mkdir(path.dirname(soulPath), { recursive: true });
    await fs.writeFile(soulPath, soul.managedMarker + '\\nold soulRead requestId contract');
    const agentsPath = path.join(process.cwd(), 'AGENTS.md');
    await fs.writeFile(agentsPath, 'user prefix\\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->\\nsoulRead: true; create requestId\\n<!-- END KIOKUKO MANAGED BLOCK -->\\nuser suffix');
    const homedir = os.homedir;
    os.homedir = () => home;
    try {
      const context = new Context();
      const fiber = context.plugin(plugin, {});
      await fiber;
      try {
        const agents = await fs.readFile(agentsPath, 'utf8');
        if (agents.includes('soulRead') || agents.includes('requestId') || !agents.includes('host operations, not model tools') || !agents.startsWith('user prefix') || !agents.endsWith('user suffix')) {
          throw new Error('packed startup AGENTS.md migration failed');
        }
        const { execFileSync } = await import('node:child_process');
        const setupScript = new URL('../../scripts/setup-dsh.mjs', import.meta.resolve('kiokuko-dsh/dsh'));
        const { fileURLToPath } = await import('node:url');
        const checked = JSON.parse(execFileSync(process.execPath, [fileURLToPath(setupScript), '--home', home, '--cwd', process.cwd(), '--check', '--json'], { encoding: 'utf8' }));
        if (!checked.current || checked.skills.unchanged !== 23) throw new Error('packed setup check failed');
        if (await fs.readFile(path.join(deployed, 'japanese-translation-for-oss-models', 'SKILL.md'), 'utf8') !== skill.content) {
          throw new Error('packed startup Japanese Skill deployment failed');
        }
        for (const file of parity.files) {
          if (await fs.readFile(path.join(deployed, file.skillName, file.relativePath), 'utf8') !== file.content) {
            throw new Error('packed startup Skill deployment failed: ' + file.skillName + '/' + file.relativePath);
          }
        }
      } finally { await fiber.dispose(); }
    } finally { os.homedir = homedir; }
  `
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
  if (paths.has('dist/cli.js')) throw new Error('generic CLI output must not be published')
  if (packageManifest.dependencies?.commander !== undefined || packageManifest.dependencies?.['@modelcontextprotocol/sdk'] !== undefined) {
    throw new Error('DSH package must not depend on generic CLI or MCP runtimes')
  }
  const npmLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const { parse } = await import('yaml')
  const pnpmLock = parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'))
  for (const name of ['@orcareplay/core', '@orcareplay/schema', '@orcareplay/viewer']) {
    const range = packageManifest.dependencies?.[name]
    if (range !== '>=0.2.1') throw new Error(`${name} must allow ordinary runtime releases >=0.2.1`)
    const entry = npmLock.packages[`node_modules/${name}`]
    const pnpmEntry = pnpmLock.importers['.'].dependencies[name]
    if (npmLock.packages[''].dependencies[name] !== range || pnpmEntry?.specifier !== range ||
        typeof entry?.version !== 'string' || !satisfies(entry.version, range) || pnpmEntry.version !== entry.version ||
        typeof entry.integrity !== 'string' || entry.integrity !== pnpmLock.packages[`${name}@${entry.version}`]?.resolution?.integrity) {
      throw new Error(`${name} lockfile tarball integrity mismatch`)
    }
  }
  const exportsKeys = Object.keys(packageManifest.exports ?? {})
  if (JSON.stringify(exportsKeys) !== JSON.stringify(['.', './client', './dsh'])) throw new Error('public exports must contain ., ./client, and ./dsh')
  const smoke = await createAndSmokeTestTarball()
  process.stdout.write(`${JSON.stringify({
    name: metadata.name,
    version: metadata.version,
    fileCount: smoke.fileCount,
    packageSize: metadata.size,
    unpackedSize: metadata.unpackedSize,
    requiredFiles,
    importSmoke: 'passed',
    dshClientArtifact: 'passed',
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
