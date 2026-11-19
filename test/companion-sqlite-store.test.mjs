import {readCompanionExport} from './support/companion-export-file.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {channel} from 'node:diagnostics_channel';
import {test} from 'node:test';
import {exportCompanionForRollback,makeCard,openCompanionStore} from '../src/companion-store.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
import {assertR95CompanionCompatible} from '../src/r95-data-compatibility.mjs';

const ownerId='fixture-conversation';
const characterId='deepseek';
const personaId='default';
const pathOf=root=>join(root,'galgame','companion.sqlite');
const message=id=>({id,role:'assistant',characterId,text:'温柔的台词',createdAt:1730000000000});

async function fixture(t){
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-'));
  const opened=[];
  t.after(async()=>{
    for(const close of opened.reverse())await close();
    await rm(root,{recursive:true,force:true});
  });
  const store=await openCompanionStore(root);
  opened.push(()=>store.close?.());
  await store.mutate(state=>{
    state.relationships[characterId]={mode:'independent',byPersona:{[personaId]:{level:1,affection:0}}};
    state.conversations[ownerId]={id:ownerId,characterId,personaId,title:'Fixture'};
  });
  return {root,store,opened};
}

function addReply(state,tx,reply){
  assert.ok(tx?.messages,'the recipe receives a message writer');
  tx.messages.append('private',ownerId,reply);
  assert.deepEqual(tx.messages.get('private',ownerId,reply.id),reply);
  state.relationships[characterId].byPersona[personaId].affection+=3;
}

function expectReplyAndAffection(store,reply,affection){
  assert.deepEqual(store.messages.get('private',ownerId,reply.id),reply);
  assert.equal(store.state.relationships[characterId].byPersona[personaId].affection,affection);
}

test('a reply and its affection commit together, and neither a rejected recipe nor a failed SQLite commit leaks either change',async t=>{
  const {root,store,opened}=await fixture(t);
  const committed=message('reply-committed');
  const originalRevision=store.state.revision;
  await store.mutate(async (state,tx)=>{
    addReply(state,tx,committed);
    await Promise.resolve();
    assert.equal(store.messages.get('private',ownerId,committed.id),undefined);
    assert.equal(store.state.relationships[characterId].byPersona[personaId].affection,0);
  });
  expectReplyAndAffection(store,committed,3);
  const committedRevision=store.state.revision;
  assert.equal(committedRevision,originalRevision+1);

  const rejected=message('reply-rejected');
  await assert.rejects(store.mutate(async (state,tx)=>{
    addReply(state,tx,rejected);
    await Promise.resolve();
    throw Error('recipe rejected');
  }),/recipe rejected/);
  assert.equal(store.messages.get('private',ownerId,rejected.id),undefined);
  expectReplyAndAffection(store,committed,3);
  assert.equal(store.state.revision,committedRevision);

  // A deferred constraint lets the row statements succeed and fails COMMIT.
  const injector=new DatabaseSync(pathOf(root));
  opened.push(()=>injector.close());
  injector.exec(`
    CREATE TABLE test_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE test_child(parent_id INTEGER REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER test_failure AFTER INSERT ON messages BEGIN INSERT INTO test_child VALUES(1); END;
  `);
  const blocked=message('reply-rolled-back');
  await assert.rejects(store.mutate((state,tx)=>addReply(state,tx,blocked)),/FOREIGN KEY constraint failed/);
  assert.equal(store.messages.get('private',ownerId,blocked.id),undefined);
  expectReplyAndAffection(store,committed,3);
  assert.equal(store.state.revision,committedRevision);

  injector.exec('DROP TRIGGER test_failure');
  await store.close();
  const reopened=await openCompanionStore(root);
  opened.push(()=>reopened.close());
  expectReplyAndAffection(reopened,committed,3);
  assert.equal(reopened.messages.get('private',ownerId,rejected.id),undefined);
  assert.equal(reopened.messages.get('private',ownerId,blocked.id),undefined);
  assert.equal(reopened.state.revision,committedRevision);

  await reopened.mutate((state,tx)=>addReply(state,tx,blocked));
  expectReplyAndAffection(reopened,blocked,6);
});

test('a single reply and affection write stays below 2 ms at p95 with 12,000 old messages and never serializes the full history',async t=>{
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-scale-'));
  let store;
  t.after(async()=>{
    await store?.close?.();
    await rm(root,{recursive:true,force:true});
  });
  const directory=join(root,'galgame');
  await mkdir(directory);
  const conversation={id:ownerId,characterId,personaId,title:'Large history',messages:[]};
  for(let index=0;index<12_000;index++){
    conversation.messages.push({
      ...message('legacy-'+index),
      text:'温柔。还在想。',
      emotionSentences:[
        {emotion:'gentle',start:0,end:3,text:'温柔。'},
        {emotion:'thinking',start:3,end:7,text:'还在想。'}
      ]
    });
  }
  await writeFile(join(directory,'companion.json'),JSON.stringify({
    schema:2,
    minimumWriter:'r95-social-core-v1',
    requiredCapabilities:['social-core-state-v1'],
    cards:{},
    personas:{[personaId]:{id:personaId,name:'Test'}},
    conversations:{[ownerId]:conversation},
    relationships:{[characterId]:{mode:'independent',byPersona:{[personaId]:{level:1,affection:0}}}},
    groups:{},
    settings:{}
  }));
  store=await openCompanionStore(root);

  const appendReply=index=>store.mutate((state,tx)=>{
    const reply=message('new-'+index);
    if(tx)tx.messages.append('private',ownerId,reply);
    else state.conversations[ownerId].messages.push(reply);
    state.relationships[characterId].byPersona[personaId].affection++;
  });
  for(let index=0;index<8;index++)await appendReply(index);
  const samples=[];
  const stringify=JSON.stringify;
  let fullSerializations=0;
  JSON.stringify=(value,...args)=>{
    const messages=value?.conversations?.[ownerId]?.messages;
    if(Array.isArray(messages)&&messages.length>=12_000)fullSerializations++;
    return stringify(value,...args);
  };
  try{
    for(let index=8;index<48;index++){
      const start=performance.now();
      await appendReply(index);
      samples.push(performance.now()-start);
    }
  }finally{
    JSON.stringify=stringify;
  }
  const firstMeasured=samples[0];
  samples.sort((a,b)=>a-b);
  const p95=samples[Math.ceil(samples.length*.95)-1];
  t.diagnostic('writes='+samples.length+' firstMs='+firstMeasured.toFixed(3)+' p95Ms='+p95.toFixed(3)+' maxMs='+samples.at(-1).toFixed(3)+' fullSerializations='+fullSerializations);
  assert.equal(fullSerializations,0,'one reply never serializes all 12,000 existing messages');
  assert.ok(firstMeasured<2,'the first measured single write after warmup should be under 2 ms');
  assert.ok(p95<2,'single-write p95 should be under 2 ms');
  assert.equal(store.messages.count('private',ownerId),12_048);
  expectReplyAndAffection(store,message('new-47'),48);
});

test('migration reads the verified legacy journal, preserves the source bytes and reopens ordered message rows',async t=>{
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-migrate-'));
  let store;
  t.after(async()=>{
    await store?.close?.();
    await rm(root,{recursive:true,force:true});
  });
  const directory=join(root,'galgame'),oldPath=join(directory,'companion.json');
  await mkdir(directory);
  const legacy={
    schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],revision:12,
    cards:{},personas:{[personaId]:{id:personaId,name:'Test'}},relationships:{},
    conversations:{
      [ownerId]:{id:ownerId,characterId,personaId,title:'old',messages:[message('duplicate-id'),{...message('second'),createdAt:1,text:'emoji: 😀 内嵌\ud800字符'}]},
      another:{id:'another',characterId,personaId,title:'same logical ID',messages:[{...message('duplicate-id'),text:'独立会话'}]}
    },
    groups:{},lives:{},settings:{},unknown:{keep:[false,null,42]}
  };
  const direct=JSON.stringify({...legacy,conversations:{}});
  await writeFile(oldPath,direct);
  const journalWriter=createSnapshotStorage(oldPath,{protectExisting:true,retention:false});
  const source=JSON.stringify(legacy,null,2);
  await journalWriter.writeText(source);
  const phases=[];
  store=await openCompanionStore(root,{onMigrationProgress:value=>phases.push(value.phase)});
  assert.deepEqual(store.messages.recent('private',ownerId,2),legacy.conversations[ownerId].messages);
  assert.deepEqual(store.messages.get('private','another','duplicate-id'),legacy.conversations.another.messages[0]);
  const [{occurrenceId,...searchMatch}]=(await store.messages.history('private',ownerId,{search:'内嵌'})).messages;
  assert.equal(typeof occurrenceId,'string');
  assert.deepEqual(searchMatch,legacy.conversations[ownerId].messages[1]);
  assert.deepEqual(await store.messages.searchOwners('private','emoji'),[ownerId]);
  assert.deepEqual(store.state.unknown,legacy.unknown);
  assert.equal(store.state.revision,12);
  assert.equal(store.state.conversations[ownerId].messages,undefined);
  assert.ok(phases.includes('validated'));
  assert.ok(phases.includes('ready'));
  const names=await readdir(directory);
  const files=await Promise.all(names.filter(name=>name.startsWith('companion.pre-sqlite-')&&name.endsWith('.json')).map(name=>readFile(join(directory,name),'utf8')));
  assert.ok(files.includes(source),'the authoritative legacy bytes remain available');
  assert.ok(files.includes(direct),'the separate original flat file is preserved');
  const fence=JSON.parse(await createSnapshotStorage(oldPath,{protectExisting:true}).readText());
  assert.throws(()=>assertR95CompanionCompatible(fence),/需要更新|未支持|不支持/);
  await store.close();
  store=await openCompanionStore(root);
  assert.deepEqual(store.messages.recent('private',ownerId,2),legacy.conversations[ownerId].messages);
});

test('migration interruption at every publication boundary preserves the original and resumes with all rows',async t=>{
  const base=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-crash-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const phases=['discovered','backed-up','partitioned','inserted','validated','checkpointed','database-published','journal-published','fenced'];
  for(const phase of phases){
    await t.test(phase,async()=>{
      const root=join(base,phase),directory=join(root,'galgame'),legacyPath=join(directory,'companion.json');
      await mkdir(directory,{recursive:true});
      const source=JSON.stringify({
        schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],
        cards:{},personas:{[personaId]:{id:personaId,name:'Test'}},groups:{},settings:{},relationships:{},revision:6,
        conversations:{[ownerId]:{id:ownerId,personaId,characterId,messages:[message('first'),message('second')]}}
      });
      await writeFile(legacyPath,source);
      await assert.rejects(
        openCompanionStore(root,{interruptMigrationAfter:phase}),
        {code:'MIGRATION_TEST_INTERRUPTED'}
      );
      const reopened=await openCompanionStore(root);
      try{
        assert.equal(reopened.state.revision,6);
        assert.deepEqual(reopened.messages.recent('private',ownerId,2),[message('first'),message('second')]);
      }finally{await reopened.close();}
      const files=(await readdir(directory)).filter(name=>name.startsWith('companion.pre-sqlite-'));
      assert.ok((await Promise.all(files.map(name=>readFile(join(directory,name),'utf8')))).includes(source));
    });
  }
});

