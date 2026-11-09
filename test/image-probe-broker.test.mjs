import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {inflateSync} from 'node:zlib';
import {ModelRouter} from '../src/model-router.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createSocialPluginBroker,SOCIAL_RUNTIME_METHODS} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {createNativeSocialFacade} from '../src/buddy-plugin-services/native-social-facade.mjs';
import {SOCIAL_CAPABILITIES} from '../src/buddy-plugin-services/social-contract.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';
import {socialScopeSnapshot} from '../src/buddy-plugin-services/social-runtime-journal.mjs';

const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
const digitRows=['11111/10001/10001/10001/10001/10001/11111','00100/01100/00100/00100/00100/00100/01110','11111/00001/00001/11111/10000/10000/11111','11111/00001/00001/11111/00001/00001/11111','10001/10001/10001/11111/00001/00001/00001','11111/10000/10000/11111/00001/00001/11111','11111/10000/10000/11111/10001/10001/11111','11111/00001/00010/00100/01000/01000/01000','11111/10001/10001/11111/10001/10001/11111','11111/10001/10001/11111/00001/00001/11111'];
// The external provider fixture reads pixels; it has no access to the host answer.
function readDigits(data){
 const png=Buffer.from(data,'base64'),chunks=[];let width,height;
 for(let at=8;at<png.length;){const size=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),bytes=png.subarray(at+8,at+8+size);if(type==='IHDR'){width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);}if(type==='IDAT')chunks.push(bytes);at+=size+12;}
 const pixels=inflateSync(Buffer.concat(chunks)),ink=(x,y)=>pixels[y*(width+1)+x+1]<128,runs=[];
 for(let x=0;x<width;x++)if(Array.from({length:height},(_,y)=>y).some(y=>ink(x,y))){if(!runs.length||x>runs.at(-1).at(-1)+1)runs.push([x]);else runs.at(-1).push(x);}
 assert.equal(runs.length,6);return runs.map(run=>{let top=0;while(!run.some(x=>ink(x,top)))top++;for(let digit=0;digit<10;digit++){const grid=digitRows[digit].split('/'),trim=Math.min(...grid.map(row=>row.indexOf('1')).filter(n=>n>=0));if(grid.every((row,y)=>[...row].slice(trim).every((value,x)=>ink(run[0]+x*8,top+y*8)===(value==='1'))))return String(digit);}throw Error('Unreadable fixture PNG');}).join('');
}
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
async function fixture(t){
 const dataRoot=await mkdtemp(join(tmpdir(),'image-probe-broker-')),identity={pluginId:'image-probe-fixture',packageName:'@ai-buddy/bilibili-companion',exactVersion:'fixture',sourceDigest:'a'.repeat(64)},origin={runtimeId:'fixture',profileId:'fixture',pid:1};
 const account={ref:'bili-account',accountId:'42',generation:1,enabled:true},state={lifeId:'life',requests:[],origins:[],usages:[],beforeResponse:async()=>{},bubbles:[],onBubble:()=>{}};
 const router=new ModelRouter({dataRoot,crypto,codex:{enabled:false,setEnabled(){},defaultModel:'native'},timeoutMs:1000,onUsage:value=>state.usages.push(value),fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);state.requests.push(body);await state.beforeResponse(init.signal);init.signal.throwIfAborted();const content=body.messages.at(-1).content,image=content.find(p=>p.type==='image_url'),probe=content.some(p=>p.text?.includes('six digits'));const text=probe?(state.wrong?'I accept images':readDigits(image.image_url.url.split(',')[1])):'{"summary":"Actual image request passed"}';return new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:6}}),{headers:{'content-type':'application/json'}});}});
 await router.ready;const saved=await router.save({kind:'custom',protocol:'chat-completions',baseUrl:'http://127.0.0.1:1',model:'manual'});await router.activate(saved.id);router.setEnabled(true);
 const host=createSocialHost({dataRoot,resolveLife:scope=>({characterId:scope.characterId,personaId:'persona',lifeId:state.lifeId,operationId:'operation'})}),bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});
 bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES});
 const r95={socialHost:host,socialProfile:()=>({characterId:'character',personaId:'persona',lifeId:state.lifeId,operationId:'operation',connectionRef:saved.id,available:true}),socialCatalog:()=>[],withOrigin:async(scope,kind,fn,{signal}={})=>{state.origins.push({scope,kind});signal?.throwIfAborted();const value=await fn('probe-origin');signal?.throwIfAborted();return value;}};
 const accounts={forPlugin:()=>structuredClone(account),get:()=>structuredClone(account),secret:()=>({cookie:'synthetic'}),list:()=>[structuredClone(account)]};
 const broker=createSocialPluginBroker({dataRoot,accounts,bridge,getR95:()=>r95,getProvider:()=>router,transport:{},verifyBilibiliAccount:async()=>({connected:true,accountId:'42'}),onBubble:async value=>{state.bubbles.push(value);await state.onBubble(value);}});
 const facade=createNativeSocialFacade({dataRoot,contract:{hash:'fixture',methods:SOCIAL_RUNTIME_METHODS},handlers:broker.handlers,contextProvider:broker.contextProvider,authorizeUI:async()=>true,resolveGrant:async()=>({...identity,enabled:true,granted:SOCIAL_RUNTIME_METHODS,generation:1})});
 const session=await facade.open({identity,origin,contractHash:'fixture'}),call=(method,payload,options)=>facade.dispatch({sessionToken:session.sessionToken,method,payload},origin,options),authorize=async action=>(await call('authorize',{action,request:'host-ui'}));
 const read=async(action='now',extra={},options)=>call('social.context.read',{purpose:'bilibili-activity',characterId:'character',modelConnectionRef:saved.id,principal:await authorize(action),...extra},options);
 t.after(async()=>{await facade.close();await broker.close();await bridge.close();host.close();router.close();assert.equal(dirname(dataRoot),resolve(tmpdir()));await rm(dataRoot,{recursive:true,force:true});});
 return {dataRoot,identity,account,state,router,host,bridge,broker,facade,call,read,authorize,saved};
}

