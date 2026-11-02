import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSocialAccounts} from '../src/buddy-plugin-services/social-accounts.mjs';
import {createSocialTransport} from '../src/buddy-plugin-services/social-transport.mjs';
import {createSocialRuntimeJournal} from '../src/buddy-plugin-services/social-runtime-journal.mjs';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';

const identity={pluginId:'memory-only-qq',packageName:'@ai-buddy/qq-connect'},at=1700000000000;
async function fixture(t,{unknown=false,appendFailure=false,rejectIntent=false}={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'qq-memory-only-')),accounts=createSocialAccounts({dataRoot}),account=accounts.save({pluginId:identity.packageName,accountId:'123',label:'Isolated QQ',httpUrl:'http://127.0.0.1:45678',webSocketUrl:'ws://127.0.0.1:45679'}),calls=[],experiences=[];
 const scope={...identity,characterId:'original',personaId:'persona',lifeId:'life',operationId:'operation',sessionId:'session',channel:'qq-private',conversationId:'private:789',conversationType:'private',peerId:'789',actorId:'789',senderId:'789',sourceMessageId:'incoming',accountBindingId:'123',bindingGeneration:account.generation,activityGeneration:1,visibilityScope:'conversation',connectionRef:'original-model'};
 const context={...scope,account,contextRef:'original-host-anchor',contextToken:'original-host-token',operatorGeneration:1,evidence:[],facts:[]};
 const journal=createSocialRuntimeJournal({dataRoot});journal.saveContext(context.contextToken,context);await journal.close();
 class Socket extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}close(){this.dispatchEvent(new Event('close'));}}
 const transport=createSocialTransport({dataRoot,accounts,now:()=>at,WebSocketImpl:Socket,fetchImpl:async(url,init)=>{const action=new URL(url).pathname.split('/').at(-1);calls.push(action);if(action!=='get_login_info'&&unknown)throw Error('accepted result lost');return Response.json({status:'ok',retcode:0,data:action==='get_login_info'?{user_id:123}:{message_id:456}});}});
 const opened=await transport.open({connectionRef:account.ref,accountId:'123',newEventsOnly:true},scope),payload={connectionId:opened.connectionId,accountId:'123',action:'send_private_msg',requestId:'original-send-request',params:{message:[{type:'text',data:{text:'Original successful text'}}],user_id:'789'}};
 if(rejectIntent){const db=new DatabaseSync(join(dataRoot,'social-core','transport-v1.sqlite'));db.exec("CREATE TRIGGER memory_insert_failure BEFORE INSERT ON qq_memory_intents BEGIN SELECT RAISE(ABORT,'test intent write failure'); END");db.close();}
 const sent=await transport.request(payload,scope,{memoryContext:context});let broker,host,bridge,failAppend=appendFailure,time=at+60000,profile={...scope},appendGate=null;
 function start(){host=createSocialHost({dataRoot,now:()=>at+60000,resolveLife:()=>({...scope}),appendExperience:async event=>{calls.push('experience.append');if(appendGate)await appendGate;if(failAppend)throw Error('temporary memory failure');if(!experiences.some(row=>row.eventId===event.eventId))experiences.push(event);}});bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});bridge.grants.set({pluginId:identity.pluginId,declared:host.capabilities,granted:host.capabilities});broker=createSocialPluginBroker({dataRoot,accounts,transport,bridge,getR95:()=>({socialHost:host,socialProfile:()=>({...profile}),socialCatalog:()=>[]}),getProvider:()=>({state:{profiles:[]}}),now:()=>time});return broker;}
 t.after(async()=>{await broker?.close();await bridge?.close();host?.close();await transport.close();accounts.close();await rm(dataRoot,{recursive:true,force:true});});
 return {dataRoot,accounts,account,scope,context,transport,calls,experiences,sent,start,setAppendFailure:value=>failAppend=value,setProfile:value=>Object.assign(profile,value),advance:value=>time+=value,setAppendGate:value=>appendGate=value,restart:async()=>{await broker?.close();await bridge?.close();host?.close();return start();}};
}

