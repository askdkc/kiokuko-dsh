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
