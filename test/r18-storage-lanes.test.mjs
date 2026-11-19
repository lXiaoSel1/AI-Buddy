import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {createAutoService} from '../src/companion-auto.mjs';
import {groupAutoNamespace,groupAutoOwner} from '../src/companion-partitions.mjs';
import {saveGroupAutoRecord} from '../src/companion-record-access.mjs';
import {ensureLives,lifeToken} from '../src/companion-life.mjs';
import {createMediaStore} from '../src/media-store.mjs';
import {makeCard,openCompanionStore} from '../src/companion-store.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {runCompanionStorageWorker} from '../src/companion-storage-worker-client.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4kAAAAASUVORK5CYII=';
const characterId='deepseek',personaId='default',groupId='group',now=()=>1_800_000_000_000;

test('Auto evicts a durable receipt within one second while a life archive keeps the reader busy',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-auto-lane-'));
 const long=process.env.AI_BUDDY_R18_LONG_READER_STALL==='1';
 let store;
 try{
  store=await openCompanionStore(root,{publishLifeRestoreTimeoutMs:long?30_000:650});
  await store.mutate(state=>{
   state.cards[characterId]={...makeCard({id:characterId,name:'Synthetic'}),avatar:png,sprite:png,backgroundImage:png,referenceImage:png};
   state.groups[groupId]={id:groupId,personaId,memberIds:[characterId]};
   state.r95={settings:{auto:true}};
   ensureLives(state,now());
  });
  const life=lifeToken(store.state,characterId);
  const scope={characterId,personaId,conversationId:groupId,channel:'app-group',...life};
  const auto=createAutoService({store,now,dispatchTurn:async()=>{}});
  const session=await auto.start({groupId,scope,authorizationId:'initial',mode:'until-stopped'});
  await store.mutate((state,tx)=>{
   for(let i=0;i<200;i++)saveGroupAutoRecord(store,state.groups[groupId].auto,groupId,session.id,'completed','old-'+i,
    {requestId:'old-'+i,status:'silent',evidenceId:'receipt-'+i,at:now()-200+i},tx);
  });
  const pending=await auto.next({groupId}),entered=Promise.withResolvers();
  let calls=0,archiveFinished=false,archiveMs;
  const archiveStart=performance.now();
  const saving=store.snapshotLifeArchive({
   characterId,token:life,kind:'save',metadata:{},savedAt:now(),content:{},hasImageCodec:true
  },{onImage:async()=>{
   calls++;
   if(calls===1)entered.resolve();
   await wait(long?4375:350);
   return true;
  }}).then(value=>{
   archiveFinished=true;
   archiveMs=performance.now()-archiveStart;
   return value;
  });
  // Keep a handler attached before the mutation can time out and stop a lane.
  const archiveResult=Promise.allSettled([saving]);
  await Promise.race([entered.promise,saving]);
  const start=performance.now();
  const [eviction]=await Promise.allSettled([auto.commitOpportunity({
   groupId,requestId:pending.requestId,status:'silent',evidenceId:'new-receipt'
  })]);
  const evictionMs=performance.now()-start,archivedWhileBusy=!archiveFinished;
  const [publication]=await archiveResult;
  t.diagnostic('Auto '+evictionMs.toFixed(2)+' ms; archive '+archiveMs?.toFixed(2)+' ms; image calls '+calls);
  assert.equal(eviction.status,'fulfilled',eviction.reason?.message);
  assert.equal(eviction.value.committed,true);
  assert.ok(archivedWhileBusy&&evictionMs<=1000);
  assert.equal(publication.status,'fulfilled',publication.reason?.message);
  assert.ok(archiveMs>=(long?35_000:1400));
  const namespace=groupAutoNamespace('completed'),owner=groupAutoOwner(groupId,session.id);
  assert.equal(store.records.count(namespace,owner),200);
  assert.equal(store.records.get(namespace,owner,'old-0'),undefined);
  assert.equal(store.archive.get('auto-completed:'+session.id,'old-0').evidenceId,'receipt-0');
 }finally{
  await store?.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('life reset and save publish a first new multi-megabyte avatar without writing SQLite on the main thread',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-life-large-'));
 const publishes=[];
 let store;
 const prepare=DatabaseSync.prototype.prepare,localStateWrites=[];
 try{
  DatabaseSync.prototype.prepare=function(sql,...args){
   const statement=prepare.call(this,sql,...args);
   if(/^UPDATE state(?:_sections)? SET /.test(sql)){
    const run=statement.run.bind(statement);
    statement.run=(...args)=>{localStateWrites.push(sql);return run(...args);};
   }
   return statement;
  };
  store=await openCompanionStore(root,{runLifeArchiveMetadata:(data,...args)=>{
   publishes.push(data.writeOperation);
   return runCompanionStorageWorker(data,...args);
  }});
  await store.mutate(state=>{
   state.cards[characterId]=makeCard({id:characterId,name:'Synthetic'});
   ensureLives(state,now());
  });
  const avatar='data:image/png;base64,'+Buffer.alloc(4*1024*1024,0x61).toString('base64');
  const life=await createCompanionLives({store,dataRoot:root,now,imageCodec:()=>true,
   call:async action=>action==='companion-life-content'?{
    ok:true,content:{cgs:Array.from({length:2400},(_,i)=>({id:'cg-'+i+'x'.repeat(96),status:'ready'}))}
   }:{ok:true},syncCard:async()=>{},projectPersona:async()=>{}});
  localStateWrites.length=0;
  await life.reset(characterId,{mode:'normal',card:{...store.state.cards[characterId],avatar}});
  assert.equal(store.state.cards[characterId].avatar,avatar);
  const saved=await life.save(characterId);
  assert.equal(store.records.get('root.lifeArchives','',saved.id).avatar,avatar);
  assert.ok(publishes.length>=2,'life metadata worker receives both publications');
  assert.deepEqual(localStateWrites,[]);
  await store.close();
  store=await openCompanionStore(root);
  assert.equal(store.state.cards[characterId].avatar,avatar);
  assert.equal(store.records.get('root.lifeArchives','',saved.id).avatar,avatar);
 }finally{
  DatabaseSync.prototype.prepare=prepare;
  await store?.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('scoped life publishes new media through its content-addressed worker without a main put',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-life-media-'));
 const diskMedia=createMediaStore(root);
 let puts=0,store;
 const media={...diskMedia,put(value){puts++;return diskMedia.put(value);}};
 try{
  store=await openCompanionStore(root,{media});
  await store.mutate(state=>{
   state.cards[characterId]=makeCard({id:characterId,name:'Synthetic'});
   ensureLives(state,now());
  });
  const avatar='data:image/png;base64,'+Buffer.alloc(4*1024*1024,0x2a).toString('base64');
  const life=await createCompanionLives({store,dataRoot:root,media,now,imageCodec:()=>true,
   call:async()=>({ok:true}),syncCard:async()=>{},projectPersona:async()=>{}});
  await life.reset(characterId,{mode:'normal',card:{...store.state.cards[characterId],avatar}});
  const ref=store.state.cards[characterId].avatar;
  assert.equal(media.resolve(ref),avatar);
  assert.equal(media.has(ref),true);
  assert.equal(puts,0);
  const saved=await life.save(characterId);
  assert.equal(media.resolve(store.records.get('root.lifeArchives','',saved.id).avatar),avatar);
 }finally{await store?.close();await rm(root,{recursive:true,force:true});}
});
