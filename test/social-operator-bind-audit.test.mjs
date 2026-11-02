import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';

const deferred=()=>{let release;return {promise:new Promise(r=>{release=r;}),release:()=>release()};};
async function fixture(t){
 const parent=resolve(process.env.AI_BUDDY_TEST_ROOT??join(tmpdir(),'buddy-social-bind'));await mkdir(join(parent),{recursive:true});const dataRoot=await mkdtemp(join(parent,'bind-'));await mkdir(join(dataRoot,'social-core'));
 const state={account:{ref:'qq',pluginId:'@ai-buddy/qq-connect',accountId:'123',enabled:true,generation:1},life:'life',ensureGate:null,issueGate:null,entered:null,issued:0};
 const identity={pluginId:'source-qq',packageName:'@ai-buddy/qq-connect'},accounts={get:()=>state.account,forPlugin:()=>state.account,list:()=>[state.account]};
 const core={socialProfile:characterId=>({characterId,personaId:'persona',lifeId:state.life,operationId:'op',connectionRef:'model'}),socialHost:{registerContext:()=>({contextRef:'context-'+(++state.issued),revoke(){}})},registerSocialDelivery:()=>({revoke(){}})};
 const bridge={issueContext:async()=>{const gate=state.issueGate;if(gate){state.entered.release();await gate.promise;}return {contextToken:'issued-'+state.issued};},invoke:async()=>assert.fail('No model/work/network call is permitted')};
 const broker=createSocialPluginBroker({dataRoot,accounts,transport:{},bridge,getR95:()=>core,getProvider:()=>({state:{profiles:[]}}),onSetup:async()=>{const gate=state.ensureGate;if(gate){state.entered.release();await gate.promise;}}});
 t.after(async()=>{state.ensureGate?.release();state.issueGate?.release();await broker.close();assert.ok(resolve(dataRoot).startsWith(parent+sep));await rm(dataRoot,{recursive:true,force:true});});
 const bind=(characterId,signal)=>broker.handlers['social.context.read']({identity,payload:{purpose:'qq-operator-bind',characterId},context:{authority:{kind:'app'}},signal,check:async()=>signal?.throwIfAborted()});
 await bind('whale');return {state,bind,operator:()=>broker.contextProvider({identity,method:'connections.open',payload:{}})};
}

test('AUDIT host cancelled delayed QQ ensure cannot overwrite the newer operator',async t=>{
 const f=await fixture(t),gate=deferred(),controller=new AbortController();f.state.ensureGate=gate;f.state.entered=deferred();
 const pending=f.bind('claude',controller.signal).then(value=>({value}),error=>({error}));await f.state.entered.promise;
 controller.abort();f.state.ensureGate=null;await f.bind('whale');gate.release();const result=await pending;
 assert.ok(result.error,'Cancelled host binding must not publish');assert.equal((await f.operator()).characterId,'whale');
});

for(const change of ['life','account-generation'])test('AUDIT host rechecks '+change+' after async context issuance',async t=>{
 const f=await fixture(t),gate=deferred();f.state.issueGate=gate;f.state.entered=deferred();const pending=f.bind('claude').then(value=>({value}),error=>({error}));await f.state.entered.promise;
 if(change==='life')f.state.life='new-life';else f.state.account={...f.state.account,generation:2};gate.release();const result=await pending;
 assert.ok(result.error,'A stale issued context must not become the current operator');
});
