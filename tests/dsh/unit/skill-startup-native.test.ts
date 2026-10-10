import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const available = existsSync(join(packages, '@deepseek-ai/dsh-tool-skill/lib/index.js'))
if (!available && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Skill startup regression requires the native runtime')

for (const mode of ['full', 'compiled'] as const) for (const skillToolPlacement of ['late', 'agent'] as const) test(`first native Skill call succeeds with ${mode}/${skillToolPlacement} registration, without task preparation`, { skip: !available, timeout: 60_000 }, async () => {
  const f = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}), mode, skillToolPlacement, extra: { lisp: { enabled: true, sbclPath: 'must-not-start-sbcl' }, typedDecisions: { mode: 'off' } } })
  try {
    f.responses.push(
      f.mock.toolCallResponse('first-guidance', 'skill', { name: 'kiokuko-soul' }),
      f.mock.toolCallResponse('lisp-guidance', 'skill', { name: 'kiokuko-lisp' }),
      f.mock.textResponse('Only read the installed guidance; no implementation was performed.'),
    )
    await f.turn('Explain the installed guidance. Do not implement changes or start Lisp.')
    assert.equal(f.model.requests.length, 3)
    const results = nativeToolResults(f.model.requests.at(-1).messages)
    for (const [id, name] of [['first-guidance', 'kiokuko-soul'], ['lisp-guidance', 'kiokuko-lisp']]) {
      const result = results.find((entry: any) => entry.toolCallId === id)
      assert.equal(result?.isError, false, `${name}: first read must not require prepare_requested_work`)
      const rendered = result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
      assert.ok(rendered.includes(`<skill_content name="${name}">`))
    }
    assert.ok(f.model.requests.every((request: any) => !request.tools.some((tool: any) => tool.name.startsWith('lisp_'))), 'reading Lisp guidance must not activate its execution tools')
    assert.equal(results.length, 2, 'only the two read calls execute; no preparation or implementation is injected')
  } finally { await f.close() }
})
