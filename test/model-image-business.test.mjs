import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {createSocialPluginBroker,SOCIAL_RUNTIME_METHODS} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {createNativeSocialFacade} from '../src/buddy-plugin-services/native-social-facade.mjs';
import {SOCIAL_CAPABILITIES} from '../src/buddy-plugin-services/social-contract.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJWQAAAAASUVORK5CYII=','base64');
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
async function fixture(t,draft={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'model-image-business-')),requests=[],usages=[],state={claims:0,finishes:[]};let game;
 const router=new ModelRouter({dataRoot,crypto,codex:{defaultModel:'gpt-6.1-sol',enabled:false,setEnabled(value){this.enabled=value;},listModels:()=>[],close(){}},timeoutMs:1000,outputLimit:()=>512,onUsage:value=>usages.push(value),fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);requests.push({url,body,origin:game.r95.currentOrigin(),claims:state.claims});init.signal.throwIfAborted();
  const text='{"summary":"Observed host picture"}',result=body.input?{status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:20,output_tokens:8}}:{choices:[{message:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:8}};
  return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
 }});
 await router.ready;const saved=await router.save({kind:'deepseek',protocol:'chat-completions',baseUrl:'http://127.0.0.1:1',model:'deepseek-flash',key:'synthetic-only',...draft});await router.activate(saved.id);router.setEnabled(true);
 game=await createGalgame({dataRoot,provider:router,model:saved.model,automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false,getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:7})}});
 const identity={pluginId:'image-business-fixture',packageName:'@ai-buddy/bilibili-companion',exactVersion:'fixture',sourceDigest:'a'.repeat(64)},origin={runtimeId:'fixture',profileId:'fixture',pid:1};
 const account={ref:'synthetic-account',accountId:'42',generation:1,enabled:true},host=game.r95.socialHost;
 const bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES});
 const accounts={forPlugin:()=>structuredClone(account),get:()=>structuredClone(account),secret:()=>({cookie:'synthetic-only'}),list:()=>[structuredClone(account)]};
 // Media resolution is an external boundary. The real broker still owns the
 // reference checks, private image ticket, claim, permission and submit guards.
 const vision={available:true,prepare:async()=>({}),read:async()=>({}),resolve:async({visualMaterialRefs})=>{assert.deepEqual(visualMaterialRefs,['vision:host-picture']);return [{ref:'vision:host-picture',from:0,to:1,mimeType:'image/png',bytes:png}];},claim:()=>{state.claims++;return {claimed:true};},finish:value=>state.finishes.push(value)};
 const broker=createSocialPluginBroker({dataRoot,accounts,bridge,getR95:()=>game.r95,getProvider:()=>router,transport:{observation:()=>null},biliVision:vision,verifyBilibiliAccount:async()=>({connected:true,accountId:'42'})});
 const facade=createNativeSocialFacade({dataRoot,contract:{hash:'image-business',methods:SOCIAL_RUNTIME_METHODS},handlers:broker.handlers,contextProvider:broker.contextProvider,authorizeUI:async()=>true,resolveGrant:async()=>({...identity,enabled:true,granted:SOCIAL_RUNTIME_METHODS,generation:1})});
 const session=await facade.open({identity,origin,contractHash:'image-business'}),call=(method,payload,options)=>facade.dispatch({sessionToken:session.sessionToken,method,payload},origin,options);
 const read=async(extra={})=>call('social.context.read',{purpose:'bilibili-activity',characterId:'deepseek',modelConnectionRef:saved.id,principal:await call('authorize',{action:'now',request:'synthetic-host-ui'}),...extra});
 const begin=async()=>{const context=await read(),lease=await call('activity.lease',{contextToken:context.contextToken,activityId:'image-reading'});return {context,payload:{contextToken:context.contextToken,...lease,connectionRef:saved.id,readingId:'reading',stepId:'overview',stepKind:'overview',purpose:'bilibili-understanding',visualMaterialRefs:['vision:host-picture'],messages:[{role:'user',content:'Describe the host picture.'}],material:{items:[{id:'frame',imageRef:'vision:host-picture',start:0,end:1}]}}};};
 t.after(async()=>{await facade.close();await broker.close();await bridge.close();await game.close();router.close();assert.equal(dirname(dataRoot),resolve(tmpdir()));await rm(dataRoot,{recursive:true,force:true});});
 return {router,game,requests,usages,state,identity,bridge,call,read,begin,saved};
}

test('real native Bili context reads keep an unverified custom model unknown without a model request',async t=>{
 const f=await fixture(t,{kind:'custom',model:'deepseek-flash'});
 const context=await f.read({probeImages:true,manual:true});
 assert.deepEqual(context.modelCapabilities,[]);assert.equal(context.modelImageCapability.imageInput,'unknown');assert.equal(context.modelImageCapability.reason,'MODEL_IMAGE_CAPABILITY_UNKNOWN');
 assert.equal(f.requests.length,0);assert.equal(f.usages.length,0);assert.equal(f.game.r95.currentOrigin(),null);
});

