import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createCompanionCacheStore,createCompanionNativeStore,NATIVE_WRITE_QUEUED} from '../src/companion-cache-store.mjs';

const filename='companion-cache-r1.sqlite';
const scope=key=>({key,conversationId:key,characterId:'synthetic-character'});
const record=(sessionUuid,id='synthetic-message')=>({
 sessionUuid,instructionsHash:'a'.repeat(64),parent:null,
 entries:[{anchor:{id,hash:'b'.repeat(64)},message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'synthetic text'}]}}],
});

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'companion-cache-r4-'));
 const stores=[];
 const keep=store=>{stores.push(store);return store;};
 t.after(async()=>{
  await Promise.all(stores.map(store=>store.close()));
  await rm(root,{recursive:true,force:true});
 });
 return {
  root,file:join(root,filename),
  api:(audit,options)=>keep(createCompanionCacheStore(root,audit,options)),
  native:audit=>keep(createCompanionNativeStore(root,audit)),
 };
}

test('R6 Q3 an acknowledged removal scrubs the old WAL value before a same-turn replacement',async t=>{
 const f=await fixture(t),first=f.native(),second=f.native();
 const key='thread:retirement-barrier',old={marker:randomUUID().repeat(32)},latest={revision:2};
 assert.equal(await first.write(key,old),true);
 assert.ok((await readFile(f.file+'-wal')).includes(Buffer.from(old.marker)));
 const removal=first.remove(key);
 assert.equal(await second.write(key,latest,{deferBusy:true}),NATIVE_WRITE_QUEUED);
 assert.deepEqual(await second.read(key),latest);
 assert.equal(await removal,true);
 const wal=await readFile(f.file+'-wal');
 assert.equal(wal.includes(Buffer.from(old.marker)),false,'acknowledged removal left old bytes in SQLite WAL');
 const disk=new DatabaseSync(f.file,{readOnly:true});
 try{
  const row=disk.prepare('SELECT payload FROM native_state WHERE key=?').get(key);
  assert.deepEqual(JSON.parse(row.payload),latest);
 }finally{disk.close();}
});

test('runtime corruption is retained and rebuilt with API and two native facades still open',async t=>{
 const f=await fixture(t);
 const audit=[];
 const api=f.api(event=>audit.push(event)),native=f.native(),calibration=f.native();
 await api.ready();
 assert.equal(await native.write('thread:synthetic',{state:'confirmed'}),true);
 assert.deepEqual(await calibration.read('thread:synthetic'),{state:'confirmed'});
 const external=new DatabaseSync(f.file);
 try{
  external.enableDefensive(false);
  const {schema_version:version}=external.prepare('PRAGMA schema_version').get();
  external.exec("PRAGMA writable_schema=ON; UPDATE sqlite_schema SET rootpage=900000 WHERE name='native_state'; PRAGMA schema_version="+(version+1));
 }finally{external.close();}
 assert.deepEqual(await calibration.read('thread:synthetic'),{state:'confirmed'});
 assert.equal((await readdir(f.root)).filter(name=>name.startsWith(filename+'.corrupt-')&&!/-(wal|shm|journal)$/.test(name)).length,1);
 assert.ok(audit.some(event=>event.type==='companion-cache-corrupt-database'));
 assert.equal(await native.write('calibration:synthetic',{ratio:1.25}),true);
 assert.deepEqual(await calibration.read('calibration:synthetic'),{ratio:1.25});
 api.write(scope('fresh'),null,record('fresh session'));
 assert.equal(await api.flush(),true);
 await api.close();
 assert.equal(await native.remove('thread:synthetic'),true);
 await native.close();
 assert.equal(await calibration.read('thread:synthetic'),null);
 const reopened=f.api();
 await reopened.ready();
 assert.equal(reopened.read('fresh')?.sessionUuid,'fresh session');
});

test('closing a facade leaves siblings available and stale API revisions cannot overwrite a winner',async t=>{
 const f=await fixture(t),first=f.api(),second=f.api(),native=f.native();
 await first.ready();
 first.write(scope('shared'),null,record('initial session'));
 assert.equal(await first.flush(),true);
 await second.ready();
 first.write(scope('shared'),1,record('winner session'));
 second.write(scope('shared'),1,record('stale session'));
 assert.equal(await first.flush(),true);
 assert.equal(await second.flush(),false);
 await first.close();
 assert.equal(await native.write('calibration:synthetic',{ratio:1.25}),true);
 const third=f.api();
 await third.ready();
 assert.equal(third.read('shared')?.sessionUuid,'winner session');
});

