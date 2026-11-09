import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {VoiceCharacters} from '../src/voice/design-ui.mjs';
import {ensureVoiceSession} from '../src/voice/client.mjs';
import {mkdtemp,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceProfiles} from '../src/voice/voice-profiles.mjs';
import {createVoiceController} from '../src/voice/controller.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
const id='ai-buddy.voice-breeze';
const profiles=[
 {id:'old',characterId:'deepseek',engine:'breeze',label:'My recording',importedAt:'2026-11-08T13:20:00Z'},
 {id:'new',characterId:'deepseek',engine:'breeze',label:'My recording',importedAt:'2026-11-09T13:20:00Z'},
 {id:'preset',characterId:'deepseek',engine:'breeze',label:'DeepSeek · 鲸鱼娘 · 预制声线',bundledPreset:{bundleId:'ai-buddy.character-voices-r04',version:1}},
];
const snapshot={working:false,profiles,state:{selectedPackageId:id,scope:{characterId:'deepseek'},profile:profiles[0]}};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];

for(const language of ['zh-CN','en'])test('Her voice footer lists preset first, dates duplicate recordings and selects in '+language,()=>{
 setLocale(language);try{
  const calls=[],node=VoiceCharacters({snapshot,id,onSelect:profileId=>calls.push(profileId)}),select=nodes(node).find(row=>row.type==='select');
  assert.ok(select,'current character needs a profile selector');assert.equal(select.props.value,'old');
  assert.deepEqual(React.Children.toArray(select.props.children).map(row=>row.props.value),['preset','new','old']);
  assert.match(React.Children.toArray(select.props.children)[1].props.children,/My recording · /);
  select.props.onChange({target:{value:'preset'}});assert.deepEqual(calls,['preset']);
  const html=renderToStaticMarkup(node);assert.match(html,language==='en'?/Her voice/:/她的声音/);
  assert.ok(html.indexOf('<select')<html.indexOf('Use my recording')||language!=='en');
  assert.equal(nodes(VoiceCharacters({snapshot:{...snapshot,working:true},id})).find(row=>row.type==='select').props.disabled,true);
  assert.equal(nodes(VoiceCharacters({snapshot:{...snapshot,state:{...snapshot.state,scope:null}},id})).find(row=>row.type==='select')?.props.disabled,true);
  assert.equal(nodes(VoiceCharacters({snapshot:{...snapshot,profiles:[profiles[0]]},id})).some(row=>row.type==='select'),false);
 }finally{setLocale('zh-CN');}
});

test('profile selection refreshes the public profile list and selected snapshot',async()=>{
 let state=snapshot.state;const calls=[],api={onEvent:()=>()=>{},async action(op,payload){calls.push(op);if(op==='state')return state;if(op==='profiles')return profiles;if(op==='profile-select'){state={...state,profile:profiles.find(row=>row.id===payload.profileId)};return state.profile;}return {accepted:true};}};
 const session=ensureVoiceSession(api,{createContext:()=>{throw Error('No audio needed');},captureOptions:{workletURL:'fixture'}}),release=session.retain();
 try{await session.refresh();assert.deepEqual(session.snapshot().profiles,profiles);await session.runAction('profile-select',{profileId:'preset'});assert.equal(session.snapshot().state.profile.id,'preset');assert.equal(calls.filter(op=>op==='profiles').length,2);}finally{await release();}
});

