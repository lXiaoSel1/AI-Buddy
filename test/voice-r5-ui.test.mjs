import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {ensureVoiceSession,voiceStatus,VoiceSettingsPanel,VoiceDialogueLine} from '../src/voice/client.mjs';
import {CloudVoiceConnectionEditor,CloudVoiceConnectionManager,CloudVoiceBatchStatus} from '../src/voice/cloud-settings-ui.mjs';
import {SpeechLine} from '../src/chat-r95-ui.mjs';

setLocale('zh-CN');
const scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c',lifeId:'life',operationId:'op'};
const configuration={settings:{enabled:true,packages:{'ai-buddy.voice-breeze':{ttsProvider:'minimax'}}},selectedPackageId:'ai-buddy.voice-breeze',preparation:{state:'ready',target:'speech'},scope,packages:[{id:'ai-buddy.voice-breeze',installed:true,usable:true}],profile:{label:'Voice'},engine:'breeze',cloudConnections:{selectedId:'cn',items:[{id:'cn',name:'My MiniMax',provider:'minimax',model:'speech-2.8-turbo',configured:true}]}};
const render=value=>renderToStaticMarkup(React.createElement(VoiceSettingsPanel,{snapshot:value}));
function fixture(state=configuration,dispatch=async()=>({accepted:true})){
  const listeners=new Set(),calls=[];
  const api={action:async(op,payload)=>{calls.push({op,payload});return op==='state'?state:dispatch(op,payload);},onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const session=ensureVoiceSession(api,{createContext:()=>{throw Error('Tests must not open an audio device');},captureOptions:{workletURL:'fixture',getMedia:async()=>{throw Error('Tests must not open a microphone');}}}),release=session.retain();
  return {session,release,calls,emit:event=>Promise.all([...listeners].map(listener=>listener(event)))};
}

test('an unscoped card voice failure is visible globally without contaminating chat presentation',async()=>{
  const f=fixture();let chat;
  const off=f.session.output.subscribe(scope,value=>{chat=value;});
  try{
    await f.session.refresh();
    await f.emit({type:'segment',state:'failed',requestId:'card-failed',channel:'card-table',code:'VOICE_CLOUD_UNBOUND',message:'MiniMax voice is not bound for this player'});
    assert.equal(voiceStatus(f.session.snapshot()),'MiniMax voice is not bound for this player');
    assert.match(render(f.session.snapshot()),/role="alert"[^>]*>MiniMax voice is not bound for this player/);
    assert.equal(chat.error,null);
    assert.equal(chat.subtitle,null);
    assert.equal(f.calls.some(row=>row.op==='prepare'||row.op==='stop'),false,'showing a failure must not request a model or stop another channel');
  }finally{off();await f.release();}
});

test('General Settings offers named cloud connections with selected-character preparation and existing voices',()=>{
  const html=render({state:configuration,working:false});
  assert.match(html,/My MiniMax/);assert.match(html,/speech-2.8-turbo/);
  assert.match(html,/data-manage-connections="voice"/);assert.match(html,/管理配置/);
  assert.match(html,/data-cloud-open-batch="true"/);assert.match(html,/批量准备/);
  assert.match(html,/data-cloud-open-voices="true"/);
  assert.doesNotMatch(html,/data-cloud-character=/,'character consent is in the explicitly opened dialog');
  assert.doesNotMatch(html,/上传当前角色参考音并准备云音色|保存 API Key（两插件共用）/);
});

test('read-only cloud reconciliation remains cancellable without locking the ordinary settings flight',async()=>{
 let release;const held=new Promise(resolve=>release=resolve);
 const f=fixture(configuration,async op=>{if(op==='cloud-batch-reconcile')await held;if(op==='cloud-batch-cancel')release();return {accepted:true};});
 try{
  await f.session.refresh();const pending=f.session.runAction('cloud-batch-reconcile',{});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.session.snapshot().working,false);assert.equal(f.session.snapshot().cloudBatchWorking,true);
  await f.session.runAction('cloud-batch-cancel',{});await pending;
  assert.equal(f.calls.some(row=>row.op==='cloud-batch-cancel'),true);
 }finally{release();await f.release();}
});

