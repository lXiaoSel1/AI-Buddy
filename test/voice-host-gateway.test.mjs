import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceChatControls} from '../src/voice/client.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createVoiceConversation} from '../src/voice/conversation.mjs';

const ids=['ai-buddy.voice-breeze','ai-buddy.voice-gpt-sovits'];
const cardScope=()=>({channel:'card-table',tableId:'table-one',handId:'hand-one',characterId:'bob',personaId:'persona-one',lifeId:'life-bob',operationId:'operation-one'});
const cardRequest=(eventId='card-one')=>({eventId,kind:'allin',text:'untrusted replacement words',scope:cardScope()});
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('voice host did not settle');}

async function fixture(t,{packageId=ids[0],provider='local',hold=false,readiness={ready:true},assetsOverride={}}={}){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-host-gateway-'));
  const settings=createVoiceSettings();
  await settings.update({enabled:true,selectedPackageId:packageId,packages:{[packageId]:{ttsProvider:provider,credentialRef:'voice:test-key'}}});
  const events=[],spoken=[],ready=[],stops=[],gameReceipts=[],profileReads=[],leases=[];
  const packages=ids.map((id,index)=>({id,engine:index?'gpt':'breeze',installed:true,enabled:true,usable:true,trusted:true,sourceId:'official',version:'1',archiveSha256:'archive-'+index}));
  const profileRows=new Map();
  for(const characterId of ['alice','bob'])for(const engine of ['breeze','gpt'])profileRows.set(characterId+':'+engine,{id:characterId+'-'+engine,version:3,characterId,engine});
  let valid=true,cancelled=0,release;
  const held=hold?new Promise(resolve=>{release=resolve;}):Promise.resolve();
  const channels=Object.fromEntries(['chat','card-table'].map(owner=>[owner,{
    async *speak(request){spoken.push({owner,...request});if(owner==='card-table')await held;yield {type:'pcm',pcm:new Uint8Array([0,0,1,0]),sampleRate:request.speechProvider==='minimax'?32000:request.engine==='gpt'?48000:24000};},
    async ready(request){ready.push({owner,...request});return readiness;},
    async prepare(){return {ready:true};},
    async stopEngine(){stops.push(owner);if(owner==='card-table')release?.();},
    async cancelCapture(){},async close(){await this.stopEngine();}
  }]));
  const runtime={channel:owner=>channels[owner],async stopEngine(){stops.push('all');release?.();},async close(){release?.();}};
  const chatScope={channel:'app-private',characterId:'alice',personaId:'persona-one',conversationId:'private-chat',lifeId:'life-alice',operationId:'operation-one'};
  const game={voiceScope:()=>({...chatScope}),voiceCancel:()=>{cancelled++;},voiceReceipt:async value=>{gameReceipts.push(value);return {accepted:true};},voiceSubmit:async()=>{throw Error('card speech must not submit another model turn');}};
  const platform={voicePackageStatus:()=>packages,resolveVoicePackage:async(id,options)=>{leases.push({id,...options});return {assertCurrent(){}};},cardGames:{voiceScopeValid:scope=>valid&&scope.tableId==='table-one'&&scope.handId==='hand-one'&&scope.lifeId==='life-bob'}};
  const profiles={
    async current(scope){profileReads.push(scope);return structuredClone(profileRows.get(scope.characterId+':'+scope.engine));},
    async select({characterId,engine,profileId}){const key=characterId+':'+engine,old=profileRows.get(key),next={...old,id:profileId,version:old.version+1};profileRows.set(key,next);return next;}
  };
  const host=createVoiceHost({dataRoot,build:'unused',getGame:()=>game,getPlatform:()=>platform,send:event=>events.push(event),
    components:{settings,profiles,runtime,local:{},cloud:{async status(){return {state:'ready'};}},credentials:{},assets:{async prepareSelected(){return {state:'ready'};},async resolve(){return {};},async status(){return {state:'ready'};},...assetsOverride},supervisor:{async close(){}}}});
  t.after(async()=>{release?.();try{await host.close();}finally{await rm(dataRoot,{recursive:true,force:true});}});
  return {host,game,settings,events,spoken,ready,stops,gameReceipts,profileReads,profileRows,leases,packages,channels,
    releaseSpeech:()=>release?.(),invalidateScope:()=>{valid=false;},cancelled:()=>cancelled};
}
const generated=(f,eventId='card-one')=>f.events.some(event=>event.type==='turn'&&event.state==='generated'&&event.requestId==='card:'+eventId&&!event.failed);
function assertChatControlsReady(state){
  const render=placement=>renderToStaticMarkup(React.createElement(VoiceChatControls,{state,scope:state.scope,placement,snapshot:{state,captureState:'idle'}}));
  assert.match(render('top'),/Breeze 就绪/);
  assert.match(render('input-left'),/vx-mic/);
  assert.match(render('input-right'),/vx-livebtn/);
  assert.doesNotMatch(render('input-left')+render('input-right'),/disabled/);
}

