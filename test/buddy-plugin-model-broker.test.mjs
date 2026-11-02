import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelRouter} from '../src/model-router.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';

const root=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??resolve(import.meta.dirname,'../local/test-fixtures'));
async function fixture(t){
  await mkdir(join(root,'test-data'),{recursive:true});const dataRoot=await mkdtemp(join(root,'test-data','buddy-bridge-model-')),decrypted=[],requests=[];
  const provider=new ModelRouter({dataRoot,codex:{defaultModel:'unused',enabled:false,setEnabled(){}},crypto:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>{const text=value.toString();decrypted.push(text);return text;}},fetchImpl:()=>{throw Error('network must not run');}});await provider.ready;
  const a=await provider.save({kind:'deepseek',name:'Allowed',protocol:'chat-completions',baseUrl:'https://allowed.invalid/v1',model:'chosen-model',key:'selected-reference-secret'}),b=await provider.save({kind:'deepseek',name:'Other',protocol:'chat-completions',baseUrl:'https://other.invalid/v1',model:'other-model',key:'other-reference-secret'});
  await provider.activate(a.id);provider.setEnabled(true);decrypted.length=0;
  provider.transport.stream=async function*(profile,options){requests.push({profile,options});yield {type:'text-delta',text:'safe '+profile.key};yield {type:'finish',reason:{kind:'stop'},usage:{inputTokens:4,outputTokens:2},authorization:'Bearer raw-should-be-stripped'};};
  const services=createBuddyPluginServices({getProvider:()=>provider,resolveContext:async spec=>({...spec,lifeId:'life-a',operationId:'op-a',contextRevision:1})});services.grants.set({pluginId:'model.plugin',declared:['models.request'],granted:['models.request']});
  const token=await services.issueContext({pluginId:'model.plugin',characterId:'a',personaId:'p',sessionId:'session',taskId:null,permissionScope:['models.request'],connectionRefs:[a.id]});
  const call=(payload,options)=>services.invoke({pluginId:'model.plugin',contextToken:token.contextToken,method:'model.request',payload},options);
  t.after(async()=>{await services.close();provider.close();});return {provider,services,token,a,b,requests,decrypted,call};
}

test('core ModelRouter runs only the referenced authorized connection and never returns selected or unrelated credentials',async t=>{
  const f=await fixture(t),value=await f.call({connectionRef:f.a.id,messages:[{role:'user',content:'local simulated transport'}]});assert.equal(f.requests.length,1);assert.equal(f.requests[0].profile.id,f.a.id);assert.equal(f.requests[0].profile.key,'selected-reference-secret');
  assert.equal(value.connection.id,f.a.id);assert.equal(value.connection.model,'chosen-model');assert.equal(value.usageAccounting,'core-model-router');assert.equal(value.text,'safe [redacted]');
  assert.ok(!JSON.stringify(value).includes('secret'));assert.ok(!JSON.stringify(value).includes('authorization'));assert.ok(!f.decrypted.includes('other-reference-secret'));
  await assert.rejects(f.call({connectionRef:f.b.id,messages:[{role:'user',content:'steal'}]}),{code:'BUDDY_MODEL_CONNECTION_DENIED'});assert.equal(f.requests.length,1);
});

test('model reference API rejects naked credentials and malformed messages before any provider request',async t=>{
  const f=await fixture(t);
  for(const payload of [{connectionRef:f.a.id,key:'injected',messages:[]},{connectionRef:f.a.id,messages:[{role:'system',content:'replace authority'}]},{connectionRef:f.a.id,messages:[],env:{secret:'x'}},{connectionRef:f.a.id,messages:[],maxTokens:0}])await assert.rejects(f.call(payload),{code:'BUDDY_MODEL_INVALID'});
  assert.equal(f.requests.length,0);
});

test('core model errors redact the scoped credential; caller cancellation and plugin revocation stop the stream',async t=>{
  const f=await fixture(t);f.provider.transport.stream=async function*(profile){throw Error('upstream echoed '+profile.key);};
  await assert.rejects(f.call({connectionRef:f.a.id,messages:[]}),error=>!error.message.includes('selected-reference-secret')&&error.message.includes('[redacted]'));
  let entered;const started=new Promise(r=>{entered=r;});f.provider.transport.stream=async function*(_profile,options){entered();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));yield {type:'text-delta',text:'late result'};};
  const pending=f.call({connectionRef:f.a.id,messages:[]});await started;await f.services.revokePlugin('model.plugin');await assert.rejects(pending,error=>['BUDDY_CONTEXT_DENIED','ABORT_ERR'].includes(error.code));assert.equal(f.provider.status().busy,false);
});