test('new recordings retain import dates after restart and legacy recordings get a non-destructive filesystem date',async t=>{
 const root=await mkdtemp(join(tmpdir(),'voice-profiles-212-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'reference.wav'),bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);await writeFile(file,bytes);
 const store=createVoiceProfiles({dataRoot:root}),params={characterId:'deepseek',engine:'breeze'},row=await store.importProfile({...params,label:'Recording',references:{calm:{file,text:'Reference.',language:'en'}}});
 assert.ok(Number.isFinite(Date.parse(row.importedAt)),'new import exposes its timestamp');
 assert.equal((await createVoiceProfiles({dataRoot:root}).list(params))[0].importedAt,row.importedAt);
 const index=join(root,'voice','profiles','index.json'),saved=JSON.parse(await readFile(index,'utf8'));delete saved.profiles[row.id].importedAt;await writeFile(index,JSON.stringify(saved));const original=await readFile(index,'utf8');
 const legacy=(await store.list(params))[0],info=await lstat(join(root,'voice','profiles',row.id));
 assert.equal(legacy.importedAt,new Date(info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs).toISOString());assert.equal(legacy.importedAtSource,'filesystem');assert.equal((await store.current(params)).id,row.id);assert.equal(await readFile(index,'utf8'),original);
});

test('profile management works while voice is off, and selecting during speech interrupts without a profile-changed error',async()=>{
 const settings=createVoiceSettings();await settings.update({enabled:false});let selected={...profiles[0],version:1};const events=[],scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c',lifeId:'l',operationId:'o'};
 let started,release;const speaking=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve);
 const controller=createVoiceController({settings,getScope:()=>scope,send:event=>events.push(event),listPackages:()=>[{id,installed:true,enabled:true,usable:true,engine:'breeze'}],profiles:{list:async()=>profiles,current:async()=>selected,select:async({profileId})=>(selected={...profiles.find(row=>row.id===profileId),version:1})},assets:{resolve:async()=>({proof:'fixture'}),status:async()=>({state:'ready'})},runtime:{ready:async()=>({ready:true}),cancelCurrent:async()=>release(),cancelCapture:async()=>{},stopEngine:async()=>release(),async *speak(){started();await held;yield {type:'pcm',pcm:Buffer.alloc(4),sampleRate:24000};}}});
 try{
  assert.equal((await controller.action('profiles')).length,3);assert.equal((await controller.action('profile-select',{profileId:'new'})).id,'new');
  await settings.update({enabled:true});const turn={...scope,requestId:'reply',messageId:'message'},lease=await controller.admit(turn);assert.ok(lease);
  await controller.segment({envelope:{...turn,...lease,index:0,segmentId:'reply:voice:0'},text:'Hello',speech_text:'Hello'});await speaking;
  await controller.action('profile-select',{profileId:'preset'});assert.equal(selected.id,'preset');assert.ok(events.some(row=>row.type==='invalidate'&&row.reason==='profile-changed'));assert.equal(events.some(row=>row.code==='VOICE_PROFILE_CHANGED'),false);
 }finally{release();await controller.close();}
});

test('browsing and selecting another installed engine lists its current role voices without changing or stopping the active engine',async()=>{
 const gpt='ai-buddy.voice-gpt-sovits',settings=createVoiceSettings();await settings.update({enabled:true});
 const scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c',lifeId:'l',operationId:'o'},gptRows=profiles.map(row=>({...row,id:'gpt-'+row.id,engine:'gpt',version:1}));
 let selected=gptRows[1];const events=[];
 const controller=createVoiceController({settings,getScope:()=>scope,send:event=>events.push(event),listPackages:()=>[{id,installed:true,enabled:true,usable:true,engine:'breeze'},{id:gpt,installed:true,enabled:false,usable:false,engine:'gpt'}],profiles:{list:async({engine})=>engine==='gpt'?gptRows:profiles,current:async({engine})=>engine==='gpt'?selected:profiles[0],select:async({engine,profileId})=>{assert.equal(engine,'gpt');return selected=gptRows.find(row=>row.id===profileId);}},assets:{status:async()=>({state:'ready'})},runtime:{cancelCurrent:async()=>assert.fail('Inactive profile selection must not interrupt active speech'),cancelCapture:async()=>{},stopEngine:async()=>{},close:async()=>{}}});
 try{
  const listed=await controller.action('profiles',{packageId:gpt});assert.deepEqual(listed.map(row=>row.engine),['gpt','gpt','gpt']);assert.equal(listed.find(row=>row.selected).id,'gpt-new');
  await controller.action('profile-select',{packageId:gpt,profileId:'gpt-preset'});assert.equal(selected.id,'gpt-preset');assert.equal(events.some(row=>row.type==='invalidate'),false);
  const config=await settings.get();assert.equal(config.selectedPackageId,id);assert.equal(config.enabled,true);
  await assert.rejects(controller.action('profiles',{packageId:'unknown'}),{code:'VOICE_PACKAGE_UNAVAILABLE'});
  const snapshot={working:false,profilesByPackage:{[gpt]:await controller.action('profiles',{packageId:gpt})},state:{selectedPackageId:id,scope,profile:profiles[0]}};
  const select=nodes(VoiceCharacters({snapshot,id:gpt})).find(row=>row.type==='select');assert.ok(select);assert.equal(select.props.value,'gpt-preset');assert.deepEqual(React.Children.toArray(select.props.children).map(row=>row.props.value),['gpt-preset','gpt-new','gpt-old']);
 }finally{await controller.close();}
});

test('renderer and host scope inactive-engine profiles without enabling voice or altering its global selection',async t=>{
 const root=await mkdtemp(join(tmpdir(),'voice-browsed-212-')),gpt='ai-buddy.voice-gpt-sovits',store=createVoiceProfiles({dataRoot:root}),settings=createVoiceSettings({dataRoot:root});
 const file=join(root,'reference.wav'),bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);await writeFile(file,bytes);
 const imported=[];for(const engine of ['breeze','gpt'])for(const label of ['First','Second'])imported.push(await store.importProfile({characterId:'deepseek',engine,label,references:{calm:{file,text:'Reference',language:'en'}}}));
 const scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c',lifeId:'l',operationId:'o'},events=[],listeners=new Set();let stops=0;
 const host=createVoiceHost({dataRoot:root,build:root,getGame:()=>({voiceScope:()=>scope}),getPlatform:()=>({voicePackageStatus:()=>[{id,engine:'breeze',installed:true,enabled:true,usable:true},{id:gpt,engine:'gpt',installed:true,enabled:false,usable:false}],resolveVoicePackage:async()=>{throw Object.assign(Error('No models needed'),{code:'VOICE_PLUGIN_REQUIRED'});}}),send:event=>{events.push(event);for(const listener of listeners)listener(event);},components:{settings,profiles:store,local:{async stopEngine(){stops++;},async cancelCapture(){},async close(){}},supervisor:{async close(){}}}});
 const api={onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},action:(...args)=>host.action(...args)},session=ensureVoiceSession(api,{createContext:()=>{throw Error('No audio needed');},captureOptions:{workletURL:'fixture'}}),release=session.retain();
 t.after(async()=>{await release();await host.close();await rm(root,{recursive:true,force:true});});
 assert.equal((await host.action('profiles',{packageId:gpt})).length,2);
 await session.refresh();assert.equal(session.snapshot().profilesByPackage[gpt].length,2);const select=nodes(VoiceCharacters({snapshot:session.snapshot(),id:gpt})).find(row=>row.type==='select');assert.equal(select.props.value,imported[3].id);
 const before=await settings.get();await session.runAction('profile-select',{packageId:gpt,profileId:imported[2].id});assert.deepEqual(await settings.get(),before);assert.equal(stops,0);assert.equal(events.some(row=>row.type==='invalidate'),false);assert.equal((await store.current({characterId:'deepseek',engine:'gpt'})).id,imported[2].id);assert.equal(session.snapshot().profilesByPackage[gpt].find(row=>row.selected).id,imported[2].id);
 await assert.rejects(host.action('profiles',{packageId:'unknown'}),{code:'VOICE_PACKAGE_UNAVAILABLE'});await assert.rejects(host.action('profile-select',{packageId:gpt,characterId:'grok',profileId:imported[2].id}),{code:'VOICE_SCOPE_FORGED'});
});
