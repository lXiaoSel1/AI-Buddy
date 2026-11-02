import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ApiTransport} from '../src/api-transport.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {CodexProvider} from '../src/codex-provider.mjs';
import {cleanModelCatalog} from '../src/reasoning-settings.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';
import {API_PROTOCOLS,MODEL_PRESETS} from '../src/model-presets.mjs';
import {imagePart,imageInputCapability,checkedImagePart,registerHostImages,takeHostImages,releaseHostImages} from '../src/model-images.mjs';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJWQAAAAASUVORK5CYII=','base64'),image=imagePart({mimeType:'image/png',bytes});
const scope={pluginId:'bili-fixture',characterId:'claude',personaId:'default',lifeId:'life-1',operationId:'op-1',sessionId:'session-1',accountBindingId:'12345',bindingGeneration:1};
const profile=protocol=>({id:'fixture-api',kind:protocol==='codex'?'codex':'custom',protocol,baseUrl:'https://fixture.invalid/v1',model:'fixture-model',models:[{id:'fixture-model',inputModalities:['text','image']}],contextTokens:32768});

test('image capability needs a declared selected-model modality and a real supported transport',()=>{
 for(const protocol of ['chat-completions','responses','anthropic','gemini','codex'])assert.equal(imageInputCapability(profile(protocol)).supported,true);
 assert.equal(imageInputCapability({...profile('responses'),models:[]}).reason,'MODEL_IMAGE_CAPABILITY_UNKNOWN');
 assert.equal(imageInputCapability({...profile('responses'),models:[{id:'fixture-model',inputModalities:['text']}]}).reason,'MODEL_IMAGE_UNSUPPORTED');
 assert.equal(imageInputCapability({...profile('responses'),protocol:'unsupported'}).supported,false);
 assert.equal(imageInputCapability({...profile('responses'),model:'another-model'}).supported,false);
});
test('model catalog retains only well-formed input modalities, not a name-based vision guess',()=>{
 const rows=cleanModelCatalog([{id:'gpt-looking-name'},{id:'a',input_modalities:['text','image']},{id:'b',inputModalities:['text','image','shell']}]);
 assert.equal(rows[0].inputModalities,undefined);assert.deepEqual(rows[1].inputModalities,['text','image']);assert.equal(rows[2].inputModalities,undefined);
});
test('actual API catalog mapping and profile validation preserve server-declared input modalities',async()=>{
 for(const protocol of ['responses','chat-completions','anthropic','gemini']){
  const transport=new ApiTransport({fetchImpl:async()=>new Response(JSON.stringify(protocol==='gemini'?{models:[{name:'models/selected',input_modalities:['text','image'],supportedGenerationMethods:['generateContent']}]}:{data:[{id:'selected',input_modalities:['text','image']}]}),{headers:{'content-type':'application/json'}})});
  const models=await transport.listModels({...profile(protocol),key:'fixture-only'});const saved=ModelRouter.prototype.validateDraft.call({presets:MODEL_PRESETS,protocols:API_PROTOCOLS},{kind:'custom',protocol,baseUrl:'https://fixture.invalid/v1',model:'selected',models});assert.deepEqual(saved.models[0].inputModalities,['text','image']);assert.equal(imageInputCapability(saved).supported,true);
 }
});
test('actual Codex model discovery and profile validation retain only app-server supplied image modality',async t=>{
 const dataRoot=join(tmpdir(),'bili-vision-catalog-'+randomUUID());t.after(()=>rm(dataRoot,{recursive:true,force:true}));const requests=[];
 const spawnImpl=()=>{const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.killed=true;}});child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){const request=JSON.parse(line);requests.push(request);if(request.id==null)continue;const result=request.method==='model/list'?{data:[{id:'selected',inputModalities:['text','image']},{id:'unknown'}],nextCursor:null}:request.method==='account/read'?{account:{type:'chatgpt'}}:{};queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result})+'\n'));}});queueMicrotask(()=>child.emit('spawn'));return child;};
 const provider=new CodexProvider({binary:'fixture-only.exe',defaultModel:'selected',dataRoot,env:{USERPROFILE:dataRoot,CODEX_HOME:join(dataRoot,'private-home')},spawnImpl});try{const models=await provider.fetchModels();const saved=ModelRouter.prototype.validateDraft.call({presets:MODEL_PRESETS,protocols:API_PROTOCOLS},{kind:'codex',model:'selected',models,reasoningEffort:null});assert.equal(imageInputCapability(saved).supported,true);saved.model='unknown';assert.equal(imageInputCapability(saved).reason,'MODEL_IMAGE_CAPABILITY_UNKNOWN');assert.ok(!requests.some(r=>r.method==='turn/start'||r.method==='thread/start'));}finally{provider.close();}
});
test('host image tickets are scoped, single-use and cannot be replaced with paths or URLs',()=>{
 const ticket=registerHostImages([{mimeType:'image/png',bytes}],scope);try{
  assert.throws(()=>takeHostImages(ticket,{...scope,lifeId:'another'}),{code:'MODEL_IMAGE_REFERENCE_DENIED'});
  assert.deepEqual(takeHostImages(ticket,scope).parts,[image]);assert.throws(()=>takeHostImages(ticket,scope),{code:'MODEL_IMAGE_REFERENCE_DENIED'});
  assert.throws(()=>checkedImagePart({type:'image',mimeType:'image/png',data:'file:///private.png'}),{code:'MODEL_IMAGE_INVALID'});
  assert.throws(()=>checkedImagePart({type:'image',mimeType:'image/png',data:'https://example.test/private.png'}),{code:'MODEL_IMAGE_INVALID'});
  assert.throws(()=>imagePart({mimeType:'image/png',bytes:Buffer.from('not an image')}),{code:'MODEL_IMAGE_INVALID'});
 }finally{releaseHostImages(ticket);}
});
for(const protocol of ['chat-completions','responses','anthropic','gemini'])test(protocol+' emits actual inline picture bytes and records only usage metadata',async()=>{
 let body;const usages=[],audits=[],p=profile(protocol),responses={
  'chat-completions':{choices:[{message:{content:'seen'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}},
  responses:{output:[{content:[{type:'output_text',text:'seen'}]}],usage:{input_tokens:3,output_tokens:2}},
  anthropic:{content:[{type:'text',text:'seen'}],usage:{input_tokens:3,output_tokens:2}},
  gemini:{candidates:[{content:{parts:[{text:'seen'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}}
 };
 const transport=new ApiTransport({fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify(responses[protocol]),{headers:{'content-type':'application/json'}});},onUsage:r=>usages.push(r),audit:r=>audits.push(r)});
 const parts=[];for await(const part of transport.stream(p,{messages:[{role:'user',content:[{type:'text',text:'What is shown?'},image]}],maxTokens:512,purpose:'bilibili-vision'}))parts.push(part);
 const actual=protocol==='gemini'?body.contents[0].parts[1]:protocol==='responses'?body.input[0].content[1]:body.messages[0].content[1];
 if(protocol==='gemini')assert.deepEqual(actual,{inlineData:{mimeType:'image/png',data:image.data}});
 else if(protocol==='anthropic')assert.deepEqual(actual,{type:'image',source:{type:'base64',media_type:'image/png',data:image.data}});
 else if(protocol==='responses')assert.equal(actual.image_url,'data:image/png;base64,'+image.data);
 else assert.equal(actual.image_url.url,'data:image/png;base64,'+image.data);
 assert.equal(parts.find(x=>x.type==='text-delta').text,'seen');assert.equal(usages.length,1);assert.equal(usages[0].usage.total,5);assert.ok(!JSON.stringify([...usages,...audits]).includes(image.data));
});
test('single-submission visual calls never auto retry a truncated response',async()=>{
 let calls=0;const owner={transport:{async *stream(){calls++;yield {type:'finish',reason:{kind:'length'}};}},outputBudget:()=>512,outputCeiling:()=>4096,audit:()=>{},timeoutMs:10000};
 await assert.rejects(async()=>{for await(const _ of ModelRouter.prototype.streamWithRetry.call(owner,profile('responses'),{singleSubmission:true},null)){}},{code:'MODEL_OUTPUT_TRUNCATED'});assert.equal(calls,1);
});
test('R95 preserves inline images outside JSON/compaction and claims only at final submission',async()=>{
 const p=profile('responses'),route=new AsyncLocalStorage(),seen=[];let compactions=0,claims=0;
 const provider={enabled:true,ready:Promise.resolve(),captureConnection:()=>structuredClone(p),resolveConnection:()=>({connectionId:p.id}),resolveContextCapacity:()=>({tokens:32768}),outputLimit:()=>512,currentSelection(){return {provider:p.id,model:p.model};},selected:()=>route.getStore()??p,runCaptured:(v,fn)=>route.run(v,fn),async *stream(options){seen.push(options);yield {type:'text-delta',text:'{"summary":"seen"}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const result=await runR95Model({provider,scope,card:{id:'claude',modelBinding:{enabled:true,connectionId:p.id}},system:'Describe observed frames only.',input:{kind:'bilibili-vision',materialRefs:['opaque']},hostImages:[image],beforeModelSubmit:()=>{claims++;},memory:{context:()=>{compactions++;throw Error('visual requests must not compact');}},withOrigin:(_s,_k,fn)=>fn('origin-one')});
 assert.equal(result.summary,'seen');assert.equal(compactions,0);assert.equal(claims,1);assert.equal(seen.length,1);assert.equal(seen[0].singleSubmission,true);assert.deepEqual(seen[0].messages.at(-1).content.at(-1),image);assert.ok(!seen[0].messages.at(-1).content[0].text.includes(image.data));
});
test('R95 rejects unknown image support before compaction, budget claim, or transport',async()=>{
 let claims=0,calls=0;const p={...profile('responses'),models:[]},provider={enabled:true,captureConnection:()=>p,resolveConnection:()=>({}),stream:async function*(){calls++;}};
 await assert.rejects(runR95Model({provider,scope,card:{id:'claude',modelBinding:{enabled:true,connectionId:p.id}},system:'test',input:{kind:'bilibili-vision'},hostImages:[image],beforeModelSubmit:()=>{claims++;},withOrigin:(_s,_k,fn)=>fn('origin')}),{code:'MODEL_IMAGE_CAPABILITY_UNKNOWN'});assert.equal(claims,0);assert.equal(calls,0);
});
test('Codex uses app-server image input, not a base64 JSON text prompt',async t=>{
 const dataRoot=join(tmpdir(),'bili-vision-codex-'+randomUUID()),cwd=join(tmpdir(),'ai-buddy-chat',createHash('sha256').update(dataRoot).digest('hex').slice(0,24));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const requests=[],notifications=new Set(),child={},owner=Object.assign(new CodexProvider({dataRoot,defaultModel:'fixture-model',handshakeTimeoutMs:500,turnTimeoutMs:1000}),{reasoningEffort:()=>null,start:async()=>{},child,notifications,request:async(method,args,_timeout,boundary)=>{requests.push({method,args});if(method==='thread/start')return {thread:{id:'thread'}};if(method==='turn/start'){boundary?.onWrite?.();setTimeout(()=>{for(const fn of notifications){fn({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'message',delta:'seen'}});fn({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'message',type:'agentMessage',text:'seen'}}});fn({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});}},0);return {turn:{id:'turn'}};}return {};}});
 assert.equal(await CodexProvider.prototype.complete.call(owner,{messages:[{role:'user',content:[{type:'text',text:'Describe'},image]}]}),'seen');
 const input=requests.find(x=>x.method==='turn/start').args.input;assert.equal(input[0].text,'[user] Describe\n');assert.deepEqual(input[1],{type:'image',url:'data:image/png;base64,'+image.data});assert.ok(!requests.find(x=>x.method==='thread/start').args.developerInstructions?.includes(image.data));
});