test('clear and recreate fences a sibling snapshot with the same numeric revision',async t=>{
 const f=await fixture(t),owner=f.api(),stale=f.api();
 await owner.ready();
 owner.write(scope('shared'),null,record('old session'));
 assert.equal(await owner.flush(),true);
 await stale.ready();
 stale.write(scope('shared'),1,record('stale dirty session'));
 assert.equal(await owner.clearConversation('shared'),true);
 assert.equal(owner.write(scope('shared'),null,record('new session')),1);
 assert.equal(await owner.flush(),true);
 assert.equal(await stale.flush(),false);
 const reopened=f.api();
 await reopened.ready();
 assert.equal(reopened.read('shared')?.sessionUuid,'new session');
});

test('half-open retry preserves the newest dirty row and applies circuit-open privacy operations first',async t=>{
 const f=await fixture(t),events=[],nativeEvents=[];
 const api=f.api(event=>events.push(event),{retryMs:100}),native=f.native(event=>nativeEvents.push(event));
 await api.ready();
 await native.list();
 api.write(scope('removed'),null,record('private removed session'));
 api.write(scope('edited'),null,record('private edited session','before-edit'));
 assert.equal(await api.flush(),true);
 const locker=new DatabaseSync(f.file);
 locker.exec('BEGIN IMMEDIATE');
 try{
  api.write(scope('dirty'),null,record('old draft'));
  for(let attempt=0;attempt<3;attempt++)assert.equal(await api.flush('dirty'),false);
  assert.equal(api.isDurable(),false);
  assert.equal(api.write(scope('dirty'),1,record('new session')),2);
  assert.equal(await api.clearConversation('removed'),false);
  assert.equal(await api.invalidateMessages([{ownerId:'edited',id:'before-edit'}]),false);
  assert.equal(api.read('removed'),null);
  assert.deepEqual(api.read('edited')?.entries,[]);
 }finally{locker.close();}
 await delay(125);
 assert.equal(await native.write('calibration:synthetic',{ratio:1.25}),true);
 assert.equal(api.isDurable(),true);
 assert.equal(await api.flush(),true);
 assert.equal(events.filter(event=>event.type==='companion-cache-durability-restored').length,1);
 assert.equal(nativeEvents.filter(event=>event.type==='companion-cache-durability-restored').length,1);
 const reopened=f.api();
 await reopened.ready();
 assert.equal(reopened.read('dirty')?.sessionUuid,'new session');
 assert.equal(reopened.read('removed'),null);
 assert.deepEqual(reopened.read('edited')?.entries,[]);
});

test('N3 corrupt read recovery never republishes a pending privacy deletion',async t=>{
 const f=await fixture(t),api=f.api(),native=f.native();
 await api.ready();
 api.write(scope('private-delete'),null,record('older private row'));
 assert.equal(await api.flush(),true);
 assert.equal(await native.write('record',{recovered:true}),true);
 const locker=new DatabaseSync(f.file);
 locker.exec('BEGIN IMMEDIATE');
 try{assert.equal(await api.clearConversation('private-delete'),false);}
 finally{locker.close();}
 const external=new DatabaseSync(f.file);
 try{
  external.enableDefensive(false);
  const {schema_version:version}=external.prepare('PRAGMA schema_version').get();
  external.exec("PRAGMA writable_schema=ON; UPDATE sqlite_schema SET rootpage=900000 WHERE name='native_state'; PRAGMA schema_version="+(version+1));
 }finally{external.close();}
 assert.deepEqual(await native.read('record'),{recovered:true});
 const reader=new DatabaseSync(f.file,{readOnly:true});
 try{assert.equal(reader.prepare('SELECT count(*) AS count FROM api_windows').get().count,0);}
 finally{reader.close();}
});

test('N3 a replacement worker preserves native rows held by the live host',async t=>{
 const f=await fixture(t),native=f.native(),sibling=f.native();
 let owned;
 const post=Worker.prototype.postMessage;
 t.mock.method(Worker.prototype,'postMessage',function(...args){owned=this;return post.apply(this,args);});
 assert.equal(await native.write('known',{generation:1}),true);
 assert.deepEqual(await sibling.list(),[{key:'known',value:{generation:1}}]);
 await owned.terminate();
 assert.deepEqual(await sibling.read('known'),{generation:1});
 assert.deepEqual(await native.list(),[{key:'known',value:{generation:1}}]);
 assert.equal(await native.write('new',{generation:2}),true);
 assert.deepEqual(await sibling.read('known'),{generation:1});
 await owned.terminate();
 const external=new DatabaseSync(f.file);
 try{external.prepare('DELETE FROM native_state WHERE key=?').run('known');}
 finally{external.close();}
 assert.equal(await native.write('healthy',{generation:3}),true);
 assert.equal(await sibling.read('known'),null,'a healthy database remains authoritative after replacement');
});

