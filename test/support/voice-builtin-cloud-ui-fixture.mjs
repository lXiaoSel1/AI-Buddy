import React from 'react';
import {flushSync} from 'react-dom';
import {BuiltinCloudPage} from '../../src/voice/builtin-cloud-page.mjs';
import {VoiceChatControls} from '../../src/voice/client.mjs';
import {setLocale} from '../../src/i18n.mjs';

const h=React.createElement;
const scope={channel:'app-group',characterId:'deepseek',personaId:'fixture-persona',conversationId:'fixture-group'};
const wait=()=>new Promise(resolve=>setTimeout(resolve,24));
export async function verify(root){
 setLocale('en');
 const account={id:'fixture-account',name:'Fixture MiniMax',providerId:'minimax-cn',model:'speech-2.8-turbo',configured:true,selected:true};
 const cloud={route:'cloud:minimax-cn',enabled:true,providerId:'minimax-cn',status:'ready',accountRevision:'fixture-revision',account,accounts:[account],characters:[
  {characterId:'deepseek',referenceAvailable:true,referenceSource:'gpt',referenceDurationMs:12199,referenceVersion:1,state:'off'},
  {characterId:'chatgpt',referenceAvailable:false,state:'off'},
 ],asr:{state:'downloading',received:48,total:100},autoRetain:true,migration:{pending:true,accounts:1,characters:2}};
 const calls=[];
 let goodProbe=false, page=true, intent=null,extensionsOpened=0,previewsStarted=0,previewsStopped=0,previewsClosed=0,activationUncertain=false;
 const savedAudio=globalThis.Audio;
 const savedCreate=URL.createObjectURL,savedRevoke=URL.revokeObjectURL,urls=new Set();
 URL.createObjectURL=blob=>{
  if(blob.type!=='audio/wav'||blob.size!==4)throw Error('Incorrect synthetic reference WAV');
  const href=savedCreate.call(URL,blob);urls.add(href);return href;
 };
 URL.revokeObjectURL=href=>{if(urls.delete(href))previewsClosed++;savedRevoke.call(URL,href);};
 globalThis.Audio=class {
  async play(){if(!urls.has(this.src))throw Error('Expected a local reference blob URL');previewsStarted++;}
  pause(){previewsStopped++;}
  removeAttribute(){this.src='';}
  load(){}
 };
 const session={async runAction(op,args){
  calls.push([op,args]);
  if(op==='builtin-cloud-probe')return goodProbe?{ok:true,status:'ready',proof:'fixture-proof'}:{ok:false,status:'key_invalid',state:'key-invalid',code:'CLOUD_MINIMAX_AUTH',category:'auth',providerCode:1004,message:'MiniMax Key 无效，请到云配音设置重新填写'};
  if(op==='builtin-cloud-reference-preview')return {pcmWav:Uint8Array.of(0,1,2,3)};
  if(op==='builtin-cloud-voices')return [{voiceId:'fixture-voice',name:'A fixture voice',kind:'system'}];
  if(op==='builtin-cloud-clone'&&activationUncertain&&!args.confirmActivationVoiceId)return {ok:false,state:'activation_confirmation',voiceId:'fixture-activation',accountRevision:'fixture-revision'};
  if(op==='builtin-cloud-save'||op==='builtin-cloud-clone'||op==='builtin-cloud-bind')return {ok:true};
  return {ok:true};
 }};
 const render=()=>{
  const snapshot={state:{scope,settings:{enabled:true,packages:{}},packages:[],builtinCloud:cloud}};
  root.render(page?h(BuiltinCloudPage,{snapshot,session,characterId:'deepseek',intent,onGetVoicePlugin:()=>extensionsOpened++}):h(React.Fragment,null,
   h(VoiceChatControls,{snapshot,session,scope,placement:'top',open:true,galgame:true,cloudMembers:['deepseek','chatgpt']}),
   h(VoiceChatControls,{snapshot,session,scope,placement:'input-left',galgame:true})));
 };
 const assert=(given,message)=>{if(!given)throw Error(message);};
 const button=(text,within=document)=>[...within.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
 const click=async node=>{assert(node,'Expected enabled control');assert(!node.disabled,'Control is disabled: '+node.title+node.textContent);node.click();await wait();};
 const dialog=()=>document.querySelector('dialog[open]');
 const input=(node,value)=>{
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));
 };
 render();await wait();
 await click(document.querySelector('[aria-label="Got it"]'));
 assert(calls.at(-1)[0]==='builtin-cloud-migration-ack','migration acknowledgement uses the built-in action');
 await click(button('Pause'));
 assert(calls.at(-1)[0]==='builtin-cloud-asr'&&calls.at(-1)[1].action==='pause','page pauses recognition download');
 await click(button('Account & key'));
 assert(dialog(),'W3 opens a protected native dialog');
 assert(button('Save',dialog()).disabled,'unprobed key cannot be saved');
 const pw=dialog().querySelector('input[type="password"]');
 assert(pw.value==='','stored key does not appear');
 input(pw,'fixture-key-only');await wait();await click(button('Test connection',dialog()));
 assert(dialog().textContent.includes('MiniMax key invalid')&&button('Save',dialog()).disabled,'invalid key has a distinct alert and blocks save');
 goodProbe=true;await click(button('Test connection',dialog()));
 assert(!button('Save',dialog()).disabled,'passing probe enables Save');
 const model=dialog().querySelectorAll('select')[1];model.value='speech-2.8-hd';model.dispatchEvent(new Event('change',{bubbles:true}));await wait();
 assert(button('Save',dialog()).disabled,'changed model invalidates the probe');
 await click(button('Test connection',dialog()));await click(button('Save',dialog()));
 const saved=calls.at(-1);
 assert(saved[0]==='builtin-cloud-save'&&saved[1].proof==='fixture-proof'&&saved[1].accountId===account.id&&saved[1].model==='speech-2.8-hd','save is bound to the last known provider, model and account');
 assert(!dialog(),'successful save closes the modal');
 await click(document.querySelector('[aria-label="Choose voice for GPT"]'));
 assert(button('Clone and use',dialog()).disabled,'missing verified plugin reference disables cloning');
 assert(dialog().textContent.includes('The reference recordings are in the voice plugin'),'missing plugin shows the approved reference explanation');
 assert(!dialog().querySelector('.cv-facts'),'missing plugin omits the reference and pricing facts');
 await click(button('Get it in Extensions',dialog()));
 assert(extensionsOpened===1,'download button opens the existing Extensions entry');
 const useAccount=[...dialog().querySelectorAll('[role=radio]')].find(node=>node.textContent.includes('Use a voice already in the account'));
 await click(useAccount);await click(button('Use this',dialog()));
 const savedVoice=calls.at(-1);
 assert(savedVoice[0]==='builtin-cloud-bind'&&savedVoice[1].voiceId==='fixture-voice'&&savedVoice[1].targetCharacterId==='chatgpt'&&savedVoice[1].accountRevision==='fixture-revision','account voice binds only the requested character');
 await click(document.querySelector('[aria-label="Choose voice for DeepSeek"]'));
 assert(!calls.some(([op])=>op==='builtin-cloud-clone'),'opening the cloning form never uploads');
 assert(dialog().textContent.includes('From the GPT-SoVITS Voice plugin'),'verified plugin name is displayed');
 await click(dialog().querySelector('[aria-label=\"Play the reference\"]'));
 assert(calls.at(-1)[0]==='builtin-cloud-reference-preview'&&JSON.stringify(calls.at(-1)[1])===JSON.stringify({targetCharacterId:'deepseek'}),'local preview requests only the selected character');
 assert(previewsStarted===1&&!dialog().querySelector('audio[src]'),'preview uses a local WAV blob URL without an app asset path');
 await click(dialog().querySelector('[aria-label=\"Stop the reference\"]'));
 assert(previewsStopped===1&&previewsClosed===1,'stop pauses playback and revokes the preview URL');
 await click(dialog().querySelector('[aria-label=\"Play the reference\"]'));
 cloud.characters[0].cloneRecovery=true;
 render();await wait();
 assert(dialog().textContent.includes('The last clone result is unconfirmed. You can upload the recording again.'),'uncertain upload explains the available retry');
 assert(!calls.some(([op])=>op==='builtin-cloud-clone'),'showing a retry never uploads');
 await click(button('Upload and clone again',dialog()));
 delete cloud.characters[0].cloneRecovery;
 assert(previewsStopped===2&&previewsClosed===2,'closing the chooser releases the preview URL');
 assert(calls.at(-1)[0]==='builtin-cloud-clone'&&calls.at(-1)[1].consentUpload&&calls.at(-1)[1].consentActivation&&calls.at(-1)[1].accountRevision==='fixture-revision','cloning only starts after both consents on explicit click');
 cloud.characters[0].referenceAvailable=false;
 render();await wait();
 await click(button('Prepare several…'));
 assert(dialog().textContent.includes('The reference recordings are in the voice plugin')&&button('Clone and use',dialog()).disabled,'batch shows the same installation path without a verified plugin');
 await click(button('Get it in Extensions',dialog()));
 assert(extensionsOpened===2,'batch repair opens Extensions');
 await click(button('Cancel',dialog()));
 const cloneCalls=()=>calls.filter(([op])=>op==='builtin-cloud-clone');
 cloud.characters[0].referenceAvailable=true;
 cloud.characters[0].activationRecovery=true;
 cloud.characters[0].activationRecoveryVoiceId='fixture-activation';
 activationUncertain=true;
 render();await wait();
 await click(document.querySelector('[aria-label="Choose voice for DeepSeek"]'));
 assert(button('Clone and use',dialog()).disabled,'activation recovery can be checked without a new plugin upload');
 const submitted=cloneCalls().length;
 await click(button('Check activation status',dialog()));
 assert(cloneCalls().length===submitted+1&&cloneCalls().at(-1)[1].expectedActivationVoiceId==='fixture-activation'&&!cloneCalls().at(-1)[1].confirmActivationVoiceId,'checking must identify the pending voice and must not confirm activation');
 await click(button('Activate again',dialog()));
 assert(cloneCalls().length===submitted+2&&cloneCalls().at(-1)[1].confirmActivationVoiceId==='fixture-activation'&&cloneCalls().at(-1)[1].accountRevision==='fixture-revision','only explicit confirmation retries the exact voice on the same account');
 assert(!dialog(),'successful activation recovery closes the chooser');
 cloud.characters[0].referenceAvailable=false;
 render();
 await click(document.querySelector('[aria-label="Choose voice for DeepSeek"]'));
 const checkActivation=await nextDom(()=>dialog()&&button('Check activation status',dialog()),'Checking activation does not depend on a reference plugin');
 assert(button('Clone and use',dialog()).disabled,'A pending activation blocks a fresh clone after uninstall');
 const beforeUninstalled=cloneCalls().length;
 await click(checkActivation);
 const confirmUninstalled=await nextDom(()=>dialog()&&button('Activate again',dialog()),'Activation can be reconfirmed without a reference plugin');
 await click(confirmUninstalled);
 assert(cloneCalls().length===beforeUninstalled+2&&cloneCalls().at(-1)[1].confirmActivationVoiceId==='fixture-activation','The same voice is confirmed without a reference plugin');
 assert(!dialog(),'recovery after uninstall closes the chooser');
 cloud.characters[0].activationRecovery=false;
 cloud.storageIssue={code:'CLOUD_STORAGE_NEWER',message:'fixture',canReset:false};
 render();await wait();
 assert(document.body.textContent.includes('were created by a newer version and are read-only'),'a future settings file is visibly read-only');
 assert(!button('Reset cloud voice settings'),'future settings do not have a destructive reset');
 cloud.storageIssue={code:'CLOUD_STORAGE_INVALID',message:'fixture',canReset:true};
 render();await wait();
 const beforeReset=calls.length;
 await click(button('Reset cloud voice settings'));
 assert(calls.length===beforeReset,'reset first requires explicit confirmation');
 await click(button('Reset settings',dialog()));
 assert(calls.at(-1)[0]==='builtin-cloud-reset'&&calls.at(-1)[1].confirm===true,'reset requires the explicit reset payload');
 delete cloud.storageIssue;
 globalThis.Audio=savedAudio;URL.createObjectURL=savedCreate;URL.revokeObjectURL=savedRevoke;
 page=false;render();await wait();
 assert(document.querySelector('.bc-voice-members').textContent.includes('GPT'),'group popover lists the member without a voice');
 let focus;const onOpen=event=>{focus=event.detail;};window.addEventListener('buddy:cloud-voice',onOpen,{once:true});
 await click(button('Choose voice for GPT'));assert(focus?.characterId==='chatgpt','group repair targets the missing member directly');
 await click(document.querySelector('.bc-asr-mic button'));
 assert(document.querySelector('.bc-asr-tip [role=progressbar]').getAttribute('aria-valuenow')==='48','composer recognition help shows current download progress');
 await click(button('Pause',document.querySelector('.bc-asr-tip')));
 assert(calls.at(-1)[0]==='builtin-cloud-asr'&&calls.at(-1)[1].action==='pause','recognition help pauses without attempting to record');
 return 'Synthetic renderer assertions, no real voice package, microphone, audio device or external request';
}

