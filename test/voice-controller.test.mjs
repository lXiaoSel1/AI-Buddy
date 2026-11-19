import assert from 'node:assert/strict';
import test from 'node:test';
import {createVoiceController} from '../src/voice/controller.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';

const scope = {characterId:'deepseek',lifeId:'life',operationId:'op',personaId:'p',channel:'app-private',conversationId:'c'};
const profile={id:'deepseek-calm',version:3,characterId:'deepseek',engine:'breeze'};
async function fixture(overrides={}){
  const events=[],submissions=[],calls=[];
  const settings=createVoiceSettings();await settings.update({enabled:true});
  let active=scope;
  const rows=[{id:'ai-buddy.voice-breeze',engine:'breeze',installed:true,enabled:true,usable:true}];
  const voice=createVoiceController({settings,getScope:()=>active,submit:async value=>{submissions.push(value);return {requestId:'reply'};},send:event=>events.push(event),listPackages:()=>rows,
    assets:{resolve:async(kind)=>{calls.push(kind);return {};},status:async()=>({state:'ready'})},
    profiles:{current:async()=>profile,list:async()=>[profile]},
    runtime:{startCapture:async()=>{},feedCapture:async()=>({endpoint:true,partial:'你好'}),finishCapture:async()=>({text:'你好'}),cancelCapture:async()=>{},stopEngine:async()=>{},close:async()=>{},prepare:async()=>({ready:true}),ready:async()=>({ready:true}),async *speak(){yield {type:'pcm',pcm:Buffer.alloc(4),sampleRate:24000};yield {type:'done',metrics:{}};}},
    ...overrides});
  return {voice,events,submissions,calls,settings,rows,switchScope:value=>{active=value;}};
}

test('cold local chat stays text-only even when resources are already available',async t=>{
  const reads=[];
  const {voice,events}=await fixture({
    assets:{resolve:async()=>{reads.push('assets');throw Error('Cold verification failed');},status:async()=>({state:'ready'})},
    profiles:{current:async()=>{reads.push('profile');return profile;}},
    runtime:{
      ready:async()=>{reads.push('ready');return {ready:true};},
      prepare:async()=>{reads.push('prepare');return {ready:true};},
      async *speak(){reads.push('speak');throw Error('Cold speech failed');},
    },
  });
  t.after(()=>voice.close());
  const before=await voice.state();
  assert.equal(before.settings.enabled,true);
  assert.equal(before.preparation.state,'idle');
  const turn={...scope,requestId:'cold-reply'};
  const lease=await voice.admit(turn);
  if(lease){
    await voice.segment({envelope:envelope(turn,lease,0),text:'Text reply'});
    await voice.finish({requestId:turn.requestId});
    await until(()=>events.some(row=>row.type==='segment'&&row.state==='failed'));
  }
  assert.deepEqual({lease,reads,events:events.map(row=>[row.type,row.state??row.stage])},{lease:null,reads:[],events:[]});
  await voice.action('prepare',{target:'speech'});
  assert.equal(events.some(row=>row.requestId===turn.requestId),false,'startup never replays the earlier text');
});

test('turns arriving while explicit speech preparation checks, verifies and loads are never queued',async t=>{
  const entered=Promise.withResolvers(),loaded=Promise.withResolvers(),reads=[];
  let progress;
  const {voice,events}=await fixture({
    profiles:{current:async()=>{reads.push('profile');return profile;}},
    runtime:{
      async prepare({onProgress}){progress=onProgress;entered.resolve();await loaded.promise;return {ready:true};},
      async ready(){reads.push('ready');return {ready:true};},
    },
  });
  t.after(()=>voice.close());
  const starting=voice.action('prepare',{target:'speech'});
  try{
    assert.equal((await voice.state()).preparation.state,'checking');
    assert.equal(await voice.admit({...scope,requestId:'checking'}),null);
    await entered.promise;
    for(const phase of ['verifying','loading']){
      progress({state:phase});
      assert.equal((await voice.state()).preparation.state,phase);
      assert.equal(await voice.admit({...scope,requestId:phase}),null);
    }
    assert.deepEqual(reads,[]);
  }finally{loaded.resolve();await starting;}
  assert.equal((await voice.state()).preparation.state,'ready');
  assert.ok(await voice.admit({...scope,requestId:'later'}));
  assert.deepEqual(events.filter(row=>row.type==='turn').map(row=>row.requestId),['later']);
});

