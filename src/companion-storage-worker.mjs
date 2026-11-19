import {parentPort,workerData} from 'node:worker_threads';
import {receiveLifeMetadata} from './companion-life-metadata-wire.mjs';
import {enablePatches,Immer} from 'immer';
import {materializeCompanionData,partitionCompanionData,partitionGroupAutoEvidence} from './companion-partitions.mjs';
import {DatabaseSync} from 'node:sqlite';
import {applyGrowthCandidates} from './companion-growth.mjs';
import {createEvidenceArchive,hasArchivedAutoAuthorization} from './evidence-archive.mjs';
import {writeValidatedPortableImages} from './companion-media.mjs';
import {expandLifeArchiveArtwork,locateLifeCardArtwork,readLifeCardArtwork} from './companion-life-card-artwork.mjs';
import {lifeImageChunkBytes,lifeImageConversionDeadlineMs,lifeImageGate as imageGate,maxLifeImageBytes,maxLifeThumbnailBytes} from './companion-life-image-wire.mjs';
import {compactAutoGroups} from './auto-evidence.mjs';
import {createCompanionMemory} from './companion-memory.mjs';
import {boundedMemoryRecordPlanBytes,memoryRecordBatchRows,memoryRecordBatchBytes} from './companion-storage-worker-client.mjs';
import {resolveLegacySocialIdentity,resolveSocialExpressionIdentity} from './companion-social-memory-proof.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmdirSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareMediaMaintenance} from './media-migration.mjs';
import {applyLegacyDedupe,planLegacyDedupe} from './legacy-dedupe.mjs';
import {isDeepStrictEqual} from 'node:util';
import {writeAtomic} from './atomic-write.mjs';
import {writeLifeRestoreSource,readLifeRestoreSource,removeLifeRestoreSource,cleanOrphanLifeRestoreSources} from './companion-life-restore-source.mjs';
import {createMediaStore,resolveStateImages,imageSlots} from './media-store.mjs';
import {createLifeArchiveRepository} from './companion-life-archive.mjs';
import {archiveBase64Bytes,buildLifeArchiveSnapshot,lifeArchiveMetadata,lifeRestorePlan,projectLifeArchivePreview,repairLifeArchiveTimes,validateLifeArchiveTarget,stageRestoreRows} from './companion-life-service.mjs';
import {assertLifeTransferFile,assertLifeTransferParent,cleanLifeArchiveTransfers,lifeTransferPath} from './companion-life-transfers.mjs';
import {createSnapshotStorage} from './storage.mjs';
import {readCompanionRollbackCounts,verifyCompanionRollbackCounts} from './companion-rollback-counts.mjs';
import {assertR95CompanionCompatible} from './r95-data-compatibility.mjs';
import {COMPANION_CAPABILITY,COMPANION_WRITER,openCompanionDatabase,queryCompanionMessages,queryCompanionRecords,readCompanionHistory,readCompanionSqliteMetadata,readCompanionSqliteSnapshot,readCompanionState,upgradeCompanionStateSections,searchCompanionOwners,readGroupReplySource,readPendingMood,readPrivateStartupRows,readGroupSavedPhoto,ensureCompanionHistoryIndexes,withCompanionRead,openCompanionReader,companionWriterPragmas,readPreparedCompanionMemoryCommit} from './companion-sqlite.mjs';

function materializeSnapshot(path,snapshot,{allowIncomplete=false}={}){
  const state=materializeCompanionData(snapshot);
  const transaction=state.lifeTransaction;
  if(transaction?.staging){
    if(allowIncomplete||transaction.staging.complete)
      transaction.target=readLifeRestoreSource(path,transaction.id,transaction.staging.sha256);
    else delete transaction.target;
  }
  return state;
}

const cap=COMPANION_CAPABILITY;
const hash=value=>createHash('sha256').update(value).digest('hex');
function post(phase,count,total,legacySource){
  parentPort.postMessage({progress:{phase,count,total,legacySource}});
  if(workerData.interruptAfter===phase)throw Object.assign(Error('Injected migration interruption'),{code:'MIGRATION_TEST_INTERRUPTED'});
}
function assertVerified(meta){
  if(!meta.migrationId||typeof meta.sourceSha256!=='string'||meta.verified!==true)throw Error('Companion database migration has not been verified');
}
function verifyCompanionData(original,restored){
  const sorted=(rows,key)=>rows.map(row=>[JSON.stringify(key(row)),row])
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,row])=>row);
  const collectionKeys=owners=>owners.map(({type,ownerId})=>JSON.stringify([type,ownerId])).sort();
  if(!isDeepStrictEqual(sorted(restored.rows,row=>[row.type,row.ownerId,row.ordinal]),sorted(original.rows,row=>[row.type,row.ownerId,row.ordinal])))throw Error('Companion migration message verification failed');
  if(!isDeepStrictEqual(collectionKeys(original.owners),collectionKeys(restored.owners)))throw Error('Companion migration message collection verification failed');
  if(!isDeepStrictEqual(sorted(restored.recordRows,row=>[row.namespace,row.owner,row.key]),sorted(original.recordRows,row=>[row.namespace,row.owner,row.key])))throw Error('Companion migration records verification failed');
  if(!isDeepStrictEqual(sorted(restored.recordOwners,row=>[row.namespace,row.owner]),sorted(original.recordOwners,row=>[row.namespace,row.owner])))throw Error('Companion migration record collection verification failed');
  const revision=original.state.revision??0;
  if(!isDeepStrictEqual(restored.state,{...original.state,revision}))throw Error('Companion migration state verification failed');
}
async function readLegacy(path){
  const disk=createSnapshotStorage(path,{protectExisting:true,retention:false});
  try{
    const text=await disk.readText();
    const authority=disk.committedPath();
    const bytes=readFileSync(authority);
    if(bytes.toString('utf8')!==text)throw Error('Companion source changed while reading');
    return {disk,bytes,source:JSON.parse(text),sha256:hash(bytes),flatSha256:existsSync(path)?hash(readFileSync(path)):null,stat:await disk.stat()};
  }catch(error){
    if(error.code==='ENOENT')return {disk,source:undefined,sha256:hash(''),flatSha256:null};
    throw error;
  }
}
function backup(path,legacy,migrationId){
  if(!legacy.bytes)return;
  const directory=dirname(path),tag=new Date().toISOString().replaceAll(':','-')+'-'+migrationId;
  writeAtomic(join(directory,'companion.pre-sqlite-'+tag+'.json'),legacy.bytes);
  if(existsSync(path)){
    const direct=readFileSync(path);
    if(!direct.equals(legacy.bytes))writeAtomic(join(directory,'companion.pre-sqlite-'+tag+'-flat.json'),direct);
  }
}
async function publishFence(path,legacy,meta){
  const current=await readLegacy(path);
  if(current.sha256!==legacy.sha256||current.flatSha256!==legacy.flatSha256||current.stat?.version!==legacy.stat?.version)throw Error('Companion legacy source changed during migration');
  const fence={
    schema:2,minimumWriter:COMPANION_WRITER,requiredCapabilities:[cap],
    sqliteMigration:{id:meta.migrationId,sourceSha256:meta.sourceSha256}
  };
  const text=JSON.stringify(fence);
  await current.disk.writeText(text,current.stat?{kind:'replaceIfVersion',version:current.stat.version}:{kind:'createIfAbsent'});
  post('journal-published');
  writeAtomic(path,text);
  post('fenced');
}

function upgradeLegacyCompanionState(path,writer){
  writer.upgradeLegacyState(state=>{
    assertR95CompanionCompatible(state);
    const next={
      ...state,schema:2,minimumWriter:'r95-social-core-v1',
      requiredCapabilities:[...new Set(['social-core-state-v1',...(state.requiredCapabilities??[])])],
      r95Migration:{from:1,to:2,at:Date.now(),minimumWriterCapability:'social-core-v1'}
    };
    compactAutoGroups(next,createEvidenceArchive(join(dirname(path),'auto-evidence.sqlite'),{wal:true}));
    return next;
  });
}
function partitionExistingAutoEvidence(path,writer){
  const state=writer.load();
  if(!partitionGroupAutoEvidence(structuredClone(state)).recordOwners.length)return;
  compactAutoGroups(state,createEvidenceArchive(join(dirname(path),'auto-evidence.sqlite'),{wal:true}));
  const {recordOwners,recordRows}=partitionGroupAutoEvidence(state);
  const staged=writer.stage();
  for(const row of recordOwners)staged.api.records.define(row.namespace,row.owner,row);
  for(const {namespace,owner,key,value} of recordRows)staged.api.records.put(namespace,owner,key,value);
  const current=state.revision;
  writer.commit(staged,{...state,revision:current+1},current,true,false,'auto-evidence-upgrade');
}
function upgradeExistingCompanionState(path){
  const state=withCompanionRead(path,readCompanionState);
  if(state.schema!==1&&!partitionGroupAutoEvidence(state).recordOwners.length)return;
  const writer=openCompanionDatabase(path);
  try{upgradeLegacyCompanionState(path,writer);partitionExistingAutoEvidence(path,writer);}
  finally{writer.close();}
}

