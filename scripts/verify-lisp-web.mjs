// Disposable installed-package Web fixture. No provider credentials or user profile.
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const exec = promisify(execFile), repository = resolve(import.meta.dirname, '..')
const base = await realpath(await mkdtemp(join(tmpdir(), 'kioku-lisp-web-')))
const project = join(base, 'project'), dsh = process.env.DSH_BIN ?? join(repository, 'tests/fixtures/dsh-runtime/node_modules/.bin/dsh')
for (const name of ['project', 'home', 'dsh', 'data']) await mkdir(join(base, name))
const env = { ...process.env, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), KIOKUKO_DATA_DIR: join(base, 'data') }
await writeFile(join(project, 'fixture-delete.txt'), 'Recoverable verification fixture.\n')
await exec('npm', ['run', 'build'], { cwd: repository, maxBuffer: 8 * 1024 ** 2 })
const pack = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', base, '--json'], { cwd: repository, maxBuffer: 8 * 1024 ** 2 })
const archive = join(base, JSON.parse(pack.stdout)[0].filename)
await exec(dsh, ['plugin', '--profile', 'web', 'add', archive, '--force'], { env, cwd: project, maxBuffer: 8 * 1024 ** 2 })
const fixture = join(base, 'fixture.mjs')
await writeFile(fixture, `import {randomUUID} from 'node:crypto';
export const name='lisp-web-fixture';
export const inject=['workspaceRegistry','commands','tools'];
export async function apply(ctx) {
  await ctx.workspaceRegistry.create(${JSON.stringify(project)}, 'Lisp verification');
  ctx.commands.register({name:'lisp-fixture',description:'Temporary local Lisp verification',input:{hint:'delete | timeout'},handler:async request=>{
    const code=request.rawInput.trim()==='timeout'?'(loop)':'(kioku.files:propose-delete "fixture-delete.txt")';
    const result=await ctx.tools.execute({name:'lisp_eval',callId:randomUUID(),agent:request.agent,signal:request.signal,arguments:{operationId:randomUUID(),code,timeoutMs:code==='(loop)'?100:10000}});
    return {kind:'success',text:JSON.stringify(result)};
  }});
}`)
const patch = join(base, 'patch.yml')
await writeFile(patch, `- id: kiokuko-dsh
  config:
    enabled: true
    orca: {enabled: false}
    lisp:
      enabled: true
      sbclPath: ${JSON.stringify(process.env.KIOKUKO_LISP_SBCL ?? 'sbcl')}
      startupTimeoutMs: 60000
- insert:
    - id: lisp-web-fixture
      name: ${JSON.stringify(fixture)}
      inject: [workspaceRegistry, commands, tools]
`)
const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version
console.log(`Installed kiokuko-dsh ${version}. Evidence directory: ${base}`)
console.log('In Web: /kioku-lisp enable; /lisp-fixture delete (deny, then allow); /lisp-fixture timeout; use recovery control. No API key is required. Ctrl+C stops this test host; evidence/backups remain.')
const child = spawn(dsh, ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], { env, cwd: project, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code ?? 1 })
