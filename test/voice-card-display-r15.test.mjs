import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {ensureVoiceOutput} from '../src/voice/client.mjs';
import {createCardGamesApp} from '../../repair-suite-r3/cards-source/plugins/card-games/src/client/app.mjs';
import {renderCardGames} from '../../repair-suite-r3/cards-source/plugins/card-games/src/client/render.mjs';

const scope={channel:'card-table',tableId:'r15-table',handId:'r15-hand',characterId:'whale',personaId:'persona',lifeId:'life',operationId:'operation',conversationId:'r15-table'};
async function until(check,limit=2500){const at=performance.now();while(!check()){if(performance.now()-at>limit)throw Error('R15 isolated seam did not settle');await delay(5);}}

// Executes the real App hooks and renderer. No browser, physical paint, device,
// network, model, or GPU is used by this deterministic adapter.
function hooks(){
 const slots=[],effects=[];let cursor=0,pending=false,closed=false,Component,props;
 const rerender=()=>{if(pending||closed)return;pending=true;queueMicrotask(()=>{pending=false;run();});};
 const api={...React,
  useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,value=>{const next=typeof value==='function'?value(slots[i].value):value;if(!Object.is(next,slots[i].value)){slots[i].value=next;rerender();}}];},
  useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useEffect(fn,deps){const i=cursor++,prior=slots[i];if(!prior||!deps||deps.some((v,n)=>!Object.is(v,prior.deps?.[n]))){slots[i]={deps,cleanup:prior?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}}
 };
 function run(){cursor=0;Component();for(const effect of effects.splice(0))effect();}
 return {React:api,mount(component){Component=component;run();},capture(value){props=value;},get props(){return props;},close(){closed=true;for(const slot of slots)slot?.cleanup?.();}};
}

