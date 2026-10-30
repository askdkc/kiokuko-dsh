import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

test('a successful test run also stops its unreferenced subprocesses', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-runner-cleanup-'))
  const path = join(root, 'child.test.ts'), pidPath = join(root, 'child.pid')
  let pid: number | undefined
  const alive = () => {
    if (pid === undefined) return false
    try {
      process.kill(pid, 0)
      // A container PID 1 may not reap our killed orphan. Zombies execute no work.
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)) return false
      }
      return true
    } catch (error) {
      if (['ESRCH','ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
      throw error
    }
  }
  try {
    await writeFile(path, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
child.unref();
`)
    await promisify(execFile)(process.execPath, ['scripts/run-tests.mjs', path], { timeout: 10_000 })
    pid = Number(await readFile(pidPath, 'utf8'))
    for (let attempt = 0; attempt < 20 && alive(); attempt++) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(alive(), false, 'the runner must stop its own descendants even when the tests pass')
  } finally {
    if (pid === undefined) pid = await readFile(pidPath, 'utf8').then(Number, () => undefined)
    if (alive()) process.kill(pid!, 'SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})
