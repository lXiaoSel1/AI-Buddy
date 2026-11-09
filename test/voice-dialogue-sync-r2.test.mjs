import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {CompanionGroupDialogue} from '../src/companion-ui.mjs';
import {ensureVoiceOutput,VoiceDialogueLine} from '../src/voice/client.mjs';
import {setTimeout as pause} from 'node:timers/promises';

setLocale('zh-CN');
const scope={channel:'app-group',characterId:'claude',personaId:'default',conversationId:'group'};
const envelope={...scope,requestId:'held-tts',segmentId:'held-tts:voice:0',index:0};
const groupState=text=>({
  characters:[{id:'claude',name:'Claude'},{id:'deepseek',name:'DeepSeek'}],
  personas:[{id:'default',nickname:'User'}],activeGroupId:'group',
  groups:[{id:'group',name:'Group',personaId:'default',memberIds:['claude','deepseek'],mutedIds:[]}],
  settings:{},groupMessages:[],groupRuntime:{mode:'list',queue:['claude'],status:'generating',streaming:{requestId:envelope.requestId,characterId:'claude',characterName:'Claude',text}},
});

test('private dialogue and the next group segment follow the same audio clock without hiding saved text',async()=>{
  const listeners=new Set(),contexts=[];
  const api={action:async()=>({accepted:true}),onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const createContext=({sampleRate})=>{const context={sampleRate,currentTime:0,state:'running',destination:{},resume:async()=>{},close:async()=>{},createGain:()=>({gain:{value:1},connect(){},disconnect(){}}),createBuffer:(_,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),createBufferSource:()=>({connect(){},disconnect(){},start(){},stop(){}})};contexts.push(context);return context;};
  const privateScope={...scope,channel:'app-private'},first={...envelope,...privateScope},second={...first,index:1,segmentId:'held-tts:voice:1'};
  const output=ensureVoiceOutput(api,{createContext}),release=output.retain();let presentation;
  const off=output.subscribe(privateScope,value=>{presentation=value;});
  const emit=event=>Promise.all([...listeners].map(listener=>listener(event)));
  const line=requestId=>renderToStaticMarkup(React.createElement(VoiceDialogueLine,{presentation,requestId,className:'whg-line-now'},'FULL_GENERATED_TEXT'));
  const pcm=new Uint8Array(4800);for(let i=1;i<pcm.length;i+=2)pcm[i]=16;
  try{
    await emit({type:'turn',state:'admitted',requestId:first.requestId,envelope:first});
    assert.doesNotMatch(line(first.requestId),/FULL_GENERATED_TEXT/);
    for(const [token,text] of [[first,'FIRST_SEGMENT'],[second,'FUTURE_SEGMENT']])await emit({type:'segment',state:'queued',envelope:token,text,speech_text:text});
    await emit({type:'audio',phase:'pcm',envelope:first,pcm,sampleRate:24000});await emit({type:'audio',phase:'end',envelope:first});
    contexts[0].currentTime=.31;await pause(75);
    assert.match(line(first.requestId),/FIRST_SEGMENT/);assert.doesNotMatch(line(first.requestId),/FUTURE_SEGMENT|FULL_GENERATED_TEXT/);
    await emit({type:'audio',phase:'pcm',envelope:second,pcm,sampleRate:24000});await emit({type:'audio',phase:'end',envelope:second});
    assert.doesNotMatch(line(first.requestId),/FUTURE_SEGMENT/);
    contexts[0].currentTime=.49;await pause(75);
    assert.match(line(first.requestId),/FUTURE_SEGMENT/);assert.doesNotMatch(line(first.requestId),/FIRST_SEGMENT/);
    assert.match(line('saved-request'),/FULL_GENERATED_TEXT/);
    await emit({type:'segment',state:'failed',envelope:second,message:'controlled provider failure'});
    assert.match(line(first.requestId),/FULL_GENERATED_TEXT/);
  }finally{off();await release();}
});
const body=(state,presentation)=>{
  const html=renderToStaticMarkup(React.createElement(CompanionGroupDialogue,{state,request:async()=>({ok:true}),onManage(){},chat:{enabled:true},voicePresentation:presentation,voiceSubtitle:presentation?.subtitle}));
  return html.match(/<div class="whg-line-now(?: narrator)?"[^>]*>([\s\S]*?)<\/div>/)?.[1];
};

test('a voice-admitted group segment stays hidden until its audio starts',async()=>{
  const listeners=new Set();
  const api={action:async()=>({accepted:true}),onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const output=ensureVoiceOutput(api,{createContext:()=>{throw Error('No PCM was received');}}),release=output.retain();
  let presentation;
  const off=output.subscribe(scope,value=>{presentation=value;});
  try{
    for(const event of [{type:'segment',state:'queued',envelope,text:'VOICE_SYNC_FUTURE_TEXT',speech_text:'VOICE_SYNC_FUTURE_TEXT'},{type:'audio',phase:'start',envelope,sampleRate:24000}])await Promise.all([...listeners].map(listener=>listener(event)));
    assert.equal(presentation.speaking,true);
    assert.equal(presentation.subtitle,null);
    assert.doesNotMatch(body(groupState('VOICE_SYNC_FUTURE_TEXT'),presentation),/VOICE_SYNC_FUTURE_TEXT/);
    assert.match(body(groupState('VOICE_SYNC_FUTURE_TEXT'),presentation),/正在准备配音/);
  }finally{off();await release();}
});

test('a silent admitted chat retires its FIFO slot so queued card audio can play',async()=>{
  const listeners=new Set();let started=0,stopped=0;
  const api={action:async()=>({accepted:true}),onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const output=ensureVoiceOutput(api,{createContext:({sampleRate})=>({sampleRate,currentTime:0,state:'running',destination:{},resume:async()=>{},close:async()=>{},createGain:()=>({gain:{value:1},connect(){},disconnect(){}}),createBuffer:(_,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),createBufferSource:()=>({connect(){},disconnect(){},start(){started++;},stop(){stopped++;}})})}),release=output.retain();
  const emit=event=>Promise.all([...listeners].map(listener=>listener(event)));
  const chat={...envelope,channel:'app-private',requestId:'silent-chat'},card={channel:'card-table',requestId:'card-turn',segmentId:'card-turn:voice:0',index:0};
  try{
    await emit({type:'turn',state:'admitted',requestId:chat.requestId,envelope:chat});
    await emit({type:'segment',state:'queued',envelope:card,text:'CARD_TEXT',speech_text:'CARD_TEXT'});
    await emit({type:'audio',phase:'pcm',envelope:card,pcm:new Uint8Array([0,16,0,16]),sampleRate:24000});
    assert.equal(started,0);
    await emit({type:'turn',state:'generated',requestId:chat.requestId});
    await pause(5);
    assert.equal(started,1,'card playback must advance after the preceding silent turn finishes');
    const later={...chat,requestId:'later-silent-chat'};
    await emit({type:'turn',state:'admitted',requestId:later.requestId,envelope:later});
    await emit({type:'turn',state:'generated',requestId:later.requestId});
    assert.equal(stopped,0,'retiring another silent turn must preserve active card playback');
  }finally{await release();}
});
