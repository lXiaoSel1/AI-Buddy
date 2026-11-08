import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {createCompanionService} from '../src/companion-service.mjs';
import {makeCard} from '../src/companion-store.mjs';
import {ensureLives,lifeToken} from '../src/companion-life.mjs';

const copy=structuredClone;
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,{relationship}={}){
 let clock=Date.now();const now=()=>++clock;
 const initial={schema:1,migrated:true,cards:{claude:makeCard({id:'claude',name:'Synthetic role',fields:{}})},personas:{default:{id:'default',name:'Synthetic persona',nickname:'Test',relationships:{}}},relationships:{claude:{mode:'independent',byPersona:{default:{level:4,affection:35}}}},conversations:{conversation:{id:'conversation',characterId:'claude',personaId:'default',createdAt:now(),updatedAt:now(),messages:[],choices:[],draft:''}},groups:{},events:{},touchQuotas:{},draftCards:{},settings:{allowUserMessageEdit:true},activeCharacterId:'claude',activePersonaId:'default',activeConversationId:'conversation',defaultPersonaId:'default'};
 ensureLives(initial,now());let value=copy(initial),tail=Promise.resolve();const changes=[],awards=[];let engineProgress={level:4,affection:35};
 const store={get state(){return value;},snapshot:()=>copy(value),flush:()=>tail,mutate(fn){const job=tail.then(async()=>{const next=copy(value),result=await fn(next);if(JSON.stringify(value)!==JSON.stringify(next))changes.push(copy(next));value=next;return result;});tail=job.catch(()=>{});return job;}};
 const engine={async handleAction(action,args={}){
  if(action==='companion-export')return {current:'claude',characters:[{id:'claude',profile:{displayName:'Synthetic role',persona:'Quiet',tone:'Calm',address:'Test',greeting:'Hi',visual:''},history:[],choices:[],personaId:'default',...engineProgress,pendingRelationEvents:[]}]};
  if(action==='view')return {current:'claude',characterMode:'manual'};
  if(action==='companion-relationship'){awards.push(copy(args));await relationship?.(args);engineProgress={level:args.base.level,affection:args.base.affection+args.delta};return {ok:true,...engineProgress,levels:[]};}
  if(['companion-register','companion-project','companion-ack-events'].includes(action))return {ok:true};
  throw Error('Unhandled synthetic engine action '+action);
 }};
 const service=await createCompanionService({store,engine,provider:{enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),resolveContextCapacity:()=>({tokens:8192})},now});
 t.after(()=>service.close());
 await store.mutate(s=>{s.conversations.conversation.messages.push({id:'reply',requestId:'synthetic-request',role:'assistant',text:'Synthetic completed text',characterId:'claude',personaId:'default',presentation:'pending',pendingAffection:1,createdAt:now(),lifeId:s.lives.claude.id,lifeToken:lifeToken(s,'claude')});});
 changes.length=0;
 return {service,store,changes,awards,present:()=>service.action('companion-private-present',{conversationId:'conversation',id:'reply'})};
}

test('concurrent confirmations of one private reply prepare one durable settlement and award once',async t=>{
 const entered=gate(),release=gate();t.after(()=>release.resolve());
 const f=await fixture(t,{relationship:async()=>{entered.resolve();await release.promise;}});
 const requests=Array.from({length:12},()=>f.present());
 await entered.promise;await turn();await f.store.flush();
 const preparations=f.changes.filter(state=>state.pendingPrivateSettlements?.reply);
 release.resolve();await Promise.all(requests);
 assert.equal(preparations.length,1,'a waiting award must not rewrite the same pending snapshot for every confirmation');
 assert.equal(f.awards.length,1);
 assert.equal(f.store.state.events['chat:synthetic-request'].delta,1);
 assert.equal(f.store.state.pendingPrivateSettlements.reply,undefined);
 assert.equal(f.store.state.relationships.claude.byPersona.default.affection,36);
});

test('explicit retry after failed settlement uses the original event, timestamp, amount and life identity',async t=>{
 let fail=true;const f=await fixture(t,{relationship:async()=>{if(fail)throw Error('Synthetic settlement unavailable');}});
 await assert.rejects(f.present(),/settlement unavailable/);
 const pending=copy(f.store.state.pendingPrivateSettlements.reply);
 assert.equal(f.store.state.events[pending.eventId],undefined);
 assert.equal(f.service.viewState().messages.at(-1).presentationSettlementPending,true);
 assert.equal(f.store.state.conversations.conversation.messages.at(-1).presentationSettlementPending,undefined,'retry eligibility is a read-only view projection');
 await f.store.mutate(state=>{state.conversations.conversation.messages.at(-1).pendingAffection=99;});
 fail=false;await f.present();
 for(const award of f.awards){assert.equal(award.eventId,pending.eventId);assert.equal(award.at,pending.at);assert.equal(award.delta,pending.amount);}
 assert.deepEqual(f.store.state.events[pending.eventId],{characterId:pending.characterId,personaId:pending.personaId,lifeId:pending.lifeToken.lifeId,delta:1,level:4,affection:36,levels:[],at:pending.at});
 assert.equal(f.store.state.pendingPrivateSettlements.reply,undefined);
 await f.store.mutate(state=>{state.pendingPrivateSettlements.reply=copy(pending);});await f.present();assert.equal(f.awards.length,2,'an already committed event must not award again');assert.equal(f.store.state.pendingPrivateSettlements.reply,undefined,'a retry also finishes cleanup after the event was already committed');
});

test('a scope switch while the store is queued prevents stale confirmation from marking the old reply',async t=>{
 const f=await fixture(t),release=gate();
 const switched=f.store.mutate(async state=>{await release.promise;state.conversations.other={...copy(state.conversations.conversation),id:'other',messages:[]};state.activeConversationId='other';});
 const pending=f.present();release.resolve();await switched;await assert.rejects(pending,/失效/);
 assert.equal(f.store.state.conversations.conversation.messages.at(-1).presentation,'pending');assert.equal(f.awards.length,0);assert.equal(f.store.state.events['chat:synthetic-request'],undefined);
});

test('an award returning after a life operation changes cannot commit into the new life',async t=>{
 const entered=gate(),release=gate();t.after(()=>release.resolve());const f=await fixture(t,{relationship:async()=>{entered.resolve();await release.promise;}});
 const pending=f.present();await entered.promise;const original=copy(f.store.state.pendingPrivateSettlements.reply);
 await f.store.mutate(state=>{state.lives.claude.id='next-life';state.lives.claude.operationId='next-operation';state.conversations.conversation.lifeId='next-life';state.conversations.conversation.messages=[];});
 release.resolve();await assert.rejects(pending,/旧人生/);
 assert.equal(f.store.state.events['chat:synthetic-request'],undefined);assert.equal(f.store.state.relationships.claude.byPersona.default.affection,35);assert.deepEqual(f.store.state.pendingPrivateSettlements.reply,original);assert.deepEqual(f.store.state.conversations.conversation.messages,[]);
});
