import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {openCompanionDatabase,readCompanionSqliteSnapshot} from '../src/companion-sqlite.mjs';
import {exportCompanionForRollback,inspectCompanionDataRoot,interruptImportedCompanion,makeCard,openCompanionStore} from '../src/companion-store.mjs';
import {assertR95CompanionCompatible} from '../src/r95-data-compatibility.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';

const character='sections-character',persona='default',conversation='sections-conversation';
const sectionNames=['cards','conversations','lives'];
const previousWriter='r14-companion-sqlite-v2',previousCapability='companion-message-rows-v2';
const nextWriter='r16-companion-sqlite-v3',nextCapability='companion-state-sections-v3';
const at=Date.parse('2026-10-20T12:00:00Z');

function readDatabase(path,read){
 const db=new DatabaseSync(path,{readOnly:true});
 try{return read(db);}finally{db.close();}
}

function sqliteFence(db){
 const version=db.prepare('PRAGMA user_version').get().user_version;
 const get=db.prepare('SELECT value FROM meta WHERE key=?');
 return {version,writer:get.get('minimumWriter').value,capabilities:JSON.parse(get.get('requiredCapabilities').value)};
}

async function physicalV2(t,{amend=()=>{},withHistory=true}={}){
 const root=await mkdtemp(join(tmpdir(),'buddy-r16-state-sections-'));
 const path=join(root,'galgame','companion.sqlite'),fencePath=join(root,'galgame','companion.json');
 let live;
 const reopen=async()=>live=await openCompanionStore(root);
 t.after(async()=>{await live?.close();await rm(root,{recursive:true,force:true});});
 const seed=await reopen();
 const life={id:'sections-life',operationId:'sections-operation',mode:'normal',startedAt:at-1000,r95:{schemaVersion:1},unknownLife:{value:null}};
 const first={id:'duplicate',role:'user',text:'Synthetic first original',createdAt:at,status:'sent',revision:0};
 const second={...first,text:'Synthetic second original',createdAt:at+2000};
 if(withHistory)await seed.mutate((state,tx)=>{
  state.activeCharacterId=character;
  state.activeConversationId=conversation;
  state.cards[character]={...makeCard({id:character,name:'Synthetic sections card'}),unknownCard:[null,{flag:true}]};
  state.lives??={};
  state.lives[character]=life;
  state.conversations[conversation]={id:conversation,characterId:character,personaId:persona,lifeId:life.id,title:'Synthetic sections',unknownConversation:{value:null}};
  state.unknownRoot={cards:'nested names are ordinary data',conversations:null,lives:[1,null]};
  state.unrelatedNull=null;
  tx.messages.define('private',conversation,['conversations',conversation]);
  tx.messages.append('private',conversation,first,{preserveDuplicate:true});
  tx.messages.append('private',conversation,second,{preserveDuplicate:true});
  tx.records.put('life.r95.lines',character,'annotation',{
   messageId:'annotation',mode:'reminder',status:'read',text:'Unique synthetic annotation',at:at+1000,
   scope:{characterId:character,personaId:persona,lifeId:life.id,operationId:life.operationId,channel:'app-private',conversationId:conversation}
  },{array:true,at:['lives',character,'r95','lines']});
 });
 await seed.mutate(state=>{state.unrelatedReceipt=true;});
 const expected=seed.snapshot(),sourceRevision=seed.memorySourceRevision;
 const occurrences=withHistory?seed.messages.recent('private',conversation,2,{occurrences:true}).map(row=>row.occurrenceId):[];
 const fenceBytes=await readFile(fencePath);
 assert.ok(expected.revision>sourceRevision,'fixture keeps global and source epochs distinct');
 await seed.close();
 live=undefined;

 // Only the v3 metadata shape changes. Rebuild the old writer's single JSON
 // row from the logical projection while preserving all shared tables and IDs.
 const {revision,...body}=expected;
 amend(body);
 const db=new DatabaseSync(path);
 try{
  db.exec('BEGIN IMMEDIATE');
  db.exec('DROP TABLE IF EXISTS state_sections; PRAGMA user_version=2;');
  db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(body));
  const meta=db.prepare('UPDATE meta SET value=? WHERE key=?');
  meta.run(previousWriter,'minimumWriter');
  meta.run(JSON.stringify([previousCapability]),'requiredCapabilities');
  db.exec('COMMIT');
  assert.deepEqual(sqliteFence(db),{version:2,writer:previousWriter,capabilities:[previousCapability]});
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get().value),body);
 }finally{db.close();}
 return {root,path,fencePath,fenceBytes,reopen,expected:{...body,revision},sourceRevision,occurrences,first,second};
}

