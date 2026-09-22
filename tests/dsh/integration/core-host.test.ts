import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { mountCore } from '../../../src/dsh/core/index.js'
import { openConnection } from '../../../src/db/connection.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { configuredSkillProvider, configuredSkillPrompts } from '../../../src/dsh/core/skills.js'
import type { DshModule } from '../../../src/dsh/core/modules.js'
import type { CoreModuleHost } from '../../../src/dsh/core/host.js'
import { synchronizeConfiguredSkills } from '../../../src/dsh/core/deployment.js'
import { compileSkillBundle } from '../../../src/dsh/skill-compiler.js'
import { pathToFileURL } from 'node:url'
import { layaV1Reply, serveLaya } from '../helpers/laya.js'

async function fixture(questions?: { ask(request: any): Promise<any> }) {
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-core-')), root = realpathSync(directory)
  const listeners = new Map<string, Function>(), tools: any[] = [], providers: any[] = [], sections: any[] = []
  const events: any[] = []
  const session = { id: 'core-session', header: { cwd: root }, snapshotEvents: () => events }, agent = { id: 'core-agent', session }
  const services: Record<string, any> = {
    sessions: { get: (id: string) => id === session.id ? session : undefined, async flush() {} },
    agents: { get: (id: string) => id === agent.id ? agent : undefined },
    skills: { registerProvider(create: Function) { const provider = create({ signal: new AbortController().signal }); providers.push(provider); return () => { providers.splice(providers.indexOf(provider), 1) } }, async snapshot() { return { complete: true, skills: (await Promise.all(providers.map(provider => provider.list({})))).flatMap(result => result.candidates) } } },
    tools: { guard: () => () => {}, schemas: () => tools.map(({ name, description }) => ({ name, description })), register(tool: any) { tools.push(tool); return () => { tools.splice(tools.indexOf(tool), 1) } } },
    systemPrompt: { section(section: any) { sections.push(section); return () => { sections.splice(sections.indexOf(section), 1) } } },
    ...(questions ? { userQuestions: questions } : {}),
  }
  const ctx = { get: (name: string) => services[name], on(name: string, callback: Function) { listeners.set(name, callback); return () => { listeners.delete(name) } } } as unknown as Context
  return { root, ctx, agent, session, events, listeners, tools, sections, providers, services, async cleanup() { await rm(root, { recursive: true, force: true }) } }
}

test('mounted core gates actionable memory and exposes a session-bound diagnostic after interrupted completion', async () => {
  const f = await fixture(), commands: any[] = []
  f.services.commands = { register(command: any) { commands.push(command); return () => commands.splice(commands.indexOf(command), 1) } }
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3') })
  try {
    const db = openConnection(join(f.root, 'memory.sqlite3'))
    const workspace = db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{workspace:string}>()!.workspace
    recordEntry(db, { workspace, kind: 'lesson', title: 'code migration expectations', body: 'code migration expectations must include the next migration.', createdBy: 'fixture' })
    db.close()
    const messages = [{ role: 'user', content: 'Implement code migration expectations' }]
    await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    const execution = { callId: 'write', name: 'Edit', arguments: {}, agent: f.agent, signal: new AbortController().signal }
    let mutated = false
    await assert.rejects(f.listeners.get('tools/pre-execute')!(execution, async () => { mutated = true }), /resolve memory decisions/)
    assert.equal(mutated, false)
    const tool = f.tools.find(tool => tool.name === 'task_memory_review')
    const status = await tool.execute({ action: 'status' }, { ...execution, name: 'task_memory_review' })
    assert.equal(status.ready, false)
    assert.equal(status.pending[0].problem, 'decision_missing')
    await assert.rejects(tool.execute({ action: 'status' }, { ...execution, name: 'task_memory_review', agent: { ...f.agent } }), /identity/)
    f.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await f.listeners.get('agent/idle')!({ agent: f.agent })
    const command = commands.find(command => command.name === 'kioku-memory-application')
    const result = await command.handler({ agent: f.agent, rawInput: 'status --json', signal: execution.signal })
    const diagnostic = JSON.parse(result.text)
    assert.equal(diagnostic.integration, 'native_active'); assert.equal(diagnostic.ready, false)
    assert.equal(diagnostic.verification, 'unobserved')
    assert.equal('body' in diagnostic.pending[0], false)
    const stored = openConnection(join(f.root, 'memory.sqlite3'))
    assert.equal(stored.prepare('SELECT status FROM ledger_runs').get()?.status, 'interrupted')
    stored.close()
  } finally { await handle.dispose(); await f.cleanup() }
})

