import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryDay,UNKNOWN_DAY,createCompanionMemory} from '../src/companion-memory.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {repairMessageTimes} from '../src/companion-store.mjs';
import {tmpDir,memoryStore,syntheticEngine,companionFixture,gate} from './support/audit-harness.mjs';

const BAD=9e15;
const capacity=()=>({tokens:16000,verified:true,source:'fixture'});
function dailyMock(calls){return async(id,request)=>{calls.push(id);const input=JSON.parse(request.messages[0].text);return JSON.stringify({coverageHash:input.coverageHash,summary:{text:'当日交流按原文记录。',eventIds:input.todayEventIds},core:[],branches:[],guide:{text:'',eventIds:[]},growthCandidates:[]});};}
async function stateWithGpt(){const state=await companionFixture(),at=state.conversations.conversation.createdAt;state.conversations.gptconv={id:'gptconv',characterId:'gpt',personaId:'default',lifeId:state.lives.gpt.id,title:'gpt',archived:false,createdAt:at,updatedAt:at,draft:'',choices:[],messages:[{id:'g-user',role:'user',text:'昨天和 gpt 的聊天',createdAt:at,status:'sent'},{id:'g-reply',role:'assistant',text:'gpt 的回答',createdAt:at+5,presentation:'presented'}]};return state;}
const summaries=(store,id)=>Object.keys(store.state.lives[id].memory?.summaries??{}).length;

test('B7: memoryDay answers "unknown" instead of throwing outside the Date range',()=>{
 assert.equal(memoryDay(8.64e15,'UTC'),'275760-09-13');
 assert.equal(memoryDay(BAD,'UTC'),UNKNOWN_DAY);assert.equal(memoryDay(NaN,'Asia/Shanghai'),UNKNOWN_DAY);
});

test('B7: imported times outside the Date range, non-positive, non-numeric or far ahead become the import time',()=>{
 const now=Date.UTC(2026,9,21);
 for(const createdAt of [BAD,1e300,-1,0,'abc',now+10*86400000]){const row=repairMessageTimes({role:'user',text:'x',createdAt},now);assert.equal(row.createdAt,now,String(createdAt));assert.equal(row.timeRepaired,true,String(createdAt));}
 const fine=repairMessageTimes({role:'user',text:'x',createdAt:now-1000,editedAt:BAD,presentedAt:now-500,revisions:[{text:'a',at:BAD},{text:'b',at:now-2000}]},now);
 assert.equal(fine.createdAt,now-1000);assert.equal(fine.editedAt,now-1000);assert.equal(fine.presentedAt,now-500);assert.deepEqual(fine.revisions.map(r=>r.at),[0,now-2000]);assert.equal(fine.timeRepaired,true);
 const untouched=repairMessageTimes({role:'user',text:'x',createdAt:now-1000},now);assert.equal(untouched.timeRepaired,undefined);
});

test('B7: a conversation imported with createdAt=9e15 keeps the character usable',async t=>{
 const root=tmpDir('b07-import',{t}),store=memoryStore(await stateWithGpt()),{engine}=syntheticEngine({getStore:()=>store});
 const provider={enabled:false,currentSelection:()=>({provider:'p1',model:'m'}),resolveConnection:()=>({mode:'global',connectionId:'p1',name:'p1',model:'m',error:null}),resolveContextCapacity:capacity,runTurn:async fn=>fn()};
 const service=await createCompanionService({store,engine,provider,dataRoot:root,now:Date.now});t.after(()=>service.close());
 const before=Date.now();
 await service.action('companion-conversation-import',{data:{format:'ai-buddy-conversations',version:1,conversations:[{id:'imported-conv',characterId:'claude',personaId:'default',title:'旧备份',messages:[{id:'imported-msg',role:'user',text:'来自导入文件的一句话',createdAt:BAD}]}]}});
 const persisted=Object.values(store.state.conversations).flatMap(c=>c.messages).find(m=>m.text==='来自导入文件的一句话');
 assert.ok(persisted.createdAt>=before&&persisted.createdAt<=Date.now());assert.equal(persisted.timeRepaired,true);
 for(const characterId of ['claude','gpt'])assert.equal((await service.action('companion-memory-view',{characterId})).ok,true,characterId);
});

test('B7: a bad time already in the store no longer stops the daily tick',async()=>{
 const state=await stateWithGpt();state.conversations.conversation.messages.push({id:'bad',role:'user',text:'坏时间戳',createdAt:BAD,status:'sent'});
 const store=memoryStore(state),calls=[];
 const result=await createCompanionMemory({store,runModel:dailyMock(calls),getCapacity:capacity,autoStart:false}).tick();
 assert.ok(result.results.length>=2);assert.ok(summaries(store,'gpt')>=1);assert.ok(summaries(store,'claude')>=1);
 const bad=Object.values(store.state.lives.claude.memory.events).find(e=>e.source.messageId==='bad');assert.equal(bad.dateUnknown,true);assert.notEqual(bad.day,UNKNOWN_DAY);
});