function nextDom(predicate,message){
 return new Promise((resolve,reject)=>{
  const tryRead=()=>{const result=predicate();if(result){observer.disconnect();clearTimeout(timeout);resolve(result);}};
  const observer=new MutationObserver(tryRead);
  const timeout=setTimeout(()=>{observer.disconnect();reject(Error(message));},2000);
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
  tryRead();
 });
}
const namedButton=(name,scope=document)=>[...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===name);

export async function verifyRetention(root){
 setLocale('zh-CN');
 const row={characterId:'deepseek',voiceId:'fixture-clone',kind:'clone',state:'ready',lastUsedAt:Date.now()-6*86400000,due:true,
  retentionIssue:{reasonCode:'CLOUD_RETENTION_UNCONFIRMED',daysRemaining:1}};
 const cloud={route:'cloud:minimax-cn',enabled:true,providerId:'minimax-cn',status:'ready',accountRevision:'fixture',
  account:{configured:true},autoRetain:true,characters:[row],asr:{state:'ready'}};
 const calls=[];
 let finish;
 const session={runAction(op,payload){
  calls.push([op,payload]);
  if(op==='builtin-cloud-probe')return Promise.resolve({ok:true,status:'ready'});
  return new Promise(resolve=>{finish=resolve;});
 }};
 const render=()=>root.render(h(BuiltinCloudPage,{session,characterId:'deepseek',snapshot:{state:{builtinCloud:{...cloud,characters:[{...row}]}}}}));
 render();
 const keep=await nextDom(()=>namedButton('保住它'),'Manual retention must appear when automatic retention has given up');
 if(!keep.closest('[role=status]')?.textContent.includes('1 天后会被 MiniMax 删除'))throw Error('Issue shows the remaining lifetime for the exact voice');
 keep.click();keep.click();
 const busy=await nextDom(()=>namedButton('正在保住…'),'Manual action must show immediate in-flight feedback');
 if(!busy.disabled||calls.length!==1||calls[0][0]!=='builtin-cloud-retain'||calls[0][1].targetCharacterId!=='deepseek')throw Error('Repeated manual click should make one request for the exact role');
 finish({ok:true});
 await nextDom(()=>namedButton('保住它'),'Manual completion should restore the control until the host snapshot updates');
 delete row.retentionIssue;
 row.retentionInFlight=true;
 render();
 const automatic=await nextDom(()=>!namedButton('保住它')&&namedButton('正在保住…'),'The host reports automatic retention already in flight');
 automatic.click();
 if(!automatic.disabled||calls.length!==1)throw Error('Automatic in-flight state blocks manual retention');
 row.retentionInFlight=false;
 cloud.autoRetain=false;
 row.retentionIssue={reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:1};
 render();
 const held=await nextDom(()=>[...document.querySelectorAll('[role=status]')].find(node=>node.textContent.includes('自动保住没成功')&&node.textContent.includes('余额不足')),'Held retention issue must remain visible with automatic retention off');
 if(!namedButton('保住它',held)||calls.length!==1)throw Error('A held voice is manually recoverable without automatically calling the provider');
 const recheck=await nextDom(()=>namedButton('重新检查'),'Recheck stays available for a stored rejection after the account status is ready');
 recheck.click();
 if(calls.length!==2||calls[1][0]!=='builtin-cloud-probe'||calls[1][1].providerId!=='minimax-cn')throw Error('Recheck uses the saved account');
 row.retentionIssue={reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:0};
 render();
 await nextDom(()=>document.body.textContent.includes('今天会被 MiniMax 删除'),'Zero days should say that deletion is due today');
 row.retentionIssue={...row.retentionIssue,expired:true};
 render();
 await nextDom(()=>document.body.textContent.includes('可能已经被 MiniMax 删除，点「重新检查」核对'),'Past due must be distinguished from deletion today');
 return 'Synthetic paused automatic and manual retention checks';
}

