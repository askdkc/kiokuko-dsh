import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { Duplex } from 'node:stream'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
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
async function fixture(reportDelay: number, options: { coldStartDelay?: number; startDelay?: number; lateSpawn?: boolean; childStartDelay?: number; announceDelay?: number; startTimeout?: number; failBeforeAnnounce?: boolean; reportPid?: number; payload?: string; monitorExit?: boolean; denyKill?: boolean; hostOwner?: boolean; repository?: boolean; detachedStdio?: boolean; exitAfterReport?: boolean; identityLookupError?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'namespace-supervisor-'))
  const script = join(base, 'monitor.py')
  await writeFile(script, `import os,sys,time,json,subprocess,select
def cancelled(seconds):
 return bool(select.select([6],[],[],seconds)[0])
print('monitor:'+str(os.getpid()),flush=True)
print('entered',flush=True)
time.sleep(${options.coldStartDelay ?? 0})
print('spawning',flush=True)
${options.lateSpawn ? `time.sleep(${options.startDelay ?? 0})` : `if cancelled(${options.startDelay ?? 0}): sys.exit(0)`}
child=subprocess.Popen([sys.executable,'-I','-c',${JSON.stringify(`import time,select; time.sleep(${options.childStartDelay ?? 0}); select.select([6],[],[],30)`)}],start_new_session=False,pass_fds=(6,)${options.detachedStdio ? ',stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL' : ''})
with open('spawned.tmp','w') as record: json.dump({'monitor':os.getpid(),'child':child.pid},record)
os.replace('spawned.tmp','spawned.json')
${options.failBeforeAnnounce ? 'sys.exit(23)' : ''}
if cancelled(${options.announceDelay ?? 0}):
 child.wait(); sys.exit(0)
print('monitor:'+str(os.getpid()),flush=True)
print('child:'+str(child.pid),flush=True)
${options.monitorExit ? 'sys.exit(0)' : ''}
if cancelled(${reportDelay}):
 child.wait(); sys.exit(0)
os.write(5,${options.payload !== undefined ? `${JSON.stringify(options.payload)}.encode()` : `json.dumps({'child-pid':${options.reportPid ?? 'child.pid'}}).encode()`})
os.close(5)
print('reported',flush=True)
${options.exitAfterReport ? 'sys.exit(0)' : ''}
sys.exit(child.wait())
`)
  const launch = { command: '/usr/bin/python3', args: ['-I', script], env: {}, cwd: base, protocol: false, namespaceInfo: true, ...(options.repository ? { repositoryRoot: base } : {}) }
  // Fixture EOF remains independent of production Stop. The owned session
  // below also bounds teardown before an inheritor can cooperate with EOF.
  // The fixture anchor is unref'ed and inherits no streams: it must neither
  // hold the tested supervisor alive nor delay the host's close event.
  const lifetime = join(base, 'lifetime.mjs')
  await writeFile(lifetime, `import net from 'node:net';import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
    const spawn=cp.spawn;const anchor=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});anchor.unref();console.log('anchor:'+anchor.pid);cp.spawn=function(command,args,options){const stdio=[...options.stdio];stdio[6]=6;return spawn.call(this,command,args,{...options,stdio})};syncBuiltinESMExports();
    const pipe=new net.Socket({fd:6,readable:true,writable:false});pipe.on('end',()=>process.kill(process.pid,'SIGKILL'));pipe.resume();pipe.unref()`)
  const args = ['--import', lifetime, supervisor, JSON.stringify(launch)]
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
    await writeFile(driver, `import {spawn} from 'node:child_process';const child=spawn(process.execPath,${JSON.stringify(args)},{stdio:['pipe','inherit','inherit','ignore','ignore','ignore',6]});console.log('helper:'+child.pid);setInterval(()=>{},1000)`)
    args.splice(0, args.length, driver)
  }
  const host = spawn(process.execPath, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe', 'ignore', 'pipe'] })
  const cancellation = host.stdio.at(6)
  assert.ok(cancellation instanceof Duplex)
  const exited = once(host, 'exit'), closed = once(host, 'close')
  let output = '', stderr = '', control = '', didClose = false, didExit = false
  host.stdout!.on('data', chunk => { output += String(chunk); observe() })
  host.stderr!.on('data', chunk => { stderr += String(chunk) })
  ;(host.stdio[4] as NodeJS.ReadableStream).on('data', chunk => { control += String(chunk) })
  void closed.then(() => { didClose = true })
  void exited.then(() => { didExit = true })
  const hostIdentity = processIdentity(host.pid!)
  let anchorPid: number | undefined, anchorIdentity: string | undefined
  let childPid: number | undefined, monitorPid: number | undefined, helperPid: number | undefined
  let childIdentity: string | undefined, monitorIdentity: string | undefined, helperIdentity: string | undefined
  let cleanedPids: number[] = []
  function observe() {
    const anchor = Number(/anchor:(\d+)/.exec(output)?.[1])
    if (anchor && !anchorPid) { anchorPid = anchor; anchorIdentity = processIdentity(anchor) }
    for (const name of ['child', 'monitor', 'helper'] as const) {
      const pid = Number(new RegExp(`${name}:(\\d+)`).exec(output)?.[1])
      if (!pid) continue
      if (name === 'child' && !childPid) { childPid = pid; childIdentity = processIdentity(pid) }
      if (name === 'monitor' && !monitorPid) { monitorPid = pid; monitorIdentity = processIdentity(pid) }
      if (name === 'helper' && !helperPid) { helperPid = pid; helperIdentity = processIdentity(pid) }
    }
  }
  const f = { host, exited, closed, base, get output() { return output }, get stderr() { return stderr }, get control() { return control }, get didClose() { return didClose }, get didExit() { return didExit }, get cleanedPids() { return cleanedPids },
    // Reserve half the existing 10s test deadline for cold interpreter startup;
    // assertion and cleanup waits remain bounded separately.
    async started() {
      await until(() => childPid !== undefined, 'fixture child did not start', options.startTimeout ?? 5000)
      return childPid!
    },
    async spawned() { return JSON.parse(await readFile(join(base, 'spawned.json'), 'utf8')) as {monitor: number; child: number} },
    async cleanup() {
      cancellation.end()
      // A birth-identified anchor retains the fixture's private session even if
      // the tested supervisor has already exited. It has no inherited stdio.
      // Never use the sandbox's reported PID as signal authority.
      const anchorAlive = anchorPid && anchorIdentity && sameProcess(anchorPid, anchorIdentity)
      const owner = anchorAlive ? anchorPid! : host.pid!
      const identity = anchorAlive ? anchorIdentity : hostIdentity
      assert.ok(identity && processIdentity(owner) === identity, 'fixture group ownership unavailable')
      const group = Number(execFileSync('/bin/ps', ['-p', String(owner), '-o', 'pgid='], { encoding: 'utf8' }).trim())
      assert.equal(group, host.pid, 'fixture anchor left its owned process group')
      process.kill(-group, 'SIGKILL')
      await until(() => didClose, 'fixture stdio cleanup did not finish')
      await closed
      // Every inheritor has now closed its lifetime fd, so no fixture process
      // can create or announce a later child. Confirm even unannounced PIDs.
      try {
        const owned = await f.spawned()
        cleanedPids = [owned.monitor, owned.child]
        for (const pid of cleanedPids) await until(() => !sameProcess(pid, undefined), 'unannounced fixture process did not stop')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const [pid, identity] of [[anchorPid, anchorIdentity], [childPid, childIdentity], [monitorPid, monitorIdentity], [helperPid, helperIdentity]] as const) {
        if (pid && identity) await until(() => !sameProcess(pid, identity), 'fixture process cleanup did not finish')
      }
      await rm(base, { recursive: true, force: true })
    },
    run<T>(body: () => Promise<T>) { return withCleanup(body, () => f.cleanup()) },
  }
  try { await until(() => !!anchorPid && !!anchorIdentity, 'fixture group anchor did not start', 5000) }
  catch (primary) { await withCleanup(async () => { throw primary }, () => f.cleanup()) }
  return f
}

