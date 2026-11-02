import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';

// QQ 2.0.2 lets the status card switch resume-on-start. The host records it through the same 'complete' setup step
// that setup.finish uses; only the QQ plugin's 'startup.update' action may ask for it, and nothing else widens.
async function fixture(t,packageName='@ai-buddy/qq-connect'){
 const parent=resolve(process.env.AI_BUDDY_TEST_ROOT??join(tmpdir(),'buddy-social-startup'));await mkdir(parent,{recursive:true});const dataRoot=await mkdtemp(join(parent,'startup-'));await mkdir(join(dataRoot,'social-core'));
 const account={ref:'qq',pluginId:packageName,accountId:'123',enabled:true,generation:1},setups=[];let issued=0;
 const identity={pluginId:'source-qq',packageName},accounts={get:()=>account,forPlugin:()=>account,list:()=>[account]};
 const core={socialProfile:characterId=>({characterId,personaId:'persona',lifeId:'life',operationId:'op',connectionRef:'model'}),socialHost:{registerContext:()=>({contextRef:'context-'+(++issued),revoke(){}})},registerSocialDelivery:()=>({revoke(){}}),socialCatalog:()=>[{id:'whale',label:'鲸鱼娘'}]};
 const bridge={issueContext:async()=>({contextToken:'issued-'+issued}),invoke:async()=>assert.fail('No model/work/network call is permitted')};
 const broker=createSocialPluginBroker({dataRoot,accounts,transport:{},bridge,getR95:()=>core,getProvider:()=>({state:{profiles:[]}}),onSetup:async value=>{setups.push(value);return {saved:true};}});
 t.after(async()=>{await broker.close();assert.ok(resolve(dataRoot).startsWith(parent+sep));await rm(dataRoot,{recursive:true,force:true});});
 const read=(payload,authority)=>broker.handlers['social.context.read']({identity,payload,context:{authority},check:async()=>{}});
 if(packageName==='@ai-buddy/qq-connect')await read({purpose:'qq-operator-bind',characterId:'whale'},{kind:'app'});
 setups.length=0;
 return {read,setups};
}

test('QQ startup.update may complete with autoResume; the scope is the live operator',async t=>{
 const f=await fixture(t);
 const value=await f.read({purpose:'manage-plugin',setupAction:'complete',autoResume:true},{kind:'app',action:'startup.update'});
 assert.deepEqual(value.onboarding,{saved:true});
 assert.equal(f.setups.length,1);assert.equal(f.setups[0].action,'complete');assert.equal(f.setups[0].payload.autoResume,true);
 assert.equal(f.setups[0].payload.scope.characterId,'whale');assert.equal(f.setups[0].payload.scope.lifeId,'life');
 await f.read({purpose:'manage-plugin',setupAction:'complete',autoResume:true},{kind:'app',action:'setup.finish'});
 assert.equal(f.setups.length,2,'setup.finish keeps working');
});

test('no other action, setup step, plugin or background authority gains the complete step',async t=>{
 const f=await fixture(t);
 for(const [payload,authority] of [
  [{purpose:'manage-plugin',setupAction:'complete',autoResume:true},{kind:'app',action:'settings.update'}],
  [{purpose:'manage-plugin',setupAction:'open'},{kind:'app',action:'startup.update'}],
  [{purpose:'manage-plugin',setupAction:'contacts'},{kind:'app',action:'startup.update'}],
  [{purpose:'plugin-background',setupAction:'complete',autoResume:true},{kind:'background',action:'startup.update'}],
 ])await assert.rejects(f.read(payload,authority),{code:'SOCIAL_SETUP_DENIED'},JSON.stringify([payload,authority]));
 assert.equal(f.setups.length,0);
 const bili=await fixture(t,'@ai-buddy/bilibili-companion');
 await assert.rejects(bili.read({purpose:'manage-plugin',setupAction:'complete'},{kind:'app',action:'startup.update'}),{code:'SOCIAL_SETUP_DENIED'});
 assert.equal(bili.setups.length,0);
});
