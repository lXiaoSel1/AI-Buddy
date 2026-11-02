import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {SOCIAL_CAPABILITIES} from '../src/buddy-plugin-services/social-contract.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';
import {createModelSubmission} from '../src/model-submission.mjs';

async function fixture(t,{qq=false,instrumented=false}={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'acr-social-attempt-'));
 const identity={pluginId:qq?'qq-attempt-fixture':'bili-attempt-fixture',packageName:qq?'@ai-buddy/qq-connect':'@ai-buddy/bilibili-companion'};
 const account={ref:'account',accountId:'42',generation:1,enabled:true};
 const profile={id:'model',kind:'custom',protocol:'responses',model:'synthetic'};
 const state={clock:1,lifeId:'life',calls:0,afterFinish:()=>{},beforeRun:()=>{}};
 const provider={supportsSubmissionLifecycle:instrumented,enabled:true,ready:Promise.resolve(),state:{profiles:[profile]},captureConnection:()=>structuredClone(profile),resolveConnection:()=>({connectionId:'model'}),resolveContextCapacity:()=>({tokens:32768,source:'fixture',verified:true}),currentSelection:()=>({provider:'model',model:'synthetic'}),selected:()=>profile,outputLimit:()=>512,runCaptured:(_profile,fn)=>{state.beforeRun();return fn();},async *stream(options){if(instrumented){const submission=createModelSubmission(options,'codex',{requestId:77,threadId:'qq-thread'});await submission.prepare();try{await submission.beforeSend();if(state.unsent)throw Object.assign(Error('QQ transport not written'),{code:'CODEX_PROCESS_CHANGED'});submission.attempt();await submission.confirm({turnId:'qq-turn',correlation:'ack'});}catch(error){throw await submission.failure(error);}}state.calls++;yield {type:'text-delta',text:'{"summary":"complete synthetic response"}'};state.afterFinish();yield {type:'finish',reason:{kind:'stop'}};}};
 let bridge,broker;
 const host=createSocialHost({dataRoot,now:()=>state.clock,resolveLife:scope=>({characterId:scope.characterId,personaId:'persona',lifeId:state.lifeId,operationId:'operation'}),model:async({context,payload,signal,check})=>runR95Model({provider,card:{id:context.characterId,modelBinding:{enabled:true,connectionId:'model'}},scope:context,system:payload.system??'',input:{kind:'social-chat',messages:payload.messages},signal,checkCurrent:check,withOrigin:async(_scope,_kind,fn)=>{const result=await fn('native-'+(state.calls+1));await check();return result;},parseOutput:({text,parts,requestId})=>({text,parts,requestId})})});
 bridge=createBuddyPluginServices({now:()=>state.clock,resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});
 bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES});
 const r95={socialHost:host,socialProfile:()=>({characterId:'character',personaId:'persona',lifeId:state.lifeId,operationId:'operation',connectionRef:'model',available:true}),socialCatalog:()=>[],registerSocialDelivery:()=>({revoke(){}}),owner:{owner:()=>null}};
 const accounts={forPlugin:()=>structuredClone(account),get:()=>structuredClone(account),secret:()=>({cookie:'synthetic-only'}),list:()=>[account]};
 broker=createSocialPluginBroker({dataRoot,now:()=>state.clock,accounts,bridge,getR95:()=>r95,getProvider:()=>provider,transport:{observation:()=>({body:JSON.stringify({body:[{content:'host observed cue'}]})}),inbound:()=>({raw:{self_id:42,user_id:123,message_type:'private',time:1,message_id:7,message:[{type:'text',data:{text:'host observed cue'}}]}})},verifyBilibiliAccount:async()=>({connected:true,accountId:'42'})});
 t.after(async()=>{await broker.close();await bridge.close();host.close();await rm(dataRoot,{recursive:true,force:true});});
 const read=payload=>broker.handlers['social.context.read']({identity,payload,context:{authority:{kind:'app',action:qq?'takeover':'watch.now'}},check:async()=>{}});
 if(qq)await read({purpose:'qq-operator-bind',characterId:'character'});
 const context=await read(qq?{purpose:'qq-message',connectionId:'synthetic',sourceMessageId:'7',accountId:'42',senderId:'123',conversationId:'private:123',conversationType:'private',characterId:'character',lifeId:'life',operationId:'operation'}:{purpose:'bilibili-activity',characterId:'character',modelConnectionRef:'model'});
 const row=await broker.contextProvider({identity,method:'activity.lease',payload:{contextToken:context.contextToken}});
 row.observations.push('synthetic-observation');
 const call=(method,payload)=>broker.handlers[method]({identity,context:row,payload,check:async()=>{}});
 const lease=await call('activity.lease',{activityId:'attempt-1'});
 const request=(requestId='batch-1')=>call('models.request',{...lease,requestId,purpose:qq?'qq-reply':'bilibili-understanding',...(qq?{replyStylePolicy:{defaultStyle:'natural',conversationStyle:'inherit'}}:{}),system:'synthetic',messages:[{role:'user',content:'host observed cue'}],material:{items:[{id:'cue',text:'host observed cue'}]}});
 return {dataRoot,state,host,bridge,broker,row,lease,call,request};
}

