import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, pairedSchedule, judgeClaims } from '../../../scripts/skill-coding/contracts.mjs';
import { put, safePath, snapshot } from '../../../scripts/skill-coding/workspace.mjs';
import { fixtures, inputsFor, acceptValues, oracleSource } from '../../../scripts/skill-coding/fixtures.mjs';
import { dockerArgs, runProcess } from '../../../scripts/skill-coding/docker.mjs';
import { nativeSession } from '../../../scripts/skill-coding/native.mjs';
const config = { maxDurationMs: 10000, maxRequests: 3, maxTokens: 20000, maxToolCalls: 2 };
test('paired schedule covers every fixture, mode and repeat without changing task order', () => {
    const runs = pairedSchedule(fixtures);
    assert.equal(runs.length, 45);
    assert.equal(new Set(runs.map(r => `${r.fixture.id}:${r.mode}:${r.repeat}`)).size, 45);
});
test('budgets reject exhaustion and unsupported verification claims', () => {
    const budget = new Budget(config);
    budget.tool();
    budget.tool();
    assert.throws(() => budget.tool(), /budget/);
    assert.equal(judgeClaims([{ check: 'local', status: 'executed', digest: 'new' }], [{ check: 'local', status: 'passed', digest: 'old' }]), false);
    assert.equal(judgeClaims([{ check: 'local', status: 'executed', digest: 'same' }], [{ check: 'local', status: 'passed', digest: 'same' }]), true);
});
test('workspace rejects escapes and symlinks without changing external data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-offline-'));
    try {
        for (const name of ['../secret', '/tmp/secret', '.git/config', 'a\\b'])
            await assert.rejects(safePath(root, name));
        await symlink('/tmp', join(root, 'link'));
        await assert.rejects(put(root, 'link/secret', 'bad'), /symlink/);
        await rm(join(root, 'link'));
        await put(root, 'main.mjs', 'export default 1');
        assert.equal(Object.keys((await snapshot(root)).files).length, 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
for (const fixture of fixtures)
    test(`${fixture.id}: independent oracle accepts intended values and rejects defective values`, async () => {
        // These are fixed, reviewed fixture implementations, never model-generated code.
        const good = (await import('data:text/javascript,' + encodeURIComponent(fixture.good))).default;
        const bad = (await import('data:text/javascript,' + encodeURIComponent(fixture.bad))).default;
        for (const stage of [1, 2]) {
            const inputs = inputsFor(fixture, stage);
            assert.equal(acceptValues(fixture.id, inputs.map(good), stage), true);
            assert.equal(acceptValues(fixture.id, inputs.map(bad), stage), false);
        }
        assert.match(oracleSource(fixture, 2), /spawnSync/);
    });
test('Docker policy exposes read-only fixture and oracle with no network, credential or host socket', () => {
    const args = dockerArgs('image@sha256:abc', '/fixture', '/oracle', 'test');
    assert.ok(args.includes('--network=none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--pull=never'));
    assert.equal(args.filter(a => a.includes('readonly')).length, 2);
    assert.ok(!args.some(a => a.includes('docker.sock') || a === '--env'));
});
test('subprocess timeout and output overflow cannot pass', async () => {
    const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 });
    assert.notEqual(timeout.code, 0);
    const overflow = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBytes: 100 });
    assert.equal(overflow.overflow, true);
});
test('real DSH loop uses fresh session and scripted provider, retaining followup', async () => {
    const budget = new Budget(config), model = { provider: 'fixture', model: 'fixture', contextWindow: 1024, maxOutputTokens: 128 };
    const session = await nativeSession({ model, prompt: 'Fixture only', tools: [], budget, adapterOverride: llm => new class extends llm.LlmAdapter {
            async resolveModel() { return { provider: 'fixture', id: 'fixture', name: 'fixture' }; }
            async *stream() { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'observed' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'observed' } }; yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
        }() });
    try {
        assert.equal(await session.turn('first'), 'observed');
        assert.equal(await session.turn('second'), 'observed');
        assert.equal(budget.requests, 2);
    }
    finally {
        await session.close();
    }
});

