import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiTransport} from '../src/api-transport.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {effortChoices,cleanModelCatalog} from '../src/reasoning-settings.mjs';
const profile={kind:'custom',protocol:'chat-completions',baseUrl:'https://example.test/v1',model:'fixture'};
const ds={kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash'};
const grok={kind:'grok',protocol:'responses',baseUrl:'https://api.x.ai/v1',model:'grok-4.6'};
test('Official exact model capabilities vary by model and never bleed into proxies or unknown names',()=>{
 assert.deepEqual(effortChoices(ds),['none','low','high','max']);
 assert.deepEqual(effortChoices(grok),['low','medium','high','xhigh']);
 assert.deepEqual(effortChoices({...grok,model:'grok-4.5'}),['low','medium','high']);
 for(const p of [profile,{...grok,baseUrl:'https://proxy.example/v1'},{...ds,model:'deepseek-chat'},{...grok,model:'grok-future'}])assert.deepEqual(effortChoices(p),[]);
 assert.deepEqual(effortChoices({...grok,models:[{id:grok.model,supportedReasoningEfforts:[]}]}),[]);
 assert.deepEqual(effortChoices({...grok,models:[{id:grok.model,supportedReasoningEfforts:['low']}]}),['low']);
});
test('DeepSeek and xAI catalogs retain effort and capacity metadata without retaining arbitrary data',async()=>{
 const rows=[{id:'deepseek-flash',name:'DeepSeek Flash',context_window:1048576,max_output_tokens:393216,effort:{supported_levels:['low','high','max'],default_level:'high'},private:'DO_NOT_COPY'}];
 const transport=new ApiTransport({fetchImpl:async()=>Response.json({data:rows})});
 const result=await transport.listModels(ds);
 assert.deepEqual(effortChoices({...ds,models:result}),['none','low','high','max']);assert.equal(result[0].defaultReasoningEffort,'high');assert.equal(result[0].context_window,1048576);assert.equal(result[0].max_output_tokens,393216);assert.equal(result[0].private,undefined);
 assert.deepEqual(cleanModelCatalog(result),result);
 transport.fetch=async()=>Response.json({data:[{id:'grok-4.6',capabilities:{reasoning_effort:['low','medium','high','xhigh'],default_reasoning_effort:'high'}}]});
 const gx=await transport.listModels(grok);assert.deepEqual(effortChoices({...grok,models:gx}),['low','medium','high','xhigh']);assert.equal(gx[0].defaultReasoningEffort,'high');
});
test('Changing models selects only that model metadata and respects explicit empty support',()=>{
 const models=cleanModelCatalog([{id:'a',supportedReasoningEfforts:['low','high']},{id:'b',supported_reasoning_efforts:['max','ultra']},{id:'c',supportedReasoningEfforts:[]},{id:'d'}]);
 assert.deepEqual(effortChoices({...profile,model:'a'},models),['low','high']);assert.deepEqual(effortChoices({...profile,model:'b'},models),['max','ultra']);
 assert.deepEqual(effortChoices({...profile,model:'c'},models),[]);assert.deepEqual(effortChoices({...profile,model:'d'},models),[]);assert.deepEqual(effortChoices({...profile,model:'absent'},models),[]);
});
test('Each verified API choice reaches the correct wire field and default omits it',async()=>{
 const bodies=[],transport=new ApiTransport({fetchImpl:async(_,r)=>{bodies.push(JSON.parse(r.body));return Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}],output:[{content:[{type:'output_text',text:'ok'}]}]});}});
 for(const p of [ds,grok])for(const effort of [...effortChoices(p),null]){
   for await(const _ of transport.stream({...p,reasoningEffort:effort},{messages:[]})){};
   const b=bodies.at(-1);assert.equal(p.protocol==='responses'?b.reasoning?.effort:b.reasoning_effort,effort??undefined);
 }
 const before=bodies.length;for(const p of [{...ds,reasoningEffort:'medium'},{...grok,reasoningEffort:'ultra'}])await assert.rejects(async()=>{for await(const _ of transport.stream(p,{})){};},/推理强度/);assert.equal(bodies.length,before);
});
test('Verified API choices persist across restart; unsupported saves leave the old connection intact',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-api-effort-')),codex={defaultModel:'fixture',setEnabled(){}},crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
 const router=new ModelRouter({dataRoot,codex,crypto});await router.ready;t.after(()=>router.close());
 const saved=await router.save({...ds,reasoningEffort:'max',key:'fixture'});
 await assert.rejects(router.save({...saved,reasoningEffort:'xhigh'}),/不支持/);assert.equal(router.view().profiles[0].reasoningEffort,'max');
 const restarted=new ModelRouter({dataRoot,codex,crypto});await restarted.ready;t.after(()=>restarted.close());assert.equal(restarted.view().profiles[0].reasoningEffort,'max');
 const reset=await restarted.save({...saved,model:'unknown',reasoningEffort:null});assert.equal(reset.reasoningEffort,null);
});