test('QQ successful send and immutable memory intent commit in the same transport transaction',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));try{
 const send=db.prepare("SELECT * FROM sends WHERE state='completed'").get();assert.ok(send);assert.equal(f.sent.status,'sent');
 const row=db.prepare('SELECT * FROM qq_memory_intents').get();assert.ok(row,'actual successful transport result must survive a crash before broker saveContext');
 const proof=JSON.parse(row.proof_json);assert.equal(proof.requestId,'original-send-request');assert.equal(proof.messageId,'456');assert.equal(proof.text,'Original successful text');assert.equal(proof.occurredAt,at);assert.equal(proof.context.contextRef,'original-host-anchor');assert.equal(proof.context.characterId,'original');assert.match(row.proof_digest,/^[a-f0-9]{64}$/);assert.equal(row.state,'pending');}finally{db.close();}
});
test('QQ unknown send creates no successful memory intent and is never replayed',async t=>{
 const f=await fixture(t,{unknown:true}),broker=f.start();assert.equal(f.sent.status,'unknown');
 await broker.recoverQqMemory();assert.equal(f.experiences.length,0);assert.equal(f.calls.filter(v=>v==='send_private_msg').length,1);
});
test('QQ restart compensates only original success memory and dedupes append before transport ACK',async t=>{
 const f=await fixture(t),broker=f.start();await broker.recoverQqMemory();assert.equal(f.experiences.length,1);assert.equal(f.experiences[0].text,'Original successful text');assert.equal(f.experiences[0].occurredAt,at);assert.equal(f.experiences[0].characterId,'original');
 const originalRef=f.experiences[0].eventRef,db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));db.exec("UPDATE qq_memory_intents SET state='pending',next_at=0");db.close();
 const reopened=await f.restart();await reopened.recoverQqMemory();assert.equal(f.experiences.length,1);assert.equal(f.experiences[0].eventRef,originalRef);assert.deepEqual(f.calls.filter(v=>v!=='experience.append'),['get_login_info','send_private_msg']);
});
test('QQ original account generation change requires review without model, send, lease or owner work',async t=>{
 const f=await fixture(t);f.accounts.save({...f.account,enabled:false});

 const broker=f.start();await broker.recoverQqMemory();assert.equal(f.experiences.length,0);const audit=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));assert.equal(audit.prepare('SELECT state FROM qq_memory_intents').get().state,'needs-review');audit.close();assert.deepEqual(f.calls,['get_login_info','send_private_msg']);
});
test('QQ memory retries 10, 60, 300 seconds then stops for review without a second send',async t=>{
 const f=await fixture(t,{appendFailure:true}),broker=f.start();await broker.recoverQqMemory();
 function state(){const db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));try{return db.prepare('SELECT * FROM qq_memory_intents').get();}finally{db.close();}}
 assert.equal(state().attempts,1);assert.equal(state().next_at,at+70000);await broker.recoverQqMemory();assert.equal(state().attempts,1);
 f.advance(10000);await broker.recoverQqMemory();assert.equal(state().attempts,2);assert.equal(state().next_at,at+130000);
 f.advance(60000);await broker.recoverQqMemory();assert.equal(state().attempts,3);assert.equal(state().next_at,at+430000);
 f.advance(300000);await broker.recoverQqMemory();assert.equal(state().attempts,4);assert.equal(state().state,'needs-review');
 assert.equal(f.calls.filter(v=>v==='send_private_msg').length,1);assert.equal(f.experiences.length,0);
});
test('QQ recovery preserves the frozen event time and reference through transient append failure',async t=>{
 const f=await fixture(t,{appendFailure:true}),broker=f.start();await broker.recoverQqMemory();const db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite')),before=db.prepare('SELECT event_ref FROM qq_memory_intents').get().event_ref;db.close();assert.ok(before);
 f.setAppendFailure(false);f.advance(10000);await broker.recoverQqMemory();assert.equal(f.experiences.length,1);assert.equal(f.experiences[0].eventRef,before);assert.equal(f.experiences[0].occurredAt,at);
});
test('QQ changed original model binding cannot be rebound during memory compensation',async t=>{
 const f=await fixture(t);f.setProfile({connectionRef:'new-role-model'});const broker=f.start();await broker.recoverQqMemory();assert.equal(f.experiences.length,0);const db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));assert.equal(db.prepare('SELECT state FROM qq_memory_intents').get().state,'needs-review');db.close();assert.deepEqual(f.calls,['get_login_info','send_private_msg']);
});
test('QQ memory-only manual retry requires matching APP action and original active account',async t=>{
 const f=await fixture(t,{appendFailure:true}),broker=f.start();await broker.recoverQqMemory();
 const read=action=>broker.handlers['social.context.read']({identity,payload:{purpose:'manage-plugin'},context:{authority:{kind:'app',action}}}),denied=await read('history.list');
 await assert.rejects(broker.contextProvider({identity,method:'connections.request',payload:{contextToken:denied.contextToken,operation:'qq.memory.retry',accountId:'123',requestId:'original-send-request'}}),{code:'TRUSTED_UI_PRINCIPAL_REQUIRED'});
 const principal=await read('memory.retry'),payload={contextToken:principal.contextToken,operation:'qq.memory.retry',accountId:'different-account',requestId:'original-send-request'},context=await broker.contextProvider({identity,method:'connections.request',payload});
 await assert.rejects(broker.handlers['connections.request']({identity,context,payload}),{code:'SOCIAL_ACCOUNT_CHANGED'});
 f.setAppendFailure(false);payload.accountId='123';await broker.handlers['connections.request']({identity,context,payload});assert.equal(f.experiences.length,1);assert.equal(f.calls.filter(v=>v==='send_private_msg').length,1);
});
test('QQ proof tampering cannot substitute another character or text',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite')),row=db.prepare('SELECT * FROM qq_memory_intents').get(),proof=JSON.parse(row.proof_json);proof.context.characterId='new-takeover';proof.text='forged';db.prepare('UPDATE qq_memory_intents SET proof_json=? WHERE id=?').run(JSON.stringify(proof),row.id);db.close();const broker=f.start();await broker.recoverQqMemory();assert.equal(f.experiences.length,0);const audit=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));assert.equal(audit.prepare('SELECT state FROM qq_memory_intents').get().state,'needs-review');audit.close();
});
test('QQ close aborts a pending memory append and never schedules another retry',async t=>{
 const f=await fixture(t),broker=f.start();let release;f.setAppendGate(new Promise(resolve=>release=resolve));const running=broker.recoverQqMemory();await new Promise(setImmediate);const closing=broker.close();release();await Promise.all([running,closing]);const calls=f.calls.length;await broker.recoverQqMemory();assert.equal(f.calls.length,calls);assert.equal(f.calls.filter(v=>v==='send_private_msg').length,1);
});

