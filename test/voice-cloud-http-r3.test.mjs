import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createVoiceCloud} from '../src/voice/cloud.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {ensureVoiceSession,VoiceChatControls,VoiceDialogueLine} from '../src/voice/client.mjs';
import {CloudVoiceSettings} from '../src/voice/cloud-settings-ui.mjs';
import {setLocale} from '../src/i18n.mjs';

const key='synthetic-key';
const params={engine:'breeze',characterId:'c',profileId:'p',profileVersion:1,text:'Synthetic speech text.'};
const profileFor=({characterId},secret=key,provider='minimax')=>({
  id:'p',version:1,characterId,engine:'breeze',
  cloudBinding:{accountScope:createHash('sha256').update(provider+'\0'+secret).digest('hex'),provider,voiceId:'v'},
});
const providerRow=status_code=>({base_resp:{status_code,status_msg:key+' '+params.text}});
const providerResponse=(code,contentType='application/json',status=200)=>new Response(JSON.stringify(providerRow(code)),{status,headers:contentType?{'content-type':contentType}:undefined});
const frame=row=>'data: '+JSON.stringify(row)+'\r\n\r\n';
const pcm=frame({base_resp:{status_code:0},data:{status:1,audio:'0100'}});
const final=frame({base_resp:{status_code:0},data:{status:2}});

function splitResponse(chunks,headers={}){
  return new Response(new ReadableStream({
    start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();},
  }),{headers});
}

async function make(t,fetch){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-cloud-http-r3-'));
  const audit=[],attempts=[];
  let currentKey=key,provider='minimax',currentTime=1;
  const cloud=createVoiceCloud({
    dataRoot,authorizeSpeech:async()=>{},now:()=>currentTime,onSpeechFailure:row=>audit.push(row),
    resolveConnection:async()=>({provider,model:'speech-2.8-turbo',keyRef:'test-reference'}),
    resolveSecret:async()=>currentKey,
    resolveProfile:async params=>profileFor(params,currentKey,provider),
    network:{fetch:(url,options)=>{attempts.push(url);return fetch(url,options);}},
  });
  t.after(async()=>{await cloud.close();await rm(dataRoot,{recursive:true,force:true});});
  return {cloud,audit,attempts,setKey:value=>{currentKey=value;},setProvider:value=>{provider=value;},advance:ms=>{currentTime+=ms;}};
}
const speak=(cloud,input=params)=>Array.fromAsync(cloud.speak(input));

for(const [name,providerCode,code,status] of [
  ['json error body 200',1004,'CLOUD_MINIMAX_AUTH','key-invalid'],
  ['json error body 200 (insufficient balance)',1008,'CLOUD_MINIMAX_BALANCE','unavailable'],
])test(name,async t=>{
  const {cloud}=await make(t,async()=>providerResponse(providerCode));
  await assert.rejects(speak(cloud),{code,providerCode});
  const readiness=await cloud.status(params);
  assert.deepEqual([readiness.state,readiness.code,readiness.providerCode],[status,code,providerCode]);
});

