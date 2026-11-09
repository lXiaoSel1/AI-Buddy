import test from 'node:test';
import assert from 'node:assert/strict';
import * as voice from '../src/voice/client.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const configuration={settings:{enabled:true,packages:{'ai-buddy.voice-breeze':{ttsProvider:'local'}}},selectedPackageId:'ai-buddy.voice-breeze',preparation:{state:'ready',target:'live'},scope:{channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c'},packages:[]};
function fixture(){
  const listeners=new Set(),calls=[];
  let stopped=false;
  const track={stop(){stopped=true;}};
  const connect=()=>({connect(){},disconnect(){}});
  const context={state:'running',sampleRate:16000,resume:async()=>{},close:async()=>{},audioWorklet:{addModule:async()=>{}},createMediaStreamSource:connect,createGain:()=>({...connect(),gain:{value:0}}),destination:{}};
  const api={action:async(op,args)=>{calls.push({op,args});if(op==='state')return configuration;if(op==='capture-start')return {id:'capture',mode:args.mode};return {accepted:true};},onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const session=()=>voice.ensureVoiceSession(api,{createContext:({sampleRate})=>({sampleRate,state:'running',resume:async()=>{},close:async()=>{}}),captureOptions:{workletURL:'fixture',getMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]}),makeContext:()=>context,makeNode:()=>({...connect(),port:{postMessage(){},onmessage:null}})}});
  return {api,session,calls,stopped:()=>stopped,emit:event=>Promise.all([...listeners].map(listener=>listener(event)))};
}

test('leaving voice settings and opening chat keeps the same active capture session',async()=>{
  const f=fixture(),session=f.session(),release=session.retain();
  try{
    await session.refresh();
    const settingsOff=session.subscribe(()=>{});
    await session.start('live');
    settingsOff();
    const chatSession=f.session(),chatOff=chatSession.subscribe(()=>{});
    assert.equal(chatSession,session);
    assert.equal(session.snapshot().captureState,'listening');
    assert.equal(f.stopped(),false);
    assert.equal(f.calls.some(row=>row.op==='stop'),false);
    chatOff();
  }finally{await session.stop();await release();}
});

test('Live stays preparing until the microphone worklet actually opens',async()=>{
  const f=fixture(),session=f.session(),release=session.retain();
  let completeWorklet;
  const worklet=new Promise(resolve=>{completeWorklet=resolve;});
  // The media API is the external boundary: delay its browser worklet, while
  // the host has already authorized capture and announced listening.
  const other={...f.api,onEvent:f.api.onEvent};
  let callback;
  const original=other.onEvent;other.onEvent=listener=>{callback=listener;return original(listener);};
  const graph={state:'running',destination:{},resume:async()=>{},close:async()=>{},audioWorklet:{addModule:()=>worklet},createMediaStreamSource:()=>({connect(){},disconnect(){}}),createGain:()=>({gain:{value:0},connect(){},disconnect(){}})};
  const captureSession=voice.ensureVoiceSession(other,{createContext:({sampleRate})=>({sampleRate,state:'running',resume:async()=>{},close:async()=>{}}),captureOptions:{workletURL:'fixture',getMedia:async()=>({getTracks:()=>[{stop(){}}],getAudioTracks:()=>[{}]}),makeContext:()=>graph,makeNode:()=>({connect(){},disconnect(){},port:{postMessage(){}}})}}),releaseCapture=captureSession.retain();
  try{
    await captureSession.refresh();
    const started=captureSession.start('live');
    for(let i=0;i<10;i++)await Promise.resolve();
    await callback({type:'capture',state:'listening',id:'capture',mode:'live'});
    assert.equal(captureSession.snapshot().captureState,'preparing');
    assert.doesNotMatch(voice.voiceStatus(captureSession.snapshot()),/Live 已开启/);
    completeWorklet();await started;
    assert.equal(captureSession.snapshot().captureState,'listening');
    assert.match(voice.voiceStatus(captureSession.snapshot()),/Live 已开启/);
  }finally{completeWorklet();await captureSession.stop();await releaseCapture();await session.stop();await release();}
});