function assertCompanionMigrationFence(source){
  if(source?.minimumWriter!==COMPANION_WRITER||!Array.isArray(source.requiredCapabilities)||
    source.requiredCapabilities.length!==1||source.requiredCapabilities[0]!==cap)
    throw Error('Unsupported companion migration fence');
}

async function migrate({path,legacyPath,initial}){
  const legacy=await readLegacy(legacyPath);
  if(legacy.source?.minimumWriter===COMPANION_WRITER||Object.hasOwn(legacy.source??{},'sqliteMigration')){
    assertCompanionMigrationFence(legacy.source);
    if(!existsSync(path))throw Error('Migrated companion database is missing');
    const meta=readCompanionSqliteMetadata(path);
    assertVerified(meta);
    if(meta.migrationId!==legacy.source.sqliteMigration?.id||meta.sourceSha256!==legacy.source.sqliteMigration?.sourceSha256)throw Error('Companion migration identity does not match');
    upgradeCompanionStateSections(path,meta);
    ensureCompanionHistoryIndexes(path);
    upgradeExistingCompanionState(path);
    if(!existsSync(legacyPath)||!readFileSync(legacyPath).equals(legacy.bytes))writeAtomic(legacyPath,legacy.bytes);
    return {migrated:false};
  }
  if(legacy.source===undefined&&initial===undefined)throw Error('Missing companion initialization state');
  if(legacy.source!==undefined)assertR95CompanionCompatible(legacy.source);
  post('discovered',undefined,undefined,legacy.source!==undefined);
  if(existsSync(path)&&existsSync(path+'.rollback.json')){
    const intent=JSON.parse(readFileSync(path+'.rollback.json','utf8'));
    assertRollbackClosed(path);
    if(intent.migrationId===readCompanionSqliteMetadata(path).migrationId){
      if(!legacy.source)throw Error('Rollback legacy source is unavailable');
      retireRollbackDatabase(path,intent);
    }
  }
  if(existsSync(path)){
    const meta=readCompanionSqliteMetadata(path);
    assertVerified(meta);
    if(meta.sourceSha256!==legacy.sha256)throw Error('Companion database belongs to a different migration source');
    upgradeCompanionStateSections(path,meta);
    ensureCompanionHistoryIndexes(path);
    upgradeExistingCompanionState(path);
    await publishFence(legacyPath,legacy,meta);
    post('ready');
    return {migrated:true};
  }
  const migrationId=randomUUID();
  const working=path+'.migrating-'+migrationId;
  mkdirSync(dirname(path),{recursive:true});
  backup(legacyPath,legacy,migrationId);
  post('backed-up');
  const original=partitionCompanionData(legacy.source??initial);
  post('partitioned',0,original.rows.length);
  const meta={migrationId,sourceSha256:legacy.sha256,verified:false};
  const writer=openCompanionDatabase(working,{initial:original.state,metadata:meta,seed:original.rows,seedOwners:original.owners,seedRecords:original.recordRows,seedRecordOwners:original.recordOwners});
  try{
    post('inserted',original.rows.length,original.rows.length);
    const stored=readCompanionSqliteSnapshot(working);
    verifyCompanionData(original,stored);
    const expected=legacy.source??initial;
    if(!isDeepStrictEqual(materializeCompanionData(stored),{...expected,revision:expected.revision??0}))throw Error('Companion migration full reconstruction verification failed');
    upgradeLegacyCompanionState(path,writer);
    partitionExistingAutoEvidence(path,writer);
    writer.markVerified();
    post('validated',original.rows.length,original.rows.length);
    if(writer.checkpoint().status!=='truncated')throw Error('Migration WAL checkpoint is busy');
  }finally{writer.close();}
  post('checkpointed');
  // A same-directory hard link publishes the closed database without replacing
  // a destination that might have appeared since discovery.
  linkSync(working,path);
  unlinkSync(working);
  post('database-published');
  await publishFence(legacyPath,legacy,meta);
  post('ready');
  return {migrated:true};
}

function countRollbackExport(exported){
  return partitionCompanionData(exported).rows.length;
}

function verifyRollbackRows(snapshot,exported){
  const at=keys=>keys.reduce((owner,key)=>owner?.[key],exported);
  const messages=new Map();
  for(const {type,ownerId,path} of snapshot.owners.map(owner=>({...owner,path:owner.at??[owner.type==='private'?'conversations':'groups',owner.ownerId]}))){
    const rows=at(path)?.messages;
    if(!Array.isArray(rows))throw Error('Rollback export lost a message collection');
    messages.set(JSON.stringify([type,ownerId]),{rows,count:0});
  }
  for(const {type,ownerId,message} of snapshot.rows){
    const owner=messages.get(JSON.stringify([type,ownerId]));
    if(!owner||!isDeepStrictEqual(owner.rows[owner.count++],message))throw Error('Rollback export lost a message row');
  }
  if([...messages.values()].some(({rows,count})=>rows.length!==count))throw Error('Rollback export changed a message collection');
  const isCoverageChunk=namespace=>namespace.startsWith('memory.coverage.');
  const isLegacyMemoryHeader=namespace=>namespace==='memory.jobs'||namespace==='memory.summaries';
  const headerNamespace=namespace=>namespace.replace('memory.','memory.coverageHeader.');
  const verifyRepartitioned=namespace=>isCoverageChunk(namespace)||namespace.startsWith('memory.coverageHeader.')||namespace.startsWith('group.autoEvidence.');
  // Virtual coverage and Auto owners do not have literal paths in legacy
  // JSON. Repartition the emitted data to verify their authoritative bytes.
  const normalized=partitionCompanionData(exported);
  const keyOf=({namespace,owner,key})=>JSON.stringify([namespace,owner,key]);
  const seenRecordOwners=new Set(snapshot.recordOwners.map(keyOf));
  const normalizedOwners=new Map(normalized.recordOwners.map(owner=>[keyOf(owner),owner]));
  const normalizedRows=new Map(normalized.recordRows.map(row=>[keyOf(row),row.value]));
  const physicalRows=new Set(snapshot.recordRows.map(keyOf));
  const populatedOwners=new Set(snapshot.recordRows.map(({namespace,owner})=>keyOf({namespace,owner})));
  for(const row of normalized.recordRows)
    if(isCoverageChunk(row.namespace)&&seenRecordOwners.has(keyOf({namespace:row.namespace,owner:row.owner}))&&!physicalRows.has(keyOf(row)))
      throw Error('Rollback export lost a memory coverage chunk');
  const records=new Map();
  for(const ownerRow of snapshot.recordOwners){
    const {namespace,owner,array,at:path}=ownerRow;
    if(verifyRepartitioned(namespace)){
      const emptyHeader=namespace.startsWith('memory.coverageHeader.')&&!populatedOwners.has(keyOf(ownerRow));
      if(!emptyHeader&&!isCoverageChunk(namespace)&&!isDeepStrictEqual(normalizedOwners.get(keyOf(ownerRow)),ownerRow))
        throw Error('Rollback export lost a partitioned record owner');
      continue;
    }
    const rows=at(path);
    if(!rows||typeof rows!=='object'||Array.isArray(rows)!==array)throw Error('Rollback export lost a record collection');
    records.set(JSON.stringify([namespace,owner]),{rows,array,count:0});
  }
  for(const row of snapshot.recordRows){
    const {namespace,owner,key,value}=row;
    if(verifyRepartitioned(namespace)){
      const normalizedKey=keyOf(row);
      if(isCoverageChunk(namespace)&&!normalizedRows.has(normalizedKey))continue;
      if(!isDeepStrictEqual(normalizedRows.get(normalizedKey),value))
        throw Error('Rollback export lost a partitioned record row');
      continue;
    }
    // A partially converted legacy header can coexist with its authoritative chunked form.
    if(isLegacyMemoryHeader(namespace)&&physicalRows.has(keyOf({...row,namespace:headerNamespace(namespace)})))continue;
    const collection=records.get(JSON.stringify([namespace,owner]));
    if(!collection)throw Error('Rollback export lost a record owner');
    const restored=collection.array?collection.rows[collection.count]:collection.rows[key];
    collection.count++;
    if(!isDeepStrictEqual(restored,value))throw Error('Rollback export lost a record row');
  }
  if([...records.entries()].some(([ownerKey,{rows,count}])=>{
    const [namespace,owner]=JSON.parse(ownerKey);
    if(!isLegacyMemoryHeader(namespace))return Object.keys(rows).length!==count;
    const compactOwner=headerNamespace(namespace);
    const compactKeys=Object.keys(rows).filter(key=>physicalRows.has(keyOf({namespace:compactOwner,owner,key})));
    return Object.keys(rows).length!==count+compactKeys.length;
  }))throw Error('Rollback export changed a record collection');
}

