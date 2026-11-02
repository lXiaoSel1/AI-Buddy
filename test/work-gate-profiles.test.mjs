import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkPluginGate} from '../src/work-plugin-gate.mjs';

// Cached data only: no runtime may start and no connection may be probed while listing profiles.
test('work profiles carry cached model lists with per-model effort support, bilingual names and structured limitations',async t=>{
  const dataRoot=await mkdtemp(join(process.env.AI_BUDDY_TEST_TEMP_BASE??tmpdir(),'buddy-work-profiles-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));let starts=0;
  const record={packageName:'@ai-buddy/work-collaboration',packageKey:'test-work',pluginId:'dsh.'+'a'.repeat(32),enabled:true,generation:1};
  const codexModels=[{id:'gpt-5.5-codex',name:'GPT-5.5 Codex',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{id:'gpt-5.5-mini',name:'GPT-5.5 mini',supportedReasoningEfforts:[{reasoningEffort:'low'}]}];
  const provider={view:()=>({codexModel:'gpt-5.5-codex',profiles:[{id:'codex',kind:'codex',name:'本机 Codex 登录',protocol:'codex',baseUrl:'',model:'gpt-5.5-codex',models:codexModels},{id:'ds',kind:'deepseek',name:'DeepSeek 官方',protocol:'chat-completions',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',reasoningEffort:'high',models:[]}]})};
  const gate=createWorkPluginGate({dataRoot,build:dataRoot,getPlatform:()=>({snapshot:()=>({dsh:{installed:[record]}}),bridge:{grants:{get:()=>({enabled:true,generation:1})}},runtimeDescriptor(){starts++;throw Object.assign(Error('no runtime in fixture'),{code:'ENOENT'});},createIsolatedWorkBackend(){starts++;throw Error('Must not start');}}),getGame:()=>({context:()=>({characterId:'deepseek',personaId:'p'}),pluginScope:async()=>({characterId:'deepseek',personaId:'p',lifeId:'l',operationId:'o',contextRevision:1}),action:async()=>({companion:{characters:[{id:'deepseek',name:'DeepSeek'}],personas:[{id:'p',name:'Default'}]}})}),getProvider:()=>provider,binaryResolver:()=>{throw Object.assign(Error('not installed'),{code:'ENOENT'});}});
  t.after(()=>gate.close());
  const tools=await gate.profiles(),codex=tools.find(row=>row.engine==='codex'),native=codex.profiles.find(row=>row.id==='native:codex-default');
  assert.equal(native.model,'gpt-5.5-codex','Codex native pre-fills the cached default model');assert.deepEqual(native.label,{zh:'Codex 本机原生配置',en:'Codex (this computer)'});assert.equal(native.nameCode,'codex-native');assert.deepEqual(native.providerLabel,{zh:'OpenAI',en:'OpenAI'});
  assert.equal(native.modelsSource,'catalog');assert.deepEqual(native.models.map(row=>[row.id,row.efforts]),[['gpt-5.5-codex',['low','medium','high']],['gpt-5.5-mini',['low']]]);assert.deepEqual(native.efforts,['low','medium','high']);assert.equal(native.effortSource,'catalog');
  const dsh=tools.find(row=>row.engine==='dsh').profiles.find(row=>row.connectionRef==='ds');assert.deepEqual(dsh.providerLabel,{zh:'DeepSeek 官方',en:'DeepSeek official'});assert.deepEqual(dsh.efforts,['none','low','high','max']);assert.equal(dsh.effortSource,'documented');assert.equal(dsh.modelsSource,'none');
  const claude=tools.find(row=>row.engine==='claude').profiles.find(row=>row.id==='native:claude-default');assert.deepEqual(claude.models,[]);assert.deepEqual(claude.efforts,[]);
  for(const tool of tools)for(const limitation of tool.limitations){assert.equal(typeof limitation.code,'string');assert.equal(typeof limitation.zh,'string');assert.equal(typeof limitation.en,'string');}
  assert.equal(tools.find(row=>row.engine==='kimi').limitations[0]?.code??'ENGINE_INCOMPATIBLE','ENGINE_INCOMPATIBLE');
  const described=await gate.describe();assert.deepEqual(described.personas,[{id:'p',name:'Default'}]);
});