test('core native path handles conversation, research, writing and project memory without coding choices or optional runtimes', async () => {
  const f = await fixture()
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3') })
  try {
    assert.equal(f.sections.length, 1)
    assert.doesNotMatch(f.sections[0].text, /\| `kiokuko-enno-oduno`|\| `kiokuko-single-purpose-functions`/)
    assert.deepEqual((await f.providers[0].list({})).candidates.map((item: any) => item.name), ['kiokuko-soul', 'memory-reasoning', 'natural-japanese-output'])
    const db = openConnection(join(f.root, 'memory.sqlite3'))
    const workspace = db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{ workspace: string }>()!.workspace
    await recordEntry(db, { workspace, kind: 'fact', title: '文章作成の表記', body: '文章作成では見出しを短くする。', status: 'verified', provenance: { type: 'user', reference: 'fixture' } })
    db.close()
    for (const [index, task] of ['こんにちは', 'この資料を調査してください', '文章作成の表記を説明してください'].entries()) {
      const messages = [{ role: 'user', content: [{ type: 'text', text: task }], source: { kind: 'user' } }]
      const input = { agent: f.agent, turn: index + 1, step: 0, messages, signal: new AbortController().signal }
      let calls = 0
      const output = await f.listeners.get('agent/pre-step')!(input, async () => { calls++; return { kind: 'enter', messages } })
      assert.equal(output.kind, 'enter'); assert.equal(calls, 1)
      assert.equal(output.messages[0], messages[0], 'native message and attachments remain owned by DSH')
      if (index === 2) assert.match(JSON.stringify(output.messages), /見出しを短くする/)
      f.events.push({ type: 'turn/end', data: { turn: index + 1, reason: { kind: 'completed' } } })
      await f.listeners.get('agent/idle')!({ agent: f.agent })
    }
    const after = openConnection(join(f.root, 'memory.sqlite3'))
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get()?.count, 0)
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM dsh_lisp_sessions').get()?.count, 0)
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM ledger_runs WHERE status='completed'").get()?.count, 3)
    after.close()
  } finally { await handle.dispose(); await f.cleanup() }
  assert.equal(f.listeners.size, 0); assert.equal(f.tools.length, 0); assert.equal(f.providers.length, 0)
})

test('a local writing feature can prepare and dispose through the same contract without router edits', async () => {
  const f = await fixture(), events: string[] = []
  const feature: DshModule<CoreModuleHost> = { id: 'writing', coreVersion: 1, requires: [], configure: value => value,
    async mount({ host, defer }) { defer(host.beforeTask(async input => { events.push(input.task) })); return { stopIngress() { events.push('stop') }, async drain() { events.push('drain') }, async dispose() { events.push('dispose') } } } }
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3') }, [{ module: feature }])
  try {
    const messages = [{ role: 'user', content: 'こんにちは' }]
    await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
  } finally { await handle.dispose(); await f.cleanup() }
  assert.deepEqual(events, ['こんにちは', 'stop', 'drain', 'dispose'])
})

test('resource-only extension is available in full and compiled fallback without importing absent optional resources', async () => {
  const content = '---\nname: writing\ndescription: Organize text\n---\n<!-- KIOKUKO MANAGED STANDARD SKILL: writing -->\nOrganize the requested text.'
  const resources = [{ name: 'writing', relativePath: 'SKILL.md', load: async () => content }]
  for (const mode of ['full', 'compiled'] as const) {
    const prompts = configuredSkillPrompts(resources, mode, new URL('file:///nonexistent/kiokuko-test-bundle.json'))
    const provider = configuredSkillProvider(resources, prompts)
    const list = await provider.list({}) as { candidates: readonly any[] }
    assert.equal((await provider.get(list.candidates[0], {}))?.content, content)
    assert.equal(await prompts.get('kiokuko-lisp'), undefined)
    provider.dispose(); assert.deepEqual(await provider.list({}), { candidates: [], complete: true })
  }
})

