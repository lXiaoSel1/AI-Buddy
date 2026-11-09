// Real cloud settings, renderer session and events; only IPC/audio devices are substituted.
// This fixture never invokes MiniMax, uploads references, opens a microphone or creates a model.
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ensureVoiceSession,VoiceSettingsPanel} from '../../src/voice/client.mjs';
import {setLocale} from '../../src/i18n.mjs';

const h=React.createElement;
const clone=value=>structuredClone(value);
const names=[['deepseek','DeepSeek'],['claude','Claude'],['gemini','Gemini'],['qwen','Qwen'],['gpt','GPT'],['grok','Grok'],['kimi','Kimi'],['doubao','豆包'],['minimax','MiniMax'],['mistral','Mistral'],['llama','Llama']];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export function createVoiceR6Fixture({createContext}={}){
  const scope={channel:'app-private',characterId:'deepseek',personaId:'fixture-user',conversationId:'fixture-chat',lifeId:'fixture-life',operationId:'fixture-operation'};
  let state={settings:{enabled:true,packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax'}}},selectedPackageId:'ai-buddy.voice-breeze',packages:[{id:'ai-buddy.voice-breeze',installed:true,usable:true}],preparation:{state:'ready',target:'speech'},profile:{id:'fixture-deepseek-profile',version:1,label:'Fixture reference'},engine:'breeze',scope,cloud:{state:'ready',voiceId:'fixture-current'},cloudConnections:{selectedId:'fixture-cn',items:[{id:'fixture-cn',name:'Fixture MiniMax',provider:'minimax',model:'speech-2.8-turbo',configured:true},{id:'fixture-cn-two',name:'Fixture second account',provider:'minimax',model:'speech-2.8-hd',configured:true}]},cloudBatch:{state:'idle',total:11,items:names.map(([characterId,label])=>({characterId,label,status:'not-prepared'}))}};
  const voices=[{voiceId:'fixture-system',name:'系统女声',category:'system_voice'},{voiceId:'fixture-clone',name:'账号克隆音',category:'voice_cloning'},{voiceId:'fixture-generation',name:'账号设计音',category:'voice_generation'}];
  const listeners=new Set(),calls=[],failures=new Map(),held=new Map();let nextPlan;
  const emit=event=>Promise.all([...listeners].map(listener=>listener(event)));
  function makePlan(selection=[]){return {selectedCharacterIds:[...selection],selectedCount:selection.length,cloneCount:selection.length,activationCount:selection.length,firstUseCount:selection.length,reuseCount:0,blockedCount:0,planHash:'fixture-plan:'+selection.join(','),pricing:{currency:'CNY',cloneUnitPrice:9.9,cloneEstimate:selection.length*9.9,estimateOnly:true,sourceUrl:'https://platform.minimax.cn/docs/pricing/overview',checkedOn:'2026-11-07'}};}
  const api={onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},action:async(op,payload)=>{
    calls.push({op,payload:payload?clone(payload):payload});
    if(failures.has(op)){const failure=failures.get(op);failures.delete(op);throw Object.assign(new Error(failure.message),{code:failure.code});}
    if(op==='state')return clone(state);
    if(held.has(op)){const row=held.get(op);held.delete(op);const failure=await row.promise;if(failure)throw Object.assign(new Error(failure.message),{code:failure.code});}
    if(op==='cloud-voices')return clone(voices);
    if(op==='cloud-bind'){state={...state,cloud:{state:'ready',voiceId:payload.voiceId}};return {state:'ready',voiceId:payload.voiceId};}
    if(op==='cloud-connection-select'){state={...state,cloudConnections:{...state.cloudConnections,selectedId:payload.id},cloud:{state:'unbound'}};return clone(state.cloudConnections);}
    if(op==='cloud-batch-preview'){const plan=nextPlan??makePlan(payload?.selectedCharacterIds);nextPlan=undefined;return {...clone(state.cloudBatch),plan:clone(plan)};}
    if(op==='cloud-batch-prepare'){
      if(!payload.selectedCharacterIds?.length||payload.planHash!==makePlan(payload.selectedCharacterIds).planHash||payload.consentUpload!==true||payload.consentActivation!==true)throw Object.assign(new Error('Fixture requires a current selected-character plan and explicit consent'),{code:'CLOUD_PLAN_STALE'});
      state={...state,cloudBatch:{...state.cloudBatch,state:'completed',items:state.cloudBatch.items.map(row=>payload.selectedCharacterIds.includes(row.characterId)?{...row,status:'activated'}:row)}};
      await emit({type:'cloud-batch',cloudBatch:clone(state.cloudBatch)});return clone(state.cloudBatch);
    }
    if(op==='capture-start')throw Error('Fixture never opens a microphone');
    return {accepted:true};
  }};
  const session=ensureVoiceSession(api,{createContext:createContext??(()=>{throw Error('Fixture never opens an audio device');}),captureOptions:{workletURL:'fixture',getMedia:async()=>{throw Error('Fixture never opens a microphone');}}}),release=session.retain();
  return {session,calls,emit,makePlan,previewNextPlan:plan=>{nextPlan=plan;},rejectNext:(op,error)=>failures.set(op,error),holdNext(op){let resolve;const promise=new Promise(done=>resolve=done);held.set(op,{promise});return resolve;},
    async switchCharacter(characterId){state={...state,scope:{...state.scope,characterId,conversationId:'fixture-chat-'+characterId},profile:{...state.profile,id:'fixture-'+characterId+'-profile'},cloud:{state:'unbound'}};await emit({type:'state',state:clone(state)});},
    async switchConnection(id){state={...state,cloudConnections:{...state.cloudConnections,selectedId:id},cloud:{state:'unbound'}};await emit({type:'state',state:clone(state)});},
    async patchState(patch){state={...state,...patch};await emit({type:'state',state:clone(state)});},
    async dispose(){await release();}};
}

export async function mountVoiceR6UIFixture(element,{language='zh-CN',createContext}={}){
  setLocale(language);
  const fixture=createVoiceR6Fixture({createContext}),root=createRoot(element);
  function Fixture(){const [snapshot,setSnapshot]=useState(fixture.session.snapshot());useEffect(()=>fixture.session.subscribe(setSnapshot),[]);return h(VoiceSettingsPanel,{snapshot,session:fixture.session});}
  await fixture.session.refresh();root.render(h(Fixture));await tick();
  return {...fixture,async dispose(){root.unmount();await fixture.dispose();}};
}

// Run by the final integrator in the isolated Electron fixture, after the node RED/GREEN slice.
// DOM assertions exercise actual React event handling; no renderer implementation is mocked.
export async function verifyVoiceR6UIFixture(element){
  const checks=[],check=(condition,message)=>{if(!condition)throw Error(message);checks.push({name:message,pass:true});};
  const fixture=await mountVoiceR6UIFixture(element);
  const find=selector=>element.querySelector(selector),wait=async()=>{for(let i=0;i<5;i++)await tick();};
  const click=async selector=>{const node=find(selector);check(node,'Missing '+selector);node.click();await wait();};
  const choose=async(selector,value)=>{const node=find(selector);check(node,'Missing '+selector);const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(node,value);node.dispatchEvent(new Event('change',{bubbles:true}));await wait();};
  try{
    await wait();
    check(find('[data-cloud-prepare]').disabled,'No selection must disable prepare');
    await click('[data-cloud-prepare]');check(!fixture.calls.some(row=>row.op==='cloud-batch-preview'||row.op==='cloud-batch-prepare'),'Empty selection made a request');
    await click('[data-cloud-character="claude"]');await click('[data-cloud-prepare]');
    check(/¥\s*9\.90/.test(element.textContent),'Claude must cost ¥9.90');check(!/108\.90/.test(element.textContent),'One character must not quote eleven clones');
    check(element.querySelector('dialog')?.textContent.includes('Claude'),'Confirmation must identify selected character by host label');
    await click('[data-cloud-confirm]');
    const prepared=fixture.calls.find(row=>row.op==='cloud-batch-prepare');check(JSON.stringify(prepared?.payload.selectedCharacterIds)==='["claude"]','Prepare selection changed');check(prepared.payload.planHash==='fixture-plan:claude','Prepare did not bind the preview plan');
    fixture.previewNextPlan({...fixture.makePlan(['claude']),cloneCount:0,activationCount:1,firstUseCount:1});await click('[data-cloud-prepare]');
    check(find('[data-cloud-clone-count]').textContent.includes('0'),'Existing pending activation must not be labelled a new clone');
    check(/¥\s*9\.90/.test(find('[data-cloud-cost]').textContent),'Existing pending activation lost its first-use voice fee');
    check(!/免费/.test(element.querySelector('dialog').textContent),'Pending activation was called free');await click('dialog footer button');
    const before=fixture.calls.filter(row=>row.op==='cloud-batch-prepare').length;
    await click('[data-cloud-voices-refresh]');
    const systemCategory=[...find('[aria-label="音色分类"]').options].find(option=>option.textContent==='系统音色');
    check(!!systemCategory,'System voice category is available');await choose('[aria-label="音色分类"]',systemCategory.value);
    const systemVoice=find('[data-cloud-voice-select] option[value="fixture-system"]');
    check(systemVoice?.textContent==='系统女声 · fixture-system','System category preserves the actual system_voice provider name');
    check(systemVoice.parentElement.label==='系统音色','system_voice appears in the system voice group');
    check(!find('[data-cloud-voice-select] option[value="fixture-clone"]'),'System category excludes account clones');
    await choose('[data-cloud-voice-select]','fixture-system');await click('[data-cloud-voice-bind]');
    check(fixture.calls.filter(row=>row.op==='cloud-batch-prepare').length===before,'Existing voice binding started cloning');
    check(fixture.calls.find(row=>row.op==='cloud-bind')?.payload.voiceId==='fixture-system','Selected existing voice was not bound');
    const bindCount=fixture.calls.filter(row=>row.op==='cloud-bind').length;
    const release=fixture.holdNext('cloud-voices');await click('[data-cloud-voices-refresh]');await fixture.switchCharacter('claude');await wait();release();await wait();
    check(!find('option[value="fixture-system"]'),'Late voice list leaked to a new character');
    check(find('[data-cloud-voice-bind]').disabled,'Old list can bind to a new character');
    check(fixture.calls.filter(row=>row.op==='cloud-bind').length===bindCount,'Scope switch submitted a binding');
    await click('[data-cloud-voices-refresh]');await fixture.switchConnection('fixture-cn-two');await wait();
    check(!find('option[value="fixture-system"]'),'Voice list leaked to a different configuration');
    fixture.rejectNext('cloud-voices',{code:'CLOUD_REMOTE_1008',message:'云配音服务返回错误，请检查连接与声音配置'});await click('[data-cloud-voices-refresh]');
    check(/余额不足/.test(element.textContent)&&/1008/.test(element.textContent),'Load error lost its stable reason or code');
    check(!/已绑定到当前角色/.test(element.textContent),'Loading failure kept an unrelated old success');
    return {passed:true,checks,calls:fixture.calls};
  }finally{await fixture.dispose();}
}
