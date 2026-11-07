import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCardSpeech} from '../src/voice/card-speech.mjs';

const scope=(characterId='alice')=>({channel:'card-table',tableId:'table-one',handId:'hand-one',characterId,personaId:'persona-one',lifeId:'life-'+characterId,operationId:'operation-one'});
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('card speech did not settle');}
function fixture(options={}){
  const events=[],spoken=[],resolutions=[];
  const runtime={async *speak(request){spoken.push(request);yield {type:'pcm',pcm:new Uint8Array([0,0,1,0]),sampleRate:24000};yield {type:'done'};},stopEngine:async()=>{}};
  const bridge=createCardSpeech({emit:event=>events.push(event),isScopeValid:()=>true,resolveVoice:async value=>{resolutions.push(value);return {runtime,engine:'breeze',packageId:'voice-breeze',profileId:'profile-'+value.characterId,profileVersion:3,speechProvider:'local'};},...options});
  return {bridge,events,spoken,resolutions,runtime};
}

test('committed fixed card calls use the speaker voice and literal words without another model request',async t=>{
  const {bridge,events,spoken}=fixture();t.after(()=>bridge.close());
  assert.equal((await bridge.accept({eventId:'allin-one',kind:'allin',text:'invented model words',scope:scope()})).accepted,true);
  await until(()=>events.some(row=>row.type==='audio'&&row.phase==='end'));
  assert.equal(spoken[0].text,'All in!');
  assert.equal(spoken[0].characterId,'alice');assert.equal(spoken[0].profileId,'profile-alice');
  const queued=events.find(row=>row.type==='segment'&&row.state==='queued');
  assert.equal(queued.text,'All in!');assert.equal(queued.envelope.channel,'card-table');
  assert.equal(queued.envelope.tableId,'table-one');assert.equal(queued.envelope.handId,'hand-one');
});

test('a table queue waits for an authentic terminal playback receipt and admits only three waiting calls',async t=>{
  const {bridge,events,spoken}=fixture();t.after(()=>bridge.close());
  const alice=scope();await bridge.accept({eventId:'one',kind:'allin',scope:alice});alice.characterId='forged';
  await until(()=>events.some(row=>row.type==='audio'&&row.phase==='end'));
  await bridge.accept({eventId:'two',kind:'trips',scope:scope('bob')});
  await bridge.accept({eventId:'three',kind:'triple',scope:scope()});
  await bridge.accept({eventId:'four',kind:'table-chat',text:'已经写好的桌聊。',scope:scope('bob')});
  assert.equal((await bridge.accept({eventId:'five',kind:'allin',scope:scope()})).reason,'queue-full');
  assert.equal((await bridge.accept({eventId:'one',kind:'allin',scope:scope()})).duplicate,true);
  const first=events.find(row=>row.type==='segment'&&row.state==='queued').envelope;
  assert.equal(first.characterId,'alice');assert.equal(bridge.busy(),true);
  assert.deepEqual(await bridge.receipt({envelope:{...first,characterId:'forged'},status:'audioCompleted'}),{accepted:false});
  assert.equal((await bridge.receipt({envelope:first,status:'textDisplayed'})).accepted,true);
  assert.equal(spoken.length,1);
  assert.equal((await bridge.receipt({envelope:first,status:'audioCompleted',playedMs:150})).accepted,true);
  assert.equal((await bridge.receipt({envelope:first,status:'audioCompleted'})).accepted,false);
  await until(()=>spoken.length===2);
  assert.equal(spoken[1].text,'三条');assert.equal(spoken[1].profileId,'profile-bob');
});

