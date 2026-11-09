// The real React voice UI and renderer session. Only IPC, media and AudioContext are replaced.
// No network, model, microphone, user data or stored credentials are used.
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ensureVoiceSession,VoiceChatControls,VoiceSettingsPanel} from '../../src/voice/client.mjs';
import {setLocale} from '../../src/i18n.mjs';
const h=React.createElement,tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export const chatDesignScope={channel:'app-private',characterId:'deepseek',personaId:'voice-ui-fixture',conversationId:'voice-ui-chat',lifeId:'fixture-life',operationId:'fixture-operation'};
export function createVoiceDesignChatFixture(){
 const id='ai-buddy.voice-breeze',listeners=new Set(),calls=[],drafts=[],connect=()=>({connect(){},disconnect(){}});
 const held=new Map();
 let state={settings:{enabled:true,packages:{[id]:{ttsProvider:'local'},'ai-buddy.voice-gpt-sovits':{ttsProvider:'local'}}},selectedPackageId:id,preparation:{state:'ready',target:'speech'},scope:chatDesignScope,packages:[{id,installed:true,usable:true,enabled:true,trusted:true},{id:'ai-buddy.voice-gpt-sovits',installed:true,usable:true,enabled:true,trusted:true}],profile:{label:'Fixture calm voice'},assets:{asr:{state:'ready'},tts:{state:'ready'}},engine:'breeze',live:false,capture:null};
 let rejectMedia=false,mediaStops=0;const audioClock={time:0};
 const emit=event=>Promise.all([...listeners].map(fn=>fn(event)));
 const api={onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},async action(op,payload){
  calls.push({op,payload:structuredClone(payload)});
  if(held.has(op)){const gate=held.get(op);held.delete(op);gate.enter();await gate.promise;}
  if(op==='state')return structuredClone(state);
  if(op==='configure'){state={...state,selectedPackageId:payload.selectedPackageId??state.selectedPackageId,settings:{...state.settings,...payload,packages:{...state.settings.packages,...payload.packages}}};return state.settings;}
  if(op==='prepare'){state={...state,preparation:{state:'ready',target:payload.target}};return {ready:true};}
  if(op==='capture-start'){state={...state,live:payload.mode==='live',capture:{id:'fixture-capture',mode:payload.mode}};return state.capture;}
  if(op==='capture-finish'){await emit({type:'draft',scope:state.scope,text:'A real recogniser fixture draft'});state={...state,live:false,capture:null};return {accepted:true};}
  if(op==='stop'){state={...state,live:false,capture:null};return {accepted:true};}
  if(op==='profile-import')return {label:'Fixture imported recording'};
  return {accepted:true};
 }};
 const track={stop(){mediaStops++;}},media={getTracks:()=>[track],getAudioTracks:()=>[track]},context={...connect(),state:'running',sampleRate:16000,destination:{},resume:async()=>{},close:async()=>{},audioWorklet:{addModule:async()=>{}},createMediaStreamSource:connect,createGain:()=>({...connect(),gain:{value:0}})};
 let worklet;
 const session=ensureVoiceSession(api,{createContext:({sampleRate})=>({sampleRate,state:'running',get currentTime(){return audioClock.time;},destination:{},resume:async()=>{},close:async()=>{},createBuffer:(_,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),createBufferSource:()=>({...connect(),start(){},stop(){}}),createGain:()=>({...connect(),gain:{value:1}})}),captureOptions:{workletURL:'fixture',getMedia:async()=>{if(rejectMedia)throw Error('NotAllowedError: fixture microphone permission denied');return media;},makeContext:()=>context,makeNode:()=>{worklet={...connect(),port:{onmessage:null,postMessage(value){if(value.type==='flush')queueMicrotask(()=>worklet.port.onmessage?.({data:{type:'flushed'}}));}}};return worklet;}}}),release=session.retain();
 return {session,calls,drafts,api,emit,audioClock,holdNext(op){let enter,release;const entered=new Promise(resolve=>enter=resolve),promise=new Promise(resolve=>release=resolve);held.set(op,{enter,promise});return {entered,release};},get mediaStops(){return mediaStops;},denyMicrophone(value=true){rejectMedia=value;},async patch(patch){state={...state,...patch};await emit({type:'state',state:structuredClone(state)});},async dispose(){await release();}};
}
export async function mountVoiceDesignChatFixture(element,{language='zh-CN',settings=false}={}){
 setLocale(language);const fixture=createVoiceDesignChatFixture(),root=createRoot(element);await fixture.session.refresh();let draftValue='Existing typed draft';
 function Fixture(){const [snapshot,setSnapshot]=useState(fixture.session.snapshot()),[draft,setDraft]=useState(draftValue),[fromVoice,setFromVoice]=useState(false),[captureAttempt,setCaptureAttempt]=useState(null);useEffect(()=>fixture.session.subscribe(setSnapshot),[]);useEffect(()=>fixture.session.onDraft(chatDesignScope,event=>{fixture.drafts.push(event);setDraft(old=>old+'\n'+event.text);setFromVoice(true);}),[]);
  const controls=placement=>h(VoiceChatControls,{snapshot,session:fixture.session,scope:chatDesignScope,placement,captureAttempt,onCaptureAttempt:setCaptureAttempt});
  const replacing=(snapshot.captureMode==='live'&&snapshot.captureState!=='preparing'||snapshot.captureMode==='record')&&snapshot.captureState!=='idle';
  return settings?h(VoiceSettingsPanel,{snapshot,session:fixture.session}):h('div',null,controls('top'),controls('alerts'),replacing?controls('replacement'):h('div',{className:'vx-ginput'},controls('input-left'),h('textarea',{'aria-label':'Fixture message',value:draft,onChange:e=>setDraft(e.target.value)}),fromVoice&&h('small',null,'来自录音'),controls('input-right')));
 }
 root.render(h(Fixture));for(let i=0;i<4;i++)await tick();return {...fixture,get mediaStops(){return fixture.mediaStops;},async dispose(){root.unmount();await fixture.dispose();}};
}
export async function verifyVoiceDesignChatFixture(element){
 const checks=[],check=(value,message)=>{if(!value)throw Error(message);checks.push(message);},wait=async()=>{for(let i=0;i<6;i++)await tick();};
 let fixture=await mountVoiceDesignChatFixture(element);
 const click=async selector=>{const node=element.querySelector(selector);check(node,'control exists: '+selector);node.click();await wait();};
 try{
  await click('.vx-mic');check(element.querySelector('[data-voice-recording]'),'recording replaces input');
  await click('.vx-recrow .ghost');check(element.querySelector('textarea').value==='Existing typed draft','cancel preserves typed text');check(fixture.mediaStops>0,'cancel releases microphone');
  await click('.vx-mic');await click('.vx-recrow .primary');
  check(element.querySelector('textarea').value==='Existing typed draft\nA real recogniser fixture draft','recording appends to editable draft');
  check(!fixture.calls.some(row=>/chat-send|group-send/.test(row.op)),'recording never auto-sends');
  await click('[data-voice-live]');check(element.querySelector('[data-voice-live-phase="you"]'),'Live starts listening');
  await fixture.emit({type:'capture',state:'processing',partial:'Actual partial text'});await wait();check(element.querySelector('[data-voice-live-phase="hear"]'),'Live shows recognition');
  await fixture.emit({type:'capture',state:'waiting-playback'});await wait();check(element.querySelector('[data-voice-live-phase="think"]'),'Live shows thinking');
  await click('.vx-live-end');check(!element.querySelector('.vx-live'),'ending Live restores input');
  check(fixture.calls.filter(row=>row.op==='stop').every(row=>row.payload?.channel==='app-chat'),'chat controls never stop card voice');
  await click('.vx-vchip');await click('.vx-pop .ui-switch');check(fixture.calls.some(row=>row.op==='configure'&&row.payload.enabled===false),'voice switch uses existing configure');
  await fixture.dispose();fixture=await mountVoiceDesignChatFixture(element,{settings:true});
  const count=fixture.calls.length;await click('[role="tab"]:last-child');check(fixture.calls.length===count,'browsing plugin tab makes no action request');await click('[role="tab"]:first-child');
  await click('.vx-voices-f button');check(element.querySelector('[role="dialog"]'),'recording import opens confirmation');
  check(!fixture.calls.some(row=>row.op==='profile-import'),'opening recording import does not write');
  const textarea=element.querySelector('.vx-form textarea'),setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(textarea,'Exact words in the calm recording');textarea.dispatchEvent(new Event('input',{bubbles:true}));await wait();
  await click('.vx-dlg .ui-dlg-act .primary');check(fixture.calls.find(row=>row.op==='profile-import')?.payload.text==='Exact words in the calm recording','confirmation forwards exact transcript to existing system-file import');
  return {passed:true,checks,calls:fixture.calls};
 }finally{await fixture.dispose();}
}