async function exportRollback({path,legacyPath}){
  const legacy=await readLegacy(legacyPath);
  const intentPath=path+'.rollback.json';
  if(legacy.source?.minimumWriter!==COMPANION_WRITER){
    const intent=existsSync(intentPath)?JSON.parse(readFileSync(intentPath,'utf8')):null;
    if(!intent||legacy.sha256!==intent.exportSha256)throw Error('Rollback source is not the current companion database');
    const exportBytes=readFileSync(intent.exportPath),exported=JSON.parse(exportBytes);
    if(hash(exportBytes)!==intent.exportSha256)throw Error('Rollback staged export hash changed');
    if(intent.ownerCounts){
      verifyCompanionRollbackCounts(intent,exported);
      if(countRollbackExport(exported)!==intent.messageCount)throw Error('Rollback staged export message count changed');
    }
    if(existsSync(path)){
      assertRollbackClosed(path);
      if(intent.ownerCounts){
        const census=readCompanionRollbackCounts(path);
        if(census.totalMessageCount!==intent.totalMessageCount)throw Error('Rollback database message count changed');
        verifyCompanionRollbackCounts(census,exported);
      }
      retireRollbackDatabase(path,intent);
    }
    if(!existsSync(legacyPath)||!readFileSync(legacyPath).equals(legacy.bytes))writeAtomic(legacyPath,legacy.bytes);
    return intent;
  }
  assertRollbackClosed(path);
  const census=readCompanionRollbackCounts(path),snapshot=readCompanionSqliteSnapshot(path);
  if(census.totalMessageCount!==snapshot.rows.length)throw Error('Rollback total database message count changed');
  assertVerified(snapshot.meta);
  if(snapshot.meta.migrationId!==legacy.source.sqliteMigration?.id||snapshot.meta.sourceSha256!==legacy.source.sqliteMigration?.sourceSha256)throw Error('Rollback database identity does not match');
  const state=materializeSnapshot(path,{...snapshot,state:structuredClone(snapshot.state)},{allowIncomplete:true});
  state.schema=2;
  state.minimumWriter='r95-social-core-v1';
  state.requiredCapabilities=(state.requiredCapabilities??[]).filter(value=>value!==cap);
  if(!state.requiredCapabilities.includes('social-core-state-v1'))state.requiredCapabilities.push('social-core-state-v1');
  assertR95CompanionCompatible(state);
  const staged=owner=>owner.at?.[0]==='lifeTransaction'&&owner.at?.[1]==='staged';
  const stageMessages=new Set(snapshot.owners.filter(staged).map(({type,ownerId})=>JSON.stringify([type,ownerId])));
  const stageRecords=new Set(snapshot.recordOwners.filter(staged).map(({namespace,owner})=>JSON.stringify([namespace,owner])));
  const sealedTargetCount=state.lifeTransaction?.staging?countRollbackExport({lifeTransaction:state.lifeTransaction}):0;
  const publicRows=snapshot.rows.filter(({type,ownerId})=>!stageMessages.has(JSON.stringify([type,ownerId])));
  if(state.lifeTransaction?.staging){
    delete state.lifeTransaction.staging;
    delete state.lifeTransaction.staged;
  }
  const text=JSON.stringify(state);
  verifyRollbackRows({
    ...snapshot,
    rows:publicRows,owners:snapshot.owners.filter(owner=>!staged(owner)),
    recordRows:snapshot.recordRows.filter(({namespace,owner})=>!stageRecords.has(JSON.stringify([namespace,owner]))),
    recordOwners:snapshot.recordOwners.filter(owner=>!staged(owner))
  },JSON.parse(text));
  const stage=path+'.rollback-export-'+snapshot.meta.migrationId+'.json';
  writeAtomic(stage,text);
  const reread=readFileSync(stage),parsed=JSON.parse(reread);
  const messageCount=publicRows.length+sealedTargetCount;
  if(countRollbackExport(parsed)!==messageCount)throw Error('Rollback exported total message count mismatch');
  if(reread.toString('utf8')!==text||!isDeepStrictEqual(parsed,state))throw Error('Rollback export verification failed');
  const intent={
    migrationId:snapshot.meta.migrationId,sourceSha256:snapshot.meta.sourceSha256,revision:state.revision,
    exportPath:stage,exportSha256:hash(reread),messageCount,
    totalMessageCount:census.totalMessageCount,stagedMessageCount:snapshot.rows.length-publicRows.length,
    sealedTargetMessageCount:sealedTargetCount,...verifyCompanionRollbackCounts(census,parsed)
  };
  writeAtomic(intentPath,JSON.stringify(intent));
  const current=await readLegacy(legacyPath);
  if(current.sha256!==legacy.sha256||current.flatSha256!==legacy.flatSha256||current.stat?.version!==legacy.stat?.version)throw Error('Rollback source changed before publication');
  assertRollbackClosed(path);
  if(readCompanionSqliteSnapshot(path).state.revision!==snapshot.state.revision)throw Error('Rollback database changed before publication');
  await current.disk.writeText(text,{kind:'replaceIfVersion',version:current.stat.version});
  writeAtomic(legacyPath,text);
  retireRollbackDatabase(path,intent);
  return intent;
}


function assertRollbackClosed(path){
  if(!existsSync(path+'-wal')&&!existsSync(path+'-shm'))return;
  assertVerified(readCompanionSqliteMetadata(path));
  const db=new DatabaseSync(path);
  try{
    db.exec(companionWriterPragmas);
    if(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy)
      throw Error('Rollback requires the database to be closed and checkpointed');
  }finally{db.close();}
  if(existsSync(path+'-wal')||existsSync(path+'-shm'))throw Error('Rollback requires the database to be closed and checkpointed');
}

function retireRollbackDatabase(path,intent){
  const meta=readCompanionSqliteMetadata(path);
  if(meta.migrationId!==intent.migrationId||meta.sourceSha256!==intent.sourceSha256)throw Error('Rollback intent belongs to another database');
  const retired=join(dirname(path),'companion.sqlite-retired-'+intent.migrationId);
  if(!existsSync(retired))linkSync(path,retired);
  else if(!statSync(path).ino||statSync(path).ino!==statSync(retired).ino)throw Error('Rollback retired database path is occupied');
  unlinkSync(path);
}

