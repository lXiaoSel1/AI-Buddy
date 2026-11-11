import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as voice from '../src/voice/client.mjs';
import {createVoiceController} from '../src/voice/controller.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';

const scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c'};
const configuration={settings:{enabled:true,packages:{'ai-buddy.voice-breeze':{ttsProvider:'local'}}},selectedPackageId:'ai-buddy.voice-breeze',preparation:{state:'ready',target:'speech'},scope,packages:[{id:'ai-buddy.voice-breeze',installed:true,usable:true}],profile:{label:'Voice'},assets:{tts:{state:'ready'}},engine:'breeze'};
const snapshot={state:configuration,captureState:'idle',working:false,error:''};

test('Galgame retains Live while the approved voice page owns engine and reference configuration',()=>{
  const chat=renderToStaticMarkup(React.createElement(voice.VoiceChatControls,{snapshot,scope}));
  assert.equal((chat.match(/<button\b/g)??[]).length,2);
  assert.match(chat,/aria-label="语音总开关"/);
  assert.match(chat,/aria-label="Live 轮流交谈"/);
  assert.match(chat,/开启 Live/);
  assert.doesNotMatch(chat,/录音输入|<select|API Key/);
  const settings=renderToStaticMarkup(React.createElement(voice.VoiceSettingsPanel,{snapshot}));
  assert.doesNotMatch(settings,/<button\b[^>]*>Live 轮流交谈<\/button>/);
  assert.doesNotMatch(settings,/录音输入/);assert.match(settings,/在哪里配音/);
  assert.match(settings,/停止并释放/);
  assert.match(settings,/语音插件/);
  assert.match(settings,/换成我的录音/);
});

const renderLive=(value=snapshot,expected=scope)=>renderToStaticMarkup(React.createElement(voice.VoiceChatControls,{snapshot:value,scope:expected})).match(/<button\b[^>]*data-voice-live="true"[^>]*>[\s\S]*?<\/button>/)?.[0];

test('Live start is available only for enabled usable voice in the current trusted private or group chat',()=>{
  assert.doesNotMatch(renderLive(),/disabled/);
  for(const changed of [null,{...scope,characterId:'other'},{...scope,personaId:'other'},{...scope,conversationId:'other'},{...scope,channel:'card-table'}]){
    assert.match(renderLive({...snapshot,state:{...configuration,scope:changed}}),/disabled/);
  }
  for(const changed of [
    {...configuration,settings:{...configuration.settings,enabled:false}},
    {...configuration,packages:[{id:configuration.selectedPackageId,installed:false,usable:true}]},
    {...configuration,packages:[{id:configuration.selectedPackageId,installed:true,usable:false}]},
    {...configuration,packages:[{id:configuration.selectedPackageId,installed:true,usable:true,enabled:false}]},
    {...configuration,packages:[{id:configuration.selectedPackageId,installed:true,usable:true,trusted:false}]}
  ])assert.match(renderLive({...snapshot,state:changed}),/disabled/);
  assert.match(renderLive({...snapshot,working:true}),/disabled/);
  const group={channel:'app-group',characterId:'deepseek',personaId:'p',conversationId:'g'};
  assert.doesNotMatch(renderLive({...snapshot,state:{...configuration,scope:{...group,characterId:'group-member'}}},group),/disabled/);
  const card={...scope,channel:'card-table'};
  assert.match(renderLive({...snapshot,state:{...configuration,scope:card}},card),/disabled/);
});

test('Live remains visible and cancellable while initializing, while settings recording does not appear as Live',()=>{
  const initializing=renderLive({...snapshot,state:{...configuration,preparation:{state:'loading',target:'live'}},captureState:'preparing',working:true});
  assert.match(initializing,/取消 Live · 初始化中…/);
  assert.match(initializing,/aria-checked="false"/);
  assert.match(initializing,/aria-busy="true"/);
  assert.doesNotMatch(initializing,/disabled/);
  const waitingForMicrophone=renderLive({...snapshot,state:{...configuration,live:true,capture:{id:'live-capture',mode:'live'}},captureState:'preparing',working:true});
  assert.match(waitingForMicrophone,/取消 Live · 初始化中…/);
  assert.match(waitingForMicrophone,/aria-checked="false"/);
  const listening=renderLive({...snapshot,state:{...configuration,live:true},captureState:'listening'});
  assert.match(listening,/停止 Live/);
  assert.match(listening,/aria-checked="true"/);
  assert.doesNotMatch(listening,/disabled/);
  const recording=renderLive({...snapshot,state:{...configuration,preparation:{state:'ready',target:'live'},capture:{id:'record-capture',mode:'record'}},captureState:'processing',working:true});
  assert.match(recording,/开启 Live/);
  assert.match(recording,/disabled/);
  assert.doesNotMatch(recording,/取消 Live|停止 Live/);
});