async function withCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let value: T
  try { value = await body() }
  catch (primary) {
    try { await cleanup() }
    catch (cleanupError) { console.error('fixture primary failure:', primary); console.error('fixture cleanup failure:', cleanupError); throw new AggregateError([primary, cleanupError], 'fixture test and cleanup both failed') }
    throw primary
  }
  await cleanup()
  return value
}

// Cancellation is independent of the readiness announcements and covers a
// child which is still starting or whose monitor already failed.
for (const mode of ['delayed monitor', 'late spawn', 'delayed announcement', 'delayed child', 'failed announcement'] as const) {
  test(`fixture cleanup owns partial startup: ${mode}`, { timeout: 10000 }, async () => {
    const f = await fixture(0.05, { startTimeout: 30,
      ...(mode === 'delayed monitor' ? { coldStartDelay: 3.5 }
        : mode === 'late spawn' ? { startDelay: 0.2, lateSpawn: true }
        : mode === 'delayed child' ? { announceDelay: 0.4, childStartDelay: 0.4 }
        : mode === 'failed announcement' ? { failBeforeAnnounce: true } : { announceDelay: 0.4 }) })
    let monitor: { pid: number; identity: string } | undefined
    let child: { pid: number; identity: string } | undefined
    await assert.rejects(f.run(async () => {
      if (mode === 'delayed monitor') {
        await until(() => f.output.includes('entered'), 'monitor did not enter pre-cooperation phase', 5000)
        const pid = Number(/monitor:(\d+)/.exec(f.output)![1]), identity = processIdentity(pid)
        assert.ok(identity); assert.equal(sameProcess(pid, identity), true)
        monitor = { pid, identity }
        await assert.rejects(f.spawned(), { code: 'ENOENT' })
      }
      if (mode === 'late spawn') await until(() => f.output.includes('spawning'), 'monitor never reached delayed spawn')
      else if (mode !== 'delayed monitor') {
        let spawned: Awaited<ReturnType<typeof f.spawned>> | undefined
        const deadline = Date.now() + 5000
        while (!spawned) {
          try { spawned = await f.spawned() }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          assert.ok(Date.now() < deadline, 'fixture spawn record did not arrive')
          if (!spawned) await delay(10)
        }
        const identity = processIdentity(spawned.child)
        assert.ok(identity); child = { pid: spawned.child, identity }
      }
      await f.started()
    }), { message: 'fixture child did not start' })
    assert.equal(f.didClose, true, 'all stdio, including every inherited lifetime fd, must close')
    if (mode === 'late spawn') assert.equal(f.cleanedPids.length, 0, 'cancellation before the delayed spawn must prevent child creation')
    if (monitor) assert.equal(sameProcess(monitor.pid, monitor.identity), false, 'the entered non-cooperating monitor must be gone')
    if (child) assert.equal(sameProcess(child.pid, child.identity), false, 'even an unannounced child must be gone')
  })
}

