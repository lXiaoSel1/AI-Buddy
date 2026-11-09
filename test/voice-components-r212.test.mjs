import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';
import {VoiceParts} from '../src/voice/design-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {ensureVoiceSession} from '../src/voice/client.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'voice-components-212-')),seed=join(root,'seed'),directory=join(root,'package');await mkdir(seed);await mkdir(directory);
 const bytes=Buffer.from('verified component'),descriptor=Buffer.from(JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',python:'python.exe',files:[{path:'python.exe',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:'https://example.com/python.exe'}]}));
 await writeFile(join(seed,'python.exe'),bytes);await writeFile(join(directory,'assets.json'),descriptor);
 let archive='old',downloads=0;const record=()=>({sourceId:'official',archiveSha256:archive,directory}),assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async()=>({...record(),shared:record()}),fetchImpl:async()=>{downloads++;return new Response(bytes);}});
 t.after(async()=>{await assets.close();await rm(root,{recursive:true,force:true});});
 await assets.prepare('asr',{engineId:'breeze',localRoot:seed});const resolved=await assets.resolve('asr','breeze');archive='new';
 return {assets,root,resolved,downloads:()=>downloads};
}

test('package upgrade needs user verification and never automatically downloads or rebinds',async t=>{
 const f=await fixture(t),before=await readFile(join(f.resolved.root,'.ready'),'utf8');
 assert.equal((await f.assets.status('asr','breeze')).state,'verification-needed');
 await assert.rejects(f.assets.prepare('asr',{engineId:'breeze'}),{code:'VOICE_ASSET_VERIFY_REQUIRED'});
 assert.equal(await readFile(join(f.resolved.root,'.ready'),'utf8'),before);assert.equal(f.downloads(),0);
 const progress=[];assert.deepEqual(await f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>progress.push(row)}),{state:'ready',reused:true});
 assert.equal((await f.assets.status('asr','breeze')).state,'ready');assert.equal(f.downloads(),0);assert.ok(progress.some(row=>row.phase==='verifying'));
});

test('failed verification never downloads, marks recovery and explicit Download replaces damaged bytes',async t=>{
 const f=await fixture(t);await writeFile(f.resolved.python,Buffer.alloc(18));
 await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true}),{code:'VOICE_ASSET_HASH'});
 assert.equal(f.downloads(),0);assert.equal((await f.assets.status('asr','breeze')).verificationFailed,true);
 assert.deepEqual(await f.assets.prepare('asr',{engineId:'breeze',forceDownload:true}),{state:'ready',reused:false});
 assert.equal(f.downloads(),1);assert.equal((await f.assets.status('asr','breeze')).state,'ready');assert.equal((await readFile(f.resolved.python)).toString(),'verified component');
 await rm(f.resolved.python);
 assert.equal((await f.assets.status('asr','breeze')).state,'ready','ordinary status reports the completed install without scanning payload files');
 await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true}),{code:'VOICE_ASSET_MISSING'});assert.equal((await f.assets.status('asr','breeze')).state,'missing');assert.equal(f.downloads(),1);
 await f.assets.prepare('asr',{engineId:'breeze',forceDownload:true});assert.equal(f.downloads(),2);assert.equal((await f.assets.status('asr','breeze')).state,'ready');
});

const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
for(const language of ['zh-CN','en'])test('existing parts show primary Verify beside secondary Download and exclude verification from totals in '+language,()=>{
 setLocale(language);try{
  const id='ai-buddy.voice-breeze',snapshot={working:false,state:{selectedPackageId:id,settings:{packages:{[id]:{ttsProvider:'local'}}},assets:{asr:{state:'verification-needed',bytes:10,downloadBytes:10},tts:{state:'missing',bytes:20,downloadBytes:20}}}},calls=[];
  const node=VoiceParts({snapshot,id,onVerify:kind=>calls.push(kind)}),verify=nodes(node).find(row=>row.props?.['data-voice-verify']==='asr'),download=nodes(node).find(row=>row.props?.['data-voice-download']==='asr');
  assert.ok(verify);assert.match(verify.props.kind,/primary/);assert.doesNotMatch(download.props.kind,/primary/);verify.props.onClick();assert.deepEqual(calls,['asr']);
  const html=renderToStaticMarkup(node);assert.match(html,language==='en'?/Needs verification/:/需要校验/);assert.match(html,language==='en'?/Selected download: 20 B/:/所选组件下载 20 B/);
  const progress={...snapshot,state:{...snapshot.state,assetProgress:{state:'preparing',operation:'verify',phase:'verifying',kind:'asr',engineId:id,receivedBytes:5,totalBytes:10}}};
  assert.match(renderToStaticMarkup(VoiceParts({snapshot:progress,id})),language==='en'?/Verifying · 5 B \/ 10 B/:/正在校验 · 5 B \/ 10 B/);
  const failed={...snapshot,state:{...snapshot.state,assetProgress:{state:'failed',operation:'verify',kind:'asr',engineId:id},assets:{...snapshot.state.assets,asr:{...snapshot.state.assets.asr,state:'error',code:'VOICE_ASSET_HASH',verificationFailed:true}}}};
  assert.match(renderToStaticMarkup(VoiceParts({snapshot:failed,id})),language==='en'?/Verification failed, please download again/:/校验没通过，请重新下载/);
 }finally{setLocale('zh-CN');}
});