test('an externally released local speech engine makes the previously prepared chat cold',async t=>{
  let resident=true,reads=0;
  const {voice,events}=await fixture({runtime:{
    prepare:async()=>{resident=true;return {ready:true};},
    ready:async()=>{reads++;return {ready:resident,state:resident?'ready':'idle'};},
  }});
  t.after(()=>voice.close());
  assert.equal((await voice.action('prepare')).preparation.state,'ready');
  resident=false;
  assert.equal(await voice.admit({...scope,requestId:'after-release'}),null);
  assert.equal((await voice.state()).preparation.state,'idle');
  assert.ok(events.some(row=>row.type==='preparation'&&row.preparation.state==='idle'));
  assert.equal(events.some(row=>row.type==='turn'||row.type==='status'),false);
  resident=true;
  assert.equal(await voice.admit({...scope,requestId:'other-owner-restarted'}),null);
  assert.equal(reads,1);
  await voice.action('prepare');
  assert.ok(await voice.admit({...scope,requestId:'explicitly-restarted'}));
});

test('a missing group speaker binding does not affect the next speaker or require restart',async t=>{
  const active={...scope,channel:'app-group'},bindingError={ready:false,state:'unbound',code:'CLOUD_VOICE_REQUIRED',message:'Synthetic missing voice binding'};
  let selectedBound=true;
  const {voice,settings,switchScope,events}=await fixture({
    profiles:{current:async({characterId})=>({...profile,characterId,id:characterId+'-profile'})},
    runtime:{ready:async({characterId})=>characterId===active.characterId&&selectedBound?{ready:true}:bindingError},
  });
  t.after(()=>voice.close());
  switchScope(active);
  await settings.update({packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax',credentialRef:'synthetic'}}});
  assert.equal(await voice.admit({...active,characterId:'other',requestId:'unbound-speaker'}),null);
  assert.ok(await voice.admit({...active,requestId:'bound-speaker'}));
  await voice.finish({requestId:'bound-speaker'});
  selectedBound=false;
  assert.equal(await voice.admit({...active,requestId:'lost-binding'}),null);
  assert.deepEqual(events.filter(row=>row.type==='cloud-speech-status').map(row=>[row.envelope.characterId,row.status.state]),[
    ['other','unbound'],[active.characterId,'ready'],[active.characterId,'unbound'],
  ]);
  selectedBound=true;
  assert.ok(await voice.admit({...active,requestId:'restored-binding'}));
});

test('recorded speech becomes a draft, and a cancelled capture cannot submit stale audio', async () => {
  const events = [];
  const submissions = [];
  const settings=createVoiceSettings();
  await settings.update({enabled:true});
  const voice = createVoiceController({
    getScope:()=>scope, submit:value=>submissions.push(value), send:event=>events.push(event),
    settings,listPackages:()=>[{id:'ai-buddy.voice-breeze',engine:'breeze',installed:true,enabled:true,usable:true}],
    runtime:{startCapture:async()=>{},feedCapture:async()=>({partial:'预览'}),finishCapture:async()=>({text:'一段录音'}),cancelCapture:async()=>{}},
    assets:{resolve:async()=>({}),status:async()=>({ready:true})},
  });
  const first = await voice.action('capture-start',{mode:'record'});
  await voice.action('capture-feed',{id:first.id,pcm:new Uint8Array(1024)});
  assert.equal((await voice.action('capture-finish',{id:first.id})).draft,'一段录音');
  const second = await voice.action('capture-start',{mode:'record'});
  assert.notEqual(second.id,first.id);
  await voice.action('stop');
  await assert.rejects(voice.action('capture-finish',{id:second.id}), {code:'VOICE_STALE_CAPTURE'});
  assert.deepEqual(submissions,[]);
  assert.ok(events.some(event=>event.type==='capture'&&event.state==='idle'));
});

test('stopping Live cancels a pending configuration read before forwarding old PCM',async()=>{
  const reading=Promise.withResolvers(),held=Promise.withResolvers();
  const settings=createVoiceSettings();
  const config=await settings.update({enabled:true});
  let hold=false,forwarded=false,stopped=false;
  const {voice}=await fixture({
    settings:{get(){if(!hold)return config;reading.resolve();return held.promise;}},
    runtime:{
      startCapture:async()=>{},cancelCapture:async()=>{},stopEngine:async()=>{},
      feedCapture:async()=>{forwarded=true;return {};},
    },
  });
  const capture=await voice.action('capture-start',{mode:'live'});
  hold=true;
  const feed=assert.rejects(voice.action('capture-feed',{id:capture.id,pcm:new Uint8Array(320)}));
  await reading.promise;
  const stop=voice.action('stop').then(()=>{stopped=true;});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(stopped,true,'ending Live must not wait for a revoked read-only request');
  }finally{
    hold=false;
    held.resolve(config);
    await Promise.all([stop,feed]);
    await voice.close();
  }
  assert.equal(forwarded,false);
});

test('admission freezes the host role profile and rechecks plugin permission; cloud needs a binding but no local TTS assets',async()=>{
  const {voice,settings,rows,calls}=await fixture();
  const turn={...scope,requestId:'request-1',messageId:'message-1'};
  await voice.action('prepare',{target:'speech'});
  assert.deepEqual(await voice.admit(turn),{epoch:0,voiceProfileVersion:3});
  await voice.finish({requestId:turn.requestId});
  rows[0].enabled=false;
  assert.equal(await voice.admit({...turn,requestId:'request-2'}),null);
  rows[0].enabled=true;
  assert.ok(await voice.admit(turn));
  assert.equal(await voice.admit({...turn,requestId:'still-playing'}),null);
  await voice.finish({requestId:turn.requestId});
  await settings.update({packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax',credentialRef:'voice-key'}}});
  calls.length=0;
  assert.ok(await voice.admit({...turn,requestId:'cloud'}));
  assert.deepEqual(calls,[]);
  const missing=await fixture({runtime:{prepare:async()=>({ready:true}),ready:async()=>({ready:false,state:'unbound',code:'CLOUD_VOICE_REQUIRED'})}});
  await missing.settings.update({packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax',credentialRef:'voice-key'}}});
  assert.equal(await missing.voice.admit(turn),null);
  assert.ok(missing.events.some(row=>row.type==='cloud-speech-status'&&row.status.code==='CLOUD_VOICE_REQUIRED'));
});

const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('expected controller event');};
const envelope=(turn,lease,index)=>({...turn,...lease,index,segmentId:turn.requestId+':voice:'+index});

test('Live submits an endpoint once and waits for actual final playback before listening again',async()=>{
  const {voice,events,submissions}=await fixture();
  const capture=await voice.action('capture-start',{mode:'live'});
  await voice.action('capture-feed',{id:capture.id,pcm:new Uint8Array(320)});
  await assert.rejects(voice.action('capture-finish',{id:capture.id}),{code:'VOICE_STALE_CAPTURE'});
  assert.equal(submissions.length,1);
  const turn={...scope,requestId:'reply',messageId:'reply-message'};
  const lease=await voice.admit(turn);assert.ok(lease);
  const token=envelope(turn,lease,0);
  await voice.segment({envelope:token,text:'听到了。'});
  await voice.finish({requestId:'reply'});
  await until(()=>events.some(row=>row.type==='audio'&&row.phase==='end'));
  const listeningIds=()=>new Set(events.filter(row=>row.type==='capture'&&row.state==='listening').map(row=>row.id));
  assert.equal(listeningIds().size,1);
  assert.equal((await voice.action('receipt',{envelope:{...token,epoch:99},status:'audioCompleted'})).accepted,false);
  await voice.action('receipt',{envelope:token,status:'audioCompleted',playedMs:100});
  await until(()=>listeningIds().size===2);
  await voice.close();
});

test('ending Live while the next listening turn is preparing does not report a capture error',async()=>{
  const preparing=Promise.withResolvers(),held=Promise.withResolvers();
  let asrReads=0;
  const {voice,events}=await fixture({
    assets:{
      resolve(kind){
        if(kind!=='asr'||++asrReads===1)return {};
        preparing.resolve();
        return held.promise;
      },
      status:async()=>({state:'ready'}),
    },
  });
  const capture=await voice.action('capture-start',{mode:'live'});
  await voice.action('capture-feed',{id:capture.id,pcm:new Uint8Array(320)});
  assert.ok(await voice.admit({...scope,requestId:'reply',messageId:'reply-message'}));
  const reply=voice.finish({requestId:'reply'});
  await preparing.promise;
  const stop=voice.action('stop');
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(events.some(event=>event.type==='error'),false);
  }finally{
    held.resolve({});
    await Promise.all([reply,stop]);
    await voice.close();
  }
  const listeningIds=new Set(events.filter(event=>event.type==='capture'&&event.state==='listening').map(event=>event.id));
  assert.equal(listeningIds.size,1);
});

test('output buffers stay bounded and a stale role cannot continue queued synthesis',async()=>{
  const {voice,events,switchScope}=await fixture();
  await voice.action('prepare',{target:'speech'});
  const turn={...scope,requestId:'long',messageId:'long-reply'},lease=await voice.admit(turn);
  for(let i=0;i<5;i++)await voice.segment({envelope:envelope(turn,lease,i),text:'第'+i+'段。'});
  await until(()=>events.filter(row=>row.type==='audio'&&row.phase==='end').length===2);
  assert.deepEqual((await voice.state()).queue,{queued:3,inflight:2});
  let released=false;
  const blocked=voice.segment({envelope:envelope(turn,lease,5),text:'第六段。'}).then(value=>{released=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(released,false);
  switchScope({...scope,characterId:'kimi'});
  await voice.invalidate('scope-changed');
  assert.equal(await blocked,false);
  assert.equal(events.filter(row=>row.type==='audio'&&row.phase==='start').length,2);
  assert.deepEqual((await voice.state()).queue,{queued:0,inflight:0});
});

test('a 120-second capture becomes a reviewable draft and a failed reply never resumes Live',async()=>{
  const limited=await fixture({runtime:{startCapture:async()=>{},feedCapture:async()=>({limit:true,endpoint:true}),finishCapture:async()=>({text:'达到上限的内容'}),cancelCapture:async()=>{}}});
  const take=await limited.voice.action('capture-start',{mode:'live'});
  const result=await limited.voice.action('capture-feed',{id:take.id,pcm:new Uint8Array(320)});
  assert.equal(result.draft,'达到上限的内容');assert.deepEqual(limited.submissions,[]);
  assert.equal((await limited.voice.state()).live,false);
  const {voice,events}=await fixture();
  const first=await voice.action('capture-start',{mode:'live'});
  await voice.action('capture-feed',{id:first.id,pcm:new Uint8Array(320)});
  const turn={...scope,requestId:'reply',messageId:'reply-message'};
  assert.ok(await voice.admit(turn));await voice.finish({requestId:'reply',failed:true});
  assert.equal(new Set(events.filter(row=>row.type==='capture'&&row.state==='listening').map(row=>row.id)).size,1);
  assert.equal((await voice.state()).live,false);
});

test('an unconfirmed worker exit keeps the controller sealed',async()=>{
  const {voice}=await fixture({runtime:{cancelCapture:async()=>{},stopEngine:async()=>{throw Error('worker is still alive');}}});
  await assert.rejects(voice.action('stop'),{code:'VOICE_CLEANUP_FAILED'});
  await assert.rejects(voice.action('capture-start',{mode:'record'}),{code:'VOICE_STOPPING'});
});

test('empty Live recognition re-arms a new capture without releasing the microphone',async()=>{
  const {voice,events,submissions}=await fixture({runtime:{startCapture:async()=>{},feedCapture:async()=>({endpoint:true}),finishCapture:async()=>({text:''}),cancelCapture:async()=>{}}});
  const first=await voice.action('capture-start',{mode:'live'});
  await voice.action('capture-feed',{id:first.id,pcm:new Uint8Array(320)});
  const next=(await voice.state()).capture;
  assert.notEqual(next.id,first.id);
  assert.equal(next.mode,'live');assert.deepEqual(submissions,[]);
  assert.equal(events.some(row=>row.type==='capture'&&row.state==='idle'),false);
  await voice.close();
});

test('stopping during capture startup waits for initialization to retire, without a late listening event',async()=>{
  let release,starting=false;
  const initialized=new Promise(resolve=>{release=resolve;});
  const {voice,events}=await fixture({runtime:{startCapture:async()=>{starting=true;await initialized;},cancelCapture:async()=>{},stopEngine:async()=>{}}});
  const start=voice.action('capture-start',{mode:'live'});const rejected=assert.rejects(start,{code:'VOICE_STALE_CAPTURE'});
  await until(()=>starting);
  let stopped=false;const stop=voice.action('stop').then(()=>{stopped=true;});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(stopped,false);
  release();await rejected;await stop;
  assert.equal(events.some(row=>row.type==='capture'&&row.state==='listening'),false);
  assert.equal((await voice.state()).capture,null);
});


test('preparation exposes real loading and stop cancels it without a late ready state',async()=>{
  let release,started=false;
  const held=new Promise(resolve=>{release=resolve;});
  const {voice,events}=await fixture({runtime:{
    async prepare({onProgress}){started=true;onProgress({state:'loading',component:'breeze'});await held;return {ready:true};},
    async cancelCapture(){},async stopEngine(){},async close(){}
  }});
  const pending=voice.action('prepare',{target:'speech'});
  const cancelled=assert.rejects(pending,{code:'VOICE_PREPARATION_CANCELLED'});
  await until(()=>started);
  assert.deepEqual((await voice.state()).preparation,{state:'loading',target:'speech',component:'breeze'});
  const stop=voice.action('stop');
  release();await cancelled;await stop;
  assert.equal((await voice.state()).preparation.state,'idle');
  assert.equal(events.some(row=>row.type==='state'&&row.state.preparation?.state==='ready'),false);
});


test('a preparation failure publishes the actual error and never reports ready',async()=>{
  const {voice,events}=await fixture({runtime:{async prepare(){throw Object.assign(Error('component load failed'),{code:'VOICE_WORKER_NOT_READY'});},async cancelCapture(){},async stopEngine(){}}});
  await assert.rejects(voice.action('prepare',{target:'live'}),{code:'VOICE_WORKER_NOT_READY'});
  const state=await voice.state();
  assert.deepEqual(state.preparation,{state:'failed',target:'live',code:'VOICE_WORKER_NOT_READY',message:'component load failed'});
  assert.equal(events.some(row=>row.type==='state'&&row.state.preparation?.state==='failed'),true);
  assert.equal(events.some(row=>row.type==='state'&&row.state.preparation?.state==='ready'),false);
});

test('R2 U1 cloud admits a bound group member when the entry role has no profile',async t=>{
  const entry={...scope,channel:'app-group'},speaker={...entry,characterId:'other'};
  const {voice,settings,switchScope}=await fixture({
    profiles:{current:async({characterId})=>characterId===speaker.characterId?{...profile,characterId}:null},
  });
  t.after(()=>voice.close());switchScope(entry);
  await settings.update({packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax',credentialRef:'synthetic'}}});
  assert.ok(await voice.admit({...speaker,requestId:'bound-speaker'}),'bound group member can read');
  assert.equal(await voice.admit({...entry,requestId:'entry-speaker'}),null);
});

test('R2 U7 enabled MiniMax speaks without startup or local components',async t=>{
  const spoken=[];
  const {voice,settings,events}=await fixture({
    assets:{resolve:async()=>assert.fail('cloud must not resolve local assets'),status:async()=>({state:'missing'})},
    runtime:{prepare:async()=>assert.fail('cloud must not prepare'),ready:async()=>({ready:true}),
      async *speak(request){spoken.push(request);yield {type:'pcm',pcm:Buffer.alloc(4),sampleRate:32000};yield {type:'done',metrics:{}};}},
  });
  t.after(()=>voice.close());
  await settings.update({packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax',credentialRef:'synthetic'}}});
  const turn={...scope,requestId:'cold-cloud'},lease=await voice.admit(turn);
  assert.ok(lease,'MiniMax admits without manual preparation');
  await voice.segment({envelope:envelope(turn,lease,0),text:'Synthetic reply'});
  await until(()=>events.some(row=>row.type==='audio'&&row.phase==='end'));
  assert.equal(spoken[0].speechProvider,'minimax');
});

test('R2 U2 switching an active local profile restores the resident engine with the new profile',async t=>{
  let activeProfile=profile;
  const readinessProfiles=[];
  const {voice}=await fixture({
    profiles:{current:async()=>activeProfile,select:async()=>activeProfile={...profile,id:'replacement',version:4}},
    runtime:{prepare:async()=>({ready:true}),cancelCurrent:async()=>{},ready:async({profileId})=>{readinessProfiles.push(profileId);return {ready:true};}},
  });
  t.after(()=>voice.close());
  await voice.action('prepare');
  await voice.action('profile-select',{profileId:'replacement'});
  assert.equal((await voice.state()).preparation.state,'ready');
  assert.deepEqual(readinessProfiles,['replacement']);
  assert.equal((await voice.admit({...scope,requestId:'new-profile'})).voiceProfileVersion,4);
});