test('persisted protected sessions cannot become native work when the required module is absent', async () => {
  const f = await fixture()
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    const db = openConnection(databasePath)
    db.prepare('INSERT INTO dsh_lisp_sessions(session_id,root_path,enabled,epoch,updated_at) VALUES(?,?,1,?,?)').run(f.session.id, f.root, 'epoch', new Date().toISOString())
    db.close()
    let called = false
    await assert.rejects(f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: [{ role: 'user', content: 'こんにちは' }], turn: 1, step: 0, signal: new AbortController().signal }, async () => { called = true }), /Required module unavailable/)
    await assert.rejects(f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: [{ role: 'user', content: [{ type: 'image', attachmentId: 'fixture' }] }], turn: 2, step: 0, signal: new AbortController().signal }, async () => { called = true }), /Required module unavailable/)
    assert.equal(called, false)
    const after = openConnection(databasePath)
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get()?.count, 0)
    assert.equal(after.prepare('SELECT enabled FROM dsh_lisp_sessions').get()?.enabled, 1)
    after.close()
  } finally { await handle.dispose(); await f.cleanup() }
})

test('memory checkpoint uses exact native identity, persists candidate memory outside Git and rejects replay', async () => {
  const f = await fixture()
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    const messages = [{ role: 'user', content: 'こんにちは' }]
    await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    const tool = f.tools.find(tool => tool.name === 'memory_checkpoint')
    const args = { outcome: 'completed', memories: [{ kind: 'fact', title: 'Writing preference', body: 'Keep headings short.' }] }
    const execution = { name: 'memory_checkpoint', agent: f.agent, signal: new AbortController().signal }
    await assert.rejects(tool.execute({ ...args, runId: 'forged' }, execution))
    await assert.rejects(tool.execute(args, { ...execution, agent: { ...f.agent } }), /identity/)
    const result = await tool.execute(args, execution)
    assert.equal(result.entries.length, 1)
    await assert.rejects(tool.execute(args, execution), /No open bound task/)
    const db = openConnection(databasePath)
    const row = db.prepare('SELECT status FROM entries WHERE id=?').get(result.entries[0].id)
    assert.equal(row?.status, 'candidate')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ledger_runs WHERE status='completed'").get()?.count, 1)
    db.close()
  } finally { await handle.dispose(); await f.cleanup() }
})

test('reload resumes the exact ordinary request and a completed checkpoint cannot be replayed', async () => {
  const f = await fixture(), databasePath = join(f.root, 'memory.sqlite3')
  const config = { repositoryRoot: f.root, databasePath }
  let handle = await mountCore(f.ctx, config)
  const messages = [{ role: 'user', content: 'こんにちは' }]
  const prepare = () => f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
  try {
    assert.equal((await prepare()).kind, 'enter')
    await handle.dispose(); handle = await mountCore(f.ctx, config)
    assert.equal((await prepare()).kind, 'enter')
    await f.tools.find(tool => tool.name === 'memory_checkpoint').execute({ outcome: 'completed', memories: [{ kind: 'fact', title: 'One saved fact', body: 'This exact request is saved once.' }] }, { name: 'memory_checkpoint', agent: f.agent, signal: new AbortController().signal })
    await handle.dispose(); handle = await mountCore(f.ctx, config)
    assert.equal((await prepare()).kind, 'reject')
    const db = openConnection(databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get()?.n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n, 1)
    db.close()
  } finally { await handle.dispose(); await f.cleanup() }
})

