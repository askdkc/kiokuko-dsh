import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { createDecisionService, mountDecisionCommand } from '../../../src/dsh/decisions/host.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import type { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import type { DshNativeCommandDefinition } from '../../../src/dsh/commands.js'

const signal = () => new AbortController().signal
const batch = { purpose: 'lisp', state: { fruit: 'apple' }, questions: [{ id: 'fruit', instructions: 'Which fruit?',
  choices: [{ id: 'apple', description: 'Apple' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' }] }
async function setup(t: import('node:test').TestContext) {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:')); t.after(() => db.close())
  for (const name of ['021_typed_decisions', '024_decision_selection']) db.exec(await readFile(new URL(`../../../migrations/${name}.sql`, import.meta.url), 'utf8'))
  return { db, runtime: { withDatabase: async (op: any) => op(db) } as Pick<DshCoreRuntime, 'withDatabase'> }
}
function command(service: ReturnType<typeof createDecisionService>) {
  let definition!: DshNativeCommandDefinition
  mountDecisionCommand({ register: d => { definition = d; return () => {} } }, service)
  return (rawInput: string, abort = signal()) => definition.handler({ rawInput, signal: abort } as any)
}
function wire(t: import('node:test').TestContext, pending?: () => Promise<Response>) {
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(url)
    if (pending) return pending()
    const body = JSON.parse(String(init.body))
    if (url.includes('api.openai.com')) return Response.json({ model: body.model, answers: body.questions.map((q: any) => ({
      name: q.name, type: 'choice', choice: 'apple', confidence: 1,
      probabilities: q.choices.map((c: any) => ({ value: c.value, probability: c.value === 'apple' ? 1 : 0 })),
    })), usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } })
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id,
      { type: 'choice', choice: 'apple', confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(c => [c, c === 'apple' ? 1 : 0])) }])) })
  })
  return urls
}

test('use openai probes the real adapter contract, persists, restores, and keeps old Jev bindings', async t => {
  const { db, runtime } = await setup(t), urls = wire(t), refs: string[] = []
  const ctx = { get: () => ({ resolve: async (ref: string) => { refs.push(ref); return { value: ref === 'OPENAI_API_KEY' ? 'openai-fixture' : 'jev-fixture', source: 'file' } } }) }
  const base = TypedDecisionsConfig.parse({}), make = () => createDecisionService(ctx, runtime, base, undefined, undefined, '/repo')
  const service = make(), run = command(service)
  await service.bind('old-jev')
  assert.equal((await run('use openai')).kind, 'success')
  assert.equal((service.status() as any).provider, 'openai')
  assert.equal((service.status() as any).model, 'gpt-6-luna')
  assert.equal((await service.bind('old-jev')).provider, 'typesafe')
  assert.equal((await service.evaluate('openai-task', batch, signal())).status, 'completed')
  assert.equal(urls.length, 2); assert.ok(urls.every(u => u === 'https://api.openai.com/v1/decisions'))
  const persisted = db.prepare('SELECT config_json FROM dsh_decision_selections').get()!
  assert.doesNotMatch(String(persisted.config_json), /fixture/)
  const restarted = make(), count = urls.length
  assert.equal(JSON.parse((await command(restarted)('status')).text!).provider, 'openai')
  assert.equal(urls.length, count, 'status makes no inference request')
  assert.equal((await restarted.bind('old-jev')).provider, 'typesafe')
  assert.equal((await restarted.bind('new-openai')).provider, 'openai')
  assert.equal((await command(restarted)('use jev')).kind, 'success')
  assert.equal((await restarted.bind('new-jev')).provider, 'typesafe')
  assert.equal((await restarted.bind('new-openai')).provider, 'openai')
  assert.match((await command(restarted)('')).text!, /use openai/)
  assert.ok(refs.includes('OPENAI_API_KEY')); assert.ok(refs.includes('TYPESAFE_API_KEY'))
})

test('missing OpenAI credential cannot publish selection, dispatch to Jev, or claim ready', async t => {
  const { db, runtime } = await setup(t), urls = wire(t)
  const ctx = { get: () => ({ resolve: async (ref: string) => ref === 'TYPESAFE_API_KEY' ? { value: 'jev-fixture', source: 'file' } : undefined }) }
  const service = createDecisionService(ctx, runtime), result = await command(service)('use openai')
  assert.equal(result.kind, 'error'); assert.match(result.text!, /DECISION_AUTH.*OPENAI_API_KEY/)
  assert.equal(urls.length, 0); assert.equal((service.status() as any).provider, 'typesafe')
  assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_decision_selections').get()!.n, 0)
  const explicit = createDecisionService(ctx, runtime, TypedDecisionsConfig.parse({ provider: 'openai' }))
  assert.deepEqual(await explicit.evaluate('unconfigured', batch, signal()), { status: 'fallback', reason: 'DECISION_AUTH' })
  assert.equal(urls.length, 0)
})

test('cancelled selection rejects late OpenAI response and preserves stored and bound Jev', async t => {
  const { db, runtime } = await setup(t)
  let resolve!: (r: Response) => void
  const urls = wire(t, () => new Promise(r => { resolve = r }))
  const service = createDecisionService({ get: () => ({ resolve: async () => ({ value: 'fixture', source: 'file' }) }) }, runtime)
  const controller = new AbortController(), pending = command(service)('use openai', controller.signal)
  while (!resolve) await new Promise(r => setTimeout(r, 1))
  controller.abort()
  assert.match((await pending).text!, /DECISION_CANCELLED/)
  resolve(Response.json({})); await new Promise(r => setTimeout(r, 0))
  assert.equal(urls.length, 1); assert.equal((service.status() as any).provider, 'typesafe')
  assert.equal((await service.bind('after-cancel')).provider, 'typesafe')
  assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_decision_selections').get()!.n, 0)
})