test('existing table speech keeps its displayed text and pure faces finish silently without a voice lookup',async t=>{
  const {bridge,events,spoken,resolutions}=fixture();t.after(()=>bridge.close());
  await bridge.accept({eventId:'faces',kind:'lastSpeech',text:'(^_^) 😊',scope:scope()});
  await until(()=>events.some(row=>row.type==='turn'&&row.state==='generated'));
  const silent=events.find(row=>row.type==='segment'&&row.state==='queued');
  assert.equal(silent.text,'(^_^) 😊');assert.equal(silent.speech_text,'');
  assert.equal(spoken.length,0);assert.equal(resolutions.length,0);
  assert.equal(events.find(row=>row.type==='audio'&&row.phase==='end').skipped,true);
  await bridge.receipt({envelope:silent.envelope,status:'explicitlySkipped'});
  await bridge.accept({eventId:'chat',kind:'table-chat',text:'你好😊！',scope:scope('bob')});
  await until(()=>spoken.length===1);assert.equal(spoken[0].text,'你好！');
  await assert.rejects(bridge.accept({eventId:'forged',kind:'allin',scope:{...scope(),lifeId:''}}),{code:'VOICE_CARD_EVENT_INVALID'});
});

test('accepted events survive a restart as interrupted evidence and are never automatically replayed',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'buddy-card-speech-'));
  const first=fixture({dataRoot});let second;
  t.after(async()=>{await second?.bridge.close();await first.bridge.close();await rm(dataRoot,{recursive:true,force:true});});
  await first.bridge.accept({eventId:'restart-one',kind:'allin',scope:scope()});
  await until(()=>first.events.some(row=>row.type==='audio'&&row.phase==='end'));
  // A second host represents recovery after the first process disappeared before a playback receipt.
  second=fixture({dataRoot});
  const duplicate=await second.bridge.accept({eventId:'restart-one',kind:'allin',scope:scope()});
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.status,'interrupted');
  assert.equal(duplicate.reason,'restart-unfinished');assert.equal(second.spoken.length,0);
  await second.bridge.accept({eventId:'restart-two',kind:'table-chat',text:'仍是原文。',scope:scope('bob')});
  await until(()=>second.spoken.length===1);assert.equal(second.spoken[0].text,'仍是原文。');
});

