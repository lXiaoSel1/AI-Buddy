import {copyCompanionValue} from './companion-draft.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {channel} from 'node:diagnostics_channel';
import {enablePatches,Immer} from 'immer';
import {openCompanionDatabase,reportSlowCompanionTransaction} from './companion-sqlite.mjs';
import {acquireCompanionStorageReader,boundedMemoryRecordPlanBytes,createCompanionAutoArchivePublisher,createCompanionMemoryPublisher,prepareCompanionStorage,runCompanionStorageWorker} from './companion-storage-worker-client.mjs';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import {createEvidenceArchive} from './evidence-archive.mjs';
import {createCompanionWalMaintenance} from './companion-wal-maintenance.mjs';
import {startCompanionWriteTrace} from './companion-write-trace.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {currentLife} from './companion-life.mjs';
import {normalizePhotoPlannerBinding} from './group-cg-planner.mjs';
import {imageSlots,isMediaUrl} from './media-store.mjs';

export const DEFAULT_PERSONA_ID='default';
export function companionId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_:.-]{1,200}$/.test(value)||value==='prototype'||Object.hasOwn(Object.prototype,value))throw Error('身份或记录 ID 格式无效');return value;}
export const CARD_FIELDS=['intro','identity','background','personality','interests','likes','dislikes','tone','selfAddress','speechHabits','address','relationship','meeting','greeting','visual','sprite','backgroundImage','referenceImage'];
export function cardTalkativeness(value=.5){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)throw Error('健谈程度应在 0–100%');return value;}
export function migrateCharacterTalkativeness(state,at=Date.now()){
 for(const card of Object.values(state.cards)){
  if(Object.hasOwn(card,'talkativeness')){cardTalkativeness(card.talkativeness);continue;}
  const legacy=Object.values(state.groups).filter(group=>Object.hasOwn(group.talkativeness??{},card.id)).map(group=>({groupId:group.id,value:group.talkativeness[card.id],updatedAt:Number(group.updatedAt)||0})).filter(row=>typeof row.value==='number'&&Number.isFinite(row.value)&&row.value>=0&&row.value<=1).sort((a,b)=>b.updatedAt-a.updatedAt||a.groupId.localeCompare(b.groupId));
  card.talkativeness=legacy[0]?.value??.5;
  state.characterTalkativenessMigration??={version:1,at,entries:[]};state.characterTalkativenessMigration.entries.push({characterId:card.id,value:card.talkativeness,sourceGroupId:legacy[0]?.groupId??null,legacy});
 }
}
const memoryPublications=channel('ai-buddy.companion.memory-publisher');
const copy=copyCompanionValue;
enablePatches();
const companionDraft=new Immer({autoFreeze:false});
function fitsLifeMetadataDelta(value){
 let remaining=512*1024;
 function visit(item){
  remaining-=8;
  if(remaining<0)return false;
  if(typeof item==='string'){remaining-=item.length*3;return remaining>=0;}
  if(!item||typeof item!=='object')return true;
  if(item instanceof Map){
   for(const [key,value] of item)if(!visit(key)||!visit(value))return false;
  }else if(item instanceof Set){
   for(const value of item)if(!visit(value))return false;
  }else for(const key in item)if(Object.hasOwn(item,key)&&(!visit(key)||!visit(item[key])))return false;
  return true;
 }
 return visit(value);
}
// Guards may inspect a few live fields without copying the archive. Wrap lazily
// so neither assignment nor descriptor access can change committed state.
function readOnlyGuardState(state){
 const views=new WeakMap(),reject=()=>{throw TypeError('Companion mutation guards are read-only');};
 const view=value=>{
  if(!value||typeof value!=='object')return value;if(views.has(value))return views.get(value);
  const proxy=new Proxy(value,{get:(target,key,receiver)=>view(Reflect.get(target,key,receiver)),getOwnPropertyDescriptor(target,key){const descriptor=Reflect.getOwnPropertyDescriptor(target,key);return descriptor&&'value'in descriptor?{...descriptor,value:view(descriptor.value)}:descriptor;},set:reject,deleteProperty:reject,defineProperty:reject,setPrototypeOf:reject,preventExtensions:reject});
  views.set(value,proxy);return proxy;
 };return view(state);
}
const text=(value,limit=20000)=>{if(typeof value!=='string')throw Error('文本字段格式无效');if([...value].length>limit)throw Error(`文本超过 ${limit} 字符；原文未截断`);return value.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');};
export const progress=(value={})=>({level:Math.max(1,Math.floor(Number(value.level)||1)),affection:Math.max(0,Number(value.affection)||0)});
export const cap=level=>30+(Math.max(1,level)-1)*15;
export function advanceProgress(value,delta){const next=progress(value);next.affection=Math.max(0,next.affection+delta);const levels=[];while(next.affection>=cap(next.level)){next.affection-=cap(next.level);next.level++;levels.push(next.level);}return {...next,levels};}
function initial(){return {schema:1,migrated:false,activeCharacterId:'deepseek',activePersonaId:DEFAULT_PERSONA_ID,activeConversationId:null,activeGroupId:null,cards:{},personas:{[DEFAULT_PERSONA_ID]:{id:DEFAULT_PERSONA_ID,name:'默认身份',nickname:'你',createdAt:Date.now(),relationships:{}}},relationships:{},conversations:{},groups:{},touchQuotas:{},events:{},draftCards:{},settings:{allowUserMessageEdit:false}};}
const openCompanionWriters=new Map();

export async function exportCompanionForRollback(dataRoot){
 const directory=resolve(dataRoot,'galgame'),path=join(directory,'companion.sqlite');
 if(openCompanionWriters.has(path))throw Error('Companion database is currently open');
 return runCompanionStorageWorker({operation:'rollback',path,legacyPath:join(directory,'companion.json')});
}

function importWorker(dataRoot,operation,planId){
 const directory=resolve(dataRoot,'galgame'),path=join(directory,'companion.sqlite');
 if(operation==='import-interrupt'&&openCompanionWriters.has(path))return Promise.reject(Error('Companion database is currently open'));
 return runCompanionStorageWorker({operation,path,legacyPath:join(directory,'companion.json'),planId});
}
export const inspectCompanionDataRoot=dataRoot=>importWorker(dataRoot,'import-inspect');
export const interruptImportedCompanion=(dataRoot,planId)=>importWorker(dataRoot,'import-interrupt',planId);

export async function openCompanionStore(dataRoot,{media=null,deferredSaveRegistry=null,audit,sqlClock,onMigrationProgress,interruptMigrationAfter,publishLifeRestoreTimeoutMs=30000,runLifeArchiveMetadata=runCompanionStorageWorker}={}){
 const directory=resolve(dataRoot,'galgame'),sqlitePath=join(directory,'companion.sqlite');
 const firstState={...initial(),schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1']};
 const started=performance.now();
 await prepareCompanionStorage(sqlitePath,join(directory,'companion.json'),firstState,{
  interruptMigrationAfter,
  cleanRestoreSources:!openCompanionWriters.has(sqlitePath),
  onMigrationProgress:progress=>{
   onMigrationProgress?.(progress);
   if(['discovered','validated','database-published','ready'].includes(progress.phase)){
    try{audit?.({type:'companion-migration',phase:progress.phase,count:progress.count??null,total:progress.total??null,elapsedMs:performance.now()-started});}catch{}
   }
  }
 });
 return openSqliteCompanionStore(dataRoot,sqlitePath,{media,deferredSaveRegistry,audit,sqlClock,publishLifeRestoreTimeoutMs,runLifeArchiveMetadata});
}

function memoryMetadataEffect(before,after){
 if(before.memorySettings!==after.memorySettings)return 'memorySettings';
 if(before.cards!==after.cards)return 'cards';
 if(before.personas!==after.personas)return 'personas';
 const changedField=(collection,fields)=>{
  const oldRows=before[collection],newRows=after[collection];
  if(oldRows===newRows)return null;
  const oldIds=Object.keys(oldRows??{}),newIds=Object.keys(newRows??{});
  if(oldIds.length!==newIds.length)return collection+'.membership';
  for(const id of oldIds){
   if(!Object.hasOwn(newRows,id))return collection+'.membership';
   const field=fields.find(key=>oldRows[id][key]!==newRows[id][key]);
   if(field)return collection+'.'+field;
  }
  return null;
 };
 const transactionFields=['id','characterId','operationId','phase'];
 if(transactionFields.some(key=>before.lifeTransaction?.[key]!==after.lifeTransaction?.[key]))return 'lifeTransaction';
 const lives=changedField('lives',[
  'id','operationId','mode','startedAt','memory','growth','groupIntervals','restoredGroupEvidence',
  'personalEvents','gameExperiences','workExperiences','socialExperiences'
 ]);
 if(lives)return lives;
 if(before.lives!==after.lives&&Object.entries(before.lives??{}).some(([id,life])=>life.r95?.lines!==after.lives?.[id]?.r95?.lines))return 'life.r95.lines';
 return changedField('conversations',['characterId','personaId','lifeId','importedFrom'])
  ??changedField('groups',['personaId','importedFrom','intervals']);
}

const parkedForCheckpoint=Symbol('parkedForCheckpoint');

const tracedMemoryOperations=new Set([
 'memory.sync','memory.tick','memory.consolidate','life-restore-prepare','life-restore-stage','life-restore-staged','life-restore-publish'
]);
const tracedMemoryNamespaces=new Set([
 'group.intervals','life.groupIntervals','life.personalEvents','life.gameExperiences','life.workExperiences','life.socialExperiences','life.r95.lines',
 'memory.events','memory.jobs','memory.summaries','memory.guides','memory.core','memory.branches','memory.working','memory.notices',
 'memory.coverageHeader.jobs','memory.coverageHeader.summaries','memory.coverage.cutoff','memory.coverage.eventIds',
 'memory.coverage.modelEventIds','memory.coverage.segments','growth.history','growth.observations','growth.batches','growth.evidenceUse',
 'growth.daily','growth.failures','growth.preferences.traits','growth.preferences.evidenceUseByTrait','growth.trait.evidence',
 'growth.trait.counterEvidence','growth.trait.versions'
]);

function memoryCommitEffects(staged,prepared,metadata){
 const effects=new Set(metadata?[metadata]:[]);
 const namespaceEffect=namespace=>tracedMemoryNamespaces.has(namespace)?namespace:
  namespace.startsWith('memory.')?'memory.records':namespace.startsWith('growth.')?'growth.records':null;
 if(prepared)effects.add(namespaceEffect(prepared.namespace)??'prepared-memory-record');
 if(staged.memoryChanged){
  const {owners,recordStages,messageMoves,recordMoves}=staged.plan();
  if(messageMoves.length)effects.add('messages.move');
  if(recordMoves.length)effects.add('records.move');
  for(const owner of owners.values()){
   if(!owner.type.startsWith('transaction-')&&(owner.deleted||[...owner.rows.values()].some(row=>!row||row.memoryChanged)))
    effects.add(owner.type==='private'?'messages.private':owner.type==='group'?'messages.group':'messages.other');
  }
  for(const slot of recordStages.values()){
   const effect=namespaceEffect(slot.namespace);
   if(effect&&(slot.cleared||[...slot.rows.values()].some(row=>!row||row.memoryChanged)))effects.add(effect);
   if(effects.size>=8)break;
  }
 }
 return [...effects].slice(0,8);
}

function verifyLifeRestoreCursor(before,after,batch,staged){
 const transaction=before.lifeTransaction,staging=transaction?.staging;
 const next=after.lifeTransaction,nextStage=next?.staging;
 const sameExcept=(left,right,except)=>Object.keys(left).length===Object.keys(right).length&&
  Object.keys(left).every(key=>except.includes(key)||Object.hasOwn(right,key)&&left[key]===right[key]);
 if(staged.changed||transaction?.id!==batch.id||staging?.sha256!==batch.sha256||staging.cursor!==batch.start||
  nextStage?.cursor!==batch.end||!sameExcept(before,after,['revision','lifeTransaction'])||
  !sameExcept(transaction,next,['staging'])||!sameExcept(staging,nextStage,['cursor']))
  throw Error('Companion life restore batch can only advance its own staging cursor');
}

function openSqliteCompanionStore(dataRoot,path,{media,deferredSaveRegistry,audit,sqlClock=()=>performance.now(),publishLifeRestoreTimeoutMs,runLifeArchiveMetadata}){
 const sql=openCompanionDatabase(path,{audit,clock:sqlClock}),scope=resolve(dataRoot);
 let state=sql.load(),memorySourceRevision=sql.memorySourceRevision(),tail=Promise.resolve(),closing=null,publishing=null,authorityError=null;
 openCompanionWriters.set(path,(openCompanionWriters.get(path)??0)+1);
 const evidence=createEvidenceArchive(join(dataRoot,'galgame','auto-evidence.sqlite'),{readOnly:true});
 let authorizationRevision=0;
 const archive={...evidence,get authorizationRevision(){return authorizationRevision;}};
 const reads=new Set(),reader=acquireCompanionStorageReader(path),memoryPublisher=createCompanionMemoryPublisher(path);
 const autoArchivePublisher=createCompanionAutoArchivePublisher(path);
 async function publishArchiveEvidence(rows){
  const acknowledged=await autoArchivePublisher.publish({rows},{timeoutMs:publishLifeRestoreTimeoutMs});
  if(acknowledged!==true)throw Error('Companion Auto archive acknowledgement mismatch');
 }
 const workerOwnedMedia=media?.directory&&resolve(media.directory)===join(scope,'galgame','media');
 const maintenance=createCompanionWalMaintenance(path,{lastWrite:reader.lastWrite,audit});
 let memoryPublisherAuthorityError=null;
 const syncRecords=Object.fromEntries(Object.entries(sql.records).map(([name,readRecord])=>[name,(...args)=>{
  if(memoryPublisherAuthorityError)throw memoryPublisherAuthorityError;
  return readRecord(...args);
 }]));
 const memorySourceTrace=process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE==='1'?[]:null;
 const traceWrites=process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE==='1',lifeWriteScope=new AsyncLocalStorage();
 async function publishMemoryRecord(record,revision,waitFor,commitTrace){
  const releaseSnapshot=sql.pinReadSnapshot();
  let releasePublishing;
  publishing=new Promise(resolve=>{releasePublishing=resolve;});
  const timeout={timeoutMs:publishLifeRestoreTimeoutMs};
  try{
   const result=await waitFor(reader.read({operation:'write-prepared-memory',record,currentRevision:revision,commitTrace},timeout));
   if(result.revision!==revision+1||result.sha256!==record.sha256)throw Error('Companion memory record acknowledgement mismatch');
   return result;
  }catch(commitError){
   try{
    const actual=await waitFor(reader.read({operation:'verify-prepared-memory',record},timeout));
    if(actual.revision===revision)throw commitError;
    if(actual.revision!==revision+1||actual.memorySourceRevision!==actual.revision||actual.sha256!==record.sha256)
     throw Error('Companion memory record commit state mismatch');
    return {...actual,rows:1};
   }catch(error){
    if(error===commitError)throw error;
    authorityError=Object.assign(Error('Companion memory record state changed outside the current store; reopen it'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:error});
    throw authorityError;
   }
  }finally{
   try{releaseSnapshot();}
   catch(error){
    authorityError=Object.assign(Error('Companion memory record snapshot could not be released; reopen the store'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:error});
    throw authorityError;
   }finally{publishing=null;releasePublishing();}
  }
 }
 async function publishRecordPlan(plan,operation,revision,memoryChanged,commitTrace,waitFor){
  const id=randomUUID(),releaseSnapshot=sql.pinReadSnapshot();
  function unpin(){
   try{releaseSnapshot();}
   catch(error){
    authorityError=memoryPublisherAuthorityError=Object.assign(Error('Companion memory record snapshot could not be released; reopen the store'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:error});
    throw authorityError;
   }
  }
  let failure,stopped=true;
  try{
   const result=await waitFor(memoryPublisher.publish({id,operation,plan,currentRevision:revision,writeMemoryRevision:memoryChanged,commitTrace},
    {timeoutMs:publishLifeRestoreTimeoutMs}));
   if(result?.id!==id||result.revision!==revision+1)throw Error('Companion memory record acknowledgement mismatch');
   return {result,unpin};
  }catch(error){
   failure=error;
   try{await waitFor(memoryPublisher.stop(true));}
   catch(stopError){
    stopped=false;
    failure=new AggregateError([error,stopError],'Companion memory publisher did not stop',{cause:error});
   }finally{unpin();}
  }
  if(stopped){
   let actual;
   try{actual=sql.readRevision();}
   catch(error){failure=new AggregateError([failure,error],'Companion memory record revision could not be read',{cause:failure});}
   if(actual===revision)throw failure;
  }
  authorityError=memoryPublisherAuthorityError=Object.assign(Error('Companion memory record commit could not be confirmed; reopen the store'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:failure});
  throw authorityError;
 }
 function writeLifeMetadata(run,data,payload){
  const options={timeoutMs:publishLifeRestoreTimeoutMs};
  if(fitsLifeMetadataDelta(payload))return run({...data,...payload},undefined,options);
  return run(data,undefined,{...options,streamLifeMetadata:payload});
 }
 function read(input,options){
  if(closing||authorityError)return Promise.reject(authorityError??Error('Companion store is closing'));
  if(publishing)return publishing.then(()=>read(input,options));
  const task=input.operation==='seal-life-restore-source'&&!fitsLifeMetadataDelta(input)
   ?runCompanionStorageWorker({operation:input.operation,path},undefined,{...options,timeoutMs:publishLifeRestoreTimeoutMs,streamLifeMetadata:input})
   :reader.read(input,options);
  reads.add(task);void task.finally(()=>reads.delete(task)).catch(()=>{});
  return task;
 }
 async function drain(){
  await tail;
  while(reads.size)await Promise.allSettled([...reads]);
  // A completed read can enqueue its final write as it settles.
  await tail;
 }
 const api={
  archive,
  archivedAutoAuthorization:(groupId,authorizationId)=>read({operation:'auto-authorization-exists',groupId,authorizationId}),
  records:{...syncRecords,query:(namespace,owner,options)=>read({operation:'records',namespace,owner,options})},
  messages:{...sql.messages,
    history:(type,ownerId,options)=>read({operation:'history',type,ownerId,options}),
    query:options=>read({operation:'query',options}),
    searchOwners:(type,search,language)=>read({operation:'search-owners',type,search,language})
  },
  withLifeArchiveWrites(perform){
   if(lifeWriteScope.getStore()?.open)return perform();
   const scope={open:true};
   return lifeWriteScope.run(scope,async()=>{try{return await perform();}finally{scope.open=false;}});
  },
  get state(){return state;},
  get memorySourceRevision(){return memorySourceRevision;},
  ...(memorySourceTrace?{memorySourceChanges:after=>memorySourceTrace.filter(row=>row.revision>after)}:{}),
  mutate(fn,{storeImages:convert=true,guard,receipt=false,operation='mutate',publishLifeRestore=false,clearLifeRestore=false,prepareLegacyLife=null,lifeRestoreBatch=null,memoryRecordBatch=null,publishMemoryRecords=false,waitForScheduledCheckpoint=false}={}){
   if(closing||authorityError)return Promise.reject(authorityError??Error('Companion store is closing'));
   const writeTrace=traceWrites?startCompanionWriteTrace(operation):null,commitTrace=writeTrace?.marks;
   const scopedLifeWrite=lifeWriteScope.getStore()?.open===true||publishLifeRestore||clearLifeRestore||!!prepareLegacyLife;
   const restoreCheckpoint=publishLifeRestore||clearLifeRestore?'restore-finish':lifeRestoreBatch?.end%640===0?'restore-stage':null;
   let committedRestoreCheckpoint=false,tracedRows=0,tracedWorkerWait=0;
   let parked=false;
   const waitsForCheckpoint=operation==='memory.tick'&&waitForScheduledCheckpoint;
   const commit=async()=>{
    if(waitsForCheckpoint&&!closing&&!authorityError){
     const flight=maintenance.timerFlight;
     if(flight){
      parked=true;
      return {[parkedForCheckpoint]:flight};
     }
    }
    writeTrace?.enter();
    if(authorityError)throw authorityError;
    if(parked&&closing)throw Error('Companion store is closing');
    if(guard){
     const proceed=guard(readOnlyGuardState(state));
     if(typeof proceed!=='boolean')throw TypeError('Companion mutation guards must return a boolean synchronously');
     if(!proceed)return;
    }
    const started=sqlClock(),archiveRows=[],archiveArtwork=[];
    let staged,workerAttempted=false,workerWaitMs=0,publication,releaseMemoryPublication;
    try{
     const draft=companionDraft.createDraft(state);staged=sql.stage();
     let result,next,finished=false,patches;
     try{
      result=await fn(draft,{...staged.api,
       archiveEvidence(rows){for(const row of rows)archiveRows.push(copy(row));},
       archiveArtwork(archiveId,locator){archiveArtwork.push({archiveId,locator});}
      });
      if(convert&&media){
       const images=[...changedCompanionImages(state,draft)];
       if(workerOwnedMedia&&images.length){
        workerAttempted=scopedLifeWrite;
        const writing=writeLifeMetadata(runCompanionStorageWorker,{operation:'store-life-media',path},{
         images:images.map(([, ,value])=>value)
        });
        const beforeWait=sqlClock();
        let urls;
        try{urls=await writing;}
        finally{workerWaitMs+=sqlClock()-beforeWait;}
        if(!Array.isArray(urls)||urls.length!==images.length||urls.some(value=>value!==null&&!isMediaUrl(value)))
         throw Error('Companion life media acknowledgement mismatch');
        for(const [index,[holder,key]] of images.entries())if(urls[index])holder[key]=urls[index];
       }else for(const [holder,key,value] of images){
        const url=media.put(value);
        if(url)holder[key]=url;
       }
      }
      if(result&&typeof result==='object')result=copy(result);
      finished=true;
      next=companionDraft.finishDraft(draft,scopedLifeWrite?changes=>{patches=changes;}:undefined);
     }finally{
      if(!finished)companionDraft.finishDraft(draft);
     }
     if(next===state&&!staged.changed&&!memoryRecordBatch)return receipt?{value:result,memorySourceRevision}:result;
     const changed=next!==state,revision=state.revision;
     const memoryPlan=publishMemoryRecords&&!changed&&staged.changed?staged.plan():null;
     next={...next,revision:revision+1};
     // A records-only commit still updates the revision of the same large SQL row.
     const delta=patches?{patches,plan:staged.plan(),archiveArtwork}:null;
     if(archiveArtwork.length&&(!delta||memoryRecordBatch||publishLifeRestore||clearLifeRestore||prepareLegacyLife||lifeRestoreBatch))
      throw Error('操作失败。');
     if(lifeRestoreBatch)verifyLifeRestoreCursor(state,next,lifeRestoreBatch,staged);
     const stagedMemoryChanged=!!memoryRecordBatch||staged.memoryChanged;
     const metadataEffect=changed&&(!stagedMemoryChanged||memorySourceTrace)?memoryMetadataEffect(state,next):null;
     const memoryChanged=stagedMemoryChanged||metadataEffect!==null;
     if(archiveRows.length){
      // The archive can safely have a duplicate if the primary transaction
      // fails. It must never be missing a row whose primary deletion commits.
      const writing=publishArchiveEvidence(archiveRows);
      const beforeWait=sqlClock();
      try{await writing;}
      finally{workerWaitMs+=sqlClock()-beforeWait;}
      if(archiveRows.some(row=>row.namespace.startsWith('auto-authorizations:')))authorizationRevision++;
     }
     if(memoryRecordBatch){
      if(changed||staged.changed)throw Error('Prepared companion memory writes can only update their record');
      publication=await publishMemoryRecord(memoryRecordBatch,revision,async writing=>{
       const beforeWait=sqlClock();
       try{return await writing;}
       finally{workerWaitMs+=sqlClock()-beforeWait;}
      },commitTrace);
     }else if(publishLifeRestore||clearLifeRestore||prepareLegacyLife||lifeRestoreBatch){
      const releaseSnapshot=sql.pinReadSnapshot();
      let releasePublishing;
      publishing=new Promise(resolve=>{releasePublishing=resolve;});
      let committed,commitError;
      try{
       workerAttempted=true;
       const writing=lifeRestoreBatch
        ?reader.read({operation:'write-life-restore-batch',batch:lifeRestoreBatch,currentRevision:revision,commitTrace})
        :writeLifeMetadata(runCompanionStorageWorker,{
          operation:prepareLegacyLife?'prepare-legacy-life-restore':clearLifeRestore?'clear-life-restore':'publish-life-restore',
          path,clearLifeRestore,currentRevision:revision,writeMemoryRevision:memoryChanged,commitTrace
         },{...delta,prepareLegacyLife});
       // Worker construction and postMessage belong to main-thread time.
       const beforeWait=sqlClock();
       try{committed=await writing;}
       finally{workerWaitMs+=sqlClock()-beforeWait;}
       if(committed.revision!==next.revision||prepareLegacyLife&&!/^[a-f0-9]{64}$/.test(committed.sha256))
        throw Error('Life restore acknowledgement mismatch');
       if(prepareLegacyLife)next.lifeTransaction.staging.sha256=committed.sha256;
      }catch(error){commitError=error;}
      finally{
       try{releaseSnapshot();}
       catch(error){
        authorityError=Object.assign(Error('Life restore snapshot could not be released; reopen the store'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:error});
        throw authorityError;
       }finally{publishing=null;releasePublishing();}
      }
      if(commitError){
       try{
        const actual=sql.load();
        if(actual.revision===revision)throw commitError;
        const expected=next.lastLifeTransaction,received=actual.lastLifeTransaction;
        const actualStage=actual.lifeTransaction?.staging;
        const matching=lifeRestoreBatch
         ?actual.lifeTransaction?.id===lifeRestoreBatch.id&&actualStage?.sha256===lifeRestoreBatch.sha256&&actualStage.cursor===lifeRestoreBatch.end
         :prepareLegacyLife
          ?actual.lifeTransaction?.id===next.lifeTransaction.id&&actual.lifeTransaction.phase===next.lifeTransaction.phase&&
           actualStage?.cursor===0&&!actualStage.complete&&actualStage.planVersion===2&&/^[a-f0-9]{64}$/.test(actualStage.sha256)
          :expected?.id&&received?.id===expected.id&&received.status===expected.status&&actual.lifeTransaction?.phase===next.lifeTransaction?.phase;
        if(actual.revision!==next.revision||!matching)throw Error('Life restore commit state mismatch');
        if(prepareLegacyLife)next=actual;
       }catch(error){
        if(error===commitError)throw error;
        authorityError=Object.assign(Error('Life restore state changed outside the current store; reopen it'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:error});
        throw authorityError;
       }
      }else publication=committed;
     }else if(memoryPlan&&(operation==='memory.tick'||boundedMemoryRecordPlanBytes(memoryPlan)!==null)){
      publishing=new Promise(resolve=>{releaseMemoryPublication=resolve;});
      const committed=await publishRecordPlan(memoryPlan,operation,revision,memoryChanged,commitTrace,async writing=>{
       const beforeWait=sqlClock();
       try{return await writing;}
       finally{workerWaitMs+=sqlClock()-beforeWait;}
      });
      publication=committed.result;
      // Synchronous record readers and RAM must advance in the same turn.
      committed.unpin();
     }else if(delta){
      const releaseSnapshot=sql.pinReadSnapshot(),id=randomUUID();
      let releasePublishing,committed,commitError;
      publishing=new Promise(resolve=>{releasePublishing=resolve;});
      try{
       workerAttempted=true;
       const writing=writeLifeMetadata(runLifeArchiveMetadata,{
        operation:'write-life-archive-metadata',writeOperation:operation,path,id,
        currentRevision:revision,writeMemoryRevision:memoryChanged,commitTrace
       },delta);
       const beforeWait=sqlClock();
       try{committed=await writing;}
       finally{workerWaitMs+=sqlClock()-beforeWait;}
       if(committed.id!==id||committed.revision!==next.revision)throw Error('Life metadata commit acknowledgement mismatch');
      }catch(error){commitError=error;}
      finally{
       try{releaseSnapshot();}
       catch(error){
        authorityError=Object.assign(Error('Life metadata snapshot could not be released; reopen the store'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:error});
        throw authorityError;
       }finally{publishing=null;releasePublishing();}
      }
      if(commitError){
       try{if(sql.readRevision()===revision)throw commitError;}
       catch(error){
        if(error===commitError)throw error;
        commitError=new AggregateError([commitError,error],'Life metadata commit could not be confirmed',{cause:commitError});
       }
       authorityError=Object.assign(Error('Life metadata commit could not be confirmed; reopen the store'),{code:'COMPANION_STORE_REOPEN_REQUIRED',cause:commitError});
       throw authorityError;
      }
      publication=committed;
     }else try{sql.commit(staged,next,revision,changed,memoryChanged,operation,commitTrace);}
     catch(error){
      if(error.code==='COMPANION_STORE_REOPEN_REQUIRED')authorityError=error;
      throw error;
     }
     if(writeTrace)tracedWorkerWait=workerWaitMs;
     state=next;
     reader.noteWrite();
     if(!closing&&!authorityError){
      maintenance.schedule();
      committedRestoreCheckpoint=restoreCheckpoint!==null;
     }
     if(memoryChanged){
      memorySourceRevision=next.revision;
      if(memorySourceTrace){
       const effects=memoryCommitEffects(staged,memoryRecordBatch,metadataEffect);
       memorySourceTrace.push({revision:next.revision,operation:tracedMemoryOperations.has(operation)?operation:'mutate',effects});
       if(memorySourceTrace.length>8)memorySourceTrace.shift();
      }
     }
     return receipt?{value:result,memorySourceRevision}:result;
    }finally{
     const elapsedMs=sqlClock()-started,rows=publication?.rows??staged?.rowsWritten??0;
     const mainThreadMs=elapsedMs-workerWaitMs;
     if(writeTrace){tracedRows=rows;if(releaseMemoryPublication||!Atomics.load(commitTrace,2))tracedWorkerWait=workerWaitMs;}
     if(releaseMemoryPublication){
      publishing=null;releaseMemoryPublication();
      if(memoryPublications.hasSubscribers)memoryPublications.publish({operation,rows,recordBytes:publication?.recordBytes??null,
       elapsedMs,mainThreadMs,workerWaitMs,workerElapsedMs:publication?.elapsedMs??null,workerCommitMs:publication?.commitMs??null});
     }
     if(workerAttempted&&!lifeRestoreBatch)try{audit?.({type:'companion-life-restore-worker',operation,rows,elapsedMs,mainThreadMs,workerElapsedMs:publication?.elapsedMs??null,workerWaitMs});}catch{}
     reportSlowCompanionTransaction(audit,{operation,rows,elapsedMs:mainThreadMs,scope:'mutate',...(workerAttempted||releaseMemoryPublication||archiveRows.length||archiveArtwork.length?{mainThreadMs,workerWaitMs}:{})});
    }
   };
   function enqueue(){
    let queued=tail.then(commit);
    if(writeTrace)queued=queued.then(value=>{
     if(!value?.[parkedForCheckpoint])writeTrace.finish(false,tracedRows,tracedWorkerWait);
     return value;
    },error=>{
     writeTrace.finish(true,tracedRows,tracedWorkerWait);throw error;
    });
    queued=queued.finally(yieldImmediate);
    tail=queued.catch(()=>{});
    return queued;
   }
   const task=enqueue();
   if(waitsForCheckpoint)return task.then(async value=>{
    // Keep the admitted batch and its trace, leaving the tail available for
    // normal writes until the timer's checkpoint has finished.
    while(value?.[parkedForCheckpoint]){
     await value[parkedForCheckpoint];
     value=await enqueue();
    }
    return value;
   });
   if(!restoreCheckpoint)return task;
   // Staging and publication wait for their checkpoint before continuing.
   // The committed write has already left the writer queue.
   return task.then(async value=>{
    if(committedRestoreCheckpoint&&!closing&&!authorityError){
     try{await maintenance.flush(restoreCheckpoint);}
     catch{/* The maintenance worker reports failures. The write has committed. */}
    }
    return value;
   });
  },
  async flush(){
   await drain();
   const task=tail.then(async()=>({checkpoint:await maintenance.flush()}));
   tail=task.catch(()=>{});
   return task;
  },
  drain,
  drainReads:()=>reader.drain(),
  releaseDeferredSave:()=>release?.(),
  snapshot:()=>copy(state),
  snapshotAsync:scope=>read({operation:'snapshot',scope}),
  snapshotLifeArchive:(input,options)=>read({operation:'snapshot-life-archive',...input},options),
  prepareArchiveRestore:(input,options)=>read({operation:'prepare-archive-restore',...input},options),
  readLifePreview:(input,options)=>read({operation:'read-life-preview',...input},options),
  prepareLifeExport:(input,options)=>read({operation:'prepare-life-export',...input},options),
  prepareLifeImport:(input,options)=>read({operation:'prepare-life-import',...input},options),
  readStagedLife:(input,options)=>read({operation:'read-staged-life',...input},options),
  projectStagedLife:input=>read({operation:'project-staged-life',...input}),
  stageLifeRestore:(input,onBatch)=>read({operation:'stage-life-restore',...input},{onBatch}),
  readLifeArchiveContent:(id,sha256,{archiveInput,...options})=>read({operation:'read-life-archive-content',id,sha256,...archiveInput},options),
  sealLifeRestoreSource:(id,target,resetPersonas,resetArtwork)=>read({operation:'seal-life-restore-source',id,target,resetPersonas,resetArtwork}),
  removeLifeRestoreSource:id=>read({operation:'remove-life-restore-source',id}),
  privateStartupRows:after=>read({operation:'private-startup-rows',after}),
  pendingMood:(characterId,scope)=>read({operation:'pending-mood',characterId,scope}),
  groupSavedPhoto:(groupId,range,characterIds)=>read({operation:'group-saved-photo',groupId,range,characterIds}),
  groupReplySource:options=>read({operation:'group-reply-source',options}),
  exportConversations:(options,readMedia)=>read({operation:'portable-conversations',...options},{onModel:(_,input)=>readMedia(input)}),
  planMaintenance:(name,options)=>read({operation:'maintenance-plan',name,options}),
  exportMaintenanceBackup:(target,{revision})=>read({operation:'maintenance-backup',target,revision}),
  readMemory:(method,args,options,onModel,onBatch)=>read({operation:'memory',method,args,...options,stream:!!onBatch},{
   onModel,onBatch,onArchive:publishArchiveEvidence
  }),
  close(){
   if(!closing)closing=(async()=>{
    await tail;
    try{
     const closingReader=reader.close();
     const closingArchive=closingReader.catch(()=>{}).then(()=>autoArchivePublisher.stop());
     const lanes=await Promise.allSettled([closingReader,memoryPublisher.stop(),closingArchive]);
     const failures=lanes.filter(row=>row.status==='rejected').map(row=>row.reason);
     const checkpoint=await maintenance.close({truncate:failures.length===0});
     if(checkpoint)try{audit?.({type:'companion-wal-close',...checkpoint,commits:Number(Atomics.load(reader.lastWrite,1))});}catch{}
     if(failures.length===1)throw failures[0];
     if(failures.length>1)throw new AggregateError(failures,'Companion worker cleanup failed');
     return {checkpoint};
    }finally{release?.();sql.close();const remaining=openCompanionWriters.get(path)-1;if(remaining)openCompanionWriters.set(path,remaining);else openCompanionWriters.delete(path);}
   })();
   return closing;
  }
 };
 let deferredCheckpoint;
 const release=deferredSaveRegistry?.register('companion',{target:path,scope,
  async drain(){
   const commitCount=Atomics.load(reader.lastWrite,1);
   deferredCheckpoint={commitCount,...await api.flush()};
  },
  flushSync(){
   if(publishing||maintenance.busy)return {checkpoint:{status:'busy'}};
   if(deferredCheckpoint?.commitCount===Atomics.load(reader.lastWrite,1))return {checkpoint:deferredCheckpoint.checkpoint};
   // The OS session-end notification cannot await a worker. Its synchronous
   // fallback can checkpoint committed pages, but must never truncate a WAL.
   return {checkpoint:sql.checkpoint({truncate:false})};
  },
  skipAutomatic:true
 });
 return api;
}

function* changedCompanionImages(state,next){
 const before=new Map();
 for(const [holder,key,path] of imageSlots(state))before.set(path,holder[key]);
 for(const [holder,key,path] of imageSlots(next)){
  const value=holder[key];
  if(typeof value!=='string'||!value.startsWith('data:image/')||before.get(path)===value)continue;
  yield [holder,key,value];
 }
}

export function makeCard(raw,previous=null,{draft=false}={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('角色卡格式无效');const name=text(raw.name??previous?.name??'',80).trim();if(!name&&!draft)throw Error('角色名称必填');
 const id=previous?.id??raw.id??'custom-'+randomUUID();if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||id==='prototype'||Object.hasOwn(Object.prototype,id))throw Error('角色身份格式无效');
 const fields=copy(previous?.fields??{});if(raw.fields!==undefined){if(!raw.fields||typeof raw.fields!=='object'||Array.isArray(raw.fields))throw Error('角色字段格式无效');for(const [key,field]of Object.entries(raw.fields)){if(!CARD_FIELDS.includes(key))throw Error('未知角色字段：'+key);if(!field||!['inherit','custom','empty'].includes(field.mode))throw Error('角色字段需要选择继承／自定义／清空');const value=field.mode==='custom'?text(field.value??'',key.endsWith('Image')||key==='sprite'?26_000_000:20000):'';if((key.endsWith('Image')||key==='sprite')&&value&&!isMediaUrl(value)&&!/^data:image\/(?:png|jpeg|webp|avif);base64,[a-zA-Z0-9+/=\s]+$/.test(value))throw Error('形象字段只接受 PNG、JPEG、WebP 或 AVIF 图片');fields[key]={mode:field.mode,...(field.mode==='custom'?{value}:{})};}}
 const examples=raw.examples===undefined?copy(previous?.examples??[]):raw.examples;if(!Array.isArray(examples)||examples.length>100)throw Error('示例对话格式无效');
 const binding=raw.modelBinding??previous?.modelBinding??{enabled:false,connectionId:null};if(typeof binding.enabled!=='boolean'||binding.enabled&&!String(binding.connectionId||'').trim())throw Error('请选择角色关联的聊天连接');
 return {...previous,id,name,nameCustomized:previous?.nameCustomized===true||!!previous&&name!==previous.name,builtin:previous?.builtin===true,talkativeness:cardTalkativeness(Object.hasOwn(raw,'talkativeness')?raw.talkativeness:previous?.talkativeness??.5),fields,examples:examples.map(row=>({scene:text(row.scene??'',5000),speaker:text(row.speaker??'',100),text:text(row.text??'',20000)})),modelBinding:{enabled:binding.enabled,connectionId:binding.enabled?text(binding.connectionId,200):null},avatar:text(raw.avatar??previous?.avatar??'',26_000_000),revision:(previous?.revision??0)+1,updatedAt:Date.now(),draft};
}
export function effectiveCard(card){const value={...(card.defaults??{})};for(const key of CARD_FIELDS){const field=card.fields?.[key];if(field?.mode==='empty')value[key]='';else if(field?.mode==='custom')value[key]=field.value;}return {...value,name:card.name,examples:card.examples??[]};}
// Reads a relationship without adding default entries, so callers need no copy of the archive.
// Same values as relationshipFor would return on a throwaway copy.
export function relationshipView(state,characterId,personaId=state.activePersonaId){const entry=state.relationships?.[characterId];if(!entry)return {level:1,affection:0};if(entry.mode==='shared')return entry.shared??{level:1,affection:0};return entry.byPersona?.[personaId]??{level:1,affection:0};}
export function relationshipFor(state,characterId,personaId=state.activePersonaId){const entry=state.relationships[characterId]??={mode:'independent',byPersona:{}};if(entry.mode==='shared')return entry.shared??={level:1,affection:0};return entry.byPersona[personaId]??={level:1,affection:0};}
export function conversationFor(state,characterId=state.activeCharacterId,personaId=state.activePersonaId,{fresh=false,title='',tx}={}){
 if(!Object.hasOwn(state.cards,characterId)||!Object.hasOwn(state.personas,personaId))throw Error('角色或身份不存在');const lifeId=state.lives?.[characterId]?.id;let row=!fresh&&Object.values(state.conversations).filter(row=>row.characterId===characterId&&row.personaId===personaId&&(!lifeId||row.lifeId===lifeId)&&!row.archived).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
 if(!row){const at=Date.now();row={id:'conversation-'+randomUUID(),characterId,personaId,...(lifeId?{lifeId}:{}),title:title||state.cards[characterId].name,createdAt:at,updatedAt:at,archived:false,draft:'',...(tx?.messages?{}:{messages:[]})};state.conversations[row.id]=row;if(tx?.messages)tx.messages.define('private',row.id,['conversations',row.id]);}
 return row;
}
// Times read from a file are kept only when they are real dates: inside the Date
// range, positive and at most a day ahead. Others become the import time (revision
// times become 0, the existing "date unknown" value) and the message is flagged.
// With unknown:true (life archives) createdAt 0 stays and bad values become 0, so
// no date is invented for a restored message.
export const validTime=(value,now=Date.now())=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=Math.min(8.64e15,now+86400000);
export const importTime=(value,now=Date.now())=>validTime(Number(value),now)?Number(value):now;
export function repairMessageTimes(raw,now=Date.now(),{unknown=false}={}){
 const given=key=>raw[key]!==undefined&&raw[key]!==null,bad=key=>given(key)&&!validTime(Number(raw[key]),now)&&!(unknown&&key==='createdAt'&&Number(raw[key])===0);let repaired=false;
 const createdAt=bad('createdAt')?(unknown?0:now):unknown&&(!given('createdAt')||Number(raw.createdAt)===0)?raw.createdAt:importTime(raw.createdAt,now),message={...raw,createdAt};if(bad('createdAt'))repaired=true;
 for(const key of ['editedAt','updatedAt','presentedAt','recordedAt'])if(bad(key)){if(unknown)delete message[key];else message[key]=key==='recordedAt'?now:createdAt;repaired=true;}
 if(Array.isArray(raw.revisions))message.revisions=raw.revisions.map(row=>{const at=Number(row?.at)||0;if(at&&!validTime(at,now)){repaired=true;return {...row,at:0};}return {...row,at};});
 if(repaired)message.timeRepaired=true;return message;
}
export function safeMessage(raw,owner){if(!raw||!['user','assistant','narrator'].includes(raw.role))throw Error('导入消息角色无效');const id=companionId(raw.id??randomUUID()),body=text(raw.text??'',200000);return repairMessageTimes({...copy(raw),id,role:raw.role,text:body,characterId:owner.characterId,personaId:owner.personaId,revisions:Array.isArray(raw.revisions)?raw.revisions.map(row=>({text:text(row.text??'',200000),at:Number(row.at)||0})):[]});}
export function restoreCompanionExport(state,data){
 if(data?.format!=='ai-buddy-conversations'||data.version!==1||!Array.isArray(data.conversations)||data.groups!==undefined&&!Array.isArray(data.groups))throw Error('会话恢复文件格式无效');
 for(const [key,raw]of Object.entries(data.cards??{})){const id=companionId(key);if(!Object.hasOwn(state.cards,id))state.cards[id]=makeCard({...raw,id});}
 for(const [key,raw]of Object.entries(data.personas??{})){
  const id=companionId(key);if(Object.hasOwn(state.personas,id))continue;
  const row={id,name:text(raw.name,80),revision:Math.max(1,Math.floor(Number(raw.revision)||1)),createdAt:importTime(raw.createdAt),relationships:{}};
  for(const field of ['nickname','avatar','occupation','identity','background','interests','preferences'])if(raw[field]!==undefined)row[field]=text(raw[field],field==='avatar'?26000000:20000);
  for(const [role,value]of Object.entries(raw.relationships??{})){companionId(role);if(!Object.hasOwn(state.cards,role))throw Error('身份专属关系的角色不存在');row.relationships[role]={address:text(value.address??'',300),relationship:text(value.relationship??'',20000)};}
  state.personas[id]=row;
 }
 for(const raw of data.conversations){
  const characterId=companionId(raw.characterId),personaId=companionId(raw.personaId);if(!Object.hasOwn(state.cards,characterId)||!Object.hasOwn(state.personas,personaId)||!Array.isArray(raw.messages))throw Error('会话的角色、身份或消息缺失');
  const importDigest=createHash('sha256').update(JSON.stringify(raw)).digest('hex');if(Object.values(state.conversations).some(row=>row.importDigest===importDigest))continue;let id=companionId(raw.id??randomUUID());if(Object.hasOwn(state.conversations,id)){if(JSON.stringify(state.conversations[id])===JSON.stringify(raw))continue;id='import-'+randomUUID();}
  const owner={characterId,personaId,conversationId:id},messages=raw.messages.map(row=>({...safeMessage(row,owner),conversationId:id}));
  state.conversations[id]={id,...owner,importedFrom:raw.importedFrom??raw.id,importDigest,choices:Array.isArray(raw.choices)?raw.choices.filter(c=>c&&typeof c.id==='string'&&typeof c.text==='string').map(c=>({id:companionId(c.id),text:text(c.text,20000),effect:[-1,0,1].includes(c.effect)?c.effect:0})):[],title:text(raw.title??'',300),draft:text(raw.draft??'',200000),createdAt:importTime(raw.createdAt),updatedAt:importTime(raw.updatedAt),archived:raw.archived===true,messages};
 }
 for(const raw of data.groups??[]){
  const importDigest=createHash('sha256').update(JSON.stringify(raw)).digest('hex');if(Object.values(state.groups).some(row=>row.importDigest===importDigest))continue;let id=companionId(raw.id??randomUUID());const personaId=companionId(raw.personaId);if(!Object.hasOwn(state.personas,personaId)||!Array.isArray(raw.memberIds)||!Array.isArray(raw.messages))throw Error('群聊身份、成员或消息缺失');
  const members=[...new Set(raw.memberIds.map(companionId))];if(members.some(id=>!Object.hasOwn(state.cards,id)))throw Error('群成员不存在');
  const seq=Number(raw.seq),intervals={};if(!Number.isSafeInteger(seq)||seq<0)throw Error('群消息序号无效');
  for(const [member,rows]of Object.entries(raw.intervals??{})){
   companionId(member);if(!Object.hasOwn(state.cards,member)||!Array.isArray(rows))throw Error('群参与区间无效');let previousEnd=0;
   intervals[member]=rows.map((row,index)=>{const start=Number(row.start),end=row.end===null?null:Number(row.end);if(!Number.isSafeInteger(start)||start<1||start>seq+1||start<=previousEnd||end!==null&&(!Number.isSafeInteger(end)||end<start-1||end>seq)||end===null&&(index!==rows.length-1||!members.includes(member)))throw Error('群参与区间重叠或越界');previousEnd=end??Infinity;return {start,end};});
  }
  let previousSeq=0;const messages=raw.messages.map(message=>{if(!Number.isSafeInteger(message.seq)||message.seq<=previousSeq||message.seq>seq)throw Error('群消息顺序无效');previousSeq=message.seq;const characterId=message.role==='assistant'?companionId(message.characterId):undefined;if(characterId&&!Object.hasOwn(state.cards,characterId))throw Error('群发言角色不存在');if(characterId&&!(intervals[characterId]??[]).some(row=>message.seq>=row.start&&(row.end===null||message.seq<=row.end)))throw Error('群发言不在角色参与区间');return {...safeMessage(message,{characterId,personaId}),seq:message.seq};});
  if(Object.hasOwn(state.groups,id)){if(JSON.stringify(state.groups[id])===JSON.stringify(raw))continue;id='import-'+randomUUID();}
  const mode=['natural','list','manual','pool'].includes(raw.mode)?raw.mode:'natural',talkativeness={};for(const member of members){const value=Number(raw.talkativeness?.[member]??.5);if(!Number.isFinite(value)||value<0||value>1)throw Error('群健谈程度无效');talkativeness[member]=value;}
  state.groups[id]={id,importedFrom:raw.importedFrom??raw.id,importDigest,...(raw.photoPlannerBinding!==undefined?{photoPlannerBinding:normalizePhotoPlannerBinding(raw.photoPlannerBinding)}:{}),name:text(raw.name??'恢复的群聊',200),personaId,memberIds:members,stageOrder:[...new Set([...(Array.isArray(raw.stageOrder)?raw.stageOrder.map(companionId).filter(id=>Object.hasOwn(state.cards,id)):[]),...members])],sceneTemplate:raw.sceneTemplate==='plain'?'plain':'library',cameraMode:raw.cameraMode==='wide'?'wide':'focus',autoPhoto:raw.autoPhoto===true,lastEndedSeq:Math.min(seq,Math.max(0,Math.floor(Number(raw.lastEndedSeq)||0))),photos:Array.isArray(raw.photos)?raw.photos.map(photo=>({...copy(photo),cgId:companionId(photo.cgId)})):[],scene:text(raw.scene??'',20000),background:text(raw.background??'',26000000),mode,talkativeness,poolIndex:Number.isSafeInteger(raw.poolIndex)&&raw.poolIndex>=0?raw.poolIndex:0,...(typeof raw.poolLastSpeakerId==='string'&&Object.hasOwn(state.cards,raw.poolLastSpeakerId)?{poolLastSpeakerId:raw.poolLastSpeakerId}:{}),mutedIds:(raw.mutedIds??[]).filter(id=>members.includes(id)),createdAt:importTime(raw.createdAt),updatedAt:importTime(raw.updatedAt),seq,intervals,messages,entryCharacterId:members.includes(raw.entryCharacterId)?raw.entryCharacterId:members[0]};
 }
 if(data.defaultPersonaId!==undefined){const id=companionId(data.defaultPersonaId);if(!Object.hasOwn(state.personas,id))throw Error('恢复文件的默认身份不存在');state.defaultPersonaId=id;}
}
export function visibleGroupMessages(group,characterId){const intervals=group.intervals?.[characterId]??[];return group.messages.filter(message=>intervals.some(interval=>message.seq>=interval.start&&(interval.end===null||message.seq<=interval.end)));}
export function groupSpeakers(group,{cards={},mentionIds=[],forceCharacterId=null,random=Math.random}={}){
 const members=[...new Set(group.memberIds)].filter(id=>!(group.mutedIds??[]).includes(id));if(forceCharacterId){if(!group.memberIds.includes(forceCharacterId))throw Error('成员不在群内');return [forceCharacterId];}
 const mentioned=[...new Set(mentionIds)].filter(id=>members.includes(id));if(group.mode==='manual')return mentioned;if(group.mode==='list')return [...members];if(group.mode==='pool'){
  if(!members.length)return [];const order=[...new Set([...(group.stageOrder??[]),...group.memberIds])],last=order.indexOf(group.poolLastSpeakerId);
  if(last>=0){for(let step=1;step<=order.length;step++){const id=order[(last+step)%order.length];if(members.includes(id))return[id];}}
  const start=(group.poolIndex??0)%Math.max(1,group.memberIds.length);for(let step=0;step<group.memberIds.length;step++){const id=group.memberIds[(start+step)%group.memberIds.length];if(members.includes(id))return[id];}return [];
 }
 const chosen=[...mentioned,...members.filter(id=>!mentioned.includes(id)&&random()<cardTalkativeness(cards[id]?.talkativeness??.5))];return chosen.length?chosen:members.length?[members[Math.min(members.length-1,Math.floor(random()*members.length))]]:[];
}
export {text as companionText,copy as companionCopy};
