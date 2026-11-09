import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,rename,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSnapshotStorage} from '../src/storage.mjs';
import {createDeferredSaves} from '../src/deferred-saves.mjs';

test('hourly saves publish the latest accepted state, leave clean stores alone and unref the timer',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r14-deferred-clock-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'companion.json'),storage=createSnapshotStorage(target,{deferWrites:true});
 let tick,period,unref=0,cleared=0;
 const timer={unref(){unref++;}};
 const saves=createDeferredSaves({setIntervalFn:(fn,ms)=>{tick=fn;period=ms;return timer;},clearIntervalFn:value=>{assert.equal(value,timer);cleared++;}});
 saves.register('companion',{target,scope:root,flushSync:()=>storage.flushSync()});
 saves.start();assert.equal(period,3600000);assert.equal(unref,1);
 await storage.writeText('latest');await tick();
 assert.equal(await createSnapshotStorage(target).readText(),'latest');
 const version=(await storage.stat()).version;
 await tick();assert.equal((await storage.stat()).version,version);
 saves.stop();assert.equal(cleared,1);
});

test('paired publication cannot persist a new engine ACK between companion and engine writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r14-deferred-pair-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cPath=join(root,'companion.json'),ePath=join(root,'global.json');
 const c=createSnapshotStorage(cPath,{deferWrites:true}),e=createSnapshotStorage(ePath,{deferWrites:true});
 await c.writeText('{"events":[1]}');await e.writeText('{"acknowledged":[1]}');
 const saves=createDeferredSaves();let advanced=false;
 saves.register('engine',{target:ePath,scope:root,flushSync:()=>e.flushSync()});
 saves.register('companion',{target:cPath,scope:root,flushSync:()=>{
  const receipt=c.flushSync();queueMicrotask(()=>{advanced=true;void c.writeText('{"events":[1,2]}');void e.writeText('{"acknowledged":[1,2]}');});return receipt;
 }});
 await saves.flushAll();assert.equal(advanced,true);
 assert.deepEqual(JSON.parse(await createSnapshotStorage(cPath).readText()),{events:[1]});
 assert.deepEqual(JSON.parse(await createSnapshotStorage(ePath).readText()),{acknowledged:[1]});
 assert.deepEqual(JSON.parse(await c.readText()),{events:[1,2]});
});

test('failed companion publication leaves engine ACK uncommitted and both states retryable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r14-deferred-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cPath=join(root,'companion.json'),ePath=join(root,'global.json');
 const c=createSnapshotStorage(cPath,{deferWrites:true}),e=createSnapshotStorage(ePath,{deferWrites:true});
 await c.writeText('old companion');c.flushSync();await e.writeText('old engine');e.flushSync();
 const saves=createDeferredSaves(),audits=[];saves.setAudit(row=>audits.push(row));
 saves.register('engine',{target:ePath,scope:root,flushSync:()=>e.flushSync()});
 saves.register('companion',{target:cPath,scope:root,flushSync:()=>c.flushSync()});
 await c.writeText('new companion');await e.writeText('new engine');
 const directory=cPath+'.snapshots',moved=directory+'-saved';await rename(directory,moved);await writeFile(directory,'not a directory');
 await assert.rejects(saves.flushAll());assert.equal(await createSnapshotStorage(ePath).readText(),'old engine');
 assert.equal(await e.readText(),'new engine');assert.equal(audits.at(-1).type,'deferred-save-failed');
 await rm(directory);await rename(moved,directory);await saves.flushAll();
 assert.equal(await createSnapshotStorage(cPath).readText(),'new companion');assert.equal(await createSnapshotStorage(ePath).readText(),'new engine');
});

test('import pause blocks even a timer already draining and resumes after failure',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r14-deferred-import-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'companion.json'),storage=createSnapshotStorage(target,{deferWrites:true});
 await storage.writeText('baseline');storage.flushSync();await storage.writeText('accepted');
 let tick,finishDrain,entered;const waiting=new Promise(r=>{entered=r;}),drained=new Promise(r=>{finishDrain=r;});
 const saves=createDeferredSaves({setIntervalFn:fn=>{tick=fn;return {unref(){}};},clearIntervalFn(){}});
 saves.register('companion',{target,scope:root,flushSync:()=>storage.flushSync(),drain:async()=>{entered();await drained;}});saves.start();
 const running=tick();await waiting;const resume=saves.pause({scope:root});finishDrain();await running;
 assert.equal(await createSnapshotStorage(target).readText(),'baseline');
 resume();await assert.rejects(saves.withPaused(async()=>{throw Error('cancelled');},{scope:root}),/cancelled/);
 assert.equal(await createSnapshotStorage(target).readText(),'accepted');
 await storage.writeText('after cancel');await tick();assert.equal(await createSnapshotStorage(target).readText(),'after cancel');saves.stop();
});

test('reading a registered engine file checkpoints its companion first and leaves other roots untouched',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r14-deferred-read-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cPath=join(root,'companion.json'),ePath=join(root,'global.json'),otherPath=join(root,'other/global.json');
 const c=createSnapshotStorage(cPath,{deferWrites:true}),e=createSnapshotStorage(ePath,{deferWrites:true}),other=createSnapshotStorage(otherPath,{deferWrites:true});
 await c.writeText('event');await e.writeText('ack');await other.writeText('other');const saves=createDeferredSaves();
 saves.register('companion',{target:cPath,scope:root,flushSync:()=>c.flushSync()});
 saves.register('engine',{target:ePath,scope:root,flushSync:()=>e.flushSync()});
 saves.register('engine',{target:otherPath,scope:join(root,'other'),flushSync:()=>other.flushSync()});
 await saves.beforeRead(ePath);assert.equal(await createSnapshotStorage(cPath).readText(),'event');assert.equal(await createSnapshotStorage(ePath).readText(),'ack');
 await assert.rejects(createSnapshotStorage(otherPath).readText(),{code:'ENOENT'});
 await saves.beforeRead(join(root,'not-registered.json'));await assert.rejects(createSnapshotStorage(otherPath).readText(),{code:'ENOENT'});
});

test('session-end synchronous flush sees accepted writes without awaiting their promises',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r14-deferred-sync-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'companion.json'),storage=createSnapshotStorage(target,{deferWrites:true}),saves=createDeferredSaves();
 saves.register('companion',{target,scope:root,flushSync:()=>storage.flushSync()});
 const receipt=storage.writeText('latest before session end');saves.flushSyncAll();await receipt;
 assert.equal(await createSnapshotStorage(target).readText(),'latest before session end');
});
