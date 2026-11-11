import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CloudVoiceSettings,CloudVoiceConnectionManager,CloudVoiceConnectionEditor} from '../src/voice/cloud-settings-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';

setLocale('zh-CN');
const state={scope:{characterId:'deepseek'},profile:{id:'reference',version:1},cloud:{state:'ready',voiceId:'current'},cloudConnections:{selectedId:'local',items:[{id:'local',name:'我的 MiniMax',provider:'minimax',model:'speech-2.8-turbo',configured:true}]},cloudBatch:{state:'idle',items:[{characterId:'deepseek',status:'activated'},{characterId:'claude',status:'not-prepared'},{characterId:'kimi',status:'profile-missing'}]}};
test('C3 shows cloud character states and opens voice and batch workflows without provider requests',()=>{
  const calls=[];
  const html=renderToStaticMarkup(React.createElement(CloudVoiceSettings,{snapshot:{state},session:{runAction:(...args)=>calls.push(args)}}));
  assert.match(html,/class="vx-cols/);
  assert.match(html,/角色的云端声音/);
  assert.match(html,/data-cloud-open-voices/);
  assert.match(html,/data-cloud-open-batch/);
  assert.match(html,/当前角色/);
  assert.match(html,/还没有声音档案/);
  assert.deepEqual(calls,[]);
});

test('C3 identifies a reused existing voice without labelling it unverified',()=>{
  const snapshot={state:{...state,cloudBatch:{state:'idle',items:[{characterId:'claude',status:'reuse-existing'}]}}};
  const html=renderToStaticMarkup(React.createElement(CloudVoiceSettings,{snapshot}));
  assert.match(html,/已复用/);
  assert.doesNotMatch(html,/等待核对/);
});

test('cloud voice list distinguishes no profile from a partially profiled role before and after preparation',()=>{
  const cloudBatch={items:[{characterId:'deepseek',status:'activated',missingEngines:['gpt']},
    {characterId:'chatgpt',status:'activation-confirmed-query-pending',missingEngines:['gpt']},
    {characterId:'claude',status:'profile-incomplete',availableStatus:'not-prepared',missingEngines:['breeze'],code:'CLOUD_PROFILE_REQUIRED'},
    {characterId:'kimi',status:'profile-missing',code:'CLOUD_PROFILE_REQUIRED'}]};
  const render=()=>renderToStaticMarkup(React.createElement(CloudVoiceSettings,{snapshot:{state:{...state,cloudBatch}}}));
  try{
    const zh=render();
    assert.match(zh,/2 个已就绪/);assert.match(zh,/还没准备/);assert.match(zh,/还没有声音档案/);
    assert.match(zh,/Breeze 还没有声音档案，这次只准备 GPT-SoVITS/);
    assert.match(zh,/GPT-SoVITS 还没有声音档案</);
    assert.match(zh,/首次合成已确认，待查询核对/);
    assert.doesNotMatch(zh,/GPT-SoVITS 还没有声音档案，这次只准备 Breeze/);
    assert.doesNotMatch(zh,/CLOUD_PROFILE_REQUIRED/);
    setLocale('en');
    const en=render();
    assert.match(en,/Breeze has no voice profile yet, so only GPT-SoVITS will be prepared/);
    assert.match(en,/GPT-SoVITS has no voice profile yet</);
  }finally{setLocale('zh-CN');}
});

test('C4 displays saved configuration and the new configuration form together without exposing credentials',()=>{
  const html=renderToStaticMarkup(React.createElement(CloudVoiceConnectionManager,{connections:{...state.cloudConnections,items:[{...state.cloudConnections.items[0],key:'DO_NOT_RENDER'}]},onClose(){}}));
  assert.match(html,/vx-cfglist/);
  assert.match(html,/vx-cfgform/);
  assert.match(html,/两个语音插件共用这些配置/);
  assert.match(html,/保存配置不会上传任何声音/);
  assert.doesNotMatch(html,/DO_NOT_RENDER/);
});

test('real cloud dialogs preserve explicit upload consent, scoped voice binding, configuration editing and cancellation',async context=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-design-cloud-'));
  const require=createRequire(import.meta.url),host=dirname(dirname(fileURLToPath(import.meta.url)));
  const renderer=String.raw`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {CloudVoiceSettings} from './src/voice/cloud-settings-ui.mjs';
    import {setLocale} from './src/i18n.mjs';
    const {ipcRenderer}=window.require('electron');
    window.fetch=()=>{throw Error('External API forbidden in cloud UI test');};
    setLocale('zh-CN');
    const h=React.createElement,calls=[],checks=[],wait=()=>new Promise(resolve=>setTimeout(resolve,20));
    const check=(value,name)=>{if(!value)throw Error(name);checks.push(name);};
    const find=selector=>document.querySelector(selector);
    const click=async selector=>{const element=find(selector);check(element,'Present: '+selector);element.click();await wait();};
    const input=async(selector,value)=>{const element=find(selector);check(element,'Present: '+selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));await wait();};
    let snapshot=${JSON.stringify({state})},update,releasePrepare,queryFailure=false,previewBad=false,holdQuery=false,releaseQuery;
    Object.assign(snapshot.state.cloudBatch.items.find(row=>row.characterId==='claude'),{status:'profile-incomplete',availableStatus:'not-prepared',missingEngines:['gpt']});
    snapshot.state.cloudBatch.items.push({characterId:'qwen',status:'preparing'});
    snapshot.state.cloudBatch.items.push({characterId:'chatgpt',status:'activation-confirmed-query-pending',missingEngines:['gpt']});
    snapshot.state.cloudBatch.items.push({characterId:'expired-fixture',status:'expired'},{characterId:'unknown-fixture',status:'unknown'});
    const emit=patch=>{snapshot={...snapshot,...patch};update({...snapshot});};
    const plan=ids=>{const count=ids.includes('claude')?2:1;return {selectedCharacterIds:ids,selectedCount:ids.length,cloneCount:count,activationCount:count,firstUseCount:count,reuseCount:0,blockedCount:0,planHash:'approved-plan',pricing:{currency:'CNY',cloneUnitPrice:9.9,cloneEstimate:count*9.9,checkedOn:'2026-11-07'}};};
    const session={snapshot:()=>snapshot,runAction:async(op,payload)=>{
      calls.push({op,payload:structuredClone(payload)});
      if(op==='cloud-batch-preview')return {plan:previewBad?{...plan(payload.selectedCharacterIds),planHash:''}:plan(payload.selectedCharacterIds)};
      if(op==='cloud-batch-prepare'){
        emit({cloudBatchWorking:true,cloudBatch:{state:'running',items:[{characterId:'claude',status:'preparing'}],total:1}});
        await new Promise(resolve=>releasePrepare=resolve);return {state:'cancelled'};
      }
      if(op==='cloud-batch-cancel'){emit({cloudBatchWorking:false,cloudBatch:{state:'cancelled',items:[{characterId:'claude',status:'cancelled'}],total:1}});releasePrepare();return {state:'cancelled'};}
      if(op==='cloud-voices'){if(holdQuery)await new Promise(resolve=>releaseQuery=resolve);if(queryFailure)throw Object.assign(Error('Provider request failed'),{code:'CLOUD_REMOTE_1008'});return [{voiceId:'current',name:'My clone',category:'voice_cloning'},{voiceId:'system-voice',name:'System girl',category:'system_voice'},{voiceId:'designed-voice',name:'Designed girl',category:'voice_generation'}];}
      if(op==='cloud-bind'){emit({state:{...snapshot.state,cloud:{state:'ready',voiceId:payload.voiceId}}});return {state:'ready',voiceId:payload.voiceId};}
      return {accepted:true};
    }};
    function Harness(){const [value,setValue]=useState(snapshot);update=setValue;return h(CloudVoiceSettings,{snapshot:value,session});}
    const root=createRoot(document.getElementById('root'));root.render(h(Harness));
    (async()=>{try{
      await wait();check(calls.length===0,'Opening C3 performs no provider request');
      check(!find('[data-cloud-reclone="unknown-fixture"]'),'Unknown outcome never offers automatic recloning');
      await click('[data-cloud-reclone="expired-fixture"]');check(find('[data-cloud-character="expired-fixture"]').checked,'Reclone selects only the expired character');
      await click('[data-cloud-prepare]');check(find('[data-cloud-cost]').textContent==='¥9.90'&&!calls.some(row=>row.op==='cloud-batch-prepare'),'Expired voice returns to the original explicit fee review');
      await click('dialog .ui-dlg-act .ghost');await click('dialog [aria-label="关闭"]');
      await click('[data-cloud-open-batch]');
      check(find('[data-cloud-character="deepseek"]').disabled,'Ready voice cannot be selected');
      check(find('[data-cloud-character="chatgpt"]').disabled,'Confirmed activation awaiting query cannot be selected again');
      check(find('[data-cloud-character="qwen"]').disabled,'Preparing voice cannot be selected');
      check(find('[data-cloud-character="kimi"]').disabled,'Missing profile cannot be selected');
      check(!find('[data-cloud-character="claude"]').disabled,'A partially profiled role can be selected');
      check(find('[data-cloud-prepare]').disabled,'Empty selection cannot advance');
      await click('[data-cloud-character="claude"]');await click('[data-cloud-prepare]');
      check(calls.filter(row=>row.op==='cloud-batch-preview').length===2&&!calls.some(row=>row.op==='cloud-batch-prepare'),'Cost review does not upload or prepare');
      check(find('dialog').textContent.includes('Claude')&&find('[data-cloud-clone-count]').textContent==='2'&&find('[data-cloud-cost]').textContent==='¥19.80','Confirmation identifies selected character and actual clone count and plan cost');
      const realNow=Date.now;Date.now=()=>realNow()+6*60*1000;emit({});await wait();
      check(find('[data-cloud-confirm]').disabled,'Expired preview cannot be confirmed');Date.now=realNow;
      await click('dialog .ui-dlg-act .ghost');previewBad=true;await click('[data-cloud-prepare]');
      check(find('[data-cloud-confirm]').disabled,'Malformed preview cannot be confirmed');
      await click('dialog .ui-dlg-act .ghost');previewBad=false;await click('[data-cloud-prepare]');await click('[data-cloud-confirm]');
      const sent=calls.find(row=>row.op==='cloud-batch-prepare').payload;
      check(JSON.stringify(sent.selectedCharacterIds)==='["claude"]'&&sent.planHash==='approved-plan'&&sent.consentUpload===true&&sent.consentActivation===true,'Prepare preserves exact plan and both explicit consents');
      check(find('[data-cloud-cancel]')&&!find('[data-cloud-cancel]').disabled,'Running work remains cancellable');
      await click('dialog .ui-dlg-act .primary');check(!find('dialog')&&snapshot.cloudBatchWorking,'Closing progress keeps preparation running');
      await click('[data-cloud-open-batch]');await click('[data-cloud-cancel]');
      check(calls.some(row=>row.op==='cloud-batch-cancel'),'Stop remaining uses existing cancellation');
      await click('dialog [aria-label="关闭"]');
      await click('[data-cloud-open-voices]');check(!calls.some(row=>row.op==='cloud-voices'),'Voice dialog waits for explicit refresh');
      check(find('[data-cloud-voices-refresh]').textContent===''&&find('[data-cloud-voices-refresh]').getAttribute('aria-label')==='刷新音色列表','Refresh remains an icon-only accessible action');
      await click('[data-cloud-voices-refresh]');
      const systemTab=[...document.querySelectorAll('[role="radio"]')].find(element=>element.textContent==='系统音色');systemTab.click();await wait();
      check(!find('[data-cloud-voice-bind="designed-voice"]')&&find('[data-cloud-voice-bind="system-voice"]'),'Category filters real provider categories');
      await click('[data-cloud-voice-bind="system-voice"]');
      const bound=calls.find(row=>row.op==='cloud-bind').payload;
      check(bound.voiceId==='system-voice'&&bound.expectedSelection.scope.characterId==='deepseek'&&bound.expectedSelection.cloudConnectionId==='local','Existing voice binding preserves current scope and configuration');
      check(calls.filter(row=>row.op==='cloud-batch-prepare').length===1,'Existing voice binding does not clone again');
      queryFailure=true;await click('[data-cloud-voices-refresh]');check(find('[role="alert"]').textContent.includes('1008')&&find('[role="alert"]').textContent.includes('余额不足'),'Provider errors keep stable reason and code');
      queryFailure=false;holdQuery=true;await click('[data-cloud-voices-refresh]');
      emit({state:{...snapshot.state,scope:{characterId:'claude'},profile:{id:'claude-reference',version:2}}});await wait();releaseQuery();await wait();
      check(!find('dialog')&&!find('[data-cloud-voice-bind="system-voice"]'),'Late list for previous character cannot appear in new scope');
      holdQuery=false;await click('[data-cloud-open-voices]');await click('[data-cloud-voices-refresh]');
      emit({state:{...snapshot.state,cloudConnections:{selectedId:'other',items:[...snapshot.state.cloudConnections.items,{id:'other',name:'Other MiniMax',configured:true,provider:'minimax',model:'speech-2.8-turbo'}]}}});await wait();
      check(!find('dialog')&&!find('[data-cloud-voice-bind="system-voice"]'),'Changing configuration clears the previous account list');
      await click('[data-cloud-open-voices]');check(!find('[data-cloud-voice-bind="system-voice"]'),'Reopened list requires a new explicit query after configuration change');
      await click('dialog .ui-dlg-act .primary');
      await click('[data-manage-connections="voice"]');await click('[data-cloud-edit="local"]');
      check(find('[data-cloud-field="key"]').value==='','Saved key is never echoed');
      const region=find('[data-cloud-field="provider"]');check(region.options.length===2&&region.value==='minimax','Existing configuration keeps its domestic region');region.value='minimax-global';region.dispatchEvent(new Event('change',{bubbles:true}));await wait();check(find('[data-cloud-save]').disabled,'Changing region requires a new regional key');
      region.value='minimax';region.dispatchEvent(new Event('change',{bubbles:true}));await wait();check(!find('[data-cloud-save]').disabled,'Returning to original region can keep the original key');
      await input('[data-cloud-field="name"]','Renamed configuration');await click('[data-cloud-save]');
      check(calls.find(row=>row.op==='cloud-connection-save').payload.name==='Renamed configuration'&&!Object.hasOwn(calls.find(row=>row.op==='cloud-connection-save').payload,'key'),'Blank edit keeps saved credential');
      check(find('[data-cloud-field="key"]').value==='','Editor clears key after save');
      await input('[data-cloud-field="name"]','New test account');await input('[data-cloud-field="key"]','STUB_KEY_ONLY');await click('[data-cloud-save]');
      check(calls.some(row=>row.op==='cloud-connection-save'&&row.payload.key==='STUB_KEY_ONLY')&&find('[data-cloud-field="key"]').value==='','New configuration submits only entered key and immediately clears editor');
      await click('[data-cloud-use="local"]');check(calls.some(row=>row.op==='cloud-connection-select'&&row.payload.id==='local'),'Saved account selection keeps original action');
      await click('[data-cloud-remove="local"]');check(calls.some(row=>row.op==='cloud-connection-remove'&&row.payload.id==='local'),'Configuration removal keeps original action');
      root.unmount();ipcRenderer.send('result',{checks});
    }catch(error){ipcRenderer.send('result',{error:error.stack,checks});}})();
  `;
  try{
    await build({stdin:{contents:renderer,resolveDir:host,sourcefile:'cloud-ui-dom-fixture.mjs'},bundle:true,format:'iife',platform:'browser',outfile:join(directory,'renderer.js')});
    await writeFile(join(directory,'index.html'),'<!doctype html><div id="root"></div><script src="renderer.js"></script>');
    await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow,ipcMain,session}=require('electron');const fs=require('node:fs'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();ipcMain.once('result',(_,value)=>{fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(value));app.quit();});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});w.loadFile(path.join(__dirname,'index.html'));});setTimeout(()=>app.exit(2),20000);`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const outcome=await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[join(directory,'main.cjs')],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
    assert.equal(outcome.code,0,outcome.output);
    const result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));
    assert.equal(result.error,undefined,result.error);
    assert.ok(result.checks.length>=20);
    context.diagnostic('Actual Electron DOM checks: '+result.checks.length);
  }finally{
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()),'Cleanup must stay within the temporary test directory');
    assert.ok(basename(directory).startsWith('voice-design-cloud-'));
    await rm(directory,{recursive:true,force:true});
  }
});

test('B6/C13: English new draft defaults international while saved domestic and expired labels remain explicit',()=>{
 setLocale('en');try{
  const fresh=renderToStaticMarkup(React.createElement(CloudVoiceConnectionManager,{connections:state.cloudConnections}));assert.match(fresh,/<option value="minimax-global" selected=""/);
  const saved=renderToStaticMarkup(React.createElement(CloudVoiceConnectionEditor,{draft:{id:'fixture',name:'Saved',provider:'minimax',model:'speech-2.8-turbo',configured:true,key:''},onChange(){}}));assert.match(saved,/<option value="minimax" selected=""/);
  const expired=renderToStaticMarkup(React.createElement(CloudVoiceSettings,{snapshot:{state:{...state,cloudBatch:{items:[{characterId:'fixture',status:'expired'}]}}}}));assert.match(expired,/This cloud voice has expired/);assert.match(expired,/Clone again/);
 }finally{setLocale('zh-CN');}
});

test('browsing the other engine cannot open editing operations for the running engine',()=>{
 const snapshot={state:{...state,selectedPackageId:'ai-buddy.voice-breeze'}};
 const html=renderToStaticMarkup(React.createElement(CloudVoiceSettings,{snapshot,browsedPackageId:'ai-buddy.voice-gpt-sovits'}));
 assert.match(html,/先启动此插件/);
 assert.match(html,/<button[^>]*data-cloud-open-voices="true"[^>]*disabled/);
 assert.match(html,/<button[^>]*data-cloud-open-batch="true"[^>]*disabled/);
});
