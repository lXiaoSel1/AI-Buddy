import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createAutoService} from '../src/companion-auto.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {makeCard,openCompanionStore} from '../src/companion-store.mjs';

const characterId='r17-auto-fixture',personaId='default',groupId='r17-auto-group',sessionId='existing-auto',at=1730000000000;
const anotherGroup='concurrent-auto-start';
const oldRequest=i=>'old-request-'+i,oldAuth=i=>'old-authorization-'+i;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ai-buddy-r17-auto-evidence-')),dir=join(root,'galgame'),stores=[];
 t.after(async()=>{
  for(const store of stores.reverse())await store.close();
  await rm(root,{recursive:true,force:true});
 });
 const state={
  schema:1,activeCharacterId:characterId,activePersonaId:personaId,
  cards:{[characterId]:makeCard({id:characterId,name:'Synthetic character'})},
  personas:{[personaId]:{id:personaId,name:'Synthetic persona'}},
  relationships:{},conversations:{},groups:{},r95:{settings:{auto:true}}
 };
 ensureLives(state,at);
 const life=state.lives[characterId],scope={
  characterId,personaId,conversationId:groupId,channel:'app-group',lifeId:life.id,operationId:life.operationId
 };
 const completed=Object.fromEntries(Array.from({length:199},(_,i)=>[oldRequest(i),{
  requestId:oldRequest(i),characterId,status:'silent',evidenceId:'recorded-'+i,roundIndex:i,opportunityIndex:0,at
 }]));
 state.groups[groupId]={
  id:groupId,personaId,memberIds:[characterId],
  autoAuthorizations:Object.fromEntries(Array.from({length:200},(_,i)=>[oldAuth(i),{id:'past-session-'+i,at}])),
  auto:{
   id:sessionId,scope,mode:'until-stopped',authorizationId:oldAuth(199),members:[characterId],groupMemberSnapshot:[characterId],
   status:'active',generation:1,roundIndex:199,opportunityIndex:0,completed,pending:null
  }
 };
 state.groups[anotherGroup]={id:anotherGroup,personaId,memberIds:[characterId]};
 await mkdir(dir);
 await writeFile(join(dir,'companion.json'),JSON.stringify(state));
 async function open(){
  const store=await openCompanionStore(root);
  stores.push(store);
  return {store,auto:createAutoService({store,now:()=>at,dispatchTurn:async()=>{}})};
 }
 const {store,auto}=await open();
 return {store,auto,open,scope,path:join(dir,'auto-evidence.sqlite')};
}
async function finishTurn(auto,evidenceId){
 const turn=await auto.next({groupId});
 const result=await auto.commitOpportunity({groupId,requestId:turn.requestId,status:'silent',evidenceId});
 assert.equal(result.committed,true);
 return turn.requestId;
}
const replay=(auto,requestId)=>auto.commitOpportunity({groupId,requestId,status:'silent',evidenceId:'duplicate-must-not-change-evidence'});

test('Auto past 200 receipts can check archived authorizations and start during a separate archive write',async t=>{
 const {store,auto,open,scope,path}=await fixture(t);
 const receipts=[];
 for(let i=0;i<30;i++)receipts.push(await finishTurn(auto,'new-evidence-'+i));
 const active=auto.view({groupId}).auto;
 assert.equal(active.roundIndex,229);assert.equal(Object.keys(active.completed).length,200);
 assert.ok(active.completed[receipts.at(-1)]);
 assert.equal(store.archive.get('auto-completed:'+sessionId,oldRequest(0)).evidenceId,'recorded-0');
 assert.equal(active.completed[oldRequest(0)],undefined);
 assert.equal((await replay(auto,oldRequest(0))).duplicate,true);
 await auto.stop({groupId});
 const second=await auto.start({groupId,scope,authorizationId:'archived-auth-fixture-new'});
 assert.equal(second.status,'active');
 await auto.stop({groupId});
 assert.equal(await store.archivedAutoAuthorization(groupId,oldAuth(0)),true);
 const writer=new DatabaseSync(path,{timeout:0});
 try{
  writer.exec('BEGIN EXCLUSIVE');
  // An independent writer is still in its transaction while the authorized
  // lookup sees the previously committed receipt.
  assert.equal(await store.archivedAutoAuthorization(groupId,oldAuth(0)),true);
  assert.equal(await store.archivedAutoAuthorization(groupId,'not-used'),false);
  await assert.rejects(auto.start({groupId,scope,authorizationId:oldAuth(0)}),{code:'AUTO_AUTHORIZATION_REUSED'});
  const concurrent=await auto.start({groupId:anotherGroup,scope:{...scope,conversationId:anotherGroup},authorizationId:'concurrent-new'});
  assert.equal(concurrent.status,'active');
 }finally{writer.close();}
 const third=await auto.start({groupId,scope,authorizationId:'archive-write-finished'});
 assert.equal(third.status,'active');
 await store.close();
 const reopened=await open();
 assert.equal(await reopened.store.archivedAutoAuthorization(groupId,oldAuth(0)),true);
 await assert.rejects(reopened.auto.start({groupId,scope,authorizationId:oldAuth(0)}),{code:'AUTO_AUTHORIZATION_REUSED'});
});

test('a failed archive write keeps the current receipt and authorization until a safe retry',async t=>{
 const {store,auto,open,scope,path}=await fixture(t);
 await finishTurn(auto,'fills-existing-window');
 await finishTurn(auto,'creates-archive');
 const turn=await auto.next({groupId}),revision=store.state.revision;
 const writer=new DatabaseSync(path,{timeout:0});
 const receipt={groupId,requestId:turn.requestId,status:'silent',evidenceId:'retry-after-lock'};
 try{
  writer.exec('BEGIN IMMEDIATE');
  await assert.rejects(auto.commitOpportunity(receipt),/database is locked/i);
  assert.equal(store.state.revision,revision);
  assert.ok(auto.view({groupId}).auto.completed[oldRequest(1)]);
  assert.equal(auto.view({groupId}).auto.pending.requestId,turn.requestId);
  assert.equal(store.archive.get('auto-completed:'+sessionId,oldRequest(1)),null);
 }finally{writer.close();}
 assert.equal((await auto.commitOpportunity(receipt)).committed,true);
 assert.equal(store.archive.get('auto-completed:'+sessionId,oldRequest(1)).evidenceId,'recorded-1');
 await auto.stop({groupId});
 const blockedAuthority=new DatabaseSync(path,{timeout:0}),beforeAuth=store.archive.authorizationRevision,stoppedRevision=store.state.revision;
 const args={groupId,scope,authorizationId:'retry-authorization'};
 try{
  blockedAuthority.exec('BEGIN IMMEDIATE');
  await assert.rejects(auto.start(args),/database is locked/i);
  assert.equal(store.archive.authorizationRevision,beforeAuth);
  assert.equal(store.state.revision,stoppedRevision);
  assert.equal(await store.archivedAutoAuthorization(groupId,oldAuth(0)),false);
 }finally{blockedAuthority.close();}
 assert.equal((await auto.start(args)).status,'active');
 assert.equal(store.archive.authorizationRevision,beforeAuth+1);
 await store.close();
 const reopened=await open();
 assert.equal(await reopened.store.archivedAutoAuthorization(groupId,oldAuth(0)),true);
 assert.equal(reopened.store.archive.get('auto-completed:'+sessionId,oldRequest(1)).evidenceId,'recorded-1');
});