async function portableConversations({path,ownerId,groupId,at,drafts,target},db,requestMedia){
  const state=materializeCompanionData(readCompanionSqliteSnapshot(db,{portable:{ownerId,groupId}}));
  const selectedPrivate=groupId?[]:ownerId?[state.conversations?.[ownerId]].filter(Boolean):Object.values(state.conversations??{});
  const selectedGroups=groupId?[state.groups?.[groupId]].filter(Boolean):ownerId?[]:Object.values(state.groups??{});
  const data=resolveStateImages(createMediaStore(dirname(dirname(path))),{
    format:'ai-buddy-conversations',version:1,exportedAt:at,defaultPersonaId:state.defaultPersonaId??'default',
    personas:state.personas,
    cards:Object.fromEntries(Object.values(state.cards).filter(row=>!row.builtin).map(row=>[row.id,row])),
    conversations:selectedPrivate.map(row=>({...row,draft:drafts[row.id]??row.draft??''})),
    groups:selectedGroups.map(({pending,...row})=>row)
  });
  if(ownerId||groupId){
    if(!data.conversations.length&&!data.groups.length)throw Error('导出会话不存在');
    const personaIds=new Set([...data.conversations,...data.groups].map(row=>row.personaId));
    const characterIds=new Set([...data.conversations.map(row=>row.characterId),...data.groups.flatMap(row=>[...row.memberIds,...Object.keys(row.intervals??{}),...(row.messages??[]).map(message=>message.characterId),row.entryCharacterId])]);
    data.personas=Object.fromEntries(Object.entries(data.personas).filter(([id])=>personaIds.has(id)).map(([id,entry])=>[id,{...entry,relationships:Object.fromEntries(Object.entries(entry.relationships??{}).filter(([id])=>characterIds.has(id)))}]));
    data.cards=Object.fromEntries(Object.entries(data.cards).filter(([id])=>characterIds.has(id)));
    for(const owner of [...data.conversations,...data.groups])for(const message of owner.messages??[])if(message.personaSnapshot?.relationships)message.personaSnapshot.relationships=Object.fromEntries(Object.entries(message.personaSnapshot.relationships).filter(([id])=>characterIds.has(id)));
    data.defaultPersonaId=[...personaIds][0];
  }
  assertPortableBytes(Buffer.byteLength(JSON.stringify(data)));
  const ids=[...new Set(data.groups.flatMap(group=>(group.photos??[]).map(photo=>photo.cgId)))];
  const {media}=await requestMedia({ids,all:!ownerId&&!groupId});
  data.media=media;
  const text=JSON.stringify(data);
  assertPortableBytes(Buffer.byteLength(text));
  writeAtomic(target,text);
  const ownerCounts=[
    ...data.conversations.map(row=>({type:'private',ownerId:row.id,messageCount:row.messages?.length??0})),
    ...data.groups.map(row=>({type:'group',ownerId:row.id,messageCount:row.messages?.length??0}))
  ];
  return {path:target,ownerCounts,messageCount:ownerCounts.reduce((sum,row)=>sum+row.messageCount,0),sha256:hash(text)};
}

function assertPortableBytes(bytes){
  if(bytes>50*1024*1024)throw Error('导出文件超过 50 MiB，请分别导出群聊或备份完整数据目录 / Export exceeds 50 MiB');
}


function withIsolatedSqlite(path,inspect){
  const temp=mkdtempSync(join(tmpdir(),'buddy-companion-import-'));
  const copied=join(temp,'companion.sqlite'),files=[['',''],['-wal','-wal']];
  try{
    const before=files.map(([suffix])=>existsSync(path+suffix)?hash(readFileSync(path+suffix)):null);
    for(const [index,[source,dest]] of files.entries())if(before[index])copyFileSync(path+source,copied+dest);
    const after=files.map(([suffix])=>existsSync(path+suffix)?hash(readFileSync(path+suffix)):null);
    if(!isDeepStrictEqual(before,after)||files.some(([,suffix],index)=>before[index]&&hash(readFileSync(copied+suffix))!==before[index]))throw Error('Companion source changed while copying for inspection');
    return inspect(copied);
  }finally{
    for(const name of readdirSync(temp))unlinkSync(join(temp,name));
    rmdirSync(temp);
  }
}

function maintenancePlan(path,db,name,{draftEntries,applyPlanId,revision}={}){
  if(name==='media-migrate'||name==='media-revert'){
    const state=withCompanionRead(db,reader=>{
      const value=readCompanionState(reader);
      value.lifeArchives=Object.fromEntries(reader.prepare("SELECT value FROM records WHERE namespace='root.lifeArchives' ORDER BY ordinal").all().map(row=>JSON.parse(row.value)).map(archive=>[archive.id,archive]));
      return value;
    });
    if(applyPlanId&&state.revision!==revision)throw Object.assign(Error('清理计划已经变化，请重新预演后再确认'),{code:'MAINTENANCE_PLAN_CHANGED'});
    return {...prepareMediaMaintenance({state,task:name,dataRoot:dirname(dirname(path)),draftEntries,applyPlanId}),revision:state.revision};
  }
  if(name!=='legacy-dedupe')throw Error('Unknown companion maintenance task');
  const state=materializeCompanionData(readCompanionSqliteSnapshot(db)),plan=planLegacyDedupe(state),before=new Map();
  for(const {characterId} of plan.removals){
    if(before.has(characterId))continue;
    before.set(characterId,new Map(Object.entries(state.lives?.[characterId]?.memory?.events??{}).map(([key,item])=>[key,item.duplicateOf])));
  }
  applyLegacyDedupe(state,plan.planId);
  const duplicateEvents=[];
  for(const [characterId,events] of before)for(const [eventId,duplicateOf] of Object.entries(state.lives?.[characterId]?.memory?.events??{}).map(([id,item])=>[id,item.duplicateOf])){
    if(events.get(eventId)!==duplicateOf)duplicateEvents.push({characterId,eventId,duplicateOf});
  }
  return {...plan,revision:state.revision,duplicateEvents};
}

function maintenanceBackup(path,target,revision){
  const state=materializeCompanionData(readCompanionSqliteSnapshot(path));
  if(state.revision!==revision)throw Object.assign(Error('清理计划已经变化，请重新预演后再确认'),{code:'MAINTENANCE_PLAN_CHANGED'});
  const text=JSON.stringify(state);
  writeAtomic(target,text);
  return {revision,sha256:hash(text)};
}

function importMetadata(path,legacy){
  assertCompanionMigrationFence(legacy.source);
  const meta=readCompanionSqliteMetadata(path);
  assertVerified(meta);
  if(legacy.source.sqliteMigration?.id!==meta.migrationId||legacy.source.sqliteMigration?.sourceSha256!==meta.sourceSha256)
    throw Error('Companion import database does not match its legacy fence');
  return meta;
}

async function inspectImport({path,legacyPath}){
  if(!existsSync(path)){
    const old=await readLegacy(legacyPath);
    if(old.source?.minimumWriter===COMPANION_WRITER||Object.hasOwn(old.source??{},'sqliteMigration'))throw Error('Migrated companion database is missing');
    return null;
  }
  const old=await readLegacy(legacyPath);
  return withIsolatedSqlite(path,copied=>{
  importMetadata(copied,old);
  return withCompanionRead(copied,db=>{
    const state=readCompanionState(db);
    const length=value=>Object.keys(value??{}).length;
    return {
      characters:length(state.cards),personas:length(state.personas),conversations:length(state.conversations),groups:length(state.groups),
      messages:db.prepare("SELECT coalesce(sum(count),0) AS total FROM message_owners WHERE owner_type='private'").get().total,
      memoryEvents:db.prepare("SELECT count(*) AS total FROM records WHERE namespace='memory.events'").get().total
    };
  });
  });
}

async function interruptImport(input){
  if(await inspectImport(input)===null)return null;
  const {path,legacyPath,planId}=input;
  upgradeCompanionStateSections(path,importMetadata(path,await readLegacy(legacyPath)));
  const sql=openCompanionDatabase(path);
  try{
    const state=sql.load(),staged=sql.stage(),messages=staged.api.messages;
    const rows=queryCompanionMessages(path,{type:'private',withOwners:true,pendingOnly:true});
    let interruptedRequests=0,changed=false;
    for(const {ownerId,message,occurrenceId} of rows){
      messages.update('private',ownerId,message.id,row=>{
        row.status='interrupted';
        if(row.presentation==='pending')row.presentation='discarded';
        row.interruptedByImport=planId;
      },{occurrenceId});
      interruptedRequests++;
    }
    for(const group of Object.values(state.groups??{}))if(group.pending&&!group.pending.settlement){
      group.importedPending=group.pending;group.pending=null;interruptedRequests++;changed=true;
    }
    if(interruptedRequests)sql.commit(staged,{...state,revision:state.revision+1},state.revision,changed);
    sql.checkpoint();
    return {interruptedRequests};
  }finally{sql.close();}
}