test('a published legacy fence fails closed if companion.sqlite is missing',async t=>{
  const {root,store}=await fixture(t);
  await store.close();
  await rm(pathOf(root));
  await assert.rejects(openCompanionStore(root),/Migrated companion database is missing/);
});

test('SQLite compacts sentence text to UTF-16 ranges while preserving legacy and invalid rows on read',async t=>{
  const {root,store,opened}=await fixture(t);
  const tagged={
    ...message('valid-expressions'),text:'😀。\n再见！',emotion:'gentle',
    emotionSentences:[{emotion:'gentle',start:0,end:3,text:'😀。'},{emotion:'thinking',start:4,end:7,text:'再见！'}]
  };
  const original={
    ...message('old-expressions'),text:'单句。',
    emotionSentences:[{emotion:'oldUnknown',start:0,end:3,text:'老句。',custom:true}]
  };
  await store.mutate((state,tx)=>{
    tx.messages.append('private',ownerId,tagged);
    tx.messages.append('private',ownerId,original);
  });
  assert.deepEqual(store.messages.get('private',ownerId,tagged.id),tagged);
  assert.deepEqual(store.messages.get('private',ownerId,original.id),original);
  // The physical string is part of the storage contract.
  const reader=new DatabaseSync(pathOf(root),{readOnly:true});
  opened.push(()=>reader.close());
  const select=reader.prepare('SELECT emotion_ranges,extra_json FROM messages WHERE message_id=?');
  const compact=select.get(tagged.id);
  assert.equal(compact.emotion_ranges,'gentle:0-3|thinking:4-7');
  assert.ok(!compact.extra_json.includes('再见'));
  assert.equal(select.get(original.id).emotion_ranges,null);
});

test('migration rejects a newly published legacy source before fencing it',async t=>{
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-stale-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=join(root,'galgame'),oldPath=join(dir,'companion.json');
  await mkdir(dir);
  const source=JSON.stringify({schema:1,revision:1,cards:{},groups:{},conversations:{}});
  const replacement=JSON.stringify({schema:1,revision:2,cards:{},groups:{},conversations:{}});
  await writeFile(oldPath,source);
  await assert.rejects(openCompanionStore(root,{interruptMigrationAfter:'database-published'}),{code:'MIGRATION_TEST_INTERRUPTED'});
  const legacy=createSnapshotStorage(oldPath,{protectExisting:true,retention:false});
  await legacy.writeText(replacement);
  await assert.rejects(openCompanionStore(root),/different migration source|changed during migration/);
  assert.equal(await legacy.readText(),replacement);
  assert.equal(await readFile(oldPath,'utf8'),source);
});

test('the slow-query probe emits only the statement name and elapsed time',async t=>{
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-slow-'));
  let store,delayed=false,clock=0;
  t.after(async()=>{await store?.close?.();await rm(root,{recursive:true,force:true});});
  const slow=[];
  store=await openCompanionStore(root,{
    audit:event=>{if(event.type==='companion-slow-query')slow.push(event);},
    sqlClock:()=>{if(delayed)clock+=20;return clock;}
  });
  await store.mutate((state,tx)=>tx.messages.append('private',ownerId,message('probe')));
  delayed=true;
  assert.deepEqual(store.messages.get('private',ownerId,'probe'),message('probe'));
  delayed=false;
  assert.deepEqual(slow,[{type:'companion-slow-query',statement:'messages.get',elapsedMs:20}]);
});

test('worker history pages retain stable order across new writes and use full-message search',async t=>{
  const {store}=await fixture(t);
  for(let index=1;index<=7;index++){
    await store.mutate((state,tx)=>tx.messages.append('private',ownerId,{
      ...message('page-'+index),text:index%2===0?'时间 纪念日 '+index:'普通 '+index
    }));
  }
  const first=await store.messages.history('private',ownerId,{limit:3});
  assert.deepEqual(first.messages.map(row=>row.id),['page-5','page-6','page-7']);
  assert.equal(first.hasMore,true);
  assert.equal(first.totalCount,7);
  assert.ok(first.nextBefore);
  await store.mutate((state,tx)=>tx.messages.append('private',ownerId,message('newer')));
  const earlier=await store.messages.history('private',ownerId,{limit:3,before:first.nextBefore});
  assert.deepEqual(earlier.messages.map(row=>row.id),['page-2','page-3','page-4']);
  const matching=await store.messages.history('private',ownerId,{limit:2,search:'纪念日'});
  assert.deepEqual(matching.messages.map(row=>row.id),['page-4','page-6']);
  assert.equal(matching.totalCount,3);
  assert.equal(matching.hasMore,true);
});

test('rollback export includes writes made after migration and a later upgrade imports new r4 writes',async t=>{
  const {root,store,opened}=await fixture(t);
  const oldPath=join(root,'galgame','companion.json');
  await store.mutate((state,tx)=>addReply(state,tx,message('before-rollback')));
  await store.close();

  const receipt=await exportCompanionForRollback(root);
  assert.equal(receipt.messageCount,1);
  const legacyWriter=createSnapshotStorage(oldPath,{protectExisting:true,retention:false});
  const data=JSON.parse(await legacyWriter.readText());
  assertR95CompanionCompatible(data);
  assert.deepEqual(data.conversations[ownerId].messages,[message('before-rollback')]);
  assert.deepEqual(JSON.parse(await readFile(oldPath,'utf8')),data);
  assert.equal(data.relationships[characterId].byPersona[personaId].affection,3);
  data.conversations[ownerId].messages.push(message('during-r4'));
  await legacyWriter.writeText(JSON.stringify(data));
  const reopened=await openCompanionStore(root);
  opened.push(()=>reopened.close());
  assert.deepEqual(reopened.messages.recent('private',ownerId,2),[message('before-rollback'),message('during-r4')]);
  assert.ok((await readdir(join(root,'galgame'))).some(name=>name.startsWith('companion.sqlite-retired-')));
});

test('legacy export preserves omitted, empty, and null message collections until the owner receives a message',async t=>{
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-collection-shape-'));
  let store;
  t.after(async()=>{await store?.close?.();await rm(root,{recursive:true,force:true});});
  const directory=join(root,'galgame');
  await mkdir(directory);
  const source={
    schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],revision:3,
    cards:{},personas:{},groups:{},settings:{},
    conversations:{
      omitted:{id:'omitted',odd:{preserve:[false,null]}},
      empty:{id:'empty',messages:[]},
      nullable:{id:'nullable',messages:null}
    }
  };
  await writeFile(join(directory,'companion.json'),JSON.stringify(source));
  store=await openCompanionStore(root);
  assert.deepEqual(await store.snapshotAsync(),source);
  await store.mutate((state,tx)=>tx.messages.append('private','omitted',message('new-omitted')));
  source.conversations.omitted.messages=[message('new-omitted')];
  source.revision++;
  assert.deepEqual(await store.snapshotAsync(),source);
  await store.close();
  await exportCompanionForRollback(root);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'companion.json'),'utf8')),source);
});

test('migration puts live, archived, transaction messages and accumulating records in SQLite and restores the legacy shape',async t=>{
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r14-records-'));
  let store,reader;
  t.after(async()=>{reader?.close();await store?.close?.();await rm(root,{recursive:true,force:true});});
  const directory=join(root,'galgame');
  await mkdir(directory);
  const quote=message('archived-copy'),record={id:'record-1',text:'evidence'};
  const source={
    schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],revision:2,
    cards:{},conversations:{},settings:{},events:{'event:1':record},
    groups:{g:{id:'g',submissions:{s:{at:1}},pendingUserInputs:[{clientRequestId:'queued',state:'queued'}]}},
    lives:{[characterId]:{id:'life-x',restoredGroupEvidence:[{id:'g',messages:[quote]}],memory:{events:{'memory-1':record}},r95:{evidence:{'evidence-1':record}},socialExperiences:[record],growth:{preferences:{traits:{
      'pref-first':{id:'pref-first',subject:'rain',evidence:[record],counterEvidence:[],versions:[{id:'rev-1',text:'first'}]},
      'pref-second':{id:'pref-second',subject:'tea',evidence:[],counterEvidence:[record],versions:[]}
    }}}}},
    lifeTransaction:{id:'transaction-1',target:{conversations:[{id:'c',messages:[quote]}],groupEvidence:[{id:'g',messages:[quote]}],life:{restoredGroupEvidence:[{id:'g',messages:[quote]}]}}}
  };
  await writeFile(join(directory,'companion.json'),JSON.stringify(source));
  store=await openCompanionStore(root);
  assert.deepEqual(await store.snapshotAsync(),source);
  reader=new DatabaseSync(pathOf(root),{readOnly:true});
  const value=JSON.parse(reader.prepare('SELECT value FROM state').get().value);
  assert.equal(value.events,undefined);
  assert.equal(value.groups.g.pendingUserInputs,undefined);
  assert.equal(value.lives,undefined);
  const lives=JSON.parse(reader.prepare("SELECT value FROM state_sections WHERE name='lives'").get().value);
  assert.equal(lives[characterId].memory.events,undefined);
  assert.equal(value.lifeTransaction.target.conversations[0].messages,undefined);
  assert.equal(reader.prepare('SELECT count(*) AS n FROM messages').get().n,4);
  assert.ok(reader.prepare('SELECT count(*) AS n FROM records').get().n>=5);
});

test('rollback refuses even a clean WAL held by an open companion writer',async t=>{
  const {root,store}=await fixture(t);
  await store.flush();
  await assert.rejects(exportCompanionForRollback(root),/closed and checkpointed|currently open/);
  const oldPath=join(root,'galgame','companion.json');
  const fence=JSON.parse(await readFile(oldPath,'utf8'));
  assert.throws(()=>assertR95CompanionCompatible(fence),/需要更新|未支持|不支持/);
});

