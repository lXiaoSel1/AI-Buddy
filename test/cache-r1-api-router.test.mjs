import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';

test('Kimi cache lifetime persists through connection save and reload',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'cache-r1-router-'));
  t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const router=await new ModelRouter({dataRoot,codex:{defaultModel:'fixture'}}).ready;
  const draft={kind:'kimi',model:'kimi-k3.1-pro'};
  const saved=await router.save(draft);
  assert.equal(saved.kimiCacheTtl,'5m');
  const change={...draft,id:saved.id,kimiCacheTtl:'1h'};
  assert.equal((await router.save(change)).kimiCacheTtl,'1h');
  const restored=await new ModelRouter({dataRoot,codex:{defaultModel:'fixture'}}).ready;
  assert.equal(restored.view().profiles[0].kimiCacheTtl,'1h');
  assert.equal((await restored.save({...draft,id:saved.id})).kimiCacheTtl,'1h');
  await assert.rejects(restored.save({...change,kimiCacheTtl:'30m'}),/5/);
  assert.equal((await restored.save({...change,baseUrl:'https://proxy.example.test/v1'})).kimiCacheTtl,undefined);
});
