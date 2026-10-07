import assert from 'node:assert/strict'
import test from 'node:test'
import { offlineSkillCatalog } from '../helpers/offline-skill-catalog.mjs'
import { SkillsShCompatibilityProvider } from '../../../src/skills/providers/skills-sh-compat.js'

test('offline aggregate Skill discovery uses the real provider parser without external transport', async () => {
  let outbound = 0
  const fetchImpl = offlineSkillCatalog(async () => { outbound++; throw new Error('Unexpected external transport') })
  const provider = new SkillsShCompatibilityProvider({ fetchImpl })
  const result = await provider.search({ query: 'typescript', limit: 5 })
  assert.deepEqual(result.candidates, [])
  assert.equal(outbound, 0)
})

test('offline catalog rejects unsupported community endpoints and preserves other transports', async () => {
  const forwarded: string[] = []
  const fetchImpl = offlineSkillCatalog(async input => { forwarded.push(String(input)); return Response.json({ local: true }) })
  for (const input of ['https://skills.sh/api/search?q=typescript&limit=5&unknown=1', 'https://skills.sh/api/skills/private', 'http://skills.sh/api/search?q=typescript&limit=5']) {
    await assert.rejects(fetchImpl(input), /Offline Skill catalog/)
  }
  await assert.rejects(fetchImpl('https://skills.sh/api/search?q=typescript&limit=5', { method: 'POST', body: 'private task' }), /Offline Skill catalog/)
  assert.deepEqual(forwarded, [])
  assert.deepEqual(await (await fetchImpl('http://127.0.0.1:1234/local-fixture')).json(), { local: true })
  assert.deepEqual(forwarded, ['http://127.0.0.1:1234/local-fixture'])
})