test('N3 closing the last lease tries one bounded replay before the write cooldown expires',async t=>{
 const f=await fixture(t),api=f.api(),native=f.native();
 await api.ready();
 assert.equal(await native.write('retired-note',{revision:0}),true);
 const locker=new DatabaseSync(f.file);
 locker.exec('BEGIN IMMEDIATE');
 try{
  for(let revision=1;revision<=3;revision++)await native.write('retired-note',{revision});
  assert.equal(api.isDurable(),false);
 }finally{locker.close();}
 await native.close();
 await api.close();
 const reader=new DatabaseSync(f.file,{readOnly:true});
 try{
  const {payload}=reader.prepare('SELECT payload FROM native_state WHERE key=?').get('retired-note');
  assert.equal(JSON.parse(payload).revision,3);
 }finally{reader.close();}
});

test('N3 the first corrupt write after worker loss rebuilds live native rows and keeps tombstones',async t=>{
 const f=await fixture(t),native=f.native(),sibling=f.native();
 let owned;
 const post=Worker.prototype.postMessage;
 t.mock.method(Worker.prototype,'postMessage',function(...args){owned=this;return post.apply(this,args);});
 await native.write('kept',{generation:1});
 await native.write('removed',{generation:1});
 await owned.terminate();
 const external=new DatabaseSync(f.file);
 external.exec('BEGIN IMMEDIATE');
 try{assert.equal(await sibling.remove('removed'),false);}
 finally{external.exec('ROLLBACK');}
 await owned.terminate();
 try{
  external.enableDefensive(false);
  const {schema_version:version}=external.prepare('PRAGMA schema_version').get();
  external.exec("PRAGMA writable_schema=ON; UPDATE sqlite_schema SET rootpage=900000 WHERE name='native_state'; PRAGMA schema_version="+(version+1));
 }finally{external.close();}
 assert.equal(await sibling.write('new',{generation:2}),true);
 assert.deepEqual(await native.list(),[{key:'kept',value:{generation:1}},{key:'new',value:{generation:2}}]);
 await Promise.all([native.close(),sibling.close()]);
 assert.deepEqual(await f.native().list(),[{key:'kept',value:{generation:1}},{key:'new',value:{generation:2}}]);
});

test('N3 late registration of a stale facade cannot expose or replay a privacy-deleted window',async t=>{
 const f=await fixture(t),owner=f.api(),stale=f.api(),native=f.native();
 const keys=['edit-late','clear-late','unrelated'];
 await owner.ready();
 for(const key of keys)owner.write(scope(key),null,record('persisted',key));
 assert.equal(await owner.flush(),true);
 await stale.ready();
 const locker=new DatabaseSync(f.file);
 locker.exec('BEGIN IMMEDIATE');
 let reopened;
 try{
  for(let attempt=0;attempt<3;attempt++)await native.write('busy',{attempt});
  assert.equal(owner.isDurable(),false);
  for(const key of keys)assert.equal(stale.write(scope(key),1,record('new draft',key)),2);
  assert.equal(await owner.invalidateMessages([{ownerId:'edit-late',id:'edit-late'}]),false);
  assert.equal(await owner.clearConversation('clear-late'),false);
  await stale.close();
  reopened=f.api();
  await reopened.ready();
  assert.equal(reopened.read('edit-late')?.entries.length,0);
  assert.equal(reopened.read('clear-late'),null);
  const editedRevision=reopened.read('edit-late').revision;
  assert.equal(reopened.write(scope('edit-late'),editedRevision,record('later draft','edit-late')),editedRevision+1);
  assert.equal(reopened.read('edit-late').entries.length,0);
  assert.equal(reopened.write(scope('clear-late'),null,record('later draft','clear-late')),null);
  assert.equal(reopened.read('unrelated')?.sessionUuid,'new draft');
  assert.equal(reopened.write(scope('unrelated'),2,record('continued legitimate row','unrelated')),3);
 }finally{locker.close();}
 await Promise.all([native.close(),owner.close(),reopened.close()]);
 const verified=f.api();
 await verified.ready();
 assert.equal(verified.read('edit-late')?.entries.length,0);
 assert.equal(verified.read('clear-late'),null);
 assert.equal(verified.read('unrelated')?.sessionUuid,'continued legitimate row');
});