test('the host resolves the table speaker profile for either plugin/provider and routes card receipts away from private chat',async t=>{
  for(const packageId of ids)for(const provider of ['local','minimax'])await t.test(packageId+' / '+provider,async t=>{
    const f=await fixture(t,{packageId,provider}),engine=packageId===ids[0]?'breeze':'gpt';
    assert.equal((await f.host.cardEvent(cardRequest())).accepted,true);await until(()=>generated(f));
    assert.equal(f.spoken.length,1);
    assert.equal(f.spoken[0].text,'All in!');assert.equal(f.spoken[0].characterId,'bob');
    assert.equal(f.spoken[0].profileId,'bob-'+engine);assert.equal(f.spoken[0].engine,engine);assert.equal(f.spoken[0].speechProvider,provider);
    assert.equal(f.profileReads.every(scope=>scope.characterId==='bob'),true);
    assert.deepEqual(f.leases,[{id:packageId,provider}]);
    assert.equal(f.ready.length,provider==='minimax'?1:0);
    const envelope=f.events.find(event=>event.type==='segment'&&event.state==='queued').envelope;
    assert.equal(envelope.channel,'card-table');assert.equal(envelope.voiceProfileVersion,3);
    assert.equal((await f.host.action('receipt',{envelope,status:'audioCompleted'})).accepted,true);
    assert.equal(f.gameReceipts.length,0);assert.equal(f.host.snapshot().cardSpeechBusy,false);
    assert.equal((await f.host.cardEvent(cardRequest())).status,'audioCompleted');
  });
});

test('channel stops preserve the other owner while ordinary stop and maintenance stop both',async t=>{
  const f=await fixture(t);await f.host.cardEvent(cardRequest());await until(()=>generated(f));
  const cardStops=f.stops.filter(owner=>owner==='card-table').length;
  await f.host.action('stop',{channel:'app-chat'});
  assert.equal(f.stops.filter(owner=>owner==='card-table').length,cardStops);
  assert.equal(f.host.snapshot().cardSpeechBusy,true);assert.equal(f.stops.includes('chat'),false);
  const chatStops=f.stops.filter(owner=>owner==='chat').length,cancels=f.cancelled();
  await f.host.action('stop',{channel:'card-table'});
  assert.equal(f.stops.filter(owner=>owner==='chat').length,chatStops);assert.equal(f.cancelled(),cancels);
  assert.equal(f.host.snapshot().cardSpeechBusy,false);
  for(const operation of [()=>f.host.action('stop'),()=>f.host.quiesce()]){
    const before=f.stops.length,beforeCancel=f.cancelled();await operation();
    assert.ok(f.stops.slice(before).includes('chat'));assert.ok(f.stops.slice(before).includes('card-table'));assert.ok(f.cancelled()>beforeCancel);
  }
  assert.equal(f.stops.includes('all'),true,'global stop also drains cloud operations without a speech owner');
});

