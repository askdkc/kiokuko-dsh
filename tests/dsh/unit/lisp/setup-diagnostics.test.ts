import assert from 'node:assert/strict'
import test from 'node:test'
import childProcess, { type ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runLispSetup } from '../../../../src/dsh/lisp/compiled-cache.js'
import { LispConfig, LispError } from '../../../../src/dsh/lisp/contracts.js'
import { prepareLayout } from '../../../../src/dsh/lisp/sandbox.js'

const realTimeout = setTimeout
const delay = (ms: number) => new Promise(resolve => realTimeout(resolve, ms))
for (const [primary, boundary] of [['CANCELLED', false], ['COMPILE_TIMEOUT', false], ['OUTPUT_LIMIT', false], ['COMPILE_FAILED', false], ['COMPILE_FAILED', true]] as const) {
  test(`setup diagnostics retain ${primary}${boundary ? ' at truncation boundary' : ''} without confirming an unobserved stop`, { timeout: 12000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const base = await mkdtemp(join(tmpdir(), 'setup-diagnostic-'))
    const layout = await prepareLayout(join(base, 'runtime'), base)
    const abort = new AbortController()
    const secret = 'sk-' + 'a'.repeat(30)
    const ansiSecret = 'sk-' + 'b'.repeat(30), controlSecret = 'sk-' + 'd'.repeat(30), keyedSecret = 'c'.repeat(30)
    const boundarySecret = 'sk-' + 'e'.repeat(30), tail = '\nsetup diagnostic tail\n'
    const diagnostic = boundary ? 'x' + boundarySecret + 'z'.repeat(6000 - boundarySecret.length - tail.length) + tail
      : 'x'.repeat(17000) + '\nsetup fixture detail\nOPENAI_API_KEY=' + secret
      + '\nOPENAI_API_KEY=sk-\u001b[31m' + 'b'.repeat(30) + '\u001b[0m'
      + '\nAPI_\u001b[31mKEY\u001b[0m=' + keyedSecret
      + '\ndiagnostic=sk-\u0000' + 'd'.repeat(30) + '\n\u001b[31msetup diagnostic tail\u001b[0m\n'
    await writeFile(join(base, 'supervisor.mjs'), `
      process.on('SIGTERM',()=>{});
      process.stderr.write(${JSON.stringify(diagnostic)});
      ${primary === 'COMPILE_FAILED' ? 'process.exit(23)' : 'setInterval(()=>{},1000)'}`)
    const config = LispConfig.parse({sbclPath:process.execPath,startupTimeoutMs:30000,
      maxOutputBytes:primary === 'OUTPUT_LIMIT'?1024:100000})
    // Keep the actual child handle: a failed ps lookup must never strand a fixture.
    let child: ChildProcess | undefined, closed: Promise<void> | undefined, output = ''
    const spawn = childProcess.spawn
    const spawnMock = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
      child = spawn(...args)
      closed = new Promise(resolve => child!.once('close', () => resolve()))
      child.stderr!.on('data', chunk => { output += chunk.toString() })
      return child
    })
    syncBuiltinESMExports()
    const phase = primary === 'CANCELLED' ? 'runtime-identity.lisp' : boundary ? 'check-compiled.lisp' : 'compile.lisp'
    const outcome = runLispSetup(layout, config, phase, abort.signal).catch(error => error)
    try {
      const end = Date.now()+5000
      while (output !== diagnostic) {
        assert.ok(Date.now()<end,'setup fixture did not emit its diagnostic'); await delay(10)
      }
      if (primary === 'CANCELLED') abort.abort()
      if (primary !== 'COMPILE_FAILED') {
        let settled=false; void outcome.then(()=>{settled=true})
        if (primary === 'COMPILE_TIMEOUT') t.mock.timers.tick(30000)
        t.mock.timers.tick(4999); await Promise.resolve()
        assert.equal(settled,false,'the existing five-second Stop deadline must remain intact')
        t.mock.timers.tick(1)
      }
      const problem = await outcome
      assert.ok(problem instanceof LispError)
      assert.equal(problem.code, primary === 'COMPILE_FAILED' ? 'COMPILE_FAILED' : 'STOP_UNCONFIRMED')
      if (primary !== 'COMPILE_FAILED') {
        assert.ok(child?.pid)
        assert.equal(child.kill(0),true,'unconfirmed really means the child remains alive')
        assert.equal(child.exitCode,null,'unconfirmed really means the child has not exited')
        assert.equal(child.signalCode,null,'unconfirmed really means the child has not been killed')
        assert.ok(problem.cause instanceof LispError)
        assert.equal(problem.cause.code,primary)
        assert.ok(problem.message.includes(primary))
      }
      assert.ok(problem.message.includes('Setup phase: ' + phase), 'retain the actual setup phase separately from its failure code')
      assert.match(problem.message,/setup diagnostic tail/)
      for (const value of [secret, ansiSecret, controlSecret, keyedSecret, boundarySecret])
        assert.equal(problem.message.includes(value),false,'canonicalization must not reconstruct secret material')
      assert.equal(problem.message.includes('\u001b'),false)
      assert.ok(Buffer.byteLength(problem.message)<7000,'diagnostics must remain bounded')
    } finally {
      try {
        abort.abort()
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed
        await outcome
      } finally {
        spawnMock.mock.restore(); syncBuiltinESMExports()
        await rm(base,{recursive:true,force:true})
      }
    }
  })
}