for(const [name,fetch,code,raw,category] of [
  ['JSON without Content-Type',()=>splitResponse(['','\ufeff  ','{"base_resp":',JSON.stringify(providerRow(2049).base_resp),'}']),'CLOUD_MINIMAX_AUTH',{providerCode:2049},'auth'],
  ['JSON labeled as SSE',()=>providerResponse(1026,'text/event-stream'),'CLOUD_MINIMAX_MODERATION',{providerCode:1026},'moderation'],
  ['JSON with a +json type',()=>providerResponse(20132,'application/problem+json; charset=utf-8'),'CLOUD_MINIMAX_PARAMETERS',{providerCode:20132},'parameters'],
  ['unknown code in JSON',()=>providerResponse(729531,'application/json'),'CLOUD_MINIMAX_UNKNOWN',{providerCode:729531},'unknown'],
  ['standalone JSON success data is unexpected for streaming',()=>providerResponse(0),'CLOUD_MINIMAX_RESPONSE',{},'response'],
  ['business code overrides HTTP status',()=>providerResponse(2053,'text/plain',429),'CLOUD_MINIMAX_BALANCE',{providerCode:2053,httpStatus:429},'balance'],
  ['HTTP 401',()=>new Response('Unauthorized',{status:401}),'CLOUD_MINIMAX_AUTH',{httpStatus:401},'auth'],
  ['HTTP 403',()=>new Response(null,{status:403}),'CLOUD_MINIMAX_DENIED',{httpStatus:403},'denied'],
  ['HTTP 429',()=>new Response('Rate limited',{status:429}),'CLOUD_MINIMAX_RATE_LIMIT',{httpStatus:429},'rate_limit'],
  ['HTTP 500',()=>new Response('Server error',{status:500}),'CLOUD_MINIMAX_SERVICE',{httpStatus:500},'service'],
  ['HTTP 504',()=>new Response('Timed out',{status:504}),'CLOUD_TIMEOUT',{httpStatus:504},'timeout'],
  ['network rejection',()=>{throw Object.assign(Error(key+' '+params.text),{code:'CLOUD_INCOMPLETE'});},'CLOUD_NETWORK',{},'network'],
])test('ordinary MiniMax classifies '+name+' and logs only safe diagnostics',async t=>{
  const {cloud,audit,attempts}=await make(t,fetch);
  await assert.rejects(speak(cloud),error=>{
    assert.equal(error.code,code);
    assert.equal(error.category,category);
    assert.deepEqual([error.providerCode,error.httpStatus],[raw.providerCode,raw.httpStatus]);
    assert.equal(error.cause,undefined);
    assert.doesNotMatch(error.message,/synthetic-key|Synthetic speech text/);
    return true;
  });
  const numericCode=raw.providerCode??raw.httpStatus;
  assert.deepEqual(audit,numericCode===undefined?[{category}]:[{category,code:numericCode}]);
  assert.equal(attempts.length,1);
});

for(const failure of ['provider event','disconnected reader'])test('ordinary MiniMax retains streamed PCM before a '+failure,async t=>{
  let control;
  const {cloud,attempts}=await make(t,()=>new Response(new ReadableStream({
    start(controller){control=controller;control.enqueue(new TextEncoder().encode(pcm));},
  }),{headers:{'content-type':'text/event-stream'}}));
  const iterator=cloud.speak(params);
  assert.equal((await iterator.next()).value.type,'reference');
  assert.deepEqual((await iterator.next()).value.pcm,Buffer.from([1,0]));
  if(failure==='provider event'){
    control.enqueue(new TextEncoder().encode(frame({...providerRow(1045),data:{status:2}})));
    await assert.rejects(iterator.next(),{code:'CLOUD_MINIMAX_RATE_LIMIT',providerCode:1045});
  }else{
    control.error(Error(key));
    await assert.rejects(iterator.next(),{code:'CLOUD_NETWORK'});
  }
  assert.equal(attempts.length,1);
});

test('ordinary MiniMax plays actual SSE with the documented application/json media type',async t=>{
  const {cloud}=await make(t,()=>splitResponse(['','da',pcm.slice(2),final],{'content-type':'application/json'}));
  const events=await speak(cloud);
  assert.deepEqual(events.map(event=>event.type),['reference','pcm','done']);
  assert.deepEqual(events[1].pcm,Buffer.from([1,0]));
  assert.equal((await cloud.status(params)).state,'ready');
});

