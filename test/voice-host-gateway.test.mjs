import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';

const ids=['ai-buddy.voice-breeze','ai-buddy.voice-gpt-sovits'];
const cardScope=()=>({channel:'card-table',tableId:'table-one',handId:'hand-one',characterId:'bob',personaId:'persona-one',lifeId:'life-bob',operationId:'operation-one'});
const cardRequest=(eventId='card-one')=>({eventId,kind:'allin',text:'untrusted replacement words',scope:cardScope()});
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('voice host did not settle');}

async function fixture(t,{packageId=ids[0],provider='local',hold=false}={}){
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
    async ready(request){ready.push({owner,...request});return {ready:true};},
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
    components:{settings,profiles,runtime,local:{},cloud:{async status(){return {state:'ready'};}},credentials:{},assets:{async resolve(){return {};},async status(){return {state:'ready'};}},supervisor:{async close(){}}}});
  t.after(async()=>{release?.();try{await host.close();}finally{await rm(dataRoot,{recursive:true,force:true});}});
  return {host,settings,events,spoken,ready,stops,gameReceipts,profileReads,profileRows,leases,packages,
    releaseSpeech:()=>release?.(),invalidateScope:()=>{valid=false;},cancelled:()=>cancelled};
}
const generated=(f,eventId='card-one')=>f.events.some(event=>event.type==='turn'&&event.state==='generated'&&event.requestId==='card:'+eventId&&!event.failed);

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
  assert.equal(f.host.snapshot().cardSpeechBusy,true);assert.ok(f.stops.includes('chat'));
  const chatStops=f.stops.filter(owner=>owner==='chat').length,cancels=f.cancelled();
  await f.host.action('stop',{channel:'card-table'});
  assert.equal(f.stops.filter(owner=>owner==='chat').length,chatStops);assert.equal(f.cancelled(),cancels);
  assert.equal(f.host.snapshot().cardSpeechBusy,false);
  for(const operation of [()=>f.host.action('stop'),()=>f.host.quiesce()]){
    const before=f.stops.length,beforeCancel=f.cancelled();await operation();
    assert.ok(f.stops.slice(before).includes('chat'));assert.ok(f.stops.slice(before).includes('card-table'));assert.ok(f.cancelled()>beforeCancel);
  }
  assert.equal(f.stops.includes('all'),false);
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
