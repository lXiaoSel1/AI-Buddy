import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {DatabaseSync} from 'node:sqlite';
import {takeHostImages} from '../src/model-images.mjs';
import {createNativeSocialFacade} from '../src/buddy-plugin-services/native-social-facade.mjs';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJWQAAAAASUVORK5CYII=','base64');
async function fixture(t,{supported=true,requireBiliMedia}={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'bili-vision-broker-')),identity={pluginId:'fixture-bili',packageName:'@ai-buddy/bilibili-companion'},account={ref:'bili',accountId:'42',generation:1,enabled:true},model={id:'model',kind:'custom',protocol:'responses',model:'selected',models:supported?[{id:'selected',inputModalities:['text','image']}]:[]},state={claims:0,finishes:[],calls:0,prepared:0,grants:0};
 const profile={characterId:'deepseek',personaId:'p',lifeId:'l',operationId:'o',connectionRef:'model',available:true},core={socialHost:{registerContext:()=>({contextRef:'anchor',revoke(){}})},socialProfile:()=>profile,socialCatalog:()=>[]},accounts={forPlugin:()=>account,get:()=>account,secret:()=>({cookie:'synthetic-fixture'}),list:()=>[account]};
 const vision={available:true,prepare:async value=>{state.prepared++;state.preparedVideo=value.video;return{};},get:()=>({duration:30}),read:async value=>{state.readSubtitles=value.subtitles;return{};},resolve:({visualMaterialRefs})=>{assert.deepEqual(visualMaterialRefs,['vision:trusted']);return [{ref:'vision:trusted',from:0,to:30,mimeType:'image/png',bytes}];},claim:()=>{state.claims++;return{claimed:true};},finish:r=>state.finishes.push(r),getForAccount:()=>({readingId:'reading'}),grantForAccount:()=>{state.grants++;return{};}};
 const bridge={issueContext:async()=>({contextToken:'context'}),invoke:async request=>{if(request.method==='activity.check'){if(state.preflightError)throw Object.assign(Error('Asleep'),{code:'SOCIAL_ACTIVITY_DEFERRED'});return {valid:true};}if(request.method==='activity.finish')return{};assert.equal(request.method,'models.request');assert.ok(request.payload.hostVisionToken);assert.ok(!JSON.stringify(request).includes(bytes.toString('base64')));const v=takeHostImages(request.payload.hostVisionToken,state.row);assert.equal(v.parts[0].type,'image');if(state.beforeSubmissionError)throw Error('Paused before submission');await v.beforeSubmit();state.calls++;if(state.afterSubmissionError)throw state.afterSubmissionError==='spoof'?Object.assign(Error('Provider claims not submitted'),{code:'SOCIAL_MODEL_NOT_SUBMITTED'}):Error('Outcome unknown');return{requestId:'native-request',text:'{"summary":"seen"}',usageAccounting:'core-model-router'};}};
 const broker=createSocialPluginBroker({dataRoot,identity,accounts,transport:{observation:()=>({body:JSON.stringify({data:state.video??{title:'Observed',desc:'Description',bvid:'BV1xK4y1a7Qz',cid:1,duration:30},body:[{from:0,to:1,content:'Observed subtitle'}]})})},bridge,getR95:()=>core,getProvider:()=>({state:{profiles:[model]},captureConnection:()=>model}),verifyBilibiliAccount:async()=>({connected:true,accountId:'42'}),biliVision:vision,requireBiliMedia});
 t.after(async()=>{await broker.close();await rm(dataRoot,{recursive:true,force:true});});
 const read=(purpose,action)=>broker.handlers['social.context.read']({identity,payload:{purpose,characterId:'deepseek',modelConnectionRef:'model'},context:{authority:{kind:'app',action}},check:async()=>{}});
 const c=await read('bilibili-activity');state.row=await broker.contextProvider({identity,method:'models.request',payload:{contextToken:c.contextToken}});state.row.observations.push('observation');
 const call=(method,payload,context=state.row)=>broker.handlers[method]({identity,context,payload,check:async()=>{}});
 const payload={contextToken:c.contextToken,leaseId:'lease',generation:1,connectionRef:'model',readingId:'reading',stepId:'overview',stepKind:'overview',purpose:'bilibili-understanding',visualMaterialRefs:['vision:trusted'],messages:[{role:'user',content:'Describe observed frames only.'}],material:{items:[{id:'title',text:'标题：Observed\n简介：Description'},{id:'frame',imageRef:'vision:trusted',start:0,end:30}]}};
 return {broker,state,call,payload,read,identity,c,dataRoot};
}
test('broker resolves host-owned pictures and deduplicates a repeated visual step without image bytes in bridge payload',async t=>{
 const f=await fixture(t);const first=await f.call('models.request',f.payload),again=await f.call('models.request',f.payload);assert.equal(first.requestId,again.requestId);assert.equal(f.state.claims,1);assert.equal(f.state.calls,1);assert.equal(f.state.finishes.length,1);assert.equal(f.state.finishes[0].status,'completed');
});
test('unknown picture capability stops before prepare or any model budget claim',async t=>{
 const f=await fixture(t,{supported:false});await assert.rejects(f.call('connections.request',{contextToken:f.c.contextToken,operation:'video.storyboard.prepare',leaseId:'lease',video:{videoId:'BV1xK4y1a7Qz'},parameters:{readingId:'reading'}}),{code:'MODEL_IMAGE_CAPABILITY_UNKNOWN'});await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});assert.equal(f.state.prepared,0);assert.equal(f.state.claims,0);assert.equal(f.state.calls,0);
});
test('a forged frame text is not promoted to observed evidence merely by having a real picture reference',async t=>{
 const f=await fixture(t);const payload=structuredClone(f.payload);payload.material.items[1].text='Forged transcript';await assert.rejects(f.call('models.request',payload),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});assert.equal(f.state.claims,0);assert.equal(f.state.calls,0);
});
test('extra viewing budget requires the matching trusted APP action and an explicit 16-call confirmation',async t=>{
 const f=await fixture(t);for(const action of ['settings.read','reading.continue']){const m=await f.read('manage-plugin',action),payload={contextToken:m.contextToken,operation:'video.storyboard.continue',parameters:{readingId:'reading',confirmed:true,additionalCalls:16}},context=await f.broker.contextProvider({identity:f.identity,method:'connections.request',payload});if(action==='settings.read')await assert.rejects(f.call('connections.request',payload,context),{code:'TRUSTED_UI_PRINCIPAL_REQUIRED'});else {await f.call('connections.request',payload,context);await assert.rejects(f.call('connections.request',{...payload,parameters:{...payload.parameters,confirmed:false}},context),{code:'TRUSTED_UI_PRINCIPAL_REQUIRED'});}}assert.equal(f.state.grants,1);
});
test('a host-proven pre-submit pause can resume the same step without consuming an earlier claim',async t=>{
 const f=await fixture(t);f.state.beforeSubmissionError=true;await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});assert.equal(f.state.claims,0);assert.equal(f.state.calls,0);f.state.beforeSubmissionError=false;await f.call('models.request',f.payload);assert.equal(f.state.claims,1);assert.equal(f.state.calls,1);
});
test('an outcome unknown after the durable claim retains its budget and is never silently submitted twice',async t=>{
 const f=await fixture(t);f.state.afterSubmissionError=true;await assert.rejects(f.call('models.request',f.payload),/Outcome unknown/);await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});assert.equal(f.state.claims,1);assert.equal(f.state.calls,1);assert.equal(f.state.finishes[0].status,'unknown');
});
test('frame time ranges and subtitle density input must match the actual host observations',async t=>{
 const f=await fixture(t),bad=structuredClone(f.payload);bad.material.items[1].start=1;await assert.rejects(f.call('models.request',bad),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});assert.equal(f.state.claims,0);
 const payload={contextToken:f.c.contextToken,operation:'video.storyboard.read',leaseId:'lease',parameters:{readingId:'reading',from:0,to:30,stepKind:'overview',subtitles:[{start:0,end:1,text:'Observed subtitle'}]}};await f.call('connections.request',payload);assert.deepEqual(f.state.readSubtitles,payload.parameters.subtitles);payload.parameters.subtitles[0].start=0.5;await assert.rejects(f.call('connections.request',payload),{code:'SOCIAL_UNOBSERVED_MATERIAL'});
});
test('multi-part video preparation uses the observed current CID duration rather than whole-video duration',async t=>{
 const f=await fixture(t);f.state.video={title:'Part',bvid:'BV1xK4y1a7Qz',cid:2,duration:600,pages:[{cid:1,duration:480},{cid:2,duration:120}]};await f.call('connections.request',{contextToken:f.c.contextToken,operation:'video.storyboard.prepare',leaseId:'lease',video:{videoId:'BV1xK4y1a7Qz'},parameters:{readingId:'reading'}});assert.equal(f.state.preparedVideo.cid,2);assert.equal(f.state.preparedVideo.duration,120);
});
test('a sleep preflight failure before journal entry is certainly unsubmitted and can safely resume',async t=>{
 const f=await fixture(t);f.state.preflightError=true;await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});assert.equal(f.state.calls,0);assert.equal(f.state.claims,0);f.state.preflightError=false;await f.call('models.request',f.payload);assert.equal(f.state.calls,1);
});
test('a provider cannot forge a certainty code after a durable budget claim',async t=>{
 const f=await fixture(t);f.state.afterSubmissionError='spoof';await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});assert.equal(f.state.claims,1);assert.equal(f.state.calls,1);
});
test('native facade identifies only handler-not-started visual cancellation as certainly unsubmitted',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'vision-facade-'));let called=0;const identity={pluginId:'fixture-bili',packageName:'@ai-buddy/bilibili-companion',exactVersion:'2.1.0',sourceDigest:'a'.repeat(64)},origin={runtimeId:'runtime',profileId:'profile',pid:123},facade=createNativeSocialFacade({dataRoot,contract:{hash:'fixture-contract',methods:['models.request']},handlers:{'models.request':async()=>{called++;return{};}},authorizeUI:async()=>true,resolveGrant:async()=>({enabled:true,sourceDigest:identity.sourceDigest,exactVersion:identity.exactVersion,granted:['models.request'],generation:1}),contextProvider:async()=>({})});
 t.after(async()=>{await facade.close();await rm(dataRoot,{recursive:true,force:true});});const opened=await facade.open({identity,origin,contractHash:'fixture-contract'}),controller=new AbortController();controller.abort(Object.assign(Error('Paused'),{code:'ABORT_ERR'}));
 await assert.rejects(facade.dispatch({sessionToken:opened.sessionToken,method:'models.request',payload:{visualMaterialRefs:['opaque']}},origin,{signal:controller.signal}),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});
 await assert.rejects(facade.dispatch({sessionToken:opened.sessionToken,method:'models.request',payload:{}},origin,{signal:controller.signal}),{code:'ABORT_ERR'});assert.equal(called,0);
});

