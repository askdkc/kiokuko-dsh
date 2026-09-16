import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, LISP_TOOLS, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../../../../src/dsh/lisp/coding-choice.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

for (const outcome of ['ready', 'startup-failure', 'decline'] as const) test(`Lisp coding surface: ${outcome}`, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-coding-surface-')))
  const path = join(base, 'db.sqlite3')
  const db = new NodeSqliteAdapter(path, new DatabaseSync(path))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new Context(), definitions = new Map<string, any>(), commands = new Map<string, any>()
  const sections = new Map<string, string>()
  const prompt = { section: (input: { name: string; text: string }) => {
    sections.set(input.name, input.text)
    return () => { sections.delete(input.name) }
  } }
  const tools = {
    guard: () => () => {}, presentAs: () => () => {}, restrict: () => () => {},
    register: (definition: any) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
    get: (name: string) => definitions.get(name), execute: async () => {},
  }
  const agent = { id: 'agent', session: { id: 'session', header: { cwd: base } },
    ctx: { get: (name: string) => name === 'tools' ? tools : name === 'systemPrompt' ? prompt : undefined } }
  let asked = 0, activated = 0
  const fiber = ctx.plugin({ name: 'lisp-coding-surface-services', apply(c) {
    c.provide('tools', tools)
    c.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
    c.provide('sessions', { get: (id: string) => id === agent.session.id ? agent.session : undefined })
    c.provide('commands', { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
    c.provide('userQuestions', { ask: async (request: any) => {
      assert.equal(request.agent, agent)
      asked++
      return { answers: [{ id: request.questions[0].id,
        selected: [outcome === 'decline' ? 'Lispモードを使わない' : 'Lispモードを使う（通常実行）'] }] }
    } })
  } })
  await fiber
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined
  try {
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true, sbclPath: join(base, 'missing-sbcl') }))
    if (outcome === 'ready') t.mock.method(surface.manager, 'enable', async (owner: LispOwner) => {
      activated++
      surface!.manager.enabled.set(owner.sessionId, owner.root)
      return { state: 'READY' }
    })
    const service = ctx.get(LISP_CODING_SERVICE) as LispCodingService
    const input = { agent, turn: 1, task: 'Implement src/index.ts', taskType: 'build' as const, signal: new AbortController().signal }
    if (outcome === 'startup-failure') {
      await assert.rejects(service.prepare(input), /SBCL|sbcl|ENOENT/u)
      assert.equal(service.enabled(agent), true, 'failed startup retains the admitted fence')
      assert.deepEqual([...definitions.keys()], [...LISP_TOOLS], 'diagnostic tools remain available')
      await assert.rejects(service.prepare({ ...input, turn: 2 }), /復旧/u)
      assert.equal(asked, 1)
    } else {
      assert.equal((await service.prepare(input)).taskType, 'build')
      assert.equal(service.enabled(agent), outcome === 'ready')
      assert.equal(asked, 1)
      if (outcome === 'ready') {
        assert.equal(activated, 1)
        assert.deepEqual([...definitions.keys()], [...LISP_TOOLS])
        assert.equal(sections.get('kiokuko:lisp'), await readFile(new URL('../../../../skills/kiokuko-lisp/SKILL.md', import.meta.url), 'utf8'),
          'the active agent receives the complete current bundled Skill')
        assert.equal((await commands.get('kioku-lisp').handler({ rawInput: 'enable', agent, signal: input.signal })).kind, 'success')
        assert.equal(activated, 2, 'command and prompt share the activation path')
      } else {
        assert.equal(definitions.size, 0)
        assert.equal(db.prepare('SELECT enabled FROM dsh_lisp_sessions WHERE session_id=?').get<{ enabled: number }>('session')?.enabled, 0)
        await service.prepare({ ...input, turn: 2 })
        assert.equal(asked, 1)
      }
    }
  } finally {
    surface?.stop(); await surface?.dispose()
    await fiber.dispose(); db.close()
    await rm(base, { recursive: true, force: true })
  }
})
