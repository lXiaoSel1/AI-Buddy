import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompanionService} from '../src/companion-service.mjs';
import {createPresentationState} from '../src/companion-presentation-state.mjs';
import {companionFixture,memoryStore,syntheticEngine} from './support/audit-harness.mjs';

async function until(check){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw Error('social voice did not settle');}
async function fixture(t,{admit}={}){
 const root=await mkdtemp(join(tmpdir(),'r5-social-')),store=memoryStore(await companionFixture()),segments=[],finishes=[];
 const voice={admit:admit??(()=>({epoch:4,voiceProfileVersion:8})),segment:v=>segments.push(v),finish:v=>finishes.push(v),invalidate:()=>{}};
 const {engine}=syntheticEngine({getStore:()=>store});
 const provider={enabled:true,captureConnection:()=>({id:'fixture',model:'fixture'}),runCaptured:(_,fn)=>fn(),resolveSearchCapability:()=>({supported:false}),async *stream(){yield {type:'text-delta',text:JSON.stringify({speak:true,mode:'awake',text:'看完这个视频，我想起了海边。'})};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionService({store,engine,provider,dataRoot:root,voice,automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false,getRuntimeState:()=>({sleepPhase:'awake',canPresent:true})}});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 await service.r95.action('social-settings',{proactive:true});
 const scope=service.r95.activeScope();
 await service.r95.userInteraction({scope,eventId:'watched-video',kind:'chat',text:'看完了这部视频。'});
 assert.equal((await service.r95.proactive.tick()).delivered,true);
 const line=service.r95.view().lines[0];assert(line);
 return {service,store,scope,line,segments,finishes};
}

test('real social ACK feeds existing voice conversation once; audio receipt never marks it read or adds a chat reward',async t=>{
 const f=await fixture(t),before=structuredClone(f.store.state.relationships),messages=structuredClone(f.store.state.conversations.conversation.messages);
 assert.equal(f.segments.length,0,'distribution alone is not proof that the line was visible');
 await Promise.all([1,2].map(()=>f.service.action('companion-r95',{action:'speech-presented',args:{messageId:f.line.messageId}})));
 await until(()=>f.finishes.some(v=>v.requestId==='social-voice:'+f.line.messageId));
 assert.equal(f.segments.length,1);const {envelope,text}=f.segments[0];
 assert.equal(text,f.line.text);assert.equal(envelope.messageId,f.line.messageId);assert.equal(envelope.source,'social-line');
 for(const key of ['characterId','personaId','lifeId','operationId','conversationId','channel'])assert.equal(envelope[key],f.scope[key]);
 await f.service.voiceReceipt({envelope,status:'audioStarted'});
 await f.service.voiceReceipt({envelope,status:'audioCompleted',playedMs:800});
 await until(()=>f.store.state.lives[f.scope.characterId].r95.lines[0].voicePresentation?.length===2);
 const saved=f.store.state.lives[f.scope.characterId].r95.lines[0];
 assert.equal(saved.status,'presented');assert.equal(saved.voiceDelivery.state,'completed');
 assert.equal(f.service.r95.presentation.snapshot(f.scope).presenting,true);
 assert.equal(f.service.r95.presentation.snapshot(f.scope).audioPlaying,false);
 assert.deepEqual(f.store.state.relationships,before);assert.deepEqual(f.store.state.conversations.conversation.messages,messages);
 await f.service.action('companion-r95',{action:'speech-presented',args:{messageId:f.line.messageId}});assert.equal(f.segments.length,1);
 await f.service.action('companion-r95',{action:'speech-read',args:{messageId:f.line.messageId}});assert.equal(f.service.r95.presentation.snapshot(f.scope).presenting,false);
});

test('disabled voice and an already claimed social line do not trigger later implicit playback',async t=>{
 const f=await fixture(t,{admit:()=>null});
 await f.service.action('companion-r95',{action:'speech-presented',args:{messageId:f.line.messageId}});
 await until(()=>f.store.state.lives[f.scope.characterId].r95.lines[0].voiceDelivery?.state==='skipped');
 await f.service.action('companion-r95',{action:'speech-presented',args:{messageId:f.line.messageId}});
 assert.equal(f.segments.length,0);assert.equal(f.service.r95.presentation.snapshot(f.scope).audioPlaying,false);
});

test('reading or switching scope while voice admission waits discards the late social audio',async t=>{
 for(const change of ['read','scope'])await t.test(change,async t=>{
  let resolve,entered;const waiting=new Promise(r=>entered=r),held=new Promise(r=>resolve=r);
  const f=await fixture(t,{admit:async()=>{entered();await held;return {epoch:4,voiceProfileVersion:8};}});
  await f.service.action('companion-r95',{action:'speech-presented',args:{messageId:f.line.messageId}});await waiting;
  if(change==='read')await f.service.action('companion-r95',{action:'speech-read',args:{messageId:f.line.messageId}});
  else await f.store.mutate(state=>{state.activeConversationId='different-conversation';});
  resolve();await until(()=>f.finishes.length>0);
  assert.equal(f.segments.length,0);
 });
});

test('audio joins the existing unread barrier without resetting the real text receipt',()=>{
 const p=createPresentationState(),scope={characterId:'c',personaId:'p',lifeId:'l',operationId:'o',channel:'app-private',conversationId:'v'};
 p.beginPresentation(scope,{id:'line'});assert.equal(p.attachAudio(scope,'line'),true);
 p.finishText(scope,'line');assert.equal(p.snapshot(scope).presenting,true);
 p.finishAudio(scope,'line');assert.equal(p.snapshot(scope).presenting,false);assert.equal(p.attachAudio(scope,'line'),false);
});
