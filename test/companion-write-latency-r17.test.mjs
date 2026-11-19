import assert from 'node:assert/strict';
import {channel} from 'node:diagnostics_channel';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {openCompanionStore} from '../src/companion-store.mjs';

test('isolated write metrics separate the real queued commit from no-op and rejected drafts',async t=>{
 const flag='AI_BUDDY_R17_COMPANION_WRITE_TRACE',before=process.env[flag],events=[];
 const root=await mkdtemp(join(tmpdir(),'ai-buddy-r17-write-trace-'));
 const trace=channel('ai-buddy.companion.write-latency'),listen=value=>events.push(value);
 process.env[flag]='1';trace.subscribe(listen);
 let store;
 t.after(async()=>{
  trace.unsubscribe(listen);
  if(before===undefined)delete process.env[flag];else process.env[flag]=before;
  await store?.close();
  await rm(root,{recursive:true,force:true});
 });
 store=await openCompanionStore(root);
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const blocker=store.mutate(async()=>{entered.resolve();await release.promise;});
 await entered.promise;
 const acceptedAfter=Date.now();
 const write=store.mutate(state=>{state.settings.synthetic='no trace body';});
 const rejected=store.mutate(()=>{throw Error('synthetic rejected draft');});
 const rejection=assert.rejects(rejected,/synthetic rejected draft/);
 await delay(20);release.resolve();
 await Promise.all([blocker,write,rejection]);
 const skipped=await store.mutate(()=>{throw Error('guard did not skip body');},{guard:()=>false});
 assert.equal(skipped,undefined);assert.equal(store.state.settings.synthetic,'no trace body');
 assert.deepEqual(events.map(({status})=>status),['no-op','committed','failed','no-op']);
 const commit=events[1];
 assert.equal(commit.operation,'mutate');
 assert.ok(commit.acceptedAt>=acceptedAfter-2);
 assert.ok(commit.committedAt>=commit.acceptedAt);
 assert.ok(commit.queueMs>=15,JSON.stringify(commit));
 assert.ok(commit.acceptedToCommitMs>=commit.queueMs);
 assert.ok(commit.acceptedToOutcomeMs>=commit.acceptedToCommitMs);
 assert.ok(commit.commitMs>0);
 assert.equal(commit.workerMs,null);assert.equal(commit.workerWaitMs,0);
 for(const event of [events[0],events[2],events[3]]){
  assert.equal(event.acceptedToCommitMs,null);
  assert.equal(event.committedAt,null);
 }
 assert.doesNotMatch(JSON.stringify(events),/no trace body|synthetic rejected draft/);
});