async function fixture(t,{cold=120,legacy=false,fail=false,readFailure=false,readDelay=3,readNever=false,deadlineMs=15000}={}){
 const trace=[],listeners=new Set(),timers=new Set(),h=hooks();let voiceHost,currentId,first=true,reads=0,inflight=0,maxInflight=0,chat=[];
 const mark=(kind,id)=>trace.push({kind,id,at:performance.now()});
 const deadlineAt=Date.now()+deadlineMs;
 const records=new Set();
 const projection=async()=>{const {available,...value}=await voiceHost.cardPresentation({tableId:scope.tableId,handId:scope.handId,eventIds:[...records]});return value;};
 const api={onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},async action(op,payload){if(op==='receipt')mark(payload.status,payload.envelope.messageId);return voiceHost.action(op,payload);}};
 const createContext=({sampleRate})=>{
  const origin=performance.now();return {sampleRate,state:'running',destination:{},get currentTime(){return (performance.now()-origin)/1000;},async resume(){},async close(){this.state='closed';},
   createGain:()=>({gain:{value:1},connect(){},disconnect(){}}),createBuffer:(_channels,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),
   createBufferSource(){const context=this;let timer;return {connect(){},disconnect(){},stop(){clearTimeout(timer);},start(at){const id=currentId;timer=setTimeout(()=>{timers.delete(timer);mark('first-frame',id);this.onended?.();},Math.max(0,(at-context.currentTime)*1000));timers.add(timer);}};}
  };
 };
 const output=ensureVoiceOutput(api,{createContext}),release=output.retain();
 const settings=createVoiceSettings();await settings.update({enabled:true});
 const runtime={channel(){return this;},async *speak(){const id=currentId,wait=first?cold:0;first=false;await delay(wait);if(fail)throw Object.assign(Error('Synthetic failure'),{code:'R15_TEST_FAILURE'});mark('pcm',id);yield {type:'pcm',pcm:new Uint8Array(Array.from({length:4800},(_,i)=>i%2?10:30)),sampleRate:24000};},async cancelCurrent(){},async stopEngine(){},async close(){}};
 voiceHost=createVoiceHost({dataRoot:undefined,build:'unused',getGame:()=>({voiceScope:()=>null,voiceCancel(){},voiceSubmit(){throw Error('R15 forbids model calls');}}),getPlatform:()=>({voicePackageStatus:()=>[{id:'ai-buddy.voice-breeze',installed:true,enabled:true,usable:true,trusted:true}],resolveVoicePackage:async()=>({assertCurrent(){}}),cardGames:{voiceScopeValid:()=>true}}),send:event=>{for(const listener of listeners)listener(event);},components:{settings,runtime,profiles:{async current({characterId,engine}){return {id:'test-profile',version:1,characterId,engine};}},assets:{},credentials:{},local:{},cloud:{},supervisor:{async close(){}},controller:{async close(){},async invalidate(){},async recoverStop(){}}}});
 let table={tableId:scope.tableId,type:'texas',status:'active',version:1,userSeatId:'user',currentCharacterId:'whale',actorKind:'user',presentation:{events:[],emotions:{},lastSpeech:null},projection:{type:'texas',phase:'preflop',handId:scope.handId,version:1,actorId:'user',players:[{id:'user',kind:'user',name:'User',stack:100},{id:'ai',kind:'ai',characterId:'whale',name:'Whale',stack:100}],board:[],ownHand:[],legalActions:[],pot:0,history:[]}};
 const withVoice=async value=>legacy?value:{...value,presentation:{...value.presentation,voice:await projection()}};
 const client={async readiness(){return {mode:'runtime',cardAudioVolume:true};},async invoke(method,payload){
  if(method==='games.table.read'&&payload.voiceOnly){reads++;inflight++;maxInflight=Math.max(maxInflight,inflight);try{if(readNever)await new Promise(()=>{});await delay(readDelay);if(readFailure)throw Error('Synthetic read failure');return {tableId:scope.tableId,handId:scope.handId,presentation:{voice:await projection()}};}finally{inflight--;}}
  if(method==='games.table.read')return payload.tableId?structuredClone(payload.tableId===scope.tableId?await withVoice(table):{...table,tableId:payload.tableId,presentation:{events:[],emotions:{},lastSpeech:null},projection:{...table.projection,handId:'other-hand'}}):{tables:[],charactersAvailable:[]};
  if(method==='games.chat.read')return withVoice({messages:structuredClone(chat)});
  if(method==='audio.settings')return {settings:{muted:true,music:0,sfx:0,voice:1}};
  if(method==='games.table.art')return {};
  if(method==='games.chat.send')return withVoice({inputAccepted:true,messages:structuredClone(chat),assistant:{status:'completed',characterId:'whale',requestId:currentId,text:'Synthetic '+currentId}});
  throw Error('Unexpected R15 stub call: '+method);
 }};
 const seen=new Set(),messageSeen=new Set();
 const App=createCardGamesApp(h.React,{client,render(_React,props){h.capture(props);if(props.speech?.id&&!seen.has(props.speech.id)){assert.ok(renderToStaticMarkup(renderCardGames(React,props)).includes(props.speech.text));seen.add(props.speech.id);mark('bubble',props.speech.id);}for(const message of props.messages)if(message.role==='assistant'&&!messageSeen.has(message.id)){messageSeen.add(message.id);mark('assistant',message.id);}return null;}});
 h.mount(App);await until(()=>h.props?.ready);await h.props.openSaved(scope.tableId);await delay(10);
 t.after(async()=>{h.close();await release();await voiceHost.close();for(const timer of timers)clearTimeout(timer);});
 return {h,trace,get reads(){return reads;},get maxInflight(){return maxInflight;},async line(id,{kind='lastSpeech',audio=true}={}){currentId=id;if(audio){records.add(id);await voiceHost.cardEvent({eventId:id,kind,text:'Synthetic '+id,scope,deadlineAt});}if(kind==='lastSpeech'){table={...table,version:table.version+1,presentation:{...table.presentation,lastSpeech:{id,actorId:'ai',text:'Synthetic '+id}}};await h.props.refresh(scope.tableId);}else{chat=[...chat,{id,role:'assistant',text:'Synthetic '+id,characterId:'whale'}];h.props.setText('Synthetic input');await delay(0);await h.props.submitChat();}},projection};
}

