import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCompanionCacheStore} from '../src/companion-cache-store.mjs';

const hash='a'.repeat(64);
const record=(sessionUuid='synthetic-session',id='shared-message')=>({
 sessionUuid,instructionsHash:hash,parent:null,
 entries:[{anchor:{id,hash},message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'synthetic text'}]}}],
});
const scope=(key,conversationId=key,personaId='persona',lifeId='life')=>({key,conversationId,characterId:'character',personaId,lifeId});
const filename='companion-cache-r1.sqlite';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'companion-cache-r2-'));
 const audit=[];
 const stores=[];
 t.after(async()=>{
  for(const store of stores)await store.close();
  rmSync(root,{recursive:true,force:true});
 });
 return {
  root,file:join(root,filename),audit,
  open(){const store=createCompanionCacheStore(root,event=>audit.push(event));stores.push(store);return store;},
 };
}

function legacyRows(file,rows){
 const db=new DatabaseSync(file);
 try{
  db.exec('CREATE TABLE api_windows (scope_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL)');
  const insert=db.prepare('INSERT INTO api_windows VALUES (?,?,?,?,?)');
  for(const [key,conversationId,value] of rows)insert.run(key,conversationId,'character',1,typeof value==='string'?value:JSON.stringify({...value,version:1}));
 }finally{db.close();}
}

test('a malformed disk row is isolated while a good legacy row remains reusable',async t=>{
 const f=fixture(t);
 legacyRows(f.file,[['bad','bad','{}'],['good','good',record()]]);
 const store=f.open();
 await store.ready?.();
 assert.equal(store.read('bad'),null);
 assert.equal(store.read('good')?.sessionUuid,'synthetic-session');
 assert.equal(f.audit.filter(event=>event.type==='companion-cache-bad-row').length,1);
 await store.close();
 const reopened=f.open();
 await reopened.ready();
 assert.equal(reopened.read('good')?.sessionUuid,'synthetic-session');
 assert.equal(f.audit.filter(event=>event.type==='companion-cache-bad-row').length,1);
});

test('a damaged SQLite database is preserved and new windows survive restart',async t=>{
 const f=fixture(t);
 const damaged='synthetic damaged sidecar';
 writeFileSync(f.file,damaged);
 const store=f.open();
 await store.ready?.();
 assert.equal(store.read('new'),null);
 assert.equal(store.write(scope('new'),null,record()),1);
 await store.flush?.('new');
 await store.close();
 const evidence=readdirSync(f.root).find(name=>name.startsWith(filename+'.corrupt-'));
 assert.ok(evidence,'damaged database must remain as evidence');
 assert.equal(readFileSync(join(f.root,evidence),'utf8'),damaged);
 const reopened=f.open();
 await reopened.ready();
 assert.equal(reopened.read('new')?.revision,1);
});

test('SQLite contention leaves the host responsive, gives up finitely and can recover',async t=>{
 const f=fixture(t);
 const store=f.open();
 await store.ready?.();
 store.write(scope('good'),null,record('good'));
 await store.flush?.('good');
 const locker=new DatabaseSync(f.file);
 locker.exec('BEGIN IMMEDIATE');
 try{
  let ticked=false;
  setTimeout(()=>{ticked=true;},20);
  const revision=store.write(scope('busy'),null,record('busy'));
  const flushed=store.flush?.('busy');
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(ticked,true);
  assert.equal(revision,1);
  assert.equal(f.audit.some(event=>event.type==='companion-cache-memory-fallback'),false);
  assert.equal(await flushed,false);
  assert.equal(store.read('good')?.sessionUuid,'good');
 }finally{
  locker.exec('ROLLBACK');
  locker.close();
 }
 assert.equal(store.write(scope('busy'),1,record('recovered')),2);
 assert.equal(await store.flush('busy'),true);
 await store.close();
 const reopened=f.open();
 await reopened.ready();
 assert.equal(reopened.read('good')?.sessionUuid,'good');
 assert.equal(reopened.read('busy')?.sessionUuid,'recovered');
});

test('message invalidation before hydration scopes duplicate message IDs to their owner',async t=>{
 const f=fixture(t);
 legacyRows(f.file,[['one','thread-one',record()],['two','thread-two',record()]]);
 const store=f.open();
 const invalidated=store.invalidateMessages([{ownerId:'thread-one',id:'shared-message'}]);
 await store.ready?.();
 await invalidated;
 assert.equal(store.read('one')?.entries.length,0);
 assert.equal(store.read('two')?.entries.length,1);
 await store.close();
 const reopened=f.open();
 await reopened.ready();
 assert.equal(reopened.read('one')?.entries.length,0);
 assert.equal(reopened.read('two')?.entries.length,1);
});

test('privacy deletion removes only matching legacy and current scopes before restart',async t=>{
 const f=fixture(t);
 legacyRows(f.file,[['legacy-deleted','deleted-thread',record()],['legacy-keep','other-thread',record()]]);
 const store=f.open();
 const deleted=store.clearPersona?.('deleted-persona',['deleted-thread']);
 await store.ready?.();
 await deleted;
 store.write(scope('known-deleted','known-deleted','deleted-persona'),null,record());
 store.write(scope('keep','keep','other-persona'),null,record());
 await store.clearPersona?.('deleted-persona',['deleted-thread']);
 await store.flush?.();
 await store.close();
 const reopened=f.open();
 await reopened.ready?.();
 assert.equal(reopened.read('legacy-deleted'),null);
 assert.equal(reopened.read('known-deleted'),null);
 assert.equal(reopened.read('legacy-keep')?.revision,1);
 assert.equal(reopened.read('keep')?.revision,1);
});