function requestHost(pending,envelope,type,value){
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    try{parentPort.postMessage({...envelope,[type]:{id,...value}});}
    catch(error){pending.delete(id);reject(error);}
  });
}
function receiveHost(pending,result){
  const waiting=pending?.get(result?.id);
  if(!waiting)return;
  pending.delete(result.id);
  if(result.error)waiting.reject(Object.assign(Error(result.error.message),{code:result.error.code}));
  else waiting.resolve(result.value);
}
function memoryRecordPartitions(snapshot,{syncOnly}){
  const owners=snapshot.recordOwners.filter(({namespace,at})=>at[0]==='lives'&&
    (namespace.startsWith('memory.')||!syncOnly&&namespace.startsWith('growth.')));
  const ownerKey=row=>JSON.stringify([row.namespace,row.owner]);
  const allowed=new Set(owners.map(ownerKey));
  return {owners,rows:snapshot.recordRows.filter(row=>allowed.has(ownerKey(row)))};
}

async function readCompanionMemory({path,method,args,at,capacity,capacities,stream,compactResult},db,runModel,send,preparedMemory,readId,evidenceArchive){
  const updates=method==='consolidate'||method==='tick'||method==='sync';
  const snapshot=readCompanionSqliteSnapshot(db),before=updates?structuredClone(snapshot):null,state=materializeCompanionData(snapshot);
  const store={
    state,
    ...(updates?{archive:evidenceArchive}:{}),
    mutate:async(fn,{guard}={})=>{if(!guard||guard(state))return fn(state);},
    snapshot:()=>structuredClone(state)
  };
  const socialPath=join(dirname(dirname(path)),'social-core','events.sqlite');
  const evidence=existsSync(socialPath)?new DatabaseSync(socialPath,{readOnly:true}):null;
  try{
    const select=evidence?.prepare('SELECT id,plugin,body,digest FROM events WHERE id=?');
    const readEvidence=(plugin,id)=>{
      const row=select?.get(id);
      if(!row||row.plugin!==plugin)throw Error('Companion social evidence unavailable');
      return {...JSON.parse(row.body),eventRef:row.id,sourceHash:row.digest};
    };
    const memory=createCompanionMemory({
      store,now:()=>at,getCapacity:id=>capacities?.[id]??capacity,runModel,autoStart:false,compactWriteResult:compactResult===true,
      onGrowth:(value,id,candidates,batch)=>applyGrowthCandidates(value,id,candidates,batch,at),
      resolveLegacySocialIdentity:value=>resolveLegacySocialIdentity(readEvidence,value),
      resolveSocialExpressionIdentity:value=>resolveSocialExpressionIdentity(readEvidence,value)
    });
    const value=method==='sync'?await memory.sync(args.characterId):await memory[method](args);
    if(!updates)return {revision:state.revision,memorySourceRevision:snapshot.meta.memorySourceRevision??0,value};
    const after=partitionCompanionData(state),syncOnly=method==='sync';
    const beforeRecords=memoryRecordPartitions(before,{syncOnly}),afterRecords=memoryRecordPartitions(after,{syncOnly});
    const itemKey=row=>[row.namespace,row.owner,row.key],ownerKey=row=>[row.namespace,row.owner];
    const removed=(previous,next,key)=>{
      const present=new Set(next.map(row=>JSON.stringify(key(row))));
      return previous.filter(row=>!present.has(JSON.stringify(key(row))));
    };
    const changed=(previous,next,key)=>{
      const original=new Map(previous.map(row=>[JSON.stringify(key(row)),row]));
      return next.filter(row=>!isDeepStrictEqual(original.get(JSON.stringify(key(row))),row));
    };
    const source={revision:state.revision,memorySourceRevision:snapshot.meta.memorySourceRevision??0};
    const result={
      ...source,value:value??null,
      patch:{
        records:changed(beforeRecords.rows.map(({ordinal,...row})=>row),afterRecords.rows.map(({ordinal,...row})=>row),itemKey)
          .map(row=>({...row,bytes:Buffer.byteLength(JSON.stringify(row.value))})),
        deletedRecords:removed(beforeRecords.rows,afterRecords.rows,itemKey).map(({namespace,owner,key})=>({namespace,owner,key})),
        deletedOwners:removed(beforeRecords.owners,afterRecords.owners,ownerKey).map(({namespace,owner})=>({namespace,owner})),
        owners:changed(beforeRecords.owners,afterRecords.owners,ownerKey),
        cards:syncOnly?[]:changed(Object.values(before.state.cards??{}),Object.values(after.state.cards??{}),row=>row.id),
        memorySettings:after.state.memorySettings,
        lives:Object.fromEntries(Object.entries(after.state.lives??{}).flatMap(([id,life])=>{
          const old=before.state.lives?.[id],patch={};
          if(!isDeepStrictEqual(life.memory,old?.memory))patch.memory=life.memory;
          if(!syncOnly&&!isDeepStrictEqual(life.growth,old?.growth))patch.growth=life.growth;
          return Object.keys(patch).length?[[id,patch]]:[];
        }))
      }
    };
    if(stream){
      const {records,deletedRecords,deletedOwners,owners,...metadata}=result.patch;
      const coverage=row=>row.namespace.startsWith('memory.coverage.');
      const header=row=>['memory.jobs','memory.summaries'].includes(row.namespace)||row.namespace.startsWith('memory.coverageHeader.');
      const define=row=>({entry:{type:'define',...row}});
      const descriptors=new Map(owners.map(row=>[JSON.stringify(ownerKey(row)),row]));
      const writes=records.map(({bytes,...row})=>{
        const descriptor=descriptors.get(JSON.stringify(ownerKey(row)));
        return {entry:{type:'put',...row,...(descriptor?{descriptor}:{})},bytes};
      });
      const populatedOwners=new Set(writes.map(({entry})=>JSON.stringify(ownerKey(entry))));
      const deletes=rows=>rows.map(row=>({entry:{type:'delete',...row}}));
      const removeOwners=rows=>rows.map(row=>({entry:{type:'removeEmptyOwner',...row}}));
      const publication=[
        ...writes.filter(({entry})=>header(entry)),
        ...deletes(deletedRecords.filter(header)),
        ...removeOwners(deletedOwners.filter(header))
      ];
      const cleanup=[
        ...deletes(deletedRecords.filter(coverage)),
        ...removeOwners(deletedOwners.filter(coverage))
      ];
      const fits=changes=>changes.length<=memoryRecordBatchRows&&
        changes.reduce((sum,change)=>sum+(change.bytes??0),0)<=memoryRecordBatchBytes;
      const final=publication.length>0&&fits(publication);
      const changes=[
        ...owners.filter(row=>!populatedOwners.has(JSON.stringify(ownerKey(row)))).map(define),
        ...writes.filter(({entry})=>coverage(entry)),
        ...deletes(deletedRecords.filter(row=>!coverage(row)&&!header(row))),
        ...writes.filter(({entry})=>!coverage(entry)&&!header(entry)),
        ...removeOwners(deletedOwners.filter(row=>!coverage(row)&&!header(row))),
        ...(!final?[...publication,...cleanup]:[])
      ];
      let batch=[],bytes=0,rows=0;
      const definedOwners=new Set();
      for(const {entry,bytes:weight=0} of changes){
        // A put can add an owner descriptor as well as its record row.
        const definition=entry.descriptor?JSON.stringify(ownerKey(entry)):null;
        const extraRow=definition&&!definedOwners.has(definition)?1:0;
        if(batch.length&&(rows+1+extraRow>memoryRecordBatchRows||bytes+weight>memoryRecordBatchBytes)){
          await send({...source,changes:batch});
          batch=[];bytes=0;rows=0;definedOwners.clear();
        }
        if(weight>memoryRecordBatchBytes){
          const {namespace,owner,key,value}=entry;
          const record={token:randomUUID(),readId,namespace,owner,key,sha256:hash(JSON.stringify(value))};
          preparedMemory.set(record.token,{record,entry});
          try{await send({...source,record});}
          finally{preparedMemory.delete(record.token);}
        }else{
          if(definition&&!definedOwners.has(definition)){definedOwners.add(definition);rows++;}
          batch.push(entry);bytes+=weight;rows++;
        }
      }
      if(batch.length)await send({...source,changes:batch});
      // Old immutable chunks can be discarded by next sync after publication.
      result.patch=final?{...metadata,changes:publication.map(({entry})=>entry)}:metadata;
    }

    return result;
  }finally{evidence?.close();}
}

