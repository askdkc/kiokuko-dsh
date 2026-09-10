import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { applyJapaneseOutputSkill, JAPANESE_OUTPUT_SECTION, loadJapaneseOutputSkill, needsJapaneseOutputSkill } from '../../../src/dsh/japanese-output-skill.js'

test('Japanese output policy recognizes the requested model families across gateways and local suffixes', () => {
  for (const model of ['deepseek-chat', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', 'moonshotai/kimi-k2', 'z-ai/GLM-4.6', 'Qwen/Qwen3-32B-GGUF:Q4_K_M', 'tencent/HY3-preview', 'hunyuan-a13b', 'xiaomi/MiMo-V2', 'MiniMaxAI/MiniMax-M2']) {
    assert.equal(needsJapaneseOutputSkill(model), true, model)
  }
  for (const model of [undefined, '', 'gpt-oss-120b', 'gpt-4.1', 'claude-sonnet', 'gemma-3', 'rhythm', 'notdeepseek', 'qwenish', 'hybrid-model']) {
    assert.equal(needsJapaneseOutputSkill(model), false, model)
  }
})

test('bundled Japanese Skill is injected verbatim once without modifying the caller or another model', async () => {
  const skill = await loadJapaneseOutputSkill()
  assert.equal(skill.content, await readFile(new URL('../../../skills/japanese-translation-for-oss-models/SKILL.md', import.meta.url), 'utf8'))
  const original = {sections:[{name:'protocol',text:'Return JSON.'}],variables:{provider:'gateway',model:'qwen3-coder'}}
  const before = structuredClone(original)
  const result = await applyJapaneseOutputSkill(original)
  assert.deepEqual(original,before)
  assert.equal(result.sections.filter(s=>s.name===JAPANESE_OUTPUT_SECTION).length,1)
  assert.ok(result.variables.kiokuko_natural_japanese_output?.includes(skill.content))
  assert.match(result.variables.kiokuko_natural_japanese_output!, /required response schema/u)
  assert.match(result.variables.kiokuko_natural_japanese_output!, /explicit output-language request takes precedence/u)
  assert.deepEqual(await applyJapaneseOutputSkill(result),result)
  const switched = await applyJapaneseOutputSkill({...result,variables:{...result.variables,model:'gpt-4.1'}})
  assert.deepEqual(switched.sections,original.sections)
  assert.equal(switched.variables.kiokuko_natural_japanese_output,undefined)
  const unrelated = {sections:[],variables:{provider:'deepseek-host',model:'gpt-oss-120b'}}
  assert.equal(await applyJapaneseOutputSkill(unrelated),unrelated)
})