test('production presentation rolls back the message and affinity before any engine relationship action when SQLite commit fails',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{state.cards.claude=makeCard({id:'claude',name:'Claude'});});
  const {engine}=syntheticEngine({getStore:()=>store});
  const calls=[];
  const action=engine.handleAction.bind(engine);
  engine.handleAction=(name,args)=>{if(name==='companion-relationship')calls.push(args.eventId);return action(name,args);};
  const service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot:null});
  opened.push(service.close);
  const state=service.viewState(),id=state.activeConversationId,character=state.activeCharacterId,persona=state.activePersonaId;
  const token={lifeId:store.state.lives[character].id,operationId:store.state.lives[character].operationId};
  const reply={id:'present-r14',requestId:'r14-test',role:'assistant',text:'一句话',characterId:character,personaId:persona,lifeId:token.lifeId,lifeToken:token,presentation:'pending',pendingAffection:3,createdAt:1730000000000};
  await store.mutate((draft,tx)=>tx.messages.append('private',id,reply));
  const before=service.progress(character,persona),revision=store.state.revision;
  const db=new DatabaseSync(pathOf(root));
  opened.push(()=>db.close());
  db.exec(`
    CREATE TABLE guard_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE guard_child(id INTEGER REFERENCES guard_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER guard_present AFTER UPDATE ON messages BEGIN INSERT INTO guard_child VALUES(1); END;
  `);
  await assert.rejects(service.action('companion-private-present',{conversationId:id,id:reply.id}),/FOREIGN KEY constraint failed/);
  assert.deepEqual(service.progress(character,persona),before);
  assert.equal(store.messages.get('private',id,reply.id).presentation,'pending');
  assert.deepEqual(calls,[]);
  db.exec('DROP TRIGGER guard_present');
  await service.action('companion-private-present',{conversationId:id,id:reply.id});
  assert.equal(store.messages.get('private',id,reply.id).presentation,'presented');
  assert.deepEqual(service.progress(character,persona),{level:before.level,affection:before.affection+3});
  assert.deepEqual(calls,['chat:r14-test']);
  assert.equal(store.state.revision,revision+1,'presenting a reply and affinity uses one companion transaction');
});

test('group history counts and page cursors exclude pending-presentation legacy rows',async t=>{
  const {store}=await fixture(t);
  await store.mutate((state,tx)=>{
    for(const [index,status] of ['presented','pending-presentation','presented'].entries()){
      tx.messages.append('group','group-fixture',{...message('group-'+index),seq:index+1,status});
    }
  });
  const first=await store.messages.history('group','group-fixture',{limit:1});
  assert.deepEqual(first.messages.map(row=>row.id),['group-2']);
  assert.equal(first.totalCount,2);
  const previous=await store.messages.history('group','group-fixture',{limit:1,before:first.nextBefore});
  assert.deepEqual(previous.messages.map(row=>row.id),['group-0']);
  assert.equal(previous.hasMore,false);
  assert.equal(store.messages.count('group','group-fixture'),3);
});

test('a failed engine projection is retried without duplicating SQLite presentation or affinity',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{state.cards.claude=makeCard({id:'claude',name:'Claude'});});
  const {engine}=syntheticEngine({getStore:()=>store});
  const calls=[];
  const action=engine.handleAction.bind(engine);
  engine.handleAction=(name,args)=>{
    if(name==='companion-relationship'){
      calls.push(args.eventId);
      if(calls.length===1)throw Error('Injected projection outage');
    }
    return action(name,args);
  };
  const service=await createCompanionService({store,engine,provider:{enabled:false}});
  opened.push(service.close);
  const state=service.viewState(),id=state.activeConversationId,character=state.activeCharacterId,persona=state.activePersonaId;
  const token={lifeId:store.state.lives[character].id,operationId:store.state.lives[character].operationId};
  const reply={id:'retry-r14',requestId:'r14-retry',role:'assistant',text:'一句话',characterId:character,personaId:persona,lifeId:token.lifeId,lifeToken:token,presentation:'pending',pendingAffection:3,createdAt:1730000000000};
  await store.mutate((draft,tx)=>tx.messages.append('private',id,reply));
  const before=service.progress(character,persona);
  await assert.rejects(service.action('companion-private-present',{conversationId:id,id:reply.id}),/projection outage/);
  assert.equal(store.messages.get('private',id,reply.id).presentation,'presented');
  assert.equal((await service.action('companion-state')).companion.relationship.affection,before.affection+3);
  await service.action('companion-private-present',{conversationId:id,id:reply.id});
  assert.deepEqual(calls,['chat:r14-retry','chat:r14-retry']);
  assert.equal(service.progress(character,persona).affection,before.affection+3);
});

test('worker long-term retrieval matches the legacy memory service for the same visible history',async t=>{
  const {root,store}=await fixture(t);
  const {createCompanionMemory}=await import('../src/companion-memory.mjs');
  const {companionFixture,memoryStore}=await import('./support/audit-harness.mjs');
  const legacy=await companionFixture({now:1730000000000}),id=legacy.activeConversationId;
  const owner=legacy.conversations[id],character=owner.characterId,persona=owner.personaId;
  const legacyRows=[
    {...message('memory-user'),role:'user',text:'星空纪念日需要记住',characterId:character,personaId:persona,lifeId:owner.lifeId,status:'sent'},
    {...message('memory-assistant'),text:'我记住了星空。',characterId:character,personaId:persona,lifeId:owner.lifeId,presentation:'presented'}
  ];
  owner.messages=legacyRows;
  await store.mutate((state,tx)=>{
    const {messages,...metadata}=owner;
    Object.assign(state,{...legacy,conversations:{...legacy.conversations,[id]:metadata}});
    for(const row of legacyRows)tx.messages.append('private',id,row);
  });
  const settings={autoStart:false,now:()=>1730003600000,runModel:async()=>{throw Error('Unexpected model request');}};
  const old=createCompanionMemory({store:memoryStore(legacy),...settings});
  const next=createCompanionMemory({store,...settings});
  try{
    const args={characterId:character,personaId:persona,conversationId:id,query:'星空纪念日'};
    assert.deepEqual(await next.context(args),await old.context(args));
    const oldView=await old.view(args),newView=await next.view(args);
    assert.deepEqual(newView,oldView);
    await next.sync(character);
    assert.ok(store.records.count('memory.events',character)>0);
  }finally{await Promise.all([old.close(),next.close()]);}
});

test('a committed group turn retries projection and request journal before advancing the queue once',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{
    state.cards.deepseek=makeCard({id:'deepseek',name:'DeepSeek'});
    state.cards.claude=makeCard({id:'claude',name:'Claude'});
  });
  const {engine}=syntheticEngine({getStore:()=>store}),committed=[],projections=[];
  const action=engine.handleAction.bind(engine);
  engine.handleAction=(name,args)=>{
    if(name==='companion-relationship'&&args.eventId.startsWith('group:')){
      projections.push(args.eventId);
      if(projections.length===1)throw Error('Injected group projection outage');
    }
    return action(name,args);
  };
  const provider={
    enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),
    async *stream(){
      yield {type:'text-delta',text:JSON.stringify({text:'已经听到了。',affection:1,affectionTarget:'user'})};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  };
  const service=await createCompanionService({store,engine,provider,dataRoot:root,onChatCommitted:message=>committed.push(message)});
  opened.push(service.close);
  const {group}=await service.action('companion-group-save',{memberIds:['claude','deepseek'],mode:'list'});
  await service.action('companion-group-select',{id:group.id});
  await service.action('companion-group-send',{id:group.id,text:'来讨论今天的事'});
  let pending;
  for(let i=0;i<300;i++){
    const runtime=service.viewState().groupRuntime;
    assert.notEqual(runtime.status,'failed',runtime.error);
    pending=runtime.pendingMessage;
    if(pending)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(pending);
  const requestId=pending.id,args={id:group.id,requestId};
  const journal=join(root,'chat-requests',requestId+'.json'),savedJournal=journal+'.held';
  const before=service.progress('claude','default');
  await assert.rejects(service.action('companion-group-present',args),/group projection outage/);
  assert.equal(store.messages.get('group',group.id,requestId).status,'presented');
  assert.equal(service.viewState().groupRuntime.status,'awaiting-presentation');
  assert.equal(JSON.parse(await readFile(journal,'utf8')).status,'completed-unpresented');
  assert.deepEqual(committed,[]);
  try{
    await rename(journal,savedJournal);
    await mkdir(journal);
    await assert.rejects(service.action('companion-group-present',args),/EISDIR|EPERM|EACCES/);
    assert.equal(service.viewState().groupRuntime.status,'awaiting-presentation');
    assert.deepEqual(committed,[]);
  }finally{
    await rm(journal,{recursive:true,force:true});
    await rename(savedJournal,journal);
  }
  await Promise.all([service.action('companion-group-present',args),service.action('companion-group-present',args)]);
  assert.equal(service.viewState().groupRuntime.status,'awaiting-continue');
  assert.deepEqual(service.viewState().groupRuntime.queue,['deepseek']);
  assert.equal(JSON.parse(await readFile(journal,'utf8')).status,'completed');
  assert.deepEqual(committed.map(row=>row.messageId),[requestId]);
  assert.deepEqual(projections,['group:'+requestId,'group:'+requestId]);
  assert.equal(service.progress('claude','default').affection,before.affection+1);
});

test('startup rejects a malformed SQLite fence without writing over the legacy authority',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-r14-malformed-fence-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'galgame');
  await mkdir(directory);
  const old=join(directory,'companion.json');
  const bytes=JSON.stringify({schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],sqliteMigration:{id:'incomplete'}});
  await writeFile(old,bytes);
  await assert.rejects(openCompanionStore(root),/Unsupported companion migration fence/);
  assert.equal(await readFile(old,'utf8'),bytes);
  assert.deepEqual(await readdir(directory),['companion.json']);
});

