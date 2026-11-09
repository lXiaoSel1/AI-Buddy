import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createVoiceSettings} from '../src/voice/settings.mjs';import {createVoiceCredentials} from '../src/voice/credentials.mjs';import {createCloudVoiceGateway} from '../src/voice/cloud-host.mjs';import {createVoiceCloud} from '../src/voice/cloud.mjs';
import {providerEndpoint,defaultProviderRegion} from '../src/provider-regions.mjs';import {ModelRouter} from '../src/model-router.mjs';
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
test('regions keep purpose-specific hosts and language only chooses new connection defaults',()=>{
 assert.equal(providerEndpoint('kimi','cn'),'https://api.moonshot.cn/v1');assert.equal(providerEndpoint('kimi','global'),'https://api.moonshot.ai/v1');
 assert.equal(providerEndpoint('minimax','cn','quota'),'https://www.minimax.cn/v1/token_plan/remains');assert.equal(providerEndpoint('minimax','global','voice'),'https://api.minimax.io');
 assert.equal(defaultProviderRegion('en'),'global');assert.equal(defaultProviderRegion('zh-CN'),'cn');
});
test('real saved voice region reaches the matching Python request endpoint and credential once',async t=>{
 for(const [language,expected,provider] of [['en','https://api.minimax.io','minimax-global'],['zh-CN','https://api.minimax.cn','minimax']]){
  const dataRoot=await mkdtemp(join(tmpdir(),'network-region-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const settings=createVoiceSettings({dataRoot}),credentials=createVoiceCredentials({dataRoot,crypto}),gateway=createCloudVoiceGateway({settings,credentials,getLocale:()=>language,profiles:{},cloud:{},getGame:()=>null,resolvePackage:async()=>({})});
  await gateway.action('cloud-connection-save',{name:'Fixture',key:'fixture-'+language});const requests=[],routes=[];
  const cloud=createVoiceCloud({dataRoot,resolveRuntime:async()=>({}),resolveConnection:params=>settings.resolveConnection(params),resolveSecret:ref=>credentials.resolve(ref),resolveProfile:async()=>({id:'profile',version:1,characterId:'fixture'}),network:{childNetworkConfig:async base=>{routes.push(base);return {destinationOrigin:base,routes:[{kind:'direct'}]};}},transport:async(_assets,request)=>{requests.push(request);return {events:(async function*(){yield {type:'result',voices:[]};})(),closed:Promise.resolve(),cancel:async()=>{}};}});
  await cloud.listVoices({engine:'breeze',packageId:'ai-buddy.voice-breeze',characterId:'fixture',profileId:'profile',profileVersion:1});await cloud.close();
  assert.equal((await settings.resolveConnection({packageId:'ai-buddy.voice-breeze'})).provider,provider);assert.equal(requests.length,1);assert.equal(requests[0].base,expected);assert.equal(requests[0].key,'fixture-'+language);assert.deepEqual(routes,[expected]);
 }
});
test('private model services allow an empty key even when a provider preset is used',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'network-model-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));const router=new ModelRouter({dataRoot,crypto,codex:{defaultModel:'fixture',enabled:false,setEnabled:()=>{}}});await router.ready;
 const saved=await router.save({kind:'deepseek',baseUrl:'http://192.168.20.2:8000/v1/chat/completions',model:'fixture',key:''});assert.equal(saved.baseUrl,'http://192.168.20.2:8000/v1');await router.activate(saved.id);assert.equal(router.currentKind,'deepseek');
});
test('ongoing model stream activity extends the idle deadline beyond its original duration',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'network-model-stream-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));let interval;
 const router=new ModelRouter({dataRoot,crypto,timeoutMs:35,codex:{defaultModel:'fixture',enabled:false,setEnabled:()=>{}},fetchImpl:async()=>new Response(new ReadableStream({start(stream){let count=0;interval=setInterval(()=>{const final=++count===5;stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'x'},finish_reason:final?'stop':null}]})+'\n\n'));if(final){clearInterval(interval);stream.close();}},15);},cancel(){clearInterval(interval);}}),{headers:{'content-type':'text/event-stream'}})});await router.ready;
 const saved=await router.save({kind:'custom',baseUrl:'http://127.0.0.1:8000/v1',model:'fixture',key:''});await router.activate(saved.id);router.setEnabled(true);let output='';try{for await(const event of router.stream({messages:[{role:'user',content:'fixture'}],singleSubmission:true}))if(event.type==='text-delta')output+=event.text;}finally{clearInterval(interval);router.setEnabled(false);}assert.equal(output,'xxxxx');
});
