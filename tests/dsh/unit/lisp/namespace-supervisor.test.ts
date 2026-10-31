import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { processIdentity, sameProcess } from '../../../../lisp/process-identity.mjs'
import { claimRepository } from '../../../../lisp/repository-owner.mjs'
import { sandboxLaunch } from '../../../../src/dsh/lisp/sandbox.js'

// Real processes model bwrap's monitor/setup/init ownership boundary. This is
// not a Linux namespace or protected-SBCL test; those run in the native lane.
const supervisor = fileURLToPath(new URL('../../../../lisp/supervisor.mjs', import.meta.url))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, message: string, ms = 2500) {
  const deadline = Date.now() + ms
  while (!check()) { assert.ok(Date.now() < deadline, message); await delay(10) }
}
function kill(pid: number | undefined, identity: string | undefined) {
  if (pid && identity && processIdentity(pid) === identity) try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}
async function fixture(reportDelay: number, options: { reportPid?: number; payload?: string; monitorExit?: boolean; denyKill?: boolean; hostOwner?: boolean; repository?: boolean; detachedStdio?: boolean; exitAfterReport?: boolean; identityLookupError?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'namespace-supervisor-'))
  const script = join(base, 'monitor.py')
  await writeFile(script, `import os,sys,time,json,subprocess
child=subprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(30)'],start_new_session=True${options.detachedStdio ? ',stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL' : ''})
print('monitor:'+str(os.getpid()),flush=True)
print('child:'+str(child.pid),flush=True)
${options.monitorExit ? 'sys.exit(0)' : ''}
time.sleep(${reportDelay})
os.write(5,${options.payload !== undefined ? `${JSON.stringify(options.payload)}.encode()` : `json.dumps({'child-pid':${options.reportPid ?? 'child.pid'}}).encode()`})
os.close(5)
print('reported',flush=True)
${options.exitAfterReport ? 'sys.exit(0)' : ''}
sys.exit(child.wait())
`)
  const launch = { command: '/usr/bin/python3', args: ['-I', script], env: {}, cwd: base, protocol: false, namespaceInfo: true, ...(options.repository ? { repositoryRoot: base } : {}) }
  const args = [supervisor, JSON.stringify(launch)]
  if (options.denyKill) {
    const preload = join(base, 'denied.mjs')
    await writeFile(preload, `const kill=process.kill;process.kill=function(pid,signal){if(signal==='SIGKILL'){const error=new Error('fixture denied');error.code='EPERM';throw error}return kill.call(this,pid,signal)}`)
    args.unshift('--import', preload)
  }
  if (options.identityLookupError) {
    const fake = join(base, 'identity.mjs'), preload = join(base, 'identity-error.mjs')
    const identity = new URL('./process-identity.mjs', pathToFileURL(supervisor)).href
    await writeFile(fake, `export{sameProcess}from ${JSON.stringify(identity)};export function processIdentity(){throw new Error('fixture identity lookup failed')}`)
    await writeFile(preload, `import{registerHooks}from'node:module';registerHooks({resolve(spec,context,next){if(spec==='./process-identity.mjs'&&context.parentURL===${JSON.stringify(pathToFileURL(supervisor).href)})return{url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true};return next(spec,context)}})`)
    args.unshift('--import', preload)
  }
  if (options.hostOwner) {
    const driver = join(base, 'owner.mjs')
    await writeFile(driver, `import {spawn} from 'node:child_process';const child=spawn(process.execPath,${JSON.stringify(args)},{stdio:['pipe','inherit','inherit']});console.log('helper:'+child.pid);setInterval(()=>{},1000)`)
    args.splice(0, args.length, driver)
  }
  const host = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'] })
  const exited = once(host, 'exit'), closed = once(host, 'close')
  let output = '', stderr = '', control = '', didClose = false, didExit = false
  host.stdout!.on('data', chunk => { output += String(chunk) })
  host.stderr!.on('data', chunk => { stderr += String(chunk) })
  ;(host.stdio[4] as NodeJS.ReadableStream).on('data', chunk => { control += String(chunk) })
  void closed.then(() => { didClose = true })
  void exited.then(() => { didExit = true })
  let childPid: number | undefined, monitorPid: number | undefined, helperPid: number | undefined
  let childIdentity: string | undefined, monitorIdentity: string | undefined, helperIdentity: string | undefined
  return { host, exited, closed, base, get output() { return output }, get stderr() { return stderr }, get control() { return control }, get didClose() { return didClose }, get didExit() { return didExit },
    async started() {
      await until(() => /child:(\d+)/.test(output), 'fixture child did not start')
      childPid = Number(/child:(\d+)/.exec(output)![1]); childIdentity = processIdentity(childPid)
      monitorPid = Number(/monitor:(\d+)/.exec(output)![1]); monitorIdentity = processIdentity(monitorPid)
      if (options.hostOwner) { helperPid = Number(/helper:(\d+)/.exec(output)![1]); helperIdentity = processIdentity(helperPid) }
      return childPid
    },
    async cleanup() {
      kill(childPid, childIdentity); kill(monitorPid, monitorIdentity); kill(helperPid, helperIdentity)
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
      await until(() => didClose, 'fixture stdio cleanup did not finish')
      await closed; await rm(base, { recursive: true, force: true })
    },
  }
}

