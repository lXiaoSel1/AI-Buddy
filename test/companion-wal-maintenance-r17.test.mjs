import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {createCompanionWalMaintenance} from '../src/companion-wal-maintenance.mjs';

test('independent companion WAL maintenance preserves pinned reads, coalesces flushes and truncates on the final close',async t=>{
 const base=resolve(tmpdir()),root=await mkdtemp(join(base,'companion-wal-maintenance-'));
 assert.equal(dirname(root),base);
 const path=join(root,'companion.sqlite'),writer=new DatabaseSync(path);
 let reader,first,second;
 t.after(async()=>{
  reader?.close();
  await first?.close();
  await second?.close();
  writer.close();
  await rm(root,{recursive:true,force:true});
 });
 writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(id INTEGER PRIMARY KEY, body BLOB); PRAGMA wal_checkpoint(TRUNCATE);');
 reader=new DatabaseSync(path,{readOnly:true});
 reader.exec('BEGIN');
 assert.equal(reader.prepare('SELECT COUNT(*) AS total FROM notes').get().total,0);
 const insert=writer.prepare('INSERT INTO notes VALUES(?,zeroblob(32768))');
 for(let n=1;n<=128;n++)insert.run(n);
 const lastWrite=new BigInt64Array(new SharedArrayBuffer(16));
 Atomics.store(lastWrite,0,BigInt(Date.now()-2500));
 Atomics.store(lastWrite,1,128n);
 const audits=[],options={lastWrite,audit:event=>audits.push(event),intervalMs:15};
 first=createCompanionWalMaintenance(path,options);
 second=createCompanionWalMaintenance(path,options);
 const [held,shared]=await Promise.all([first.flush(),second.flush()]);
 assert.deepEqual(held,shared);
 assert.equal(audits.filter(event=>event.reason==='flush').length,1);
 assert.equal(held.status,'busy');
 assert.ok(held.log>1000&&held.checkpointed<held.log);
 assert.equal(held.commits,128);
 assert.equal(reader.prepare('SELECT COUNT(*) AS total FROM notes').get().total,0);
 reader.close();reader=null;
 await first.close({truncate:true});

 second.schedule();
 const deadline=performance.now()+5000;
 while(!audits.some(event=>event.reason==='scheduled'&&event.status==='checkpointed')&&performance.now()<deadline)await wait(20);
 const scheduled=audits.find(event=>event.reason==='scheduled'&&event.status==='checkpointed');
 assert.ok(scheduled,JSON.stringify(audits));
 assert.equal(scheduled.log,held.log);
 assert.equal(scheduled.checkpointed,held.log);
 assert.equal(scheduled.commits,128);
 assert.match(scheduled.walGeneration,/^[a-f0-9]{16}$/);
 insert.run(129);
 Atomics.add(lastWrite,1,1n);
 const closed=await second.close({truncate:true});
 assert.equal(closed.status,'truncated');
 assert.equal(closed.log,0);
 assert.equal(closed.checkpointed,0);
 assert.equal(writer.prepare('SELECT COUNT(*) AS total FROM notes').get().total,129);
 t.diagnostic(JSON.stringify({held,scheduled,closed}));
});


async function openRestoreWal(t){
 const base=resolve(tmpdir()),root=await mkdtemp(join(base,'companion-wal-restore-retry-'));
 assert.equal(dirname(root),base);
 const path=join(root,'companion.sqlite'),writer=new DatabaseSync(path);
 let reader,maintenance;
 t.after(async()=>{
  reader?.close();
  await maintenance?.close();
  writer.close();
  await rm(root,{recursive:true,force:true});
 });
 writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(id INTEGER PRIMARY KEY, body BLOB); PRAGMA wal_checkpoint(TRUNCATE);');
 reader=new DatabaseSync(path,{readOnly:true});
 reader.exec('BEGIN');
 assert.equal(reader.prepare('SELECT COUNT(*) AS total FROM notes').get().total,0);
 const insert=writer.prepare('INSERT INTO notes VALUES(?,zeroblob(32768))');
 for(let id=1;id<=180;id++)insert.run(id);
 const lastWrite=new BigInt64Array(new SharedArrayBuffer(16)),audits=[];
 const wroteAt=Date.now();
 Atomics.store(lastWrite,0,BigInt(wroteAt));
 Atomics.store(lastWrite,1,180n);
 maintenance=createCompanionWalMaintenance(path,{lastWrite,audit:event=>audits.push(event),intervalMs:20});
 return {
  maintenance,audits,wroteAt,
  releaseReader(){reader.close();reader=null;},
  writeOneMore(){
   insert.run(181);
   Atomics.store(lastWrite,0,BigInt(Date.now()));
   Atomics.add(lastWrite,1,1n);
  }
 };
}

async function waitForAudit(find){
 const deadline=performance.now()+1000;
 while(!find()&&performance.now()<deadline)await wait(20);
 return find();
}

test('a busy restore checkpoint retries at the restore threshold while writes are recent',async t=>{
 const {maintenance,audits,wroteAt,releaseReader}=await openRestoreWal(t);
 maintenance.schedule();
 const held=await maintenance.flush('restore-stage');
 assert.equal(held.status,'busy');
 assert.ok(held.log-held.checkpointed>=1500&&held.log<4000,JSON.stringify(held));
 releaseReader();

 const retried=await waitForAudit(()=>audits.find(event=>event.reason==='restore-stage'&&event.status==='checkpointed'));
 assert.ok(retried,JSON.stringify(audits));
 assert.equal(retried.checkpointed,held.log);
 assert.equal(retried.commits,held.commits);
 assert.equal(retried.walGeneration,held.walGeneration);
 assert.ok(retried.startedAt-wroteAt<2000,JSON.stringify(retried));
 t.diagnostic(JSON.stringify({held,retried}));
});


test('restore checkpoint retries stop at five until another commit is recorded',async t=>{
 const {maintenance,audits,releaseReader,writeOneMore}=await openRestoreWal(t);
 maintenance.schedule();
 assert.equal((await maintenance.flush('restore-finish')).status,'busy');
 const busyCount=()=>audits.filter(event=>event.reason==='restore-finish'&&event.status==='busy').length;
 assert.ok(await waitForAudit(()=>busyCount()>=6),JSON.stringify(audits));
 await wait(100);
 assert.equal(busyCount(),6,'the initial checkpoint and five retries exhaust this commit');

 writeOneMore();
 assert.equal((await maintenance.flush('restore-finish')).status,'busy');
 releaseReader();
 const retried=await waitForAudit(()=>audits.find(event=>event.reason==='restore-finish'&&event.status==='checkpointed'));
 assert.ok(retried,JSON.stringify(audits));
 assert.equal(retried.commits,181);
 assert.equal(retried.checkpointed,retried.log);
});
