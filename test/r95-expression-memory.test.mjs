import test from 'node:test';
import assert from 'node:assert/strict';
import {collectMemoryEvents,createCompanionMemory} from '../src/companion-memory.mjs';
import {enableGrowth,applyGrowthCandidates} from '../src/companion-growth.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';
import {fixtureReceiptHash} from './support/social-receipt-fixture.mjs';

const at=Date.parse('2026-10-20T12:00:00Z'),day=86400000;
async function fixture(){const state=await companionFixture({now:at}),life=state.lives.claude;state.personas.other={id:'other',name:'另一个身份'};life.r95={lines:[]};const store=memoryStore(state);store.expressionReceipts=new Map();return store;}
function line(state,{id='said-1',status='presented',channel='app-private',conversationId='conversation',personaId='default',mode='awake',kind='greeting',when=at,text='刚才实际说过的台词'}={}){const life=state.lives.claude;return {messageId:id,candidateId:'candidate-'+id,scope:{characterId:'claude',lifeId:life.id,operationId:life.operationId,personaId,channel,conversationId,...(channel.startsWith('qq-')?{accountBindingId:'fixture-qq-account',actorId:'fixture-qq-member'}:{})},mode,kind,text,status,at:when,presentedAt:when+1,sourceRefs:['real-event-'+id],...(channel.startsWith('qq-')?{nativeReceipt:{status:'sent',nativeMessageId:'wire-'+id,eventRef:'outbound-'+id,sourcePluginId:'qq-fixture',sourceHash:fixtureReceiptHash({id,text}),sourceVersion:1}}:{})};}
const trustExpression=(store,row)=>store.expressionReceipts.set(row.nativeReceipt.eventRef,structuredClone(row));
const expressionResolver=store=>args=>{const original=store.expressionReceipts.get(args.eventRef);if(!original||original.messageId!==args.messageId||original.candidateId!==args.candidateId||original.text!==args.text||original.nativeReceipt.nativeMessageId!==args.nativeMessageId||original.nativeReceipt.sourceHash!==args.sourceEvidenceHash||original.nativeReceipt.sourcePluginId!==args.sourcePluginId||original.nativeReceipt.sourceVersion!==args.sourceVersion||['characterId','lifeId','personaId','channel','conversationId'].some(key=>original.scope[key]!==args[key]))return null;return {...args,...original.scope};};
const memory=(store,runModel=async()=>{throw Error('unexpected model request');})=>createCompanionMemory({store,resolveSocialExpressionIdentity:expressionResolver(store),now:()=>at+2*day,autoStart:false,getCapacity:()=>({tokens:64000,verified:true}),runModel});

test('R95 actually presented/read autonomous lines are indexed; generated drafts remain excluded',async()=>{
 const store=await fixture();await store.mutate(state=>{state.lives.claude.r95.lines=[line(state),line(state,{id:'said-2',status:'read',kind:'selftalk'}),line(state,{id:'draft',status:'awaiting-presentation'}),line(state,{id:'failed',status:'failed'})];});
 const events=collectMemoryEvents(store.state,'claude').filter(event=>event.source.type==='expression');assert.equal(events.length,2);assert.deepEqual(events.map(row=>row.sourceKind).sort(),['proactive-expression','selftalk']);assert.ok(events.every(row=>row.presented===true&&row.autonomousExpression===true));
});

test('R95 autonomous expression retrieval matches Persona, channel and exact conversation',async()=>{
 const store=await fixture();await store.mutate(state=>{state.lives.claude.r95.lines=[line(state,{text:'ONLY-THIS-APP-CONVERSATION'}),line(state,{id:'qq',channel:'qq-private',text:'QQ-PRIVATE-EXPRESSION'}),line(state,{id:'other-conversation',conversationId:'another',text:'OTHER-CONVERSATION'}),line(state,{id:'other-persona',personaId:'other',text:'OTHER-PERSONA'})];});
 trustExpression(store,store.state.lives.claude.r95.lines.find(row=>row.messageId==='qq'));const engine=memory(store);try{const own=JSON.stringify(await engine.context({characterId:'claude',personaId:'default',conversationId:'conversation',query:'刚才'}));assert.match(own,/ONLY-THIS-APP-CONVERSATION/);assert.doesNotMatch(own,/QQ-PRIVATE-EXPRESSION|OTHER-CONVERSATION|OTHER-PERSONA/);const qq=JSON.stringify(await engine.context({characterId:'claude',personaId:'default',socialContext:{channel:'qq-private',conversationId:'conversation',accountBindingId:'fixture-qq-account',actorId:'fixture-qq-member'},query:'刚才'}));assert.match(qq,/QQ-PRIVATE-EXPRESSION/);assert.doesNotMatch(qq,/ONLY-THIS-APP-CONVERSATION/);}finally{await engine.close();}
});
test('QQ expression account changes cannot self-authorize and missing native proof stays locally exportable',async()=>{
 const store=await fixture(),context={channel:'qq-private',conversationId:'conversation',accountBindingId:'fixture-qq-account',actorId:'fixture-qq-member'};let original;
 await store.mutate(state=>{original=line(state,{id:'qq-bound',channel:'qq-private',text:'QQ-RECEIPT-BOUND-EXPRESSION'});state.lives.claude.r95.lines=[original];});trustExpression(store,original);const engine=memory(store);
 try{
  assert.match(JSON.stringify(await engine.context({characterId:'claude',personaId:'default',socialContext:context,query:'刚才'})),/QQ-RECEIPT-BOUND-EXPRESSION/);
  await store.mutate(state=>{const scope=state.lives.claude.r95.lines[0].scope;scope.accountBindingId='forged-account';scope.actorId='forged-member';});const forged=await engine.context({characterId:'claude',personaId:'default',socialContext:{...context,accountBindingId:'forged-account',actorId:'forged-member'},query:'刚才'});assert.doesNotMatch(JSON.stringify(forged),/QQ-RECEIPT-BOUND-EXPRESSION/);assert.equal((await engine.view({characterId:'claude',personaId:'default'})).pendingAttributionTotal,1);
  await store.mutate(state=>{state.lives.claude.r95.lines[0]=structuredClone(original);});store.expressionReceipts.clear();const imported=await engine.context({characterId:'claude',personaId:'default',socialContext:context,query:'刚才'});assert.doesNotMatch(JSON.stringify(imported),/QQ-RECEIPT-BOUND-EXPRESSION/);const pending=await engine.view({characterId:'claude',personaId:'default'});assert.equal(pending.pendingAttribution[0].text,original.text);assert.deepEqual(store.state.lives.claude.r95.lines[0],original);
 }finally{await engine.close();}
});