test('stopping a chat capture keeps resident speech available for the next reply and capture',async t=>{
  const f=await fixture(t),chat=f.channels.chat;
  let engineReady=false;
  const stopEngine=chat.stopEngine;
  chat.prepare=async()=>{engineReady=true;return {ready:true};};
  chat.ready=async()=>({ready:engineReady});
  chat.stopEngine=async()=>{engineReady=false;await stopEngine();};
  chat.cancelCurrent=async()=>{};
  chat.startCapture=async()=>{};
  await f.host.action('prepare',{target:'speech'});
  const first=await f.host.action('capture-start',{mode:'record'});

  await f.host.action('stop',{channel:'app-chat'});
  const state=await f.host.action('state');
  assert.deepEqual(state.preparation,{state:'ready',target:'speech'});
  assertChatControlsReady(state);
  assert.equal(state.capture,null);
  assert.deepEqual(f.stops,[]);
  await assert.rejects(f.host.action('capture-finish',{id:first.id}),{code:'VOICE_STALE_CAPTURE'});

  const turn={...state.scope,requestId:'after-chat-stop',messageId:'new-message'};
  const lease=await f.host.controller.admit(turn);
  assert.ok(lease);
  const envelope={...turn,...lease,index:0,segmentId:'after-chat-stop:voice:0'};
  assert.equal(await f.host.controller.segment({envelope,text:'结束后仍然朗读。'}),true);
  await until(()=>f.events.some(event=>event.type==='audio'&&event.phase==='end'&&event.envelope.requestId===turn.requestId));
  await f.host.controller.finish({requestId:turn.requestId});
  await f.host.action('receipt',{envelope,status:'audioCompleted'});
  const next=await f.host.action('capture-start',{mode:'live'});
  assert.notEqual(next.id,first.id);
  await f.host.action('stop',{channel:'app-chat'});
  assertChatControlsReady(await f.host.action('state'));

  await f.host.action('stop');
  assert.equal((await f.host.action('state')).preparation.state,'idle');
  assert.equal(engineReady,false);
  assert.ok(f.stops.includes('chat'));
});

test('stopping an active reading interrupts its presentation without stopping resident speech',async t=>{
  const f=await fixture(t),chat=f.channels.chat,entered=Promise.withResolvers();
  const conversation=createVoiceConversation({voice:f.host.controller,current:f.game.voiceScope,valid:()=>true,
    persist:async()=>{},beginPresentation:()=>{},completePresentation:()=>{},now:()=>1,audit:()=>{}});
  f.game.voiceCancel=()=>conversation.cancel(()=>true);
  f.game.voiceSkip=conversation.skip;
  chat.cancelCurrent=async()=>{};
  chat.speak=async function*({signal}){
    const aborted=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    entered.resolve();
    await aborted;
  };
  await f.host.action('prepare',{target:'speech'});
  const scope=f.game.voiceScope();
  const turn=await conversation.begin({...scope,requestId:'reading',messageId:'reading-message'},scope);
  assert.ok(turn);
  assert.equal(await conversation.emit(turn,{text:'朗读过程中停止。'}),true);
  await entered.promise;

  await f.host.action('stop-reading',{requestId:'reading'});
  assert.deepEqual(f.stops,[]);
  assert.equal(conversation.blocked('reading'),true,'text generation can still finish');
  conversation.finish(turn);
  assert.equal(conversation.blocked('reading'),false);
  const state=await f.host.action('state');
  assert.deepEqual(state.preparation,{state:'ready',target:'speech'});
  assertChatControlsReady(state);
});

