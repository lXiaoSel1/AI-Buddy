import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentAdapterFactory} from '../src/agent-work-profile.mjs';
import {resolveWorkCapability,requireWorkCapability,workTransportBinding,deepseekModelCatalog,deepseekBaseInstructions} from '../src/work-capabilities.mjs';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'buddy-deepseek-route-')),dataRoot=join(root,'data'),workspace=join(root,'project'),binary=join(root,'codex.exe');
  await mkdir(dataRoot);await mkdir(workspace);await writeFile(binary,'isolated fixture');
  const task={id:'route-fixture',scope:{characterId:'deepseek',lifeId:'life',personaId:'persona'},workspace:{path:workspace},binding:{provider:'deepseek',model:'deepseek-flash'}};
  return {root,task,factory:createAgentAdapterFactory({dataRoot,binaryResolver:async()=>binary}),cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('official DeepSeek chat preset maps explicitly to the documented Responses root',async()=>{
  const f=await fixture();let adapter;
  try{adapter=await f.factory({task:f.task,connection:{kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',key:'only-selected-key'}});const config=await readFile(join(adapter.profileReceipt.home,'config.toml'),'utf8');assert.ok(config.includes('base_url = "http://127.0.0.1:'));assert.equal(adapter.profileReceipt.endpoint,'https://api.deepseek.com');assert.equal(adapter.profileReceipt.transport.mapping,'deepseek-official-root');assert.notEqual(adapter.rpc.env.AI_BUDDY_SELECTED_WORK_KEY,'only-selected-key');assert.ok(config.includes('request_max_retries = 0'));assert.ok(config.includes('stream_max_retries = 0'));}
  finally{adapter?.dispose();await f.cleanup();}
});
test('third-party Chat-only connection is rejected before a work process can be constructed',async()=>{
  const f=await fixture();let adapter;
  try{await assert.rejects(async()=>{adapter=await f.factory({task:f.task,connection:{kind:'deepseek',protocol:'chat-completions',baseUrl:'http://127.0.0.1:32123/v1',model:'deepseek-flash',key:'only-selected-key'}});},{code:'HARNESS_WORK_PROTOCOL_UNSUPPORTED'});}
  finally{adapter?.dispose();await f.cleanup();}
});
const official={kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash'};
test('all supported official preset spellings resolve to the same immutable work binding',()=>{
  const expected=workTransportBinding(requireWorkCapability(official));
  for(const baseUrl of ['https://api.deepseek.com','https://api.deepseek.com/','https://api.deepseek.com/v1','https://api.deepseek.com/v1/','https://api.deepseek.com:443/v1'])for(const protocol of ['responses','chat-completions'])assert.deepEqual(workTransportBinding(requireWorkCapability({...official,baseUrl,protocol})),expected);
  const copy=workTransportBinding(requireWorkCapability(official));copy.endpoint='https://other.invalid';assert.equal(requireWorkCapability(official).transport.endpoint,expected.endpoint);
});
test('third-party explicit Responses keeps its endpoint and never claims official verified capability',()=>{
  const profile={...official,protocol:'responses',baseUrl:'https://provider.invalid/prefix/v1',model:'exact-custom-model',contextTokens:65536};
  const result=requireWorkCapability(profile);assert.equal(result.compatibility,'configuration-only');assert.equal(result.transport.endpoint,profile.baseUrl);assert.equal(result.transport.model,profile.model);assert.equal(result.modelCapabilities.contextWindow,65536);assert.deepEqual(result.modelCapabilities.reasoningEfforts,[]);assert.equal(result.transport.effort,null);
  const catalog=deepseekModelCatalog(result);assert.equal(catalog.models[0].slug,profile.model);assert.equal(catalog.models[0].default_reasoning_level,null);assert.equal(catalog.models[0].apply_patch_tool_type,'freeform');
});
test('lookalike domains and nonstandard official paths cannot invoke the official mapping',()=>{
  for(const baseUrl of ['https://api.deepseek.com.evil.invalid/v1','https://api.deepseek.com:8443/v1','https://api.deepseek.com/custom','https://api.deepseek.com/v1/responses'])assert.equal(resolveWorkCapability({...official,baseUrl}).code,'HARNESS_WORK_PROTOCOL_UNSUPPORTED');
  for(const baseUrl of ['https://api.deepseek.com/v1?key=secret','https://secret@api.deepseek.com/v1','http://api.deepseek.com/v1'])assert.equal(resolveWorkCapability({...official,baseUrl}).code,'HARNESS_WORK_ENDPOINT_INVALID');
});
test('official model IDs and effort levels are validated without aliases or fallback',()=>{
  for(const model of ['deepseek-flash','deepseek-v4-pro'])for(const reasoningEffort of [null,'none','low','high','max'])assert.equal(resolveWorkCapability({...official,model,reasoningEffort}).available,true);
  for(const model of ['deepseek-chat','deepseek-reasoner','unknown'])assert.equal(resolveWorkCapability({...official,model}).code,'HARNESS_WORK_MODEL_UNVERIFIED');
  for(const reasoningEffort of ['medium','xhigh','ultra','nonsense'])assert.equal(resolveWorkCapability({...official,reasoningEffort}).code,'HARNESS_WORK_EFFORT_UNSUPPORTED');
});
test('third-party declared effort and context capabilities are selected by exact model ID',()=>{
  const profile={...official,protocol:'responses',baseUrl:'http://127.0.0.1:32123/v1',model:'chosen',reasoningEffort:'high',models:[{id:'other',supportedReasoningEfforts:['max'],contextWindow:999999},{id:'chosen',supportedReasoningEfforts:[{reasoningEffort:'high'}],contextWindow:32768}]};
  const result=requireWorkCapability(profile);assert.deepEqual(result.modelCapabilities.reasoningEfforts,['high']);assert.equal(result.modelCapabilities.contextWindow,32768);assert.equal(result.transport.effort,'high');
  assert.equal(resolveWorkCapability({...profile,reasoningEffort:'max'}).code,'HARNESS_WORK_EFFORT_UNSUPPORTED');
  assert.equal(resolveWorkCapability({...profile,models:[{id:'chosen',supportsTools:false}]}).code,'HARNESS_WORK_TOOLS_UNSUPPORTED');
});
test('transport hash changes with capability metadata, not unrelated keys or persona text',()=>{
  const profile={...official,protocol:'responses',baseUrl:'https://provider.invalid/v1',model:'chosen',models:[{id:'chosen',contextWindow:32768,supportedReasoningEfforts:['high']}]};
  const result=requireWorkCapability(profile);assert.deepEqual(workTransportBinding(requireWorkCapability({...profile,key:'private',name:'other label'})),result.transport);
  assert.notEqual(requireWorkCapability({...profile,models:[{...profile.models[0],contextWindow:65536}]}).transport.catalogHash,result.transport.catalogHash);
  assert.ok(!JSON.stringify(result).includes('private'));assert.equal(deepseekBaseInstructions('identity marker').endsWith('identity marker'),true);assert.ok(deepseekBaseInstructions('identity marker').includes('# Tool Guidelines'));
});
test('native model capacity and compaction never exceed the resolved user context budget',()=>{
  const defaults=requireWorkCapability(official);assert.equal(defaults.modelCapabilities.declaredContextWindow,1048576);assert.equal(defaults.modelCapabilities.effectiveContextWindow,272000);
  for(const contextTokens of [4096,32768,272000,1048576,1500000]){const resolved=requireWorkCapability({...official,contextTokens}),catalog=deepseekModelCatalog(resolved).models[0];assert.equal(catalog.context_window,Math.min(contextTokens,1048576));assert.equal(catalog.max_context_window,catalog.context_window);assert.ok(catalog.auto_compact_token_limit<catalog.context_window);}
  const fromRow={...official,models:[{id:'deepseek-flash',contextWindow:65536}]};assert.deepEqual(requireWorkCapability(fromRow).transport,requireWorkCapability({...fromRow,contextTokens:65536}).transport);
  assert.deepEqual(requireWorkCapability(official).transport,requireWorkCapability({...official,contextTokens:272000}).transport);
  assert.notEqual(requireWorkCapability({...official,contextTokens:32768}).transport.catalogHash,defaults.transport.catalogHash);
  const external=requireWorkCapability({...official,protocol:'responses',baseUrl:'https://provider.invalid/v1',contextTokens:500000,models:[{id:'deepseek-flash',contextWindow:64000}]});assert.equal(external.modelCapabilities.declaredContextWindow,64000);assert.equal(external.modelCapabilities.effectiveContextWindow,64000);
});
test('factory verifies frozen work transport before writing task profiles or constructing Codex',async()=>{
  const f=await fixture();try{const connection={...official,key:'private'},transport=workTransportBinding(requireWorkCapability(connection));await assert.rejects(f.factory({task:{...f.task,binding:{...f.task.binding,workTransport:{...transport,endpoint:'https://other.invalid'}}},connection}),{code:'HARNESS_WORK_TRANSPORT_CHANGED'});}finally{await f.cleanup();}
});