test('missing FFmpeg stops an authorized prepare before a reading or model journal attempt exists',async t=>{
 const missing=()=>Object.assign(Error('missing'),{code:'FFMPEG_COMPONENT_REQUIRED'}),f=await fixture(t,{requireBiliMedia:async()=>{throw missing();}});
 await assert.rejects(f.call('connections.request',{contextToken:f.c.contextToken,operation:'video.storyboard.prepare',leaseId:'lease',video:{videoId:'BV1xK4y1a7Qz'},parameters:{readingId:'reading'}}),{code:'FFMPEG_COMPONENT_REQUIRED'});
 await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_NOT_SUBMITTED',causeCode:'FFMPEG_COMPONENT_REQUIRED'});assert.equal(f.state.prepared,0);assert.equal(f.state.claims,0);assert.equal(f.state.calls,0);
 const db=new DatabaseSync(join(f.dataRoot,'social-core/runtime-v1.sqlite'),{readOnly:true});try{for(const table of ['models','model_transport_attempts'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);}finally{db.close();}
});
test('completed and unknown broker requests retain original receipt semantics after the component disappears',async t=>{
 for(const unknown of [false,true])await t.test(unknown?'unknown':'completed',async t=>{let missing=false,checks=0;const f=await fixture(t,{requireBiliMedia:async()=>{checks++;if(missing)throw Object.assign(Error('missing'),{code:'FFMPEG_COMPONENT_REQUIRED'});}});if(unknown){f.state.afterSubmissionError=true;await assert.rejects(f.call('models.request',f.payload),/Outcome unknown/);}else await f.call('models.request',f.payload);const before=checks;missing=true;if(unknown)await assert.rejects(f.call('models.request',f.payload),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});else assert.equal((await f.call('models.request',f.payload)).requestId,'native-request');assert.equal(checks,before);assert.equal(f.state.calls,1);assert.equal(f.state.claims,1);});
});