test('Galgame Live stop is limited to normal chat while General Settings retains global release',async()=>{
  const calls=[],api={action:async(op,args)=>{calls.push({op,args});return op==='state'?configuration:{accepted:true};},onEvent:()=>()=>{}};
  const session=voice.ensureVoiceSession(api,{captureOptions:{workletURL:'fixture'}}),release=session.retain();
  try{
    await session.refresh();
    await session.stopChat();
    assert.deepEqual(calls.filter(row=>row.op==='stop'),[{op:'stop',args:{channel:'app-chat'}}]);
    await session.stop();
    assert.deepEqual(calls.filter(row=>row.op==='stop').at(-1),{op:'stop',args:undefined});
  }finally{await release();}
});

function pendingCaptureFixture(){
  let completeCapture,enteredCapture;
  const captureGate=new Promise(resolve=>{completeCapture=resolve;}),entered=new Promise(resolve=>{enteredCapture=resolve;}),calls=[];
  const state={...configuration,preparation:{state:'ready',target:'live'},live:false,capture:null};
  const api={action:async(op,args)=>{
    calls.push({op,args});
    if(op==='state')return state;
    if(op==='capture-start'){enteredCapture();await captureGate;return {id:'pending-capture',mode:args.mode};}
    return {accepted:true};
  },onEvent:()=>()=>{}};
  const session=voice.ensureVoiceSession(api,{createContext:({sampleRate})=>({sampleRate,state:'running',resume:async()=>{},close:async()=>{}}),captureOptions:{workletURL:'fixture',getMedia:async()=>{throw Error('cancelled capture must not open the microphone');}}}),release=session.retain();
  return {api,session,release,calls,entered,completeCapture};
}

test('a remounted Galgame can cancel pending Live without treating settings recording as Live',async()=>{
  for(const mode of ['live','record']){
    const f=pendingCaptureFixture();let started;
    try{
      await f.session.refresh();
      const off=f.session.subscribe(()=>{});
      started=f.session.start(mode);
      await f.entered;
      off();
      const reopened=voice.ensureVoiceSession(f.api);
      assert.equal(reopened,f.session);
      const remounted=renderLive(reopened.snapshot());
      if(mode==='live'){
        assert.match(remounted,/取消 Live · 初始化中…/);
        assert.doesNotMatch(remounted,/disabled/);
        assert.equal(reopened.snapshot().captureMode,'live');
      }else{
        assert.match(remounted,/开启 Live/);
        assert.match(remounted,/disabled/);
        assert.equal(reopened.snapshot().captureMode,'record');
      }
      await reopened.stopChat();
      assert.equal(reopened.snapshot().captureMode,null);
    }finally{await f.session.stopChat();f.completeCapture();await started;await f.release();}
  }
});

test('a Live capture acknowledgement arriving after cancellation cannot issue a global stop',async()=>{
  const f=pendingCaptureFixture();let started;
  try{
    await f.session.refresh();
    started=f.session.start('live');
    await f.entered;
    await f.session.stopChat();
    f.completeCapture();await started;
    const stops=f.calls.filter(row=>row.op==='stop');
    assert.ok(stops.length>0);
    assert.ok(stops.every(row=>row.args?.channel==='app-chat'),JSON.stringify(stops));
  }finally{await f.session.stopChat();f.completeCapture();await started;await f.release();}
});

test('Live shows only the current capture transcript when the next listening turn starts',async()=>{
  let receive;
  const api={
    async action(op){if(op==='state')return configuration;if(op==='capture-start')return {id:'first',mode:'live'};return {ready:true};},
    onEvent(listener){receive=listener;return()=>{};},
  };
  const connect=()=>({connect(){},disconnect(){}}),track={stop(){}},port={postMessage(){}};
  const context={state:'running',sampleRate:16000,resume:async()=>{},close:async()=>{},audioWorklet:{addModule:async()=>{}},
    createMediaStreamSource:connect,createGain:()=>({...connect(),gain:{value:0}}),destination:{}};
  const session=voice.ensureVoiceSession(api,{createContext:({sampleRate})=>({...context,sampleRate}),
    captureOptions:{workletURL:'fixture',getMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]}),
      makeContext:()=>context,makeNode:()=>({...connect(),port})}});
  const release=session.retain();
  const markup=()=>renderToStaticMarkup(React.createElement(voice.VoiceChatControls,{snapshot:session.snapshot(),scope,placement:'replacement'}));
  const capture=(id,state,partial)=>receive({type:'capture',mode:'live',id,state,partial});
  try{
    await session.refresh();await session.start('live');
    await capture('first','listening','上一轮字幕');
    assert.match(markup(),/上一轮字幕/);
    await capture('first','processing');
    assert.match(markup(),/上一轮字幕/);
    await capture('first','waiting-playback');
    await capture('second','listening');
    assert.match(markup(),/正在听，你说吧/);
    assert.doesNotMatch(markup(),/上一轮字幕/);
    await capture('first','listening','迟到的字幕');
    assert.doesNotMatch(markup(),/迟到的字幕/);
    await capture('second','listening','当前轮字幕');
    assert.match(markup(),/当前轮字幕/);
  }finally{await release();}
});