test('the master switch remains unchanged while the approved plugin page owns voice configuration',()=>{
  const snapshot={state:{...configuration,packages:[{id:'ai-buddy.voice-breeze',installed:true,usable:true}],profile:{label:'Voice'},assets:{tts:{state:'ready'}},engine:'breeze'},captureState:'idle',working:false,error:''};
  const chat=renderToStaticMarkup(React.createElement(voice.VoiceToggle,{snapshot}));
  assert.equal((chat.match(/<button\b/g)??[]).length,1);
  assert.match(chat,/role="switch"/);
  assert.doesNotMatch(chat,/录音输入|Live 轮流交谈|<details|<select|API Key/);
  const settings=renderToStaticMarkup(React.createElement(voice.VoiceSettingsPanel,{snapshot}));
  assert.doesNotMatch(settings,/录音输入/);assert.doesNotMatch(settings,/<button\b[^>]*>Live 轮流交谈<\/button>/);assert.match(settings,/语音插件/);assert.match(settings,/换成我的录音/);
  const cold=renderToStaticMarkup(React.createElement(voice.VoiceToggle,{snapshot:{...snapshot,state:{...snapshot.state,preparation:{state:'idle',target:null}}}}));
  assert.match(cold,/启动语音/);assert.match(cold,/语音尚未启动/);assert.doesNotMatch(cold,/语音模型已就绪/);assert.match(cold,/aria-checked="false"/);
});

test('a recording made in settings is delivered once only to its matching chat scope',async()=>{
  const f=fixture(),session=f.session(),release=session.retain(),received=[];
  try{
    await session.refresh();
    const scope=configuration.scope;
    await f.emit({type:'draft',scope,text:'Recorded while chat was closed',append:true});
    assert.equal(session.snapshot().pendingDraft.text,'Recorded while chat was closed');
    const wrong=session.onDraft({...scope,characterId:'other'},event=>received.push(event));
    assert.equal(received.length,0);wrong();
    const matching=session.onDraft(scope,event=>received.push(event));
    assert.deepEqual(received.map(row=>row.text),['Recorded while chat was closed']);
    assert.equal(session.snapshot().pendingDraft,null);matching();
    const reopened=session.onDraft(scope,event=>received.push(event));reopened();
    assert.equal(received.length,1);
  }finally{await session.stop();await release();}
});

test('the last release detaches a closing session before another owner opens it',async()=>{
  const f=fixture(),first=f.session(),releaseFirst=first.retain();
  let closing,releaseNext;
  try{
    closing=releaseFirst();
    const next=f.session();
    releaseNext=next.retain();
    assert.notEqual(next,first);
    await closing;
    assert.equal(f.session(),next,'old asynchronous cleanup must not remove the replacement');
    await next.output.prepare(24000);
  }finally{await closing;await releaseNext?.();}
});

test('a pending audio gesture cannot start voice in a different chat scope',async()=>{
  for(const scenario of ['enable','live','card-invalidation']){
    const listeners=new Set(),calls=[];let state=structuredClone(configuration),resume,entered;
    const gate=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const emit=event=>Promise.all([...listeners].map(listener=>listener(event)));
    const api={action:async(op,args)=>{calls.push({op,args,scope:state.scope.characterId});if(op==='state')return state;if(op==='configure')await emit({type:'invalidate',reason:'configuration-changed'});return {accepted:true};},onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
    const session=voice.ensureVoiceSession(api,{createContext:({sampleRate})=>({sampleRate,state:'suspended',resume:()=>{entered();return gate;},close:async()=>{}}),captureOptions:{workletURL:'fixture'}}),release=session.retain();
    try{
      await session.refresh();
      const pending=scenario==='live'?session.start('live'):session.configure({enabled:true});
      await started;
      const card=scenario==='card-invalidation';
      if(!card)state={...state,scope:{...state.scope,characterId:'new-character',conversationId:'new-conversation'}};
      await emit({type:'invalidate',reason:'scope-changed',...(card?{channel:'card-table'}:{})});
      if(!card)await emit({type:'state',state});
      const boundary=calls.length;
      resume();await pending;
      const newWork=calls.slice(boundary).filter(row=>['configure','prepare','capture-start'].includes(row.op));
      if(card)assert.deepEqual(newWork.map(row=>row.op),['configure'],'card cancellation and configure invalidation must preserve the chat gesture');
      else assert.deepEqual(newWork,[],`${scenario} must not follow the old gesture into the new scope`);
    }finally{resume();await release();}
  }
});