test('B7: one character that cannot be read is reported; the others are still consolidated',async()=>{
 const state=await stateWithGpt();state.conversations.conversation.messages.push({id:'bad',role:'user',text:'坏时间戳',createdAt:BAD,status:'sent'});delete state.lives.claude.startedAt;
 const store=memoryStore(state),calls=[],errors=[];
 const memory=createCompanionMemory({store,runModel:dailyMock(calls),getCapacity:capacity,autoStart:false,onError:row=>errors.push(row)});
 await memory.tick();
 assert.ok(summaries(store,'gpt')>=1,'gpt is consolidated');assert.equal(calls.includes('claude'),false);
 assert.ok(errors.some(row=>row.type==='memory-sync-error'&&row.characterId==='claude'));
 assert.match(store.state.lives.claude.memory.syncError.message,/未标日期/);
});

// B9: a reply generated at 23:59:30 on D is presented only after midnight.
const time=value=>Date.parse(value+'Z');
const D='2026-10-20';
function lateFixture(){
 return {cards:{a:{id:'a',name:'A',revision:1,fields:{},defaults:{personality:'安静'}}},personas:{p:{id:'p'}},activePersonaId:'p',groups:{},
  conversations:{c:{id:'c',characterId:'a',personaId:'p',lifeId:'la',messages:[
   {id:'u1',role:'user',text:'晚上好',createdAt:time(D+'T21:00:00')},{id:'r1',role:'assistant',text:'晚上好呀',createdAt:time(D+'T21:00:05'),presentation:'presented',requestId:'r1'},
   {id:'u2',role:'user',text:'明天一起去看海吧',createdAt:time(D+'T23:59:20')},{id:'late',role:'assistant',text:'好呀，约定了：明天去看海！',createdAt:time(D+'T23:59:30'),presentation:'pending',requestId:'late'}]}},
  lives:{a:{id:'la',operationId:'oa',mode:'normal',memory:{},growth:{},personalEvents:[],groupIntervals:{}}},memorySettings:{timeZone:'UTC'}};
}
function lateMemory({hold,state=lateFixture()}={}){
 const store=memoryStore(state),calls=[],clock={value:time('2026-10-21T00:01:00')};
 const runModel=async(id,request)=>{const input=JSON.parse(request.messages[0].text);calls.push(input.todayEventIds?.length);if(hold)await hold();return JSON.stringify({coverageHash:input.coverageHash,summary:{text:'当日交流按原文记录。',eventIds:input.todayEventIds},core:[],branches:[],guide:{text:'',eventIds:[]},growthCandidates:[]});};
 return {store,calls,clock,memory:createCompanionMemory({store,runModel,getCapacity:capacity,now:()=>clock.value,autoStart:false})};
}
const present=store=>store.mutate(s=>{const m=s.conversations.c.messages.find(x=>x.id==='late');m.presentation='presented';m.presentedAt=time('2026-10-21T00:01:10');});
const lateEvent=store=>Object.values(store.state.lives.a.memory.events).find(e=>e.source.messageId==='late');
const covered=(store,id)=>Object.values(store.state.lives.a.memory.summaries).some(s=>s.eventIds.includes(id));

test('B9: a reply presented while the day-D summary runs is moved to a later day and summarised',async()=>{
 const entered=gate(),release=gate();let first=true;
 const f=lateMemory({hold:async()=>{if(first){first=false;entered.resolve();await release.promise;}}});
 const running=f.memory.consolidate({characterId:'a',personaId:'p',day:D});await entered.promise;
 await present(f.store);await f.memory.sync('a');
 release.resolve();assert.equal((await running).status,'committed');
 const late=lateEvent(f.store);assert.equal(late.day,D);assert.equal(late.lateForDay,D);assert.equal(late.consolidationDay,'2026-10-21');assert.equal(covered(f.store,late.id),false);
 f.clock.value=time('2026-10-22T00:05:00');await f.memory.tick();
 assert.equal(covered(f.store,late.id),true);
 const context=await f.memory.context({characterId:'a',personaId:'p',query:'海'});assert.equal(context.inputEventIds.includes(late.id),false,'no longer sent as raw text every turn');
});

test('B9: control — a reply presented after the summary commits is rescheduled as before',async()=>{
 const f=lateMemory();assert.equal((await f.memory.consolidate({characterId:'a',personaId:'p',day:D})).status,'committed');
 await present(f.store);await f.memory.sync('a');const late=lateEvent(f.store);
 f.clock.value=time('2026-10-22T00:05:00');await f.memory.tick();
 assert.equal(late.consolidationDay,'2026-10-21');assert.equal(covered(f.store,late.id),true);
});

test('B9: an event missed before this fix is picked up by the next sync',async()=>{
 const f=lateMemory();assert.equal((await f.memory.consolidate({characterId:'a',personaId:'p',day:D})).status,'committed');
 await present(f.store);await f.memory.sync('a');
 // What the old code left behind: the event exists, its day has a summary without it, no later day.
 await f.store.mutate(s=>{const event=Object.values(s.lives.a.memory.events).find(e=>e.source.messageId==='late');delete event.consolidationDay;delete event.lateForDay;});
 await f.memory.sync('a');assert.equal(lateEvent(f.store).consolidationDay,'2026-10-21');
 f.clock.value=time('2026-10-22T00:05:00');await f.memory.tick();assert.equal(covered(f.store,lateEvent(f.store).id),true);
 const calls=f.calls.length;f.clock.value=time('2026-10-23T00:05:00');await f.memory.tick();assert.equal(f.calls.length,calls,'no repeated consolidation');
});
