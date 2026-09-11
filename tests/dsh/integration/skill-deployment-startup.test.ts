import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../../../src/dsh/index.js'
import { loadJapaneseOutputSkill } from '../../../src/dsh/japanese-output-skill.js'
import { loadStandardSkillParity } from '../../../src/dsh/standard-skill-integrity.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

const home = isolateSkillHome()

test('plugin startup synchronizes before provider registration and repeats after a package reload', async t => {
  const parity = await loadStandardSkillParity()
  const japanese = await loadJapaneseOutputSkill()
  const soul = parity.files.find(file => file.skillName === 'kiokuko-soul')!
  const root = path.join(home(), '.agents', 'skills')
  const soulPath = path.join(root, soul.skillName, soul.relativePath)
  await mkdir(path.dirname(soulPath), { recursive: true })
  const old = `${soul.managedMarker}\nold soulRead requestId contract`
  await writeFile(soulPath, old)
  const ctx = new Context()
  let registrations = 0
  const host = await ctx.plugin({ name: 'skill-deployment-fixture', apply(context: Context) {
    return context.provide('kiokukoDsh', { skills: { registerProvider() {
      for (const file of parity.files) assert.equal(readFileSync(path.join(root, file.skillName, file.relativePath), 'utf8'), file.content)
      assert.equal(readFileSync(path.join(root, 'japanese-translation-for-oss-models', 'SKILL.md'), 'utf8'), japanese.content)
      registrations++
      return () => {}
    } } })
  } })
  t.after(() => host.dispose())
  for (let pass = 0; pass < 2; pass++) {
    const fiber = ctx.plugin(plugin, {})
    await fiber
    assert.equal(registrations, pass + 1)
    for (const file of parity.files) assert.equal(await readFile(path.join(root, file.skillName, file.relativePath), 'utf8'), file.content)
    await fiber.dispose()
    if (pass === 0) await writeFile(soulPath, old)
  }
})

test('disabled plugin does not sync; unmanaged conflicts warn and preserve bundled provider startup', async t => {
  const soulPath = path.join(home(), '.agents', 'skills', 'kiokuko-soul', 'SKILL.md')
  await writeFile(soulPath, 'user-owned')
  const ctx = new Context()
  const disabled = ctx.plugin(plugin, { enabled: false })
  await disabled
  assert.equal(await readFile(soulPath, 'utf8'), 'user-owned')
  await disabled.dispose()
  const warnings = t.mock.method(console, 'warn', () => {})
  const enabled = ctx.plugin(plugin, {})
  await enabled
  assert.equal(await readFile(soulPath, 'utf8'), 'user-owned')
  assert.ok(warnings.mock.calls.some(call => String(call.arguments[0]).includes('synchronization failed (CONFLICT)')))
  await enabled.dispose()
})