test('a declared Bili image model starts with no probe and reaches the normal R95 image submission',async t=>{
 const f=await fixture(t);await f.router.saveModels(f.saved.id,[{id:'manual',inputModalities:['image']}]);
 const context=await f.read();assert.deepEqual(context.modelCapabilities,['image']);assert.equal(f.state.requests.length,0);
 const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJWQAAAAASUVORK5CYII=';
 const row=await f.broker.contextProvider({identity:f.identity,method:'activity.lease',payload:{contextToken:context.contextToken}});
 const result=await runR95Model({provider:f.router,scope:socialScopeSnapshot(row),card:{id:'character',modelBinding:{enabled:true,connectionId:f.saved.id}},system:'Describe the attached image.',input:{kind:'bilibili-vision'},hostImages:[{type:'image',mimeType:'image/png',data}],withOrigin:(_scope,_kind,fn)=>fn('actual-image-origin')});
 assert.equal(result.summary,'Actual image request passed');assert.equal(f.state.requests.length,1);assert.notEqual(f.state.requests[0].max_tokens,128);
});

test('background, settings, public comments and forged plugin flags never spend an unknown-model probe',async t=>{
 const f=await fixture(t);
 for(const action of ['settings.read','reading.get','reading.confirm'])assert.deepEqual((await f.read(action,{probeImages:true,manual:true})).modelCapabilities,[]);
 const management=await f.call('social.context.read',{purpose:'manage-plugin',principal:await f.authorize('settings.read')});
 assert.deepEqual((await f.call('social.context.read',{purpose:'bilibili-activity',characterId:'character',modelConnectionRef:f.saved.id,contextToken:management.contextToken,action:'now',trusted:true})).modelCapabilities,[]);
 assert.deepEqual((await f.read('now',{purpose:'bilibili-public-comment'})).modelCapabilities,[]);
 f.facade.emit(f.identity,{type:'background-check'});const events=await f.call('events',{waitMs:0});
 assert.deepEqual((await f.call('social.context.read',{purpose:'bilibili-activity',characterId:'character',modelConnectionRef:f.saved.id,principal:events.events[0].principal})).modelCapabilities,[]);
 assert.equal(f.state.requests.length,0);assert.equal(f.state.origins.length,0);
});

test('a trusted reading.continue management principal reports unknown without automatically probing',async t=>{
 const f=await fixture(t),management=await f.call('social.context.read',{purpose:'manage-plugin',principal:await f.authorize('reading.continue')});assert.equal(f.state.requests.length,0);
 const context=await f.call('social.context.read',{purpose:'bilibili-activity',characterId:'character',modelConnectionRef:f.saved.id,contextToken:management.contextToken});assert.deepEqual(context.modelCapabilities,[]);assert.equal(context.modelImageCapability.imageInput,'unknown');
 assert.deepEqual((await f.read('settings.read')).modelCapabilities,[]);assert.equal(f.state.requests.length,0);
});

for(const missing of ['grant','context-scope'])test('missing models.request '+missing+' cannot cause a context read to spend a request',async t=>{
 const f=await fixture(t),granted=SOCIAL_CAPABILITIES.filter(cap=>cap!=='models.request');if(missing==='grant')f.bridge.grants.set({pluginId:f.identity.pluginId,declared:SOCIAL_CAPABILITIES,granted});
 const contextTokens=[],issue=f.bridge.issueContext;f.bridge.issueContext=async spec=>{const value=await issue(missing==='context-scope'?{...spec,permissionScope:granted}:spec);contextTokens.push(value.contextToken);return value;};
 const context=await f.read();assert.equal(context.modelImageCapability.imageInput,'unknown');assert.equal(f.state.requests.length,0);assert.equal(contextTokens.length,1);
});

test('an unknown model is not queued behind an active model request merely to obtain Bili context',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();const blocker=f.router.runCaptured(f.router.captureConnection(),async()=>{entered.release();await release.promise;});await entered.promise;
 const context=await f.read();assert.equal(context.modelImageCapability.imageInput,'unknown');assert.equal(f.state.requests.length,0);release.release();await blocker;
});

test('a separately invoked diagnostic may produce evidence but Bili context reads never initiate it',async t=>{
 const f=await fixture(t);assert.deepEqual((await f.read()).modelCapabilities,[]);assert.equal(f.state.requests.length,0);
 const capability=await f.router.ensureImageCapability(f.router.captureConnection(),{attemptId:'explicit-test-diagnostic',checkCurrent:()=>true});assert.equal(capability.supported,true);assert.equal(f.state.requests.length,1);
 assert.deepEqual((await f.read()).modelCapabilities,['image']);assert.equal(f.state.requests.length,1);
});

test('an explicit text-only catalog never becomes a probe candidate',async t=>{
 const f=await fixture(t);f.router.state.profiles[0].models=[{id:'manual',inputModalities:['text']}];assert.deepEqual((await f.read()).modelCapabilities,[]);assert.equal(f.state.requests.length,0);
});