test('R15 actual App bubble and assistant message wait for authentic playback start in cold and warm lines',async t=>{
 const f=await fixture(t,{cold:1200});
 await f.line('cold');await delay(35);
 assert.equal(f.trace.some(row=>row.kind==='bubble'&&row.id==='cold'),false,'cold text must wait for audioStarted');
 await until(()=>f.trace.some(row=>row.kind==='bubble'&&row.id==='cold'));
 const timings=id=>Object.fromEntries(f.trace.filter(row=>row.id===id).map(row=>[row.kind,row.at]));
 assert.ok(timings('cold').bubble>=timings('cold').audioStarted);
 await until(()=>f.trace.some(row=>row.kind==='audioCompleted'&&row.id==='cold'));
 await f.line('warm',{kind:'table-chat'});await delay(30);
 assert.equal(f.trace.some(row=>row.id==='warm'&&['bubble','assistant'].includes(row.kind)),false);
 await until(()=>f.trace.some(row=>row.id==='warm'&&row.kind==='assistant'));
 const warm=timings('warm');assert.ok(warm.bubble>=warm.audioStarted);assert.ok(warm.assistant>=warm.audioStarted);
 assert.ok(f.maxInflight<=1);assert.ok(f.reads>0);
 console.log('R15 synthetic actual-App timings',JSON.stringify(['cold','warm'].map(id=>{const a=timings(id);return {id,synthetic:true,configuredPcmDelayMs:id==='cold'?1200:0,firstFrameMs:+a['first-frame'].toFixed(3),audioStartedMs:+a.audioStarted.toFixed(3),bubbleMs:+a.bubble.toFixed(3),textAfterFirstFrameMs:+(a.bubble-a['first-frame']).toFixed(3),textAfterAudioStartedMs:+(a.bubble-a.audioStarted).toFixed(3),assistantAfterAudioStartedMs:a.assistant?+(a.assistant-a.audioStarted).toFixed(3):null};})));
});

test('R15 failed synthesis and failed wait reads each release text once without a second speech request',async t=>{
 for(const options of [{fail:true},{readFailure:true}]){
  await t.test(options.fail?'synthesis failure':'projection read failure',async t=>{
   const f=await fixture(t,{...options,cold:120});await f.line('fallback');
   await until(()=>f.trace.some(row=>row.kind==='bubble'&&row.id==='fallback'));
   assert.equal(f.trace.filter(row=>row.kind==='bubble'&&row.id==='fallback').length,1);
   const polls=f.reads;await delay(90);assert.equal(f.reads,polls,'fallback must stop 50 ms polling');
   assert.ok(f.maxInflight<=1);
  });
 }
});

test('R15 old-host and no-audio lines display immediately without wait polling',async t=>{
 for(const legacy of [true,false])await t.test(legacy?'old host':'no audio event',async t=>{
  const f=await fixture(t,{legacy});await f.line('text-only',{audio:false});
  await until(()=>f.trace.some(row=>row.kind==='bubble'&&row.id==='text-only'));
  assert.equal(f.reads,0);
 });
});

test('R15 switching tables discards the old in-flight projection and cannot reveal the old bubble',async t=>{
 const f=await fixture(t,{cold:240,readDelay:140});await f.line('old-table');
 await until(()=>f.reads===1);await f.h.props.openSaved('other-table');
 await delay(400);
 assert.equal(f.h.props.table.tableId,'other-table');assert.equal(f.h.props.speech,null);
 assert.equal(f.trace.some(row=>row.kind==='bubble'&&row.id==='old-table'),false);
 assert.equal(f.maxInflight,1);assert.equal(f.reads,1);
});

test('R15 a never-settling wait read cannot hold text beyond its deadline or start late audio',async t=>{
 const f=await fixture(t,{cold:350,deadlineMs:150,readNever:true});await f.line('hung-read');
 await until(()=>f.reads===1);assert.equal(f.trace.some(row=>row.kind==='bubble'),false);
 await until(()=>f.trace.some(row=>row.kind==='bubble'&&row.id==='hung-read'));
 await delay(240);
 assert.equal(f.trace.some(row=>row.kind==='first-frame'&&row.id==='hung-read'),false);
 assert.equal(f.reads,1);assert.equal(f.maxInflight,1);
 assert.equal(f.trace.filter(row=>row.kind==='bubble'&&row.id==='hung-read').length,1);
});