test('the real companion boot normalizes migrated undated private replies and does not resurrect deleted legacy imports',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-r14-legacy-private-'));
  let store,service;
  t.after(async()=>{await service?.close();await store?.close();await rm(root,{recursive:true,force:true});});
  const {createHash}=await import('node:crypto');
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {companionFixture,syntheticEngine}=await import('./support/audit-harness.mjs');
  const source=await companionFixture({now:1730000000000}),character=source.activeCharacterId;
  const owner=source.conversations[source.activeConversationId];
  const deletedId='deleted-legacy-on-r4',id='kept-undated-on-r4',lineHash=createHash('sha256').update('id:'+deletedId).digest('hex').slice(0,24);
  owner.messages=[{id,role:'assistant',text:'早年的一条原文',createdAt:0,legacy:true}];
  source.legacyImports={[character]:{[lineHash]:1}};
  source.lives[character].legacyImportEnabled=true;
  const directory=join(root,'galgame');
  await mkdir(directory);await writeFile(join(directory,'companion.json'),JSON.stringify(source));
  store=await openCompanionStore(root);
  const {schema,minimumWriter,requiredCapabilities,r95Migration,...migrated}=await store.snapshotAsync();
  assert.equal(schema,2);
  assert.equal(minimumWriter,'r95-social-core-v1');
  assert.deepEqual(requiredCapabilities,['social-core-state-v1']);
  assert.equal(r95Migration.from,1);
  assert.equal(r95Migration.to,2);
  assert.deepEqual({...migrated,schema:1},{...source,revision:0},'migration preserves original rows before runtime normalization');
  const {engine}=syntheticEngine({getStore:()=>store,history:{[character]:[{id:deletedId,who:'heroine',text:'用户已删除'}]}});
  service=await createCompanionService({store,engine,provider:{enabled:false}});
  const original=store.messages.get('private',owner.id,id);
  assert.equal(original.text,owner.messages[0].text);
  assert.equal(original.lifeId,source.lives[character].id);
  assert.equal(original.recordedAt,source.lives[character].startedAt);
  assert.equal(original.dateBasis,'migration-undated');
  assert.equal(original.presentation,'presented');
  assert.equal(store.messages.get('private',owner.id,deletedId),undefined);
  assert.equal(store.records.get('legacyImports',character,lineHash),1);
});

test('idle R95 tick with eleven lives launches no storage readers',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{
    for(let index=0;index<11;index++){
      const id=index===0?'claude':'character-'+index;
      state.cards[id]=makeCard({id,name:id});
    }
  });
  const {engine}=syntheticEngine({getStore:()=>store});
  const service=await createCompanionService({store,engine,provider:{enabled:true},dataRoot:root,r95Options:{tickAllowed:()=>false}});
  opened.push(service.close);
  assert.equal(Object.keys(store.state.lives).length,11);
  const reads=[],starts=channel('ai-buddy.companion.worker-start'),count=operation=>reads.push(operation);
  starts.subscribe(count);
  try{await service.r95.tick();}finally{starts.unsubscribe(count);}
  assert.deepEqual(reads,[]);
});

test('growth cards read bounded public history, observations and preference evidence after migration',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-r14-live-growth-'));
  let store,service;
  t.after(async()=>{await service?.close();await store?.close();await rm(root,{recursive:true,force:true});});
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {companionFixture,syntheticEngine}=await import('./support/audit-harness.mjs');
  const source=await companionFixture({now:1730000000000}),character=source.activeCharacterId,life=source.lives[character];
  life.mode='seed';
  life.growth={
    history:Array.from({length:22},(_,index)=>({id:'history-'+index,field:'likes',evidenceCount:index})),
    observations:{observed:{id:'observed',field:'interests',status:'observing'}},
    batches:{batch:{day:'2024-10-27',result:{status:'applied'}}},
    preferences:{traits:{'pref-rain':{id:'pref-rain',field:'likes',status:'established',subject:'rain',text:'likes rain',evidence:[{id:'example'}],counterEvidence:[],versions:[]}}}
  };
  const directory=join(root,'galgame');
  await mkdir(directory);await writeFile(join(directory,'companion.json'),JSON.stringify(source));
  store=await openCompanionStore(root);
  const {engine}=syntheticEngine({getStore:()=>store});
  service=await createCompanionService({store,engine,provider:{enabled:false}});
  const growth=(await service.action('companion-state')).companion.characters.find(row=>row.id===character).growth;
  assert.equal(growth.history.length,20);
  assert.equal(growth.history.at(-1).id,'history-21');
  assert.equal(growth.observing[0].id,'observed');
  assert.equal(growth.batches[0].status,'applied');
  assert.equal(growth.preferences[0].evidenceCount,1);
  assert.equal(growth.preferences[0].evidence,undefined);
  assert.equal(store.state.lives[character].growth.history,undefined);
});

test('a committed relationship reset survives a failed engine projection and process restart',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{state.cards.claude=makeCard({id:'claude',name:'Claude'});state.activeCharacterId='claude';});
  const failing=syntheticEngine({getStore:()=>store,hooks:{call(name,args){
    if(name==='companion-project'&&args.characterId==='claude')throw Error('Injected reset projection outage');
  }}});
  const service=await createCompanionService({store,engine:failing.engine,provider:{enabled:false}});
  assert.equal((await service.action('companion-state')).companion.relationship.affection,35);
  await assert.rejects(service.action('companion-relationship-reset',{characterId:'claude'}),/reset projection outage/);
  assert.equal(service.progress('claude','default').affection,0);
  assert.equal(failing.engineState.claude.affection,35);
  // Close the raw companion writer without calling the host's projection flush.
  await service.close();await store.close();
  const reopened=await openCompanionStore(root),next=syntheticEngine({getStore:()=>reopened,hooks:{call(name,args,{engineState}){
    if(name==='companion-project'&&args.characterId){Object.assign(engineState[args.characterId],args.relationship);return {ok:true};}
  }}});
  opened.push(()=>reopened.close());
  const recovered=await createCompanionService({store:reopened,engine:next.engine,provider:{enabled:false}});
  opened.push(recovered.close);
  assert.equal((await recovered.action('companion-state')).companion.relationship.affection,0);
  assert.equal(next.engineState.claude.affection,0);
});

test('conversation export enforces the completed 50 MiB limit including its CG media',async t=>{
  const {store,opened,root}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate((state,tx)=>{
    state.cards.deepseek=makeCard({id:'deepseek',name:'DeepSeek'});
    state.activeConversationId=ownerId;state.migrated=true;
    tx.messages.define('private',ownerId,['conversations',ownerId]);
    tx.messages.append('private',ownerId,message('portable-line'));
  });
  let large=false;
  const {engine}=syntheticEngine({getStore:()=>store,hooks:{call(name){
    if(name==='companion-media-export')return {media:[{id:'cg-fixture',data:'x'.repeat(large?50*1024*1024:10)}]};
  }}});
  const service=await createCompanionService({store,engine,provider:{enabled:false},chooseConversationExportPath:()=>join(root,'media-test.json')});
  opened.push(service.close);
  assert.equal((await readCompanionExport(service,'companion-conversation-export',{id:ownerId})).media.length,1);
  large=true;
  await assert.rejects(service.action('companion-conversation-export',{id:ownerId}),/Export exceeds 50 MiB/);
});

