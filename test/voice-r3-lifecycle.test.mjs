import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceController} from '../src/voice/controller.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const scope={characterId:'fixture',lifeId:'life',operationId:'operation',personaId:'persona',channel:'app-private',conversationId:'conversation'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function controllerFixture(t,{assets,runtime,profiles,onEvent=()=>{},preflightTimeoutMs,settings:providedSettings}={}){
  const settings=providedSettings??createVoiceSettings();if(!providedSettings)await settings.update({enabled:true});
  const events=[],calls=[];
  const voice=createVoiceController({getScope:()=>scope,settings,preflightTimeoutMs,submit:async()=>assert.fail('must not submit'),send:event=>{events.push(event);onEvent(event);},
    listPackages:()=>[{id:'ai-buddy.voice-breeze',engine:'breeze',installed:true,enabled:true,usable:true}],
    profiles:profiles??{current:async()=>({id:'profile',version:1,characterId:'fixture',engine:'breeze'})},
    assets:assets??{status:async kind=>{calls.push(kind);return {state:'ready'};},resolve:async()=>({proof:'fixture'})},
    runtime:{async cancelCapture(){},async stopEngine(){},async close(){},...runtime}});
  t.after(()=>voice.close());return {voice,events,calls,settings};
}

test('preparation progress stays lightweight instead of starting full ASR/TTS state queries',async t=>{
  const entered=deferred(),release=deferred();
  const {voice,events,calls}=await controllerFixture(t,{runtime:{async prepare({onProgress,signal}){
    for(let i=0;i<12;i++)onProgress({state:'verifying',component:'breeze'});
    entered.resolve();await release.promise;signal.throwIfAborted();return {ready:true};
  }}});
  const pending=voice.action('prepare');await entered.promise;await tick();
  const progressCalls=[...calls];release.resolve();await pending;
  assert.deepEqual(progressCalls,[],'periodic progress must not authorize/read complete state');
  assert.ok(events.some(row=>row.type==='preparation'&&row.preparation.state==='verifying'));
  assert.deepEqual(calls,['asr','breeze'],'ready publishes one freshly checked complete state');
});

test('concurrent complete state readers share only the current in-flight read',async t=>{
  const entered=deferred(),release=deferred(),calls=[];
  const {voice}=await controllerFixture(t,{assets:{async status(kind){calls.push(kind);if(kind==='asr'){entered.resolve();await release.promise;}return {state:'ready'};}}});
  const readers=Array.from({length:8},()=>voice.state());await entered.promise;await tick();
  const beforeRelease=[...calls];release.resolve();await Promise.all(readers);
  assert.deepEqual(beforeRelease,['asr']);assert.deepEqual(calls,['asr','breeze']);
  await voice.state();assert.deepEqual(calls,['asr','breeze','asr','breeze'],'settled authority is never cached');
});

test('stop invalidates a held state read before its old ASR check can continue into TTS',async t=>{
  const entered=deferred(),release=deferred(),calls=[];
  const {voice}=await controllerFixture(t,{assets:{async status(kind){calls.push(kind);if(kind==='asr'){entered.resolve();await release.promise;}return {state:'ready'};}}});
  const pending=voice.state();const outcome=pending.then(()=>null,error=>error);await entered.promise;
  await voice.invalidate('scope-changed');release.resolve();
  assert.equal((await outcome)?.code,'VOICE_STATE_CANCELLED');assert.deepEqual(calls,['asr']);
});

test('a settings mutation cannot reuse the preceding complete state or its permissions',async t=>{
  const {voice}=await controllerFixture(t);
  assert.equal((await voice.state()).settings.enabled,true);
  await voice.action('configure',{enabled:false});
  assert.equal((await voice.state()).settings.enabled,false);
});

test('configuration commit cancels an overlapping pre-mutation state read before publishing fresh permissions',async t=>{
  const enteredUpdate=deferred(),releaseUpdate=deferred(),committed=deferred(),enteredAsr=deferred(),releaseAsr=deferred();
  const saved=createVoiceSettings();await saved.update({enabled:true});let held=false;
  const {voice,events}=await controllerFixture(t,{
    settings:{get:()=>saved.get(),async update(patch){enteredUpdate.resolve();await releaseUpdate.promise;const result=await saved.update(patch);committed.resolve();return result;}},
    assets:{async status(kind){if(kind==='asr'&&!held){held=true;enteredAsr.resolve();await releaseAsr.promise;}return {state:'ready'};}}});
  const configuring=voice.action('configure',{enabled:false});await enteredUpdate.promise;
  const old=voice.state().then(snapshot=>({snapshot}),error=>({error}));await enteredAsr.promise;
  releaseUpdate.resolve();await committed.promise;await tick();
  const fresh=voice.state();releaseAsr.resolve();await configuring;
  const current=await fresh,prior=await old;
  assert.equal(events.filter(event=>event.type==='state').at(-1).state.settings.enabled,false,'configure must not publish the state captured before its commit');
  assert.equal(current.settings.enabled,false);assert.equal(prior.error?.code,'VOICE_STATE_CANCELLED');
});

test('the controller preflight deadline fences a withheld fresh profile check after reference yield',async t=>{
  const entered=deferred(),release=deferred(),failed=deferred();let profileReads=0,sent=0,references=0;
  const {voice,events}=await controllerFixture(t,{preflightTimeoutMs:35,
    profiles:{async current(){if(++profileReads===5){entered.resolve();await release.promise;}return {id:'profile',version:1,characterId:'fixture',engine:'breeze'};}},
    onEvent:event=>{if(event.type==='segment'&&event.state==='failed')failed.resolve(event);},
    runtime:{ready:async()=>({ready:true}),async *speak({signal}){references++;yield {type:'reference',style:'calm',source:'neutral-fallback'};signal.throwIfAborted();sent++;yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};yield {type:'done'};}}});
  const turn={...scope,requestId:'held-authority',messageId:'message'},lease=await voice.admit(turn),envelope={...turn,...lease,index:0,segmentId:turn.requestId+':voice:0'};
  assert.equal(await voice.segment({envelope,text:'INERT_TEXT'}),true);await entered.promise;
  const beforeRelease=await Promise.race([failed.promise,delay(150,'still-waiting')]);release.resolve();await tick();
  assert.notEqual(beforeRelease,'still-waiting');assert.equal(beforeRelease.code,'VOICE_PREFLIGHT_TIMEOUT');assert.equal(references,1);assert.equal(sent,0);
  assert.deepEqual(events.filter(row=>row.type==='phase').map(row=>row.stage),['queue','error']);
  assert.equal((await voice.state()).preparation.state,'failed','retired worker cannot remain presented as ready');
  assert.equal((await voice.state()).preparation.code,'VOICE_PREFLIGHT_TIMEOUT');
});
