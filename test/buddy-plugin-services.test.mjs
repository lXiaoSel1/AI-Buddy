import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanionStore,makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {createBuddyPluginServices,BUDDY_PLUGIN_CAPABILITIES} from '../src/buddy-plugin-services/index.mjs';
import {createPluginUsageRecorder} from '../src/plugin-usage-recorder.mjs';

const executionRoot=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??resolve(import.meta.dirname,'../local/test-fixtures')),pluginId='test.native';
async function fixture(t,options={}){
  const base=join(executionRoot,'test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'buddy-bridge-'));
  const store=await openCompanionStore(root);
  await store.mutate(state=>{
    state.cards={a:makeCard({id:'a',name:'Alpha',personality:'alpha persona'}),b:makeCard({id:'b',name:'Beta',personality:'beta persona'})};
    state.personas={p:{id:'p',name:'P',relationships:{}},q:{id:'q',name:'Q',relationships:{}}};state.activeCharacterId='a';state.activePersonaId='p';state.migrated=true;state.conversations={};state.groups={};state.relationships={};state.accountLedger={tokens:1234};ensureLives(state,Date.now());
  });
  const game=await createCompanionService({store,engine:{handleAction:async action=>action==='companion-export'?{characters:[]}:{ok:true}},provider:{enabled:false},automaticWorkAllowed:()=>false});
  let clock=1000;const events=[],usages=[],notifications=[],pages=[],disposed=[];
  const service=createBuddyPluginServices({getGame:()=>game,now:()=>clock,
    resolveContext:async spec=>({...spec,...game.workScope(spec.characterId,spec.personaId),contextRevision:store.state.cards[spec.characterId].revision}),
    onEvidence:async value=>events.push(value),onUsage:async value=>usages.push(value),onNotification:async value=>notifications.push(value),
    registerPage:async value=>{pages.push(value);return ()=>disposed.push(value.descriptor.id);},registerLifecycle:async value=>()=>disposed.push(value.descriptor.id),...options});
  service.grants.set({pluginId,declared:[...BUDDY_PLUGIN_CAPABILITIES],granted:[...BUDDY_PLUGIN_CAPABILITIES]});
  const issue=(extra={})=>service.issueContext({pluginId,characterId:'a',personaId:'p',sessionId:'native-session',taskId:'task-native',workspace:{id:'project-one',path:root},permissionScope:[...BUDDY_PLUGIN_CAPABILITIES],connectionRefs:[],...extra});
  const call=(token,method,payload={},extra={})=>service.invoke({pluginId,contextToken:token.contextToken,method,payload},extra);
  t.after(async()=>{await service.close();await game.close();await store.flush();});
  return {root,store,game,service,events,usages,notifications,pages,disposed,issue,call,setClock:value=>{clock=value;}};
}

test('real companion context selects only the host-issued character and refuses forged character, Persona, life and workspace',async t=>{
  const f=await fixture(t),token=await f.issue();
  const value=await f.call(token,'character.context',{query:'read my character'});assert.equal(value.character.id,'a');assert.equal(value.persona.id,'p');assert.equal(value.character.name,'Alpha');
  for(const payload of [{characterId:'b'},{personaId:'q'},{lifeId:'other-life'},{scope:{characterId:'b'}},{workspaceId:'project-two'},{sessionId:'other-session'}])await assert.rejects(f.call(token,'character.context',payload),{code:'BUDDY_CONTEXT_DENIED'});
  await assert.rejects(f.service.invoke({pluginId:'other.plugin',contextToken:token.contextToken,method:'character.context',payload:{}}),{code:'BUDDY_CONTEXT_DENIED'});
});

test('visible character and Persona changes do not reattribute a fixed session; its own life change invalidates it',async t=>{
  const f=await fixture(t),a=await f.issue(),b=await f.issue({characterId:'b',personaId:'q',sessionId:'b-session',taskId:'task-b'});
  await f.store.mutate(state=>{state.activeCharacterId='b';state.activePersonaId='q';});
  assert.equal((await f.call(a,'character.context')).character.id,'a');assert.equal((await f.call(b,'character.context')).character.id,'b');
  await f.store.mutate(state=>{state.lives.a.id='new-life';state.lives.a.operationId='new-operation';});
  await assert.rejects(f.call(a,'character.context'),{code:'BUDDY_CONTEXT_STALE'});assert.equal((await f.call(b,'character.context')).character.id,'b');
});

test('effective capabilities are declaration, explicit grant and per-session scope intersection; expiration is enforced',async t=>{
  const f=await fixture(t),token=await f.issue({ttlMs:20,permissionScope:['characters.getContext']});
  await assert.rejects(f.call(token,'notifications.publish',{title:'x',text:'x'}),{code:'BUDDY_CAPABILITY_DENIED'});
  f.service.grants.set({pluginId,declared:['characters.getContext'],granted:[]});await assert.rejects(f.call(token,'character.context'),{code:'BUDDY_CAPABILITY_DENIED'});
  f.service.grants.set({pluginId,declared:[],granted:['characters.getContext']});await assert.rejects(f.call(token,'character.context'),{code:'BUDDY_CAPABILITY_DENIED'});
  f.service.grants.set({pluginId,declared:['characters.getContext'],granted:['characters.getContext'],expiresAt:1010});f.setClock(1010);await assert.rejects(f.call(token,'character.context'),{code:'BUDDY_GRANT_EXPIRED'});
  f.setClock(1020);await assert.rejects(f.call(token,'character.context'),{code:'BUDDY_CONTEXT_EXPIRED'});
});

test('host-native evidence and actual presentation gate existing companion memory, deduplicated without touching wallet or other life',async t=>{
  const f=await fixture(t),a=await f.issue(),b=await f.issue({characterId:'b',sessionId:'b-session',taskId:'task-b'}),before=f.store.snapshot(),scope=a.context;
  await f.service.registerEventEvidence({pluginId,contextToken:a.contextToken,evidence:{id:'observed',status:'completed',presented:false,text:'not shown',at:2000}});
  assert.equal((await f.call(a,'memory.appendEvent',{evidenceId:'observed',presented:true})).recorded,false);assert.equal(f.events.length,1);
  assert.equal(f.store.state.lives.a.workExperiences?.length??0,0);
  await f.service.registerEventEvidence({pluginId,contextToken:a.contextToken,evidence:{id:'shown',status:'completed',presented:true,text:'real shown project result',at:2001}});
  const refreshed=await f.issue();await f.service.registerEventEvidence({pluginId,contextToken:refreshed.contextToken,evidence:{id:'shown',status:'completed',presented:true,text:'real shown project result',at:2001}});
  await assert.rejects(f.call(b,'memory.appendEvent',{evidenceId:'shown'}),{code:'BUDDY_CONTEXT_DENIED'});
  const [one,two]=await Promise.all([f.call(a,'memory.appendEvent',{evidenceId:'shown'}),f.call(a,'memory.appendEvent',{evidenceId:'shown'})]);assert.deepEqual(one,two);
  const rows=f.store.state.lives.a.workExperiences;assert.equal(rows.length,1);assert.equal(rows[0].lifeId,scope.lifeId);assert.equal(rows[0].taskId,'task-native');assert.match(rows[0].sourceHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.store.state.lives.b,before.lives.b);assert.deepEqual(f.store.state.accountLedger,before.accountLedger);assert.deepEqual(f.store.state.conversations,before.conversations);
  await assert.rejects(f.service.registerEventEvidence({pluginId,contextToken:a.contextToken,evidence:{id:'shown',status:'completed',presented:true,text:'rewritten'}}),{code:'BUDDY_EVIDENCE_CONFLICT'});
  await f.store.flush();const reopened=await openCompanionStore(f.root);assert.equal(reopened.state.lives.a.workExperiences[0].text,'real shown project result');
});

test('plugin cannot invent usage; native request accounting distinguishes parent totals and child details',async t=>{
  const f=await fixture(t),token=await f.issue();await assert.rejects(f.call(token,'usage.record',{evidenceId:'invented',usage:{totalTokens:100}}),{code:'BUDDY_EVIDENCE_MISSING'});
  await f.service.registerUsageEvidence({pluginId,contextToken:token.contextToken,evidence:{id:'usage-parent',nativeRequestId:'native-parent',accounting:'parent-total',usage:{inputTokens:10,outputTokens:5,totalTokens:15}}});
  await Promise.all([f.call(token,'usage.record',{evidenceId:'usage-parent'}),f.call(token,'usage.record',{evidenceId:'usage-parent'})]);
  await f.service.registerUsageEvidence({pluginId,contextToken:token.contextToken,evidence:{id:'usage-parent-replayed',nativeRequestId:'native-parent',accounting:'parent-total',usage:{inputTokens:10,outputTokens:5,totalTokens:15}}});await f.call(token,'usage.record',{evidenceId:'usage-parent-replayed'});
  await f.service.registerUsageEvidence({pluginId,contextToken:token.contextToken,evidence:{id:'usage-child',nativeRequestId:'native-child',parentNativeRequestId:'native-parent',accounting:'child-detail',usage:{totalTokens:5}}});await f.call(token,'usage.record',{evidenceId:'usage-child'});
  assert.equal(f.usages.length,2);assert.equal(f.usages.filter(r=>r.billable).length,1);assert.equal(f.usages[1].billable,false);assert.equal(f.usages[0].idempotencyKey,'test.native:native-session:native-parent');
  await f.service.registerUsageEvidence({pluginId,contextToken:token.contextToken,evidence:{id:'usage-parent-changed',nativeRequestId:'native-parent',accounting:'parent-total',usage:{totalTokens:999}}});await assert.rejects(f.call(token,'usage.record',{evidenceId:'usage-parent-changed'}),{code:'BUDDY_EVIDENCE_CONFLICT'});
});

test('native tool authorization does not require character-context capability or perform character reads',async t=>{
  let reads=0;const f=await fixture(t,{getCharacterContext:()=>{reads++;throw Error('not allowed');}}),token=await f.issue({permissionScope:['tools.list','tools.invoke']});
  f.service.grants.set({pluginId,declared:['tools.list','tools.invoke'],granted:['tools.list','tools.invoke']});
  const authorized=await f.service.authorize({pluginId,contextToken:token.contextToken,capability:'tools.list'});assert.equal(authorized.context.characterId,'a');assert.equal(reads,0);
  f.service.grants.revoke(pluginId);await assert.rejects(f.service.checkAuthorization({pluginId,contextToken:token.contextToken,capability:'tools.invoke',generation:authorized.generation}),{code:'BUDDY_PLUGIN_DISABLED'});
});

test('host planning state, read-only tools and approval revision survive authorization and cannot drift or be forged',async t=>{
 let hostState={planState:'planning',readOnlyToolNames:['read_file'],approvedPlanRevision:null};
 const f=await fixture(t,{resolveContext:async spec=>({...spec,...f.game.workScope(spec.characterId,spec.personaId),contextRevision:f.store.state.cards[spec.characterId].revision,...hostState})}),token=await f.issue();
 const auth=await f.service.authorize({pluginId,contextToken:token.contextToken,capability:'tools.invoke'});assert.equal(auth.context.planState,'planning');assert.deepEqual(auth.context.readOnlyToolNames,['read_file']);assert.equal(auth.context.approvedPlanRevision,null);
 for(const payload of [{planState:'execution'},{readOnlyToolNames:['write_file']},{approvedPlanRevision:'invented'},{scope:{planState:'execution'}}])await assert.rejects(f.service.authorize({pluginId,contextToken:token.contextToken,capability:'tools.invoke',payload}),{code:'BUDDY_CONTEXT_DENIED'});
 hostState={planState:'execution',readOnlyToolNames:['read_file'],approvedPlanRevision:'approved-r1'};await assert.rejects(f.service.authorize({pluginId,contextToken:token.contextToken,capability:'tools.invoke'}),{code:'BUDDY_CONTEXT_STALE'});
 const approved=await f.issue();assert.equal((await f.service.authorize({pluginId,contextToken:approved.contextToken,capability:'tools.invoke'})).context.approvedPlanRevision,'approved-r1');
 hostState.readOnlyToolNames.push('another_tool');await assert.rejects(f.service.authorize({pluginId,contextToken:approved.contextToken,capability:'tools.invoke'}),{code:'BUDDY_CONTEXT_STALE'});
 const fallback=await fixture(t),defaultToken=await fallback.issue();assert.equal(defaultToken.context.planState,'planning');assert.deepEqual(defaultToken.context.readOnlyToolNames,[]);
});

test('usage metadata comes from host native evidence and trusted workspace, never plugin payload',async t=>{
 const f=await fixture(t),token=await f.issue();await f.service.registerUsageEvidence({pluginId,contextToken:token.contextToken,evidence:{id:'native-cumulative',nativeRequestId:'step-real',engine:'dsh',nativeSessionId:'native-real-session',nativeProfileId:'native-profile',model:'actual-model',provider:'actual-provider',usageMode:'cumulative',origin:'native-log',accounting:'parent-total',usage:{totalTokens:5},cumulative:{totalTokens:20},connectionIdentity:{profileId:'connection-real'},at:'2026-10-24T12:00:00Z',secret:'must-not-forward'}});
 await f.call(token,'usage.record',{evidenceId:'native-cumulative',engine:'fake',nativeSessionId:'forged',usageMode:'delta',usage:{totalTokens:900},origin:'managed-receipt',model:'fake-model'});
 assert.equal(f.usages.length,1);const row=f.usages[0];assert.equal(row.engine,'dsh');assert.equal(row.nativeSessionId,'native-real-session');assert.equal(row.usageMode,'cumulative');assert.equal(row.origin,'native-log');assert.deepEqual(row.cumulative,{totalTokens:20});assert.equal(row.model,'actual-model');assert.equal(row.provider,'actual-provider');assert.equal(row.workspace,f.root);assert.equal(row.workspaceId,'project-one');assert.equal(row.timestamp,'2026-10-24T12:00:00Z');assert.equal(row.secret,undefined);
});

test('host-only evidence flows through bridge into durable receipt storage without promoting an unknown mode',async t=>{
 let recorder;const f=await fixture(t,{onUsage:value=>recorder.record(value)}),token=await f.issue();recorder=createPluginUsageRecorder({dataRoot:f.root});t.after(()=>recorder.close());
 const base={nativeRequestId:'bridge-request',engine:'dsh',nativeSessionId:'native-authority',usageMode:'delta',origin:'managed-receipt',accounting:'parent-total',usage:{totalTokens:8}};
 await f.service.registerUsageEvidence({pluginId,contextToken:token.contextToken,evidence:{id:'bridge-receipt',...base}});assert.equal((await f.call(token,'usage.record',{evidenceId:'bridge-receipt'})).billable,true);
 await f.service.registerUsageEvidence({pluginId,contextToken:token.contextToken,evidence:{id:'bridge-unknown',...base,nativeRequestId:'unknown-mode',usageMode:null}});assert.equal((await f.call(token,'usage.record',{evidenceId:'bridge-unknown',usageMode:'cumulative'})).billable,false);
 const rows=(await readFile(join(f.root,'plugin-usage.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,2);assert.equal(rows[0].idempotencyKey,'test.native:native-session:bridge-request');assert.equal(rows[0].monitorDisposition,'count');assert.equal(rows[1].monitorDisposition,'unknown');assert.equal(rows[1].usage.totalTokens,8);assert.equal(rows[1].accountedCounters,null);
});

test('page/lifecycle registration is namespaced and revoked on disable; UI notification retains trusted scope',async t=>{
  const f=await fixture(t),token=await f.issue();await f.call(token,'pages.register',{id:pluginId+'.page',title:'native page'});await f.call(token,'lifecycle.register',{id:pluginId+'.lifecycle'});
  await assert.rejects(f.call(token,'pages.register',{id:'other.page'}),{code:'BUDDY_NAMESPACE_DENIED'});
  await assert.rejects(f.call(token,'pages.register',{id:pluginId+'.page'}),{code:'BUDDY_REGISTRATION_DUPLICATE'});
  await f.call(token,'notifications.publish',{title:'Done',text:'Real task result'});assert.equal(f.notifications[0].scope.characterId,'a');
  await f.service.revokePlugin(pluginId);assert.deepEqual(f.disposed.sort(),[pluginId+'.lifecycle',pluginId+'.page']);await assert.rejects(f.call(token,'character.context'),{code:'BUDDY_CONTEXT_DENIED'});
});

test('revocation during async character read rejects the result and never returns stale data',async t=>{
  let release,entered;const started=new Promise(r=>{entered=r;}),pending=new Promise(r=>{release=r;}),f=await fixture(t,{getCharacterContext:async()=>{entered();await pending;return {private:'should not escape'};}}),token=await f.issue();
  const call=f.call(token,'character.context');await started;assert.equal(f.service.busy(pluginId),true);const rejected=assert.rejects(call,{code:'BUDDY_CONTEXT_DENIED'}),stopping=f.service.revokePlugin(pluginId);release();await stopping;await rejected;assert.equal(f.service.busy(pluginId),false);
});