test('review artifact rejects seeded dead helper and empty control flow', async () => {
    const {inspectArtifact}=await import('../../../scripts/skill-coding/artifact.mjs');
    const fixture=fixtures.find(f=>f.id==='review');
    assert.equal(inspectArtifact({'main.mjs':fixture.good},fixture).length,0);
    assert.ok(inspectArtifact({'main.mjs':fixture.seed},fixture).some(v=>v.reason==='empty_branch'));
    assert.ok(inspectArtifact({'main.mjs':fixture.seed},fixture).some(v=>v.reason==='seeded_dead_helper'));
});
test('native provider failure is not converted into successful completion',async()=>{
    const budget=new Budget(config),model={provider:'fixture',model:'fixture',contextWindow:1024,maxOutputTokens:128};
    const session=await nativeSession({model,prompt:'test',tools:[],budget,adapterOverride:llm=>new class extends llm.LlmAdapter {
        async resolveModel(){return {provider:'fixture',id:'fixture',name:'fixture'}}
        async *stream(){throw new Error('fixture failure')}
    }()});
    try {await assert.rejects(session.turn('test'),/provider_or_turn_failure/);assert.equal(budget.requests,1)}finally{await session.close()}
});
test('cancellation stops native turn without consuming another request',async()=>{
    const budget=new Budget(config),controller=new AbortController(),model={provider:'fixture',model:'fixture',contextWindow:1024,maxOutputTokens:128};
    const session=await nativeSession({model,prompt:'test',tools:[],budget,signal:controller.signal,adapterOverride:llm=>new class extends llm.LlmAdapter {
        async resolveModel(){return {provider:'fixture',id:'fixture',name:'fixture'}}
        async *stream(options){await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));}
    }()});
    try {const turn=session.turn('test');setTimeout(()=>controller.abort(),30);await assert.rejects(turn,/interrupted/)}finally{await session.close()}
});

test('paired comparison exposes regression rather than averaging it away',async()=>{
 const {compareRecords}=await import('../../../scripts/skill-coding/contracts.mjs');
 const result=compareRecords([{case:'a',repeat:0,mode:'baseline-full',status:'passed'},{case:'a',repeat:0,mode:'candidate-full',status:'failed'}]);
 assert.equal(result.regressions.length,1);assert.equal(result.summary['candidate-full'].passed,0);
});

test('native loop executes the registered file tool and consumes its result',async()=>{
 const budget=new Budget({...config,maxRequests:4}), model={provider:'fixture',model:'fixture',contextWindow:1024,maxOutputTokens:128};let written=null,requests=0;
 const session=await nativeSession({model,prompt:'Use write',budget,tools:[{name:'write',description:'fixture write',parameters:{content:{type:'string',required:true}},output:{schema:{type:'object'},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:args=>{written=args.content;return {saved:true}}}],adapterOverride:llm=>new class extends llm.LlmAdapter {
  async resolveModel(){return {provider:'fixture',id:'fixture',name:'fixture'}}
  async *stream(){
   if(requests++===0){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:'write-1',name:'write',argumentsDelta:'{"content":"artifact"}'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'write-1',name:'write',arguments:'{"content":"artifact"}'}};yield {type:'finish',reason:{kind:'tool-calls'}}}
   else{yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'done'};yield {type:'block-end',index:0,block:{type:'text',text:'done'}};yield {type:'finish',reason:{kind:'stop'}}}
  }
 }()});
 try {assert.equal(await session.turn('write artifact'),'done');assert.equal(written,'artifact');assert.equal(requests,2)}finally{await session.close()}
});

test('fixture tools expose bounded operations with object-shaped results',async()=>{
 const {fixtureTools}=await import('../../../scripts/skill-coding/tools.mjs');
 const root=await mkdtemp(join(tmpdir(),'fixture-tools-'));
 try {
  const tools=fixtureTools({work:root,resources:[],budget:new Budget({...config,maxToolCalls:8}),checks:async check=>({check,status:'passed'}),submit:()=>{}});
  const call=(name,args)=>tools.find(tool=>tool.name===name).execute(args);
  await call('write',{path:'main.mjs',content:'export default 42;'});
  assert.deepEqual(await call('read',{path:'main.mjs'}),{value:'export default 42;'});
  assert.equal((await call('search',{query:'default'})).value[0].line,1);
  await assert.rejects(call('write',{path:'../outside.mjs',content:'bad'}));
  await assert.rejects(call('verify',{check:'shell'}));
 }finally{await rm(root,{recursive:true,force:true})}
});
