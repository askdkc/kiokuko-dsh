import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountModelsClient } from "../../../src/models-client.js";
import { KiokukoModelsService } from "../../../src/dsh/models/service.js";
import { ModelsConfigStore } from "../../../src/dsh/models/config-store.js";
import { CredentialFile } from "../../../src/dsh/models/vendor/credentials.js";
import { modelsResponse } from "../../../src/dsh/models/surface.js";

const first = {provider:"head-one",model:"gpt-6.1-sol"}, second = {provider:"head-two",model:"gpt-6.1-sol"}, worker={provider:"flash",model:"deepseek-flash"};
const pair=(head=first)=>({preset:"gpt-6.1-sol-deepseek-v4.1-flash" as const,head,worker});
type Node = {type:unknown;props:any};
const text=(node:any):string=>node==null?"":typeof node!=="object"?String(node):Array.isArray(node)?node.map(text).join(""):text(node.props?.children);
const nodes=(node:any):Node[]=>node&&typeof node==="object"?[...(Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)])]:[];

/** Executes the real mounted settings component and HTTP handler with deterministic React hooks. */
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"pair-client-"));
  let unavailable=false;
  const catalog={
    listProviders:()=>[{id:first.provider,name:"First Sol"},{id:second.provider,name:"Second Sol"},{id:worker.provider,name:"Flash",route:{provider:worker.provider,family:"deepseek" as const,connection:"api" as const,protocol:"chat-completions" as const}}],
    listModels:async(provider:string)=>unavailable&&provider===worker.provider?[]:[{provider,id:provider===worker.provider?worker.model:first.model,name:provider}],
    resolveCallConfig:async(binding:any)=>binding,
  };
  const store=new ModelsConfigStore(join(dir,"models.json"));
  const service=new KiokukoModelsService({llm:{...catalog,registerAdapter:()=>{const stop=()=>{};stop.replace=()=>{};return stop;},discoverModels:async()=>[]},catalog,config:store,credentials:new CredentialFile(join(dir,"credentials.json")),now:()=>1_000,sessionCreatedAt:()=>500,assertCurrent:id=>assert.ok(["a","b"].includes(id))});
  await service.start();
  const g=globalThis as any, names=["createSnapshotStore","jsx","jsxs","Fragment","useState","useRef","useEffect","fetch"], previous=Object.fromEntries(names.map(name=>[name,g[name]]));
  const values:any[]=[],effects:{deps:unknown[];cleanup?:()=>void}[]=[];
  let cursor=0,view:any,sessionId="a",effectQueue:(()=>void)[]=[],mounted=true;
  const slots:any[]=[],requests:{url:string;body:any}[]=[],pending=new Set<Promise<unknown>>();
  let hold:((url:string)=>Promise<void>)|undefined;
  g.createSnapshotStore=(initial:any)=>({getSnapshot:()=>initial,update:(change:any)=>change(initial)});
  g.jsx=g.jsxs=(type:unknown,props:any)=>({type,props});g.Fragment="fragment";
  g.useState=(initial:any)=>{const index=cursor++;if(!(index in values))values[index]=typeof initial==="function"?initial():initial;return [values[index],(next:any)=>{values[index]=next;}];};
  g.useRef=(initial:any)=>{const index=cursor++;if(!(index in values))values[index]={current:initial};return values[index];};
  g.useEffect=(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++;const old=effects[index];if(!old||deps.some((d,i)=>d!==old.deps[i])){effectQueue.push(()=>{old?.cleanup?.();const cleanup=effect();effects[index]={deps,...(cleanup?{cleanup}:{})};});}};
  g.fetch=(url:string,options?:RequestInit)=>{const body=options?.body?JSON.parse(String(options.body)):undefined;requests.push({url,body});const request=new Request("http://localhost"+url,options);const result=(async()=>{await hold?.(url);return modelsResponse(service,request);})();pending.add(result);void result.finally(()=>pending.delete(result));return result;};
  mountModelsClient({locale:{register(){}},effect(){},on(){},slots:{inject(_name,run){run();},register(definition,component){slots.push({definition,component});}}});
  const settings=slots.find(row=>row.definition.id==="kiokuko-models");
  const anchor=slots.find(row=>row.definition.id==="kiokuko-models-dialog").definition.inject().activeModelsSession;
  const render=()=>{cursor=0;anchor.current=sessionId;const panel=settings.component();view=panel.type(panel.props);const queued=effectQueue;effectQueue=[];for(const run of queued)run();return view;};
  const settle=async()=>{for(let i=0;i<20;i++){if(pending.size)await Promise.all([...pending]);await new Promise(r=>setTimeout(r,2));render();if(!pending.size&&!nodes(view).some(n=>n.props?.["aria-busy"]===true))return;}throw new Error("settings component did not settle");};
  const find=(type:string,label:string)=>{const found=nodes(view).find(n=>n.type===type&&(n.props["aria-label"]===label||text(n)===label));assert.ok(found,`${type}: ${label}`);return found;};
  render();
  return {service,store,requests,render,settle,find,text:()=>text(view),
    unavailable(value:boolean){unavailable=value;},hold(value:(url:string)=>Promise<void>){hold=value;},
    navigate(id:string){sessionId=id;render();},
    async close(){if(mounted){mounted=false;for(const effect of effects)effect?.cleanup?.();}for(const name of names){if(previous[name]===undefined)delete g[name];else g[name]=previous[name];}await service.close();await rm(dir,{recursive:true,force:true});},
  };
}
const headLabel="Head connection · GPT-6.1-Sol";
const choose=(f:Awaited<ReturnType<typeof fixture>>,binding=first)=>{f.find("select",headLabel).props.onChange({target:{value:JSON.stringify(binding)}});f.render();};
const click=(f:Awaited<ReturnType<typeof fixture>>,label:string)=>{const node=f.find("button",label);assert.equal(node.props.disabled,false,label);node.props.onClick();};