test('QQ failed intent insertion rolls back sends.completed in the same SQLite transaction',async t=>{
 const f=await fixture(t,{rejectIntent:true}),db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));try{const send=db.prepare('SELECT * FROM sends').get();assert.equal(f.sent.status,'unknown');assert.equal(send.state,'unknown');assert.equal(send.result,null,'the completed receipt UPDATE must be rolled back with the rejected intent');assert.equal(db.prepare('SELECT COUNT(*) AS count FROM qq_memory_intents').get().count,0);}finally{db.close();}assert.deepEqual(f.calls,['get_login_info','send_private_msg']);
});
test('QQ legacy recovery requires completed transport plus original host fact and stable existing evidence time',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));db.exec('DELETE FROM qq_memory_intents');db.close();
 const prior=createSocialHost({dataRoot:f.dataRoot,now:()=>at,resolveLife:()=>({...f.scope}),appendExperience:async event=>f.experiences.push(event)}),anchor=prior.registerContext({pluginId:identity.pluginId,scope:f.scope,restoreRef:f.context.contextRef,check:()=>true}),event=prior.recordContextEvidence({pluginId:identity.pluginId,contextRef:anchor.contextRef,nativeEvidenceId:'456',sourceKind:'qq-outbound',stage:'sent',status:'completed',text:'Original successful text',occurredAt:at,deliveryState:'sent'});
 await prior.services['experience.append'].handler({pluginId:identity.pluginId,context:{...f.scope,contextKind:'social',taskId:null,permissionScope:prior.capabilities},payload:{eventRef:event.eventRef},check:async()=>{}});prior.close();
 const fact=f.transport.observation(f.sent.observationId);delete fact.occurredAt;const journal=createSocialRuntimeJournal({dataRoot:f.dataRoot});journal.saveContext(f.context.contextToken,{...f.context,facts:[fact],evidence:[['legacy-send',event.eventRef]]});await journal.close();
 const broker=f.start();await broker.recoverQqMemory();assert.equal(f.experiences.length,1);assert.equal(f.calls.filter(value=>value==='experience.append').length,0,'already committed legacy facts must not be replayed');const audit=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));assert.equal(audit.prepare('SELECT state FROM qq_memory_intents').get().state,'committed');audit.close();
});
test('QQ orphan legacy observation without original time or host evidence is not proof',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));db.exec('DELETE FROM qq_memory_intents');db.close();const fact=f.transport.observation(f.sent.observationId);delete fact.occurredAt;const journal=createSocialRuntimeJournal({dataRoot:f.dataRoot});journal.saveContext(f.context.contextToken,{...f.context,facts:[fact]});await journal.close();const broker=f.start();await broker.recoverQqMemory();assert.equal(f.experiences.length,0);const audit=new DatabaseSync(join(f.dataRoot,'social-core','transport-v1.sqlite'));assert.equal(audit.prepare('SELECT COUNT(*) AS count FROM qq_memory_intents').get().count,0);audit.close();assert.deepEqual(f.calls,['get_login_info','send_private_msg']);
});

test('QQ normal append racing memory compensation shares original event reference and one append',async t=>{
 const f=await fixture(t),journal=createSocialRuntimeJournal({dataRoot:f.dataRoot});journal.saveContext(f.context.contextToken,{...f.context,facts:[f.transport.observation(f.sent.observationId)]});await journal.close();let release;f.setAppendGate(new Promise(resolve=>release=resolve));const broker=f.start(),recovering=broker.recoverQqMemory();await new Promise(setImmediate);
 const payload={contextToken:f.context.contextToken,deliveryState:'sent',status:'sent',providerRequestId:'original-send-request',sourceMessageId:'456',eventId:'normal-plugin-event'},context=await broker.contextProvider({identity,method:'experience.append',payload}),normal=broker.handlers['experience.append']({identity,context,payload});release();await Promise.all([recovering,normal]);assert.equal(f.experiences.length,1);assert.equal(f.calls.filter(value=>value==='experience.append').length,1);assert.equal(f.experiences[0].occurredAt,at);
});
