import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkPluginGate} from '../src/work-plugin-gate.mjs';
import {createWorkHostServer} from '../src/work-host-server.mjs';

test('missing or disabled plugin blocks all work paths before runtime creation and leaves cold data untouched',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'buddy-work-gate-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));let starts=0,record=null;
  const gate=createWorkPluginGate({dataRoot,build:dataRoot,getPlatform:()=>({snapshot:()=>({dsh:{installed:record?[record]:[]}}),runtimeDescriptor(){starts++;throw Error('Must not resolve runtime');},createIsolatedWorkBackend(){starts++;throw Error('Must not start');}}),getGame:()=>({context:()=>({characterId:'deepseek',personaId:'persona-a'}),pluginScope:async()=>({characterId:'deepseek',personaId:'persona-a',lifeId:'life-a',operationId:'operation-a',contextRevision:1}),action:async()=>({companion:{characters:[]}})}),getProvider:()=>null,binaryResolver:()=>{starts++;throw Error('Must not probe');}});
  assert.equal(gate.status().installed,false);await assert.rejects(gate.open(),{code:'WORK_PLUGIN_REQUIRED'});
  for(const action of ['create','start','continue','respond','fork','cancel'])await assert.rejects(gate.legacyAction(action,{}),{code:'WORK_PLUGIN_REQUIRED'});
  for(const action of ['tasks.create','tasks.plan','tasks.execute','tasks.continue','projects.discover'])await assert.rejects(gate.action(action,{}),{code:'WORK_PLUGIN_REQUIRED'});
  await assert.rejects(gate.profiles(),{code:'WORK_PLUGIN_REQUIRED'});assert.deepEqual((await gate.describe()).tools,[]);
  record={packageName:'@ai-buddy/work-collaboration',packageKey:'test-work',pluginId:'dsh.'+'a'.repeat(32),enabled:false,generation:1};await assert.rejects(gate.open(),{code:'WORK_PLUGIN_DISABLED'});await assert.rejects(gate.action('tasks.execute',{}),{code:'WORK_PLUGIN_DISABLED'});
  assert.equal(starts,0);assert.equal(gate.busy(),false);await gate.close();assert.deepEqual(await readdir(dataRoot),[]);
});

test('private job HTTP rejects browser, forged bearer and revoked leases before dispatch',async()=>{
  let calls=0,allowed=true;const server=createWorkHostServer({dispatch:async({operation})=>{calls++;return {operation};},validateLease:()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'REVOKED'});}});
  try{const lease=await server.createLease({context:{pluginId:'work'}}),headers={authorization:'Bearer '+lease.bearer,'content-type':'application/json'},body=JSON.stringify({operation:'context',payload:{}});
    assert.equal((await fetch(lease.url,{method:'POST',headers:{...headers,origin:'http://127.0.0.1:1234'},body})).status,403);
    assert.equal((await fetch(lease.url,{method:'POST',headers:{...headers,authorization:'Bearer forged'},body})).status,401);assert.equal(calls,0);
    const response=await fetch(lease.url,{method:'POST',headers,body});assert.deepEqual(await response.json(),{result:{operation:'context'}});assert.equal(calls,1);
    allowed=false;const denied=await fetch(lease.url,{method:'POST',headers,body});assert.equal((await denied.json()).error.code,'REVOKED');assert.equal(calls,1);
    server.revoke(()=>true);assert.equal((await fetch(lease.url,{method:'POST',headers,body})).status,401);
  }finally{await server.close();}
});
