import { selectedDshRuntime } from './dsh-fixture-identity.mjs'
import { webTestPort } from './test-web-port.mjs';
// Disposable installed-package Web fixture. No provider credentials or user profile.
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
const exec = promisify(execFile), repository = resolve(import.meta.dirname, '..')
const selected = selectedDshRuntime(repository)
const base = await realpath(await mkdtemp(join(tmpdir(), 'kioku-lisp-web-')))
const project = join(base, 'project'), dsh = selected.environment.DSH_BIN
for (const name of ['project', 'home', 'dsh', 'data']) await mkdir(join(base, name))
const env = { ...selected.environment, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), KIOKUKO_DATA_DIR: join(base, 'data') }
// pnpm 12 requires an explicit build decision before it will run the packed
// plugin's postinstall. This disposable profile must run that script because
// it installs the standalone Lisp runtime exercised by the Web acceptance.
const webProfile = join(base, 'dsh', 'profiles', 'web')
await mkdir(webProfile, { recursive: true })
await writeFile(join(project, 'fixture-delete.txt'), 'Recoverable verification fixture.\n')
await exec('npm', ['run', 'build'], { cwd: repository, maxBuffer: 8 * 1024 ** 2 })
const pack = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', base, '--json'], { cwd: repository, maxBuffer: 8 * 1024 ** 2 })
const archive = join(base, JSON.parse(pack.stdout)[0].filename)
// Local tarballs require the exact resolved file locator, not only the
// package name, so the approval cannot accidentally cover a different
// archive copied into this disposable profile.
const packedBuildLocator = `kiokuko-dsh@file:${relative(webProfile, archive)}`
await writeFile(join(webProfile, 'pnpm-workspace.yaml'), `allowBuilds:\n  ${JSON.stringify(packedBuildLocator)}: true\n`)
await exec(dsh, ['plugin', '--profile', 'web', 'add', archive, '--force'], { env, cwd: project, maxBuffer: 8 * 1024 ** 2 })
const fixture = join(base, 'fixture.mjs')
await writeFile(fixture, `import {randomUUID} from 'node:crypto';
export const name='lisp-web-fixture';
export const inject=['workspaceRegistry','commands','tools','agents'];
export async function apply(ctx) {
  await ctx.workspaceRegistry.create(${JSON.stringify(project)}, 'Lisp verification');
  ctx.commands.register({name:'lisp-fixture',description:'Temporary local Lisp verification',input:{hint:'delete | timeout'},handler:async request=>{
    const code=request.rawInput.trim()==='timeout'?'(loop)':'(kioku.files:propose-delete "fixture-delete.txt")';
    const callId=randomUUID();
    const agent=ctx.agents.get(request.agent.id);
    const batch=await ctx.tools.execute({calls:[{type:'tool-call',id:callId,name:'lisp_eval',arguments:JSON.stringify({operationId:randomUUID(),code,timeoutMs:code==='(loop)'?100:10000})}],agent,signal:request.signal});
    const result=batch.results?.find(entry=>entry.callId===callId)?.result;
    if(!result)throw new Error('Lisp fixture tool batch did not settle');
    return {kind:'success',text:JSON.stringify(result)};
  }});
}`)
const patch = join(base, 'patch.yml')
await writeFile(patch, `- id: kiokuko-dsh
  config:
    enabled: true
    agenticReplay: {enabled: false}
    lisp:
      enabled: true
      sbclPath: ${JSON.stringify(process.env.KIOKUKO_LISP_SBCL ?? 'sbcl')}
      startupTimeoutMs: 60000
- insert:
    - id: lisp-web-fixture
      name: ${JSON.stringify(fixture)}
      inject: [workspaceRegistry, commands, tools, agents]
`)
const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version
console.log(`Installed kiokuko-dsh ${version}. Evidence directory: ${base}`)
console.log('In Web: /kioku-lisp enable; /lisp-fixture delete (deny, then allow); /lisp-fixture timeout; use recovery control. No API key is required. Ctrl+C stops this test host; evidence/backups remain.')
const child = spawn(dsh, ['--profile', 'web', '--patch', patch, '--no-open', '--port', webTestPort()], { env, cwd: project, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code ?? 1 })