test('fixture reports both the primary failure and cleanup failure', async () => {
  const f = await fixture(0.05, { startTimeout: 20, announceDelay: 0.4 })
  const cleanupError = new Error('injected cleanup evidence failure')
  await assert.rejects(withCleanup(() => f.started(), async () => {
    await f.cleanup(); throw cleanupError
  }), error => {
    assert.ok(error instanceof AggregateError)
    assert.match(String(error.errors[0]), /fixture child did not start/)
    assert.equal(error.errors[1], cleanupError)
    return true
  })
  assert.equal(f.didClose, true)
})

for (const mode of ['missing', 'malformed', 'identity lookup error', 'closed diagnostics'] as const) {
  test(`namespace Stop retains ownership after stdin EOF and monitor exit: ${mode}`, { timeout: 10000 }, async () => {
    const f = await fixture(0.3, { detachedStdio: true, exitAfterReport: true,
      ...(mode === 'missing' || mode === 'closed diagnostics' ? { payload: '' } : mode === 'malformed' ? { payload: '{' } : { identityLookupError: true }) })
    await f.run(async () => {
      const pid = await f.started(), identity = processIdentity(pid)
      assert.ok(identity)
      if (mode === 'closed diagnostics') f.host.stderr!.destroy()
      f.host.stdin!.end()
      await until(() => f.output.includes('reported') && (mode === 'closed diagnostics' || f.stderr.includes('LISP_STOP_UNCONFIRMED')), 'fixture did not reach unconfirmed monitor exit')
      await delay(200)
      assert.equal(f.didExit, false, JSON.stringify({ supervisorExited: f.didExit, stdioClosed: f.didClose, ownedChildAlive: sameProcess(pid, identity) }))
      assert.equal(sameProcess(pid, identity), true, 'this real child must not be labelled stopped')
    })
  })
}

