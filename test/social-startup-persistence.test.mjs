import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {createQqLoginRuntime} from '../src/qq-login-runtime.mjs';

async function fixture(t){
 const base=resolve(process.env.AI_BUDDY_TEST_ROOT??tmpdir());await mkdir(base,{recursive:true});const dataRoot=await mkdtemp(join(base,'resume-proof-'));await mkdir(join(dataRoot,'social-core'));
 const account={ref:'qq',pluginId:'@ai-buddy/qq-connect',accountId:'123',platform:'qq',enabled:true,generation:1},accounts={get:()=>account,forPlugin:()=>account,list:()=>[account]};
 const runtime=createQqLoginRuntime({dataRoot,build:dataRoot,accounts,component:{info:()=>({}),ensure:()=>assert.fail('No component start')}});
 const scope={characterId:'whale',lifeId:'life',operationId:'op'};
 const saved=()=>{const db=new DatabaseSync(join(dataRoot,'social-login/onboarding-v1.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT body FROM bindings WHERE ref=?').get('qq')?.body??'null');}finally{db.close();}};
 const closers=[()=>runtime.close()];t.after(async()=>{for(const close of closers.reverse())await close();await rm(dataRoot,{recursive:true,force:true});});
 return {accounts,account,runtime,scope,saved,dataRoot,closers};
}
test('the real QQ binding writer rejects an earlier suspended enable after a newer disable',async t=>{
 const f=await fixture(t);await f.runtime.setAutoResume('qq',false,f.scope);let release,entered,first=true;const waiting=new Promise(resolve=>entered=resolve);
 const enabled=f.runtime.setAutoResume('qq',true,f.scope,{check:async()=>{if(first){first=false;entered();await new Promise(resolve=>release=resolve);}}});const cancelled=assert.rejects(enabled,{code:'SOCIAL_ACCOUNT_CHANGED'});
 await waiting;await f.runtime.setAutoResume('qq',false,f.scope);release();await cancelled;assert.equal(f.saved().autoResume,false);
});
test('broker cancellation reaches the real QQ binding writer before a late complete can persist',async t=>{
 const f=await fixture(t);let release,entered;const waiting=new Promise(resolve=>entered=resolve),identity={pluginId:'source-qq',packageName:'@ai-buddy/qq-connect'};
 const core={socialProfile:()=>({...f.scope,personaId:'persona',connectionRef:'model'}),socialHost:{registerContext:()=>({contextRef:'ctx',revoke(){}})},registerSocialDelivery:()=>({revoke(){}}),socialCatalog:()=>[{id:'whale',label:'Whale'}]};
 const broker=createSocialPluginBroker({dataRoot:f.dataRoot,accounts:f.accounts,transport:{},bridge:{issueContext:async()=>({contextToken:'host-context'})},getR95:()=>core,getProvider:()=>({state:{profiles:[]}}),onSetup:async({action,payload,signal,check})=>{if(action!=='complete')return{};if(payload.autoResume){entered();await new Promise(resolve=>release=resolve);}await f.runtime.setAutoResume('qq',payload.autoResume,payload.scope,{signal,check});return{saved:true};}});
 f.closers.push(()=>broker.close());
 const read=(payload,signal)=>broker.handlers['social.context.read']({identity,payload,context:{authority:{kind:'app',action:payload.purpose==='qq-operator-bind'?'operator.select':'startup.update'}},signal,check:async()=>{signal?.throwIfAborted();}});
 await read({purpose:'qq-operator-bind',characterId:'whale'});const controller=new AbortController();
 const enabled=read({purpose:'manage-plugin',setupAction:'complete',autoResume:true},controller.signal),cancelled=assert.rejects(enabled,{name:'AbortError'});await waiting;
 controller.abort();await read({purpose:'manage-plugin',setupAction:'complete',autoResume:false});release();await cancelled;assert.equal(f.saved().autoResume,false);
});
