import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoService} from '../src/companion-auto.mjs';
import {createEvidenceArchive} from '../src/evidence-archive.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scope={characterId:'a',lifeId:'la',operationId:'oa',personaId:'p',channel:'app',conversationId:'g'};
async function rig(t){
 const root=await mkdtemp(join(tmpdir(),'audit-auto-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let state={r95:{settings:{auto:true}},personas:{p:{}},lives:{a:{id:'la',operationId:'oa'},b:{id:'lb',operationId:'ob'}},groups:{g:{id:'g',personaId:'p',memberIds:['a','b']}}};
 const archive=createEvidenceArchive(join(root,'archive.sqlite')),calls=[],store={archive,get state(){return state;},async mutate(fn){const next=structuredClone(state),result=await fn(next);state=next;return result;}};
 const auto=createAutoService({store,dispatchTurn:async v=>calls.push(v)});return {auto,store,archive,calls};
}
test('restart unknown needs explicit skip, keeps unknown evidence, then advances once without resending',async t=>{
 const f=await rig(t);await f.auto.start({groupId:'g',scope,authorizationId:'one',mode:'until-stopped'});const first=await f.auto.next({groupId:'g'});await f.auto.recover();
 await assert.rejects(f.auto.continue({groupId:'g'}),{code:'AUTO_RECONCILE_REQUIRED'});
 await assert.rejects(f.auto.continue({groupId:'g',resumeFromNext:true,requestId:'wrong'}),{code:'AUTO_REQUEST_STALE'});
 await f.auto.continue({groupId:'g',resumeFromNext:true,requestId:first.requestId});
 const retired=f.auto.view({groupId:'g'}).auto.retiredRequests[first.requestId];assert.equal(retired.status,'unknown');
 const next=await f.auto.next({groupId:'g'});assert.equal(next.characterId,'b');assert.equal(f.calls.length,2);
 assert.notEqual(next.requestId,first.requestId);assert.equal((await f.auto.commitOpportunity({groupId:'g',requestId:first.requestId,status:'silent',evidenceId:'late'})).retired,true);
});
test('bounded Auto state retains durable deduplication through service recreation',async t=>{
 const f=await rig(t);await f.auto.start({groupId:'g',scope,authorizationId:'session',mode:'until-stopped'});let first;
 for(let i=0;i<215;i++){const turn=await f.auto.next({groupId:'g'});first??=turn;await f.auto.commitOpportunity({groupId:'g',requestId:turn.requestId,status:'silent',evidenceId:'e'+i});}
 assert.equal(Object.keys(f.store.state.groups.g.auto.completed).length,200);
 assert.equal((await f.auto.commitOpportunity({groupId:'g',requestId:first.requestId,status:'silent',evidenceId:'e0'})).duplicate,true);
 await f.auto.stop({groupId:'g'});
 for(let i=0;i<205;i++){await f.auto.start({groupId:'g',scope,authorizationId:'s'+i});await f.auto.stop({groupId:'g'});}
 assert.equal(f.store.state.groups.g.autoHistory.length,20);assert.equal(Object.keys(f.store.state.groups.g.autoAuthorizations).length,200);
 const restored=createAutoService({store:f.store});await assert.rejects(restored.start({groupId:'g',scope,authorizationId:'session'}),{code:'AUTO_AUTHORIZATION_REUSED'});
});
