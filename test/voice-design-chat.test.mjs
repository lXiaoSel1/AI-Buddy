import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceChatControls,VoiceSettingsPanel} from '../src/voice/client.mjs';
import {setLocale} from '../src/i18n.mjs';
setLocale('zh-CN');
const id='ai-buddy.voice-breeze';
const scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c'};
const state={settings:{enabled:true,packages:{[id]:{ttsProvider:'local'}}},selectedPackageId:id,preparation:{state:'ready',target:'speech'},scope,packages:[{id,installed:true,usable:true,enabled:true},{id:'ai-buddy.voice-gpt-sovits',installed:true,usable:true,enabled:true}],profile:{label:'My recording'},assets:{asr:{state:'ready'},tts:{state:'ready'}},engine:'breeze'};
const snapshot={state,captureState:'idle',working:false,error:''};
const render=(placement,value=snapshot)=>renderToStaticMarkup(React.createElement(VoiceChatControls,{snapshot:value,scope,placement}));
test('approved chat entry is a voice chip and separate recording and Live input controls',()=>{
 assert.match(render('top'),/class="[^"]*vx-vchip/);
 assert.match(render('top'),/Breeze 就绪/);
 assert.match(render('input-left'),/aria-label="录音输入"/);
 assert.match(render('input-right'),/class="vx-livebtn/);
 assert.doesNotMatch(render('top'),/开启 Live|语音总开关/);
});

test('voice popover reflects off, actual preparation step, actual error and ready states',()=>{
 const pop=value=>renderToStaticMarkup(React.createElement(VoiceChatControls,{snapshot:value,scope,placement:'top',open:true}));
 assert.match(pop({...snapshot,state:{...state,settings:{...state.settings,enabled:false}}}),/9.5 GB/);
 const preparing=pop({...snapshot,state:{...state,preparation:{state:'verifying',target:'speech'}}});
 assert.match(preparing,/<li class="now"><span class="ui-spinner"[^>]*><\/span><span>校验组件/);
 assert.match(preparing,/<li class=""><span class="vx-stepdot"[^>]*><\/span><span>加载声音模型/);
 const failure=pop({...snapshot,error:'Measured model failure',state:{...state,preparation:{state:'failed'}}});
 assert.match(failure,/Measured model failure/);assert.doesNotMatch(failure,/6.1 GB|显卡空闲显存不够/);
 assert.match(pop(snapshot),/role="radiogroup" aria-label="配音插件"/);
});

test('Live shows four truthful phases and preserves cancelling preparation plus record finish controls',()=>{
 const live=(captureState,presentation)=>renderToStaticMarkup(React.createElement(VoiceChatControls,{snapshot:{...snapshot,captureState,captureMode:'live',state:{...state,live:true}},scope,placement:'replacement',presentation}));
 assert.match(live('listening'),/data-voice-live-phase="you"/);
 assert.match(live('processing'),/data-voice-live-phase="hear"/);
 assert.match(live('waiting-playback'),/data-voice-live-phase="think"/);
 assert.match(live('waiting-playback',{speaking:true,subtitle:{envelope:{index:0},text:'Actual spoken sentence'}}),/data-voice-live-phase="say"/);
 const loading={...snapshot,captureState:'preparing',captureMode:'live',working:true,state:{...state,preparation:{state:'loading',target:'live'}}};
 assert.match(render('alerts',loading),/声音模型还在加载[\s\S]*取消 Live/);
 const rec=render('replacement',{...snapshot,captureState:'recording',captureMode:'record',partial:'Actual recogniser text'});
 assert.match(rec,/Actual recogniser text/);assert.match(rec,/取消/);assert.match(rec,/说完了/);
 assert.doesNotMatch(rec,/live-phase|vx-phases/);
});

test('recording and Live entry stay disabled for an unrelated, disabled or untrusted chat session',()=>{
 for(const value of [
  {...snapshot,state:{...state,scope:{...scope,conversationId:'other'}}},
  {...snapshot,state:{...state,settings:{...state.settings,enabled:false}}},
  {...snapshot,state:{...state,packages:[{id,installed:true,usable:true,trusted:false}]}},
  {...snapshot,state:{...state,preparation:{state:'loading',target:'speech'}}}
 ]){assert.match(render('input-left',value),/disabled/);assert.match(render('input-right',value),/disabled/);}
 const unrelated={...snapshot,captureState:'listening',captureMode:'live',state:{...state,scope:{...scope,conversationId:'other'}}};
 assert.equal(render('replacement',unrelated),'');
});

