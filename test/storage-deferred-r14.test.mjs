import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,utimesSync,existsSync,copyFileSync,mkdirSync,renameSync,rmdirSync} from 'node:fs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSnapshotStorage,parseCommits,retentionState} from '../src/storage.mjs';

const fresh=t=>{const dir=mkdtempSync(join(tmpdir(),'storage-r14-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'state.json');};

test('a journal I/O failure can be retried on the same snapshot storage instance',async t=>{
 const path=fresh(t),journal=join(path+'.snapshots','commits.jsonl');
 await createSnapshotStorage(path).writeText('original content');
 const held=journal+'.held';renameSync(journal,held);mkdirSync(journal);
 const storage=createSnapshotStorage(path);
 await assert.rejects(storage.readText(),{code:'EISDIR'});
 rmdirSync(journal);renameSync(held,journal);
 assert.equal(await storage.readText(),'original content');
});

test('protected saves recover an older verified commit and report it without rewriting the journal',async t=>{
 const path=fresh(t),directory=path+'.snapshots',journal=join(directory,'commits.jsonl'),seed=createSnapshotStorage(path);
 const older=await seed.writeText('verified older state');
 const newer=await seed.writeText('newer state');
 const before=readFileSync(journal),expected=parseCommits(before.toString()).commits[0];
 writeFileSync(join(directory,newer.version),'checksum mismatch');
 const events=[],store=createSnapshotStorage(path,{protectExisting:true,onAudit:event=>events.push(event)});
 assert.equal((await store.stat()).version,older.version);
 assert.equal(await store.readText(),'verified older state');
 assert.deepEqual(events,[{type:'snapshot-fallback',target:path,skipped:1,version:older.version,recoveredAt:expected.timestamp}]);
 assert.deepEqual(readFileSync(journal),before);
});

test('protected saves do not mistake an unreadable newest payload for a missing one',async t=>{
 const path=fresh(t),directory=path+'.snapshots',seed=createSnapshotStorage(path);
 await seed.writeText('verified older state');
 const newer=await seed.writeText('newer state');
 const newest=join(directory,newer.version),held=newest+'.held';renameSync(newest,held);mkdirSync(newest);
 const storage=createSnapshotStorage(path,{protectExisting:true,deferWrites:true});
 await assert.rejects(storage.writeText('would overwrite a protected save'),{code:'EISDIR'});
 rmdirSync(newest);renameSync(held,newest);
 assert.equal(await storage.readText(),'newer state');
 assert.equal((await storage.flush()).operation,'unchanged');
});

test('a torn snapshot journal does not let a protected save start over or use stale bare JSON',async t=>{
 const path=fresh(t),directory=path+'.snapshots',journal=join(directory,'commits.jsonl');
 const stale='{"generation":1}',torn='\n{"file":';
 writeFileSync(path,stale);mkdirSync(directory);writeFileSync(journal,torn);
 const store=createSnapshotStorage(path,{protectExisting:true,deferWrites:true});
 await assert.rejects(store.stat(),{code:'SNAPSHOT_RECOVERY_REQUIRED',reason:'no-valid-commit'});
 await assert.rejects(store.writeText('{"generation":0}'),{code:'SNAPSHOT_RECOVERY_REQUIRED'});
 assert.throws(()=>store.flushSync(),{code:'SNAPSHOT_RECOVERY_REQUIRED'});
 assert.equal(readFileSync(path,'utf8'),stale);
 assert.equal(readFileSync(journal,'utf8'),torn);
});

test('a staged default save cannot replace history that appears before the first flush',async t=>{
 const path=fresh(t),journal=join(path+'.snapshots','commits.jsonl');
 const writer=createSnapshotStorage(path,{protectExisting:true,deferWrites:true});
 assert.equal(await writer.stat(),undefined);
 await writer.writeText('staged default');
 await createSnapshotStorage(path).writeText('reappeared history');
 const before=readFileSync(journal);
 await assert.rejects(writer.flush(),{code:'SNAPSHOT_RECOVERY_REQUIRED',reason:'existing-save-appeared'});
 assert.throws(()=>writer.flushSync(),{code:'SNAPSHOT_RECOVERY_REQUIRED'});
 assert.deepEqual(readFileSync(journal),before);
 writer.reload();
 assert.equal(await writer.readText(),'reappeared history');
});

test('flushSync includes the latest writeText call even before its promise is awaited',async t=>{
 const path=fresh(t),storage=createSnapshotStorage(path,{deferWrites:true});
 const first=storage.writeText('first accepted'),latest=storage.writeText('latest accepted');
 assert.equal(storage.flushSync().operation,'create');
 await Promise.all([first,latest]);
 assert.equal(await createSnapshotStorage(path).readText(),'latest accepted');
 assert.equal(parseCommits(readFileSync(join(path+'.snapshots','commits.jsonl'),'utf8')).commits.length,1);
});

test('unchanged flushes and reverting to the saved value do not add journal commits',async t=>{
 const path=fresh(t),storage=createSnapshotStorage(path,{deferWrites:true});
 assert.equal((await storage.flush()).operation,'unchanged');assert.ok(!existsSync(path+'.snapshots'));
 await storage.writeText('saved');await storage.flush();
 const journal=join(path+'.snapshots','commits.jsonl'),before=readFileSync(journal,'utf8');
 assert.equal((await storage.writeText('saved')).operation,'unchanged');
 assert.equal((await storage.flush()).operation,'unchanged');
 await storage.writeText('temporary');await storage.writeText('saved');
 assert.equal(storage.flushSync().operation,'unchanged');
 assert.equal(readFileSync(journal,'utf8'),before);
 assert.equal(await createSnapshotStorage(path).readText(),'saved');
});

test('CAS observes pending writes and same-generation receipt and stat versions survive a flush',async t=>{
 const path=fresh(t),storage=createSnapshotStorage(path,{deferWrites:true});
 const first=await storage.writeText('one',{kind:'createIfAbsent'}),pendingVersion=(await storage.stat()).version;
 assert.equal(first.operation,'create');assert.equal(first.before,null);assert.equal(first.after,'one');
 await assert.rejects(storage.writeText('other',{kind:'createIfAbsent'}),{code:'FS_NOT_OBSERVED'});
 await storage.flush();const publishedVersion=(await storage.stat()).version;
 assert.notEqual(publishedVersion,pendingVersion);assert.equal(first.version,publishedVersion);
 const second=await storage.writeText('two',{kind:'replaceIfVersion',version:pendingVersion}),secondPending=(await storage.stat()).version;
 assert.equal(second.operation,'update');assert.equal(second.before,'one');assert.equal(second.after,'two');
 await assert.rejects(storage.writeText('stale',{kind:'replaceIfVersion',version:pendingVersion}),{code:'FS_STALE_VERSION'});
 await assert.rejects(storage.writeText('stale',{kind:'replaceIfVersion',version:first.version}),{code:'FS_STALE_VERSION'});
 await storage.flush();assert.equal(second.version,(await storage.stat()).version);
 await storage.writeText('three',{kind:'replaceIfVersion',version:secondPending});
 await assert.rejects(storage.writeText('stale',{kind:'replaceIfVersion',version:second.version}),{code:'FS_STALE_VERSION'});
 storage.flushSync();assert.equal(await createSnapshotStorage(path).readText(),'three');
});

test('failed async and synchronous flushes audit the error and retain the latest accepted value for retry',async t=>{
 const path=fresh(t),audits=[],storage=createSnapshotStorage(path,{deferWrites:true,onAudit:event=>{audits.push(event);throw Error('audit sink unavailable');}});
 await storage.writeText('accepted before failure');writeFileSync(path+'.snapshots','filesystem blocker');
 const blocked=error=>['EEXIST','ENOTDIR'].includes(error.code);
 await assert.rejects(storage.flush(),blocked);assert.equal(await storage.readText(),'accepted before failure');
 assert.throws(()=>storage.flushSync(),blocked);
 assert.equal(audits.length,2);assert.equal(audits[0].type,'snapshot-flush-failed');
 assert.equal(audits[0].target,path);assert.equal(audits[0].synchronous,false);assert.equal(audits[1].synchronous,true);
 await storage.writeText('latest accepted after failure');rmSync(path+'.snapshots');
 const receipt=await storage.flush();assert.equal(receipt.operation,'create');
 assert.equal(await createSnapshotStorage(path).readText(),'latest accepted after failure');
 assert.equal((await storage.flush()).operation,'unchanged');assert.equal(audits.length,2);
});

test('deferred memory reads and receipt shapes support retainText false with either receipt mode',async t=>{
 for(const compactReceipt of [false,true]){
  const path=fresh(t);await createSnapshotStorage(path).writeText('previous saved value');
  const storage=createSnapshotStorage(path,{deferWrites:true,retainText:false,compactReceipt});
  assert.equal(await storage.readText(),'previous saved value');
  const receipt=await storage.writeText('next pending value');assert.equal(await storage.readText(),'next pending value');
  if(compactReceipt)assert.deepEqual(Object.keys(receipt).sort(),['operation','version']);
  else {assert.equal(receipt.before,'previous saved value');assert.equal(receipt.after,'next pending value');}
  await storage.flush();assert.equal(receipt.version,(await storage.stat()).version);
  assert.equal(await storage.readText(),'next pending value');
  assert.equal(await createSnapshotStorage(path,{retainText:false}).readText(),'next pending value');
 }
});

test('deferred writes are immediately readable while a disk reopen sees only the last flushed value',async t=>{
 const path=fresh(t);await createSnapshotStorage(path).writeText('last saved');
 const storage=createSnapshotStorage(path,{deferWrites:true});
 const receipt=await storage.writeText('latest accepted');
 assert.equal(receipt.before,'last saved');assert.equal(receipt.after,'latest accepted');
 assert.equal(await storage.readText(),'latest accepted');
 assert.equal((await storage.stat()).size,15);
 assert.equal(await createSnapshotStorage(path).readText(),'last saved');
 await storage.flush();
 assert.equal(await createSnapshotStorage(path).readText(),'latest accepted');
});

test('offline reload discards old pending state and cannot overwrite the imported disk state',async t=>{
 const path=fresh(t);await createSnapshotStorage(path).writeText('before import');
 const storage=createSnapshotStorage(path,{deferWrites:true});await storage.writeText('obsolete pending state');
 const imported=await createSnapshotStorage(path).writeText('imported state');
 const info=storage.reload();assert.equal(info.version,imported.version);
 assert.equal(await storage.readText(),'imported state');
 assert.equal(storage.flushSync().operation,'unchanged');
 assert.equal(await createSnapshotStorage(path).readText(),'imported state');
});

test('offline archive daily snapshots remain protected during later normal retention',async t=>{
 const path=fresh(t),seed=createSnapshotStorage(path,{retention:false});
 for(let n=0;n<60;n++)await seed.writeText('saved '+n);
 const root=path+'.snapshots',first=parseCommits(readFileSync(join(root,'commits.jsonl'),'utf8')).commits[0].file;
 const old=new Date(Date.now()-2*3600000),orphan=old.toISOString().replaceAll(':','-')+'-daily.json';
 writeFileSync(join(root,orphan),'daily backlog');utimesSync(join(root,orphan),old,old);
 writeFileSync(join(root,'retention-archived.json'),JSON.stringify({protectedFiles:[first,orphan,'../escape.json','nested\\escape.json','.',null]}));
 assert.deepEqual(retentionState(root).protectedFiles,[first,orphan]);
 await createSnapshotStorage(path).prune();
 assert.ok(existsSync(join(root,first)));assert.ok(existsSync(join(root,orphan)));
 assert.ok(parseCommits(readFileSync(join(root,'commits.jsonl'),'utf8')).commits.some(c=>c.file===first));
 assert.equal(await createSnapshotStorage(path).readText(),'saved 59');
});

test('a synchronous flush during an already-read retention pass cannot lose the new journal commit',async t=>{
 const path=fresh(t),seed=createSnapshotStorage(path,{retention:false});
 for(let n=0;n<60;n++)await seed.writeText('saved '+n);
 writeFileSync(join(path+'.snapshots','retention-archived.json'),'{}');
 const storage=createSnapshotStorage(path,{deferWrites:true});await storage.readText();
 const originalRead=fsPromises.readFile;let release,signal;
 const captured=new Promise(resolve=>{signal=resolve;}),resume=new Promise(resolve=>{release=resolve;});
 fsPromises.readFile=async(...args)=>{const body=await originalRead(...args);if(args[0]===join(path+'.snapshots','commits.jsonl')){signal();await resume;}return body;};
 syncBuiltinESMExports();
 try {
  const pruning=storage.prune();await captured;
  await storage.writeText('saved during retention');storage.flushSync();release();await pruning;
  assert.equal(await createSnapshotStorage(path).readText(),'saved during retention');
 } finally {release();fsPromises.readFile=originalRead;syncBuiltinESMExports();}
});

test('offline replacement and reload invalidate a retention pass that already read the old journal',async t=>{
 const path=fresh(t),seed=createSnapshotStorage(path,{retention:false});
 for(let n=0;n<60;n++)await seed.writeText('old saved '+n);
 const root=path+'.snapshots',journal=join(root,'commits.jsonl');
 writeFileSync(join(root,'retention-archived.json'),'{}');
 const replacement=fresh(t),imported=await createSnapshotStorage(replacement,{retention:false}).writeText('imported offline value');
 const storage=createSnapshotStorage(path,{deferWrites:true});await storage.readText();
 const originalRead=fsPromises.readFile;let release,signal;
 const captured=new Promise(resolve=>{signal=resolve;}),resume=new Promise(resolve=>{release=resolve;});
 fsPromises.readFile=async(...args)=>{const body=await originalRead(...args);if(args[0]===journal){signal();await resume;}return body;};
 syncBuiltinESMExports();
 try {
  const pruning=storage.prune();await captured;
  copyFileSync(join(replacement+'.snapshots',imported.version),join(root,imported.version));
  writeFileSync(journal,readFileSync(join(replacement+'.snapshots','commits.jsonl')));
  storage.reload();release();await pruning;
  assert.equal(await createSnapshotStorage(path).readText(),'imported offline value');
 } finally {release();fsPromises.readFile=originalRead;syncBuiltinESMExports();}
});

test('drain waits for queued default writes without publishing deferred pending content',async t=>{
 const path=fresh(t),storage=createSnapshotStorage(path);
 const first=storage.writeText('default first'),second=storage.writeText('default latest');
 await storage.drain();await Promise.all([first,second]);
 assert.equal(await createSnapshotStorage(path).readText(),'default latest');
 const journal=join(path+'.snapshots','commits.jsonl'),before=readFileSync(journal,'utf8');
 assert.equal(parseCommits(before).commits.length,2);
 await storage.writeText('default latest');await storage.drain();await storage.flush();storage.flushSync();
 assert.equal(readFileSync(journal,'utf8'),before);
 const deferredPath=fresh(t),deferred=createSnapshotStorage(deferredPath,{deferWrites:true});
 await deferred.writeText('accepted only in memory');await deferred.drain();
 assert.equal(await deferred.readText(),'accepted only in memory');assert.ok(!existsSync(deferredPath+'.snapshots'));
});
