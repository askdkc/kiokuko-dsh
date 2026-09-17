import { writeFile } from 'node:fs/promises'
import { compileSkillBundle } from '../dist/dsh/skill-compiler.js'
import { loadSkillSources } from '../dist/dsh/skill-sources.js'

const bundle = compileSkillBundle(await loadSkillSources())
await writeFile(new URL('../dist/dsh/skill-prompts.json', import.meta.url), `${JSON.stringify(bundle)}\n`)
console.error(`Skill prompts: ${bundle.resources.length} validated resources compiled`)
