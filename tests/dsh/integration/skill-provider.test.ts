import assert from 'node:assert/strict'
import test from 'node:test'
import { mountSoulPrompt } from '../../../src/dsh/prompt-policy.js'
import { createStandardSkillProvider, mountStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'

test('bundled provider exposes complete model/user-invocable definitions and disposes cleanly', async () => {
  const provider = createStandardSkillProvider()
  const result = await provider.list({})
  const listed = 'complete' in result ? result : { candidates: result, complete: true as const }
  assert.equal(listed.complete, true)
  assert.equal(listed.candidates.length, 6)
  assert.deepEqual(listed.candidates.map((candidate) => candidate.name), [
    'kiokuko-ui-design-soul',
    'kiokuko-simple-work',
    'kiokuko-single-purpose-functions',
    'kiokuko-enno-oduno',
    'memory-reasoning',
    'kiokuko-soul',
  ])
  assert.ok(listed.candidates.every((candidate) => candidate.invocation.modelInvocable && candidate.invocation.userInvocable))
  const soul = listed.candidates.find((candidate) => candidate.name === 'kiokuko-soul')!
  const definition = await provider.get(soul, {})
  assert.match(definition?.content ?? '', /name: kiokuko-soul/u)
  provider.dispose()
  assert.deepEqual(await provider.list({}), { candidates: [], complete: true })
  assert.equal(await provider.get(soul, {}), undefined)
})

test('provider and SOUL prompt are independently reversible Cordis-style effects', async () => {
  let unregisterCalls = 0
  let registeredProvider: unknown
  const abort = new AbortController()
  const context = {
    skills: {
      registerProvider(create: (control: { signal: AbortSignal }) => unknown) {
        registeredProvider = create({ signal: abort.signal })
        return () => { unregisterCalls += 1 }
      },
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section: (input: { name: string; order: number; text: string }) => {
        assert.equal(input.name, 'kiokuko:soul')
        assert.match(input.text, /name: kiokuko-soul/u)
        return () => undefined
      },
    },
    effect: async (execute: () => Promise<() => void>) => {
      const dispose = await execute()
      return dispose()
    },
  }
  const disposeProvider = mountStandardSkillProvider(context)
  assert.ok(registeredProvider)
  await mountSoulPrompt(context)
  disposeProvider()
  assert.equal(unregisterCalls, 1)
  abort.abort()
})
