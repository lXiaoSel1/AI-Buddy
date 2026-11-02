import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionService} from '../src/companion-service.mjs';
import {groupTextDecoder} from '../src/output-events.mjs';
import {groupHeaderContext} from '../src/group-header.mjs';
import {companionFixture,memoryStore,syntheticEngine} from './support/audit-harness.mjs';

async function until(read,label){for(let i=0;i<500;i++){const result=await read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(label);}
async function fixture(t){
 const store=memoryStore(await companionFixture()),dataRoot=mkdtempSync(join(tmpdir(),'ggc1-group-failure-')),calls=[];
 const provider={enabled:true,resolveConnection:()=>({mode:'global',connectionId:'p',name:'p',model:'m',error:null}),currentSelection:()=>({provider:'p',model:'m'}),captureConnection:()=>({id:'p',model:'m',kind:'custom'}),resolveContextCapacity:()=>({tokens:272000,verified:false,source:'fixture'}),runTurn:async fn=>fn(),runCaptured:async(_profile,fn)=>fn(),async *stream(request){if(request.purpose==='group-chat'){calls.push(request);yield {type:'text-delta',text:calls.length===1?'{"text":"malformed missing closing brace"':'{"text":"本次重试完整回复","emotion":"normal","affection":0}'};}else yield {type:'text-delta',text:'{"changed":false}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const {engine}=syntheticEngine({getStore:()=>store}),service=await createCompanionService({store,engine,provider,dataRoot,r95Options:{getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:1})}});
 t.after(async()=>{await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 const group=(await service.action('companion-group-save',{name:'Synthetic failure group',memberIds:['claude','gpt'],mode:'list'})).group;await service.action('companion-group-select',{id:group.id});await service.r95.action('social-settings',{auto:true});
 await service.r95.action('auto-start',{requestId:'human-start',mode:'rounds',rounds:6,memberIds:['claude','gpt']});await until(()=>service.viewState().groupRuntime.status==='failed','group did not reach its real parse failure');
 return {store,service,group,calls};
}

test('GG-C1 complete plain group dialogue has a neutral compatibility result',()=>{
 const decoder=groupTextDecoder();decoder.feed('DeepSeek：「这是一条完整的虚构回复。」');const parsed=decoder.finish();
 assert.equal(parsed.text,'DeepSeek：「这是一条完整的虚构回复。」');assert.equal(parsed.affection,0);assert.equal(parsed.emotion,'normal');
});
test('GG-C1 asynchronous parse failure pauses Auto without advancing the opportunity',async t=>{
 const f=await fixture(t),auto=f.store.state.groups[f.group.id].auto;
 assert.equal(auto.status,'paused');assert.equal(auto.pending.status,'failed');assert.equal(auto.pending.characterId,'claude');assert.equal(auto.roundIndex,0);assert.equal(auto.opportunityIndex,0);assert.equal(Object.keys(auto.completed).length,0);
});
test('GG-C1 explicit concurrent retry stays on the failed member and produces only one new request',async t=>{
 const f=await fixture(t),reservation=f.store.state.groups[f.group.id].auto.pending.requestId;
 await Promise.all([f.service.action('companion-group-retry',{id:f.group.id}),f.service.action('companion-group-retry',{id:f.group.id})]);
 const message=await until(()=>f.store.state.groups[f.group.id].pending?.message,'retry did not produce a pending line'),auto=f.store.state.groups[f.group.id].auto;
 assert.equal(f.calls.length,2);assert.equal(message.characterId,'claude');assert.equal(auto.pending.requestId,reservation);assert.equal(auto.opportunityIndex,0);assert.equal(auto.status,'paused');
 await f.service.action('companion-group-present',{id:f.group.id,requestId:message.id});await f.service.action('companion-group-present',{id:f.group.id,requestId:message.id});
 const completed=f.store.state.groups[f.group.id].auto;assert.equal(completed.pending,null);assert.equal(completed.opportunityIndex,1);assert.equal(completed.status,'paused');assert.equal(Object.keys(completed.completed).length,1);assert.equal(f.calls.length,2);
});
test('GG-C1 own assistant history uses the JSON protocol and private conversation text stays out of group context',async t=>{
 const f=await fixture(t);await f.service.action('companion-group-retry',{id:f.group.id});const first=await until(()=>f.store.state.groups[f.group.id].pending?.message,'retry did not produce a line');await f.service.action('companion-group-present',{id:f.group.id,requestId:first.id});await f.service.r95.action('auto-stop');
 const secret='SYNTHETIC_PRIVATE_ONLY_NOT_FOR_GROUP';await f.store.mutate(state=>{const row=Object.values(state.conversations).find(row=>row.characterId==='claude');row.messages.push({id:'synthetic-private-only',role:'user',text:secret,createdAt:Date.now(),status:'completed'});});
 await f.service.action('companion-group-send',{id:f.group.id,text:'请同一位角色继续',forceCharacterId:'claude'});await until(()=>f.store.state.groups[f.group.id].pending?.message,'same member did not receive the next line');
 const request=f.calls.at(-1),own=request.messages.filter(row=>row.role==='assistant');assert.ok(own.length>0);for(const row of own){const body=JSON.parse(row.content[0].text);assert.equal(body.text,'本次重试完整回复');assert.equal(body.affection,0);}assert.ok(!JSON.stringify(request).includes(secret));
});
test('GG-C1 failed group header separates the failed member from the displayed historical speaker',()=>{
 const state={activeGroupId:'g',groups:[{id:'g',memberIds:['claude','deepseek'],personaId:'p'}],characters:[{id:'claude',name:'Claude'},{id:'deepseek',name:'DeepSeek'}],personas:[{id:'p'}],groupRuntime:{status:'failed',queue:['deepseek'],currentMessage:{id:'old',role:'assistant',characterId:'claude',text:'上一条已呈现的虚构回复'}}};
 const context=groupHeaderContext(state);assert.equal(context.speaker?.id??null,null);assert.equal(context.failedSpeaker?.id,'deepseek');assert.equal(context.displaySpeaker?.id,'claude');
});
