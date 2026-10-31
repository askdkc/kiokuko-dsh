// Trusted host helper, never evaluated inside Lisp. stdin is a parent-liveness
// pipe. It stays outside the worker sandbox so arbitrary Lisp cannot disable it.
import { spawn, execFileSync } from 'node:child_process'
import { openSync, closeSync, writeSync, readFileSync } from 'node:fs'
import { claimRepository } from './repository-owner.mjs'
import { processIdentity, sameProcess } from './process-identity.mjs'
const launch = JSON.parse(process.argv[2])
let repositoryLease
if (launch.repositoryRoot) {
  try { repositoryLease = claimRepository(launch.repositoryRoot) }
  catch(error) {
    writeSync(4, JSON.stringify({ type: 'error', code: error.message === 'REPOSITORY_IN_USE' ? 'REPOSITORY_IN_USE' : 'REPOSITORY_LOCK_FAILED' })+'\n')
    process.exit(73)
  }
}
let child, closing = false, terminationSent = false
let namespace, terminal, finishTimer, ownershipError = false
// Pending promises and SQLite leases do not keep Node alive after stdin EOF
// and monitor exit. Keep unconfirmed ownership visible to the host watchdog.
const namespaceLifetime = launch.namespaceInfo ? setInterval(() => {}, 60000) : undefined
const unconfirmed = message => {
  if (!ownershipError) console.error(`LISP_STOP_UNCONFIRMED: ${message}`)
  ownershipError = true
}
const reportRuntime = pid => {
  if (!repositoryLease) return
  try {
    const identity = repositoryLease.recordRuntime(pid)
    writeSync(4, JSON.stringify({ type: 'runtime', pid, identity })+'\n')
  } catch {
    try { writeSync(4, JSON.stringify({ type: 'error', code: 'REPOSITORY_LOCK_FAILED' })+'\n') } finally { stop() }
  }
}
const parentPid = pid => process.platform === 'linux'
  ? Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1])
  : Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim())
const finish = () => {
  if (!terminal) return
  if (launch.namespaceInfo) {
    if (!namespace) return // Missing ownership evidence never confirms Stop.
    try {
      if (sameProcess(namespace.pid, namespace.identity)) {
        finishTimer ??= setTimeout(() => { finishTimer = undefined; finish() }, 10)
        return
      }
    } catch { unconfirmed('cannot confirm sandbox child termination'); return }
  }
  clearTimeout(finishTimer)
  clearInterval(namespaceLifetime)
  repositoryLease?.close()
  process.exit(terminal.signal ? 128 : terminal.code ?? 70)
}
const kill = () => {
  if (!child?.pid || terminationSent) return
  if (launch.namespaceInfo) {
    // bwrap's monitor can fork before its namespace init installs PDEATHSIG.
    // Keep the monitor alive until its private info pipe identifies that child.
    if (!namespace) return
    try {
      if (sameProcess(namespace.pid, namespace.identity)) {
        if (!namespace.identity || processIdentity(namespace.pid) !== namespace.identity) throw new Error('identity unavailable')
        process.kill(namespace.pid, 'SIGKILL')
      }
      terminationSent = true
    } catch (error) {
      if (error.code === 'ESRCH') terminationSent = true
      else unconfirmed('sandbox child termination was not authorized or its identity changed')
    }
    return
  }
  try {
    if (launch.group && child?.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
    terminationSent = true
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
    terminationSent = true
  }
}
const stop = () => { closing = true; kill() }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdin.resume()
const filter = launch.seccompPath ? openSync(launch.seccompPath, 'r') : undefined
const stdio = ['ignore', 'inherit', 'inherit', launch.protocol ? 3 : 'ignore']
if (filter !== undefined) stdio.push(filter)
if (launch.namespaceInfo) {
  while (stdio.length < 5) stdio.push('ignore')
  stdio.push('pipe')
}
child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio, detached: !!launch.group })
if (filter !== undefined) closeSync(filter)
if (launch.namespaceInfo) {
  let info = '', excessive = false
  child.stdio[5].on('data', chunk => {
    if (excessive) return
    info += chunk.toString()
    if (Buffer.byteLength(info) > 16384) { excessive = true; unconfirmed('invalid sandbox ownership report') }
  })
  child.stdio[5].once('error', () => unconfirmed('sandbox ownership channel failed'))
  child.stdio[5].once('end', () => {
    try {
      if (excessive) return
      const pid = JSON.parse(info)['child-pid']
      if (!Number.isSafeInteger(pid) || pid < 1 || pid === child.pid || pid === process.pid) throw new Error('invalid pid')
      const identity = processIdentity(pid)
      // The channel is private to bwrap and closed before guest execution.
      // Check kernel parentage while its monitor is alive, then retain the
      // birth fingerprint so a later orphan or PID reuse cannot change scope.
      if (sameProcess(pid, identity) && (!identity || parentPid(pid) !== child.pid)) throw new Error('not an owned child')
      namespace = { pid, identity }
      // A dead bwrap monitor cannot donate a still-live namespace runtime.
      reportRuntime(pid)
      if (closing) kill()
      finish()
    } catch { unconfirmed('invalid or unowned sandbox child report') }
  })
}
// Stream one JSON object: older readers still consume the complete terminal
// object, while current readers observe the prefix only after actual spawn.
child.once('spawn',()=>{
  if (!launch.namespaceInfo) reportRuntime(child.pid)
  if(launch.report){try{writeSync(4,'{"processStarted":true,')}catch{/* host already stopped */}}
})
child.once('error', error => { process.stderr.write(`LISP_LAUNCH_ERROR: ${error.message}\n`); process.exit(70) })
child.once('exit', (code, signal) => {
  if(launch.report){try{writeSync(4,JSON.stringify({exitCode:code,signal}).slice(1)+'\n')}catch{/* host already stopped */}}
  terminal = { code, signal }
  if (launch.namespaceInfo) stop()
  else if (launch.group) kill()
  finish()
})
if (closing) kill()
