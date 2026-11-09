import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';
import {imageInputCapability} from '../src/model-images.mjs';
import {MODEL_IMAGE_CATALOG} from '../src/model-image-catalog.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {CodexProvider} from '../src/codex-provider.mjs';

const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
async function fixture(t,draft={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'model-image-catalog-')),requests=[],codex={defaultModel:'gpt-6.1-sol',enabled:false,setEnabled(value){this.enabled=value;}};
 const router=new ModelRouter({dataRoot,codex,crypto,fetchImpl:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});throw Error('No capability request is authorized by this fixture');}});
 await router.ready;const saved=await router.save({kind:'deepseek',protocol:'chat-completions',baseUrl:'http://127.0.0.1:1',model:'deepseek-flash',key:'synthetic-only',...draft});await router.activate(saved.id);router.setEnabled(true);
 t.after(async()=>{router.close();assert.equal(dirname(dataRoot),resolve(tmpdir()));await rm(dataRoot,{recursive:true,force:true});});
 return {router,requests,saved};
}

test('an exact documented DeepSeek model accepts images without a capability request',async t=>{
 const {router,requests}=await fixture(t),profile=router.captureConnection();
 assert.equal(router.resolveImageCapability().supported,true);
 const capability=await router.ensureImageCapability(profile,{attemptId:'explicit-diagnostic'});
 assert.equal(capability.supported,true);assert.equal(capability.imageInput,'supported');assert.equal(capability.source,'official-documentation');
 assert.equal(capability.provider,'deepseek');assert.equal(capability.model,'deepseek-flash');assert.equal(capability.checkedAt,'2026-11-08');
 assert.equal(capability.sourceUrl,'https://api-docs.deepseek.com/guides/vision/');assert.equal(requests.length,0);
});

test('connection and model choices project distinct image states without starting a model request',async t=>{
 const {router,requests,saved}=await fixture(t);await router.saveModels(saved.id,[{id:'deepseek-flash'},{id:'deepseek-v4-pro'},{id:'deepseek-flash-next'}]);
 assert.equal(router.view().profiles[0].imageCapability.imageInput,'supported');
 const models=router.listModels(saved.id);assert.equal(models[0].imageCapability.supported,true);assert.equal(models[1].imageCapability.imageInput,'unknown');assert.equal(models[2].imageCapability.source,'unknown');
 assert.equal(requests.length,0);assert.equal(router.captureConnection().model,'deepseek-flash');
});