test('all-character preparation stays independently cancellable and streams actual progress',async()=>{
  let entered,finish;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  const f=fixture(configuration,async op=>{if(op==='cloud-batch-prepare'){entered();await gate;return {state:'cancelled'};}return {accepted:true};});
  let preparing;
  try{
    await f.session.refresh();
    preparing=f.session.runAction('cloud-batch-prepare',{consentUpload:true,consentActivation:true});
    await started;
    assert.equal(f.session.snapshot().working,false,'long cloud work must not lock every voice control');
    assert.equal(f.session.snapshot().cloudBatchWorking,true);
    await f.emit({type:'cloud-batch',cloudBatch:{state:'preparing',total:3,counts:{activated:1,unknown:1,failed:1},items:[{characterId:'deepseek',status:'activated'},{characterId:'claude',status:'unknown'},{characterId:'gemini',status:'failed',message:'Reference file is missing'}]}});
    const html=render(f.session.snapshot());
    assert.match(html,/aria-label="正在准备云端声音"/);assert.match(html,/DeepSeek/);assert.match(html,/Claude/);assert.match(html,/Gemini/);
    assert.match(html,/结果未知，待核对/);
    assert.match(html,/Reference file is missing/);
    const cancel=html.match(/<button\b[^>]*data-cloud-cancel="true"[^>]*>[\s\S]*?<\/button>/)?.[0];
    assert.ok(cancel);assert.doesNotMatch(cancel,/disabled/);
    await f.session.runAction('cloud-batch-cancel',{});
    assert.equal(f.calls.filter(row=>row.op==='cloud-batch-cancel').length,1,'cancellation IPC reaches the host while preparation is still pending');
    assert.equal(f.calls.some(row=>row.op==='stop'),false);
  }finally{finish();await preparing;await f.release();}
});

test('retired channel failures stay retired and a fresh global failure survives an unrelated ready state',async()=>{
  const f=fixture();
  try{
    await f.session.refresh();
    const envelope={...scope,requestId:'retired-chat',segmentId:'retired-chat:0',index:0};
    await f.emit({type:'segment',state:'queued',envelope,text:'old',speech_text:'old'});
    await f.emit({type:'invalidate',channel:'app-chat',reason:'scope-changed'});
    await f.emit({type:'segment',state:'failed',envelope,message:'Old cancelled failure'});
    assert.equal(f.session.snapshot().error,'');
    await f.emit({type:'segment',state:'failed',message:'Card provider stopped responding'});
    await f.emit({type:'state',state:configuration});
    assert.equal(voiceStatus(f.session.snapshot()),'Card provider stopped responding');
  }finally{await f.release();}
});

test('cloud configuration editing exposes only supported choices and never echoes a stored credential',()=>{
  const editor=renderToStaticMarkup(React.createElement(CloudVoiceConnectionEditor,{draft:{id:'cn',name:'Saved voice',provider:'minimax',model:'speech-2.8-hd',configured:true,key:''}}));
  assert.match(editor,/type="password"/);
  assert.match(editor,/已保存；留空保留原 Key/);
  assert.match(editor,/value="speech-2.8-turbo"/);
  assert.match(editor,/value="speech-2.8-hd" selected/);
  assert.doesNotMatch(editor,/自定义|baseUrl|credentialRef/);
  const manager=renderToStaticMarkup(React.createElement(CloudVoiceConnectionManager,{connections:{...configuration.cloudConnections,items:[{...configuration.cloudConnections.items[0],key:'RAW_KEY_MUST_NOT_RENDER',credentialRef:'PRIVATE_REFERENCE_MUST_NOT_RENDER'}]},error:'Save failed'}));
  assert.match(manager,/aria-label="云配音配置"/);
  assert.match(manager,/Key 已保存/);
  assert.match(manager,/role="alert"[^>]*>Save failed/);
  assert.doesNotMatch(manager,/RAW_KEY_MUST_NOT_RENDER|PRIVATE_REFERENCE_MUST_NOT_RENDER/);
});