test('configured resource deployment preserves omitted/user files and compiled delivery uses only its manifest', async () => {
  const f = await fixture()
  const content = '---\nname: writing\ndescription: Organize text\n---\n<!-- KIOKUKO MANAGED STANDARD SKILL: writing -->\n<!-- kiokuko:runtime action -->\nOrganize the requested text.\n<!-- /kiokuko:runtime -->\n<!-- kiokuko:documentation explanation -->\nOptional long explanation.\n<!-- /kiokuko:documentation -->'
  const resource = { name: 'writing', relativePath: 'SKILL.md', load: async () => content }
  try {
    const other = join(f.root, '.agents/skills/other/SKILL.md')
    await mkdir(join(f.root, '.agents/skills/other'), { recursive: true }); await writeFile(other, 'User-owned Skill')
    assert.deepEqual(await synchronizeConfiguredSkills([resource], f.root), { created: 1, updated: 0, unchanged: 0 })
    assert.equal(await readFile(other, 'utf8'), 'User-owned Skill')
    assert.deepEqual(await synchronizeConfiguredSkills([resource], f.root), { created: 0, updated: 0, unchanged: 1 })
    const path = join(f.root, 'prompts.json')
    await writeFile(path, JSON.stringify(compileSkillBundle([{ ...resource, content }])))
    const prompts = configuredSkillPrompts([resource], 'compiled', pathToFileURL(path)), provider = configuredSkillProvider([resource], prompts)
    const inventory = await provider.list({}) as { candidates: readonly any[] }
    const delivered = await provider.get(inventory.candidates[0], {})
    assert.match(delivered!.content, /Organize the requested text/)
    assert.doesNotMatch(delivered!.content, /Optional long explanation/)
    assert.equal(await prompts.get('kiokuko-enno-oduno'), undefined)
    const target = join(f.root, '.agents/skills/writing/SKILL.md')
    await writeFile(target, 'User replacement')
    await assert.rejects(synchronizeConfiguredSkills([resource], f.root), /managed|ownership|marker|overwrite/i)
    assert.equal(await readFile(target, 'utf8'), 'User replacement')
    provider.dispose()
  } finally { await f.cleanup() }
})

test('native error and cancellation preserve distinct terminal outcomes', async () => {
  const f = await fixture(), databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    for (const [index, reason] of ['error', 'aborted'].entries()) {
      const turn = index + 1, messages = [{ role: 'user', content: 'こんにちは' }]
      await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
      f.events.push({ type: 'turn/end', data: { turn, reason: { kind: reason } } })
      await f.listeners.get('agent/idle')!({ agent: f.agent })
    }
    const db = openConnection(databasePath)
    assert.deepEqual(db.prepare('SELECT status FROM ledger_runs ORDER BY status').all().map(row => row.status), ['cancelled', 'failed'])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 0)
    db.close()
  } finally { await handle.dispose(); await f.cleanup() }
})

test('cancelling intake releases the pending owner and admits the next request', async () => {
  const controller = new AbortController()
  let asked = false
  const f = await fixture({ ask: async () => { asked = true; controller.abort(); throw new Error('User cancelled intake') } })
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    await assert.rejects(
      f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: [{ role: 'user', content: 'Do that please' }], turn: 1, step: 0, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] })),
      /User cancelled intake|aborted|cancelled/i,
    )
    assert.equal(asked, true)
    f.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    await f.listeners.get('agent/idle')!({ agent: f.agent })
    const afterCancellation = openConnection(databasePath)
    assert.deepEqual(afterCancellation.prepare('SELECT status FROM ledger_runs').all().map((row: any) => row.status), ['cancelled'])
    assert.equal(afterCancellation.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 0)
    afterCancellation.close()

    const messages = [{ role: 'user', content: 'こんにちは' }]
    const result = await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    assert.equal(result.kind, 'enter')
  } finally { await handle.dispose(); await f.cleanup() }
})

test('intake answer failure without signal abort releases the failed owner', async () => {
  let asked = false
  const f = await fixture({ ask: async () => { asked = true; throw new Error('Question service unavailable') } })
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    await assert.rejects(
      f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: [{ role: 'user', content: 'Do that please' }], turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] })),
      /Question service unavailable/,
    )
    assert.equal(asked, true)
    f.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
    await f.listeners.get('agent/idle')!({ agent: f.agent })
    const afterFailure = openConnection(databasePath)
    assert.deepEqual(afterFailure.prepare('SELECT status FROM ledger_runs').all().map((row: any) => row.status), ['failed'])
    assert.equal(afterFailure.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 0)
    afterFailure.close()

    const messages = [{ role: 'user', content: 'こんにちは' }]
    const result = await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    assert.equal(result.kind, 'enter')
  } finally { await handle.dispose(); await f.cleanup() }
})

