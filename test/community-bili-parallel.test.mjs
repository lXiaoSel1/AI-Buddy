import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,setupCommunity} from './support/community-fixtures.mjs';

async function cold(t) {
  const pinned=new Set(),state={work:false,same:false};
  const f=await setupCommunity(t,{officialFingerprints:pinned,busy:(_key,_ref,plugin)=>plugin?state.same:state.work});
  f.pub.source.sourceId='official';pinned.add(f.pub.source.keyFingerprint);
  const page=catalog(f.pub),work=page.works[0];
  work.packageName=work.releases[0].package.packageName='@ai-buddy/bilibili-companion';
  await f.load(page);await f.install();
  const key=f.service.snapshot().dsh.installed[0].packageKey;
  const act=action=>f.service.action({action,packageKey:key});
  await act('dsh-enable');await f.service.drainMaintenance();
  await f.restart();state.work=true;
  const before=f.grants.at(-1);
  return {f,state,before,act};
}
test('signed enabled Bilibili cold-opens during unrelated work without changing its grant or generation',async t=>{
  const {f,before,act}=await cold(t);
  await act('dsh-open-client');assert.equal(f.opened.length,1);
  assert.equal(f.grants.at(-1).generation,before.generation);
  assert.deepEqual(f.grants.at(-1).grantedCapabilities,before.grantedCapabilities);
  await act('dsh-disable');await f.service.drainMaintenance();assert.equal(f.service.snapshot().maintenance.jobs.at(-1).state,'queued');
});
test('target contention and a pending disable still block a cold Bilibili open',async t=>{
  const {f,state,act}=await cold(t);state.same=true;
  await assert.rejects(act('dsh-open-client'),{code:'PLUGIN_BUSY'});assert.equal(f.opened.length,0);
  state.same=false;await act('dsh-open-client');await f.restart();
  await act('dsh-disable');await f.service.drainMaintenance();
  await assert.rejects(act('dsh-open-client'),{code:'PLUGIN_BUSY'});assert.equal(f.opened.length,1);
});