test('owning host crash before namespace ownership arrives still drains the actual child', { timeout: 10000 }, async () => {
  const f = await fixture(0.4, { hostOwner: true })
  await f.run(async () => {
    const pid = await f.started(), identity = processIdentity(pid)
    assert.ok(identity)
    f.host.kill('SIGKILL')
    await until(() => f.didClose, 'owning host crash left its namespace child holding stdio')
    assert.equal(sameProcess(pid, identity), false)
    assert.equal(f.stderr, '')
  })
})

for (const mode of ['malformed', 'missing', 'oversized', 'monitor exited', 'permission denied'] as const) {
  test(`namespace Stop stays unconfirmed for ${mode}`, { timeout: 10000 }, async () => {
    const f = await fixture(0.05, mode === 'malformed' ? { payload: '{' } : mode === 'missing' ? { payload: '' }
      : mode === 'oversized' ? { payload: 'x'.repeat(17000) } : mode === 'monitor exited' ? { monitorExit: true } : { denyKill: true })
    await f.run(async () => {
      const pid = await f.started(), identity = processIdentity(pid)
      assert.ok(identity)
      f.host.kill('SIGTERM')
      await until(() => f.stderr.includes('LISP_STOP_UNCONFIRMED'), 'missing refusal evidence')
      await delay(100)
      assert.equal(f.didClose, false, 'unconfirmed termination cannot release the consumer')
      assert.equal(sameProcess(pid, identity), true, 'the fixture proves that no real termination was observed')
    })
  })
}

test('a foreign PID report never authorizes signalling an unrelated process', { timeout: 10000 }, async () => {
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const exited = once(sentinel, 'exit')
  const sentinelPid = sentinel.pid
  assert.ok(sentinelPid)
  const sentinelIdentity = processIdentity(sentinelPid)
  assert.ok(sentinelIdentity)
  const f = await fixture(0.05, { reportPid: sentinelPid })
  try {
    await f.run(async () => {
    await f.started()
    const identity = processIdentity(sentinel.pid!)
    assert.ok(identity)
    f.host.kill('SIGTERM')
    await until(() => f.stderr.includes('unowned sandbox child report'), 'foreign PID was not rejected')
    assert.equal(f.didClose, false)
    assert.equal(sameProcess(sentinel.pid!, identity), true)
    })
    assert.equal(sameProcess(sentinelPid, sentinelIdentity), true, 'fixture cleanup must not kill the foreign sentinel')
  } finally { sentinel.kill('SIGKILL'); await exited }
})

test('repository ownership follows the actual namespace runtime across supervisor loss', { timeout: 10000 }, async () => {
  const f = await fixture(0.05, { repository: true })
  await f.run(async () => {
    const pid = await f.started()
    await until(() => f.control.includes('\n'), 'runtime ownership was not reported')
    assert.equal(JSON.parse(f.control).pid, pid, 'the monitor PID is not the namespace runtime identity')
    f.host.kill('SIGKILL'); await f.exited
    assert.throws(() => claimRepository(f.base), /REPOSITORY_IN_USE/, 'an orphaned live runtime cannot donate repository ownership')
  })
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
    await f.run(async () => {
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
    })
  })
}
