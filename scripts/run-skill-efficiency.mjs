import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {DshSkillPrompts} from '../dist/dsh/skill-prompts.js'
import {requestSize} from '../dist/dsh/efficiency.js'

const baseline=JSON.parse(await readFile(new URL('../tests/fixtures/skill-prompts/baseline.json',import.meta.url),'utf8'))
const prompts=new DshSkillPrompts({mode:'compiled'})
const before=name=>baseline.resources.find(r=>r.path.endsWith(`/${name}/SKILL.md`) || name==='natural-japanese-output'&&r.path.endsWith('/japanese-translation-for-oss-models/SKILL.md')).content
const cases=[
  ['ordinary',['kiokuko-soul']],
  ['japanese',['kiokuko-soul','natural-japanese-output']],
  ['lisp',['kiokuko-soul','natural-japanese-output','kiokuko-lisp']],
  ['enno',['kiokuko-soul','kiokuko-enno-oduno','kiokuko-single-purpose-functions']],
  ['ui',['kiokuko-soul','kiokuko-single-purpose-functions','kiokuko-ui-design-soul']],
]
const results=[]
for(const [name,skills]of cases){
  const prior=skills.map(before).join('\n\n'),current=(await Promise.all(skills.map(s=>prompts.require(s)))).join('\n\n')
  const envelope=system=>({system,tools:[],messages:[{role:'user',content:[{type:'text',text:'Complete this bounded task.'}]}]})
  results.push({name,baselineSkillBytes:Buffer.byteLength(prior),compiledSkillBytes:Buffer.byteLength(current),baselineRequestBytes:requestSize(envelope(prior)).totalBytes,compiledRequestBytes:requestSize(envelope(current)).totalBytes})
}
assert.ok(prompts.diagnostics().every(d=>d.representation==='compiled'&&!d.fallback),'Fallback is not compiled efficiency evidence')
const reduction=1-results.reduce((s,r)=>s+r.compiledSkillBytes,0)/results.reduce((s,r)=>s+r.baselineSkillBytes,0)
const gates={reductionAtLeast30Percent:reduction>=0.3,noRequestGrowth:results.every(r=>r.compiledRequestBytes<=r.baselineRequestBytes)}
const report={format:1,evidence:'fixed representative serialized fixtures; native/wire delivery is checked separately',cases:results,reduction,gates,providerCalls:0,tokensSaved:null,costSaved:null,liveQuality:'unmeasured',defaultMode:'full'}
if(process.argv[2]==='--output'&&process.argv.length===4)await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n')
else if(process.argv.length!==2)throw new Error('Usage: run-skill-efficiency.mjs [--output path]')
console.log(JSON.stringify(report,null,2))
assert.ok(Object.values(gates).every(Boolean),'Skill efficiency target not met; do not enable compiled by default')