test('N3 privacy changes between a local flush and shared registration win over the captured batch',async t=>{
 const f=await fixture(t),editOwner=f.api(),clearOwner=f.api(),stale=f.api(),native=f.native();
 const keys=['edit-race','clear-race','reverse','unrelated'];
 await editOwner.ready();
 for(const key of keys)editOwner.write(scope(key),null,record('persisted',key));
 assert.equal(await editOwner.flush(),true);
 await Promise.all([clearOwner.ready(),stale.ready()]);
 const locker=new DatabaseSync(f.file);
 locker.exec('BEGIN IMMEDIATE');
 let reopened,release;
 try{
  for(let attempt=0;attempt<3;attempt++)await native.write('busy',{attempt});
  assert.equal(editOwner.isDurable(),false);
  for(const key of keys)assert.equal(stale.write(scope(key),1,record('new draft',key)),2);
  assert.equal(await stale.flush('reverse'),false);
  assert.equal(await clearOwner.clearConversation('reverse'),false);

  const paused=Promise.withResolvers(),post=Worker.prototype.postMessage;
  t.mock.method(Worker.prototype,'postMessage',function(message,...args){
   if(message.op==='nativeList'&&!release){
    release=()=>post.call(this,message,...args);
    paused.resolve();
    return;
   }
   return post.call(this,message,...args);
  });
  const read=native.list();
  await paused.promise;
  const closing=stale.close();
  await new Promise(setImmediate);
  const invalidated=editOwner.invalidateMessages([{ownerId:'edit-race',id:'edit-race'}]);
  const cleared=clearOwner.clearConversation('clear-race');
  await new Promise(setImmediate);
  const projectedEdit=stale.read('edit-race')?.entries.length,projectedClear=stale.read('clear-race');
  release();
  await Promise.all([closing,read]);
  assert.deepEqual(await Promise.all([invalidated,cleared]),[false,false]);
  assert.equal(projectedEdit,0);
  assert.equal(projectedClear,null);
  reopened=f.api();
  await reopened.ready();
  assert.equal(reopened.read('edit-race')?.entries.length,0);
  assert.equal(reopened.read('edit-race')?.sessionUuid,'new draft');
  assert.equal(reopened.read('clear-race'),null);
  assert.equal(reopened.read('reverse'),null);
  assert.equal(reopened.read('unrelated')?.sessionUuid,'new draft');
 }finally{locker.close();}
 await Promise.all([native.close(),editOwner.close(),clearOwner.close(),reopened.close()]);
 const verified=f.api();
 await verified.ready();
 assert.equal(verified.read('edit-race')?.entries.length,0);
 assert.equal(verified.read('edit-race')?.sessionUuid,'new draft');
 assert.equal(verified.read('clear-race'),null);
 assert.equal(verified.read('reverse'),null);
 assert.equal(verified.read('unrelated')?.sessionUuid,'new draft');
});

for(const readFirst of [true,false])test(`N3 a closed API facade keeps its dirty successor through worker replacement (${readFirst?'read':'replay'} first)`,async t=>{
 const f=await fixture(t),api=f.api(),native=f.native();
 let owned;
 const post=Worker.prototype.postMessage;
 t.mock.method(Worker.prototype,'postMessage',function(...args){owned=this;return post.apply(this,args);});
 await api.ready();
 api.write(scope('closed'),null,record('older session'));
 assert.equal(await api.flush(),true);
 await native.list();
 const locker=new DatabaseSync(f.file);
 locker.exec('BEGIN IMMEDIATE');
 try{
  assert.equal(api.write(scope('closed'),1,record('closed pending successor')),2);
  await api.close();
 }finally{locker.close();}
 await owned.terminate();
 if(readFirst){
  const reopened=f.api();
  await reopened.ready();
  assert.equal(reopened.read('closed')?.sessionUuid,'closed pending successor');
 }
 assert.equal(await native.write('recovery',{generation:2}),true);
 const verified=f.api();
 await verified.ready();
 assert.equal(verified.read('closed')?.revision,2);
 assert.equal(verified.read('closed')?.sessionUuid,'closed pending successor');
});
