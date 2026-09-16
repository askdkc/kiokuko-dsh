import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { mountSoulPrompt } from '../../../src/dsh/prompt-policy.js'
import { createStandardSkillProvider, mountStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { loadJapaneseOutputSkill } from '../../../src/dsh/japanese-output-skill.js'
import { createDshCapabilityCatalog } from '../../../src/dsh/capability-catalog.js'

test('bundled provider exposes complete model/user-invocable definitions and disposes cleanly', async () => {
  const provider = createStandardSkillProvider()
  const result = await provider.list({})
  const listed = 'complete' in result ? result : { candidates: result, complete: true as const }
  assert.equal(listed.complete, true)
  assert.equal(listed.candidates.length, 9)
  assert.deepEqual(listed.candidates.map((candidate) => candidate.name), [
    'kiokuko-ui-design-soul',
    'kiokuko-simple-work',
    'kiokuko-single-purpose-functions',
    'kiokuko-enno-oduno',
    'memory-reasoning',
    'veteran-programmer-skill',
    'kiokuko-soul',
    'kiokuko-lisp',
    'natural-japanese-output',
  ])
  assert.equal(createDshCapabilityCatalog(listed.candidates).skills.length, 9)
  assert.ok(listed.candidates.every((candidate) => candidate.invocation.modelInvocable && candidate.invocation.userInvocable))
  const soul = listed.candidates.find((candidate) => candidate.name === 'kiokuko-soul')!
  const definition = await provider.get(soul, {})
  assert.match(definition?.content ?? '', /name: kiokuko-soul/u)
  const japanese = listed.candidates.find(candidate => candidate.name === 'natural-japanese-output')!
  assert.equal((await provider.get(japanese, {}))?.content, (await loadJapaneseOutputSkill()).content)
  assert.equal(await provider.get({...japanese, name:'forged-japanese'}, {}),undefined)
  provider.dispose()
  assert.deepEqual(await provider.list({}), { candidates: [], complete: true })
  assert.equal(await provider.get(soul, {}), undefined)
})

test('Lisp Skill is discoverable and readable without enabling a Lisp session', async () => {
  const provider = createStandardSkillProvider()
  try {
    const listed = await provider.list({})
    const candidates = 'candidates' in listed ? listed.candidates : listed
    const lisp = candidates.find(candidate => candidate.name === 'kiokuko-lisp')
    assert.ok(lisp, 'available Skills must include the Lisp guide before enable')
    assert.deepEqual(lisp.invocation, { modelInvocable: true, userInvocable: true })
    const definition = await provider.get(lisp, {})
    assert.equal(definition?.content, await readFile(new URL('../../../skills/kiokuko-lisp/SKILL.md', import.meta.url), 'utf8'))
    assert.match(definition!.content, /\/kioku-lisp enable/u)
    assert.equal(await provider.get({ ...lisp, provider: 'other' }, {}), undefined)
    assert.equal(await provider.get({ ...lisp, locator: { skillName: 'kiokuko-soul' } }, {}), undefined)
    assert.equal(await provider.get({ ...lisp, name: '../../package.json', locator: { skillName: '../../package.json' } }, {}), undefined)
  } finally { provider.dispose() }
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