for (const mode of ['missing', 'malformed', 'identity lookup error', 'closed diagnostics'] as const) {
  test(`namespace Stop retains ownership after stdin EOF and monitor exit: ${mode}`, { timeout: 10000 }, async () => {
    const f = await fixture(0.3, { detachedStdio: true, exitAfterReport: true,
      ...(mode === 'missing' || mode === 'closed diagnostics' ? { payload: '' } : mode === 'malformed' ? { payload: '{' } : { identityLookupError: true }) })
    try {
      const pid = await f.started(), identity = processIdentity(pid)
      assert.ok(identity)
      if (mode === 'closed diagnostics') f.host.stderr!.destroy()
      f.host.stdin!.end()
      await until(() => f.output.includes('reported') && (mode === 'closed diagnostics' || f.stderr.includes('LISP_STOP_UNCONFIRMED')), 'fixture did not reach unconfirmed monitor exit')
      await delay(200)
      assert.equal(f.didExit, false, JSON.stringify({ supervisorExited: f.didExit, stdioClosed: f.didClose, ownedChildAlive: sameProcess(pid, identity) }))
      assert.equal(sameProcess(pid, identity), true, 'this real child must not be labelled stopped')
    } finally { await f.cleanup() }
  })
}

test('owning host crash before namespace ownership arrives still drains the actual child', { timeout: 10000 }, async () => {
  const f = await fixture(0.4, { hostOwner: true })
  try {
    const pid = await f.started(), identity = processIdentity(pid)
    assert.ok(identity)
    f.host.kill('SIGKILL')
    await until(() => f.didClose, 'owning host crash left its namespace child holding stdio')
    assert.equal(sameProcess(pid, identity), false)
    assert.equal(f.stderr, '')
  } finally { await f.cleanup() }
})

for (const mode of ['malformed', 'missing', 'oversized', 'monitor exited', 'permission denied'] as const) {
  test(`namespace Stop stays unconfirmed for ${mode}`, { timeout: 10000 }, async () => {
    const f = await fixture(0.05, mode === 'malformed' ? { payload: '{' } : mode === 'missing' ? { payload: '' }
      : mode === 'oversized' ? { payload: 'x'.repeat(17000) } : mode === 'monitor exited' ? { monitorExit: true } : { denyKill: true })
    try {
      const pid = await f.started(), identity = processIdentity(pid)
      assert.ok(identity)
      f.host.kill('SIGTERM')
      await until(() => f.stderr.includes('LISP_STOP_UNCONFIRMED'), 'missing refusal evidence')
      await delay(100)
      assert.equal(f.didClose, false, 'unconfirmed termination cannot release the consumer')
      assert.equal(sameProcess(pid, identity), true, 'the fixture proves that no real termination was observed')
    } finally { await f.cleanup() }
  })
}