test('plugin disable invalidates only card output and drops delayed PCM and queued work',async t=>{
  let release,started=false,stops=0;
  const held=new Promise(resolve=>{release=resolve;});
  const runtime={async *speak(){started=true;await held;yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};},async stopEngine(){stops++;release();}};
  const {bridge,events}=fixture({resolveVoice:async()=>({runtime,engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local'})});
  t.after(()=>bridge.close());
  await bridge.accept({eventId:'held',kind:'allin',scope:scope()});await until(()=>started);
  await bridge.accept({eventId:'queued',kind:'trips',scope:scope('bob')});
  await bridge.invalidate('plugin-disabled');
  assert.equal(stops,1);assert.equal(bridge.busy(),false);
  assert.equal(events.some(row=>row.phase==='pcm'),false);
  assert.deepEqual(events.find(row=>row.type==='invalidate'),{type:'invalidate',channel:'card-table',reason:'plugin-disabled'});
  const interrupted=await bridge.accept({eventId:'queued',kind:'trips',scope:scope('bob')});
  assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.reason,'plugin-disabled');
});

test('a changed hand or life cannot acknowledge old audio or release the following call',async t=>{
  let valid=true;
  const {bridge,events,spoken}=fixture({isScopeValid:()=>valid});t.after(()=>bridge.close());
  await bridge.accept({eventId:'old-life',kind:'allin',scope:scope()});
  await until(()=>events.some(row=>row.phase==='end'));
  await bridge.accept({eventId:'old-hand-next',kind:'trips',scope:scope('bob')});
  const envelope=events.find(row=>row.type==='segment'&&row.state==='queued').envelope;
  valid=false;
  assert.equal((await bridge.receipt({envelope,status:'audioCompleted'})).accepted,false);
  await until(()=>!bridge.busy());assert.equal(spoken.length,1);
  assert.equal((await bridge.accept({eventId:'old-life',kind:'allin',scope:scope()})).status,'interrupted');
});

test('chat navigation preserves valid table speech, while a revoked table scope interrupts it',async t=>{
  let valid=true;
  const {bridge,events}=fixture({isScopeValid:()=>valid});t.after(()=>bridge.close());
  await bridge.accept({eventId:'scope-reconcile',kind:'allin',scope:scope()});await until(()=>events.some(row=>row.phase==='end'));
  assert.deepEqual(await bridge.reconcile(),{invalidated:false});assert.equal(bridge.busy(),true);
  assert.equal(events.some(row=>row.type==='invalidate'),false);
  valid=false;assert.deepEqual(await bridge.reconcile(),{invalidated:true});assert.equal(bridge.busy(),false);
  assert.equal(events.find(row=>row.type==='invalidate').reason,'scope-changed');
});

test('unconfirmed engine shutdown prevents another event from starting and preserves interruption evidence',async()=>{
  const {bridge,events,spoken}=fixture({resolveVoice:async()=>({runtime:{async *speak(){yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};},async stopEngine(){throw Error('worker still alive');}},engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local'})});
  await bridge.accept({eventId:'stop-one',kind:'allin',scope:scope()});await until(()=>events.some(row=>row.phase==='end'));
  await assert.rejects(bridge.invalidate('plugin-disabled'),{code:'VOICE_CARD_STOP_FAILED'});
  assert.equal(bridge.busy(),true);
  assert.equal((await bridge.accept({eventId:'stop-two',kind:'trips',scope:scope()})).reason,'stop-failed');
  await assert.rejects(bridge.close(),{code:'VOICE_CARD_STOP_FAILED'});
});

test('simultaneous duplicate playback receipts advance a table exactly once',async t=>{
  const {bridge,events,spoken}=fixture();t.after(()=>bridge.close());
  await Promise.all(['one','two','three','four'].map(eventId=>bridge.accept({eventId,kind:'allin',scope:scope()})));
  await until(()=>events.some(row=>row.phase==='end'));
  const envelope=events.find(row=>row.type==='segment'&&row.state==='queued').envelope;
  const results=await Promise.all([bridge.receipt({envelope,status:'audioCompleted'}),bridge.receipt({envelope,status:'audioCompleted'})]);
  assert.equal(results.filter(row=>row.accepted).length,1);
  await until(()=>spoken.length===2);assert.equal(bridge.busy(),true);
  assert.equal((await bridge.accept({eventId:'four',kind:'allin',scope:scope()})).duplicate,true);
});

test('malformed worker audio fails without a played receipt and cancels the remaining table queue',async t=>{
  const runtime={async *speak(){yield {type:'pcm',pcm:new Uint8Array([1]),sampleRate:2};},async stopEngine(){}};
  const {bridge,events}=fixture({resolveVoice:async()=>({runtime,engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local'})});
  t.after(()=>bridge.close());
  await bridge.accept({eventId:'bad-pcm',kind:'allin',scope:scope()});
  await until(()=>!bridge.busy());
  assert.equal(events.some(row=>row.phase==='pcm'),false);
  assert.equal(events.some(row=>row.phase==='end'&&!row.skipped),false);
  const result=await bridge.accept({eventId:'bad-pcm',kind:'allin',scope:scope()});
  assert.equal(result.status,'failed');assert.equal(result.reason,'VOICE_CARD_AUDIO_INVALID');
});

test('a worker with no PCM cannot claim successful playback for a spoken card call',async t=>{
  const runtime={async *speak(){yield {type:'done'};},async stopEngine(){}};
  const {bridge,events}=fixture({resolveVoice:async()=>({runtime,engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local'})});
  t.after(()=>bridge.close());await bridge.accept({eventId:'empty-pcm',kind:'allin',scope:scope()});await until(()=>!bridge.busy());
  assert.equal(events.some(row=>row.phase==='end'),false);
  assert.equal((await bridge.accept({eventId:'empty-pcm',kind:'allin',scope:scope()})).reason,'VOICE_CARD_AUDIO_EMPTY');
});

test('the optional in-memory bridge bounds completed receipts instead of retaining every past event',async t=>{
  let generated,envelope;
  const {bridge}=fixture({emit:event=>{if(event.type==='segment'&&event.state==='queued')envelope=event.envelope;if(event.type==='turn'&&event.state==='generated')generated?.();}});t.after(()=>bridge.close());
  for(let i=0;i<2050;i++){
    const done=new Promise(resolve=>{generated=resolve;});
    await bridge.accept({eventId:'bounded-'+i,kind:'lastSpeech',text:'😊',scope:scope()});await done;
    await bridge.receipt({envelope,status:'explicitlySkipped'});
  }
  assert.equal((await bridge.accept({eventId:'bounded-0',kind:'lastSpeech',text:'😊',scope:scope()})).accepted,true);
});

test('a real playback failure can cancel synthesis before its last PCM and retains a failed terminal receipt',async t=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const runtime={async *speak(){yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};await held;},async stopEngine(){release();}};
  const {bridge,events}=fixture({resolveVoice:async()=>({runtime,engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local'})});
  t.after(()=>bridge.close());await bridge.accept({eventId:'playback-failed',kind:'allin',scope:scope()});await until(()=>events.some(row=>row.phase==='pcm'));
  const envelope=events.find(row=>row.type==='segment'&&row.state==='queued').envelope;
  assert.equal((await bridge.receipt({envelope,status:'failed'})).accepted,true);
  assert.equal(bridge.busy(),false);assert.equal(events.some(row=>row.phase==='end'),false);
  assert.equal((await bridge.accept({eventId:'playback-failed',kind:'allin',scope:scope()})).status,'failed');
});

test('a long existing table message is spoken once in worker-sized Unicode chunks',async t=>{
  const texts=[],runtime={async *speak(request){assert.ok([...request.text].length<=240);texts.push(request.text);yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};},async stopEngine(){}};
  const {bridge,events}=fixture({resolveVoice:async()=>({runtime,engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local'})});
  t.after(()=>bridge.close());const text='既有桌聊原文。'.repeat(80);
  await bridge.accept({eventId:'long-existing-chat',kind:'table-chat',text,scope:scope()});await until(()=>events.some(row=>row.phase==='end'));
  assert.equal(texts.join(''),text);assert.equal(texts.length,3);
  assert.equal(events.filter(row=>row.type==='segment'&&row.state==='queued').length,1);
});

test('all chunks of one table event keep a single PCM rate',async t=>{
  let chunks=0;
  const runtime={async *speak(){chunks++;yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:chunks===1?24000:48000};},async stopEngine(){}};
  const {bridge,events}=fixture({resolveVoice:async()=>({runtime,engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local'})});
  t.after(()=>bridge.close());await bridge.accept({eventId:'changed-rate',kind:'table-chat',text:'长句原文'.repeat(100),scope:scope()});await until(()=>!bridge.busy());
  assert.equal(events.filter(row=>row.phase==='pcm').length,1);
  assert.equal((await bridge.accept({eventId:'changed-rate',kind:'table-chat',text:'长句原文'.repeat(100),scope:scope()})).reason,'VOICE_CARD_AUDIO_RATE_CHANGED');
});

test('a changed host voice lease rejects delayed PCM and never starts later text chunks',async t=>{
  let release,current=true,starts=0;const held=new Promise(resolve=>{release=resolve;});
  const runtime={async *speak(){starts++;yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};await held;yield {type:'pcm',pcm:new Uint8Array([1,0]),sampleRate:24000};},async stopEngine(){release();}};
  const {bridge,events}=fixture({resolveVoice:async()=>({runtime,engine:'breeze',packageId:'breeze',profileId:'alice',profileVersion:1,speechProvider:'local',async assertCurrent(){if(!current)throw Object.assign(Error('package changed'),{code:'VOICE_PACKAGE_CHANGED'});}})});
  t.after(()=>bridge.close());await bridge.accept({eventId:'changed-lease',kind:'table-chat',text:'原桌聊长句'.repeat(100),scope:scope()});await until(()=>events.some(row=>row.phase==='pcm'));
  current=false;release();await until(()=>!bridge.busy());assert.equal(starts,1);
  assert.equal(events.filter(row=>row.phase==='pcm').length,1);assert.equal(events.some(row=>row.phase==='end'),false);
  assert.equal((await bridge.accept({eventId:'changed-lease',kind:'allin',scope:scope()})).reason,'VOICE_PACKAGE_CHANGED');
});