test('v2 upgrade preserves worker history, duplicate occurrences, revisions and the legacy rollback document',async t=>{
 const f=await physicalV2(t);
 const initialFence=await createSnapshotStorage(f.fencePath,{protectExisting:true}).readText();
 const censusBefore=await inspectCompanionDataRoot(f.root);
 const v2=readDatabase(f.path,sqliteFence);
 assert.equal(v2.version,2,'read-only inspection must not migrate the input');

 const store=await f.reopen();
 assert.deepEqual(store.snapshot(),f.expected);
 assert.equal(store.memorySourceRevision,f.sourceRevision);
 assert.deepEqual(await readFile(f.fencePath),f.fenceBytes);
 assert.equal(await createSnapshotStorage(f.fencePath,{protectExisting:true}).readText(),initialFence);
 const snapshot=await store.snapshotAsync();
 assert.deepEqual(snapshot.unknownRoot,f.expected.unknownRoot);
 assert.deepEqual(snapshot.cards[character].unknownCard,f.expected.cards[character].unknownCard);
 assert.deepEqual(snapshot.conversations[conversation].unknownConversation,f.expected.conversations[conversation].unknownConversation);
 assert.deepEqual(snapshot.lives[character].unknownLife,f.expected.lives[character].unknownLife);
 assert.deepEqual(snapshot.conversations[conversation].messages,[f.first,f.second]);
 const history=await store.messages.history('private',conversation);
 assert.deepEqual(history.messages.map(row=>row.id),['duplicate','speech:annotation','duplicate']);
 assert.deepEqual(history.messages.filter(row=>row.id==='duplicate').map(row=>row.occurrenceId),f.occurrences);
 assert.deepEqual(await store.messages.searchOwners('private','Unique synthetic annotation'),[conversation]);
 assert.deepEqual(await inspectCompanionDataRoot(f.root),censusBefore);

 assert.deepEqual(readDatabase(f.path,sqliteFence),{version:3,writer:nextWriter,capabilities:[previousCapability,nextCapability]});
 await store.close();
 const reopened=await f.reopen();
 assert.deepEqual(reopened.snapshot(),f.expected);
 assert.equal(reopened.memorySourceRevision,f.sourceRevision);
 await reopened.close();
 const receipt=await exportCompanionForRollback(f.root);
 const exported=JSON.parse(await readFile(receipt.exportPath,'utf8'));
 assertR95CompanionCompatible(exported);
 assert.equal(exported.revision,f.expected.revision);
 assert.deepEqual(exported.unknownRoot,f.expected.unknownRoot);
 assert.deepEqual(exported.cards[character].unknownCard,f.expected.cards[character].unknownCard);
 assert.deepEqual(exported.conversations[conversation].messages,[f.first,f.second]);
 assert.deepEqual(exported.lives[character].unknownLife,f.expected.lives[character].unknownLife);
 assert.equal(exported.lives[character].r95.lines[0].messageId,'annotation');
});

test('an aborted v2 physical migration leaves the old root, writer and section schema intact for retry',async t=>{
 const f=await physicalV2(t);
 const db=new DatabaseSync(f.path);
 try{db.exec(`
  CREATE TRIGGER reject_state_upgrade BEFORE UPDATE OF value ON state
  BEGIN SELECT RAISE(ABORT,'Injected state section migration outage'); END;
 `);}finally{db.close();}
 await assert.rejects(f.reopen(),/Injected state section migration outage/);
 assert.deepEqual(await readFile(f.fencePath),f.fenceBytes);
 readDatabase(f.path,db=>{
  assert.deepEqual(sqliteFence(db),{version:2,writer:previousWriter,capabilities:[previousCapability]});
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_sections'").get(),undefined);
  const {value,revision}=db.prepare('SELECT value,revision FROM state WHERE id=1').get();
  assert.deepEqual({...JSON.parse(value),revision},f.expected);
 });
 const repair=new DatabaseSync(f.path);
 try{repair.exec('DROP TRIGGER reject_state_upgrade');}finally{repair.close();}
 const store=await f.reopen();
 assert.deepEqual(store.snapshot(),f.expected);
 assert.equal(readDatabase(f.path,sqliteFence).version,3);
});

