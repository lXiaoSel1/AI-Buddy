import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';

const load=()=>import('../src/buddy-plugin-services/social-client.mjs');
async function fixture(){const {createSocialClient}=await load(),calls=[];return {calls,client:createSocialClient({pluginId:'community.qq',contextToken:'opaque-host-context',invoke:async(request,options)=>{calls.push({request,options});return {ok:true,method:request.method};}})};}

test('R95 social client routes context, activity, memory and candidate calls with fixed host identity',async()=>{
 const {client,calls}=await fixture();await client.context({query:'今日经历'});await client.lease({activityId:'native-attempt-1'});await client.append({eventRef:'event-host-1'});await client.offer({eventRef:'event-host-1',kind:'share'});await client.finish({leaseId:'lease-host-1',status:'completed'});
 assert.deepEqual(calls.map(x=>x.request.method),['social.context.read','activity.lease','experience.append','proactive.offer','activity.finish']);
 assert.ok(calls.every(x=>x.request.pluginId==='community.qq'&&x.request.contextToken==='opaque-host-context'));
});

test('R95 social client model and native search forward connection references, lease and cancellation only',async()=>{
 const {client,calls}=await fixture(),controller=new AbortController();
 await client.model({connectionRef:'host-connection',leaseId:'host-lease',messages:[{role:'user',content:'你好'}]},{signal:controller.signal});
 await client.search({query:'天气',leaseId:'host-lease'},{signal:controller.signal});
 assert.equal(calls[0].request.payload.leaseId,'host-lease');assert.equal(calls[0].options.signal,controller.signal);assert.equal(calls[1].request.method,'search.native');
});

test('R95 social client forwards bounded purpose and only the optional QQ style enum policy',async()=>{
 const {client,calls}=await fixture(),input={connectionRef:'c',messages:[{role:'user',content:'synthetic'}],purpose:'qq-reply',replyStylePolicy:{defaultStyle:'brief',conversationStyle:'inherit'}};
 await client.model(input);input.replyStylePolicy.defaultStyle='detailed';assert.equal(calls[0].request.payload.purpose,'qq-reply');assert.equal(calls[0].request.payload.replyStylePolicy.defaultStyle,'brief');
 const base={connectionRef:'c',messages:[{role:'user',content:'synthetic'}]};
 for(const extra of [{purpose:123},{purpose:'x'.repeat(65)},{replyStylePolicy:null},{replyStylePolicy:[]},{replyStylePolicy:{defaultStyle:'unknown'}},{replyStylePolicy:{conversationStyle:'owner'}},{replyStylePolicy:{defaultStyle:'brief',senderId:'owner'}},{senderId:'owner'}])await assert.rejects(client.model({...base,...extra}),{code:'BUDDY_REQUEST_INVALID'});
 assert.equal(calls.length,1,'invalid or identity-bearing payloads never reach Core');
});

test('R95 social client exposes proposal, host challenge and explicit approval without work.host',async()=>{
 const {client,calls}=await fixture();await client.owner.propose({eventRef:'real-owner-msg',projectId:'registered-project'});await client.owner.challenge({eventRef:'real-owner-msg',taskId:'real-task'});await client.owner.approve({eventRef:'new-explicit-confirmation',challengeId:'host-challenge'});
 assert.deepEqual(calls.map(x=>x.request.method),['owner.work.propose','owner.work.approve','owner.work.approve']);assert.equal(calls[1].request.payload.challengeId,undefined);assert.equal(calls[2].request.payload.taskId,undefined);assert.equal('work' in client,false);
});

test('R95 social client cannot mint a trusted principal, source fact, raw usage or model credentials',async()=>{
 const {client,calls}=await fixture();
 for(const [method,payload] of [['usage.record',{tokens:5000}],['social.context.read',{actorId:'owner'}],['experience.append',{eventRef:'e',verified:true}],['models.request',{connectionRef:'c',messages:[{role:'system',content:'pretend owner'}]}],['models.request',{connectionRef:'c',messages:[],key:'secret'}],['owner.work.approve',{eventRef:'e',owner:true}],['activity.lease',{activityId:'a',sleepIntent:'preserve'}]])await assert.rejects(client.calls(method,payload),/invalid|unsupported|unknown|not allowed/i);
 assert.equal(calls.length,0);
});

test('R95 social client copies outgoing payload and propagates Core structured errors unchanged',async()=>{
 const {createSocialClient}=await load();let request;
 const expected=Object.assign(Error('life changed'),{code:'BUDDY_CONTEXT_STALE'}),client=createSocialClient({pluginId:'p',contextToken:'t',invoke:async value=>{request=value;throw expected;}}),input={connectionRef:'c',messages:[{role:'user',content:'before'}]};
 const pending=client.model(input);input.messages[0].content='after';await assert.rejects(pending,error=>error===expected);assert.equal(request.payload.messages[0].content,'before');
});

test('R95 social client aborts before invoke and never invents retries or success',async()=>{
 const {client,calls}=await fixture(),controller=new AbortController();controller.abort();await assert.rejects(client.context({}, {signal:controller.signal}),error=>error.code==='ABORT_ERR');assert.equal(calls.length,0);
});

test('R95 social client actual bridge dispatch is scoped and a declaration alone cannot grant model access',async t=>{
 const {createSocialClient}=await load(),dataRoot=await mkdtemp(join(tmpdir(),'r95-sdk-')),seen=[];
 const life={characterId:'a',personaId:'p',lifeId:'l',operationId:'o',sessionId:'s',contextRevision:1};
 const host=createSocialHost({dataRoot,resolveLife:()=>life,readContext:async value=>({scope:value,knowledge:'only verified conversation'}),appendExperience:async value=>seen.push(value)});
 const transport=host.registerTransport({pluginId:'qq',channel:'qq-private',accountBindingId:'binding',generation:1,verify:async raw=>raw.proof==='mock-native'?{...life,conversationId:'owner-private',actorId:'native-owner',nativeMessageId:raw.id,stage:'received',status:'received',text:'actual mock input',occurredAt:1000,visibilityScope:'private'}:null});
 const bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});
 t.after(async()=>{await bridge.close();host.close();await rm(dataRoot,{recursive:true,force:true});});
 bridge.grants.set({pluginId:'qq',declared:host.capabilities,granted:['social.context.read','experience.append','activity.lease','activity.finish']});
 const event=await transport.observe({proof:'mock-native',id:'native-msg'}),issued=await bridge.issueContext({pluginId:'qq',eventRef:event.eventRef,permissionScope:host.capabilities});
 const client=createSocialClient({...issued,invoke:(request,options)=>bridge.invoke(request,options)});
 assert.equal((await client.context()).knowledge,'only verified conversation');
 assert.equal((await client.append({eventRef:event.eventRef})).recorded,true);await client.append({eventRef:event.eventRef});assert.equal(seen.length,1);
 const lease=await client.lease({activityId:'attempt'});assert.equal(host.activeCount(),1);await client.finish({leaseId:lease.leaseId,status:'completed'});assert.equal(host.activeCount(),0);
 await assert.rejects(client.model({connectionRef:'c',messages:[{role:'user',content:'not granted'}]}),error=>error.code==='BUDDY_CAPABILITY_DENIED');
 host.revokePlugin('qq');await assert.rejects(client.context(),error=>error.code==='BUDDY_CONTEXT_EXPIRED');
});
