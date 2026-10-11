// Trusted host helper, never evaluated inside Lisp. stdin is a parent-liveness
// pipe. It stays outside the worker sandbox so arbitrary Lisp cannot disable it.
import { spawn } from 'node:child_process'
import { openSync, closeSync, writeSync } from 'node:fs'
const launch = JSON.parse(process.argv[2])
let child, closing = false
const kill = () => {
  try {
    if (launch.group && child?.pid) process.kill(-child.pid, 'SIGKILL')
    else child?.kill('SIGKILL')
  } catch (error) { if (error.code !== 'ESRCH') throw error }
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
child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio, detached: !!launch.group })
if (filter !== undefined) closeSync(filter)
// Stream one JSON object: older readers still consume the complete terminal
// object, while current readers observe the prefix only after actual spawn.
child.once('spawn',()=>{if(launch.report){try{writeSync(4,'{"processStarted":true,')}catch{/* host already stopped */}}})
child.once('error', error => { process.stderr.write(`LISP_LAUNCH_ERROR: ${error.message}\n`); process.exit(70) })
child.once('exit', (code, signal) => {
  if(launch.report){try{writeSync(4,JSON.stringify({exitCode:code,signal}).slice(1)+'\n')}catch{/* host already stopped */}}
  if (launch.group) kill(); process.exit(signal ? 128 : code ?? 70)
})
if (closing) kill()