test('R95 APP group expression is visible only in its group scope and stays out of private dialogue',async()=>{
 const store=await fixture();await store.mutate(state=>{state.groups.g={id:'g',personaId:'default',memberIds:['claude'],messages:[],intervals:{claude:[{start:1,end:null}]}};state.lives.claude.groupIntervals.g=[{start:1,end:null}];state.lives.claude.r95.lines=[line(state,{channel:'app-group',conversationId:'g',text:'GROUP-ONLY-EXPRESSION'})];});
 const engine=memory(store);try{assert.match(JSON.stringify(await engine.context({characterId:'claude',personaId:'default',groupId:'g'})),/GROUP-ONLY-EXPRESSION/);assert.doesNotMatch(JSON.stringify(await engine.context({characterId:'claude',personaId:'default',conversationId:'conversation'})),/GROUP-ONLY-EXPRESSION/);}finally{await engine.close();}
});

test('R95 dream utterance remains fictional and cannot become a shared-world core fact',async()=>{
 const store=await fixture();await store.mutate(state=>{state.lives.claude.r95.lines=[line(state,{mode:'dream',text:'梦见自己已经修好了全部代码'})];});let sawDream=false;
 const engine=memory(store,async(_id,request)=>{const input=JSON.parse(request.messages[0].text);sawDream=request.system.includes('dream')&&input.events.some(row=>row.sourceKind==='dream');return JSON.stringify({coverageHash:input.coverageHash,summary:{text:'角色说了一段梦话',eventIds:input.todayEventIds},guide:{text:'梦话回看',eventIds:input.todayEventIds},core:[{kind:'experience',text:'所有代码实际修复成功',perspective:'shared-fact',eventIds:input.todayEventIds,criteria:{occurred:true,enduring:true}}],branches:[],growthCandidates:[]});});
 try{const row=collectMemoryEvents(store.state,'claude').find(row=>row.source.type==='expression');assert.ok(row);assert.equal(row.fictional,true);const result=await engine.consolidate({characterId:'claude',scope:row.scope,day:'2026-10-20'});assert.equal(result.status,'failed');assert.match(result.error,/梦话|dream|现实|fiction/i);assert.equal(sawDream,true);}finally{await engine.close();}
});

test('R95 self-generated speech cannot manufacture three independent growth experiences',async()=>{
 const store=await fixture();await store.mutate(state=>{enableGrowth(state,'claude','seed',at-1000);state.lives.claude.r95.lines=[line(state,{id:'a',when:at}),line(state,{id:'b',when:at+day}),line(state,{id:'c',when:at+day})];const events=collectMemoryEvents(state,'claude').filter(event=>event.source.type==='expression');state.lives.claude.memory.events=Object.fromEntries(events.map(row=>[row.id,{...row,sourceKind:'character-statement'}]));});
 const state=store.snapshot(),events=Object.values(state.lives.claude.memory.events);assert.equal(events.length,3);const ids=events.map(row=>row.id),proposal={field:'interests',before:'',after:'开始对天文题材表现出持续兴趣',sourceEventIds:ids,counterEvidenceIds:[],scope:'general',reason:'不能从自产台词制造经历',context:'自言自语',expectedCardVersion:state.cards.claude.revision,lifeId:state.lives.claude.id,operationId:state.lives.claude.operationId,kind:'small-behavior',privacy:'general-behavior'},batch={id:'expression-batch',day:'2026-10-22',lifeId:state.lives.claude.id,operationId:state.lives.claude.operationId,scope:events[0].scope,eventIds:ids};
 assert.equal(applyGrowthCandidates(state,'claude',[proposal],batch,at+2*day).rejected[0].code,'invalid-evidence');
});
