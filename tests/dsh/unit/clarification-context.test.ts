import assert from 'node:assert/strict'
import test from 'node:test'
import {collectClarificationContext,clarificationReply,reusableClarificationAnswer,type ClarificationContext} from '../../../src/dsh/clarification-context.js'
test('repeated clarification retains each actual source and answer once without recursive envelope growth',()=>{
  const known=new Map<string,ClarificationContext>(),original={id:'human',text:'Update selected.conf; preserve the public API.'},messages=[original]
  for(let round=0;round<4;round++){
    const context=collectClarificationContext(messages,known)
    const id=`answer-${round}`,question=`target-${round}`,value=`actual human answer ${round}`
    const reply=clarificationReply(context,{id,questionId:`q-${round}`,question,value,scope:'bound-task'})
    assert.equal(reply.content.split(original.text).length-1,1)
    for(let i=0;i<=round;i++)assert.equal(reply.content.split(`actual human answer ${i}`).length-1,1)
    assert.equal(reply.context.answers.length,round+1)
    assert.ok(reply.content.length<3000)
    known.set(id,reply.context);messages.push({id,text:reply.content})
  }
})
test('same current question reuses observed answer as evidence while new sources, task scope or question require clarification',()=>{
  const base=collectClarificationContext([{id:'human',text:'Explain the selected file; preserve other constraints.'}],new Map())
  const reply=clarificationReply(base,{id:'answer',questionId:'q',question:'Which file?',value:'selected.conf',scope:'task:1'})
  const known=new Map([['answer',reply.context]])
  const same=collectClarificationContext([{id:'answer',text:reply.content}],known)
  assert.equal(reusableClarificationAnswer(same,'Which file?','task:1')?.value,'selected.conf')
  assert.equal(reusableClarificationAnswer(same,'Which file?','task:2'),undefined)
  assert.equal(reusableClarificationAnswer(same,'What action?','task:1'),undefined)
  const changed=collectClarificationContext([{id:'answer',text:reply.content},{id:'new-human',text:'Now change the other file.'}],known)
  assert.equal(reusableClarificationAnswer(changed,'Which file?','task:1'),undefined)
})
test('conflicting source identity is rejected instead of replacing a preserved constraint',()=>{
  assert.throws(()=>collectClarificationContext([{id:'same',text:'keep'},{id:'same',text:'replace'}],new Map()),/Conflicting/)
})
