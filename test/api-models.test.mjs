import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiTransport,normalizeApiUsage} from '../src/api-transport.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {MODEL_PRESETS,apiBaseUrl} from '../src/model-presets.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {mockModelServer,fakeCrypto,stubCodex} from './support/mock-model-server.mjs';
async function output(stream){let text='';for await(const part of stream)if(part.type==='text-delta')text+=part.text;return text;}
async function setup(t,legacy=false){const server=await mockModelServer();t.after(()=>server.close());const dataRoot=await mkdtemp(join(tmpdir(),'whale-api-')),codex=stubCodex(),usage=[],router=new ModelRouter({dataRoot,codex,legacy,crypto:fakeCrypto,onUsage:value=>usage.push(value),timeoutMs:1000});await router.ready;t.after(()=>router.close());return {router,codex,server,dataRoot,usage};}
for(const protocol of ['chat-completions','responses','gemini','anthropic'])test(protocol+' streams fragmented UTF8, excludes reasoning, normalizes usage and model list',async t=>{
 const server=await mockModelServer();t.after(()=>server.close());const usage=[],transport=new ApiTransport({onUsage:value=>usage.push(value)}),profile={id:'x',kind:'custom',protocol,baseUrl:server.url+'/'+protocol,key:'fake-key',model:'fixture'};
 assert.equal(await output(transport.stream(profile,{system:'你是情绪分类器',messages:[{role:'user',content:'开心'}],purpose:'emotion',maxTokens:30})),'cheerful');assert.equal(usage.length,1);assert.equal(usage[0].usage.input,11);assert.equal(usage[0].usage.output,7);
 const request=server.requests[0];assert.equal(protocol==='gemini'?request.body.generationConfig.maxOutputTokens:protocol==='responses'?request.body.max_output_tokens:request.body.max_tokens,2048);assert.equal(request.headers[protocol==='gemini'?'x-goog-api-key':protocol==='anthropic'?'x-api-key':'authorization'],protocol==='gemini'||protocol==='anthropic'?'fake-key':'Bearer fake-key');assert.equal(request.body.tools,undefined);
 assert.deepEqual(await transport.listModels(profile),[{id:'fixture',name:protocol==='gemini'?'models/fixture':'fixture'}]);
 for(const failure of [{status:401},{status:429},{incomplete:true},{empty:true}]){server.setFailure(failure);await assert.rejects(()=>output(transport.stream(profile,{messages:[{role:'user',content:'hi'}]})),error=>!error.message.includes('PRIVATE_KEY')&&/无效|受限|中断|没有返回/.test(error.message));}
});
test('API URL validation rejects credentials, insecure remote HTTP and query tokens',()=>{for(const url of ['http://example.com','https://key:secret@example.com','https://example.com?key=secret','file:///x'])assert.throws(()=>apiBaseUrl(url));assert.equal(apiBaseUrl('http://127.0.0.1:1234/v1/'),'http://127.0.0.1:1234/v1');assert.equal(normalizeApiUsage({},'responses').input,null);assert.equal(normalizeApiUsage({input_tokens:3,output_tokens:4,cache_read_input_tokens:5,cache_creation_input_tokens:2},'anthropic').total,14);});
test('Four protocols accept complete JSON replies and reject malformed/error payloads without exposing provider details',async()=>{
 const payloads={'chat-completions':{choices:[{message:{content:'正文'},finish_reason:'stop'}]},responses:{output:[{content:[{type:'output_text',text:'正文'},{type:'reasoning',text:'secret reasoning'}]}]},gemini:{candidates:[{content:{parts:[{text:'secret reasoning',thought:true},{text:'正文'}]},finishReason:'STOP'}]},anthropic:{content:[{type:'thinking',thinking:'secret reasoning'},{type:'text',text:'正文'}]}};
 for(const [protocol,payload] of Object.entries(payloads)){
  const profile={protocol,baseUrl:'https://example.com/v1',key:'fixture',model:'manual'},transport=new ApiTransport({fetchImpl:async()=>new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}})});
  assert.equal(await output(transport.stream(profile,{messages:[{role:'user',content:'hi'}]})),'正文');
  for(const raw of ['<broken>',JSON.stringify({error:{message:'SECRET_PROVIDER_DETAIL'}})]){transport.fetch=async()=>new Response(raw,{headers:{'content-type':'application/json'}});await assert.rejects(()=>output(transport.stream(profile,{})),e=>/模型/.test(e.message)&&!e.message.includes('SECRET'));}
 }
});
test('Eight presets, custom and local Codex persist encrypted keys, remain offline and resume chosen model',async t=>{
 const {router,server,dataRoot,codex}=await setup(t);assert.equal(router.view().activeId,null);
 for(const preset of MODEL_PRESETS.filter(v=>v.kind!=='codex')){
  const beforeRequests=server.requests.length;
  const profile=await router.save({...preset,baseUrl:server.url+'/'+preset.protocol,key:'fake-only-secret',model:'manual-model'});assert.equal(profile.keyConfigured,true);assert.equal(JSON.stringify(profile).includes('keyCiphertext'),false);assert.equal(router.enabled,false);assert.equal(server.requests.length,beforeRequests);
  await router.activate(profile.id);assert.equal(router.enabled,false);const models=await router.fetchModels({...profile,key:''});assert.equal(models.length,1);await router.test({...profile,key:''});
 }
 const saved=router.view();assert.equal(saved.profiles.length,9);assert.equal(codex.calls,0);assert.equal(JSON.stringify(saved).includes('fake-only-secret'),false);
 const restarted=new ModelRouter({dataRoot,codex:stubCodex(),crypto:fakeCrypto});await restarted.ready;t.after(()=>restarted.close());assert.equal(restarted.view().activeId,saved.activeId);assert.equal(restarted.enabled,false);
});
test('Migration keeps local Codex; active turn locks connection and errors never fall back',async t=>{
 const {router,server,codex}=await setup(t,true);assert.equal(router.view().activeId,'codex');
 const first=await router.save({kind:'custom',baseUrl:server.url+'/chat-completions',model:'a'}),second=await router.save({kind:'custom',baseUrl:server.url+'/responses',protocol:'responses',model:'b'});await router.activate(first.id);router.setEnabled(true);
 let release;const gate=new Promise(r=>release=r);const turn=router.runTurn(async()=>{assert.equal(router.currentSelection().model,'a');await gate;return output(router.stream({messages:[{role:'user',content:'hi'}]}));});
 await assert.rejects(()=>router.activate(second.id),/等待/);await assert.rejects(()=>router.save({...first,model:'changed'}),/等待/);await router.save({...second,model:'other'});release();assert.match(await turn,/你好呀/);
 server.setFailure({status:401});await assert.rejects(()=>output(router.stream({messages:[{role:'user',content:'hi'}]})),/Key 无效/);assert.equal(codex.calls,0);await router.activate(second.id);assert.equal(router.currentSelection().model,'other');
 server.setFailure(null);server.setDelay(1500);await assert.rejects(()=>output(router.stream({messages:[{role:'user',content:'hi'}]})),/取消或超时/);
});
test('Saving retains encrypted key only for the same endpoint; clearing, missing and undecryptable keys give configuration errors',async t=>{
 const {router,server}=await setup(t);let p=await router.save({kind:'openai',baseUrl:server.url+'/responses',model:'fixture',key:'fake-secret'});p=await router.save({...p,key:'',name:'changed'});assert.equal(p.keyConfigured,true);await router.activate(p.id);
 p=await router.save({...p,baseUrl:server.url+'/different',key:''});assert.equal(p.keyConfigured,false);await assert.rejects(()=>router.activate(p.id),/填写 API Key/);
 p=await router.save({...p,key:'fake-secret'});await router.save({...p,key:'',clearKey:true});await assert.rejects(()=>router.activate(p.id),/填写 API Key/);
 await router.save({...p,key:'fake-secret'});router.crypto={...fakeCrypto,decryptString:()=>{throw Error('WINDOWS SECRET');}};await assert.rejects(()=>router.activate(p.id),error=>error.message==='API Key 无法解密，请重新填写');
});
test('Disabling chat cancels in-flight API work and encryption failure leaves existing connections intact',async t=>{
 const {router,server}=await setup(t);const p=await router.save({kind:'custom',baseUrl:server.url+'/responses',protocol:'responses',model:'fixture'});await router.activate(p.id);router.setEnabled(true);server.setDelay(5000);
 const work=output(router.stream({messages:[{role:'user',content:'hello'}]}));await new Promise(r=>setTimeout(r,40));router.setEnabled(false);await assert.rejects(()=>work,/取消/);assert.equal(router.controllers.size,0);
 router.crypto={...fakeCrypto,isEncryptionAvailable:()=>false};await assert.rejects(()=>router.save({kind:'openai',baseUrl:server.url,model:'fixture',key:'fake'}),/加密不可用/);assert.equal(router.view().profiles.length,1);
});
test('Galgame commits early, sends emotion/reply/options to one selected API and preserves history offline',async t=>{
 const {router,server,dataRoot,codex,usage}=await setup(t);const p=await router.save({kind:'custom',baseUrl:server.url+'/responses',protocol:'responses',model:'fixture'});await router.activate(p.id);router.setEnabled(true);let commits=0;
 const game=await createGalgame({dataRoot,provider:router,model:'old-local',onChatCommitted:()=>{commits++;assert.equal(server.requests.filter(v=>/选项生成器/.test(v.body?.instructions??'')).length,0);}});t.after(()=>game.close());
 const before=await game.action('view');const result=await game.action('chat',{text:'太好了'});assert.equal(commits,1);assert.equal(server.requests.length,3);assert.ok(server.requests.every(v=>v.body.model==='fixture'));assert.match(JSON.stringify(result),/你好呀/);assert.match(JSON.stringify(result),/再聊一会/);assert.equal(codex.calls,0);assert.equal(usage.length,3);assert.equal((await game.action('settings-get')).characterId,'deepseek');assert.equal((await game.action('view')).chatModelLabel,'fixture');
 router.setEnabled(false);await game.action('view');await game.action('model-options');assert.equal(server.requests.length,3);assert.equal(before.characterId,(await game.action('view')).characterId);
});
test('Primary API failures do not commit fake replies; classifier failure alone falls back to keywords',async t=>{
 const {router,server,dataRoot,codex}=await setup(t);const p=await router.save({kind:'custom',baseUrl:server.url+'/chat-completions',model:'fixture'});await router.activate(p.id);router.setEnabled(true);let events=[];const game=await createGalgame({dataRoot,provider:router,model:'old-local',onChatCommitted:v=>events.push(v)});t.after(()=>game.close());
 server.setFailure(({purpose})=>purpose==='chat'?{status:503}:null);await assert.rejects(()=>game.action('chat',{text:'你好'}),/不可用/);assert.equal(events.length,0);const failedView=await game.action('view');assert.ok(!JSON.stringify(failedView).includes('今天也一起加油'));
 server.setFailure(({purpose})=>purpose==='emotion'?{status:503}:null);await game.action('chat',{text:'气死我了'});assert.equal(events.length,1);assert.equal(events[0].emotion,'angry');assert.equal(events[0].emotionSource,'keyword');assert.equal(codex.calls,0);
});
test('Side stories use the selected API and keep the cast separate from the model vendor',async t=>{
 const {router,server,dataRoot,codex,usage}=await setup(t);const p=await router.save({kind:'custom',baseUrl:server.url+'/gemini',protocol:'gemini',model:'manual-story-model'});await router.activate(p.id);router.setEnabled(true);const game=await createGalgame({dataRoot,provider:router,model:'old-local'});t.after(()=>game.close());
 const result=await game.action('side-story',{topic:'大家一起喝茶'});assert.equal(result.sideStoryError,undefined);assert.ok(result.sideStory.scene);assert.ok(server.requests.every(v=>v.path.includes('manual-story-model')));assert.equal(codex.calls,0);assert.ok(usage.some(v=>v.purpose==='side-story'));
 const character=(await game.action('settings-get')).characterId;const other=await router.save({kind:'custom',baseUrl:server.url+'/responses',protocol:'responses',model:'different-model'});await router.activate(other.id);await game.action('view');assert.equal((await game.action('settings-get')).characterId,character);
});