test('host component summary works without a role and explicit Verify reaches the download-free path',async t=>{
 const f=await fixture(t),id='ai-buddy.voice-breeze',settings=createVoiceSettings({dataRoot:f.root});await settings.update({enabled:true,packages:{[id]:{ttsProvider:'minimax'}}});
 const events=[],local={async stopEngine(){},async cancelCapture(){},async close(){}};
 const host=createVoiceHost({dataRoot:f.root,build:f.root,getGame:()=>null,getPlatform:()=>({voicePackageStatus:()=>[{id,engine:'breeze',installed:true,enabled:true,usable:true,trusted:true}]}),send:event=>events.push(event),components:{assets:f.assets,settings,local,supervisor:{async close(){}}}});t.after(()=>host.close());
 const summary=await host.action('component-status',{packageId:id});assert.equal(summary.asr.state,'verification-needed');assert.equal(summary.tts.state,'not-required');assert.equal(summary.ready,false);assert.equal(summary.state,'verification-needed');assert.equal(f.downloads(),0);
 await assert.rejects(host.action('component-status',{packageId:'untrusted-package'}),{code:'VOICE_PACKAGE_UNAVAILABLE'});
 await host.action('assets-verify',{kind:'asr'});assert.equal((await host.action('component-status',{packageId:id})).ready,true);assert.equal(f.downloads(),0);assert.ok(events.some(row=>row.type==='asset-progress'&&row.operation==='verify'&&row.phase==='verifying'));
});

test('inactive engine component status shows Verify with zero downloads and verification preserves the current voice',async t=>{
 const root=await mkdtemp(join(tmpdir(),'voice-inactive-parts-212-')),records={},seed=join(root,'seed'),bytes=Buffer.from('verified component');await mkdir(seed);await writeFile(join(seed,'python.exe'),bytes);
 for(const kind of ['asr','breeze','gpt']){const directory=join(root,kind);await mkdir(directory);await writeFile(join(directory,'assets.json'),JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind,version:'1',python:'python.exe',files:[{path:'python.exe',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:'https://example.com/'+kind}]}));records[kind]={sourceId:'official',archiveSha256:'old-'+kind,directory};}
 let downloads=0,stops=0;const assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async id=>({...records[id.includes('gpt')?'gpt':'breeze'],shared:records.asr}),fetchImpl:async()=>{downloads++;throw Error('No network allowed');}});
 for(const kind of ['asr','breeze','gpt'])await assets.prepare(kind,{engineId:kind==='gpt'?'gpt':'breeze',localRoot:seed});records.gpt.archiveSha256='new-gpt';
 const breeze='ai-buddy.voice-breeze',gpt='ai-buddy.voice-gpt-sovits',settings=createVoiceSettings({dataRoot:root});await settings.update({enabled:true});
 const listeners=new Set(),calls=[],host=createVoiceHost({dataRoot:root,build:root,getGame:()=>null,getPlatform:()=>({voicePackageStatus:()=>[{id:breeze,engine:'breeze',installed:true,enabled:true,usable:true},{id:gpt,engine:'gpt',installed:true,enabled:true,usable:true}]}),send:event=>{for(const listener of listeners)listener(event);},components:{assets,settings,local:{async stopEngine(){stops++;},async cancelCapture(){},async close(){}},supervisor:{async close(){}}}});
 const api={onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},action:(op,payload)=>{calls.push(op);return host.action(op,payload);}},session=ensureVoiceSession(api,{createContext:()=>{throw Error('No audio needed');},captureOptions:{workletURL:'fixture'}}),release=session.retain();
 t.after(async()=>{await release();await host.close();await rm(root,{recursive:true,force:true});});
 await session.refresh();assert.equal(session.snapshot().componentStatuses[gpt].state,'verification-needed');assert.equal(session.snapshot().componentStatuses[breeze].ready,true);assert.equal(downloads,0);
 const before=await settings.get(),node=VoiceParts({snapshot:session.snapshot(),id:gpt,onVerify:kind=>session.runAction('assets-verify',{kind,packageId:gpt})}),verify=nodes(node).find(row=>row.props?.['data-voice-verify']==='gpt');assert.ok(verify);assert.doesNotMatch(renderToStaticMarkup(node),/所选组件下载 0 B/);
 await verify.props.onClick();assert.equal(downloads,0);assert.equal(stops,0);assert.deepEqual(await settings.get(),before);assert.equal(session.snapshot().componentStatuses[gpt].ready,true);assert.equal(session.snapshot().state.selectedPackageId,breeze);
 const statusReads=calls.filter(op=>op==='component-status').length;for(const listener of listeners)listener({type:'audio',phase:'pcm',pcm:Buffer.alloc(4),sampleRate:24000});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.filter(op=>op==='component-status').length,statusReads);
});