test('stop reading removes only the selected reply while the next reply stays queued',async t=>{
  const f=await fixture(t),chat=f.channels.chat,entered=Promise.withResolvers(),drained=Promise.withResolvers();
  t.after(()=>drained.resolve());
  f.game.voiceScope=()=>({channel:'app-group',characterId:'alice',personaId:'persona-one',conversationId:'group-chat',lifeId:'life-alice',operationId:'operation-one'});
  const conversation=createVoiceConversation({voice:f.host.controller,current:f.game.voiceScope,valid:()=>true,
    persist:async()=>{},beginPresentation:()=>{},completePresentation:()=>{},now:()=>1,audit:()=>{}});
  f.game.voiceSkip=conversation.skip;
  chat.speak=async function*({text}){
    if(text==='旧回复。'){entered.resolve();await drained.promise;}
    yield {type:'pcm',pcm:Buffer.alloc(4),sampleRate:24000};
  };
  await f.host.action('prepare',{target:'speech'});
  const scope=f.game.voiceScope();
  const old=await conversation.begin({...scope,requestId:'old-reply',messageId:'old-message'},scope);
  assert.equal(await conversation.emit(old,{text:'旧回复。'}),true);
  await entered.promise;
  assert.equal(await conversation.emit(old,{text:'旧回复第二段。'}),true);
  const next=await conversation.begin({...scope,requestId:'next-reply',messageId:'next-message'},scope);
  assert.equal(await conversation.emit(next,{text:'新回复。'}),true);
  try{
    await f.host.action('stop-reading',{requestId:'old-reply'});
    assert.equal(conversation.blocked('old-reply'),true);
    await conversation.emit(old,{text:'跳过后才到达的语段。'});
    conversation.finish(old);
    assert.equal(conversation.blocked('old-reply'),false);
    assert.equal(conversation.blocked('next-reply'),true);
    assert.deepEqual(conversation.records(old).map(row=>row.status),['explicitlySkipped','explicitlySkipped','explicitlySkipped']);
    assert.equal((await f.host.action('state')).epoch,0);
    assertChatControlsReady({...await f.host.action('state'),scope});
  }finally{drained.resolve();}
  await until(()=>f.events.some(event=>event.type==='audio'&&event.phase==='pcm'&&event.envelope.requestId==='next-reply'));
  assert.equal(f.events.some(event=>event.type==='audio'&&event.phase==='pcm'&&event.envelope.requestId==='old-reply'),false);
  assert.deepEqual(f.stops,[]);
});

test('skipping a Live reply waits for text completion and ending Live fences a later reply',async t=>{
  const f=await fixture(t),chat=f.channels.chat;
  const conversation=createVoiceConversation({voice:f.host.controller,current:f.game.voiceScope,valid:()=>true,
    persist:async()=>{},beginPresentation:()=>{},completePresentation:()=>{},now:()=>1,audit:()=>{}});
  f.game.voiceSkip=conversation.skip;
  f.game.voiceSubmit=async()=>({accepted:true});
  let captures=0;
  chat.startCapture=async()=>{captures++;};
  chat.feedCapture=async()=>({endpoint:true});
  chat.finishCapture=async()=>({text:'测试语音输入'});
  const scope=f.game.voiceScope();
  await f.host.action('prepare',{target:'live'});
  const first=await f.host.action('capture-start',{mode:'live'});
  await f.host.action('capture-feed',{id:first.id,pcm:new Uint8Array(4)});
  const turn=await conversation.begin({...scope,requestId:'live-first',messageId:'first'},scope,first.id);
  await conversation.emit(turn,{text:'Live 的回复。'});
  await until(()=>f.events.some(event=>event.type==='audio'&&event.phase==='pcm'));
  await f.host.action('stop-reading',{requestId:'live-first'});
  assert.equal(captures,1);
  assert.equal((await f.host.action('state')).live,true);
  conversation.finish(turn);
  await until(()=>captures===2);
  const next=(await f.host.action('state')).capture;
  assert.notEqual(next.id,first.id);
  await f.host.action('capture-feed',{id:next.id,pcm:new Uint8Array(4)});
  await f.host.action('stop',{channel:'app-chat'});
  assert.equal((await f.host.action('state')).live,false);
  assert.equal(await conversation.begin({...scope,requestId:'late-live',messageId:'late'},scope,next.id),null);
  assert.equal(captures,2);
  assertChatControlsReady(await f.host.action('state'));
  assert.deepEqual(f.stops,[]);
});

test('a late scoped ASR stop error cannot replace a newer successful invalidation',async t=>{
  const f=await fixture(t),chat=f.channels.chat,entered=Promise.withResolvers(),late=Promise.withResolvers();
  let cancels=0;
  chat.cancelCapture=async()=>{if(++cancels===1){entered.resolve();return late.promise;}};
  chat.startCapture=async()=>{};
  chat.cancelCurrent=async()=>{};
  await f.host.action('prepare',{target:'speech'});
  await f.host.action('capture-start',{mode:'record'});
  const scoped=f.host.action('stop',{channel:'app-chat'});
  await entered.promise;
  const transition=f.host.controller.invalidate('scope-changed');
  await transition;
  late.reject(Error('old ASR cleanup finished after the transition'));
  await scoped;
  assert.equal((await f.host.action('state')).stopping,false);
  assertChatControlsReady(await f.host.action('state'));
  await f.host.action('capture-start',{mode:'record'});
});

