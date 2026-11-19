import test from 'node:test';
import assert from 'node:assert/strict';
import {appendSocialExperience,createCompanionMemory,collectMemoryEvents,socialMemoryScope} from '../src/companion-memory.mjs';

const NOW=Date.parse('2026-11-12T12:00:00Z'),DAY=86400000;
const message=(id,text,at,extra={})=>({id,text,role:'user',createdAt:at,...extra});
function fixture(){
 const history=[
  message('clinic','我周三上午去复查。',NOW-12*DAY),
  ...Array.from({length:150},(_,i)=>message('bulk-'+i,'unrelated backlog '+i+' '+('abcdefgh '.repeat(25)),NOW-DAY+i)),
  message('last','刚说到晚餐还没吃。',NOW-30000),
 ];
 const state={cards:{a:{id:'a'}},personas:{p:{id:'p'},q:{id:'q'}},activePersonaId:'p',activeConversationId:'c',
  conversations:{c:{id:'c',characterId:'a',personaId:'p',lifeId:'l',messages:history},
   other:{id:'other',characterId:'a',personaId:'q',lifeId:'l',messages:[message('secret','外部身份：复查地点 SECRET.',NOW-50000)]}},
  groups:{g:{id:'g',personaId:'p',memberIds:['a'],intervals:{a:[{start:2,end:null}]},messages:[
   message('outside','PREJOIN_SECRET',NOW-60000,{seq:1}),
   message('current','今天的话题是火锅。',NOW-1000,{seq:2}),
  ]}},
  lives:{a:{id:'l',operationId:'op',mode:'normal',startedAt:NOW-14*DAY,groupIntervals:{g:[{start:2,end:null}]},memory:{},growth:{},personalEvents:[]}},
  memorySettings:{timeZone:'UTC'}};
 let current=state,tail=Promise.resolve();
 const store={get state(){return current;},snapshot:()=>structuredClone(current),mutate(fn,{guard}={}){
  const task=tail.then(async()=>{
   if(guard&&!guard(current))return;
   const next=structuredClone(current),result=await fn(next);current=next;return result;
  });
  tail=task.catch(()=>{});return task;
 }};
 const calls=[];
 const memory=createCompanionMemory({store,autoStart:false,now:()=>NOW,getCapacity:()=>({tokens:32768,verified:true}),runModel:async(_id,request)=>{calls.push(request.purpose);throw Error('simulated model refusal');}});
 return {store,memory,calls};
}
const privateContext={characterId:'a',personaId:'p',conversationId:'c'};

test('a greeting with a 30k+ old backlog sends no history-compaction calls',async()=>{
 const {memory,store,calls}=fixture();
 const originals=structuredClone(store.state.conversations);
 const start=performance.now();
 const first=await memory.context({...privateContext,query:'晚安'});
 const repeat=await memory.context({...privateContext,query:'晚安'});
 assert.equal(calls.length,0);
 assert.equal(repeat.compression,null);
 assert.ok(repeat.messages.some(row=>row.source.messageId==='last'));
 assert.ok(!repeat.messages.some(row=>row.source.messageId==='clinic'));
 assert.deepEqual(store.state.conversations,originals);
 assert.ok(first.capacity.estimatedInputTokens+first.capacity.reserveTokens<=32768);
 assert.ok(first.capacity.estimatedInputTokens<8192,'a greeting must not spend most of the context on recent backlog');
 console.log('retrieval-monitor',JSON.stringify({sampleMessages:originals.c.messages.length,modelCalls:calls.length,iterations:2,totalMs:Number((performance.now()-start).toFixed(2))}));
});

test('recall uses a matching topic reference even when original words differ and excludes stale summaries',async()=>{
 const {memory,store,calls}=fixture();
 const note=message('plan','周五上午去办手续。',NOW-10*DAY,{revisions:[{text:'周一上午去办手续。',at:NOW-11*DAY}]});
 await store.mutate(state=>{
  state.conversations.c.messages.unshift(note);
  const versions=collectMemoryEvents(state,'a').filter(row=>row.source.messageId==='plan');
  state.lives.a.memory.branches={
   current:{topic:'驾驶证更新',text:'驾照事项已约好。',eventIds:[versions.at(-1).id],day:versions.at(-1).day},
   stale:{topic:'驾驶证更新',text:'旧版说周一上午。',eventIds:[versions[0].id],day:versions[0].day},
  };
 });
 const ctx=await memory.context({...privateContext,query:'驾驶证更新定在哪天？'});
 assert.ok(ctx.messages.some(row=>row.text==='周五上午去办手续。'));
 assert.doesNotMatch(JSON.stringify(ctx),/周一上午|SECRET/);
 assert.equal(calls.length,0);
});

