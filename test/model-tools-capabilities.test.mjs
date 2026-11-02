import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanModelCatalog} from '../src/reasoning-settings.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {ApiTransport} from '../src/api-transport.mjs';
import {resolveWorkCapability} from '../src/work-capabilities.mjs';

const profile={kind:'deepseek',protocol:'responses',baseUrl:'https://provider.invalid/v1',model:'selected',reasoningEffort:null};
const deniedDeclarations=[{supportsTools:false},{supports_tools:false},{capabilities:{tools:false}},{capabilities:{tool_use:false}}];
test('catalog cleaning retains explicit tool booleans but discards unrelated supplier data',()=>{
  for(const declaration of deniedDeclarations){const raw={id:'selected',...declaration,private:'must drop'};const row=cleanModelCatalog([raw])[0];assert.deepEqual(cleanModelCatalog([row]),[row]);assert.equal(row.private,undefined);assert.equal(resolveWorkCapability({...profile,models:[row]}).code,'HARNESS_WORK_TOOLS_UNSUPPORTED');}
  const row=cleanModelCatalog([{id:'selected',capabilities:{tools:true,tool_use:false,unknownSecret:'drop'},supportsTools:true}])[0];assert.deepEqual(row.capabilities,{tools:true,tool_use:false});assert.equal(resolveWorkCapability({...profile,models:[row]}).code,'HARNESS_WORK_TOOLS_UNSUPPORTED');assert.equal(Object.hasOwn(cleanModelCatalog([{id:'unknown'}])[0],'supportsTools'),false);
});
test('API catalog fetch, Router save and restart preserve a supplier explicit no-tools capability',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'buddy-work-tools-roundtrip-')),codex={defaultModel:'unused',setEnabled(){}},crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
  let router=new ModelRouter({dataRoot,codex,crypto});await router.ready;t.after(async()=>{router.close();await rm(dataRoot,{recursive:true,force:true});});
  for(const [index,declaration] of deniedDeclarations.entries()){
    const transport=new ApiTransport({fetchImpl:async()=>Response.json({data:[{id:'selected',...declaration}]})}),models=await transport.listModels(profile);
    const saved=await router.save({...profile,name:'fixture-'+index,key:'only-local-fixture-key',models});assert.equal(resolveWorkCapability({...profile,models:saved.models}).code,'HARNESS_WORK_TOOLS_UNSUPPORTED');
    router.close();router=new ModelRouter({dataRoot,codex,crypto});await router.ready;const persisted=router.view().profiles.find(row=>row.id===saved.id);assert.equal(resolveWorkCapability(persisted).code,'HARNESS_WORK_TOOLS_UNSUPPORTED');
    await router.saveModels(saved.id,persisted.models);assert.equal(resolveWorkCapability(router.view().profiles.find(row=>row.id===saved.id)).code,'HARNESS_WORK_TOOLS_UNSUPPORTED');
  }
});
