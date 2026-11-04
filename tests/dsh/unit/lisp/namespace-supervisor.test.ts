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
import { sandboxLaunch } from '../../../../src/dsh/lisp/sandbox.js'

// Real processes model bwrap's monitor/setup/init ownership boundary. This is
// not a Linux namespace or protected-SBCL test; those run in the native lane.
const supervisor = fileURLToPath(new URL('../../../../lisp/supervisor.mjs', import.meta.url))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, message: string, ms = 2500) {
  const deadline = Date.now() + ms
  while (!check()) { assert.ok(Date.now() < deadline, message); await delay(10) }
}
async function fixture(reportDelay: number, options: { terminationLookupError?: 'once' | 'persistent'; parentageError?: 'gone' | 'goneESRCH' | 'ENOENT' | 'EACCES'; coldStartDelay?: number; startDelay?: number; lateSpawn?: boolean; childStartDelay?: number; announceDelay?: number; startTimeout?: number; failBeforeAnnounce?: boolean; reportPid?: number; payload?: string; monitorExit?: boolean; denyKill?: boolean; hostOwner?: boolean; runtimeReport?: boolean; detachedStdio?: boolean; exitAfterReport?: boolean; identityLookupError?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'namespace-supervisor-'))
  // Use the running test runtime: system Python cold-start is unrelated to
  // namespace supervision and can consume the entire phase-entry budget on CI.
  const script = join(base, 'monitor.mjs')
  await writeFile(script, `import {spawn} from 'node:child_process';
import {writeFileSync,renameSync,writeSync,closeSync} from 'node:fs';
import {once} from 'node:events';
import net from 'node:net';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const lifetime=new net.Socket({fd:6,readable:true,writable:false});
const ended=new Promise(resolve=>lifetime.once('end',()=>resolve(true)));lifetime.resume();
const cancelled=seconds=>Promise.race([ended,sleep(seconds*1000).then(()=>false)]);
writeSync(1,'monitor:'+process.pid+'\\nentered\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${(options.coldStartDelay ?? 0) * 1000});
writeSync(1,'spawning\\n');
${options.lateSpawn ? `await sleep(${(options.startDelay ?? 0) * 1000});` : `if(await cancelled(${options.startDelay ?? 0}))process.exit(0);`}
const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(`import net from 'node:net';Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${(options.childStartDelay ?? 0) * 1000});const lifetime=new net.Socket({fd:6,readable:true,writable:false});lifetime.once('end',()=>process.exit(0));lifetime.resume();setTimeout(()=>process.exit(0),${options.terminationLookupError === 'once' ? 400 : 30000});`)}],{stdio:['ignore',${options.detachedStdio ? "'ignore','ignore'" : "'inherit','inherit'"},'ignore','ignore','ignore',6]});
const childExit=once(child,'exit');
writeFileSync('spawned.tmp',JSON.stringify({monitor:process.pid,child:child.pid}));renameSync('spawned.tmp','spawned.json');
${options.failBeforeAnnounce ? 'process.exit(23);' : ''}
if(await cancelled(${options.announceDelay ?? 0})){await childExit;process.exit(0);}
writeSync(1,'monitor:'+process.pid+'\\nchild:'+child.pid+'\\n');
${options.monitorExit ? 'process.exit(0);' : ''}
if(await cancelled(${reportDelay})){await childExit;process.exit(0);}
writeSync(5,${options.payload !== undefined ? JSON.stringify(options.payload) : `JSON.stringify({'child-pid':${options.reportPid ?? 'child.pid'}})`});closeSync(5);
writeSync(1,'reported\\n');
${options.exitAfterReport ? 'process.exit(0);' : ''}
const [code,signal]=await childExit;process.exit(signal?128:code??70);
`)
  const launch = { command: process.execPath, args: [script], env: {}, cwd: base, protocol: false, namespaceInfo: true, runtimeReport: options.runtimeReport }
  // Fixture EOF remains independent of production Stop. The owned session
  // below also bounds teardown before an inheritor can cooperate with EOF.
  // The fixture anchor is unref'ed and inherits no streams: it must neither
  // hold the tested supervisor alive nor delay the host's close event.
  const lifetime = join(base, 'lifetime.mjs')
  await writeFile(lifetime, `import net from 'node:net';import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
    const spawn=cp.spawn;const anchor=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});anchor.unref();console.log('anchor:'+anchor.pid);cp.spawn=function(command,args,options){const stdio=[...options.stdio];stdio[6]=6;const child=spawn.call(this,command,args,{...options,stdio});child.once('spawn',()=>console.log('fixture-spawned:'+child.pid));child.once('exit',(code,signal)=>console.log('fixture-terminal:'+JSON.stringify({pid:child.pid,code,signal})));return child};syncBuiltinESMExports();
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
  if (options.terminationLookupError) {
    const fake = join(base, 'terminal-identity.mjs'), preload = join(base, 'terminal-lookup.mjs')
    const identity = new URL('./process-identity.mjs', pathToFileURL(supervisor)).href
    await writeFile(fake, `export{processIdentity}from ${JSON.stringify(identity)};import{sameProcess as realSame}from ${JSON.stringify(identity)};
      let observations=0;export function sameProcess(pid,birth){
        if(globalThis.fixtureMonitorExited){observations++;
          if(observations===${options.terminationLookupError === 'once' ? 2 : 1}||${options.terminationLookupError === 'persistent'}&&observations>1){
            console.error('fixture terminal lookup EIO');throw Object.assign(Error('fixture terminal lookup'),{code:'EIO'})}}
        return realSame(pid,birth)
      }`)
    await writeFile(preload, `import{registerHooks,syncBuiltinESMExports}from'node:module';import cp from'node:child_process';
      const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn.apply(this,args);child.once('exit',()=>{globalThis.fixtureMonitorExited=true});return child};syncBuiltinESMExports();
      registerHooks({resolve(spec,context,next){if(spec==='./process-identity.mjs'&&context.parentURL===${JSON.stringify(pathToFileURL(supervisor).href)})return{url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true};return next(spec,context)}})`)
    args.unshift('--import', preload)
  }
  if (options.parentageError) {
    const preload = join(base, 'parentage.mjs')
    const identity = new URL('./process-identity.mjs', pathToFileURL(supervisor)).href
    await writeFile(preload, `import fs from'node:fs';import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';import{processIdentity,sameProcess}from ${JSON.stringify(identity)};
      const read=fs.readFileSync,exec=cp.execFileSync,counts=new Map();
      function inject(pid){
        const owned=JSON.parse(read(${JSON.stringify(join(base, 'spawned.json'))},'utf8'));if(pid!==owned.child)throw Error('foreign fixture injection refused');
        const gone=${JSON.stringify(options.parentageError.startsWith('gone'))};
        if(gone){const birth=processIdentity(pid);if(!birth||!sameProcess(pid,birth))throw Error('fixture identity unavailable');process.kill(pid,'SIGKILL');
          const end=Date.now()+2500;while(sameProcess(pid,birth)){if(Date.now()>end)throw Error('fixture child did not terminate');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}}
        const error=Error('fixture parentage lookup failed');error.code=${JSON.stringify(options.parentageError === 'goneESRCH' ? 'ESRCH' : options.parentageError === 'gone' ? 'ENOENT' : options.parentageError)};
        console.error('fixture parentage '+error.code+' '+(gone?'dead':'live'));throw error
      }
      fs.readFileSync=function(path,...args){const m=/^\\/proc\\/(\\d+)\\/stat$/.exec(String(path));if(m){const n=(counts.get(path)??0)+1;counts.set(path,n);if(n===4)inject(Number(m[1]))}return read.call(this,path,...args)};
      cp.execFileSync=function(command,args,...rest){if(command==='/bin/ps'&&args?.[3]==='ppid=')inject(Number(args[1]));return exec.call(this,command,args,...rest)};syncBuiltinESMExports()`)
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
    run<T>(body: () => Promise<T>) {
      return withCleanup(async () => {
        try { return await body() }
        catch (error) {
          // Capture the failed phase before cleanup changes process state. Keep
          // the original assertion intact; a missing marker is not a timeout diagnosis.
          console.error('namespace fixture failure:', JSON.stringify({ output, stderr, didExit, didClose,
            host: { pid: host.pid, exitCode: host.exitCode, signalCode: host.signalCode },
            monitorPid, childPid, anchorPid }))
          throw error
        }
      }, () => f.cleanup())
    },
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

for (const mode of ['once', 'persistent'] as const) test(`namespace termination observation ${mode}: only a confirmed stop releases ownership`, { timeout: 10000 }, async () => {
  const f = await fixture(0.05, { runtimeReport: true, terminationLookupError: mode })
  await f.run(async () => {
    const pid = await f.started(), identity = processIdentity(pid)
    assert.ok(identity)
    await until(() => f.control.includes('\n'), 'owned runtime was not recorded before Stop')
    if (mode === 'persistent') f.host.stdin!.end()
    await until(() => f.stderr.includes('fixture terminal lookup EIO'), 'terminal observation was not exercised')
    if (mode === 'once') {
      await until(() => f.didClose, 'a transient observation failure permanently fenced a completed setup')
      assert.deepEqual(await f.exited, [0, null], 'the real monitor completed successfully before the observation error')
    }
    else {
      await delay(200)
      assert.equal(f.didExit, false, 'an unavailable observation cannot certify termination')
    }
    await until(() => !sameProcess(pid, identity), 'the owned child was not terminated')
  })
})

for (const code of ['gone', 'goneESRCH', 'ENOENT', 'EACCES'] as const) {
  test(`namespace parentage lookup ${code}: only confirmed child death settles`, { timeout: 10000 }, async () => {
    const f = await fixture(0.4, { parentageError: code })
    await f.run(async () => {
      const pid = await f.started(), identity = processIdentity(pid)
      assert.ok(identity)
      await until(() => f.stderr.includes('fixture parentage'), 'parentage boundary was not reached')
      f.host.stdin!.end()
      if (code.startsWith('gone')) {
        await until(() => f.didClose, 'confirmed child disappearance left Stop unconfirmed')
        assert.equal(sameProcess(pid, identity), false)
        assert.equal(f.stderr.includes('LISP_STOP_UNCONFIRMED'), false)
      } else {
        await until(() => f.stderr.includes('LISP_STOP_UNCONFIRMED'), 'live lookup failure lost its fence')
        assert.equal(f.didExit, false)
        assert.equal(sameProcess(pid, identity), true)
      }
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

test('the runtime report identifies the actual namespace child', { timeout: 10000 }, async () => {
  const f = await fixture(0.05, { runtimeReport: true })
  await f.run(async () => {
    const pid = await f.started()
    await until(() => f.control.includes('\n'), 'runtime ownership was not reported')
    assert.equal(JSON.parse(f.control).pid, pid, 'the monitor PID is not the namespace runtime identity')
    assert.equal(JSON.parse(f.control).identity, processIdentity(pid))
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
