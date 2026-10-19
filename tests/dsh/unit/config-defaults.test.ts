import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../../../src/dsh/config.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'
import { SkillPromptsConfig } from '../../../src/dsh/skill-prompt-contracts.js'

test('the plugin suggests profile-memory hints while direct library callers stay off', () => {
  assert.equal(Config.parse({}).akinatorMemory.mode, 'suggest')
  assert.equal(Config.parse({ akinatorMemory: { maxCandidates: 4 } }).akinatorMemory.mode, 'suggest')
  assert.equal(Config.parse({ akinatorMemory: { mode: 'off' } }).akinatorMemory.mode, 'off')
  assert.equal(AkinatorMemoryConfig.parse({}).mode, 'off')
})

test('compiled skill prompts stay behind the documented promotion gate', () => {
  assert.equal(SkillPromptsConfig.parse({}).mode, 'full')
  assert.equal(Config.parse({}).skillPrompts.mode, 'full')
})