enablePatches();
const lifeMetadataDraft=new Immer({autoFreeze:false});
function patchLifeMetadata(writer,patches,currentRevision,state=writer.load()){
 if(state.revision!==currentRevision)throw Error('Companion database revision changed');
 return {...lifeMetadataDraft.applyPatches(state,patches),revision:currentRevision+1};
}
function writeLifeArchiveMetadata({path,id,patches,plan,archiveArtwork=[],currentRevision,writeMemoryRevision,commitTrace,writeOperation}){
 const started=performance.now(),writer=openCompanionDatabase(path);
 try{
  const changed=patches.length>0,source=archiveArtwork.length?writer.load():undefined;
  if(source){
   if(source.revision!==currentRevision)throw Error('Companion database revision changed');
   expandLifeArchiveArtwork(plan,archiveArtwork,source,{verify:true});
  }
  const next=changed?patchLifeMetadata(writer,patches,currentRevision,source):{revision:currentRevision+1},staged=writer.stage(plan);
  writer.commit(staged,next,currentRevision,changed,writeMemoryRevision,writeOperation,commitTrace);
  return {id,revision:next.revision,rows:staged.rowsWritten,elapsedMs:performance.now()-started};
 }finally{writer.close();}
}
function publishLifeRestore({path,plan,next,patches,currentRevision,writeMemoryRevision,clearLifeRestore,prepareLegacyLife,commitTrace}){
  const started=performance.now(),writer=openCompanionDatabase(path);
  try{
    next??=patchLifeMetadata(writer,patches,currentRevision);
    const staged=writer.stage(plan);
    let sha256;
    if(prepareLegacyLife){
      const snapshot=readCompanionSqliteSnapshot(path,{transaction:true});
      const legacy=materializeCompanionData(snapshot).lifeTransaction;
      const transaction=next.lifeTransaction;
      if(snapshot.state.revision!==currentRevision||!legacy||legacy.id!==transaction.id||
        legacy.operationId!==transaction.operationId||legacy.phase!==transaction.phase||legacy.staging||
        hash(JSON.stringify(legacy.target))!==prepareLegacyLife.legacyTargetHash)
        throw Error('Companion legacy life restore transaction changed');
      const target=applyStagedLifeProjection(legacy.target,prepareLegacyLife,transaction.characterId);
      sha256=writeLifeRestoreSource(path,transaction.id,target);
      transaction.staging.sha256=sha256;
      staged.api.deletePartitions(['lifeTransaction','target']);
    }
    if(clearLifeRestore)staged.api.deletePartitions(['lifeTransaction']);
    writer.commit(staged,next,currentRevision,true,writeMemoryRevision,
      prepareLegacyLife?'life-restore-prepare':clearLifeRestore?'life-restore-clear':'life-restore-publish',commitTrace);
    return {revision:next.revision,rows:staged.rowsWritten,elapsedMs:performance.now()-started,...(sha256?{sha256}:{})};
  }finally{writer.close();}
}

function checkArchiveImage(id,bytes,options){
  const {STATUS,TOTAL,OFFSET,LENGTH,WAITING,CHUNK,DONE,FAILED}=imageGate;
  const gate=new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*4)),data=Uint8Array.from(bytes);
  const convert=options?.convert===true;
  const shared=convert||options?.thumbnail?new Uint8Array(new SharedArrayBuffer(lifeImageChunkBytes+32)):null;
  const outputLimit=convert?maxLifeImageBytes:maxLifeThumbnailBytes;
  const sha=shared?createHash('sha256'):null,deadline=Date.now()+(convert?lifeImageConversionDeadlineMs+1000:10000);
  let output=null,received=0;
  parentPort.postMessage({id,image:{bytes:data,gate,output:shared,convert}},[data.buffer]);
  while(Date.now()<deadline){
    const status=Atomics.load(gate,STATUS);
    if(status===WAITING){Atomics.wait(gate,STATUS,WAITING,Math.max(0,deadline-Date.now()));continue;}
    if(status===DONE){
      if(!shared)return true;
      if(output&&received===output.length&&
        sha.digest().equals(Buffer.from(shared.buffer,lifeImageChunkBytes,32))){
        const width=output.readUInt32BE(16),height=output.readUInt32BE(20);
        if(width>0&&(convert||width<=640)&&height>0&&width*height<=16_777_216)return convert?output:{thumbnail:output};
      }
      break;
    }
    if(status!==CHUNK||!shared)break;
    const total=Atomics.load(gate,TOTAL),offset=Atomics.load(gate,OFFSET),length=Atomics.load(gate,LENGTH);
    if(total<24||total>outputLimit||offset!==received||output&&output.length!==total||
      length<1||length>lifeImageChunkBytes||offset+length>total)break;
    output??=Buffer.allocUnsafe(total);
    const chunk=shared.subarray(0,length);
    output.set(chunk,offset);sha.update(chunk);received+=length;
    if(Atomics.compareExchange(gate,STATUS,CHUNK,WAITING)!==CHUNK)break;
    Atomics.notify(gate,STATUS);
  }
  Atomics.store(gate,STATUS,FAILED);Atomics.notify(gate,STATUS);
  return false;
}

function archiveRepository({path,useMedia,hasImageCodec,hasImageConverter,streamImageConversion},requestModel,checkImage){
  const dataRoot=dirname(dirname(path));
  return createLifeArchiveRepository({
    dataRoot,worker:false,media:useMedia?createMediaStore(dataRoot):null,
    imageCodec:hasImageCodec?checkImage:null,
    imageConverter:streamImageConversion?(dataUrl=>checkImage(Buffer.from(dataUrl),{convert:true})):
      hasImageConverter?(dataUrl=>requestModel(null,{dataUrl})):null
  });
}

function restoreAssetOptions(data){
 if(!data.portableAssetRefs)return undefined;
 const root=dirname(dirname(data.path)),files=new Map();
 return {verifiedAssets:{thumbnail:true,resolve(_path,bytes,decoded,key){
  const sha256=hash(bytes);
  if(!files.has(sha256))files.set(sha256,writeValidatedPortableImages(root,[{key:sha256,bytes,decoded}]).get(sha256));
  return files.get(sha256)[key];
 }}};
}

function lifeTargetBridgeData(target){
  const {id,mode,operationId,groupIntervals,r95}=target.life;
  const mood=r95?.mood,reviewKey=mood&&String(mood.version)+':'+String(mood.nextReviewAt);
  const review=reviewKey&&r95.moodReviewEvaluations?.[reviewKey];
  return {
    characterId:target.characterId,version:target.version,requiredCapabilities:target.requiredCapabilities,savedAt:target.savedAt,
    life:{id,mode,operationId,groupIntervals,...(r95?{r95:{
      ...(mood?{mood}:{}),...(review?{moodReviewEvaluations:{[reviewKey]:review}}:{})
    }}:{})},card:target.card,relationships:target.relationships,personas:target.personas,
    conversations:target.conversations.map(({id})=>({id})),content:target.content,
    workEvidence:target.workEvidence,coreState:target.coreState
  };
}

function applyStagedLifeProjection(target,projection,characterId){
  const {life,coreState,version,requiredCapabilities}=projection;
  if(life.id!==target.life.id||life.operationId!==target.life.operationId||life.mode!==target.life.mode)
    throw Error('人生本体时间投影不得改写角色身份');
  const originalR95=target.life.r95;
  target.life={...target.life,...life};
  if(life.r95){
    target.life.r95={...originalR95,...life.r95};
    const original=originalR95?.moodReviewEvaluations;
    if(original||life.r95.moodReviewEvaluations)
      target.life.r95.moodReviewEvaluations={...original,...life.r95.moodReviewEvaluations};
  }
  target.coreState=coreState;
  target.version=version;
  target.requiredCapabilities=requiredCapabilities;
  validateLifeArchiveTarget(target,characterId);
  return target;
}

