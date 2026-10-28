import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
const exec = promisify(execFile)
const runner = resolve('scripts/run-tests.mjs')

test(
  'suite watchdog preserves a normally completed test',
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiokuko-watchdog-pass-'))
    try {
      const file = join(root, 'normal.test.ts')
      await writeFile(
        file,
        "import test from 'node:test'; test('normal', () => {});\n",
      )
      const result = await exec(process.execPath, [runner, file], {
        env: { ...process.env, KIOKUKO_TEST_TIMEOUT_MS: '2000' },
        timeout: 6000,
      })
      assert.match(result.stdout, /normal/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test(
  'outer deadline stops microtask starvation and its owned descendant',
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiokuko-watchdog-loop-'))
    try {
      const file = join(root, 'bounded.test.ts'),
        pidFile = join(root, 'child.pid')
      // Finite even if the watchdog regresses; the independent exec deadline also
      // sends SIGTERM to the supervisor, whose existing group cleanup remains on.
      await writeFile(
        file,
        `import test from 'node:test'; import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';\ntest('bounded busy fixture',{timeout:20},async()=>{const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));const until=Date.now()+5000;while(Date.now()<until)await Promise.resolve()});\n`,
      )
      const start = Date.now()
      await assert.rejects(
        exec(process.execPath, [runner, file], {
          env: { ...process.env, KIOKUKO_TEST_TIMEOUT_MS: '2000' },
          timeout: 6000,
        }),
        (error) => {
          assert.match(error.stderr, /wall-clock timeout \(2000 ms\)/)
          assert.equal(error.code, 1)
          return true
        },
      )
      assert.ok(
        Date.now() - start < 5000,
        'the outer deadline must preempt the finite busy loop',
      )
      const pid = Number(await readFile(pidFile, 'utf8'))
      let state
      for (let i = 0; i < 40; i++) {
        const result = await exec('ps', [
          '-p',
          String(pid),
          '-o',
          'stat=',
        ]).catch((error) => {
          if (error.code !== 1) throw error
          return { stdout: '' }
        })
        state = result.stdout.trim()
        if (!state || state.startsWith('Z')) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.ok(
        !state || state.startsWith('Z'),
        'the timed-out suite must not leave its child running',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