test('an engine checkpoint before projection acknowledgement preserves a delta after reset',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-r14-reset-order-'));
  const mirror=await mkdtemp(join(tmpdir(),'companion-r14-reset-reopen-'));
  const {cp}=await import('node:fs/promises');
  const {createGalgame}=await import('../src/galgame-host.mjs');
  const {createDeferredSaves}=await import('../src/deferred-saves.mjs');
  const {readJson}=await import('../src/storage.mjs');
  const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[],listModels:()=>[]};
  const open=dataRoot=>createGalgame({dataRoot,provider,model:'fixture',deferredSaveRegistry:createDeferredSaves()});
  let game,recovered;
  t.after(async()=>{await recovered?.close();await game?.close();await rm(mirror,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
  game=await open(root);
  const {current:character}=await game.action('view'),at=Date.now()-120000;
  assert.equal((await game.touch({characterId:character,eventId:'before-reset',at})).affection,1);
  await game.action('companion-relationship-reset',{characterId:character});
  assert.equal((await game.touch({characterId:character,eventId:'after-reset',at:at+61000})).affection,1);
  await game.flushSaves();
  const global=await readJson(createSnapshotStorage(join(root,'galgame','storages','dsh-whale-galgame','global.json')));
  const engine=global.characters[character];
  assert.equal(engine.affection,1);
  assert.equal(Object.values(engine.companionEvents).filter(row=>row.source==='companion-reset').length,1);
  const db=new DatabaseSync(pathOf(root),{readOnly:true});
  try{assert.equal(db.prepare("SELECT count(*) AS total FROM records WHERE namespace='root.relationshipProjections'").get().total,3);}
  finally{db.close();}
  await cp(root,mirror,{recursive:true});
  recovered=await open(mirror);
  assert.equal((await recovered.action('view')).affection,1);
  assert.equal((await recovered.action('companion-state')).companion.relationship.affection,1);
});

test('ending a SQLite group creates its automatic photo once and reuses the saved range',async t=>{
  const {store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{state.cards.claude=makeCard({id:'claude',name:'Claude'});});
  const photos=[];
  const {engine}=syntheticEngine({getStore:()=>store,hooks:{call(name,args){
    if(name==='group-photo'){photos.push(args.source);return {ok:true,cgId:'fixture-photo'};}
  }}});
  const provider={enabled:true,resolveConnection:()=>({id:'fixture',model:'fixture'}),currentSelection:()=>({provider:'fixture',model:'fixture'})};
  const service=await createCompanionService({store,engine,provider});
  opened.push(service.close);
  const {group}=await service.action('companion-group-save',{memberIds:['claude'],autoPhoto:true});
  await store.mutate((state,tx)=>{
    state.groups[group.id].seq=2;
    tx.messages.append('group',group.id,{...message('group-photo-user'),role:'user',seq:1});
    tx.messages.append('group',group.id,{...message('group-photo-reply'),characterId:'claude',seq:2,status:'presented'});
  });
  await service.action('companion-group-end',{id:group.id});
  assert.equal(photos.length,1);
  assert.equal(store.state.groups[group.id].lastEndedSeq,2);
  const again=await service.action('companion-group-photo',{id:group.id,range:{start:1,end:2}});
  assert.equal(again.photo.reused,true);
  assert.equal(again.photo.cgId,'fixture-photo');
  assert.equal(photos.length,1);
  const sourceEventId='group:'+group.id+':1:2:claude:new:retry-before-migration';
  await store.mutate((state,tx)=>tx.records.put('group.photos',group.id,'1',{
    cgId:'legacy-retry-photo',sourceEventId,range:{start:1,end:2},characterIds:['claude'],at:Date.now()
  },{array:true,at:['groups',group.id,'photos']}));
  provider.enabled=false;
  const oldRetry=await service.action('companion-group-photo',{id:group.id,range:{start:1,end:2},regenerate:true,clientRequestId:'retry-before-migration'});
  assert.equal(oldRetry.photo.cgId,'legacy-retry-photo');
  assert.equal(oldRetry.photo.reused,true);
  assert.equal(photos.length,1);
});

test('private history pages keep scoped meal narration between the original messages',async t=>{
  const {store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{state.cards.deepseek=makeCard({id:'deepseek',name:'DeepSeek'});state.activeConversationId=ownerId;state.migrated=true;});
  const {engine}=syntheticEngine({getStore:()=>store});
  const service=await createCompanionService({store,engine,provider:{enabled:false},getLanguage:()=> 'en'});
  opened.push(service.close);
  const life=store.state.lives[characterId],at=1730000000000;
  const scope={characterId,personaId,conversationId:ownerId,channel:'app-private',lifeId:life.id,operationId:life.operationId};
  const meal='feeding:fixture:experience',other='feeding:private:experience';
  await store.mutate((state,tx)=>{
    tx.messages.append('private',ownerId,{...message('before-meal'),createdAt:at,lifeId:life.id,presentation:'presented'});
    tx.messages.append('private',ownerId,{...message('after-meal'),createdAt:at+2,lifeId:life.id,presentation:'presented'});
    state.lives[characterId].r95??={};
    for(const [eventId,current] of [[meal,scope],[other,{...scope,conversationId:'other'}]]){
      tx.records.put('life.r95.evidence',characterId,eventId,{
        eventId,scope:current,sourceKind:'meal',actual:true,
        text:JSON.stringify({eventId,kind:'feeding',status:'completed',occurredAt:at+1,foodId:'cheesecake'})
      },{at:['lives',characterId,'r95','evidence']});
    }
  });
  const args={ownerType:'private',ownerId,limit:2};
  const latest=await service.action('companion-history-page',args);
  assert.equal(latest.totalCount,3);
  assert.deepEqual(latest.messages.map(row=>row.id),[meal,'after-meal']);
  assert.match(latest.messages[0].text,/Cheesecake/);
  const older=await service.action('companion-history-page',{...args,before:latest.nextBefore});
  assert.deepEqual(older.messages.map(row=>row.id),['before-meal']);
  assert.equal(older.hasMore,false);
  const searched=await service.action('companion-history-page',{...args,search:'cheesecake'});
  assert.deepEqual(searched.messages.map(row=>row.id),[meal]);
  assert.equal((await service.action('companion-history-page',{...args,favorites:true})).totalCount,0);
  assert.equal(store.messages.count('private',ownerId),2);
});

test('a level gift uses one durable job and one narrator line across pre-checkpoint engine replay',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-r14-level-cg-'));
  const mirror=await mkdtemp(join(tmpdir(),'companion-r14-level-reopen-'));
  const {cp}=await import('node:fs/promises');
  const {createGalgame}=await import('../src/galgame-host.mjs');
  const {createDeferredSaves}=await import('../src/deferred-saves.mjs');
  const {readJson}=await import('../src/storage.mjs');
  const jobs=new Map(),attempts=[];
  let isolateOnNextAdmission;
  const cg={
    enabled:true,available:()=>true,subscribe:()=>()=>{},job:id=>[...jobs.values()].find(row=>row.id===id),
    async enqueue(row){
      attempts.push(row.id);
      const job=jobs.get(row.sourceEventId)??{id:row.id,status:'queued'};
      jobs.set(row.sourceEventId,job);
      if(isolateOnNextAdmission){const capture=isolateOnNextAdmission;isolateOnNextAdmission=null;await capture();}
      return job;
    }
  };
  const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[],listModels:()=>[]};
  const open=dataRoot=>createGalgame({dataRoot,provider,cg,model:'fixture',deferredSaveRegistry:createDeferredSaves(),getLanguage:()=> 'en'});
  let game,recovered,afterCheckpoint;
  t.after(async()=>{
    await afterCheckpoint?.close();await recovered?.close();await game?.close();
    await rm(mirror,{recursive:true,force:true});await rm(root,{recursive:true,force:true});
  });
  const until=async check=>{for(let index=0;index<300;index++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Level gift fixture timeout');};
  game=await open(root);
  const {current:character}=await game.action('view'),at=Date.now()-3600000;
  for(let count=1;count<=29;count++)assert.equal((await game.touch({characterId:character,eventId:'prepare-level-'+count,at:at+count*61000})).affection,count);
  await game.flushSaves();
  let copied;
  const capture=new Promise((resolve,reject)=>{
    isolateOnNextAdmission=()=>cp(root,mirror,{recursive:true}).then(()=>{copied=true;resolve();},reject);
  });
  const milestone=await game.touch({characterId:character,eventId:'level-gift',at:at+30*61000});
  assert.equal(milestone.level,2);
  await until(()=>copied);
  await capture;
  const globalPath=dataRoot=>join(dataRoot,'galgame','storages','dsh-whale-galgame','global.json');
  const before=await readJson(createSnapshotStorage(globalPath(mirror)));
  assert.equal(before.characters[character].level,1,'captured only the SQLite commit before the engine checkpoint');
  assert.equal(jobs.size,1,'the independent job authority already accepted the level reward');
  recovered=await open(mirror);
  assert.equal((await recovered.action('view')).level,2);
  await until(()=>attempts.length===2);
  assert.deepEqual(attempts,[attempts[0],attempts[0]]);
  assert.equal(jobs.size,1);
  await recovered.flushSaves();
  const check=async()=>{
    const state=await readJson(createSnapshotStorage(globalPath(mirror))),hero=state.characters[character];
    assert.equal(hero.chatLines.filter(row=>row.who==='narrator'&&row.text.includes('reached Lv.2')).length,1);
    assert.equal(hero.cgs.filter(row=>row.kind==='level'&&row.id===attempts[0]).length,1);
  };
  await check();
  await recovered.close();
  afterCheckpoint=await open(mirror);
  assert.equal((await afterCheckpoint.action('view')).level,2);
  await afterCheckpoint.flushSaves();
  await check();
  assert.equal(attempts.length,2);
});

test('archived private speech pages keep scoped lines and pair with the actual next user message across pages',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {createCompanionLives}=await import('../src/companion-life-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  await store.mutate(state=>{state.cards.deepseek=makeCard({id:'deepseek',name:'DeepSeek'});state.activeConversationId=ownerId;state.migrated=true;});
  const {engine}=syntheticEngine({getStore:()=>store});
  const service=await createCompanionService({store,engine,dataRoot:root,provider:{enabled:false},r95Options:{tickAllowed:()=>false}});
  opened.push(service.close);
  const scope=service.r95.activeScope(),at=1730000000000,topic='remembered-dream';
  await store.mutate((state,tx)=>{
    state.lives[characterId].r95??={};
    for(const [id,offset] of [['first-response',2],['latest-unrelated',500]])tx.messages.append('private',ownerId,{id,role:'user',characterId,personaId,lifeId:scope.lifeId,createdAt:at+offset,text:id,status:'sent'});
    const put=(id,scope,mode,status,time)=>tx.records.put('life.r95.lines',characterId,id,{messageId:id,scope,mode,status,text:id,at:time,voicePresentation:[{status:'audioCompleted'}]},{array:true,at:['lives',characterId,'r95','lines']});
    put(topic,scope,'dream','read',at+1);
    put('still-visible',scope,'awake','awaiting-presentation',at+3);
    for(let index=0;index<105;index++)put('unrelated-'+index,{...scope,conversationId:'other-scope'},'awake','presented',at+10+index);
  });
  const visible=service.r95.view().lines;
  assert.deepEqual(visible.filter(line=>line.status!=='read').map(line=>line.messageId),['still-visible']);
  await service.action('companion-conversation-new',{characterId,title:'Separate current room'});
  const owners=await service.action('companion-conversation-list',{search:topic});
  assert.deepEqual(owners.conversations.map(row=>row.id),[ownerId]);
  assert.deepEqual((await service.action('companion-conversation-list',{search:'unrelated-104'})).conversations,[]);
  const history={ownerType:'private',ownerId,limit:1};
  const newest=await service.action('companion-history-page',history);
  assert.equal(newest.messages[0].id,'latest-unrelated');
  const next=await service.action('companion-history-page',{...history,before:newest.nextBefore});
  assert.equal(next.messages[0].historySpeech.line.messageId,'still-visible');
  const answered=await service.action('companion-history-page',{...history,before:next.nextBefore});
  assert.equal(answered.messages[0].id,'first-response');
  const oldest=await service.action('companion-history-page',{...history,before:answered.nextBefore});
  assert.equal(oldest.messages[0].historySpeech.line.messageId,topic);
  assert.equal(oldest.messages[0].historySpeech.reply,'first-response');
  assert.equal(oldest.messages[0].historySpeech.line.voicePresentation[0].status,'audioCompleted');
  const filtered=await service.action('companion-history-page',{...history,search:'remembered-dream'});
  assert.equal(filtered.totalCount,1);
  assert.equal(filtered.messages[0].historySpeech.reply,'first-response');
  assert.equal(store.messages.count('private',ownerId),2);
  const lives=await createCompanionLives({store,dataRoot:root,call:async action=>action==='companion-life-content'?{ok:true,content:{}}:{ok:true},syncCard:async()=>{},projectPersona:async()=>{}});
  const saved=await lives.save(characterId);
  await lives.reset(characterId);
  await lives.restore(saved.id);
  assert.notEqual(store.state.lives[characterId].operationId,scope.operationId);
  const restored=await service.action('companion-history-page',{...history,search:topic});
  assert.equal(restored.messages[0].historySpeech.reply,'first-response');
  assert.equal(restored.messages[0].historySpeech.line.scope.operationId,scope.operationId);
  assert.deepEqual(service.r95.view().lines,[],'A restored old-operation pending line is history, never a fresh live notification');
});

test('context accepts unrelated mood commits but repeats a reading whose original message changed',async t=>{
  const {store}=await fixture(t);
  const {createCompanionMemory}=await import('../src/companion-memory.mjs');
  const {companionFixture}=await import('./support/audit-harness.mjs');
  const source=await companionFixture({now:1730000000000}),id=source.activeConversationId,owner=source.conversations[id];
  const character=owner.characterId,persona=owner.personaId;
  const {messages,...metadata}=owner;
  const original={id:'scoped-source',role:'user',text:'current source',status:'sent',characterId:character,personaId:persona,lifeId:owner.lifeId,createdAt:1730000000000};
  await store.mutate((state,tx)=>{
    Object.assign(state,{...source,conversations:{[id]:metadata}});
    tx.messages.append('private',id,original);
  });
  let race,calls=0;
  const readMemory=store.readMemory.bind(store);
  store.readMemory=async(...args)=>{
    const result=await readMemory(...args);
    calls++;
    if(race)await race(calls);
    return result;
  };
  const memory=createCompanionMemory({store,autoStart:false,now:()=>1730003600000,runModel:async()=>{throw Error('Unexpected model request');}});
  const args={characterId:character,personaId:persona,conversationId:id,query:'source'};
  try{
    race=()=>store.mutate((state,tx)=>tx.records.put('life.r95.moodEvaluations',character,'new-mood',{at:Date.now()},{at:['lives',character,'r95','moodEvaluations']}));
    assert.ok((await memory.context(args)).messages.some(row=>row.text==='current source'));
    assert.equal(calls,1);
    calls=0;
    race=call=>call===1&&store.mutate((state,tx)=>tx.messages.update('private',id,original.id,row=>{row.text='corrected source';}));
    assert.ok((await memory.context(args)).messages.some(row=>row.text==='corrected source'));
    assert.equal(calls,2);
  }finally{await memory.close();}
});

test('production migration and rollback retain repeated logical IDs in the same live and nested archive owners',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-r14-duplicate-logical-'));
  let store;
  t.after(async()=>{await store?.close();await rm(root,{recursive:true,force:true});});
  const folder=join(root,'galgame'),oldPath=join(folder,'companion.json');
  await mkdir(folder);
  const repeated='preserve-this-original-id';
  const duplicates=[
    {...message(repeated),text:'Repeated logical id, first physical message',createdAt:3,favorite:true,occurrenceId:'original-field-retained'},
    {...message(repeated),text:'Repeated logical id, second physical message',createdAt:1,originalText:'Second original',revisions:[{text:'Earlier second incarnation',at:6}]},
    {...message('normal-peer'),text:'The following physical message',createdAt:2}
  ];
  const shared=duplicates.map((row,index)=>({...row,seq:index+1,status:'presented'}));
  const source={
    schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],revision:9,
    cards:{},personas:{},relationships:{},settings:{},
    conversations:{[ownerId]:{id:ownerId,characterId,personaId,messages:duplicates}},
    groups:{witnessed:{id:'witnessed',seq:shared.length,messages:shared}},
    lives:{[characterId]:{id:'old-life',restoredGroupEvidence:[{id:'archived',messages:shared}]}},
    lifeTransaction:{id:'archive-transaction',target:{conversations:[{id:ownerId,messages:duplicates}],groupEvidence:[{id:'sealed',messages:shared}]}}
  };
  const flat=JSON.stringify({...source,conversations:{}});
  await writeFile(oldPath,flat);
  const authoritative=JSON.stringify(source,null,2);
  await createSnapshotStorage(oldPath,{protectExisting:true,retention:false}).writeText(authoritative);
  try{store=await openCompanionStore(root);}
  catch(error){
    assert.equal(await readFile(oldPath,'utf8'),flat);
    assert.equal(await createSnapshotStorage(oldPath,{protectExisting:true}).readText(),authoritative);
    throw error;
  }
  assert.deepEqual(await store.snapshotAsync(),source);
  const latest=await store.messages.history('private',ownerId,{limit:2});
  const older=await store.messages.history('private',ownerId,{limit:2,before:latest.nextBefore});
  assert.deepEqual([...older.messages,...latest.messages].map(row=>[row.id,row.text]),duplicates.map(row=>[row.id,row.text]));
  assert.equal(latest.totalCount,duplicates.length);
  const pageRows=[...older.messages,...latest.messages];
  assert.equal(new Set(pageRows.map(row=>row.occurrenceId)).size,duplicates.length);
  assert.notEqual(pageRows[0].occurrenceId,duplicates[0].occurrenceId);
  assert.deepEqual(store.messages.get('private',ownerId,repeated,{occurrenceId:pageRows[0].occurrenceId}),duplicates[0]);
  const backups=await Promise.all((await readdir(folder)).filter(name=>name.startsWith('companion.pre-sqlite-')).map(name=>readFile(join(folder,name),'utf8')));
  assert.ok(backups.includes(authoritative));
  assert.ok(backups.includes(flat));
  await store.close();
  store=await openCompanionStore(root);
  assert.deepEqual(await store.snapshotAsync(),source);
  await store.close();
  const receipt=await exportCompanionForRollback(root);
  const exported=JSON.parse(await readFile(receipt.exportPath,'utf8'));
  assert.deepEqual(exported,source);
  assert.deepEqual(JSON.parse(await createSnapshotStorage(oldPath,{protectExisting:true}).readText()),source);
  assert.equal(receipt.messageCount,15);
});

