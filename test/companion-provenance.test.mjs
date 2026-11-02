import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionMemory,estimateMemoryTokens} from '../src/companion-memory.mjs';

const now=Date.parse('2026-10-31T12:00:00Z');
const initial=()=>({cards:{a:{id:'a',name:'A',fields:{},defaults:{},revision:1}},personas:{p:{id:'p'}},activePersonaId:'p',activeConversationId:'c',memorySettings:{timeZone:'UTC'},lives:{a:{id:'la',operationId:'oa',mode:'normal',memory:{},growth:{},groupIntervals:{},personalEvents:[]}},groups:{},conversations:{c:{id:'c',characterId:'a',personaId:'p',lifeId:'la',messages:[{id:'reply',role:'assistant',text:'[2026-10-30] 这是角色亲口说的日期。',createdAt:now-1000,presentation:'presented'}]}}});
function setup(state=initial()){
 const original=structuredClone(state);const store={get state(){return state;},snapshot:()=>structuredClone(state),async mutate(fn){const next=structuredClone(state);const result=await fn(next);state=next;return result;}};
 const memory=createCompanionMemory({store,now:()=>now,autoStart:false,getCapacity:()=>({tokens:16000,verified:true}),runModel:async()=>{throw Error('unexpected compression');}});return {store,memory,original};
}
test('historical assistant text stays verbatim while date, source, scope and message ID enter a separate budgeted source index',async()=>{
 const {store,memory,original}=setup();const context=await memory.context({characterId:'a',personaId:'p',conversationId:'c',query:'你好',systemTokens:70,reserveTokens:1200});
 assert.equal(context.messages.length,1);assert.equal(context.messages[0].text,original.conversations.c.messages[0].text);
 assert.equal(context.messages[0].provenance.day,'2026-10-31');assert.equal(context.messages[0].provenance.sourceKind,'character-statement');assert.equal(context.messages[0].provenance.scope,'persona:p');assert.equal(context.messages[0].provenance.messageId,'reply');
 assert.match(context.text,/内部历史来源索引/);assert.match(context.text,/character-statement/);assert.match(context.text,/persona:p/);assert.match(context.text,/reply/);
 assert.ok(context.capacity.estimatedInputTokens>=estimateMemoryTokens(context.text)+estimateMemoryTokens(context.messages)+estimateMemoryTokens('你好')+70);
 assert.deepEqual(store.state.conversations,original.conversations);await memory.close();
});
test('an existing contaminated assistant prefix is cleaned only in the model projection and recorded in provenance',async()=>{
 const state=initial();state.conversations.c.messages[0].text='[2026-10-31; character-statement; persona:p] 原始模型台词';const {memory,store,original}=setup(state);
 const context=await memory.context({characterId:'a',personaId:'p',query:'继续'});assert.equal(context.messages[0].text,'原始模型台词');assert.equal(context.messages[0].provenance.sourcePrefixRemoved,true);assert.deepEqual(store.state.conversations,original.conversations);await memory.close();
});
test('historical explicit quotations remain literal while user text, normal brackets and quoted code are never cleaned',async()=>{
 const label='[2026-10-31; character-statement; persona:p]';
 for(const origin of ['request','previous-user','current-query']){
  const state=initial(),reply=state.conversations.c.messages[0];reply.text=label+' 原始引用';
  if(origin==='request')reply.request={inputUserText:'请原样引用 '+label};
  if(origin==='previous-user')state.conversations.c.messages.unshift({id:'user',role:'user',text:'Quote '+label+' verbatim.',createdAt:now-2000,status:'sent'});
  const {memory,store,original}=setup(state),context=await memory.context({characterId:'a',personaId:'p',query:origin==='current-query'?'请原样引用 '+label:'继续'}),projected=context.messages.find(row=>row.role==='assistant');assert.equal(projected.text,reply.text);assert.equal(projected.provenance.sourcePrefixRemoved,false);assert.deepEqual(store.state.conversations,original.conversations);await memory.close();
 }
 const state=initial();state.conversations.c.messages=[{id:'user',role:'user',text:label+' 用户原话',createdAt:now-2000,status:'sent'},{id:'reply',role:'assistant',text:'```text\n'+label+'\n```',createdAt:now-1000,presentation:'presented'}];const {memory,store,original}=setup(state),context=await memory.context({characterId:'a',personaId:'p',query:'继续'});assert.deepEqual(context.messages.map(row=>row.text),state.conversations.c.messages.map(row=>row.text));assert.deepEqual(store.state.conversations,original.conversations);await memory.close();
});
test('a prior request to stop quoting does not preserve an old contaminated assistant prefix',async()=>{
 const label='[2026-10-31; character-statement; persona:p]',state=initial();state.conversations.c.messages[0].text=label+' 原始模型台词';state.conversations.c.messages[0].request={inputUserText:'请不要再引用 '+label,preserveSourceLiteral:true};const {memory,store,original}=setup(state),context=await memory.context({characterId:'a',personaId:'p',query:'继续'});assert.equal(context.messages[0].text,'原始模型台词');assert.deepEqual(store.state.conversations,original.conversations);await memory.close();
});
test('edited user originals carry an explicit budgeted correction rule outside the unchanged user text',async()=>{
 const state=initial();state.conversations.c.messages=[{id:'edited-user',role:'user',text:'修正后的事实',createdAt:now-2000,editedAt:now-1000,revisions:[{text:'原先说错的事实',at:now-2000}],status:'sent'}];const {memory,store,original}=setup(state),context=await memory.context({characterId:'a',personaId:'p',query:'继续'}),message=context.messages[0];
 assert.equal(message.text,'修正后的事实');assert.equal(message.revision,1);assert.equal(message.provenance.correction.kind,'用户更正记录');assert.equal(message.provenance.correction.currentRevision,1);assert.equal(message.provenance.correction.latest,true);assert.match(message.provenance.correction.rule,/旧说法不作为当前事实/);assert.match(context.text,/用户更正记录/);assert.deepEqual(store.state.conversations,original.conversations);await memory.close();
});
