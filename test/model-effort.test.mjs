import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';
import {effortChoices,profileEffort,cleanModelCatalog} from '../src/reasoning-settings.mjs';
const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
const catalog=[{id:'fast-model',name:'Fast',supportedReasoningEfforts:[{reasoningEffort:'low',description:'fast'},{reasoningEffort:'medium'}],defaultReasoningEffort:'low'},{id:'deep-model',name:'Deep',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'max'}],defaultReasoningEffort:'high'}];
async function fixture(t){const calls=[],codex={defaultModel:'configured-model',enabled:false,setEnabled(v){this.enabled=v;},async fetchModels(){calls.push({kind:'catalog'});return structuredClone(catalog);},async *stream(options){calls.push({kind:'turn',...options});yield{type:'text-delta',text:'fixture'};}},dataRoot=mkdtempSync(join(tmpdir(),'buddy-effort-')),router=new ModelRouter({dataRoot,codex,crypto,legacy:true});await router.ready;t.after(()=>router.close());return{router,codex,calls,dataRoot};}
async function drain(stream){for await(const _ of stream){}}

test('Codex fetch reads a real catalog while offline without changing selected model or losing effort metadata',async t=>{
 const {router,codex,calls}=await fixture(t),before=router.view();
 const rows=await router.fetchModels(before.profiles[0]);assert.equal(router.enabled,false);assert.equal(codex.enabled,false);assert.deepEqual(rows,cleanModelCatalog(catalog));assert.equal(router.defaultModel,'configured-model');assert.equal(calls.length,1);
 await router.saveModels('codex',rows);assert.deepEqual(router.view().profiles[0].models[1].supportedReasoningEfforts,[{reasoningEffort:'high',description:''},{reasoningEffort:'max',description:''}]);
 assert.equal(router.view().profiles[0].reasoningEffort,'low');
 await assert.rejects(router.save({...router.view().profiles[0],model:'deep-model',reasoningEffort:'low'}),/不支持/);
});

test('Connection effort persists across restart, per-role selection and queued request snapshots',async t=>{
 const {router,codex,calls,dataRoot}=await fixture(t);
 const fast=await router.save({kind:'codex',name:'省用量',model:'fast-model',reasoningEffort:'low',models:catalog});
 const deep=await router.save({kind:'codex',name:'认真',model:'deep-model',reasoningEffort:'high',models:catalog});
 await router.activate(fast.id);router.setEnabled(true);
 let release;const gate=new Promise(r=>release=r);
 const first=router.runProfile(deep.id,async()=>{assert.equal(router.resolveModelInfo(deep.id,'deep-model').reasoning.efforts[0].id,'high');await gate;await drain(router.stream({messages:[],reasoningEffort:'low'}));});
 const second=router.runProfile(fast.id,()=>drain(router.stream({messages:[],reasoningEffort:'max'})));
 await assert.rejects(router.save({...deep,reasoningEffort:'max'}),/等待/);release();await Promise.all([first,second]);
 // Each connection has its own lane: the fast connection no longer waits for the held deep turn.
 const sent=calls.filter(x=>x.kind==='turn');assert.deepEqual(sent.map(x=>[x.model,x.reasoningEffort]),[['fast-model','low'],['deep-model','high']]);assert.equal(router.defaultModel,'fast-model');
 const restarted=new ModelRouter({dataRoot,codex,crypto});await restarted.ready;t.after(()=>restarted.close());assert.equal(restarted.enabled,false);assert.equal(restarted.view().profiles.find(p=>p.id===deep.id).reasoningEffort,'high');
 await router.save({...deep,reasoningEffort:null});await router.runProfile(deep.id,()=>drain(router.stream({messages:[],reasoningEffort:'low'})));assert.equal(calls.at(-1).reasoningEffort,null);
});

test('Effort validation and UI choices respect model metadata and protocol defaults',async t=>{
 const {router}=await fixture(t);
 assert.equal(profileEffort({kind:'codex'}),'low');assert.equal(profileEffort({kind:'openai'}),null);
 assert.deepEqual(effortChoices({kind:'codex',protocol:'codex',model:'deep-model'},catalog),['high','max']);assert.deepEqual(effortChoices({kind:'codex',protocol:'codex',model:'unknown'},catalog),[]);
 assert.deepEqual(effortChoices({kind:'claude',protocol:'anthropic',model:'x'}),[]);
 for(const reasoningEffort of ['invalid',{},1])await assert.rejects(router.save({kind:'codex',model:'fast-model',reasoningEffort}),/推理强度/);
 await assert.rejects(router.save({kind:'claude',model:'x',reasoningEffort:'low'}),/协议不支持/);
 await assert.rejects(router.save({kind:'openai',model:'manual',reasoningEffort:'low',key:'fixture'}),/不支持/);
 const p=await router.save({kind:'openai',model:'manual',models:[{id:'manual',supportedReasoningEfforts:['low']}],reasoningEffort:'low',key:'fixture'});assert.equal(p.reasoningEffort,'low');
 await router.save({...p,reasoningEffort:null,key:''});assert.equal(router.view().profiles.find(row=>row.id===p.id).reasoningEffort,null);
});
