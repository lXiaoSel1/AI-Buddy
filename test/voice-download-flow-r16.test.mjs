import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';

const ids=['ai-buddy.voice-breeze','ai-buddy.voice-gpt-sovits'];
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,{provider='local',hold=false,assetsOverride}={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'voice-host-flow-r16-'));
 const settings=createVoiceSettings();await settings.update({enabled:false,packages:{[ids[0]]:{ttsProvider:provider,credentialRef:'fixture:key'}}});
 const events=[],prepared=[],loaded=[],imports=[],started=deferred(),gate=deferred();
 let scope={channel:'app-private',characterId:'alice',personaId:'one',conversationId:'chat',lifeId:'life',operationId:'one'};
 const packages=ids.map((id,i)=>({id,engine:i?'gpt':'breeze',installed:true,enabled:true,usable:true,trusted:true,sourceId:'official',archiveSha256:'package-'+i}));
 const assets=assetsOverride??{async status(){return {state:'missing',bytes:100};},async resolve(){return {proof:'fixture'};},
 async prepareSelected(request){prepared.push(request);request.onProgress({kind:'asr',state:'preparing',phase:'downloading',receivedBytes:25,totalBytes:100});started.resolve();if(hold)await gate.promise;request.signal.throwIfAborted();return {ready:true};},
  async prepare(kind,request){imports.push({kind,...request});return {ready:true};},async close(){}};
 const runtime={async prepare(request){loaded.push(request);return {ready:true};},async ready(){return {ready:true};},async stopEngine(){},async cancelCapture(){},async close(){}};
 const host=createVoiceHost({dataRoot,build:'unused',getGame:()=>({voiceScope:()=>scope,voiceCancel(){}}),getPlatform:()=>({voicePackageStatus:()=>packages,resolveVoicePackage:async()=>({assertCurrent(){}})}),send:event=>events.push(event),chooseAssets:async()=>{imports.push('choose');return 'E:\\fixture';},components:{settings,assets,runtime,profiles:{async current({characterId,engine}){return {id:'profile-'+characterId,version:1,characterId,engine};}},cloud:{async status(){return {state:'ready'};}},credentials:{},supervisor:{async close(){}}}});
 t.after(async()=>{gate.resolve();await host.close();await rm(dataRoot,{recursive:true,force:true});});
 return {host,settings,events,prepared,loaded,imports,started:started.promise,release:gate.resolve,switchScope(){scope={...scope,characterId:'bob',lifeId:'bob-life'};}};
}

test('first enable prepares the selected local engine and shared resources before loading',async t=>{
 const f=await fixture(t);await f.host.action('configure',{enabled:true});
 assert.deepEqual(f.prepared.map(({engineId,provider})=>({engineId,provider})),[{engineId:ids[0],provider:'local'}]);
 assert.equal(f.loaded.length,1);assert.equal(f.loaded[0].packageId,ids[0]);assert.equal(f.imports.length,0);
 assert.equal((await f.host.action('state')).preparation.state,'ready');
});

test('cloud first enable prepares shared resources with the cloud selection only',async t=>{
 const f=await fixture(t,{provider:'minimax'});await f.host.action('configure',{enabled:true});
 assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].provider,'minimax');assert.equal(f.loaded[0].speechProvider,'minimax');
 assert.equal(f.imports.length,0);
});

test('component progress survives state reads and page or character navigation',async t=>{
 const f=await fixture(t,{hold:true}),enable=f.host.action('configure',{enabled:true});await f.started;
 assert.equal((await f.host.action('state')).assetProgress.receivedBytes,25);
 f.switchScope();await f.host.controller.invalidate('scope-changed');
 assert.equal(f.prepared[0].signal.aborted,false);assert.equal((await f.host.action('state')).assetProgress.phase,'downloading');
 f.release();await enable;assert.equal(f.loaded.length,1);assert.equal(f.loaded[0].characterId,'bob');
});

for(const operation of ['assets-cancel','disable','reselect','stop','close'])test(operation+' fences late component completion from loading or re-enabling voice',async t=>{
 const f=await fixture(t,{hold:true}),enable=f.host.action('configure',{enabled:true});await f.started;
 const cancel=operation==='disable'?f.host.action('configure',{enabled:false}):operation==='reselect'?f.host.action('configure',{enabled:false,selectedPackageId:ids[1]}):operation==='close'?f.host.close():f.host.action(operation);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.prepared[0].signal.aborted,true);
 f.release();await cancel;await enable;assert.equal(f.loaded.length,0);
 if(operation==='disable'||operation==='reselect')assert.equal((await f.settings.get()).enabled,false);
 assert.equal(f.events.some(event=>event.type==='asset-progress'&&event.state==='failed'),false);
});

for(const change of ['provider','engine'])test('changing '+change+' cancels its predecessor and loads only the new selection',async t=>{
 const f=await fixture(t,{hold:true}),enable=f.host.action('configure',{enabled:true});await f.started;
 const changed=f.host.action('configure',change==='provider'?{packages:{[ids[0]]:{ttsProvider:'minimax'}}}:{selectedPackageId:ids[1]});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.prepared[0].signal.aborted,true);
 f.release();await changed;await enable;
 assert.equal(f.prepared.length,2);assert.equal(f.loaded.length,1);
 assert.equal(f.loaded[0].packageId,change==='provider'?ids[0]:ids[1]);assert.equal(f.loaded[0].speechProvider,change==='provider'?'minimax':'local');
});

test('Download has no folder picker and offline Import explicitly chooses a folder',async t=>{
 const f=await fixture(t);await f.host.action('assets-prepare',{kind:'breeze'});
 assert.equal(f.imports.length,1);assert.equal(f.imports[0].localRoot,undefined);
 await f.host.action('assets-import',{kind:'asr'});
 assert.equal(f.imports[1],'choose');assert.equal(f.imports[2].localRoot,'E:\\fixture');
});

for(const provider of ['local','minimax'])test(provider+' first enable reaches real assets with streamed bytes and leaves the other engine missing',async t=>{
 const root=await mkdtemp(join(tmpdir(),'voice-host-download-r16-')),records={},requests=[];
 for(const kind of ['asr','breeze','gpt']){
  const directory=join(root,kind),bytes=Buffer.from(kind+' fixture');await mkdir(directory);
  await writeFile(join(directory,'assets.json'),JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind,version:'1',python:'python.exe',files:[{path:'python.exe',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:'https://fixture.example/'+kind}]}));
  records[kind]={directory,sourceId:'fixture',archiveSha256:'fixture-'+kind};
 }
 const assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async id=>({...records[id===ids[0]?'breeze':'gpt'],shared:records.asr}),fetchImpl:async url=>{requests.push(String(url));const bytes=Buffer.from(String(url).split('/').at(-1)+' fixture');return new Response(new ReadableStream({start(stream){stream.enqueue(bytes.subarray(0,2));stream.enqueue(bytes.subarray(2));stream.close();}}));}});
 const f=await fixture(t,{provider,assetsOverride:assets});t.after(async()=>{await assets.close();await rm(root,{recursive:true,force:true});});
 await f.host.action('configure',{enabled:true});
 assert.deepEqual(requests,provider==='local'?['https://fixture.example/asr','https://fixture.example/breeze']:['https://fixture.example/asr']);
 assert.equal((await assets.status('gpt',ids[1])).state,'missing');assert.equal(f.loaded.length,1);
 if(provider==='minimax')assert.equal((await assets.status('breeze',ids[0])).state,'missing');
});