test('batch progress distinguishes activation evidence and unknown outcomes with one row per character',()=>{
  const results=[{characterId:'deepseek',status:'activated'},{characterId:'deepseek',status:'activated'},{characterId:'claude',status:'activation-confirmed-query-pending'},{characterId:'gemini',status:'prepared-awaiting-activation'},{characterId:'qwen',status:'unknown',code:'CLOUD_REMOTE_UNKNOWN'}];
  const html=renderToStaticMarkup(React.createElement(CloudVoiceBatchStatus,{batch:{state:'completed',total:4,results}}));
  assert.equal((html.match(/deepseek/g)??[]).length,1);
  assert.match(html,/本批角色：4/);
  assert.match(html,/首次合成已确认，待查询核对/);
  assert.match(html,/已准备，待激活/);
  assert.match(html,/结果未知，待核对 · CLOUD_REMOTE_UNKNOWN/);
  assert.doesNotMatch(html,/11 个.*已就绪|永久绑定/);
});

test('a renderer playback error reaches the global session while preserving separate channel cancellation',async()=>{
  const f=fixture();
  try{
    await f.session.refresh();
    const envelope={channel:'card-table',requestId:'card-audio',segmentId:'card-audio:0',index:0};
    await f.emit({type:'segment',state:'queued',envelope,text:'Card line',speech_text:'Card line'});
    await f.emit({type:'audio',phase:'pcm',envelope,pcm:new Uint8Array([0,1]),sampleRate:32000});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(voiceStatus(f.session.snapshot()),'Tests must not open an audio device');
    const stops=f.calls.filter(row=>row.op==='stop');
    assert.deepEqual(stops.map(row=>row.payload),[{channel:'card-table'}]);
  }finally{await f.release();}
});

test('a social line preserves its presentation acknowledgement before following the shared audio subtitle clock',()=>{
  const line={messageId:'social:line:with:colons',text:'Full saved social line',status:'presented',scope:{...scope,personaId:'identity:with:colons'}};
  const requestId='social-voice:'+line.messageId,envelope={...line.scope,requestId,segmentId:requestId+':0',index:0};
  const waiting={requests:[{requestId,envelope,hasSegments:true,phase:{stage:'queue'},subtitle:null}]};
  const view=(row,presentation)=>renderToStaticMarkup(React.createElement(SpeechLine,{line:row,voicePresentation:presentation,onAction:()=>{throw Error('Rendering must never acknowledge or read a social line');}}));
  const pending=view(line,waiting);
  assert.doesNotMatch(pending,/Full saved social line/);
  assert.match(pending,/data-r95-speech-text="social:line:with:colons"[^>]*><span[^>]*data-voice-waiting="true"/);
  assert.match(pending,/正在等待配音队列/);
  const playing=view(line,{requests:[{...waiting.requests[0],subtitle:{envelope,text:'Current audio segment'}}]});
  assert.match(playing,/Current audio segment/);assert.doesNotMatch(playing,/Full saved social line/);
  assert.match(playing,/data-speech-option="read"/);
  const awaiting=view({...line,status:'awaiting-presentation'},waiting);
  assert.match(awaiting,/data-r95-speech-text="social:line:with:colons">Full saved social line<\/p>/);
  assert.doesNotMatch(awaiting,/data-voice-waiting/);
  assert.match(view(line,{requests:[]}),/Full saved social line/);
  assert.equal(view({...line,status:'read'},waiting),'');
});

test('shared voice dialogue content can stay inline inside the social presentation paragraph',()=>{
  const html=renderToStaticMarkup(React.createElement(VoiceDialogueLine,{as:'span',requestId:'inactive',presentation:{requests:[]}},'Saved line'));
  assert.equal(html,'<span>Saved line</span>');
});
