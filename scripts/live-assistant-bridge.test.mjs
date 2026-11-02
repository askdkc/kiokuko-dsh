import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,readdir,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {liveAssistantStream} from './live-assistant-bridge.mjs'

test('live acceptance uses an isolated OS temporary directory and actual response', {timeout:5000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'kiokuko-live-'))
  const request={provider:'fixture',model:'fixture',sessionId:'isolated',purpose:'main',system:'test',messages:[],tools:[]}
  try {
    const pending=(async()=>{const events=[];for await(const event of liveAssistantStream(root,request))events.push(event);return events})()
    let files=[];for(let i=0;i<100&&!files.length;i++){files=await readdir(root);if(!files.length)await new Promise(r=>setTimeout(r,5))}
    const captured=JSON.parse(await readFile(join(root,files[0]),'utf8'))
    assert.equal(captured.transport,'live-assistant-in-loop; no external provider authentication')
    await writeFile(join(root,`response-${captured.id}.json`),JSON.stringify({text:'a fresh response'}))
    assert.ok((await pending).some(event=>event.type==='text-delta'&&event.text==='a fresh response'))
  } finally {await rm(root,{recursive:true,force:true})}
})
test('live acceptance rejects paths outside allowed private roots',async()=>{
  const stream=liveAssistantStream('/etc/kiokuko-bridge-forbidden',{})
  await assert.rejects(stream.next(),/private temporary/)
})

test('live acceptance rejects a temporary symlink to an outside directory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'kiokuko-live-link-'))
  try{const link=join(root,'escape');await symlink('/etc',link);await assert.rejects(liveAssistantStream(link,{}).next(),/escaped/)}
  finally{await rm(root,{recursive:true,force:true})}
})