test('message history selects the exact repeated occurrence for editing and favoriting',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {companionFixture,syntheticEngine}=await import('./support/audit-harness.mjs');
  const seed=await companionFixture(),id=seed.activeConversationId,owner=seed.conversations[id];
  const {messages,...metadata}=owner;
  const sameId={...messages[0],id:'two-user-copies',occurrenceId:'legacy-field',favorite:false};
  const original={...sameId,text:'First exact original'};
  const sibling={...sameId,text:'Second exact original'};
  await store.mutate((state,tx)=>{
    Object.assign(state,{...seed,conversations:{[id]:metadata}});
    tx.messages.append('private',id,original);
    tx.messages.append('private',id,sibling,{preserveDuplicate:true});
  });
  const {engine}=syntheticEngine({getStore:()=>store});
  const service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot:root});
  opened.push(service.close);
  const page=await service.action('companion-history-page',{ownerType:'private',ownerId:id,limit:2});
  const [first,second]=page.messages;
  assert.notEqual(first.occurrenceId,second.occurrenceId);
  assert.notEqual(first.occurrenceId,sameId.occurrenceId);
  const target={conversationId:id,id:sameId.id};
  await assert.rejects(service.action('companion-message-edit',{...target,text:'wrong'}),{code:'COMPANION_MESSAGE_AMBIGUOUS'});
  await assert.rejects(service.action('companion-message-favorite',target),{code:'COMPANION_MESSAGE_AMBIGUOUS'});
  await assert.rejects(service.action('companion-message-favorite',{...target,id:'different',occurrenceId:second.occurrenceId}),/消息不存在/);
  const selected={...target,occurrenceId:second.occurrenceId};
  const result=await service.action('companion-message-edit',{...selected,text:'Second exact edit'});
  assert.equal(result.message.occurrenceId,second.occurrenceId);
  assert.equal(result.message.originalText,sibling.text);
  await service.action('companion-message-favorite',{...selected,value:true});
  await service.close();
  await store.close();
  const reopened=await openCompanionStore(root);
  opened.push(reopened.close);
  const rows=(await reopened.snapshotAsync()).conversations[id].messages;
  assert.equal(rows[0].text,original.text);
  assert.equal(rows[0].favorite,false);
  assert.equal(rows[1].text,'Second exact edit');
  assert.equal(rows[1].favorite,true);
  assert.deepEqual(rows.map(row=>row.occurrenceId),['legacy-field','legacy-field']);
  assert.equal((await reopened.messages.history('private',id,{favorites:true})).messages[0].occurrenceId,second.occurrenceId);
});

test('a pre-release v1 fence fails closed without rewriting its database or snapshots',async t=>{
  const {root,store}=await fixture(t);
  await store.close();
  const path=pathOf(root),database=new DatabaseSync(path);
  database.exec("PRAGMA user_version=1; UPDATE meta SET value='r14-companion-sqlite-v1' WHERE key='minimumWriter';");
  database.close();
  const file=join(root,'galgame','companion.json'),disk=createSnapshotStorage(file,{protectExisting:true});
  const data=JSON.parse(await disk.readText());
  data.minimumWriter='r14-companion-sqlite-v1';
  data.requiredCapabilities=['companion-message-rows-v1'];
  const fence=JSON.stringify(data);
  await disk.writeText(fence);
  await writeFile(file,fence);
  const before=await readFile(path);
  const contents=await readdir(join(root,'galgame'));
  await assert.rejects(openCompanionStore(root),/Unsupported companion migration fence/);
  assert.deepEqual(await readFile(path),before);
  assert.equal(await readFile(file,'utf8'),fence);
  assert.equal(await createSnapshotStorage(file,{protectExisting:true}).readText(),fence);
  assert.deepEqual(await readdir(join(root,'galgame')),contents,'No replacement database or backup was written');
});

