import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const installed = existsSync(join(packages, '@deepseek-ai/dsh-tool-fs/lib/index.js'))
if (!installed && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Native file workflow requires the DSH fixture')

test('native file workflow preserves sequential edits and reconciles metadata drift without disabling content protection', { skip: !installed }, async () => {
  const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
  const [cordis, llm, sessions, projection, prompt, tools, agents, fs, directory, policy, files, loop] = await Promise.all([
    'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent',
    'dsh-fs-local', 'dsh-working-directory', 'dsh-fs-observation-policy', 'dsh-tool-fs', 'dsh-agent-loop',
  ].map(load))
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'native-file-workflow-')))
  const path = join(root, 'PLAN.md'), ctx = new cordis.Context(), fibers: any[] = []
  let handle: any
  try {
    for (const plugin of [llm, sessions, projection, prompt, tools, agents, fs, directory, policy, files]) {
      fibers.push(await ctx.plugin(plugin.default ?? plugin, plugin === fs ? { cwd: root }
        : plugin === directory ? { defaultDirectory: root } : plugin === prompt ? { persona: '' } : undefined))
    }
    fibers.push(await ctx.plugin(loop.default, { agents: [] }))
    handle = await ctx.agents.create({ sessionId: sessions.SessionId('file-workflow'), agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: root } })
    let sequence = 0
    const call = (name: string, args: object) => ctx.tools.execute({ callId: `file-${++sequence}`, name, arguments: args, agent: handle.agent, signal: new AbortController().signal })
    const read = () => call('read', { file_path: 'PLAN.md' })
    const edit = (old_string: string, new_string: string) => call('edit', { file_path: 'PLAN.md', old_string, new_string })
    await writeFile(path, '# Plan\nfirst\nsecond\n')
    assert.equal((await read()).isError, false)
    assert.equal((await edit('first', 'updated first')).isError, false)
    assert.equal((await edit('second', 'updated second')).isError, false, 'current DSH already records its own mutation version')

    // The session export cannot identify an outside metadata writer. Reproduce
    // that possible cause without claiming it occurred in the reported session.
    const info = await stat(path)
    await utimes(path, info.atime, new Date(info.mtimeMs + 10_000))
    const stale = await edit('updated second', 'final second')
    assert.equal(stale.isError, true)
    assert.equal(stale.error.info?.code, 'FS_STALE_VERSION')
    assert.equal(await readFile(path, 'utf8'), '# Plan\nupdated first\nupdated second\n')
    assert.equal((await read()).isError, false)
    assert.equal((await edit('updated second', 'final second')).isError, false)
    assert.equal(await readFile(path, 'utf8'), '# Plan\nupdated first\nfinal second\n')

    await writeFile(path, '# Plan\nexternal change\nfinal second\n')
    const conflict = await edit('final second', 'must not overwrite')
    assert.equal(conflict.isError, true)
    assert.equal(conflict.error.info?.code, 'FS_STALE_VERSION')
    assert.equal(await readFile(path, 'utf8'), '# Plan\nexternal change\nfinal second\n')
    assert.equal((await read()).isError, false)
    assert.equal((await edit('external change', 'reconciled change')).isError, false)
    assert.equal(await readFile(path, 'utf8'), '# Plan\nreconciled change\nfinal second\n')
  } finally {
    await handle?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