async function runStorageOperation(data,db=data.path,requestModel,send,checkImage,activeStages,preparedMemory,readId,evidenceArchive){
  if(data.commitTrace)Atomics.store(data.commitTrace,0,process.hrtime.bigint());
  switch(data.operation){
    case 'migrate':{
      const result=await migrate(data);
      if(data.cleanRestoreSources){
        const activeId=withCompanionRead(data.path,db=>readCompanionState(db).lifeTransaction?.id);
        cleanOrphanLifeRestoreSources(data.path,activeId);
        cleanLifeArchiveTransfers(dirname(dirname(data.path)));
      }
      return result;
    }
    case 'prepare-legacy-life-restore':
    case 'clear-life-restore':
    case 'publish-life-restore':return publishLifeRestore(data);
    case 'history':return readCompanionHistory(db,data.type,data.ownerId,data.options);
    case 'records':return queryCompanionRecords(db,data.namespace,data.owner,data.options);
    case 'auto-authorization-exists':return hasArchivedAutoAuthorization(join(dirname(data.path),'auto-evidence.sqlite'),data.groupId,data.authorizationId);
    case 'query':return queryCompanionMessages(db,data.options);
    case 'search-owners':return searchCompanionOwners(db,data.type,data.search,data.language);
    case 'snapshot':return materializeSnapshot(data.path,readCompanionSqliteSnapshot(db,data.scope),{allowIncomplete:data.scope?.transaction===true&&data.scope?.replay===true});
    case 'snapshot-life-archive':{
      const repository=archiveRepository(data,requestModel,checkImage);
      const state=materializeCompanionData(readCompanionSqliteSnapshot(db,{characterId:data.characterId}));
      const snapshot=buildLifeArchiveSnapshot(state,data);
      const file=await repository.save(snapshot);
      const suffix=data.kind==='restore'?' · 恢复前':data.kind==='reset'?' · 重置前':'';
      const archive=lifeArchiveMetadata(snapshot,file,{...data.metadata,name:data.metadata.name??snapshot.card.name+suffix});
      const avatarLocator=data.compactArchiveArtwork?locateLifeCardArtwork(snapshot.card):null;
      if(avatarLocator){delete archive.avatar;archive.avatarLocator=avatarLocator;}
      if(data.kind!=='reset')return archive;
      const {format,characterId,savedAt,card,personas,dependencies}=snapshot;
      const resetCardArtwork=data.keepResetArtwork?avatarLocator:null,resetCard={...card};
      if(avatarLocator)delete resetCard.avatar;
      const resetPersonas=data.compactResetPersonas?Object.fromEntries(Object.entries(personas)
        .map(([id,persona])=>[id,{id:persona.id,relationships:persona.relationships}])):personas;
      return {archive,resetCardArtwork,resetBase:{format,characterId,savedAt,card:resetCard,personas:resetPersonas,dependencies}};
    }
    case 'prepare-archive-restore':{
      const repository=archiveRepository(data,requestModel,checkImage);
      const {snapshot}=repository.read(data.archiveId,data.sha256,restoreAssetOptions(data));
      const target=repairLifeArchiveTimes(snapshot);
      validateLifeArchiveTarget(target,data.characterId);
      if(data.useMedia){
        const media=createMediaStore(dirname(dirname(data.path)));
        for(const [holder,key] of imageSlots({cards:{target:target.card},personas:target.personas})){
          const value=holder[key];
          if(typeof value==='string'&&value.startsWith('data:image/'))holder[key]=media.put(value)??value;
        }
      }
      return {target:lifeTargetBridgeData(target),sha256:writeLifeRestoreSource(data.path,data.id,target)};
    }
    case 'read-staged-life':{
      const tx=data.sha256?null:materializeCompanionData(readCompanionSqliteSnapshot(db,{transaction:true})).lifeTransaction;
      if(tx&&tx.id!==data.id)throw Error('Companion life restore transaction changed');
      const target=tx?tx.target:readLifeRestoreSource(data.path,data.id,data.sha256);
      if(data.bridgeOnly)return {
        coreState:target.coreState,life:{id:target.life.id},conversations:target.conversations.map(({id})=>({id}))
      };
      validateLifeArchiveTarget(target,data.characterId);
      return {...lifeTargetBridgeData(target),...(tx?{legacyTargetHash:hash(JSON.stringify(target))}:{})};
    }
    case 'project-staged-life':{
      const target=readLifeRestoreSource(data.path,data.id,data.sha256);
      return writeLifeRestoreSource(data.path,data.id,applyStagedLifeProjection(target,data,data.characterId));
    }
    case 'stage-life-restore':{
      const {id,characterId,operationId,staging}=data;
      const target=readLifeRestoreSource(data.path,id,staging.sha256);
      const {rows,...plan}=lifeRestorePlan({id,characterId,operationId,target,staging});
      if(staging.complete)return plan;
      if(activeStages.has(id))throw Error('Companion life staging is already active');
      const writer=openCompanionDatabase(data.path);
      const progress={batches:0,messageRows:0,maxBatchRows:0,maxCommitMs:0};
      try{
        for(let start=staging.cursor;start<rows.length;start+=32){
          const end=Math.min(start+32,rows.length);
          activeStages.set(id,{writer,progress,sha256:staging.sha256,start,end,rows:rows.slice(start,end)});
          await send({start,end});
        }
        return {...plan,progress};
      }finally{activeStages.delete(id);writer.close();}
    }
    case 'write-life-restore-batch':{
      const {id,sha256,start,end}=data.batch,active=activeStages.get(id);
      if(!active||active.sha256!==sha256||active.start!==start||active.end!==end)
        throw Error('Companion life restore batch changed');
      const started=performance.now(),{writer,rows,progress}=active;
      const state=writer.load(),transaction=state.lifeTransaction;
      if(state.revision!==data.currentRevision||transaction?.id!==id||transaction.staging?.sha256!==sha256||
        transaction.staging.cursor!==start||transaction.staging.complete)
        throw Error('Companion life restore cursor changed');
      transaction.staging.cursor=end;
      const staged=writer.stage();
      stageRestoreRows(staged.api,rows);
      writer.commit(staged,{...state,revision:state.revision+1},state.revision,true,false,'life-restore-stage',data.commitTrace);
      const elapsedMs=performance.now()-started;
      progress.batches++;
      progress.messageRows+=rows.filter(row=>row.type==='message').length;
      progress.maxBatchRows=Math.max(progress.maxBatchRows,rows.length);
      progress.maxCommitMs=Math.max(progress.maxCommitMs,elapsedMs);
      return {revision:state.revision+1,rows:staged.rowsWritten,elapsedMs};
    }
    case 'read-life-preview':{
      const repository=archiveRepository(data,requestModel,checkImage);
      const {snapshot}=repository.read(data.id,data.sha256);
      return projectLifeArchivePreview(snapshot,data.personaId);
    }
    case 'prepare-life-export':{
      const repository=archiveRepository(data,requestModel,checkImage);
      const {bytes}=repository.read(data.id,data.sha256);
      const path=lifeTransferPath(dirname(dirname(data.path)),data.transferId);
      assertLifeTransferParent(path);
      writeFileSync(path,bytes,{flag:'wx'});
      return {fileName:data.id+'.zip',bytes:bytes.length,sha256:data.sha256};
    }
    case 'prepare-life-import':{
      const repository=archiveRepository(data,requestModel,checkImage);
      const path=lifeTransferPath(dirname(dirname(data.path)),data.id);
      if(assertLifeTransferFile(path,data.bytes)!==data.bytes)throw Error('人生 ZIP 编码或大小无效');
      const input=readFileSync(path);
      const bytes=data.encoding==='base64'?archiveBase64Bytes(input.toString('ascii')):input;
      const verifiedAssets=data.portableAssetRefs?{resolve(_path,bytes){
        // Engine validation checks the progress and ownership shape; the ZIP
        // image has already passed the codec and need not be projected yet.
        return 'cg-assets/portable-'+hash(bytes)+'/image.png';
      }}:null;
      const {snapshot}=repository.decode(bytes,{verifiedAssets});
      validateLifeArchiveTarget(snapshot,snapshot.characterId);
      const file=await repository.importVerified(bytes);
      return {archive:lifeArchiveMetadata(snapshot,file,{name:snapshot.card.name+' · 导入'}),
       target:{characterId:snapshot.characterId,life:{id:snapshot.life.id},content:snapshot.content,
        requiresWorkBridge:!!snapshot.workEvidence,coreState:snapshot.coreState}};
    }
    case 'read-life-archive-content':{
      const repository=archiveRepository(data,requestModel,checkImage);
      const {snapshot}=repository.read(data.id,data.sha256,restoreAssetOptions(data));
      return {life:{id:snapshot.life.id,operationId:snapshot.life.operationId},content:snapshot.content};
    }
    case 'seal-life-restore-source':{
      if(data.resetPersonas||data.resetArtwork){
        const current=withCompanionRead(db,reader=>readCompanionState(reader));
        if(data.resetArtwork)data.target.card.avatar=readLifeCardArtwork(current,data.resetArtwork,{verify:true});
        if(data.resetPersonas){
          data.target.personas=Object.fromEntries(Object.entries(data.target.personas).map(([id,persona])=>{
            if(!Object.hasOwn(current.personas,id))throw Error('人生身份数据无效');
            return [id,{...current.personas[id],relationships:persona.relationships}];
          }));
        }
      }
      return writeLifeRestoreSource(data.path,data.id,data.target);
    }
    case 'remove-life-restore-source':removeLifeRestoreSource(data.path,data.id);return true;
    case 'portable-conversations':return portableConversations(data,db,options=>requestModel(null,options));
    case 'maintenance-plan':return maintenancePlan(data.path,db,data.name,data.options);
    case 'maintenance-backup':return maintenanceBackup(db,data.target,data.revision);
    case 'private-startup-rows':return readPrivateStartupRows(db,data.after);
    case 'pending-mood':return readPendingMood(db,data.characterId,data.scope);
    case 'group-saved-photo':return readGroupSavedPhoto(db,data.groupId,data.range,data.characterIds);
    case 'group-reply-source':return readGroupReplySource(db,data.options);
    case 'import-inspect':return inspectImport(data);
    case 'import-interrupt':return interruptImport(data);
    case 'rollback':return exportRollback(data);
    case 'memory':return readCompanionMemory(data,db,requestModel,send,preparedMemory,readId,evidenceArchive);
    case 'write-prepared-memory':{
      const active=preparedMemory?.get(data.record.token);
      if(!active||!isDeepStrictEqual(active.record,data.record))throw Error('Prepared companion memory record changed');
      preparedMemory.delete(data.record.token);
      const started=performance.now(),writer=openCompanionDatabase(data.path);
      try{
        const {namespace,owner,key,value,descriptor}=active.entry,staged=writer.stage();
        staged.api.records.put(namespace,owner,key,value,descriptor);
        const current=data.currentRevision;
        writer.commit(staged,{revision:current+1},current,false,true,'memory.prepared-record',data.commitTrace);
        return {revision:current+1,rows:staged.rowsWritten,elapsedMs:performance.now()-started,sha256:active.record.sha256};
      }finally{writer.close();}
    }
    case 'verify-prepared-memory':
      return readPreparedCompanionMemoryCommit(db,data.record);

    case 'store-life-media':{
      const media=createMediaStore(dirname(dirname(data.path)));
      return data.images.map(value=>media.put(value));
    }
    case 'write-life-archive-metadata':return writeLifeArchiveMetadata(data);
    default:throw Error('Unsupported companion worker operation');
  }
}

