import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {inflateSync} from 'node:zlib';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {createSocialPluginBroker,SOCIAL_RUNTIME_METHODS} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {createNativeSocialFacade} from '../src/buddy-plugin-services/native-social-facade.mjs';
import {SOCIAL_CAPABILITIES} from '../src/buddy-plugin-services/social-contract.mjs';

const digitRows=['11111/10001/10001/10001/10001/10001/11111','00100/01100/00100/00100/00100/00100/01110','11111/00001/00001/11111/10000/10000/11111','11111/00001/00001/11111/00001/00001/11111','10001/10001/10001/11111/00001/00001/00001','11111/10000/10000/11111/00001/00001/11111','11111/10000/10000/11111/10001/10001/11111','11111/00001/00010/00100/01000/01000/01000','11111/10001/10001/11111/10001/10001/11111','11111/10001/10001/11111/00001/00001/11111'];
// The fake external model reads the transmitted pixels, never the host answer.
function readDigits(data){
 const png=Buffer.from(data,'base64'),chunks=[];let width,height;
 for(let at=8;at<png.length;){const size=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),bytes=png.subarray(at+8,at+8+size);if(type==='IHDR'){width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);}if(type==='IDAT')chunks.push(bytes);at+=size+12;}
 const pixels=inflateSync(Buffer.concat(chunks)),ink=(x,y)=>pixels[y*(width+1)+x+1]<128,runs=[];
 for(let x=0;x<width;x++)if(Array.from({length:height},(_,y)=>y).some(y=>ink(x,y))){if(!runs.length||x>runs.at(-1).at(-1)+1)runs.push([x]);else runs.at(-1).push(x);}
 assert.equal(runs.length,6);return runs.map(run=>{let top=0;while(!run.some(x=>ink(x,top)))top++;for(let digit=0;digit<10;digit++){const grid=digitRows[digit].split('/'),trim=Math.min(...grid.map(row=>row.indexOf('1')).filter(n=>n>=0));if(grid.every((row,y)=>[...row].slice(trim).every((value,x)=>ink(run[0]+x*8,top+y*8)===(value==='1'))))return String(digit);}throw Error('Unreadable fixture PNG');}).join('');
}

async function fixture(t){
 const dataRoot=await mkdtemp(join(tmpdir(),'voice-r9-image-origin-')),requests=[],usages=[],cleanups=[],state={beforeResponse:async()=>{}};let game;
 const router=new ModelRouter({dataRoot,codex:{defaultModel:'fixture',enabled:false,setEnabled(value){this.enabled=value;},listModels:()=>[],close(){}},crypto:{isEncryptionAvailable:()=>false},timeoutMs:1000,onUsage:value=>usages.push(value),fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);requests.push({url,body,origin:game.r95.currentOrigin()});await state.beforeResponse(init.signal);init.signal.throwIfAborted();
  const image=body.messages.at(-1).content.find(part=>part.type==='image_url'),text=readDigits(image.image_url.url.split(',')[1]);
  return new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:6}}),{headers:{'content-type':'application/json'}});
 }});
 await router.ready;const saved=await router.save({kind:'custom',protocol:'chat-completions',name:'Isolated origin fixture',baseUrl:'http://127.0.0.1:1',model:'fixture'});await router.activate(saved.id);router.setEnabled(true);
 game=await createGalgame({dataRoot,provider:router,model:'fixture',automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false,getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:7})}});
 t.after(async()=>{for(const close of cleanups)await close();await game.close();router.close();assert.equal(dirname(dataRoot),resolve(tmpdir()));await rm(dataRoot,{recursive:true,force:true});});
 return {dataRoot,router,game,requests,usages,saved,state,cleanups,scope:game.r95.scopeFor('deepseek','default','bilibili','origin-fixture')};
}

async function nativeBili(f){
 const identity={pluginId:'r9-bili-fixture',packageName:'@ai-buddy/bilibili-companion',exactVersion:'fixture',sourceDigest:'a'.repeat(64)},origin={runtimeId:'fixture',profileId:'fixture',pid:1};
 const account={ref:'synthetic-account',accountId:'42',generation:1,enabled:true},host=f.game.r95.socialHost;
 const bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});
 bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES});
 const accounts={forPlugin:()=>structuredClone(account),get:()=>structuredClone(account),secret:()=>({cookie:'synthetic'}),list:()=>[structuredClone(account)]};
 const broker=createSocialPluginBroker({dataRoot:f.dataRoot,accounts,bridge,getR95:()=>f.game.r95,getProvider:()=>f.router,transport:{},verifyBilibiliAccount:async()=>({connected:true,accountId:'42'})});
 const facade=createNativeSocialFacade({dataRoot:f.dataRoot,contract:{hash:'r9-fixture',methods:SOCIAL_RUNTIME_METHODS},handlers:broker.handlers,contextProvider:broker.contextProvider,authorizeUI:async()=>true,resolveGrant:async()=>({...identity,enabled:true,granted:SOCIAL_RUNTIME_METHODS,generation:1})});
 f.cleanups.push(()=>facade.close(),()=>broker.close(),()=>bridge.close());
 const session=await facade.open({identity,origin,contractHash:'r9-fixture'}),call=(method,payload,options)=>facade.dispatch({sessionToken:session.sessionToken,method,payload},origin,options);
 const principal=await call('authorize',{action:'now',request:'synthetic-host-ui'}),read=options=>call('social.context.read',{purpose:'bilibili-activity',characterId:'deepseek',modelConnectionRef:f.saved.id,principal},options);
 return {read};
}

