import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
for (const core of [false, true]) for (const route of ['native', 'ptc', 'lisp']) test(`${core ? 'core' : 'adapter'} ${route}: native background bash preserves the original edit/test/retry request`, { timeout: 45000 }, async () => {
  const ptc = route === 'ptc'
  let lispEnabled = false
  const f = await nativeSkillFixture({ packages, core, ptc, ...(process.env.KIOKUKO_SKILL_PACKAGE_ROOT ? { packageRoot: process.env.KIOKUKO_SKILL_PACKAGE_ROOT } : {}),
    extra: { lisp: { enabled: route === 'lisp', executionMode: 'development', sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 15000 }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
      memoryReuse: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' },
      memoryIndexReasoning: { mode: 'off' }, modelAutoMode: { mode: 'off' } },
    hostPlugin: { name: 'background-native-services', async apply(ctx: any) {
      for (const name of ['dsh-jobs-local', 'dsh-tool-jobs', 'dsh-subprocess-local', 'dsh-bash-local', 'dsh-shell-env', 'dsh-tool-bash', 'dsh-tool-fs', 'dsh-tool-fs-search', 'dsh-tool-todo']) {
        const plugin = await import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
        if (ptc && name === 'dsh-subprocess-local') continue
        await ctx.plugin(plugin.default ?? plugin, name === 'dsh-tool-jobs' ? { completionDelivery: 'quiet' } : name === 'dsh-tool-fs-search' ? { sampleOverCapGlobResults: false } : name === 'dsh-tool-todo' ? { allowParallelInProgress: false } : {})
      }
    } },
  })
  const call = (id: string, name: string, args: object) => ptc
    ? f.mock.toolCallResponse(id, 'run_code', { description: name, code: `console.log(JSON.stringify(await tools.${name}(${JSON.stringify(args)})))` })
    : lispEnabled ? f.mock.toolCallResponse(id, 'lisp_eval', { operationId: id, code: name === 'bash' ? `(kioku.process:run "/bin/sh" (list "-c" ${JSON.stringify((args as { command: string }).command)}))` : `(kioku.tools:result-value (kioku.tools:call ${JSON.stringify(name)} (kioku.data:parse-json ${JSON.stringify(JSON.stringify(args))})))` })
    : f.mock.toolCallResponse(id, name, args)
  const file = join(f.dir, 'result.txt'), release = join(f.dir, 'release')
  let completed = false
  let backgroundJobId: string | undefined
  const observeBackground = () => {
    backgroundJobId = f.ctx.jobs.list(f.agent.session.id).find((job: any) => job.kind === 'bash' && job.status === 'running')?.id
    assert.ok(backgroundJobId, 'the native Bash job must still be running')
  }
  const ok = (q: any, id: string) => {
    const result = nativeToolResults(q.messages).find((r: any) => r.toolCallId === id)
    assert.ok(result && !result.isError, JSON.stringify(result))
    const text = result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    if (lispEnabled) assert.equal(JSON.parse(text).ok, true, text)
    return text
  }
  try {
    await writeFile(file, 'before\n')
    if (route === 'lisp') {
      f.responses.push(call('background', 'bash', { command: `while [ ! -f '${release}' ]; do sleep 0.05; done`, run_in_background: true, description: 'Wait for test release' }),
        (q: any) => { ok(q, 'background'); observeBackground(); return f.mock.textResponse('Background wait started.') })
      await f.turn('Start the requested background wait and leave it running.')
      const enabled = await f.ctx.commands.execute(f.agent, '/kioku-lisp enable', [], new AbortController().signal)
      assert.equal(enabled.result.kind, 'success', JSON.stringify(enabled)); lispEnabled = true
    }
    f.responses.push(
      ...(route === 'lisp' ? [call('read', 'read', { file_path: file })] : [call('background', 'bash', { command: `while [ ! -f '${release}' ]; do sleep 0.05; done`, run_in_background: true, description: 'Wait for the test release' }),
      (q: any) => { ok(q, 'background'); observeBackground(); return call('read', 'read', { file_path: file }) }]),
      (q: any) => { ok(q, 'read'); return call('grep', 'grep', { pattern: 'before', path: file }) },
      (q: any) => { ok(q, 'grep'); return call('todo', 'todo_write', { todos: [{ content: 'Edit and verify result.txt', status: 'in_progress' }] }) },
      (q: any) => { ok(q, 'todo'); return call('write', 'write', { file_path: file, content: 'wrong\n' }) },
      (q: any) => { ok(q, 'write'); return call('test-red', 'bash', { command: `test "$(cat '${file}')" = correct`, description: 'Test the requested result' }) },
      async (q: any) => { assert.match(ok(q, 'test-red'), /exit code: 1|"(?:exitCode|code)":\s*1/); if (route !== 'lisp') await writeFile(release, 'release'); return call('edit', 'edit', { file_path: file, old_string: 'wrong', new_string: 'correct' }) },
      async (q: any) => { ok(q, 'edit'); await writeFile(release, 'release');
        const settled = await f.ctx.jobs.wait(backgroundJobId!, 5000, f.agent.id)
        assert.equal(settled.status, 'completed', JSON.stringify(settled)); return call('test-green', 'bash', { command: `test "$(cat '${file}')" = correct && echo VERIFIED`, description: 'Retest the corrected result' }) },
      async (q: any) => { assert.match(ok(q, 'test-green'), /VERIFIED/); assert.equal(await readFile(file, 'utf8'), 'correct\n'); return call('todo-done', 'todo_write', { todos: [{ content: 'Edit and verify result.txt', status: 'completed' }] }) },
      (q: any) => { ok(q, 'todo-done'); completed = true; return f.mock.textResponse('Completed and verified.') },
    )
    await f.turn('Change result.txt to correct, test it, fix any failure and retest. Keep the background wait running until the first test fails.')
    assert.equal(completed, true)
  } finally {
    await writeFile(release, 'release')
    for (const job of f.ctx.jobs.list(f.agent.session.id)) { f.ctx.jobs.kill(job.id, f.agent.id); await f.ctx.jobs.wait(job.id, 5000, f.agent.id) }
    await f.close()
  }
})