test('max-tokens is an interrupted boundary and releases ownership before the next request', async () => {
  const f = await fixture()
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    const first = [{ role: 'user', content: 'こんにちは' }]
    await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: first, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: first }))
    f.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
    const second = [{ role: 'user', content: 'こんにちは' }]
    const result = await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: second, turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: second }))
    assert.equal(result.kind, 'enter')
    const afterBoundary = openConnection(databasePath)
    assert.deepEqual(afterBoundary.prepare('SELECT status FROM ledger_runs ORDER BY started_at').all().map((row: any) => row.status), ['interrupted', 'active'])
    afterBoundary.close()
    f.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await f.listeners.get('agent/idle')!({ agent: f.agent })
  } finally { await handle.dispose(); await f.cleanup() }
})

test('max-tokens is finalized by native idle when no next request arrives', async () => {
  const f = await fixture()
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    const messages = [{ role: 'user', content: 'こんにちは' }]
    await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    f.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
    await f.listeners.get('agent/idle')!({ agent: f.agent })
    const afterIdle = openConnection(databasePath)
    assert.deepEqual(afterIdle.prepare('SELECT status FROM ledger_runs').all().map((row: any) => row.status), ['interrupted'])
    assert.equal(afterIdle.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 0)
    afterIdle.close()
    const next = [{ role: 'user', content: 'こんにちは' }]
    assert.equal((await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: next, turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: next }))).kind, 'enter')
  } finally { await handle.dispose(); await f.cleanup() }
})

test('a missing or wrong-turn boundary never releases the current owner', async () => {
  const f = await fixture()
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    const first = [{ role: 'user', content: 'こんにちは' }]
    await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: first, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: first }))
    await assert.rejects(
      f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: [{ role: 'user', content: '次の依頼' }], turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] })),
      /Previous task has not reached its confirmed native boundary/,
    )
    let db = openConnection(databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 1)
    db.close()

    f.events.push({ type: 'turn/end', data: { turn: 99, reason: { kind: 'max-tokens' } } })
    await assert.rejects(
      f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: [{ role: 'user', content: '次の依頼' }], turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] })),
      /Previous task has not reached its confirmed native boundary/,
    )
    db = openConnection(databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 1)
    db.close()
  } finally { await handle.dispose(); await f.cleanup() }
})

test('a non-admitted intake run is failed and released by a native blocked boundary', async () => {
  const f = await fixture()
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    const first = [{ role: 'user', content: 'Do that please' }]
    const result = await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: first, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: first }))
    assert.equal(result.kind, 'reject')
    f.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
    await f.listeners.get('agent/idle')!({ agent: f.agent })
    const afterBlocked = openConnection(databasePath)
    assert.deepEqual(afterBlocked.prepare('SELECT status FROM ledger_runs').all().map((row: any) => row.status), ['failed'])
    assert.equal(afterBlocked.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 0)
    afterBlocked.close()
    const next = [{ role: 'user', content: 'こんにちは' }]
    assert.equal((await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: next, turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: next }))).kind, 'enter')
  } finally { await handle.dispose(); await f.cleanup() }
})

test('a late valid intake answer after signal cancellation is not persisted', async () => {
  const controller = new AbortController()
  let asked = false
  const f = await fixture({ ask: async (request: any) => {
    asked = true
    controller.abort()
    return { answers: [{ id: request.questions[0].id, selected: ['chat'] }] }
  } })
  const databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  try {
    await assert.rejects(
      f.listeners.get('agent/pre-step')!({ agent: f.agent, messages: [{ role: 'user', content: 'Do that please' }], turn: 1, step: 0, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] })),
      /aborted|cancelled/i,
    )
    assert.equal(asked, true)
    const db = openConnection(databasePath)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_events WHERE event_type='intake.answered'").get()?.n, 0)
    assert.equal(db.prepare("SELECT status FROM ledger_runs").get()?.status, 'cancelled')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 0)
    db.close()
  } finally { await handle.dispose(); await f.cleanup() }
})