export async function verifyVoiceDesignReviewFixes(element){
 const checks=[],check=(value,message)=>{if(!value)throw Error(message);checks.push(message);},wait=async()=>{for(let i=0;i<7;i++)await tick();};
 const click=async selector=>{const node=element.querySelector(selector);check(node,'control exists: '+selector);node.click();await wait();};
 const transcript=async()=>{const node=element.querySelector('.vx-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,'Words belonging only to the original character');node.dispatchEvent(new Event('input',{bubbles:true}));await wait();};
 for(const invalidation of ['close','scope-life','unmount']){
  const f=await mountVoiceDesignChatFixture(element,{settings:true});let gate,disposed=false;
  try{
   await click('[role="tab"]:last-child');await click('.vx-voices-f button');await transcript();gate=f.holdNext('configure');
   element.querySelector('.vx-dlg .ui-dlg-act .primary').click();await gate.entered;await wait();
   if(invalidation==='close')await click('.vx-dlg-h button');
   else if(invalidation==='scope-life'){await f.patch({scope:{...chatDesignScope,lifeId:'different-life',operationId:'different-operation'}});await wait();}
   else{await f.dispose();disposed=true;}
   gate.release();await wait();check(!f.calls.some(row=>row.op==='profile-import'),'stale import is cancelled after '+invalidation);
  }finally{gate?.release();if(!disposed)await f.dispose();}
 }
 let f=await mountVoiceDesignChatFixture(element,{settings:true});
 try{
  await f.patch({assets:{asr:{state:'ready'},tts:{state:'missing'}}});await wait();await click('[data-voice-full-settings]');
  check(element.querySelector('.vx-where'),'missing local model can return to complete configuration');await click('.vx-choice:last-child');
  check(f.calls.some(row=>row.op==='configure'&&row.payload.packages?.['ai-buddy.voice-breeze']?.ttsProvider==='minimax'),'cloud choice remains available without local model preparation');check(!f.calls.some(row=>row.op==='assets-prepare'),'cloud choice does not require local model preparation');
 }finally{await f.dispose();}
 f=await mountVoiceDesignChatFixture(element);
 try{
  await f.patch({preparation:{state:'idle'}});await wait();await click('.vx-vchip');check(element.querySelector('.vx-pop .ui-switch').getAttribute('aria-checked')==='false','cold stopped voice switch agrees with off chip');await click('.vx-pop .ui-switch');
  check(f.calls.some(row=>row.op==='configure'&&row.payload.enabled===true),'one click restarts cold stopped voice');
 }finally{await f.dispose();}
 return {passed:true,checks};
}

export async function verifyVoiceDesignRetryModes(element){
 const checks=[],check=(value,message)=>{if(!value)throw Error(message);checks.push(message);},wait=async()=>{for(let i=0;i<7;i++)await tick();};
 for(const mode of ['record','live']){
  const f=await mountVoiceDesignChatFixture(element);
  try{
   f.denyMicrophone();element.querySelector(mode==='record'?'.vx-mic':'.vx-livebtn').click();await wait();check(element.querySelector('.vx-livealert'),'microphone error appears after '+mode+' failure');
   f.denyMicrophone(false);const retry=[...element.querySelectorAll('.vx-livealert button')].find(node=>node.textContent.includes('再试一次'));check(retry,'retry control is available for '+mode);retry.click();await wait();
   check(f.calls.filter(row=>row.op==='capture-start').at(-1)?.payload.mode===mode,'microphone retry preserves '+mode+' mode');
   check(!f.calls.some(row=>/chat-send|group-send/.test(row.op)),'microphone retry never sends a message in '+mode+' mode');
  }finally{await f.dispose();}
 }
 return {passed:true,checks};
}