test('stop reading drops a stale ready indicator after a confirmed worker retirement',async t=>{
  const f=await fixture(t),chat=f.channels.chat,entered=Promise.withResolvers();
  let ready=true;
  chat.ready=async()=>({ready});
  chat.speak=async function*({signal}){
    const aborted=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    entered.resolve();
    await aborted;
    ready=false;
    throw signal.reason;
  };
  await f.host.action('prepare',{target:'speech'});
  const scope={...f.game.voiceScope(),requestId:'retired-reading',messageId:'retired-message'};
  const lease=await f.host.controller.admit(scope);
  await f.host.controller.segment({envelope:{...scope,...lease,segmentId:'retired-reading:voice:0',index:0},text:'测试退出。'});
  await entered.promise;
  await f.host.action('stop-reading',{requestId:scope.requestId});
  await until(()=>f.events.some(event=>event.type==='preparation'&&event.preparation.state==='idle'));
  assert.equal((await f.host.action('state')).preparation.state,'idle');
});

test('cancelling Live while ASR loads aborts that preparation and keeps an already ready speech engine',async t=>{
  const f=await fixture(t),chat=f.channels.chat;
  const loading=Promise.withResolvers();
  let engineReady=false,asrRetired=false,liveAttempts=0;
  const stopEngine=chat.stopEngine;
  chat.prepare=async({target,onProgress,signal})=>{
    if(target==='speech'){engineReady=true;return {ready:true};}
    if(++liveAttempts>1)return {ready:engineReady};
    const cancelled=new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    onProgress({state:'loading',component:'asr'});
    loading.resolve(signal);
    return cancelled;
  };
  chat.ready=async()=>({ready:engineReady});
  chat.stopEngine=async()=>{engineReady=false;await stopEngine();};
  chat.cancelCurrent=async()=>{};
  chat.cancelCapture=async()=>{asrRetired=true;};
  await f.host.action('prepare',{target:'speech'});
  const live=assert.rejects(f.host.action('prepare',{target:'live'}),{code:'VOICE_PREPARATION_CANCELLED'});
  const signal=await loading.promise;
  assert.deepEqual((await f.host.action('state')).preparation,{state:'loading',target:'live',component:'asr'});

  await Promise.all([f.host.action('stop',{channel:'app-chat'}),f.host.action('stop',{channel:'app-chat'}),live]);
  assert.equal(signal.aborted,true);
  assert.equal(asrRetired,true);
  assert.deepEqual((await f.host.action('state')).preparation,{state:'ready',target:'speech'});
  assert.deepEqual(f.stops,[]);
  assert.deepEqual((await f.host.action('prepare',{target:'live'})).preparation,{state:'ready',target:'live'});
  assert.equal(liveAttempts,2);
});

test('ending chat voice does not cancel a separate engine component download',async t=>{
  const entered=Promise.withResolvers(),finish=Promise.withResolvers();
  const f=await fixture(t,{assetsOverride:{async prepare(kind,{signal}){entered.resolve(signal);await finish.promise;return {state:'ready'};}}});
  f.channels.chat.cancelCurrent=async()=>{};
  await f.host.action('prepare',{target:'speech'});
  const download=f.host.action('assets-prepare',{kind:'gpt',packageId:ids[1]});
  const signal=await entered.promise;
  const stop=f.host.action('stop',{channel:'app-chat'});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(signal.aborted,false);
    await stop;
    assert.equal((await f.host.action('state')).preparation.state,'ready');
  }finally{finish.resolve();await Promise.all([download,stop]);}
});

