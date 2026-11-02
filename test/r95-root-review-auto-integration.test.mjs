import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionService} from '../src/companion-service.mjs';
import {companionFixture,memoryStore,syntheticEngine} from './support/audit-harness.mjs';

const spin=()=>new Promise(resolve=>setImmediate(resolve));
async function until(read,label){for(let i=0;i<500;i++){const result=await read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(label);}
async function fixture(t,{silent=false}={}){
 const store=memoryStore(await companionFixture()),dataRoot=mkdtempSync(join(tmpdir(),'r95-auto-review-')),calls=[],audits=[];
 const provider={enabled:true,resolveConnection:()=>({mode:'global',connectionId:'p',name:'p',model:'m',error:null}),currentSelection:()=>({provider:'p',model:'m'}),captureConnection:()=>({id:'p',model:'m',kind:'custom'}),resolveContextCapacity:()=>({tokens:272000,verified:false,source:'fixture'}),runTurn:async fn=>fn(),runCaptured:async(_profile,fn)=>fn(),async *stream(options){if(options.purpose==='group-chat')calls.push(options);yield {type:'text-delta',text:options.purpose==='mood'?'{"changed":false}':silent?'{"speak":false}':'{"text":"完整的当前台词","emotion":"normal","affection":0}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const {engine}=syntheticEngine({getStore:()=>store});const service=await createCompanionService({store,engine,provider,dataRoot,r95Options:{getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:1})},audit:event=>audits.push(event)});
 t.after(async()=>{await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 const group=(await service.action('companion-group-save',{name:'真实服务调度回归',memberIds:['claude','gpt'],mode:'list'})).group;
 await service.action('companion-group-select',{id:group.id});await service.r95.action('social-settings',{auto:true});
 return {store,service,group,calls,audits};
}

test('R95 root review: real group scheduler accepts an Auto silent opportunity with no text',async t=>{
 const f=await fixture(t,{silent:true});await f.service.r95.action('auto-start',{requestId:'human-auto-1',mode:'rounds',rounds:1,memberIds:['claude']});
 await until(()=>f.store.state.groups[f.group.id].auto.status==='ended'||f.service.viewState().groupRuntime?.status==='failed','Auto did not settle');
 const group=f.store.state.groups[f.group.id];assert.equal(group.auto.status,'ended',f.service.viewState().groupRuntime?.error);assert.equal(Object.values(group.auto.completed)[0].status,'silent');assert.equal(group.messages.length,0);assert.equal(f.calls.length,1);
});

test('R95 root review: queued user interruption waits until the current Auto line is actually rendered',async t=>{
 const f=await fixture(t);await f.service.r95.action('auto-start',{requestId:'human-auto-2',mode:'rounds',rounds:6,memberIds:['claude']});
 const message=await until(()=>{const runtime=f.service.viewState().groupRuntime;if(runtime?.status==='failed')assert.fail(runtime.error);return f.store.state.groups[f.group.id].pending?.message;},'Auto line did not reach pending-presentation');
 const queued=await f.service.action('companion-group-send',{id:f.group.id,text:'等一下，我有一个新问题',clientRequestId:'actual-user-insertion'});assert.equal(queued.queued,true);assert.equal(f.store.state.groups[f.group.id].auto.status,'paused');
 await f.service.action('companion-group-present',{id:f.group.id,requestId:message.id});await f.store.flush();
 assert.equal(f.store.state.groups[f.group.id].pendingUserInputs[0].state,'queued','user insertion must not enter submitting before actual rendered acknowledgement');
 assert.equal(f.store.state.groups[f.group.id].messages.filter(row=>row.role==='user').length,0,'before render, the current Auto line remains the latest visible dialogue');
 assert.equal(f.calls.length,1,'a stored/presentGroup receipt is not yet the renderer acknowledgement');
 await f.service.r95.action('auto-rendered',{messageId:message.id});
 await until(()=>f.calls.length>=2,'queued user insertion was not resumed after the actual rendered acknowledgement');
 await until(()=>f.store.state.groups[f.group.id].pendingUserInputs[0].state==='submitted','queued user record did not commit after rendered acknowledgement');
 assert.equal(f.calls.length,2);assert.equal(f.store.state.groups[f.group.id].messages.filter(row=>row.role==='user').length,1);assert.equal(f.store.state.groups[f.group.id].auto.status,'paused','replying to a human must not silently resume Auto');
});