test('R9 the real Galgame R95 origin boundary admits image capability probes and finishes their registry record',async t=>{
 const f=await fixture(t);let originId;
 const result=await f.game.r95.withOrigin(f.scope,'image-capability-probe',async id=>{
  originId=id;assert.equal(f.game.r95.currentOrigin().originId,id);
  const origin=f.game.r95.origins.resolve(id);assert.equal(origin.kind,'image-capability-probe');assert.equal(origin.sleepPolicy,'wake');assert.deepEqual(origin.scope,f.scope);assert.equal(origin.finishedAt,undefined);return 'probe-admitted';
 });
 assert.equal(result,'probe-admitted');assert.ok(Number.isFinite(f.game.r95.origins.resolve(originId).finishedAt));assert.equal(f.game.r95.currentOrigin(),null);assert.equal(f.requests.length,0);
});

test('R9 the real registry keeps unknown kinds, stale life scopes and cross-scope parents rejected',async t=>{
 const f=await fixture(t),registry=f.game.r95.origins;let callbacks=0;
 await assert.rejects(f.game.r95.withOrigin(f.scope,'image-capability-probe-unknown',async()=>{callbacks++;}),{code:'ACTIVITY_ORIGIN_INVALID'});
 await assert.rejects(f.game.r95.withOrigin({...f.scope,lifeId:'old-life'},'image-capability-probe',async()=>{callbacks++;}),{code:'SOCIAL_STALE_LIFE'});
 const parent=registry.issue({scope:f.scope,kind:'dream',sleepIntentGeneration:7});
 assert.throws(()=>registry.issue({scope:{...f.scope,conversationId:'another'},kind:'image-capability-probe',parentOriginId:parent}),{code:'ACTIVITY_ORIGIN_INVALID'});
 registry.revoke(parent);assert.throws(()=>registry.issue({scope:f.scope,kind:'image-capability-probe',parentOriginId:parent}),{code:'ACTIVITY_ORIGIN_INVALID'});
 assert.equal(callbacks,0);assert.equal(f.requests.length,0);
});

test('R9 a nested real R95 image probe inherits its active parent sleep intent and finishes both origins',async t=>{
 const f=await fixture(t);let parentId,childId;
 await f.game.r95.withOrigin(f.scope,'dream',async parent=>{
  parentId=parent;
  await f.game.r95.withOrigin({...f.scope,channel:'app-private',conversationId:'nested'},'image-capability-probe',async child=>{
   childId=child;const origin=f.game.r95.origins.resolve(child);
   assert.equal(origin.kind,'image-capability-probe');assert.equal(origin.sleepPolicy,'preserve');assert.equal(origin.sleepIntentGeneration,7);assert.deepEqual(origin.scope,f.scope);
  });
  assert.ok(Number.isFinite(f.game.r95.origins.resolve(childId).finishedAt));assert.equal(f.game.r95.origins.resolve(parentId).finishedAt,undefined);
 });
 assert.ok(Number.isFinite(f.game.r95.origins.resolve(parentId).finishedAt));assert.equal(f.game.r95.currentOrigin(),null);
});

test('R9 real R95 cancellation and callback failures finish the probe origin without a model submission',async t=>{
 const f=await fixture(t),controller=new AbortController();let cancelledId,failedId;
 await assert.rejects(f.game.r95.withOrigin(f.scope,'image-capability-probe',async id=>{cancelledId=id;controller.abort();return 'discard';},{signal:controller.signal}),/请求已取消/);
 assert.ok(Number.isFinite(f.game.r95.origins.resolve(cancelledId).finishedAt));
 const failure=Error('Synthetic callback failed');
 await assert.rejects(f.game.r95.withOrigin(f.scope,'image-capability-probe',async id=>{failedId=id;throw failure;}),error=>error===failure);
 assert.ok(Number.isFinite(f.game.r95.origins.resolve(failedId).finishedAt));assert.equal(f.game.r95.currentOrigin(),null);assert.equal(f.requests.length,0);
});

test('R9 an actual temporary life reset revokes an in-flight image origin and rejects its late result',async t=>{
 const f=await fixture(t);let oldOrigin;
 await assert.rejects(f.game.r95.withOrigin(f.scope,'image-capability-probe',async id=>{oldOrigin=id;await f.game.action('companion-life-reset',{characterId:'deepseek',mode:'blank'});return 'old-life-result';}),{code:'SOCIAL_STALE_LIFE'});
 assert.equal(f.game.r95.origins.resolve(oldOrigin),null);assert.notEqual(f.game.r95.scopeFor('deepseek','default','bilibili','origin-fixture').lifeId,f.scope.lifeId);assert.equal(f.requests.length,0);
});

test('R12 trusted NativeSocialFacade Bili start reports unknown without creating a probe origin or model request',async t=>{
 const f=await fixture(t),bili=await nativeBili(f),context=await bili.read();
 assert.deepEqual(context.modelCapabilities,[]);assert.equal(context.modelImageCapability.imageInput,'unknown');assert.equal(f.requests.length,0);assert.equal(f.usages.length,0);
 assert.equal(f.game.r95.currentOrigin(),null);assert.deepEqual((await bili.read()).modelCapabilities,[]);assert.equal(f.requests.length,0);
});

test('R12 cancellation through NativeSocialFacade stops the context read without a model request',async t=>{
 const f=await fixture(t),bili=await nativeBili(f),controller=new AbortController();controller.abort();
 await assert.rejects(bili.read({signal:controller.signal}));assert.equal(f.requests.length,0);
 assert.equal(f.router.imageCapability(f.router.captureConnection()).supported,false);assert.equal(f.game.r95.currentOrigin(),null);
});