test('ending Live cancels its asset preparation without starting recognition or stopping resident speech',async t=>{
  const entered=Promise.withResolvers();let preparations=0,recognitionStarts=0;
  const f=await fixture(t,{assetsOverride:{async prepareSelected({signal}){
    if(++preparations===1)return {state:'ready'};
    const cancelled=new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    entered.resolve(signal);return cancelled;
  }}});
  const chat=f.channels.chat;
  chat.cancelCurrent=async()=>{};
  chat.prepare=async({target})=>{if(target==='live')recognitionStarts++;return {ready:true};};
  await f.host.action('prepare',{target:'speech'});
  const pending=f.host.action('prepare',{target:'live'}),signal=await entered.promise;
  await f.host.action('stop',{channel:'app-chat'});
  assert.deepEqual(await pending,{cancelled:true});
  assert.equal(signal.aborted,true);
  assert.equal(recognitionStarts,0);
  assert.deepEqual(f.stops,[]);
  assertChatControlsReady(await f.host.action('state'));
});

test('global disable and an unusable package reject card admission before synthesis',async t=>{
  const f=await fixture(t);await f.settings.update({enabled:false});
  await assert.rejects(f.host.cardEvent(cardRequest('disabled')),{code:'VOICE_PACKAGE_UNAVAILABLE'});
  await f.settings.update({enabled:true});f.packages[0].usable=false;
  await assert.rejects(f.host.cardEvent(cardRequest('unusable')),{code:'VOICE_PACKAGE_UNAVAILABLE'});
  assert.equal(f.spoken.length,0);assert.equal(f.events.some(event=>event.phase==='pcm'),false);
});

test('maintenance revokes a card admission paused in settings before it can start synthesis',async t=>{
  const f=await fixture(t),readSettings=f.settings.get;
  let release,entered;
  const held=new Promise(resolve=>{release=resolve;}),selectionStarted=new Promise(resolve=>{entered=resolve;});
  f.settings.get=async()=>{entered();await held;return readSettings();};
  const admission=f.host.cardEvent(cardRequest('paused-admission'));
  try{
    await selectionStarted;await f.host.quiesce();release();
    assert.deepEqual(await admission,{accepted:false,reason:'revoked'});
    assert.equal(f.spoken.length,0);assert.equal(f.events.some(event=>event.type==='segment'&&event.state==='queued'),false);
  }finally{release();f.settings.get=readSettings;await admission.catch(()=>{});}
});

test('a changed table scope discards delayed PCM instead of completing the old card call',async t=>{
  const f=await fixture(t,{hold:true});await f.host.cardEvent(cardRequest());await until(()=>f.spoken.length===1);
  f.invalidateScope();f.releaseSpeech();await until(()=>!f.host.busy());
  assert.equal(f.events.some(event=>event.phase==='pcm'),false);assert.equal(generated(f),false);
  assert.equal(f.events.find(event=>event.type==='segment'&&event.state==='failed').code,'VOICE_CARD_SCOPE_CHANGED');
});

test('renderer-supplied identity is rejected before it can configure or stop an owner',async t=>{
  const f=await fixture(t);
  for(const identity of [{characterId:'bob'},{personaId:'other'},{lifeId:'other'},{operationId:'other'},{conversationId:'table-one'},{engine:'gpt'},{packageId:ids[1]}]){
    await assert.rejects(f.host.action('configure',identity),{code:'VOICE_SCOPE_FORGED'});
  }
  assert.equal(f.stops.length,0);assert.equal(f.cancelled(),0);assert.equal(f.spoken.length,0);
});

test('table hand transition cancels old output without releasing an idle healthy voice engine',async t=>{
 const f=await fixture(t);
 await f.host.cardEvent({type:'scope-update',tableId:'table-one',handId:'hand-one',status:'completed'});
 const before=f.stops.length;
 await f.host.cardEvent({type:'scope-update',tableId:'table-one',handId:'hand-two',status:'active'});
 assert.equal(f.stops.length,before);
});

test('table cloud readiness preserves the real provider failure code and explanation',async t=>{
 const f=await fixture(t,{provider:'minimax',readiness:{ready:false,code:'CLOUD_KEY_REQUIRED',message:'请更新失效的云配音配置'}});
 await f.host.cardEvent(cardRequest());await until(()=>f.events.some(row=>row.type==='segment'&&row.state==='failed'));
 const error=f.events.find(row=>row.type==='segment'&&row.state==='failed');
 assert.equal(error.code,'CLOUD_KEY_REQUIRED');assert.equal(error.message,'请更新失效的云配音配置');assert.equal(f.spoken.length,0);
});