test('worker memory keeps identical repeated originals and a sparse life ZIP preserves witnessed group occurrence provenance',async t=>{
  const {root,store,opened}=await fixture(t);
  const destination=await mkdtemp(join(tmpdir(),'companion-r14-detached-occurrence-'));
  t.after(()=>rm(destination,{recursive:true,force:true}));
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {createCompanionMemory}=await import('../src/companion-memory.mjs');
  const {companionFixture,syntheticEngine}=await import('./support/audit-harness.mjs');
  const now=()=>1730000000000,seed=await companionFixture({now:now()}),id=seed.activeConversationId,character=seed.activeCharacterId;
  const {messages,...owner}=seed.conversations[id],groupId='sequence-collision';
  const user={...messages[0],id:'repeat-user',text:'Identical preserved private text'};
  const twice={...user,personaId:'default',id:'repeat-group',text:'Identical witnessed group text',createdAt:now()-2};
  const groupRows=[{...twice,seq:10},{...twice,seq:20}];
  const intervals=[{start:10,end:20}];
  await store.mutate((state,tx)=>{
    Object.assign(state,{...seed,conversations:{[id]:owner},groups:{[groupId]:{id:groupId,name:'Fixture',personaId:'default',memberIds:[character],mutedIds:[],seq:20,intervals:{[character]:intervals}}}});
    for(const row of [user,user])tx.messages.append('private',id,row,{preserveDuplicate:true});
    for(const row of groupRows)tx.messages.append('group',groupId,row,{preserveDuplicate:true});
    tx.records.put('life.groupIntervals',character,groupId,intervals,{at:['lives',character,'groupIntervals']});
    tx.records.define('group.intervals',JSON.stringify([groupId,character]),{array:true,at:['groups',groupId,'intervals',character]});
    tx.records.put('group.intervals',JSON.stringify([groupId,character]),'10',intervals[0]);
  });
  const {engine}=syntheticEngine({getStore:()=>store});
  const service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot:root,now});
  opened.push(service.close);
  await store.mutate(state=>{
    state.groups[groupId].duplicateMessageSeqs=[10];
    state.lives[character].restoredGroupEvidence=[{id:'unrelated-marker',personaId:'default',duplicateMessageSeqs:37}];
  });
  const memory=createCompanionMemory({store,now,autoStart:false,runModel:async()=>{throw Error('Unexpected model request');}});
  opened.push(memory.close);
  const privateMemory=await memory.view({characterId:character,personaId:'default',conversationId:id});
  const originals=privateMemory.events.filter(event=>event.source.messageId===user.id);
  assert.equal(originals.length,2);
  assert.equal(new Set(originals.map(event=>event.id)).size,2);
  assert.deepEqual(originals.map(event=>event.text),[user.text,user.text]);
  const both=await memory.view({characterId:character,personaId:'default',groupId});
  const witnessed=both.events.filter(event=>event.source.messageId===twice.id);
  assert.deepEqual(witnessed.map(event=>event.source.seq).sort((a,b)=>a-b),[10,20]);
  assert.equal(witnessed.find(event=>event.source.seq===10).source.messageOccurrence,undefined,'Unknown live metadata cannot rekey the first original');
  assert.equal((await store.snapshotAsync()).lives[character].restoredGroupEvidence[0].duplicateMessageSeqs,37);
  const expectedId=witnessed.find(event=>event.source.seq===20).id;
  await store.mutate((state,tx)=>{
    delete state.groups[groupId].duplicateMessageSeqs;
    delete state.lives[character].restoredGroupEvidence;
    tx.records.put('life.groupIntervals',character,groupId,[{start:20,end:20}]);
  });
  const sparse=await memory.view({characterId:character,personaId:'default',groupId});
  assert.deepEqual(sparse.events.filter(event=>event.source.messageId===twice.id).map(event=>event.id),[expectedId]);
  const saved=await service.action('companion-life-save',{characterId:character});
  const exported=await service.action('companion-life-export',{id:saved.archive.id});
  const detached=await openCompanionStore(destination);
  let target;
  try{
    await detached.mutate(state=>Object.assign(state,{...seed,conversations:{[id]:owner}}));
    const {engine:targetEngine}=syntheticEngine({getStore:()=>detached});
    target=await createCompanionService({store:detached,engine:targetEngine,provider:{enabled:false},dataRoot:destination,now});
    const imported=await target.action('companion-life-import',{base64:exported.archive.base64});
    await target.action('companion-life-restore',{id:imported.archive.id});
    const restored=await detached.snapshotAsync(),copies=restored.lives[character].restoredGroupEvidence;
    assert.equal(restored.groups[groupId],undefined);
    assert.deepEqual(copies[0].messages,[groupRows[1]]);
    assert.deepEqual(copies[0].duplicateMessageSeqs,[20]);
    assert.equal(detached.state.lives[character].restoredGroupEvidence[0].duplicateMessageSeqs,undefined);
    assert.deepEqual(restored.conversations[id].messages.map(row=>row.id),[user.id,user.id]);
    const recovered=createCompanionMemory({store:detached,now,autoStart:false,runModel:async()=>{throw Error('Unexpected model request');}});
    try{
      const context=await recovered.view({characterId:character,personaId:'default',conversationId:id});
      assert.deepEqual(context.events.filter(event=>event.source.messageId===twice.id).map(event=>event.id),[expectedId]);
      assert.deepEqual(context.events.filter(event=>event.source.messageId===user.id).map(event=>event.id).sort(),originals.map(event=>event.id).sort());
    }finally{await recovered.close();}
  }finally{await target?.close();await detached.close();}
});

test('group audio receipts and explicit acknowledgement resolve the current round even if two older rows share its ID',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {companionFixture,syntheticEngine}=await import('./support/audit-harness.mjs');
  const seed=await companionFixture(),id=seed.activeConversationId;
  const {messages,...owner}=seed.conversations[id];
  await store.mutate(state=>Object.assign(state,{...seed,conversations:{[id]:owner}}));
  const {engine}=syntheticEngine({getStore:()=>store}),segments=[];
  const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),async *stream({purpose}){
    if(purpose==='group-chat'){
      for(const row of [{type:'decision',speak:true},{type:'segment',text:'Current voiced occurrence.',performance:{emotion:'normal'}},{type:'control',interactionTarget:'group',affectionTarget:'none',affection:0}]){
        yield {type:'text-delta',text:JSON.stringify(row)+'\n'};
      }
    }
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  const voice={admit:()=>({epoch:1,voiceProfileVersion:1}),segment:event=>segments.push(event),finish:()=>{}};
  const service=await createCompanionService({store,engine,provider,voice,dataRoot:root});
  opened.push(service.close);
  const {group}=await service.action('companion-group-save',{memberIds:['claude','gpt'],mode:'list'});
  await service.action('companion-group-select',{id:group.id});
  await service.action('companion-group-send',{id:group.id,text:'Test current reply'});
  let live;
  for(let count=0;count<300;count++){
    live=service.viewState().groupRuntime;
    assert.notEqual(live.status,'failed',live.error);
    if(live.pendingMessage)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  const pending=live.pendingMessage,envelope=segments[0]?.envelope;
  assert.equal(envelope?.requestId,pending?.id);
  assert.equal(envelope.roundId,live.roundId);
  const stale={...pending,status:'presented'};
  const historical=[];
  await store.mutate((state,tx)=>{
    for(const text of ['Older physical reply one','Older physical reply two']){
      const row={...stale,text,seq:++state.groups[group.id].seq};
      delete row.voicePresentation;
      delete row.autoRequestId;
      historical.push(row);
      tx.messages.append('group',group.id,row,{preserveDuplicate:true});
    }
  });
  const args={id:group.id,requestId:pending.id,roundId:live.roundId};
  await assert.rejects(service.action('companion-group-present',{...args,roundId:'stale-round'}),{code:'GROUP_PRESENTATION_STALE'});
  assert.deepEqual(await service.voiceReceipt({envelope:{...envelope,roundId:'stale-round'},status:'audioCompleted'}),{accepted:false,ready:false});
  assert.equal((await service.action('companion-group-present',args)).presentationDeferred,true);
  assert.equal((await service.voiceReceipt({envelope,status:'audioStarted'})).accepted,true);
  assert.equal((await service.voiceReceipt({envelope,status:'audioCompleted',playedMs:333})).ready,true);
  await service.action('companion-group-present',args);
  const rows=(await store.snapshotAsync()).groups[group.id].messages.filter(row=>row.id===pending.id);
  assert.deepEqual(rows.slice(0,2),historical);
  assert.equal(rows.length,3);
  assert.equal(rows[2].text,pending.text);
  assert.deepEqual(rows[2].voicePresentation.map(row=>row.status),['audioStarted','audioCompleted']);
  assert.equal(rows[2].voicePresentation.at(-1).playedMs,333);
  assert.equal(service.viewState().groupRuntime.status,'awaiting-continue');
});