test('plugin page follows actual selected and enabled state without claiming other characters are ready',()=>{
 const page=value=>renderToStaticMarkup(React.createElement(VoiceSettingsPanel,{snapshot:value,selectedPackageId:id}));
 for(const [expected,value] of [
  ['ready',snapshot],
  ['off',{...snapshot,state:{...state,settings:{...state.settings,enabled:false}}}],
  ['starting',{...snapshot,state:{...state,preparation:{state:'checking'}}}],
  ['failed',{...snapshot,error:'Real model startup failure',state:{...state,preparation:{state:'failed'}}}],
  ['idleOther',{...snapshot,state:{...state,selectedPackageId:'ai-buddy.voice-gpt-sovits'}}],
  ['disabled',{...snapshot,state:{...state,packages:[{id,installed:true,usable:true,enabled:false}]}}]
 ])assert.match(page(value),new RegExp('data-voice-plugin-state="'+expected+'"'));
 const ready=page(snapshot);assert.equal((ready.match(/尚未检查/g)??[]).length,10);assert.match(ready,/My recording/);assert.doesNotMatch(ready,/11 个角色都有|22\/22/);
 assert.doesNotMatch(ready,/录音输入|参考音逐字稿/);
 assert.match(ready,/<svg[^>]*width="28"[^>]*height="28"/);
});

test('microphone and reply failure display preserve actual errors and never pretend to open Windows settings',()=>{
 const mic=render('alerts',{...snapshot,error:'NotAllowedError: actual microphone permission denied'});
 assert.match(mic,/麦克风用不了/);assert.match(mic,/actual microphone permission denied/);assert.match(mic,/再试一次/);assert.doesNotMatch(mic,/打开 Windows 麦克风设置/);
 const reply=render('alerts',{...snapshot,captureMode:'live',captureState:'listening',error:'消息已保存，本次语音回复未能开始'});
 assert.match(reply,/这次的回复没能读出来/);assert.match(reply,/Live 还开着/);
});

test('parts preparation shows actual byte progress or an honest indeterminate state after returning to the page',()=>{
 const page=value=>renderToStaticMarkup(React.createElement(VoiceSettingsPanel,{snapshot:value,selectedPackageId:id}));
 const preparing={...snapshot,state:{...state,assets:{asr:{state:'ready'},tts:{state:'preparing'}}}};
 const unknown=page(preparing);assert.match(unknown,/vx-narrow/);assert.match(unknown,/role="progressbar"/);assert.doesNotMatch(unknown,/aria-valuenow/);
 const measured=page({...preparing,assetProgress:{kind:'breeze',receivedBytes:46,totalBytes:100}});assert.match(measured,/aria-valuenow="46"/);assert.match(measured,/width:46%/);assert.match(measured,/data-voice-download-cancel/);
});

test('startup cards retain a host supplied preparation reason when no session error string exists',()=>{
 const failed={...snapshot,state:{...state,preparation:{state:'failed',message:'Actual trusted preparation reason',code:'VOICE_COMPONENT_MISSING'}}};
 const card=renderToStaticMarkup(React.createElement(VoiceSettingsPanel,{snapshot:failed,selectedPackageId:id}));assert.match(card,/Actual trusted preparation reason/);
 const pop=renderToStaticMarkup(React.createElement(VoiceChatControls,{snapshot:failed,scope,placement:'top',open:true}));assert.match(pop,/Actual trusted preparation reason/);
});

test('cold stopped voice is off in both chip and switch and missing local parts retain a route to all settings',()=>{
 const cold={...snapshot,state:{...state,preparation:{state:'idle'}}};
 const pop=renderToStaticMarkup(React.createElement(VoiceChatControls,{snapshot:cold,scope,placement:'top',open:true}));assert.match(pop,/Voice off|语音 关/);assert.match(pop,/role="switch" aria-label="语音" aria-checked="false"/);
 const missing={...snapshot,state:{...state,assets:{asr:{state:'ready'},tts:{state:'missing'}}}};
 const page=renderToStaticMarkup(React.createElement(VoiceSettingsPanel,{snapshot:missing,selectedPackageId:id}));assert.match(page,/data-voice-full-settings="true"/);
});

test('group header renders the same voice entry ahead of its network control',async()=>{
 const {GroupHeader}=await import('../src/group-header.mjs');
 const group={id:'g',name:'Group',personaId:'p',memberIds:['deepseek'],mutedIds:[]};
 const html=renderToStaticMarkup(React.createElement(GroupHeader,{state:{activeGroupId:'g',groups:[group],characters:[{id:'deepseek',name:'DeepSeek'}],personas:[{id:'p',nickname:'User'}],groupRuntime:{}},voiceControls:React.createElement('button',{'data-fixture-voice-entry':true},'Voice'),chat:{enabled:true}}));
 assert.match(html,/data-fixture-voice-entry="true"/);assert.ok(html.indexOf('data-fixture-voice-entry')<html.indexOf('data-group-net'));
});
