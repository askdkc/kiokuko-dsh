import assert from 'node:assert/strict'
import test from 'node:test'
import { installDshModelRouting, type ModelRoutingChoice } from '../../../src/dsh/model-routing.js'

test('two logical auto tasks reset captured baseline; a later native manual choice is not overwritten', async () => {
  const hooks = new Map<string, (...args: any[]) => Promise<any>>()
  const agent = { id: 'agent', ctx: { on(name: string, listener: (...args: any[]) => Promise<any>) {
    hooks.set(name, listener); return () => { hooks.delete(name) }
  } } }
  let owner = 'run-1', choice: ModelRoutingChoice = { provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'low' }
  const saved: string[] = []
  const stop = installDshModelRouting(agent, async () => choice,
    { load: () => undefined, save: async binding => { saved.push(`${owner}:${binding.model}`) } },
    { prompts: () => undefined as any, owner: () => owner })
  const assembly = () => hooks.get('system-prompt/assemble')!({}, { signal: new AbortController().signal },
    async () => ({ variables: { provider: 'native', model: 'manual' }, sections: [], contexts: [] }))
  const request = (model: string) => hooks.get('agent/request')!({}, async () => ({ provider: 'native', model }))
  try {
    await assembly()
    assert.equal((await request('baseline-1')).model, 'gpt-6-luna')
    owner = 'run-2'; choice = { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'high' }
    await assembly()
    assert.equal((await request('baseline-2')).model, 'gpt-6-sol')
    assert.deepEqual(saved, ['run-1:baseline-1', 'run-2:baseline-2'])
    owner = 'run-3'; choice = { kind: 'native' }
    await assembly()
    assert.deepEqual(await request('manual-selected'), { provider: 'native', model: 'manual-selected' })
  } finally { stop() }
})