test('physical sections keep a logical null distinct from an absent legacy field',async t=>{
 const f=await physicalV2(t,{withHistory:false,amend(state){
  state.cards=null;
  delete state.lives;
 }});
 const store=await f.reopen();
 assert.deepEqual(store.snapshot(),f.expected);
 const snapshot=await store.snapshotAsync();
 assert.equal(snapshot.cards,null);
 assert.deepEqual(snapshot.conversations,{});
 assert.ok(!Object.hasOwn(snapshot,'lives'));
 readDatabase(f.path,db=>{
  const root=JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get().value);
  assert.ok(sectionNames.every(name=>!Object.hasOwn(root,name)));
  const sections=db.prepare('SELECT name,value FROM state_sections ORDER BY name').all().map(({name,value})=>({name,value}));
  assert.deepEqual(sections,[{name:'cards',value:'null'},{name:'conversations',value:'{}'},{name:'lives',value:null}]);
 });
 await store.close();
 const reopened=await f.reopen();
 assert.equal(reopened.state.cards,null);
 assert.ok(!Object.hasOwn(reopened.state,'lives'));
});

for(const corruption of ['missing section row','duplicate root field'])test('v3 fails closed on a '+corruption,async t=>{
 const f=await physicalV2(t);
 const store=await f.reopen();
 await store.close();
 const db=new DatabaseSync(f.path);
 try{
  if(corruption==='missing section row'){
   db.prepare("DELETE FROM state_sections WHERE name='lives'").run();
   db.exec('DROP INDEX app_lines_scope');
  }else db.prepare("UPDATE state SET value=json_set(value,'$.cards',json('{}')) WHERE id=1").run();
 }finally{db.close();}
 const before=await readFile(f.path);
 const opening=f.reopen();
 await assert.rejects(opening,/state|section/i);
 await assert.rejects(inspectCompanionDataRoot(f.root),/state|section/i);
 await assert.rejects(exportCompanionForRollback(f.root),/state|section/i);
 assert.deepEqual(await readFile(f.fencePath),f.fenceBytes);
 assert.deepEqual(await readFile(f.path),before);
});

test('a worker view and a pinned reader observe whole revisions across a multi-section commit',async t=>{
 const f=await physicalV2(t);
 const store=await f.reopen();
 const reader=new DatabaseSync(f.path,{readOnly:true});
 const root=()=>reader.prepare('SELECT revision,value FROM state WHERE id=1').get();
 const sections=()=>reader.prepare('SELECT name,value FROM state_sections ORDER BY name').all();
 const lines=()=>reader.prepare("SELECT count(*) n FROM messages WHERE owner_type='private' AND owner_id=?").get(conversation).n;
 try{
  reader.exec('BEGIN');
  const previous={root:root(),sections:sections(),lines:lines()};
  await store.mutate((state,tx)=>{
   state.unknownRoot.revisionMarker=1;
   state.cards[character].unknownCard.push('new card value');
   state.conversations[conversation].unknownConversation.value='new owner value';
   state.lives[character].unknownLife.value='new life value';
   tx.messages.append('private',conversation,{...f.first,id:'new-original',createdAt:at+3000});
  });
  assert.deepEqual({root:root(),sections:sections(),lines:lines()},previous);
  reader.exec('COMMIT');
  const snap=await store.snapshotAsync();
  assert.equal(snap.revision,f.expected.revision+1);
  assert.equal(snap.unknownRoot.revisionMarker,1);
  assert.equal(snap.cards[character].unknownCard.at(-1),'new card value');
  assert.equal(snap.conversations[conversation].unknownConversation.value,'new owner value');
  assert.equal(snap.lives[character].unknownLife.value,'new life value');
  assert.equal(snap.conversations[conversation].messages.at(-1).id,'new-original');
  assert.equal(store.memorySourceRevision,snap.revision);
 }finally{reader.close();}

 const protectedDb=new DatabaseSync(f.path);
 try{
  protectedDb.exec("CREATE TRIGGER protect_stable_sections BEFORE UPDATE ON state_sections BEGIN SELECT RAISE(ABORT,'Stable section rewritten'); END");
  await store.mutate(state=>{state.unrelatedReceipt='root-only';});
  const rootOnly=await store.snapshotAsync();
  assert.equal(rootOnly.revision,f.expected.revision+2);
  assert.equal(rootOnly.unrelatedReceipt,'root-only');
  assert.equal(store.memorySourceRevision,f.expected.revision+1);
 }finally{protectedDb.close();}
});

