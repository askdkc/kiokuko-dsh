import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'../../..')
const metadata=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'))
assert.ok(metadata.files.includes('guardrail/'),'Final package must ship the bounded Rust guardrail before combined acceptance')
const env={...process.env,PATH:path.dirname(process.execPath)+':'+process.env.PATH,KIOKUKO_DSH_PACKAGE_ROOT:path.join(root,'tests/fixtures/dsh-runtime/node_modules')}
function run(command,args){const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit',timeout:600000});if(result.error||result.signal){console.error(result.error??result.signal);process.exit(2)}if(result.status!==0)process.exit(result.status??2)}
run(process.execPath,['tests/dsh/integration/guardrail-cycle.mjs'])
run(process.execPath,['scripts/run-tests.mjs','tests/dsh/unit/task-completion.test.ts','tests/dsh/integration/task-lifecycle-release-order-regression.test.ts','tests/dsh/integration/task-completion-tool.test.ts','tests/dsh/integration/owned-execution.test.ts','tests/dsh/integration/task-authority-owned.test.ts'])
run('npm',['run','build'])
run(process.execPath,['scripts/module-smoke-root-regression.mjs'])