test('a foreign PID report never authorizes signalling an unrelated process', { timeout: 10000 }, async () => {
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const exited = once(sentinel, 'exit')
  const sentinelPid = sentinel.pid
  assert.ok(sentinelPid)
  const f = await fixture(0.05, { reportPid: sentinelPid })
  try {
    await f.started()
    const identity = processIdentity(sentinel.pid!)
    assert.ok(identity)
    f.host.kill('SIGTERM')
    await until(() => f.stderr.includes('unowned sandbox child report'), 'foreign PID was not rejected')
    assert.equal(f.didClose, false)
    assert.equal(sameProcess(sentinel.pid!, identity), true)
  } finally {
    try { await f.cleanup() } finally { sentinel.kill('SIGKILL'); await exited }
  }
})

test('repository ownership follows the actual namespace runtime across supervisor loss', { timeout: 10000 }, async () => {
  const f = await fixture(0.05, { repository: true })
  try {
    const pid = await f.started()
    await until(() => f.control.includes('\n'), 'runtime ownership was not reported')
    assert.equal(JSON.parse(f.control).pid, pid, 'the monitor PID is not the namespace runtime identity')
    f.host.kill('SIGKILL'); await f.exited
    assert.throws(() => claimRepository(f.base), /REPOSITORY_IN_USE/, 'an orphaned live runtime cannot donate repository ownership')
  } finally { await f.cleanup() }
})

test('Linux launch plan reserves a private ownership fd without changing sandbox protection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'namespace-launch-plan-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, path = process.env.PATH
  try {
    const scratch = join(base, 'scratch'), inputs = join(base, 'inputs'), cache = join(base, 'cache')
    for (const directory of [scratch, inputs, cache]) await mkdir(directory)
    // Executable discovery only; this stand-in is never executed.
    await writeFile(join(base, 'bwrap'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    process.env.PATH = base
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    const plan = await sandboxLaunch({ base, scratch, inputs, cache, library: base, protected: true }, process.execPath, [], 'generation')
    assert.equal(plan.namespaceInfo, true)
    for (const flag of ['--unshare-all', '--die-with-parent', '--new-session']) assert.ok(plan.args.includes(flag))
    assert.equal(plan.args[plan.args.indexOf('--info-fd') + 1], '5')
    assert.equal(plan.args[plan.args.indexOf('--seccomp') + 1], '4')
    assert.equal(plan.seccompPath, join(base, 'network.bpf'))
    assert.ok(!plan.group, 'a process group cannot stand in for namespace ownership')
  } finally {
    Object.defineProperty(process, 'platform', platform)
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path
    await rm(base, { recursive: true, force: true })
  }
})

for (const cause of ['signal before report', 'parent pipe before report', 'signal after report'] as const) {
  test(`supervisor drains owned namespace child on ${cause}`, { timeout: 10000 }, async () => {
    const f = await fixture(cause === 'signal after report' ? 0 : 0.4)
    try {
      const pid = await f.started(), identity = processIdentity(pid)
      assert.ok(identity)
      if (cause === 'signal after report') await until(() => f.output.includes('reported'), 'fixture ownership report did not finish')
      if (cause === 'parent pipe before report') f.host.stdin!.end()
      else f.host.kill('SIGTERM')
      try { await until(() => f.didClose, 'supervisor exited without draining the owned child stdio') }
      catch (error) { throw new Error(JSON.stringify({ supervisorExited: f.didExit, stdioClosed: f.didClose, ownedChildAlive: sameProcess(pid, identity) }), { cause: error }) }
      await f.exited
      assert.equal(sameProcess(pid, identity), false, 'the actual owned child must be stopped')
      assert.equal(f.stderr, '')
    } finally { await f.cleanup() }
  })
}