for(const [providerCode,windowMs] of [[1004,300000],[1008,300000],[1002,15000]])test('account cooldown and ordinary retry for MiniMax '+providerCode,async t=>{
  let failNext=true;
  const f=await make(t,()=>failNext?providerResponse(providerCode):splitResponse([pcm,final]));
  await assert.rejects(speak(f.cloud),{providerCode});
  const otherRole={...params,characterId:'other'};
  assert.equal((await f.cloud.status(otherRole)).suppressed,true);
  await assert.rejects(speak(f.cloud,otherRole),{suppressed:true,providerCode});
  f.advance(windowMs-1);
  f.setKey(key);
  await assert.rejects(speak(f.cloud),{suppressed:true,providerCode});
  assert.equal(f.attempts.length,1);
  assert.deepEqual(f.audit.map(row=>row.code),[providerCode]);

  failNext=false;
  f.setKey('different-key');
  assert.equal((await f.cloud.status(params)).state,'ready');
  assert.equal((await speak(f.cloud)).at(-1).type,'done');
  f.setKey(key);
  f.setProvider('minimax-global');
  assert.equal((await f.cloud.status(params)).state,'ready');
  f.setProvider('minimax');
  assert.equal((await f.cloud.status(params)).suppressed,true);
  f.advance(1);
  assert.equal((await f.cloud.status(params)).state,'ready');
  assert.equal(f.attempts.length,2,'status reads do not submit a retry');
  assert.equal((await speak(f.cloud)).at(-1).type,'done');
  assert.equal(f.attempts.length,3,'only the next ordinary request retries');
});

const packageId='ai-buddy.voice-breeze';
const chatScope={channel:'app-private',characterId:'c',personaId:'persona',conversationId:'chat',lifeId:'life',operationId:'operation'};
const cardScope={...chatScope,characterId:'other',channel:'card-table',tableId:'table',handId:'hand',conversationId:'table'};
const resolveEvent=(scope,lease,index)=>({...scope,...lease,index,segmentId:scope.requestId+':voice:'+index});

