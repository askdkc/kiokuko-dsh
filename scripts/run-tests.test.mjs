import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { processIdentity, sameProcess } from '../lisp/process-identity.mjs'
const exec = promisify(execFile)
const runner = resolve('scripts/run-tests.mjs')
// These fixtures exercise the process watchdog without a DSH runtime, even in CI.
const watchdogEnv = { ...process.env, KIOKUKO_REQUIRE_DSH_NATIVE: '0' }

test('direct native runs reject a missing DSH graph before executing tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-native-preflight-'))
  try {
    const file = join(root, 'native.test.ts')
    const packageRoot = join(root, 'missing-node_modules')
    await writeFile(file, "import test from 'node:test'; test('native test started', () => {});\n")
    await assert.rejects(exec(process.execPath, [runner, file], {
      env: { ...process.env, KIOKUKO_REQUIRE_DSH_NATIVE: '1', KIOKUKO_DSH_RUNTIME_MODE: 'current', KIOKUKO_DSH_PACKAGE_ROOT: packageRoot },
      timeout: 6000,
    }), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Cannot read installed DSH runtime/)
      assert.ok(error.stderr.includes(join(packageRoot, '@deepseek-ai/dsh/package.json')))
      assert.doesNotMatch(error.stdout, /native test started/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
        env: { ...watchdogEnv, KIOKUKO_TEST_TIMEOUT_MS: '2000' },
        timeout: 6000,
      })
      assert.match(result.stdout, /normal/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

for (const exitedGroupEperm of [false, true]) test(
  'outer deadline stops microtask starvation and its owned descendant' + (exitedGroupEperm ? ' after an exited group returns EPERM' : ''),
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
        `import test from 'node:test'; import {spawn} from 'node:child_process'; import {once} from 'node:events'; import {writeFileSync} from 'node:fs';
test('ready descendant',async t=>{
  const child=spawn(process.execPath,['-e',${JSON.stringify((exitedGroupEperm ? "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));" : '') + "setTimeout(()=>{},5000);process.send('ready')")}],{stdio:['ignore','ignore','ignore','ipc']});
  writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
  await once(child,'message');
  await t.test('bounded busy fixture',{timeout:20},async()=>{
    const until=Date.now()+5000;while(Date.now()<until)await Promise.resolve()
  })
});\n`,
      )
      const preload = join(root, 'exited-group.mjs')
      if (exitedGroupEperm) await writeFile(preload, `
        import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
        const spawn=cp.spawn,exited=new Set();
        cp.spawn=function(...args){const child=spawn.apply(this,args);child.once('exit',()=>exited.add(child.pid));return child};syncBuiltinESMExports();
        const kill=process.kill;process.kill=function(pid,signal){
          if(signal==='SIGKILL'&&pid<0&&exited.has(-pid)){
            // Leader exit does not prove that its descendants have terminated.
            // Model an exited group only after the real SIGTERM has drained it.
            const deadline=Date.now()+1000;
            while(true){
              const rows=cp.execFileSync('/bin/ps',['-A','-o','pgid=,stat='],{encoding:'utf8',timeout:1000}).trim().split('\\n');
              const live=rows.some(line=>{
                const fields=line.trim().split(/\\s+/);
                if(fields.length!==2||!/^\\d+$/.test(fields[0]))throw Error('Invalid fixture process snapshot');
                return Number(fields[0])===-pid&&!['Z','X'].includes(fields[1][0])
              });
              if(!live)break;
              if(Date.now()>=deadline)throw Error('Fixture process group did not terminate before EPERM injection');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)
            }
            console.error('injected EPERM after owned group termination');
            throw Object.assign(new Error('exited fixture group EPERM'),{code:'EPERM'})
          }
          return kill.call(this,pid,signal)
        };
      `)
      const start = Date.now()
      await assert.rejects(
        exec(process.execPath, [...(exitedGroupEperm ? ['--import', preload] : []), runner, file], {
          env: { ...watchdogEnv, KIOKUKO_TEST_TIMEOUT_MS: '2000' },
          timeout: 6000,
        }),
        (error) => {
          assert.match(error.stderr, /wall-clock timeout \(2000 ms\)/)
          assert.equal(error.code, 1)
          if (exitedGroupEperm) assert.match(error.stderr, /injected EPERM after owned group termination/)
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

test('a permission failure against a live owned group remains fatal', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-watchdog-denied-'))
  try {
    const file = join(root, 'waiting.test.ts'), preload = join(root, 'denied.mjs')
    // Finite even when the denied supervisor cannot terminate this test group.
    await writeFile(file, "import test from 'node:test';test('finite owned fixture',async()=>{await new Promise(resolve=>setTimeout(resolve,3000))});\n")
    await writeFile(preload, `
      const kill=process.kill;process.kill=function(pid,signal){
        if(pid<0&&signal==='SIGTERM'){
          kill.call(this,pid,0);
          throw Object.assign(new Error('live owned group termination denied'),{code:'EPERM'})
        }
        return kill.call(this,pid,signal)
      };
    `)
    await assert.rejects(exec(process.execPath, ['--import', preload, runner, file], {
      env: { ...watchdogEnv, KIOKUKO_TEST_TIMEOUT_MS: '1000' }, timeout: 7000,
    }), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /live owned group termination denied/)
      assert.doesNotMatch(error.stderr, /wall-clock timeout/)
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an exited leader does not hide EPERM while its owned descendant is alive', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-watchdog-orphan-'))
  const pidFile = join(root, 'owned.json')
  try {
    const file = join(root, 'orphan.test.ts'), preload = join(root, 'denied.mjs')
    await writeFile(file, `
      import test from 'node:test';import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
      import{processIdentity}from ${JSON.stringify(new URL('../lisp/process-identity.mjs', import.meta.url).href)};
      test('finite owned descendant',()=>{const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'ignore'});
        writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid,identity:processIdentity(child.pid)}));child.unref()});
    `)
    await writeFile(preload, `
      import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';
      const spawn=cp.spawn,exited=new Set();cp.spawn=function(...args){const child=spawn.apply(this,args);child.once('exit',()=>exited.add(child.pid));return child};syncBuiltinESMExports();
      const kill=process.kill;process.kill=function(pid,signal){if(pid<0&&signal==='SIGKILL'&&exited.has(-pid))
        throw Object.assign(new Error('live descendant termination denied'),{code:'EPERM'});return kill.call(this,pid,signal)};
    `)
    await assert.rejects(exec(process.execPath, ['--import', preload, runner, file], { env: watchdogEnv, timeout: 7000 }), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /live descendant termination denied/)
      return true
    })
    const owned = JSON.parse(await readFile(pidFile, 'utf8'))
    assert.ok(owned.identity)
    assert.equal(sameProcess(owned.pid, owned.identity), true, 'denial must remain visible for a real live descendant')
  } finally {
    try {
      const owned = JSON.parse(await readFile(pidFile, 'utf8'))
      if (owned.identity && sameProcess(owned.pid, owned.identity)) {
        assert.equal(processIdentity(owned.pid), owned.identity)
        process.kill(owned.pid, 'SIGKILL')
      }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error }
    await rm(root, { recursive: true, force: true })
  }
})