test("real settings component requires an explicit provider and handles cancel, repeated clicks, scoped saves and native effort",async()=>{
  const f=await fixture();try{
    await f.settle();
    assert.equal(f.find("select",headLabel).props.value,"");
    assert.equal(f.find("button","Use pair in current chat").props.disabled,true);
    choose(f);click(f,"Cancel pair changes");f.render();
    assert.equal(f.find("select",headLabel).props.value,"");
    assert.equal(f.requests.filter(r=>r.body).length,0);
    choose(f);const apply=f.find("button","Pair default for new chats");apply.props.onClick();apply.props.onClick();await f.settle();
    assert.equal(f.requests.filter(r=>r.body?.op==="head-worker").length,1,"rapid repeated click only submits once");
    assert.deepEqual((await f.store.read()).defaultHeadWorker,pair());
    assert.match(f.text(),/Current chat: Ordinary model selection/);
    choose(f,second);click(f,"Use pair in current chat");await f.settle();
    assert.deepEqual((await f.store.read()).sessionHeadWorkers?.a,pair(second));
    assert.deepEqual((await f.store.read()).defaultHeadWorker,pair());
    await f.service.updateHeadWorkerEffort("a","high");
    click(f,"Reload");await f.settle();
    assert.equal(f.find("select",headLabel).props.value,JSON.stringify(second));
    click(f,"Use pair in current chat");await f.settle();
    assert.equal((await f.store.read()).sessionHeadWorkers?.a?.head.reasoningEffort,"high");
    click(f,"Disable pair in current chat");await f.settle();
    assert.equal((await f.store.read()).sessionHeadWorkers?.a,null);
    assert.deepEqual((await f.store.read()).defaultHeadWorker,pair());
  }finally{await f.close();}
});

test("real settings component rejects stale updates and disables unavailable candidates with a reason",async()=>{
  const f=await fixture();try{
    await f.settle();choose(f);
    await f.service.selectHeadWorker(pair(second),"default",(await f.service.list()).revision);
    click(f,"Use pair in current chat");await f.settle();
    assert.match(f.text(),/Configuration changed; reload before saving/);
    assert.equal((await f.store.read()).sessionHeadWorkers?.a,undefined);
    f.unavailable(true);click(f,"Reload");await f.settle();
    assert.equal(f.find("button","Use pair in current chat").props.disabled,true);
    assert.equal(f.find("button","Pair default for new chats").props.disabled,true);
    assert.match(f.text(),/DeepSeek V4.1 Flash の利用可能/);
  }finally{await f.close();}
});

test("late settings reads cannot replace a newer chat scope or redirect a click to the old chat",async()=>{
  const f=await fixture();let release!:()=>void;try{
    await f.settle();
    await f.service.selectHeadWorker(pair(),"current",(await f.service.list()).revision,"a");
    await f.service.selectHeadWorker(pair(second),"current",(await f.service.list()).revision,"b");
    const delayed=new Promise<void>(r=>{release=r;});
    f.hold(url=>url.includes("sessionId=a")?delayed:Promise.resolve());
    click(f,"Reload");f.navigate("b");
    await new Promise(r=>setTimeout(r,30));f.render();
    assert.equal(f.find("select",headLabel).props.value,JSON.stringify(second));
    release();await f.settle();
    assert.equal(f.find("select",headLabel).props.value,JSON.stringify(second));
    click(f,"Use pair in current chat");await f.settle();
    assert.equal(f.requests.filter(r=>r.body?.op==="head-worker").at(-1)?.body.sessionId,"b");
    assert.deepEqual((await f.store.read()).sessionHeadWorkers?.a,pair());
  }finally{release?.();await f.close();}
});
