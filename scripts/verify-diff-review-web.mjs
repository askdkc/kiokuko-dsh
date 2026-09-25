// Disposable installed-package Web fixture. No user profile or provider credentials.
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, writeFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
const repository = resolve(import.meta.dirname, '..')
const base = await realpath(await mkdtemp(join(tmpdir(), 'kiokuko-diff-web-')))
process.once('exit', () => rmSync(base, { recursive: true, force: true }))
const project = join(base, 'project')
const dsh = process.env.DSH_BIN ?? join(repository, 'tests/fixtures/dsh-runtime/node_modules/.bin/dsh')
for (const name of ['project', 'home', 'dsh', 'data', 'npm-cache']) await mkdir(join(base, name))
const env = { ...process.env, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), KIOKUKO_DATA_DIR: join(base, 'data'), npm_config_cache: join(base, 'npm-cache') }
await exec('git', ['init', '-q'], { cwd: project })
await writeFile(join(project, 'sample.txt'), 'before\n')
await exec('git', ['add', 'sample.txt'], { cwd: project })
await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd: project })
await writeFile(join(project, 'sample.txt'), 'after\n')
await exec('npm', ['run', 'build'], { env, cwd: repository, maxBuffer: 8 * 1024 ** 2 })
const pack = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', base, '--json'], { env, cwd: repository, maxBuffer: 8 * 1024 ** 2 })
const archive = join(base, JSON.parse(pack.stdout)[0].filename)
await exec(dsh, ['plugin', '--profile', 'web', 'add', archive, '--force'], { env, cwd: project, maxBuffer: 8 * 1024 ** 2 })
const fixture = join(base, 'workspace-fixture.mjs')
await writeFile(fixture, `export const name = 'diff-review-workspace-fixture';
export const inject = ['workspaceRegistry'];
export async function apply(ctx) { await ctx.workspaceRegistry.create(${JSON.stringify(project)}, 'Diff review fixture'); }
`)
const patch = join(base, 'patch.yml')
await writeFile(patch, `- id: kiokuko-dsh
  config:
    enabled: true
    orca: { enabled: false }
- insert:
    - id: diff-review-workspace-fixture
      name: ${JSON.stringify(fixture)}
      inject: [workspaceRegistry]
`)
const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version
console.log(`Installed kiokuko-dsh ${version} from ${archive}`)
console.log(`Disposable profile: ${base}`)
console.log('Open the Web URL below; use Start > Diff レビュー, then 差分を取得. Ctrl+C stops this fixture.')
const child = spawn(dsh, ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], { env, cwd: project, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code ?? 1 })