test('local fallback finds relevant original without a summary',async()=>{
 const {memory,calls}=fixture();
 const ctx=await memory.context({...privateContext,query:'复查是哪一天？'});
 assert.ok(ctx.messages.some(row=>row.text==='我周三上午去复查。'));
 assert.doesNotMatch(JSON.stringify(ctx),/SECRET/);
 assert.equal(calls.length,0);
});

test('a warmed reply waits for a queued original edit and uses the current revision',async()=>{
 const {memory,store}=fixture();
 const args={...privateContext,query:'复查是哪一天？'};
 await memory.context(args);
 let release;
 const pending=store.mutate(async state=>{
  await new Promise(resolve=>{release=resolve;});
  const original=state.conversations.c.messages[0];
  original.revisions=[{text:original.text,at:original.createdAt}];
  original.text='改成周四上午去复查。';original.editedAt=NOW-1000;
 });
 const reply=memory.context(args);
 await new Promise(resolve=>setImmediate(resolve));
 release();await pending;
 const ctx=await reply;
 assert.ok(ctx.messages.some(row=>row.text==='改成周四上午去复查。'));
 assert.ok(!ctx.messages.some(row=>row.text==='我周三上午去复查。'));
});

test('a warmed reply stops using social originals when the host grant is removed',async()=>{
 const {memory,store,calls}=fixture();
 const scope={characterId:'a',lifeId:'l',operationId:'op',personaId:'p',channel:'bilibili',conversationId:'watch'};
 const source={id:'watched',eventRef:'watch-receipt',scope,sourcePluginId:'bilibili',sourceKind:'bilibili-watch',sourceVersion:1,createdAt:NOW-1000,text:'这段旅行视频已读懂。',stage:'understood',understandingState:'understood',presentationState:'not-presented',deliveryState:'not-sent',visibilityScope:'conversation',evidenceRefs:[{id:'material-receipt',sha256:'a'.repeat(64)}]};
 await appendSocialExperience(store,{eventRef:source.eventRef,scope},{verifyEvent:async()=>source});
 const args={...privateContext,query:'晚安'};
 const authorized=await memory.context({...args,authorizedSocialScopes:[socialMemoryScope(scope)]});
 assert.ok(authorized.messages.some(row=>row.text===source.text));
 const revoked=await memory.context(args);
 assert.ok(!JSON.stringify(revoked).includes(source.text));
 assert.equal(calls.length,0);
});

test('large accumulated index entries cannot block a short reply',async()=>{
 const {memory,store,calls}=fixture();
 await store.mutate(state=>{
  const source=collectMemoryEvents(state,'a').find(row=>row.source.messageId==='clinic');
  state.lives.a.memory.core=Object.fromEntries(Array.from({length:4},(_,i)=>[i,{kind:'experience',text:'长期经历 '+i+' '+'oversized '.repeat(900),eventIds:[source.id],day:source.day}]));
 });
 const ctx=await memory.context({...privateContext,query:'晚安'});
 assert.ok(ctx.messages.some(row=>row.source.messageId==='last'));
 assert.ok(ctx.capacity.estimatedInputTokens+ctx.capacity.reserveTokens<=32768);
 assert.equal(calls.length,0);
 assert.equal(Object.keys(store.state.lives.a.memory.core).length,4);
});

test('automatic work with an oversized evidence packet defers without paying to compress it',async()=>{
 const {memory,calls}=fixture();
 await assert.rejects(memory.context({...privateContext,query:'旧证据'.repeat(5000),allowQueryCompression:false}),{code:'MEMORY_CONTEXT_CAPACITY'});
 assert.equal(calls.length,0);
});

test('group Auto preserves a required user line, refuses over-capacity raw input, and keeps excluded history out',async()=>{
 const {memory,store,calls}=fixture();
 const args={characterId:'a',personaId:'p',groupId:'g',query:'今天的话题是火锅。',queryInHistory:true,requiredMessageIds:['current']};
 let ctx=await memory.context(args);
 assert.equal(ctx.messages.filter(row=>row.source.messageId==='current').length,1);
 assert.doesNotMatch(JSON.stringify(ctx),/SECRET|去复查/);
 await store.mutate(state=>{state.groups.g.messages[1].text='长'.repeat(15000);});
 await assert.rejects(memory.context({...args,query:'长'.repeat(15000)}),{code:'MEMORY_CONTEXT_CAPACITY'});
 assert.equal(calls.length,0);
});
