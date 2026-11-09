import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as voice from '../src/voice/client.mjs';

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
