import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'../../..')
const tests=['tests/dsh/unit/guardrail.test.ts','tests/dsh/integration/guardrail-owned.test.ts','tests/dsh/integration/lisp/guardrail-boundary.test.ts','tests/dsh/integration/guardrail-package.test.ts','tests/dsh/integration/guardrail-source.test.ts','tests/dsh/integration/lisp/guardrail-native-policy.test.ts']
const env={...process.env,KIOKUKO_DSH_PACKAGE_ROOT:path.join(root,'tests/fixtures/dsh-runtime/node_modules'),PATH:path.dirname(process.execPath)+':'+process.env.PATH}
for(const args of [['scripts/run-tests.mjs',...tests],['node_modules/typescript/bin/tsc','-p','tsconfig.json','--noEmit']]){
 const r=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit',timeout:240000})
 if(r.error){console.error(r.error);process.exit(2)}if(r.signal){console.error(r.signal);process.exit(2)}if(r.status!==0)process.exit(r.status??2)
}
