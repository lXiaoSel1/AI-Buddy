import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {PET_CHARACTERS} from '../src/pet-characters.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {VoiceCharacters,VoiceParts} from '../src/voice/design-ui.mjs';
import {ensureVoiceSession} from '../src/voice/client.mjs';

test('one read-only engine request returns all 11 own selections with one profile-index read and preserves current scope and choices',async t=>{
 const root=await mkdtemp(join(tmpdir(),'voice-ui-r2-')),breeze='ai-buddy.voice-breeze',gpt='ai-buddy.voice-gpt-sovits',settings=createVoiceSettings({dataRoot:root});await settings.update({enabled:true});
 const directory=join(root,'voice','profiles'),index=join(directory,'index.json'),saved={version:1,profiles:{},selections:{}};await mkdir(directory,{recursive:true});
 for(const engine of ['breeze','gpt'])for(const character of PET_CHARACTERS){const id=engine+'-'+character.id;saved.profiles[id]={id,version:1,characterId:character.id,engine,label:engine+' '+character.id,references:{calm:{}}};saved.selections[character.id+':'+engine]=id;}
 delete saved.profiles['gpt-hunyuan'];await writeFile(index,JSON.stringify(saved));const before=await readFile(index,'utf8'),scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c',lifeId:'l',operationId:'o'},events=[];
 const host=createVoiceHost({dataRoot:root,build:root,getGame:()=>({voiceScope:()=>scope}),getPlatform:()=>({voicePackageStatus:()=>[{id:breeze,engine:'breeze',installed:true,enabled:true,usable:true},{id:gpt,engine:'gpt',installed:true,enabled:false,usable:false}]}),send:event=>events.push(event),components:{local:{async stopEngine(){},async cancelCapture(){},async close(){}},supervisor:{async close(){}}}});
 t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
 const original=fsPromises.readFile;let indexReads=0;fsPromises.readFile=async function(file,...args){if(String(file)===index)indexReads++;return original.call(this,file,...args);};syncBuiltinESMExports();
 let result;try{result=await host.action('profile-selections',{packageId:gpt});}finally{fsPromises.readFile=original;syncBuiltinESMExports();}
 assert.equal(result.packageId,gpt);assert.equal(result.engine,'gpt');assert.equal(result.selections.length,11);assert.equal(indexReads,1);
 assert.deepEqual(result.selections.map(row=>[row.characterId,row.profile?.id??null]),PET_CHARACTERS.map(row=>[row.id,row.id==='hunyuan'?null:'gpt-'+row.id]));
 assert.equal(await readFile(index,'utf8'),before);assert.equal((await settings.get()).selectedPackageId,breeze);assert.equal((await settings.get()).enabled,true);assert.deepEqual(scope,{channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c',lifeId:'l',operationId:'o'});assert.equal(events.some(row=>row.type==='invalidate'),false);
 await assert.rejects(host.action('profile-selections',{packageId:'unknown'}),{code:'VOICE_PACKAGE_UNAVAILABLE'});await assert.rejects(host.action('profile-selections',{packageId:gpt,characterId:'grok'}),{code:'VOICE_SCOPE_FORGED'});
});

const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
for(const language of ['zh-CN','en'])test('browsed engine rows show own short preset/custom/missing/failure labels and verification copy in '+language,()=>{
 setLocale(language);try{
  const id='ai-buddy.voice-gpt-sovits',long='A very long user recording label that stays complete in its title',preset={id:'gpt-deepseek',characterId:'deepseek',engine:'gpt',label:'DeepSeek · 鲸鱼娘 · 预制声线',bundledPreset:{bundleId:'ai-buddy.character-voices-r04',version:1},selected:true};
  const selections=PET_CHARACTERS.map(({id:characterId})=>({characterId,profile:characterId==='seed'?null:characterId==='grok'?{id:'custom-grok',characterId,engine:'gpt',label:long}:{...preset,id:'gpt-'+characterId,characterId}}));
  const snapshot={working:false,state:{selectedPackageId:'ai-buddy.voice-breeze',scope:{characterId:'deepseek'},settings:{packages:{[id]:{ttsProvider:'local'}}}},profilesByPackage:{[id]:[preset,{id:'custom-deepseek',characterId:'deepseek',engine:'gpt',label:long}]},profileSelectionsByPackage:{[id]:{state:'ready',selections}}};
  const node=VoiceCharacters({snapshot,id}),names=nodes(node).filter(row=>row.props?.className==='vx-cname');assert.equal(names.length,11);assert.equal(names[0].props.children,language==='en'?'Preset voice':'预制声线');assert.equal(names[1].props.children,long);assert.equal(names[1].props.title,long);assert.equal(names[2].props.children,language==='en'?'No voice yet':'还没有声音');assert.equal(names.some(row=>row.props.children===(language==='en'?'Not checked':'尚未检查')),false);
  const select=nodes(node).find(row=>row.type==='select');assert.equal(select.props.title,language==='en'?'DeepSeek · Whale-chan · Preset voice':preset.label);assert.equal(React.Children.toArray(select.props.children)[1].props.title,long);
  const failed=nodes(VoiceCharacters({snapshot:{...snapshot,profileSelectionsByPackage:{[id]:{state:'failed'}}},id})).filter(row=>row.props?.className==='vx-cname');assert.ok(failed.every(row=>row.props.children===(language==='en'?'Not checked':'尚未检查')));
  const cases=[['ready','verification-needed',language==='en'?'The GPT-SoVITS voice model needs verification':'GPT-SoVITS 声音模型需要校验'],['verification-needed','ready',language==='en'?'Speech recognition needs verification':'语音识别需要校验'],['verification-needed','verification-needed',language==='en'?'Voice parts need verification':'语音组件需要校验']];
  for(const [asr,tts,title] of cases){const parts=VoiceParts({snapshot:{...snapshot,componentStatuses:{[id]:{asr:{state:asr,bytes:10},tts:{state:tts,bytes:20}}}},id}),html=renderToStaticMarkup(parts);assert.ok(html.includes(title));assert.ok(html.includes(language==='en'?'Voice works after verification passes; text chat works meanwhile.':'校验通过后才能配音，期间文字聊天照常。'));assert.doesNotMatch(html,/Selected download: 0 B|所选组件下载 0 B/);}
  const missing=renderToStaticMarkup(VoiceParts({snapshot:{...snapshot,componentStatuses:{[id]:{asr:{state:'ready'},tts:{state:'missing',downloadBytes:20}}}},id}));assert.ok(missing.includes(language==='en'?'The GPT-SoVITS voice model is not ready':'GPT-SoVITS 声音模型还没准备好'));assert.ok(missing.includes(language==='en'?'Selected download: 20 B':'所选组件下载 20 B'));
 }finally{setLocale('zh-CN');}
});

for(const language of ['zh-CN','en'])test('zero-download parts retain an actionable check-again footer without a total in '+language,()=>{
 setLocale(language);try{
  const id='ai-buddy.voice-gpt-sovits',calls=[];
  for(const state of ['ready','verification-needed']){
   const snapshot={working:false,state:{selectedPackageId:id,settings:{packages:{[id]:{ttsProvider:'local'}}}},componentStatuses:{[id]:{asr:{state,bytes:10,downloadBytes:0},tts:{state,bytes:20,downloadBytes:0}}}};
   const node=VoiceParts({snapshot,id,onRefresh:()=>calls.push(state)}),footer=nodes(node).find(row=>row.props?.className==='vx-comps-f'),label=language==='en'?'Check again':'重新检查';
   assert.ok(footer,'checking again remains available when no download is needed');
   const refresh=nodes(footer).find(row=>row.props?.children===label);assert.ok(refresh);assert.equal(refresh.props.disabled,false);refresh.props.onClick();
   const html=renderToStaticMarkup(node);assert.ok(html.includes(label));assert.doesNotMatch(html,/Selected download:|所选组件下载|Selected parts, installed:|所选组件展开后/);
   const working=nodes(VoiceParts({snapshot:{...snapshot,working:true},id})).find(row=>row.props?.children===label);assert.equal(working.props.disabled,true);
  }
  assert.deepEqual(calls,['ready','verification-needed']);
 }finally{setLocale('zh-CN');}
});

test('renderer batches character selections once per installed local engine during refresh and retains a read failure as unchecked',async()=>{
 const id='ai-buddy.voice-breeze',gpt='ai-buddy.voice-gpt-sovits',calls=[],state={selectedPackageId:id,scope:null,settings:{packages:{[id]:{ttsProvider:'local'},[gpt]:{ttsProvider:'local'}}},packages:[{id,installed:true},{id:gpt,installed:true}]};
 const api={onEvent:()=>()=>{},async action(op,payload){calls.push({op,payload});if(op==='state')return state;if(op==='profile-selections'){if(payload.packageId===gpt)throw Object.assign(Error('Profile read failed'),{code:'EACCES'});return {packageId:id,engine:'breeze',selections:PET_CHARACTERS.map(({id:characterId})=>({characterId,profile:null}))};}return {accepted:true};}};
 const session=ensureVoiceSession(api,{createContext:()=>{throw Error('No audio needed');},captureOptions:{workletURL:'fixture'}}),release=session.retain();
 try{await session.refresh();assert.deepEqual(calls.filter(row=>row.op==='profile-selections').map(row=>row.payload),[{packageId:id},{packageId:gpt}]);assert.equal(session.snapshot().profileSelectionsByPackage[id].selections.length,11);assert.equal(session.snapshot().profileSelectionsByPackage[gpt].state,'failed');assert.equal(session.snapshot().profileSelectionsByPackage[gpt].code,'EACCES');assert.equal(session.snapshot().state.selectedPackageId,id);}finally{await release();}
});