test('legacy engine replay preserves repeated explicit IDs and its copy ledger prevents replay on reopen',async t=>{
  const {root,store,opened}=await fixture(t);
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {companionFixture,syntheticEngine}=await import('./support/audit-harness.mjs');
  const seed=await companionFixture(),character=seed.activeCharacterId,ownerId=seed.activeConversationId;
  const {messages,...owner}=seed.conversations[ownerId];
  seed.lives[character].legacyImportEnabled=true;
  await store.mutate(state=>Object.assign(state,{...seed,conversations:{[ownerId]:owner}}));
  const repeated='legacy-explicit-repeat',at=1730000000000;
  const history={[character]:[
    {id:repeated,who:'user',text:'Original first occurrence',at},
    {id:repeated,who:'heroine',text:'Original second occurrence',at:at+1}
  ]};
  const boot=async store=>{
    const {engine}=syntheticEngine({getStore:()=>store,history});
    const service=await createCompanionService({store,engine,provider:{enabled:false}});
    opened.push(service.close);
    return service;
  };
  const read=store=>store.messages.recent('private',ownerId).map(row=>[row.id,row.role,row.text,row.createdAt]);
  const expected=history[character].map((row,index)=>[row.id,index?'assistant':'user',row.text,row.at]);
  const service=await boot(store);
  assert.deepEqual(read(store),expected);
  await service.close();await store.close();
  const reopened=await openCompanionStore(root);
  opened.push(reopened.close);
  await boot(reopened);
  assert.deepEqual(read(reopened),expected);
});
test('conversation import scopes the temporary statement journal and rolls back body or COMMIT failures',async t=>{
  const root=await mkdtemp(join(tmpdir(),'r17-import-temp-journal-'));
  const {createGalgame}=await import('../src/galgame-host.mjs');
  const game=await createGalgame({dataRoot:root,provider:{enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'})},model:'fixture',automaticWorkAllowed:()=>false});
  t.after(async()=>{await game.close();await rm(root,{recursive:true,force:true});});
  const sql=new DatabaseSync(pathOf(root));
  try{sql.exec(`CREATE TRIGGER r17_import_body_failure BEFORE INSERT ON messages
    WHEN NEW.message_id='r17-import-body-2' BEGIN SELECT RAISE(ABORT,'r17 injected import body failure'); END;`);}
  finally{sql.close();}
  const exec=DatabaseSync.prototype.exec,probe=[];
  const mode=db=>db.prepare('PRAGMA temp_store').get().temp_store;
  let phase,writer;
  t.mock.method(DatabaseSync.prototype,'exec',function(statement,...args){
    if(phase&&/^PRAGMA temp_store\s*=\s*(?:MEMORY|2)$/i.test(statement)){writer=this;probe.push({phase,before:mode(this)});}
    if(phase&&this===writer&&statement==='BEGIN IMMEDIATE')probe.at(-1).during=mode(this);
    if(phase==='commit'&&this===writer&&statement==='COMMIT')throw Error('r17 injected import COMMIT failure');
    const result=exec.call(this,statement,...args);
    if(this===writer&&phase&&/^PRAGMA temp_store\s*=\s*[01]$/i.test(statement))probe.at(-1).after=mode(this);
    return result;
  });
  const importedRows=()=>{
    const db=new DatabaseSync(pathOf(root),{readOnly:true});
    try{return db.prepare("SELECT message_id AS id FROM messages WHERE message_id LIKE 'r17-import-%' ORDER BY message_id").all().map(row=>row.id);}
    finally{db.close();}
  };
  const importRows=async stage=>{
    phase=stage;
    const at=1730000000000;
    try{return await game.action('companion-conversation-import',{data:{format:'ai-buddy-conversations',version:1,conversations:[{
      id:'r17-import-fixture-'+stage,characterId,personaId,title:'Synthetic import',createdAt:at,updatedAt:at,
      messages:[1,2].map(n=>({id:'r17-import-'+stage+'-'+n,role:n===1?'user':'assistant',text:'fixture '+n,createdAt:at+n}))
    }]}});}
    finally{phase=undefined;}
  };
  assert.equal((await importRows('success')).ok,true);
  assert.equal(probe.length,1);
  assert.equal(probe[0].during,2);
  assert.equal(probe[0].after,probe[0].before);
  const saved=['r17-import-success-1','r17-import-success-2'];
  assert.deepEqual(importedRows(),saved);
  await assert.rejects(importRows('body'),/r17 injected import body failure/);
  assert.deepEqual(importedRows(),saved);
  await assert.rejects(importRows('commit'),/r17 injected import COMMIT failure/);
  assert.deepEqual(importedRows(),saved);
  assert.deepEqual(probe.map(row=>row.phase),['success','body','commit']);
  for(const observed of probe){assert.equal(observed.during,2);assert.equal(observed.after,observed.before);}
  assert.notEqual(mode(writer),2,'the ordinary connection retained its default');
});

for(const restored of ['throws','no effect'])test('conversation import preserves its SQL failure if journal policy restoration '+restored,async t=>{
  const {openCompanionDatabase}=await import('../src/companion-sqlite.mjs');
  const root=await mkdtemp(join(tmpdir(),'r17-import-journal-double-fault-')),path=join(root,'companion.sqlite');
  const writer=openCompanionDatabase(path,{initial:{schema:2,revision:0,cards:{},conversations:{},lives:{}}});
  t.after(async()=>{writer.close();await rm(root,{recursive:true,force:true});});
  const faultActor=new DatabaseSync(path);
  try{faultActor.exec("CREATE TRIGGER r17_injected BEFORE INSERT ON messages WHEN NEW.message_id='r17-fail-two' BEGIN SELECT RAISE(ABORT,'original SQLite failure'); END;");}
  finally{faultActor.close();}
  const staged=writer.stage();
  staged.api.messages.define('private',ownerId,['conversations',ownerId]);
  staged.api.messages.append('private',ownerId,message('r17-accepted-one'));
  staged.api.messages.append('private',ownerId,message('r17-fail-two'));
  const exec=DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype,'exec',function(statement,...args){
    if(/^PRAGMA temp_store=[01]$/.test(statement)){
      if(restored==='throws')throw Error('injected restore failure');
      return;
    }
    return exec.call(this,statement,...args);
  });
  assert.throws(()=>writer.commit(staged,{revision:1},0,false,false,'conversation-import'),error=>{
    assert.equal(error.code,'COMPANION_STORE_REOPEN_REQUIRED');
    assert.match(error.cause.message,/original SQLite failure/);
    assert.match(error.errors[1].message,restored==='throws'?/injected restore failure/:/setting did not match/);
    return true;
  });
  assert.equal(writer.load().revision,0);
  assert.equal(writer.messages.count('private',ownerId),0);
});

test('seeded migration scopes the temporary statement journal to its atomic initializer',async t=>{
  const {companionWriterPragmas,openCompanionDatabase}=await import('../src/companion-sqlite.mjs');
  const cases=[
    {name:'success restores FILE',prior:1},
    {name:'success retains an existing MEMORY policy',prior:2},
    {name:'body failure restores DEFAULT',prior:0,body:true},
    {name:'COMMIT failure restores FILE',prior:1,commit:true},
    {name:'body failure and restore mismatch retain both errors',prior:0,body:true,restore:'ignore'},
    {name:'COMMIT failure and restore failure retain both errors',prior:1,commit:true,restore:'throw'},
    {name:'empty seed keeps DEFAULT',prior:0,empty:true}
  ];
  for(const scenario of cases)await t.test(scenario.name,async t=>{
    const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r17-seed-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const path=join(root,'companion.sqlite');
    const {exec,prepare}=DatabaseSync.prototype;
    const mode=db=>prepare.call(db,'PRAGMA temp_store').get().temp_store;
    const observed={};
    let connection;
    const bodyFailure='r17 injected seed body failure',commitFailure=Error('r17 injected seed COMMIT failure');
    const restoreFailure=Error('r17 injected seed restore failure');
    t.mock.method(DatabaseSync.prototype,'exec',function(sql){
      if(sql===companionWriterPragmas){
        connection=this;
        exec.call(this,sql);
        if(scenario.prior!==0)exec.call(this,'PRAGMA temp_store='+scenario.prior);
        observed.before=mode(this);
        return;
      }
      if(this===connection){
        if(sql==='BEGIN IMMEDIATE')observed.begin=mode(this);
        if(sql==='COMMIT'){
          observed.commit=mode(this);
          if(scenario.commit)throw commitFailure;
        }
        if(sql==='ROLLBACK')observed.rollback=mode(this);
        if(/^PRAGMA temp_store=[01]$/.test(sql)){
          if(scenario.restore==='ignore')return;
          if(scenario.restore==='throw')throw restoreFailure;
        }
      }
      return exec.call(this,sql);
    });
    t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
      if(this===connection&&sql.startsWith('INSERT INTO messages VALUES(')){
        observed.insert=mode(this);
        if(scenario.body)exec.call(this,"CREATE TRIGGER r17_fail_second_seed BEFORE INSERT ON messages WHEN NEW.message_id='seed-second' BEGIN SELECT RAISE(ABORT,'"+bodyFailure+"'); END;");
      }
      return prepare.call(this,sql);
    });
    const close=DatabaseSync.prototype.close;
    t.mock.method(DatabaseSync.prototype,'close',function(){
      if(this===connection)observed.close=mode(this);
      return close.call(this);
    });
    const replies=[message('seed-first'),message('seed-second')];
    const initialize=()=>openCompanionDatabase(path,{
      initial:{schema:2,revision:12,cards:{},conversations:{[ownerId]:{id:ownerId}},lives:{}},
      metadata:{verified:false},
      seed:scenario.empty?[]:replies.map((message,ordinal)=>({type:'private',ownerId,ordinal,message})),
      seedOwners:[{type:'private',ownerId,at:['conversations',ownerId]}]
    });
    if(scenario.body||scenario.commit){
      assert.throws(initialize,error=>{
        const original=scenario.restore?error.cause:error;
        if(scenario.body)assert.match(original.message,/r17 injected seed body failure/);
        else assert.equal(original,commitFailure);
        if(scenario.restore){
          assert.equal(error.code,'COMPANION_STORE_REOPEN_REQUIRED');
          assert.equal(error.errors[0],original);
          if(scenario.restore==='throw')assert.equal(error.errors[1],restoreFailure);
          else assert.match(error.errors[1].message,/setting did not match/);
        }
        return true;
      });
      const reader=new DatabaseSync(path,{readOnly:true});
      try{
        assert.equal(reader.prepare('PRAGMA user_version').get().user_version,0);
        assert.equal(reader.prepare('SELECT count(*) AS count FROM sqlite_schema').get().count,0);
      }finally{reader.close();}
    }else{
      const writer=initialize();
      try{
        assert.equal(writer.load().revision,12);
        assert.equal(writer.messages.count('private',ownerId),scenario.empty?0:replies.length);
        assert.equal(mode(connection),scenario.prior);
      }finally{writer.close();}
    }
    const active=scenario.empty?scenario.prior:2;
    assert.equal(observed.before,scenario.prior);
    assert.equal(observed.begin,active);
    if(!scenario.empty)assert.equal(observed.insert,2);
    if(!scenario.body)assert.equal(observed.commit,active);
    if(scenario.body||scenario.commit)assert.equal(observed.rollback,2);
    assert.equal(observed.close,scenario.restore?2:scenario.prior);
    assert.equal(connection.isOpen,false);
  });
});

for(const failCommit of [false,true])test(
  'seeded migration preserves both legacy sources '+(failCommit?'when COMMIT and journal restoration fail':'when journal restoration fails after COMMIT'),async t=>{
  const {readCompanionSqliteMetadata}=await import('../src/companion-sqlite.mjs');
  const root=await mkdtemp(join(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir(),'companion-r17-seed-publish-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'galgame'),legacyPath=join(directory,'companion.json'),path=pathOf(root);
  const source={
    schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],
    revision:6,cards:{},personas:{[personaId]:{id:personaId,name:'Test'}},relationships:{},
    conversations:{[ownerId]:{id:ownerId,personaId,characterId,messages:[message('seed-first'),message('seed-second')]}},
    groups:{},lives:{},settings:{}
  };
  const flat=JSON.stringify({...source,conversations:{}}),journal=JSON.stringify(source,null,2);
  await mkdir(directory);
  await writeFile(legacyPath,flat);
  const disk=createSnapshotStorage(legacyPath,{protectExisting:true,retention:false});
  await disk.writeText(journal);
  const before=await disk.stat();

  // Preload the fault into the real migration worker's SQLite connection.
  const preload=[
    "import {DatabaseSync} from 'node:sqlite';",
    "import {workerData} from 'node:worker_threads';",
    "const exec=DatabaseSync.prototype.exec;",
    "DatabaseSync.prototype.exec=function(sql){",
    "  if(workerData.failCommit&&sql==='COMMIT')throw Error('r17 injected seed COMMIT failure');",
    "  if(/^PRAGMA temp_store=[01]$/.test(sql))throw Error('r17 injected seed restore failure');",
    "  return exec.call(this,sql);",
    "};"
  ].join('\n');
  const worker=new Worker(new URL('../src/companion-storage-worker.mjs',import.meta.url),{
    workerData:{operation:'migrate',path,legacyPath,failCommit},
    execArgv:['--import','data:text/javascript,'+encodeURIComponent(preload)]
  });
  const phases=[];
  let failure;
  worker.on('message',({progress,error})=>{
    if(progress)phases.push(progress.phase);
    if(error)failure=error;
  });
  assert.deepEqual(await once(worker,'exit'),[0]);
  assert.equal(failure?.code,'COMPANION_STORE_REOPEN_REQUIRED');
  assert.match(failure.message,/temporary journal setting could not be restored/);
  assert.match(failure.message,/r17 injected seed restore failure/);
  assert.match(failure.message,failCommit?/r17 injected seed COMMIT failure/:/committed/);
  assert.deepEqual(phases,['discovered','backed-up','partitioned']);
  const names=await readdir(directory);
  assert.ok(!names.includes('companion.sqlite'));
  const staged=names.filter(name=>/^companion\.sqlite\.migrating-[\da-f-]+$/.test(name));
  assert.equal(staged.length,1);
  const working=join(directory,staged[0]);
  if(failCommit)assert.throws(()=>readCompanionSqliteMetadata(working),/Unsupported companion database schema/);
  else assert.equal(readCompanionSqliteMetadata(working).verified,false);
  assert.equal(await readFile(legacyPath,'utf8'),flat);
  const reopenedJournal=createSnapshotStorage(legacyPath,{protectExisting:true,retention:false});
  assert.equal(await reopenedJournal.readText(),journal);
  assert.equal((await reopenedJournal.stat()).version,before.version);

  const reopened=await openCompanionStore(root);
  try{assert.deepEqual(reopened.messages.recent('private',ownerId,2),source.conversations[ownerId].messages);}
  finally{await reopened.close();}
});