test('ACR host: an admitted attempt survives five minutes and keeps its shared ordinary token unchanged',async t=>{
 const f=await fixture(t),ordinary=f.row.contextToken;
 f.state.afterFinish=()=>{f.state.clock+=300001;};
 assert.equal((await f.request()).text,'{"summary":"complete synthetic response"}');
 assert.equal((await f.request('batch-2')).requestId,'native-2');
 assert.equal(f.row.contextToken,ordinary);
 assert.equal(f.state.calls,2);
 await f.call('activity.finish',{...f.lease,status:'completed'});
 assert.equal(f.host.activeCount(),0);
 assert.equal(f.bridge.authority.activeCalls(),0);
});

test('ACR host: revoked life can release only its already owned lease',async t=>{
 const f=await fixture(t);f.state.lifeId='replacement-life';
 await f.call('activity.finish',{...f.lease,status:'cancelled'});
 assert.equal(f.host.activeCount(),0);
 assert.equal(f.bridge.authority.activeCalls(),0);
});

test('ACR host: ordinary context TTL remains bounded while the admitted QQ queue survives cumulative five minutes',async t=>{
 const f=await fixture(t,{qq:true}),ordinary=f.row.contextToken;
 f.state.beforeRun=()=>{f.state.clock+=300001;};
 assert.equal((await f.request()).requestId,'native-1');
 assert.equal((await f.request('queued-second')).requestId,'native-2');
 await assert.rejects(f.bridge.authorize({pluginId:f.row.pluginId,contextToken:ordinary,capability:'models.request'}),{code:'BUDDY_CONTEXT_EXPIRED'});
 assert.equal(f.row.contextToken,ordinary);assert.equal(f.state.calls,2);
 await f.call('activity.finish',{...f.lease,status:'completed'});assert.equal(f.bridge.authority.activeCalls(),0);
});

test('ACR host: private lease ownership rejects another plugin or scope and coalesces duplicate admissions',async t=>{
 const f=await fixture(t);
 for(const change of [{pluginId:'wrong-plugin'},{context:{...f.row,personaId:'other-persona'}},{context:{...f.row,sessionId:'other-session'}}])assert.throws(()=>f.host.ownLease({pluginId:f.row.pluginId,context:f.row,leaseId:f.lease.leaseId,...change}));
 const duplicate=await f.call('activity.lease',{activityId:'attempt-1'});assert.equal(duplicate.leaseId,f.lease.leaseId);assert.equal(f.host.activeCount(),1);assert.equal(f.bridge.authority.activeCalls(),1);
 await assert.rejects(f.call('activity.finish',{leaseId:'wrong-lease',status:'cancelled'}));assert.equal(f.host.activeCount(),1);
 await f.call('activity.finish',{...f.lease,status:'cancelled'});assert.equal(f.host.activeCount(),0);assert.equal(f.bridge.authority.activeCalls(),0);
});

test('ACR host: context high-water GC and broker close revoke exact ordinary tokens without collecting a live attempt',async t=>{
 const f=await fixture(t);
 for(let index=0;index<901;index++)await f.broker.handlers['social.context.read']({identity:{pluginId:f.row.pluginId,packageName:f.row.packageName},payload:{purpose:'bilibili-activity',characterId:'character',modelConnectionRef:'model'},context:{authority:{kind:'app',action:'watch.now'}},check:async()=>{}});
 assert.ok(f.bridge.authority.size()<600,'collected rows must release their authority tokens');
 assert.equal((await f.request()).requestId,'native-1');assert.equal(f.host.activeCount(),1);
 await f.broker.close();assert.equal(f.host.activeCount(),0);assert.equal(f.bridge.authority.activeCalls(),0);assert.equal(f.bridge.authority.size(),0);
});