async function hostFixture(t,failCode){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-host-r3-'));
  const settings=createVoiceSettings();
  await settings.update({enabled:true,packages:{[packageId]:{credentialRef:'test-key-reference',ttsProvider:'minimax'}}});
  const events=[],audit=[],listeners=new Set(),deliveries=[];
  const submit=Promise.withResolvers();
  const fetchEntered=Promise.withResolvers(),fetchReply=Promise.withResolvers();
  let attempts=0,stateReads=0;
  const platform={
    voicePackageStatus:()=>[{id:packageId,engine:'breeze',installed:true,enabled:true,usable:true,trusted:true}],
    resolveVoicePackage:async()=>({assertCurrent(){}}),
    cardGames:{voiceScopeValid:()=>true},
  };
  const host=createVoiceHost({
    dataRoot,build:dataRoot,network:{async fetch(){attempts++;fetchEntered.resolve();await fetchReply.promise;return providerResponse(failCode);}},
    getGame:()=>({voiceScope:()=>chatScope,viewState:()=>({characters:[]}),voiceReceipt:async()=>({accepted:true}),voiceSubmit:async()=>{submit.resolve();return {requestId:'live-reply'};}}),
    getPlatform:()=>platform,send:event=>{events.push(event);deliveries.push(Promise.all([...listeners].map(listener=>listener(event))));},audit:value=>audit.push(value),
    components:{
      settings,profiles:{current:async request=>profileFor(request),resolve:async request=>profileFor(request)},
      credentials:{resolve:async()=>key},supervisor:{close:async()=>{}},assets:{resolve:async()=>({}),status:async()=>({state:'ready'})},
      local:{stopEngine:async()=>{},close:async()=>{},prepare:async()=>({ready:true}),startCapture:async()=>{},finishCapture:async()=>({text:'Synthetic ASR'}),cancelCapture:async()=>{}},
    },
  });
  const api={action:(...args)=>{if(args[0]==='state')stateReads++;return host.action(...args);},onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  const session=ensureVoiceSession(api,{captureOptions:{workletURL:'unused-fixture-worklet'}});
  const dispose=session.retain();
  t.after(async()=>{fetchReply.resolve();await dispose();await host.close();await rm(dataRoot,{recursive:true,force:true});});
  await session.refresh();
  return {host,events,audit,session,deliveries,submit,fetchEntered,fetchReply,attempts:()=>attempts,stateReads:()=>stateReads};
}

async function until(check){
  for(let i=0;i<200;i++){if(await check())return;await pause(5);}
  assert.fail('Voice operation did not settle');
}

test('Live MiniMax failure reaches the real Galgame controls and silences queued replies across chat and card tables',async t=>{
  setLocale('en');
  t.after(()=>setLocale('zh-CN'));
  const f=await hostFixture(t,1004);
  const {host,session}=f;
  assert.equal(session.snapshot().state.cloudSpeech.state,'ready');
  const capture=await host.controller.action('capture-start',{mode:'live'});
  const submission=host.controller.action('capture-finish',{id:capture.id});
  await f.submit.promise;
  const reply={...chatScope,requestId:'live-reply',messageId:'live-message'};
  const permit=await host.controller.admit(reply,capture.id);
  await submission;
  assert.ok(permit);
  let presentation;
  t.after(session.output.subscribe(chatScope,value=>{presentation=value;}));
  await host.controller.segment({envelope:resolveEvent(reply,permit,0),text:'First spoken segment.'});
  await f.fetchEntered.promise;
  await host.controller.segment({envelope:resolveEvent(reply,permit,1),text:'Already queued segment.'});
  await host.controller.finish({requestId:reply.requestId});
  const firstCard={eventId:'after-live',kind:'table-chat',text:'Card text stays visible.',scope:cardScope};
  await host.cardEvent(firstCard);
  f.fetchReply.resolve();
  await until(()=>f.events.some(row=>row.type==='segment'&&row.state==='failed'));
  await until(()=>f.events.some(row=>row.type==='turn'&&row.state==='skipped'&&row.requestId==='card:after-live'));
  await Promise.all(f.deliveries);
  await session.refresh();
  assert.equal(session.snapshot().state.live,false);
  const state=session.snapshot().state;
  assert.equal(state.cloudSpeech.state,'key-invalid');
  assert.equal(state.cloudSpeech.providerCode,1004);
  const render=(placement,replyId)=>renderToStaticMarkup(React.createElement(VoiceChatControls,{
    snapshot:session.snapshot(),scope:chatScope,placement,presentation,reply:{replyId,characterId:chatScope.characterId},open:true,galgame:true,
  }));
  assert.match(render('top',reply.requestId),/Invalid Key[\s\S]*Re-enter it in cloud voice settings/);
  assert.match(render('stage-alerts',reply.requestId),/The MiniMax API key is invalid/);
  assert.doesNotMatch(render('stage-alerts',reply.requestId),/Speech failed/);
  assert.equal(await host.controller.admit({...reply,requestId:'text-reply'}),null);
  assert.equal(f.events.filter(row=>row.type==='segment'&&row.state==='failed').length,1);
  assert.equal(f.attempts(),1);
  assert.equal(render('alerts','text-reply'),'');
  const display=renderToStaticMarkup(React.createElement(VoiceDialogueLine,{presentation,requestId:'text-reply'},'Later reply remains visible.'));
  assert.match(display,/Later reply remains visible/);
  const {records}=await host.cardPresentation({tableId:'table',handId:'hand',eventIds:[firstCard.eventId]});
  assert.deepEqual(records.map(row=>row.state),['fallback']);
  assert.deepEqual(f.audit.filter(row=>row.type==='minimax-speech-failed'),[{type:'minimax-speech-failed',category:'auth',code:1004}]);
  assert.equal(f.audit.some(row=>row.type==='voice-phase'&&row.stage==='error'),false);
});

test('a real card request reports one balance reason and lets later card text fall back quietly',async t=>{
  const {host,events,...f}=await hostFixture(t,1008);
  await host.cardEvent({eventId:'first-card',kind:'table-chat',text:'First card line',scope:cardScope});
  await f.fetchEntered.promise;
  await host.cardEvent({eventId:'later-card',kind:'trips',scope:cardScope});
  f.fetchReply.resolve();
  await until(()=>events.some(row=>row.type==='turn'&&row.state==='skipped'&&row.requestId==='card:later-card'));
  const failures=events.filter(row=>row.type==='segment'&&row.state==='failed');
  assert.deepEqual(failures.map(row=>[row.requestId,row.code,row.providerCode]),[['card:first-card','CLOUD_MINIMAX_BALANCE',1008]]);
  assert.match(failures[0].message,/余额或点数不足/);
  assert.equal(f.attempts(),1);
  assert.deepEqual((await host.cardPresentation({tableId:'table',handId:'hand',eventIds:['first-card','later-card']})).records.map(row=>row.state),['fallback','fallback']);
  assert.equal((await host.action('state')).cloudSpeech.state,'unavailable');
});


test('Live reopens at the account cooldown deadline without a synthesis request',async t=>{
  const started=1000000;
  let clock=started,expiry,schedules=0;
  const defer=globalThis.setTimeout;
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(globalThis,'setTimeout',(fn,delay,...args)=>{
    if(delay===300000){
      schedules++;
      expiry=()=>fn(...args);
      return undefined;
    }
    return defer(fn,delay,...args);
  });
  const f=await hostFixture(t,1004);
  const {host,session}=f;
  const render=()=>renderToStaticMarkup(React.createElement(VoiceChatControls,{
    snapshot:session.snapshot(),scope:chatScope,placement:'input-right',
  }));
  const reply={...chatScope,requestId:'cooldown-reply',messageId:'cooldown-message'};
  const permit=await host.controller.admit(reply);
  assert.ok(permit);
  await host.controller.segment({envelope:resolveEvent(reply,permit,0),text:'First synthetic reply.'});
  await f.fetchEntered.promise;
  await host.controller.finish({requestId:reply.requestId});
  f.fetchReply.resolve();
  await until(()=>session.snapshot().state.cloudSpeech.state==='key-invalid');
  assert.match(render(),/disabled/);
  const firstEvent=f.events.findLast(row=>row.type==='cloud-speech-status');
  assert.equal(firstEvent.status.retryAt,started+300000);
  await session.refresh();
  assert.equal(session.snapshot().state.cloudSpeech.retryAt,started+300000);
  assert.equal(schedules,1,'refresh of the same cooldown does not schedule another timer');
  clock+=299999;
  assert.match(render(),/disabled/);
  assert.equal(f.attempts(),1);
  clock++;
  const priorStateReads=f.stateReads();
  expiry();
  await until(()=>session.snapshot().state.cloudSpeech.state==='ready');
  assert.doesNotMatch(render(),/disabled/);
  assert.equal(f.stateReads(),priorStateReads+1);
  assert.equal(f.attempts(),1,'expiry only rechecks the host binding');
});

test('cloud voice settings localize unknown provider and HTTP codes before interpolating the number',t=>{
  setLocale('en');
  t.after(()=>setLocale('zh-CN'));
  const render=cloud=>renderToStaticMarkup(React.createElement(CloudVoiceSettings,{
    snapshot:{state:{selectedPackageId:packageId,cloud}},
  }));
  const provider=render({state:'unavailable',category:'unknown',code:'CLOUD_MINIMAX_UNKNOWN',providerCode:729531,
    message:'MiniMax 云配音暂不可用（错误码 729531），请稍后重试'});
  const http=render({state:'unavailable',category:'http',code:'CLOUD_MINIMAX_HTTP',httpStatus:404,
    message:'MiniMax 云配音暂不可用（HTTP 404），请稍后重试'});
  assert.match(provider,/temporarily unavailable \(error code 729531\)/);
  assert.match(http,/temporarily unavailable \(HTTP 404\)/);
});
