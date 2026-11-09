import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VoiceParts} from '../src/voice/design-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';

const id='ai-buddy.voice-breeze';
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
function snapshot(code,tts={state:'ready',bytes:20,downloadBytes:20}){
 return {working:false,state:{selectedPackageId:id,settings:{packages:{[id]:{ttsProvider:'local'}}},assets:{asr:{state:code==='VOICE_ASSET_MISSING'?'missing':'error',code,verificationFailed:true,bytes:10,downloadBytes:10},tts},assetProgress:{state:'failed',operation:'verify',kind:'asr',engineId:id,code}}};
}

for(const language of ['zh-CN','en']){
 for(const code of ['VOICE_ASSET_CHANGED','VOICE_ASSET_VERIFY','ABORT_ERR'])test(language+' '+code+' offers a real reverify action without a download estimate',()=>{
  setLocale(language);try{
   const calls=[],node=VoiceParts({snapshot:snapshot(code),id,onVerify:kind=>calls.push(kind)}),verify=nodes(node).find(row=>row.props?.['data-voice-verify']==='asr');
   assert.ok(verify,'A transient failure must retain the verification action');assert.match(verify.props.kind,/primary/);verify.props.onClick();assert.deepEqual(calls,['asr']);
   const html=renderToStaticMarkup(node);assert.match(html,language==='en'?/Verify again/:/重新校验/);assert.doesNotMatch(html,language==='en'?/please download again|Selected download:|Download 10 B/:/请重新下载|所选组件下载|下载 10 B/);
  }finally{setLocale('zh-CN');}
 });
 for(const code of ['VOICE_ASSET_HASH','VOICE_ASSET_MISSING'])test(language+' '+code+' retains secondary reverify beside the download action',()=>{
  setLocale(language);try{
   const node=VoiceParts({snapshot:snapshot(code),id}),all=nodes(node),download=all.find(row=>row.props?.['data-voice-download']==='asr'),verify=all.find(row=>row.props?.['data-voice-verify']==='asr');
   assert.ok(verify);assert.ok(download);assert.match(download.props.kind,/primary/);assert.doesNotMatch(verify.props.kind,/primary/);
   const html=renderToStaticMarkup(node);assert.match(html,language==='en'?/Verification failed, please download again/:/校验没通过，请重新下载/);assert.match(html,language==='en'?/Selected download: 10 B/:/所选组件下载 10 B/);
  }finally{setLocale('zh-CN');}
 });
 test(language+' verification in progress never adds its payload to the download total',()=>{
  setLocale(language);try{
   const value=snapshot('VOICE_ASSET_HASH',{state:'preparing',bytes:20,downloadBytes:20});value.working=true;value.state.assetProgress={state:'preparing',operation:'verify',kind:'breeze',engineId:id,receivedBytes:5,totalBytes:20};
   const html=renderToStaticMarkup(VoiceParts({snapshot:value,id}));assert.match(html,language==='en'?/Selected download: 10 B/:/所选组件下载 10 B/);assert.doesNotMatch(html,/30 B/);
  }finally{setLocale('zh-CN');}
 });
}

test('host verification preserves a real asset error code instead of requiring a download for every failure',async t=>{
 const root=await mkdtemp(join(tmpdir(),'voice-ui-213-')),seed=join(root,'seed'),directory=join(root,'package');await mkdir(seed);await mkdir(directory);
 const bytes=Buffer.from('verified component'),descriptor={schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',python:'python.exe',files:[{path:'python.exe',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 await writeFile(join(seed,'python.exe'),bytes);await writeFile(join(directory,'assets.json'),JSON.stringify(descriptor));
 const record={sourceId:'official',archiveSha256:'old',directory},assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async()=>({...record,shared:record}),fetchImpl:()=>{throw Error('No network allowed');}});
 await assets.prepare('asr',{engineId:'breeze',localRoot:seed});const resolved=await assets.resolve('asr','breeze');record.archiveSha256='new';await writeFile(resolved.python,Buffer.alloc(bytes.length,9));
 const settings=createVoiceSettings({dataRoot:root});await settings.update({enabled:true,packages:{[id]:{ttsProvider:'minimax'}}});
 const host=createVoiceHost({dataRoot:root,build:root,getGame:()=>null,getPlatform:()=>({voicePackageStatus:()=>[{id,engine:'breeze',installed:true,enabled:true,usable:true,trusted:true}]}),components:{assets,settings,local:{async stopEngine(){},async cancelCapture(){},async close(){}},supervisor:{async close(){}}}});
 t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
 await assert.rejects(host.action('assets-verify',{kind:'asr'}),{code:'VOICE_ASSET_HASH'});
});