test('ACR host: a complete response is persisted privately before a revoked post-check rejects delivery',async t=>{
 const f=await fixture(t);f.state.afterFinish=()=>{f.state.lifeId='replacement-life';};
 await assert.rejects(f.request());
 const db=new DatabaseSync(join(f.dataRoot,'social-core','runtime-v1.sqlite'),{readOnly:true});
 try{const rows=db.prepare('SELECT state,result FROM models').all();assert.equal(rows.length,1);assert.ok(rows[0].result,'complete observed result must survive failed delivery');assert.equal(JSON.parse(rows[0].result).requestId,'native-1');assert.equal(JSON.parse(rows[0].result).text,'{"summary":"complete synthetic response"}');}finally{db.close();}
 assert.equal(f.state.calls,1);
 await assert.rejects(f.request());
 assert.equal(f.state.calls,1,'revocation must not replay the provider');
});

test('ACR host: failure to persist a complete observation rejects delivery and never authorizes a provider replay',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.dataRoot,'social-core','runtime-v1.sqlite'));
 db.exec("CREATE TRIGGER refuse_observation BEFORE UPDATE ON models WHEN NEW.state='observed' BEGIN SELECT RAISE(ABORT,'synthetic observation write failure');END");
 try{await assert.rejects(f.request(),/synthetic observation write failure/);assert.equal(f.state.calls,1);const row=db.prepare('SELECT state,result FROM models').get();assert.equal(row.state,'unknown');assert.equal(row.result,null);await assert.rejects(f.request(),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});assert.equal(f.state.calls,1);}finally{db.close();}
});

test('ACR host: bridge grant off-on cannot revive an old context or activity attempt',async t=>{
 const f=await fixture(t),grant=f.bridge.grants.get(f.row.pluginId);f.bridge.grants.revoke(f.row.pluginId);f.bridge.grants.set({pluginId:f.row.pluginId,declared:grant.declared,granted:grant.granted});
 await assert.rejects(f.call('activity.lease',{activityId:'forged-new-attempt'}),{code:'BUDDY_PLUGIN_DISABLED'});
 await assert.rejects(f.request());assert.equal(f.state.calls,0);assert.equal(f.host.activeCount(),0);assert.equal(f.bridge.authority.activeCalls(),0);
});

test('ACR host: a failed lease release preserves ownership and broker close can retry the exact terminal write',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.dataRoot,'social-core','events.sqlite'));
 try{db.exec("CREATE TRIGGER refuse_release BEFORE UPDATE ON leases WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'synthetic release write failure');END");await assert.rejects(f.broker.close(),{code:'SOCIAL_LEASE_RELEASE_UNCONFIRMED'});assert.equal(f.host.activeCount(),1);assert.equal(f.bridge.authority.activeCalls(),1);assert.equal(f.row.leases.has(f.lease.leaseId),true);db.exec('DROP TRIGGER refuse_release');await f.broker.close();assert.equal(f.host.activeCount(),0);assert.equal(f.bridge.authority.activeCalls(),0);}finally{db.exec('DROP TRIGGER IF EXISTS refuse_release');db.close();}
});

test('QQ private lifecycle persists not-sent facts and safely retries without a visual authority ticket',async t=>{const f=await fixture(t,{qq:true,instrumented:true});f.state.unsent=true;await assert.rejects(f.request(),{code:'SOCIAL_MODEL_NOT_SUBMITTED',causeCode:'CODEX_PROCESS_CHANGED'});const db=new DatabaseSync(join(f.dataRoot,'social-core','runtime-v1.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT state FROM models').get();assert.equal(row.state,'not-sent');const events=db.prepare('SELECT body FROM model_transport_events ORDER BY sequence').all().map(x=>JSON.parse(x.body));assert.deepEqual(events.map(x=>x.phase),['preparing','send-attempt','not-sent']);}finally{db.close();}assert.equal(f.state.calls,0);f.state.unsent=false;assert.equal((await f.request()).requestId,'native-1');assert.equal(f.state.calls,1);});
