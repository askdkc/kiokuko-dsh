import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildDshMessageSources } from '../../../src/dsh/message-sources.js'
import { compileSkillBundle } from '../../../src/dsh/skill-compiler.js'
import { DshSkillPrompts } from '../../../src/dsh/skill-prompts.js'
import { loadSkillSources } from '../../../src/dsh/skill-sources.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'

const name = 'one-shot-software-completion'
const admitted = {
  task: 'Complete the requested code change.', intakeStatus: 'ready', nextAction: 'proceed',
  memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false }, context: null,
} as const

test('completion guidance is discoverable and delivers only the selected reference in full and compiled modes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'completion-skill-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sources = await loadSkillSources()
  const entry = sources.find(source => source.name === name && source.relativePath === 'SKILL.md')
  assert.ok(entry, 'completion Skill must be in the packaged inventory')
  const references = sources.filter(source => source.name === name && source.relativePath.startsWith('references/'))
  assert.equal(references.length, 4)
  // Byte budgets are reproducible input-size limits, not model token counts.
  assert.ok(Buffer.byteLength(entry.content) <= 6144)
  assert.ok(references.every(source => Buffer.byteLength(source.content) <= 8192))
  const artifact = pathToFileURL(path.join(directory, 'bundle.json'))
  await writeFile(artifact, JSON.stringify(compileSkillBundle(sources)))
  for (const mode of ['full', 'compiled'] as const) {
    const prompts = new DshSkillPrompts({ mode }, artifact)
    const provider = createStandardSkillProvider(prompts)
    try {
      const listed = await provider.list({})
      const candidates = 'candidates' in listed ? listed.candidates : listed
      const candidate = candidates.find(skill => skill.name === name)
      assert.ok(candidate)
      assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
      const definition = await provider.get(candidate, {})
      assert.ok(definition)
      const unrelated = await buildDshMessageSources({ ...admitted, skillPrompts: prompts })
      assert.ok(!unrelated.some(source => source.name === name || source.kind === 'expert'))
      for (const reference of references) {
        const messages = await buildDshMessageSources({ ...admitted, skillPrompts: prompts,
          routeSkillNames: [name], expertRefs: [{ skillName: name, relativePath: reference.relativePath }] })
        assert.equal(messages.find(source => source.name === name)?.text, definition.content)
        assert.deepEqual(messages.filter(source => source.kind === 'expert').map(source => source.text), [reference.content])
        assert.ok(messages.filter(source => source.kind === 'route-skill' || source.kind === 'expert')
          .reduce((bytes, source) => bytes + Buffer.byteLength(source.text), 0) <= 14_336)
      }
      assert.ok(prompts.diagnostics().every(diagnostic => !diagnostic.fallback))
    } finally { provider.dispose() }
  }
})