test('the finite official catalog preserves all ten providers and exact model identities',()=>{
 assert.equal(MODEL_IMAGE_CATALOG.length,37);assert.equal(new Set(MODEL_IMAGE_CATALOG.map(row=>row.provider)).size,10);
 const cases=[
  ['deepseek','deepseek-v4-flash','chat-completions'],['deepseek','deepseek-v4-flash-vision-exp','anthropic'],
  ['openai','gpt-6.1-terra','responses'],['openai','gpt-6.1-sol','responses'],['openai','gpt-5.6-luna','responses'],
  ['claude','claude-fable-5-1','anthropic'],['grok','grok-4.7','responses'],['qwen','qwen3.5-plus','chat-completions'],
  ['kimi','kimi-k3.1-pro','chat-completions'],['minimax','MiniMax-M3.1-Flash','chat-completions'],
 ];
 for(const [kind,model,protocol]of cases){const value=imageInputCapability({kind,model,protocol});assert.equal(value.supported,true,model);assert.equal(value.imageInput,'supported');assert.equal(value.checkedAt,'2026-11-08');assert.match(value.sourceUrl,/^https:\/\//);}
 assert.equal(imageInputCapability({kind:'custom',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-5.3-flash',protocol:'chat-completions'}).supported,true);
 assert.equal(imageInputCapability({kind:'custom',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'doubao-seed-2-0-pro-260215',protocol:'chat-completions'}).supported,true);
});

test('provider and exact ID boundaries keep unknown separate from explicitly unsupported',()=>{
 for(const profile of [
  {kind:'deepseek',model:'deepseek-v4-pro'},
  {kind:'deepseek',model:'deepseek-flash-next'},
  {kind:'deepseek',model:'deepseek-vision'},
  {kind:'openai',model:'deepseek-flash'},
  {kind:'openai',model:'GPT-6.1-SOL'},
  {kind:'minimax',model:'minimax-m3.1-flash'},
  {kind:'custom',model:'deepseek-flash',baseUrl:'https://api.deepseek.com.proxy.invalid'},
 ])assert.equal(imageInputCapability({...profile,protocol:'chat-completions'}).imageInput,'unknown',profile.model);
 for(const model of ['glm-5.3','glm-5.2']){const value=imageInputCapability({kind:'custom',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model,protocol:'chat-completions'});assert.equal(value.imageInput,'unsupported');assert.equal(value.reason,'MODEL_IMAGE_UNSUPPORTED');}
});

test('official model conclusions retain endpoint declaration conflicts as separate metadata',()=>{
 const known={kind:'deepseek',model:'deepseek-flash',protocol:'chat-completions',models:[{id:'deepseek-flash',inputModalities:['text']}]};
 const capability=imageInputCapability(known);assert.equal(capability.supported,true);assert.equal(capability.imageInput,'supported');assert.equal(capability.source,'official-documentation');
 assert.equal(capability.declaredImageInput,'unsupported');assert.equal(capability.declarationConflict,true);assert.equal(capability.declarationSource,'endpoint-model-catalog');
 const custom={kind:'custom',model:'unverified',protocol:'gemini',models:[{id:'unverified',input_modalities:['text','image']}]};
 assert.equal(imageInputCapability(custom).supported,true);assert.equal(imageInputCapability(custom).source,'model-catalog');
 const textOnly=imageInputCapability({kind:'custom',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-5.3',protocol:'chat-completions',models:[{id:'glm-5.3',inputModalities:['image']}]});
 assert.equal(textOnly.imageInput,'unsupported');assert.equal(textOnly.supported,false);assert.equal(textOnly.source,'official-documentation');assert.equal(textOnly.declaredImageInput,'supported');assert.equal(textOnly.declarationConflict,true);
 assert.equal(imageInputCapability({...known,models:[{id:'deepseek-flash',inputModalities:['nonsense']}]}).supported,true);
});

test('documented image input and the configured transport remain separate conclusions',()=>{
 for(const profile of [{kind:'openai',model:'gpt-6.1-sol',protocol:'chat-completions'},{kind:'gemini',model:'gemini-3.8-flash',protocol:'gemini'}]){
  const value=imageInputCapability(profile);assert.equal(value.imageInput,'supported');assert.equal(value.supported,false);assert.equal(value.transportSupported,false);assert.equal(value.reason,'MODEL_IMAGE_TRANSPORT_UNSUPPORTED');
 }
 const native=imageInputCapability({kind:'codex',model:'gpt-6.1-sol',protocol:'codex'});assert.equal(native.supported,true);assert.equal(native.transportSource,'host-codex-image-adapter');
 const alias=imageInputCapability({kind:'grok',model:'grok4.6',protocol:'responses'});assert.equal(alias.supported,true);assert.equal(alias.model,'grok4.6');assert.equal(alias.catalogModel,'grok-4.6');
 assert.equal(imageInputCapability({kind:'grok',model:'grok46',protocol:'responses'}).imageInput,'unknown');
});

test('native Codex sends the host image through its own turn input adapter without a vision probe',async t=>{
 const root=await mkdtemp(join(tmpdir(),'image-codex-adapter-')),requests=[],child=new EventEmitter();
 Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.killed=true;}});
 const notify=(method,params)=>child.stdout.write(JSON.stringify({method,params})+'\n');
 child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){const request=JSON.parse(line);requests.push(request);if(request.id==null)continue;queueMicrotask(()=>{
  const result=request.method==='account/read'?{account:{type:'chatgpt'}}:request.method==='thread/start'?{thread:{id:'image-thread'}}:request.method==='turn/start'?{turn:{id:'image-turn'}}:{};
  child.stdout.write(JSON.stringify({id:request.id,result})+'\n');
  if(request.method==='turn/start')queueMicrotask(()=>{notify('item/completed',{threadId:'image-thread',turnId:'image-turn',item:{id:'reply',type:'agentMessage',text:'Picture read'}});notify('turn/completed',{threadId:'image-thread',turn:{id:'image-turn',status:'completed'}});});
 });}});
 const provider=new CodexProvider({binary:'synthetic-only.exe',defaultModel:'gpt-6.1-sol',dataRoot:join(root,'data'),env:{USERPROFILE:root,CODEX_HOME:join(root,'empty-home')},handshakeTimeoutMs:500,turnTimeoutMs:1000,spawnImpl:()=>{queueMicrotask(()=>child.emit('spawn'));return child;}});provider.setEnabled(true);
 t.after(async()=>{provider.close();assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
 const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJWQAAAAASUVORK5CYII=';
 let text='';for await(const part of provider.stream({model:'gpt-6.1-sol',messages:[{role:'user',content:[{type:'text',text:'Read this picture'},{type:'image',mimeType:'image/png',data}]}]}))if(part.type==='text-delta')text+=part.text;
 assert.equal(text,'Picture read');const turns=requests.filter(row=>row.method==='turn/start');assert.equal(turns.length,1);assert.equal(turns[0].params.model,'gpt-6.1-sol');assert.deepEqual(turns[0].params.input[1],{type:'image',url:'data:image/png;base64,'+data});
});
