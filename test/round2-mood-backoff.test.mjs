import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';

const evidenceRoot=process.env.ROUND2_MODEL_OUTPUT??join(tmpdir(),'round2-mood-source');
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t,{failure=null}={}){
 mkdirSync(evidenceRoot,{recursive:true});let at=Date.parse('2026-11-10T12:00:00Z'),response='plain text',calls=[];
 const store=memoryStore(await companionFixture({now:at})),dataRoot=mkdtempSync(join(evidenceRoot,'fixture-'));
 const provider={enabled:true,captureConnection:()=>({id:'fixture',model:'fixture-model',kind:'custom',contextTokens:272000}),runCaptured:(_profile,fn)=>fn(),
  async *stream(options){if(options.purpose==='mood'){calls.push(at);if(failure)throw failure;yield {type:'text-delta',text:response};}else yield {type:'text-delta',text:'{"speak":false}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const build=()=>createCompanionR95({store,dataRoot,provider,now:()=>at,getContext:()=>({characterId:store.state.activeCharacterId,personaId:store.state.activePersonaId,conversationId:store.state.activeConversationId}),getRuntimeState:()=>({sleepPhase:'awake',canPresent:true}),memory:{context:async()=>({text:''})},delta:()=>{},audit:()=>{}});let core=await build();
 t.after(async()=>{await core.close();await store.flush();});
 const tick=async ms=>{at+=ms;await core.tick();for(let n=0;n<100&&core.busy();n++)await immediate();assert.equal(core.busy(),false,'synthetic background request settled');await store.flush();};
 return {get core(){return core;},store,calls,tick,restart:async()=>{await core.close();core=await build();},setResponse:value=>{response=value;},event:async id=>core.userInteraction({eventId:id,kind:'chat',text:'synthetic chat'})};
}

test('R95 tick backs off a failing pending mood batch for ten minutes without discarding evidence',async t=>{
 const f=await setup(t);await f.event('chat-1');await f.tick(0);for(let second=1;second<=600;second++)await f.tick(1000);
 assert.ok(f.calls.length<=4,`ten minutes made ${f.calls.length} mood requests`);
 t.diagnostic('mood requests over ten minutes: '+f.calls.length+'; relative ms: '+f.calls.map(at=>at-f.calls[0]).join(','));
 assert.deepEqual(f.store.state.lives.claude.r95.pendingMoodEventIds,['chat-1']);
});

test('R95 tick honors a 429 Retry-After of 120 seconds before another mood request',async t=>{
 const f=await setup(t,{failure:Object.assign(Error('synthetic rate limit'),{status:429,retryAfterMs:120000})});await f.event('chat-1');await f.tick(0);
 for(let second=1;second<120;second++)await f.tick(1000);
 assert.equal(f.calls.length,1,'120-second Retry-After suppresses the 30-second retry');await f.tick(1000);assert.equal(f.calls.length,2);
 t.diagnostic('120-second Retry-After relative ms: '+f.calls.map(at=>at-f.calls[0]).join(','));
});

test('R95 stops a batch after five failures and resumes only for a new chat, then clears failures on success',async t=>{
 const f=await setup(t);await f.event('chat-1');for(const delay of [0,30000,120000,600000,1800000])await f.tick(delay);
 assert.equal(f.calls.length,5);await f.tick(1800000);assert.equal(f.calls.length,5,'same batch stops automatically');
 await f.event('chat-1');await f.tick(0);assert.equal(f.calls.length,5,'a duplicate chat cannot unlock stopped retries');
 await f.event('chat-2');await f.tick(0);assert.equal(f.calls.length,6,'new chat unlocks the pending batch');
 f.setResponse('{"changed":false}');await f.tick(30000);assert.equal(f.calls.length,7);assert.deepEqual(f.store.state.lives.claude.r95.pendingMoodEventIds,[]);
 await f.event('chat-3');await f.tick(0);assert.equal(f.calls.length,8,'successful evaluation clears the delay and failure count');
});

test('a new chat waits at least 30 seconds after failure and preserves a longer Retry-After',async t=>{
 const f=await setup(t);await f.event('chat-1');await f.tick(0);await f.event('chat-2');await f.tick(29999);assert.equal(f.calls.length,1);await f.tick(1);assert.equal(f.calls.length,2);
 const rate=await setup(t,{failure:Object.assign(Error('synthetic rate limit'),{status:429,retryAfterMs:120000})});await rate.event('chat-1');await rate.tick(0);await rate.event('chat-2');await rate.tick(119999);assert.equal(rate.calls.length,1);await rate.tick(1);assert.equal(rate.calls.length,2);
});

test('mood retry state stays in runtime and a new life or restart can evaluate retained events',async t=>{
 const f=await setup(t);await f.event('chat-1');await f.tick(0);const failedLife=f.store.state.lives.claude.id;
 await f.store.mutate(state=>{state.lives.claude.id='new-life';state.lives.claude.operationId='new-operation';state.lives.claude.r95={schemaVersion:1};});await f.event('new-life-chat');await f.tick(0);assert.equal(f.calls.length,2,'old-life failure delay cannot block the new life');
 assert.notEqual(f.store.state.lives.claude.id,failedLife);
 await f.restart();await f.tick(0);assert.equal(f.calls.length,3,'restart permits a retained pending event without persisting retry control');
});