function openMemoryPublisher(path){
  let writer;
  parentPort.on('message',({id,data,close})=>{
    if(close){
      try{writer?.close();}
      finally{parentPort.close();}
      return;
    }
    try{
      const {id:publicationId,operation,plan,currentRevision,writeMemoryRevision,commitTrace}=data;
      const marks=commitTrace??new BigInt64Array(new SharedArrayBuffer(24)),started=process.hrtime.bigint();
      Atomics.store(marks,0,started);
      const recordBytes=boundedMemoryRecordPlanBytes(plan),revision=currentRevision+1;
      if(recordBytes===null)throw Error('Invalid companion memory record plan');
      writer??=openCompanionDatabase(path);
      const staged=writer.stage(plan);
      writer.commit(staged,{revision},currentRevision,false,writeMemoryRevision,operation,marks);
      const committed=Atomics.load(marks,2),commitStart=Atomics.load(marks,1);
      parentPort.postMessage({id,result:{
        id:publicationId,revision,rows:staged.rowsWritten,recordBytes,
        elapsedMs:Number(committed-started)/1e6,commitMs:Number(committed-commitStart)/1e6
      }});
    }catch(error){
      parentPort.postMessage({id,error:{message:error.message,code:error.code}});
    }
  });
}

function openAutoArchivePublisher(path){
  const archive=createEvidenceArchive(join(dirname(path),'auto-evidence.sqlite'),{wal:true,persistent:true});
  parentPort.on('message',({id,data,close})=>{
    if(close){
      try{archive.close();}
      finally{parentPort.close();}
      return;
    }
    try{
      archive.putMany(data.rows);
      parentPort.postMessage({id,result:true});
    }catch(error){parentPort.postMessage({id,error:{message:error.message,code:error.code}});}
  });
}

function openReaderSession(path){
  const db=openCompanionReader(path);
  const evidenceArchive=createEvidenceArchive(join(dirname(path),'auto-evidence.sqlite'),{readOnly:true});
  const pending=new Map(),activeStages=new Map(),preparedMemory=new Map();
  let memoryUpdateTail=Promise.resolve();
  parentPort.on('message',async message=>{
    if(message.close){
      try{db.close();}
      finally{parentPort.close();}
      return;
    }
    const {id,data,modelResult,batchResult,archiveResult,cancel}=message;
    if(modelResult||batchResult||archiveResult){receiveHost(pending.get(id),modelResult??batchResult??archiveResult);return;}
    if(cancel){
      for(const request of pending.get(id)?.values()??[])request.reject(Error('Companion storage request cancelled'));
      pending.delete(id);
      return;
    }
    const callbacks=new Map();
    pending.set(id,callbacks);
    const run=async()=>{
      if(pending.get(id)!==callbacks)return;
      try{
        const result=await runStorageOperation({...data,path},db,(characterId,options)=>{
          if(!pending.has(id))return Promise.reject(Error('Companion storage request cancelled'));
          return requestHost(callbacks,{id},'model',{characterId,options});
        },value=>{
          if(!pending.has(id))return Promise.reject(Error('Companion storage request cancelled'));
          return requestHost(callbacks,{id},'batch',{value});
        },(bytes,options)=>checkArchiveImage(id,bytes,options),activeStages,preparedMemory,id,{
          ...evidenceArchive,
          putMany:rows=>{
            if(!pending.has(id))return Promise.reject(Error('Companion storage request cancelled'));
            return requestHost(callbacks,{id},'archive',{value:rows});
          }
        });
        if(pending.has(id))parentPort.postMessage({id,result});
      }catch(error){
        if(pending.has(id))parentPort.postMessage({id,error:{
          message:error.message,code:error.code,
          ...(error.code==='LIFE_ARCHIVE_MISSING_CG'&&Array.isArray(error.missing)?{missing:error.missing}:{})
        }});
      }finally{pending.delete(id);}
    };
    if(data.operation==='memory'&&(data.method==='consolidate'||data.method==='tick')){
      // Leases share this reader. A second daily update must wait until the
      // first one has received its durable dispatch and result acknowledgements.
      const update=memoryUpdateTail.then(run);
      memoryUpdateTail=update.catch(()=>{});
      await update;
    }else await run();
  });
}

function receiveStream(){
  return new Promise((resolve,reject)=>{
    const metadata=receiveLifeMetadata();
    function receive(message){
      try{
        if(message.lifeMetadataFrame)metadata.append(message.lifeMetadataFrame);
        if(Object.hasOwn(message,'lifeMetadataRoot')){
          parentPort.off('message',receive);
          resolve(metadata.finish(message.lifeMetadataRoot));
        }
      }catch(error){parentPort.off('message',receive);reject(error);}
    }
    parentPort.on('message',receive);
  });
}

if(parentPort&&workerData){
  if(workerData.operation==='reader')openReaderSession(workerData.path);
  else if(workerData.operation==='memory-publisher')openMemoryPublisher(workerData.path);
  else if(workerData.operation==='auto-archive-publisher')openAutoArchivePublisher(workerData.path);
  else{
    const pending=new Map(),receive=message=>receiveHost(pending,message.modelResult);
    parentPort.on('message',receive);
    try{
      const payload=workerData.streamLifeMetadata?await receiveStream():null;
      const result=await runStorageOperation({...workerData,...payload},undefined,(characterId,options)=>requestHost(pending,{},'model',{characterId,options}));
      parentPort.postMessage({result});
    }catch(error){parentPort.postMessage({error:{message:error.message,code:error.code}});}
    finally{parentPort.off('message',receive);}
  }
}