test('a stale global revision cannot write state sections, messages or the memory source epoch',async t=>{
 const f=await physicalV2(t);
 const store=await f.reopen();
 const writer=openCompanionDatabase(f.path);
 try{
  const before=writer.load();
  const next={...before,unrelatedReceipt:'won',revision:before.revision+1};
  writer.commit(writer.stage(),next,before.revision,true,false,'test-competing-commit');
  await assert.rejects(store.mutate((state,tx)=>{
   state.cards[character].unknownCard.push('stale-change');
   state.conversations[conversation].title='stale-change';
   state.lives[character].unknownLife.value='stale-change';
   tx.messages.append('private',conversation,{...f.first,id:'stale-message',createdAt:at+3000});
  }),/revision changed/i);
  const actual=readCompanionSqliteSnapshot(f.path);
  assert.deepEqual(actual.state,next);
  assert.equal(actual.meta.memorySourceRevision,f.sourceRevision);
  assert.equal(actual.rows.length,2);
  assert.deepEqual(store.state,f.expected);
 }finally{writer.close();}
});

test('a v2 import must validate the authoritative fence capabilities before upgrading the database',async t=>{
 const f=await physicalV2(t,{withHistory:false});
 const authority=createSnapshotStorage(f.fencePath,{protectExisting:true});
 const fence=JSON.parse(await authority.readText());
 fence.requiredCapabilities=[previousCapability,'unsupported-fixture-capability'];
 const invalidFence=JSON.stringify(fence);
 const current=await authority.stat();
 await authority.writeText(invalidFence,{kind:'replaceIfVersion',version:current.version});
 await writeFile(f.fencePath,invalidFence);
 const before=await fileEvidence(f.path);

 const [inspection]=await Promise.allSettled([inspectCompanionDataRoot(f.root)]);
 const [interruption]=await Promise.allSettled([interruptImportedCompanion(f.root,'section-fence-fixture')]);
 const version=readDatabase(f.path,sqliteFence).version,after=await fileEvidence(f.path);
 t.diagnostic(JSON.stringify({inspection:inspection.status,interruption:interruption.status,version,before,after}));
 assert.equal(version,2);
 assert.deepEqual(after,before);
 assert.equal(await readFile(f.fencePath,'utf8'),invalidFence);
 assert.equal(await authority.readText(),invalidFence);
 for(const outcome of [inspection,interruption]){
  assert.equal(outcome.status,'rejected');
  assert.match(outcome.reason.message,/migration fence/i);
 }
});

async function fileEvidence(path){
 try{
  const bytes=await readFile(path);
  return {size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }catch(error){
  if(error.code==='ENOENT')return null;
  throw error;
 }
}

async function leaveCommittedWal(f,sql){
 const store=await f.reopen();
 await store.close();
 const copies=join(f.root,'crash-image');
 await mkdir(copies);
 const suffixes=['','-wal','-shm'];
 const seed=new DatabaseSync(f.path);
 try{
  seed.exec('PRAGMA wal_autocheckpoint=0;');
  seed.exec(sql);
  for(const suffix of suffixes)await copyFile(f.path+suffix,join(copies,'companion.sqlite'+suffix));
 }finally{seed.close();}
 for(const suffix of suffixes)await copyFile(join(copies,'companion.sqlite'+suffix),f.path+suffix);
}

test('rollback rejects a missing state section in committed WAL without modifying the crash image',async t=>{
 const f=await physicalV2(t,{withHistory:false});
 await leaveCommittedWal(f,"DELETE FROM state_sections WHERE name='lives'");
 const before=await Promise.all(['','-wal'].map(suffix=>fileEvidence(f.path+suffix)));
 assert.ok(before[1].size>32,'fixture contains committed WAL frames');

 await assert.rejects(exportCompanionForRollback(f.root),/state section/i);
 const after=await Promise.all(['','-wal'].map(suffix=>fileEvidence(f.path+suffix)));
 t.diagnostic(JSON.stringify({before,after}));
 assert.deepEqual(after,before);
 assert.deepEqual(await readFile(f.fencePath),f.fenceBytes);
});

test('rollback incorporates a valid committed WAL from a closed database',async t=>{
 const f=await physicalV2(t,{withHistory:false});
 await leaveCommittedWal(f,"UPDATE state SET value=json_set(value,'$.walProbe','committed'),revision=revision+1 WHERE id=1");
 assert.ok((await fileEvidence(f.path+'-wal')).size>32);
 const receipt=await exportCompanionForRollback(f.root);
 const exported=JSON.parse(await readFile(receipt.exportPath,'utf8'));
 assert.equal(exported.walProbe,'committed');
 assert.equal(exported.revision,f.expected.revision+1);
});