export async function verifyResetCopy(root){
 setLocale('zh-CN');
 const cloud={storageIssue:{code:'CLOUD_STORAGE_INVALID',canReset:true}};
 const session={runAction(){throw Error('Opening reset confirmation has no side effects');}};
 flushSync(()=>root.render(h(BuiltinCloudPage,{session,snapshot:{state:{builtinCloud:cloud}}})));
 const trigger=await nextDom(()=>namedButton('重置云配音设置'),'Reset action should be visible for corrupt settings');
 trigger.click();
 const reset=await nextDom(()=>document.querySelector('dialog[open]'),'Reset should first open confirmation');
 const copy='账号和角色声音要重新设置。已经克隆好的声音还在你的 MiniMax 账号里，之后用「用账号里已有的声音」可以接回来。';
 if(!reset.textContent.includes(copy))throw Error('Reset confirmation must describe the settings lost and how to recover MiniMax voices');
 return 'Synthetic reset dialog, user confirmation still pending';
}

export async function verifyAbandonActivation(root){
 setLocale('zh-CN');
 const role={characterId:'deepseek',state:'voice_pending',kind:'clone',voiceId:'fixture-pending',activationRecovery:true,activationRecoveryVoiceId:'fixture-pending',referenceAvailable:true,referenceSource:'breeze',referenceDurationMs:12000,referenceVersion:1};
 const accountRevision='fixture-revision',token='fixture-absence-token';
 const cloud={route:'cloud:minimax-cn',enabled:true,providerId:'minimax-cn',status:'ready',accountRevision,
  account:{configured:true},asr:{state:'ready'}};
 const calls=[];
 let listed=false;
 const session={async runAction(op,params){
  calls.push({op,params});
  if(op==='builtin-cloud-clone'){
   if(listed)return {ok:true,state:'ready',voiceId:role.voiceId};
   return {ok:false,state:'activation_confirmation',voiceId:role.voiceId,accountRevision,abandonActivationToken:token};
  }
  if(op==='builtin-cloud-abandon-activation'){
   role.activationRecovery=false;
   render();
   return {ok:true,state:'abandoned'};
  }
  throw Error('Unexpected action '+op);
 }};
 const render=()=>root.render(h(BuiltinCloudPage,{session,characterId:'deepseek',snapshot:{state:{builtinCloud:{...cloud,characters:[{...role}]}}}}));
 const dialog=()=>document.querySelector('dialog[open]');
 const button=name=>dialog()&&namedButton(name,dialog());
 const ready=name=>nextDom(()=>{const node=button(name);return node&&!node.disabled&&node;},'Expected enabled '+name).catch(error=>{throw Error(error.message+'; dialog: '+(dialog()?.textContent??'closed'));});
 const open=async()=>{
  const button=await nextDom(()=>document.querySelector('[aria-label="给 DeepSeek 选声音"]'),'Expected character voice selector');
  button.click();
  return ready('核对激活状态');
 };
 flushSync(render);
 const check=await open();
 if(button('放弃这条记录')||calls.length)throw Error('Abandon is forbidden before checking the provider list');
 check.click();
 const abandon=await ready('放弃这条记录');
 if(!dialog().textContent.includes('MiniMax 音色列表里没有找到这个音色'))throw Error('The dialogue must say the list did not contain the checked voice');
 abandon.click();
 await ready('确认放弃');
 const copy='如果它其实已经激活过，可能已经收过 9.9 元；放弃以后，这个角色可以用新的录音重新克隆。';
 if(!dialog().textContent.includes(copy)||calls.length!==1)throw Error('Explicit cost warning must appear before an abandon action');
 (await ready('返回')).click();
 await ready('放弃这条记录');
 if(calls.length!==1)throw Error('Returning from confirmation cannot abandon the record');
 (await ready('放弃这条记录')).click();
 (await ready('确认放弃')).click();
 await nextDom(()=>!dialog(),'Successful abandon closes the chooser');
 const action=calls.at(-1);
 if(action.op!=='builtin-cloud-abandon-activation'||action.params.targetCharacterId!==role.characterId||
  action.params.accountRevision!==accountRevision||action.params.expectedActivationVoiceId!=='fixture-pending'||
  action.params.abandonActivationToken!==token)throw Error('Confirming must identify the checked missing receipt');
 const choose=await nextDom(()=>document.querySelector('[aria-label="给 DeepSeek 选声音"]'),'Expected character voice selector');
 choose.click();
 await ready('克隆并使用');
 (await ready('取消')).click();
 await nextDom(()=>!dialog(),'Cancel closes the chooser');
 listed=true;
 role.activationRecovery=true;
 render();
 (await open()).click();
 await nextDom(()=>!dialog(),'Listed original voice reconnects directly');
 if(calls.length!==3||calls.at(-1).op!=='builtin-cloud-clone'||button('放弃这条记录'))throw Error('A found voice must not ask to abandon');
 return 'Synthetic activation check, warning, scoped abandon, fresh clone eligibility and listed voice recovery';
}