test('renderer settings and configuration events cannot disclose or replace private credential references',async t=>{
 const f=await fixture(t);
 assert.doesNotMatch(JSON.stringify(await f.host.action('state')),/credentialRef|voice:test-key/);
 await assert.rejects(f.host.action('configure',{cloudConnections:{selectedId:null,items:[]}}),{code:'VOICE_SCOPE_FORGED'});
 await assert.rejects(f.host.action('configure',{packages:{[ids[0]]:{credentialRef:'voice:forged'}}}),{code:'VOICE_SCOPE_FORGED'});
 assert.doesNotMatch(JSON.stringify(await f.host.action('configure',{enabled:true})),/credentialRef|voice:test-key/);
 assert.doesNotMatch(JSON.stringify(f.events),/credentialRef|voice:test-key/);
});

for(const target of ['app-chat','global'])test('explicit '+target+' stop retries its failed cleanup in one click',async t=>{
 const f=await fixture(t),chat=f.channels.chat,global=target==='global',payload=global?{}:{channel:'app-chat'};
 await f.host.action('prepare',{target:'speech'});
 const method=global?'stopEngine':'cancelCapture',real=chat[method];
 chat[method]=async()=>{throw Object.assign(Error('stop unknown'),{code:'VOICE_WORKER_STOP_FAILED'});};
 await assert.rejects(f.host.action('stop',payload),{code:'VOICE_CLEANUP_FAILED'});
 chat[method]=real;
 await f.host.action('stop',payload);
 assert.equal((await f.host.action('state')).preparation.state,global?'idle':'ready');
 if(!global)assert.deepEqual(f.stops,[]);
});

test('configuration and profile changes revoke pending card PCM, including an externally changed profile version',async t=>{
  for(const change of ['configure','profile-select','profile-version'])await t.test(change,async t=>{
    const f=await fixture(t,{hold:true});await f.host.cardEvent(cardRequest());await until(()=>f.spoken.length===1);
    if(change==='configure')await f.host.action('configure',{packages:{[ids[0]]:{ttsProvider:'minimax'}}});
    else if(change==='profile-select')await f.host.action('profile-select',{profileId:'alice-replacement'});
    else{const old=f.profileRows.get('bob:breeze');f.profileRows.set('bob:breeze',{...old,version:4});f.releaseSpeech();}
    await until(()=>!f.host.busy());
    assert.equal(f.events.some(event=>event.phase==='pcm'),false);assert.equal(generated(f),false);
    assert.ok(f.stops.includes('card-table'));
    if(change==='profile-version')assert.equal(f.events.find(event=>event.type==='segment'&&event.state==='failed').code,'VOICE_PROFILE_CHANGED');
    else assert.equal((await f.host.cardEvent(cardRequest())).status,'interrupted');
  });
});

test('official asset retry forwards only the chosen operation and preserves mirror failure diagnostics',async t=>{
 const calls=[],f=await fixture(t,{assetsOverride:{async prepare(kind,options){calls.push({kind,official:options.official});if(calls.length===1)throw Object.assign(Error('bad mirror bytes'),{code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true,host:'mirror.invalid'});return {state:'ready'};}}});
 await assert.rejects(f.host.action('assets-prepare',{kind:'asr',packageId:ids[0]}),{code:'NETWORK_MIRROR_MISMATCH'});
 const failed=f.events.findLast(event=>event.type==='asset-progress');assert.equal(failed.retryOfficial,true);assert.equal(failed.kind,'asr');assert.equal(failed.host,'mirror.invalid');
 await f.host.action('assets-prepare',{kind:'asr',packageId:ids[0],official:true,expectedProvider:'local'});
 await f.host.action('assets-prepare',{kind:'asr',packageId:ids[0]});assert.deepEqual(calls,[{kind:'asr',official:false},{kind:'asr',official:true},{kind:'asr',official:false}]);
 await assert.rejects(f.host.action('assets-prepare',{kind:'asr',packageId:ids[0],official:true,expectedProvider:'minimax'}),{code:'VOICE_ASSET_SELECTION_CHANGED'});
 assert.equal(calls.length,3);
});