test('cancellation at the prepared-task handoff releases the owner before host registration', async () => {
  const controller = new AbortController(), failure = new Error('Cancelled at task handoff')
  const f = await fixture(), databasePath = join(f.root, 'memory.sqlite3')
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath })
  let bindings = 0
  f.services.agents.get = (id: string) => {
    if (++bindings === 2) controller.abort(failure)
    return id === f.agent.id ? f.agent : undefined
  }
  try {
    const messages = [{ role: 'user', content: 'こんにちは' }]
    let entered = false
    await assert.rejects(f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 1, step: 0, signal: controller.signal }, async () => { entered = true; return { kind: 'enter', messages } }), error => error === failure)
    assert.equal(entered, false)
    const db = openConnection(databasePath)
    assert.equal(db.prepare('SELECT status FROM ledger_runs').get()?.status, 'cancelled')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_execution_owners').get()?.n, 0)
    db.close()
    assert.equal((await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))).kind, 'enter')
  } finally { await handle.dispose(); await f.cleanup() }
})

for (const provider of ['typesafe', 'nimble'] as const) test(`core ${provider}: selected installed Skill reaches model context and model-invocation exclusions remain`, async () => {
  const f = await fixture(), originalFetch = globalThis.fetch
  f.services.credentials = { resolve: async () => ({ value: 'fixture-key', source: 'file' }) }
  const snapshot = f.services.skills.snapshot
  f.services.skills.snapshot = async () => ({ ...(await snapshot()), skills: [...(await snapshot()).skills,
    { name: 'fixture-writing', description: 'Rewrite prose clearly', invocation: { modelInvocable: true } },
    { name: 'excluded-skill', description: 'Writing', invocation: { modelInvocable: false } }] })
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++; const request = JSON.parse(String(init!.body)); assert.ok(!String(init!.body).includes('excluded-skill'))
    return Response.json({ model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]: [string, any]) => {
      const choice = id === 'task-type' ? 'writing' : q.instructions.includes('fixture-writing') ? 'yes' : 'no'
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])), confidence: 1 }]
    })) })
  }
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3'), typedDecisions: { provider, nimble: { endpoint: 'http://127.0.0.1:8000/v1/systemone', model: 'fixture-model' } } })
  try {
    const messages = [{ role: 'user', content: '文章を読みやすく修正して' }]
    const output = await f.listeners.get('agent/pre-step')!({ agent: f.agent, messages, turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    assert.equal(output.kind, 'enter'); assert.match(JSON.stringify(output.messages), /fixture-writing/); assert.ok(!JSON.stringify(output.messages).includes('excluded-skill'))
    assert.equal(calls, 2)
    const db = openConnection(join(f.root, 'memory.sqlite3'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enno_contracts').get()?.n, 0)
    db.close()
  } finally { await handle.dispose(); globalThis.fetch = originalFetch; await f.cleanup() }
})


test('core connects to an existing start-laya v1 worker without credentials or replacement scripts', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(), commands: any[] = []
  f.services.commands = { register(command: any) { commands.push(command); return () => {} } }
  f.services.credentials = { resolve() { throw new Error('No cloud credentials for Laya') } }
  const socket = await serveLaya(t, request => layaV1Reply(request))
  const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3'), typedDecisions: { 'laya-coreml': { socketPath: socket.path } } })
  try {
    const command = commands.find(c => c.name === 'kioku-decisions'), signal = new AbortController().signal
    const status = await command.handler({ rawInput: 'status', signal })
    assert.equal(JSON.parse(status.text).provider, 'typesafe'); assert.equal(socket.calls(), 0)
    const selected = await command.handler({ rawInput: 'use laya', signal })
    assert.equal(selected.kind, 'success'); assert.equal(socket.calls(), 3)
    const probe = await command.handler({ rawInput: 'probe', signal })
    assert.equal(JSON.parse(probe.text).protocol, 'v1')
    assert.equal(JSON.parse(probe.text).readiness.state, 'ready'); assert.equal(socket.calls(), 5)
  } finally { await handle.dispose(); await f.cleanup() }
})