test('Galgame recording shows preparation before recording and transcribing after Done',()=>{
  const render=captureState=>renderToStaticMarkup(React.createElement(voice.VoiceChatControls,{
    snapshot:{...snapshot,captureState,captureMode:'record'},scope,placement:'replacement',
  }));
  const preparing=render('preparing');
  assert.match(preparing,/准备中/);
  assert.doesNotMatch(preparing,/识别中/);
  assert.match(preparing,/<button\b[^>]*disabled[^>]*>[\s\S]*?说完了<\/button>/);
  assert.match(preparing,/<button\b(?:(?!disabled)[^>])*>取消<\/button>/);
  assert.match(render('recording'),/录音中/);
  assert.match(render('processing'),/识别中/);
});

test('ending Live releases the input while ASR stops and ignores the cancelled microphone feed',async()=>{
  const feed=Promise.withResolvers(),feedStarted=Promise.withResolvers(),cleanup=Promise.withResolvers();
  const profilesReading=Promise.withResolvers(),profilesReply=Promise.withResolvers();
  const settings=createVoiceSettings();
  await settings.update({enabled:true});
  const listeners=new Set(),port={postMessage(){}};
  let microphoneStopped=false,stopCalls=0,submissions=0;
  const controller=createVoiceController({
    getScope:()=>({...scope,lifeId:'life',operationId:'operation'}),
    settings,listPackages:()=>[{...configuration.packages[0],enabled:true,engine:'breeze'}],
    assets:{resolve:async()=>({}),status:async()=>({state:'ready'})},
    runtime:{
      startCapture:async()=>{},
      feedCapture(){feedStarted.resolve();return feed.promise;},
      async cancelCapture(){if(port.onmessage)feed.reject(new DOMException('Aborted','AbortError'));await cleanup.promise;},
      stopEngine:async()=>{},
    },
    send:event=>{for(const listener of listeners)listener(event);},
    submit:async()=>{submissions++;return {requestId:'unexpected'};},
  });
  const api={
    async action(op,payload){
      if(op==='prepare')return {ready:true};
      if(op==='stop'){
        stopCalls++;
        await controller.recoverStop();
      }
      if(op==='profiles'&&stopCalls){
        profilesReading.resolve();
        return profilesReply.promise;
      }
      return controller.action(op,payload);
    },
    onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  };
  const connect=()=>({connect(){},disconnect(){}});
  const track={stop(){microphoneStopped=true;}};
  const context={state:'running',sampleRate:16000,resume:async()=>{},close:async()=>{},audioWorklet:{addModule:async()=>{}},
    createMediaStreamSource:connect,createGain:()=>({...connect(),gain:{value:0}}),destination:{}};
  const session=voice.ensureVoiceSession(api,{
    createContext:({sampleRate})=>({...context,sampleRate}),
    captureOptions:{workletURL:'fixture',getMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]}),
      makeContext:()=>context,makeNode:()=>({...connect(),port})},
  });
  const release=session.retain();
  const liveStrip=()=>renderToStaticMarkup(React.createElement(voice.VoiceChatControls,{
    snapshot:session.snapshot(),scope,placement:'replacement',
  }));
  let stopping,stopComplete=false;
  try{
    await session.refresh();
    await session.start('live');
    assert.match(liveStrip(),/正在听/);
    port.onmessage({data:new ArrayBuffer(320)});
    await feedStarted.promise;
    stopping=session.stopChat().then(()=>{stopComplete=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(microphoneStopped,true);
    assert.equal(liveStrip(),'');
    assert.match(renderLive(session.snapshot()),/正在停止 Live/);
    assert.equal(stopCalls,1);
    cleanup.resolve();
    await profilesReading.promise;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(stopComplete,true,'a slow voice profile read must not hold the Live stop open');
    await stopping;
    assert.equal(liveStrip(),'');
    assert.equal(session.snapshot().state.live,false);
    assert.equal(session.snapshot().state.settings.enabled,true);
    assert.equal(session.snapshot().error,'');
    assert.equal(submissions,0);
  }finally{
    cleanup.resolve();
    profilesReply.resolve([]);
    await stopping;
    await release();
    await controller.close();
  }
});
