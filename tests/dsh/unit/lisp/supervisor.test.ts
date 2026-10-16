import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

test('supervisor stops a busy child when the owning host crashes', { timeout: 10000 }, async () => {
  const launch = { command: process.execPath, args: ['-e', 'process.stdout.write(String(process.pid)+"\\n"); for(;;) {}'], env: {}, cwd: '/tmp', protocol: false }
  const supervisor = fileURLToPath(new URL('../../../../lisp/supervisor.mjs', import.meta.url))
  const host = spawn(process.execPath, ['--input-type=module', '-e', `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,${JSON.stringify([supervisor, JSON.stringify(launch)])},{stdio:['pipe','inherit','inherit']}); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let pid: number | undefined
  try {
    const [chunk] = await once(host.stdout!, 'data'); pid = Number(String(chunk).trim())
    assert.ok(Number.isInteger(pid) && pid > 1)
    const exited = once(host, 'exit'); host.kill('SIGKILL'); await exited
    let stopped = false
    for (let i = 0; i < 200; i++) {
      try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { stopped = true; break }; throw error }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(stopped, true, 'busy child survived its host')
  } finally { host.kill('SIGKILL'); if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ } } }
})

test('supervisor sends termination once when Stop and child-exit cleanup overlap', { timeout: 15000 }, async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'lisp-supervisor-stop-'))
  const count = join(base, 'kill-count'), preload = join(base, 'observe-kill.mjs')
  // macOS can return EPERM for a repeated kill of an already killed group.
  // Keep the first real termination; deterministically model only that later race.
  await writeFile(preload, `import {writeFileSync} from 'node:fs';import {ChildProcess} from 'node:child_process';
let count=0;const observe=()=>{writeFileSync(${JSON.stringify(count)},String(++count));if(count>1){const e=new Error('duplicate owned termination');e.code='EPERM';throw e}};
const kill=process.kill;process.kill=function(pid,signal){if(signal==='SIGKILL')observe();return kill.call(this,pid,signal)};
const childKill=ChildProcess.prototype.kill;ChildProcess.prototype.kill=function(signal){if(signal==='SIGKILL')observe();return childKill.call(this,signal)};`)
  const launch = { command: process.execPath, args: ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], env: {}, cwd: base, protocol: false, group: process.platform !== 'win32' }
  const supervisor = fileURLToPath(new URL('../../../../lisp/supervisor.mjs', import.meta.url))
  const host = spawn(process.execPath, ['--import', preload, supervisor, JSON.stringify(launch)], { stdio: ['pipe', 'pipe', 'pipe'] })
  let pid: number | undefined, stderr = ''
  host.stderr!.on('data', chunk => { stderr += String(chunk) })
  try {
    const [chunk] = await once(host.stdout!, 'data'); pid = Number(String(chunk).trim())
    assert.ok(Number.isInteger(pid) && pid > 1)
    const exited = once(host, 'exit')
    if (process.platform === 'win32') host.stdin!.end()
    else host.kill('SIGTERM')
    const [code] = await exited
    assert.equal(stderr, '', 'a redundant stop must not crash the supervisor')
    assert.equal(code, 128)
    assert.equal(await readFile(count, 'utf8'), '1')
    let stopped = false
    for (let n=0;n<200;n++) {
      try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { stopped=true;break };throw error }
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(stopped,true,'the actual owned child must be gone')
  } finally {
    host.kill('SIGKILL')
    if (pid) { try { process.kill(pid,'SIGKILL') } catch { /* this fixture child was already reaped */ } }
    await rm(base,{recursive:true,force:true})
  }
})

test('supervisor reports a first termination permission failure instead of claiming Stop', { timeout: 10000 }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base=await mkdtemp(join(tmpdir(),'lisp-supervisor-denied-')),preload=join(base,'deny-first-kill.mjs')
  await writeFile(preload, `import {ChildProcess} from 'node:child_process';
const denied=()=>{const e=new Error('first owned termination denied');e.code='EPERM';throw e};
const kill=process.kill;process.kill=function(pid,signal){if(signal==='SIGKILL')denied();return kill.call(this,pid,signal)};
const childKill=ChildProcess.prototype.kill;ChildProcess.prototype.kill=function(signal){if(signal==='SIGKILL')denied();return childKill.call(this,signal)};`)
  const supervisor=fileURLToPath(new URL('../../../../lisp/supervisor.mjs',import.meta.url))
  const launch={command:process.execPath,args:['-e','console.log(process.pid);setInterval(()=>{},1000)'],env:{},cwd:base,protocol:false,group:process.platform!=='win32'}
  const host=spawn(process.execPath,['--import',preload,supervisor,JSON.stringify(launch)],{stdio:['pipe','pipe','pipe']})
  let pid:number|undefined,stderr='';host.stderr!.on('data',chunk=>{stderr+=String(chunk)})
  try {
    const [chunk]=await once(host.stdout!,'data');pid=Number(String(chunk).trim());assert.ok(Number.isInteger(pid)&&pid>1)
    const exit=once(host,'exit');if(process.platform==='win32')host.stdin!.end();else host.kill('SIGTERM')
    const [code]=await exit;assert.equal(code,1);assert.match(stderr,/first owned termination denied/)
    assert.doesNotThrow(()=>process.kill(pid!,0),'a genuine permission failure is never reported as a stopped child')
  } finally {
    host.kill('SIGKILL');if(pid){try{process.kill(pid,'SIGKILL')}catch{/* fixture child already gone */}}
    await rm(base,{recursive:true,force:true})
  }
})