test('a documented Bili model reaches the real guarded image request once without a preliminary probe',async t=>{
 const f=await fixture(t),{context,payload}=await f.begin();
 assert.deepEqual(context.modelCapabilities,['image']);assert.equal(context.modelImageCapability.source,'official-documentation');assert.equal(f.requests.length,0);
 const result=await f.call('models.request',payload);
 assert.equal(JSON.parse(result.text).summary,'Observed host picture');assert.equal(f.requests.length,1);assert.equal(f.state.claims,1);assert.equal(f.requests[0].claims,1);
 const request=f.requests[0];assert.equal(request.body.model,'deepseek-flash');assert.notEqual(request.body.max_tokens,128);
 assert.equal(request.body.messages.at(-1).content.find(part=>part.type==='image_url').image_url.url,'data:image/png;base64,'+png.toString('base64'));
 assert.equal(request.origin.scope.characterId,'deepseek');assert.equal(request.origin.scope.channel,'bilibili');assert.equal(f.usages[0].purpose,'bilibili-vision');
 assert.equal(f.state.finishes[0].status,'completed');assert.equal(f.game.r95.currentOrigin(),null);
 await f.call('models.request',payload);assert.equal(f.requests.length,1);assert.equal(f.state.claims,1);
});

test('text-only endpoint metadata does not block an official image model or add a Bili probe',async t=>{
 const f=await fixture(t);await f.router.saveModels(f.saved.id,[{id:'deepseek-flash',inputModalities:['text']}]);
 const {context,payload}=await f.begin();assert.deepEqual(context.modelCapabilities,['image']);assert.equal(context.modelImageCapability.imageInput,'supported');assert.equal(context.modelImageCapability.declaredImageInput,'unsupported');assert.equal(context.modelImageCapability.declarationConflict,true);
 assert.equal(f.requests.length,0);await f.call('models.request',payload);assert.equal(f.state.claims,1);assert.equal(f.requests.length,1);assert.equal(f.usages[0].purpose,'bilibili-vision');assert.notEqual(f.requests[0].body.max_tokens,128);
});

test('an official text-only model is rejected before Bili image spend despite image endpoint metadata',async t=>{
 const f=await fixture(t,{kind:'custom',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-5.3'});await f.router.saveModels(f.saved.id,[{id:'glm-5.3',inputModalities:['image']}]);
 const {context,payload}=await f.begin();assert.deepEqual(context.modelCapabilities,[]);assert.equal(context.modelImageCapability.imageInput,'unsupported');assert.equal(context.modelImageCapability.declaredImageInput,'supported');
 await assert.rejects(f.call('models.request',payload),{code:'SOCIAL_MODEL_NOT_SUBMITTED',causeCode:'MODEL_IMAGE_UNSUPPORTED'});
 assert.equal(f.state.claims,0);assert.equal(f.requests.length,0);
});

test('an unknown custom Bili image request stops before any image claim or model spend',async t=>{
 const f=await fixture(t,{kind:'custom',model:'deepseek-flash'}),{payload}=await f.begin();
 await assert.rejects(f.call('models.request',payload),{code:'SOCIAL_MODEL_NOT_SUBMITTED',causeCode:'MODEL_IMAGE_CAPABILITY_UNKNOWN'});
 assert.equal(f.state.claims,0);assert.equal(f.requests.length,0);
});

test('native cancellation still prevents a documented Bili image from claiming or submitting',async t=>{
 const f=await fixture(t),{payload}=await f.begin(),controller=new AbortController();controller.abort();
 await assert.rejects(f.call('models.request',payload,{signal:controller.signal}),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});
 assert.equal(f.state.claims,0);assert.equal(f.requests.length,0);
});

test('a revoked model grant still prevents a documented Bili image from claiming or submitting',async t=>{
 const f=await fixture(t),{payload}=await f.begin();f.bridge.grants.revoke(f.identity.pluginId);
 await assert.rejects(f.call('models.request',payload));assert.equal(f.state.claims,0);assert.equal(f.requests.length,0);
});

test('the confirmed Grok lookup alias preserves the configured model ID on the actual image request',async t=>{
 const f=await fixture(t,{kind:'grok',protocol:'responses',model:'grok4.6'}),{context,payload}=await f.begin();
 assert.equal(context.modelImageCapability.catalogModel,'grok-4.6');assert.equal(f.requests.length,0);
 await f.call('models.request',payload);assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.model,'grok4.6');assert.ok(f.requests[0].body.input.at(-1).content.some(part=>part.type==='input_image'));assert.equal(f.state.claims,1);
});
