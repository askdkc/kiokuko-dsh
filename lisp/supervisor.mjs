// Trusted host helper, never evaluated inside Lisp. stdin is a parent-liveness
// pipe. It stays outside the worker sandbox so arbitrary Lisp cannot disable it.
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
const launch = JSON.parse(process.argv[2])
let child, closing = false
const stop = () => { closing = true; child?.kill('SIGKILL') }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdin.resume()
const filter = launch.seccompPath ? openSync(launch.seccompPath, 'r') : undefined
const stdio = ['ignore', 'inherit', 'inherit', launch.protocol ? 3 : 'ignore']
if (filter !== undefined) stdio.push(filter)
child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio })
if (filter !== undefined) closeSync(filter)
child.once('error', error => { process.stderr.write(`LISP_LAUNCH_ERROR: ${error.message}\n`); process.exit(70) })
child.once('exit', (code, signal) => { process.exit(signal ? 128 : code ?? 70) })
if (closing) child.kill('SIGKILL')
