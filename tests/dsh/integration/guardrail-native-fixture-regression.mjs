import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'../../..')
const env={...process.env,KIOKUKO_DSH_PACKAGE_ROOT:path.join(root,'tests/fixtures/dsh-runtime/node_modules'),PATH:path.dirname(process.execPath)+':'+process.env.PATH}
const probe=spawnSync(process.execPath,['scripts/run-tests.mjs','tests/dsh/integration/lisp/guardrail-native-policy.test.ts'],{cwd:root,env,encoding:'utf8',timeout:60000})
process.stdout.write(probe.stdout??'');process.stderr.write(probe.stderr??'')
assert.ifError(probe.error)
assert.equal(probe.signal,null,'Native policy fixture must finish normally')
assert.equal(probe.status,0,'The actual native registry fixture must compile and complete its owned-effect policy assertions')
const all=spawnSync(process.execPath,['tests/dsh/integration/guardrail-cycle.mjs'],{cwd:root,env,stdio:'inherit',timeout:300000})
assert.ifError(all.error)
assert.equal(all.signal,null,'Full runtime and typecheck acceptance must finish normally')
assert.equal(all.status,0,'Full runtime and typecheck acceptance must pass')
