// Browser fixture for the final integrator's focused Electron UI check.
// Real components/session/output; only IPC and audio hardware are substitutes.
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ensureVoiceSession,VoiceSettingsPanel,VoiceChatControls} from '../../src/voice/client.mjs';
import {setLocale} from '../../src/i18n.mjs';

const h=React.createElement;
export async function mountVoiceR5UIFixture(element,{language='zh-CN',createContext}={}){
  setLocale(language);
  const scope={channel:'app-private',characterId:'deepseek',personaId:'fixture-user',conversationId:'fixture-chat',lifeId:'fixture-life',operationId:'fixture-operation'};
  let state={settings:{enabled:true,packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax'}}},selectedPackageId:'ai-buddy.voice-breeze',packages:[{id:'ai-buddy.voice-breeze',installed:true,usable:true}],preparation:{state:'ready',target:'speech'},profile:{label:'Fixture reference'},engine:'breeze',scope,cloud:{state:'unbound',message:'Fixture: current character voice is not prepared'},cloudConnections:{selectedId:'fixture-cn',items:[{id:'fixture-cn',name:'Fixture MiniMax',provider:'minimax',model:'speech-2.8-turbo',configured:true}]},cloudBatch:{state:'idle',total:3,available:2,counts:{'not-prepared':2,missing:1},items:[{characterId:'deepseek',status:'not-prepared'},{characterId:'claude',status:'not-prepared'},{characterId:'gemini',status:'missing',message:'Fixture: reference file is missing'}]}};
  const listeners=new Set(),calls=[];
  let finishBatch;
  const emit=event=>Promise.all([...listeners].map(listener=>listener(event)));
  const api={onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},action:async(op,payload)=>{
    calls.push({op,payload:payload?{...payload,...(payload.key?{key:'<REDACTED>'}:{})}:payload});
    if(op==='state')return structuredClone(state);
    if(op==='cloud-connection-save'){
      const row={id:payload.id??'fixture-'+(state.cloudConnections.items.length+1),name:payload.name,provider:payload.provider,model:payload.model,configured:true};
      state.cloudConnections.items=[...state.cloudConnections.items.filter(item=>item.id!==row.id),row];
      state.cloudConnections.selectedId??=row.id;return row;
    }
    if(op==='cloud-connection-select'){state.cloudConnections.selectedId=payload.id;return structuredClone(state.cloudConnections);}
    if(op==='cloud-connection-remove'){state.cloudConnections.items=state.cloudConnections.items.filter(row=>row.id!==payload.id);if(state.cloudConnections.selectedId===payload.id)state.cloudConnections.selectedId=state.cloudConnections.items[0]?.id??null;return structuredClone(state.cloudConnections);}
    if(op==='cloud-batch-preview')return structuredClone(state.cloudBatch);
    if(op==='cloud-batch-prepare'){
      if(payload.consentUpload!==true||payload.consentActivation!==true)throw Error('Fixture requires explicit upload and activation consent');
      state.cloudBatch={...state.cloudBatch,state:'preparing',counts:{activated:1,unknown:1,missing:1},items:[{characterId:'deepseek',status:'activated'},{characterId:'claude',status:'unknown',code:'FIXTURE_REMOTE_UNKNOWN'},{characterId:'gemini',status:'missing'}]};
      const pending=new Promise(resolve=>{finishBatch=resolve;});
      await emit({type:'cloud-batch',cloudBatch:structuredClone(state.cloudBatch)});
      await pending;return structuredClone(state.cloudBatch);
    }
    if(op==='cloud-batch-cancel'){state.cloudBatch={...state.cloudBatch,state:'cancelled'};await emit({type:'cloud-batch',cloudBatch:structuredClone(state.cloudBatch)});finishBatch?.();return {accepted:true};}
    if(op==='configure'){
      state={...state,settings:{...state.settings,...payload,packages:{...state.settings.packages,...payload.packages}}};return structuredClone(state);
    }
    if(op==='capture-start')throw Error('Fixture never opens a microphone');
    return {accepted:true};
  }};
  const session=ensureVoiceSession(api,{createContext:createContext??(({sampleRate})=>({sampleRate,state:'running',resume:async()=>{},close:async()=>{}})),captureOptions:{workletURL:'fixture',getMedia:async()=>{throw Error('Fixture never opens a microphone');}}}),release=session.retain(),root=createRoot(element);
  function Fixture(){
    const [snapshot,setSnapshot]=useState(session.snapshot());
    useEffect(()=>session.subscribe(setSnapshot),[]);
    return h(React.Fragment,null,h(VoiceSettingsPanel,{snapshot,session}),h('section',{className:'ws-card ws-set'},h(VoiceChatControls,{snapshot,session,scope})));
  }
  await session.refresh();root.render(h(Fixture));
  return {session,calls,emit,fail:message=>emit({type:'segment',state:'failed',channel:'card-table',requestId:'fixture-failure',code:'FIXTURE_CARD_FAILURE',message}),async dispose(){finishBatch?.();root.unmount();await release();}};
}
