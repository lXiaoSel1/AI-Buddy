import {partitionCompanionData} from './companion-partitions.mjs';
import {rootRecord,saveRootRecord} from './companion-record-access.mjs';
import {appendMessage} from './companion-message-access.mjs';
import {copyCompanionValue} from './companion-draft.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {currentLife,ensureLives,lifeToken,assertLife,makeLife,lifeConversations,resetGroupKnowledge} from './companion-life.mjs';
import {conversationFor,effectiveCard,progress,relationshipFor,companionId,repairMessageTimes} from './companion-store.mjs';
import {createLifeArchiveRepository,validateWorkEvidence,validateSocialCoreState,lifeArchiveCapabilities} from './companion-life-archive.mjs';
import {createLifeArchiveTransfers} from './companion-life-transfers.mjs';
import {readLifeCardArtwork} from './companion-life-card-artwork.mjs';
import {growthView} from './companion-growth.mjs';

const copy=value=>copyCompanionValue(value);
const contentHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A repeated-group regexp can exhaust V8's regexp stack on a valid multi-MiB
// archive. Scan canonical Base64 in constant stack space before allocating the
// ZIP buffer; the archive decoder still verifies all structure and file hashes.
export function archiveBase64Bytes(value){
 const invalid=()=>{throw Error('人生 ZIP 编码或大小无效');};
 if(typeof value!=='string'||value.length>715827884||value.length%4!==0)invalid();
 const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,end=value.length-padding;
 let last=0;
 for(let index=0;index<end;index++){
  const code=value.charCodeAt(index);
  if(code>=65&&code<=90)last=code-65;
  else if(code>=97&&code<=122)last=code-71;
  else if(code>=48&&code<=57)last=code+4;
  else if(code===43)last=62;
  else if(code===47)last=63;
  else invalid();
 }
 // Canonical padding cannot carry unused nonzero bits. Buffer.from alone also
 // accepts whitespace, Base64URL and malformed padding, so it is not a gate.
 if(padding===2&&(end%4!==2||(last&15)!==0)||padding===1&&(end%4!==3||(last&3)!==0))invalid();
 return Buffer.from(value,'base64');
}
// Message times in an archive are checked like any other import (see repairMessageTimes).
export function repairLifeArchiveTimes(target){
 const now=Date.now(),messages=rows=>Array.isArray(rows)?rows.map(row=>row&&typeof row==='object'?repairMessageTimes(row,now,{unknown:true}):row):rows;
 for(const row of target.conversations??[])row.messages=messages(row.messages);
 for(const group of [...(target.groupEvidence??[]),...(target.life?.restoredGroupEvidence??[])])group.messages=messages(group.messages);
 if(target.life&&Array.isArray(target.life.personalEvents))target.life.personalEvents=messages(target.life.personalEvents);
 return target;
}
export function lifeRestorePlan(transaction){
  const {id,characterId,operationId,target,staging}=transaction;
  const life={...target.life,restoredGroupEvidence:target.groupEvidence??[],legacyImportEnabled:false,operationId};
  delete life.groupIntervals;
  const conversations=Object.fromEntries(target.conversations.map(row=>{
   let clearedChoices=false;
   const messages=row.messages.map(message=>{
    if(message.presentation==='pending'){
     clearedChoices=true;
     return {...message,presentation:'discarded',status:'interrupted'};
    }
    return message.status==='pending'?{...message,status:'interrupted'}:message;
   });
   return [row.id,{...row,messages,...(clearedChoices?{choices:[]}:{})}];
  }));
  const partitions=partitionCompanionData({lives:{[characterId]:life},conversations},{chunkMemoryCoverage:staging?.planVersion===2});
  const stagedAt=at=>['lifeTransaction','staged',...at];
  const stagedId=owner=>JSON.stringify([id,owner]);
  const messageOwners=partitions.owners.map(to=>({to,from:{type:to.type==='private'?'transaction-private':'transaction-life-group',ownerId:stagedId(to.ownerId),at:stagedAt(to.at)}}));
  const recordOwners=partitions.recordOwners.map(to=>({to,from:{...to,namespace:'staged.'+to.namespace,owner:stagedId(to.owner),at:stagedAt(to.at)}}));
  const rows=[
   ...messageOwners.map(({from})=>({...from,ownerType:from.type,type:'message-owner'})),
   ...recordOwners.map(({from})=>({type:'record-owner',...from})),
   ...partitions.rows.map(row=>({type:'message',ownerType:row.type==='private'?'transaction-private':'transaction-life-group',ownerId:stagedId(row.ownerId),message:row.message})),
   ...partitions.recordRows.map(row=>({type:'record',namespace:'staged.'+row.namespace,owner:stagedId(row.owner),key:row.key,value:row.value}))
  ];
  return {state:partitions.state,messageOwners,recordOwners,rows};
 }
export function stageRestoreRows(tx,rows){
  for(const row of rows){
   switch(row.type){
    case 'message-owner':tx.messages.define(row.ownerType,row.ownerId,row.at);break;
    case 'record-owner':tx.records.define(row.namespace,row.owner,row);break;
    case 'message':tx.messages.append(row.ownerType,row.ownerId,row.message,{preserveDuplicate:true});break;
    case 'record':tx.records.put(row.namespace,row.owner,row.key,row.value);break;
   }
  }
}
export function lifeArchiveMetadata(snapshot,file,{name,note}={}){
  const relations=copy(snapshot.relationships),personas=Object.values(snapshot.personas??{}).map(p=>({id:p.id,name:p.name,nickname:p.nickname}));
  return {...file,characterId:snapshot.characterId,lifeId:snapshot.life.id,mode:snapshot.life.mode,name:String(name??snapshot.card.name).slice(0,200),note:String(note??'').slice(0,4000),avatar:snapshot.card.avatar||effectiveCard(snapshot.card).sprite||snapshot.card.sprite,createdAt:snapshot.savedAt,personas,relations,level:Math.max(1,...Object.values(relations.byPersona??{}).map(p=>p.level||1),relations.shared?.level||1),unlocks:(snapshot.content?.cgs??[]).map(cg=>({id:cg.id,level:cg.level,status:cg.status})),overview:Object.entries(effectiveCard(snapshot.card)).filter(([key,v])=>['personality','interests','tone'].includes(key)&&v).map(([key,v])=>key+': '+v).join('\n'),importantExperiences:[],dependencies:snapshot.dependencies??[]};
 }
export function buildLifeArchiveSnapshot(state,{characterId,token,content,workEvidence,coreState,canRestoreWork,drafts,savedAt}){
  const life=copy(assertLife(state,characterId,token));
  const conversations=lifeConversations(state,characterId),personaIds=new Set([...conversations.map(c=>c.personaId),...Object.keys(state.relationships[characterId]?.byPersona??{})]);
  const groupEvidence=Object.values(state.groups).filter(g=>life.groupIntervals[g.id]?.length).map(g=>({id:g.id,...(g.importedFrom?{importedFrom:g.importedFrom}:{}),...(g.duplicateMessageSeqs?.length?{duplicateMessageSeqs:copy(g.duplicateMessageSeqs)}:{}),name:g.name,personaId:g.personaId,scene:g.scene,background:g.background,seq:g.seq,intervals:copy(life.groupIntervals[g.id]).map(row=>({...row,end:row.end===null?g.seq:row.end})),messages:copy(g.messages.filter(m=>life.groupIntervals[g.id].some(i=>m.seq>=i.start&&(i.end===null||m.seq<=i.end))))}));
  for(const group of life.restoredGroupEvidence??[])if(!groupEvidence.some(row=>row.id===group.id))groupEvidence.push(copy(group));
  for(const group of groupEvidence)personaIds.add(group.personaId);
  if(workEvidence){validateWorkEvidence(workEvidence,{characterId,lifeId:life.id});for(const task of workEvidence.tasks)personaIds.add(task.scope.personaId);}
  if((life.workExperiences??[]).length&&!workEvidence)throw Error('工作经历缺少完整任务证据，不能创建不完整人生存档');
  const hasWork=!!workEvidence?.tasks?.length;
  if(hasWork&&!canRestoreWork)throw Error('工作档案恢复服务尚未就绪');
  for(const event of coreState?.feeding?.mealEvidence??[])personaIds.add(event.scope.personaId);
  // Seal the old open intervals at this precise snapshot cutoff. Restore will
  // reopen at the present boundary, never grant knowledge of the gap.
  life.groupIntervals=Object.fromEntries(groupEvidence.map(g=>[g.id,g.intervals]));life.selectedCgIds=[...new Set([...(content?.cgs??[]),...(content?.sharedCgs??[])].map(cg=>cg.id))];
  return {format:'ai-buddy-life-state',version:coreState?3:hasWork?2:1,...(coreState?{requiredCapabilities:['social-core-state-v1',...(hasWork?['work-task-evidence-v1']:[])],coreState:copy(coreState)}:hasWork?{requiredCapabilities:['work-task-evidence-v1']} :{}),...(hasWork?{workEvidence:copy(workEvidence)}:{}),characterId,savedAt,card:copy(state.cards[characterId]),life,relationships:copy(state.relationships[characterId]??{mode:'independent',byPersona:{}}),personas:Object.fromEntries([...personaIds].filter(id=>state.personas[id]).map(id=>[id,{...copy(state.personas[id]),relationships:{[characterId]:copy(state.personas[id].relationships?.[characterId]??{})}}])),conversations:copy(conversations).map(row=>({...row,draft:drafts?.[row.id]??row.draft??''})),groupEvidence,content:copy(content??{}),dependencies:[{type:'builtin-character-resources',version:'1.8.0',characterId,optional:state.cards[characterId].builtin!==true}]};
 }
export function projectLifeArchivePreview(snapshot,personaId){
 let remaining=16*1024;
 const conversations=snapshot.conversations.filter(row=>row.personaId===personaId).map(row=>{
  const messages=[];
  for(const message of row.messages??[]){
   if(remaining<=0)break;
   if(typeof message.text!=='string')continue;
   const text=message.text.slice(0,remaining);
   remaining-=text.length+128;
   messages.push({id:message.id,role:message.role,text});
  }
  return {id:row.id,personaId:row.personaId,messages};
 });
 const {characterId,card,life}=snapshot,content=snapshot.content??{};
 const visibleCard={id:card.id,name:card.name,
  fields:Object.fromEntries(Object.entries(card.fields??{}).filter(([key])=>!['sprite','backgroundImage','referenceImage'].includes(key))),
  defaults:Object.fromEntries(Object.entries(card.defaults??{}).filter(([key])=>!['sprite','backgroundImage','referenceImage'].includes(key)))};
 const growth=growthView({cards:{[characterId]:card},lives:{[characterId]:life}},characterId,personaId);
 return {
  characterId,version:snapshot.version,card:visibleCard,relationships:snapshot.relationships,dependencies:snapshot.dependencies,
  life:{id:life.id,mode:life.mode,startedAt:life.startedAt,growth},conversations,
  groupEvidence:(snapshot.groupEvidence??[]).filter(row=>row.personaId===personaId).map(({id,name,personaId})=>({id,name,personaId})),
  personas:Object.fromEntries(Object.entries(snapshot.personas??{}).map(([id,p])=>[id,{id,name:p.name,nickname:p.nickname}])),
  content:{level:content.level,affection:content.affection,cgs:(content.cgs??[]).filter(cg=>!cg.personaId||cg.personaId===personaId).map(({id,status,level,kind})=>({id,status,level,kind}))},
  workTaskCount:snapshot.workEvidence?.tasks?.filter(task=>task.scope.personaId===personaId).length??0,
  ...(snapshot.coreState?.feeding?{coreState:{feeding:{...snapshot.coreState.feeding,mealEvidence:(snapshot.coreState.feeding.mealEvidence??[]).filter(event=>event.scope?.personaId===personaId)}}}:{})
 };
}
export function validateLifeArchiveTarget(target,characterId){
  if(target.characterId!==characterId||target.card?.id!==characterId||!['normal','seed','blank'].includes(target.life?.mode))throw Error('人生存档角色或模式不匹配');
  lifeArchiveCapabilities(target);
  if(target.workEvidence){validateWorkEvidence(target.workEvidence,{characterId,lifeId:target.life.id});for(const task of target.workEvidence.tasks)if(!target.personas?.[task.scope.personaId])throw Error('人生工作任务缺少对应身份');}
  if(target.coreState){validateSocialCoreState(target.coreState,{characterId,lifeId:target.life.id});for(const event of target.coreState.feeding?.mealEvidence??[])if(!target.personas?.[event.scope.personaId])throw Error('人生进食经历缺少对应身份');}
  for(const [id,p]of Object.entries(target.personas??{})){companionId(id);if(id!==p.id)throw Error('人生身份数据无效');}
  for(const row of target.conversations){
   companionId(row.id);
   if(row.characterId!==characterId||row.lifeId!==target.life.id||!target.personas[row.personaId]||!Array.isArray(row.messages)||
    row.messages.some(message=>!message||typeof message!=='object'||Array.isArray(message)||typeof message.id!=='string'||!message.id))throw Error('人生会话归属或消息无效');
  }
  for(const relation of [...Object.values(target.relationships.byPersona??{}),...(target.relationships.shared?[target.relationships.shared]:[])])if(!Number.isFinite(relation.level)||relation.level<1||!Number.isFinite(relation.affection)||relation.affection<0)throw Error('人生进度无效');
 }
export async function createCompanionLives({store,dataRoot,imageCodec,imageConverter=null,imageValidator=null,imageConversionWorker=null,media=null,drafts=null,workBridge=null,coreStateBridge=null,call,syncCard,projectPersona,quiesce=async()=>{},onChanged=()=>{},enableGrowth,now=Date.now,audit=()=>{}}){
 const archiveMeta=(id,state=store.state,tx)=>rootRecord(store,state,'lifeArchives',id,tx);
 const resetArtwork=new WeakMap();
 function splitArchiveArtwork(value){
  if(!value.avatarLocator)return {archive:value};
  const {avatarLocator,...archive}=value;
  return {archive,artwork:{locator:avatarLocator,avatar:readLifeCardArtwork(store.state,avatarLocator)}};
 }
 function saveArchive(state,tx,archive,artwork){
  if(artwork){
   if(!tx?.archiveArtwork||readLifeCardArtwork(state,artwork.locator)!==artwork.avatar)
    throw Object.assign(Error('操作失败。'),{code:'LIFE_ARCHIVE_CARD_ARTWORK_STALE'});
   tx.archiveArtwork(archive.id,artwork.locator);
  }
  saveRootRecord(state,'lifeArchives',archive.id,archive,tx);
 }
 const publicArchive=(archive,artwork)=>artwork?{...archive,avatar:artwork.avatar}:archive;
 const snapshotRows=scope=>store.snapshotAsync?store.snapshotAsync(scope):Promise.resolve(copy(store.state));
 const fullTransaction=async({bridgeOnly=false}={})=>{
  const entry=store.state.lifeTransaction;
  if(entry&&store.readStagedLife){
   const {target,...metadata}=entry;
   const transaction=copy(metadata);
   if(bridgeOnly&&!target?.coreState)transaction.target={};
   else transaction.target=await store.readStagedLife({id:entry.id,characterId:entry.characterId,sha256:entry.staging?.sha256,
    bridgeOnly:bridgeOnly||entry.phase==='character-published'});
   return transaction;
  }
  return copy((await snapshotRows({transaction:true,replay:true})).lifeTransaction??null);
 };
 function writeParts(tx,source){
  if(!tx)return source;
  const {state,owners,rows,recordOwners,recordRows}=partitionCompanionData(source);
  for(const owner of owners)tx.messages.define(owner.type,owner.ownerId,owner.at);
  for(const row of rows)tx.messages.append(row.type,row.ownerId,row.message,{preserveDuplicate:true});
  for(const owner of recordOwners)tx.records.define(owner.namespace,owner.owner,owner);
  for(const row of recordRows)tx.records.put(row.namespace,row.owner,row.key,row.value);
  return state;
 }

 function writeStagedMetadata(state,transaction){
  const {target,...metadata}=transaction;
  state.lifeTransaction={...metadata,target:{coreState:target.coreState?true:undefined}};
 }
 async function sealStagedTarget(transaction){
  transaction.staging={sha256:await store.sealLifeRestoreSource(transaction.id,transaction.target,transaction.kind==='reset'&&archiveInput.compactResetPersonas,resetArtwork.get(transaction)?.locator),cursor:0,complete:false,planVersion:2};
 }
 async function stageLifeRestore(transaction){
  const {id,characterId,operationId,staging}=transaction;
  if(!store.stageLifeRestore)throw Error('Companion life staging is unavailable');
  const {progress,...plan}=await store.stageLifeRestore({id,characterId,operationId,staging},async ({start,end})=>{
   await store.mutate(state=>{
    if(state.lifeTransaction?.id!==id||state.lifeTransaction.staging.cursor!==start)throw Error('人生事务已失效');
    state.lifeTransaction.staging.cursor=end;
   },{storeImages:false,operation:'life-restore-stage',lifeRestoreBatch:{id,sha256:staging.sha256,start,end}});
   staging.cursor=end;
  });
  if(!staging.complete){
   audit({type:'companion-life-restore-stage',...progress});
   await store.mutate(state=>{
    if(state.lifeTransaction?.id!==id)throw Error('人生事务已失效');
    state.lifeTransaction.staging.complete=true;
   },{storeImages:false,operation:'life-restore-staged'});
   staging.complete=true;
  }
  return plan;
 }
 async function clearRestoreSource(transaction){
  if(!transaction.staging)return;
  try{await store.removeLifeRestoreSource(transaction.id);}catch(error){audit({type:'life-restore-source-cleanup-failed',code:error.code});}
 }

 function writeLifeTransaction(state,tx,value){
  if(value?.staging){writeStagedMetadata(state,value);return;}
  if(!value)tx?.deletePartitions(['lifeTransaction','staged']);
  tx?.deletePartitions(['lifeTransaction','target']);
  if(!value){delete state.lifeTransaction;return;}
  state.lifeTransaction=writeParts(tx,{lifeTransaction:copy(value)}).lifeTransaction;
 }
 const repository=createLifeArchiveRepository({dataRoot,imageCodec,imageConverter,media}),switching=new Set(),rollbackFlights=new Map();
 const transfers=store.prepareLifeImport?createLifeArchiveTransfers(dataRoot):null;
 const scopedLifeWrite=perform=>store.withLifeArchiveWrites?store.withLifeArchiveWrites(perform):perform();
 const archiveInput={compactArchiveArtwork:!!store.withLifeArchiveWrites,compactResetPersonas:!!store.sealLifeRestoreSource,useMedia:!!media,hasImageCodec:!!(imageValidator||imageCodec),hasImageConverter:!!imageConverter,streamImageConversion:!!imageConversionWorker,portableAssetRefs:!!imageValidator};
 const archiveCallbacks={onImage:(bytes,options)=>options.convert?imageConversionWorker(bytes,{onChunk:options.onThumbnailChunk}):
  (imageValidator??repository.checkImage)(bytes,options),onModel:(_,options)=>imageConverter(options.dataUrl)};
 const readArchiveContent=(id,sha256)=>store.readLifeArchiveContent
  ?store.readLifeArchiveContent(id,sha256,{...archiveCallbacks,archiveInput})
  :repository.read(id,sha256).snapshot;
 const knownCard=id=>{companionId(id);if(!store.state.cards[id])throw Error('角色不存在');return id;};
 const assertStable=id=>{if(store.state.lifeTransaction?.replayFailed&&store.state.lifeTransaction.characterId===id)throw Error('该角色的人生切换没有完成，请先选择重试、回到切换前或放弃这次切换');if(switching.has(id)||store.state.lifeTransaction?.characterId===id)throw Error('正在保存或切换此角色人生，请稍候');};
 const assertRollbackClear=id=>{if(store.state.pendingLifeRollbacks?.[id])throw Object.assign(Error('该角色的人生经济回退待恢复，投喂和存档暂缓'),{code:'FEEDING_ROLLBACK_PENDING'});};
 const busy=id=>{assertStable(id);workBridge?.assertIdle?.(id);};
 const checked=async(action,args)=>{const result=await call(action,args);if(result?.ok===false)throw Error(result.error??'人生内容验证或保存失败');return result;};
 const scopeOf=(characterId,life=currentLife(store.state,characterId))=>({characterId,personaId:store.state.activePersonaId??'default',lifeId:life.id,operationId:life.operationId});
 const activateCurrent=async characterId=>{if(!coreStateBridge?.activate||store.state.lifeTransaction?.characterId===characterId||store.state.pendingLifeRollbacks?.[characterId])return;await coreStateBridge.activate(scopeOf(characterId));};
 async function finishPendingRollback(characterId,{economyComplete=false}={}){
  if(rollbackFlights.has(characterId))return rollbackFlights.get(characterId);
  const task=(async()=>{
   const pending=copy(store.state.pendingLifeRollbacks?.[characterId]);if(!pending)return true;
   const life=store.state.lives[characterId];
   if(store.state.lifeTransaction?.characterId===characterId||life?.id!==pending.rollbackScope.lifeId||life.operationId!==pending.rollbackScope.operationId)return false;
   try{
    if(!economyComplete){await coreStateBridge.recover({transactionId:pending.transactionId,decision:'rollback'});await coreStateBridge.rebindRollback(pending);}
    if(store.state.activeCharacterId===characterId)await coreStateBridge.activate?.(scopeOf(characterId),{allowPending:true});
    await store.mutate(state=>{
     const current=state.pendingLifeRollbacks?.[characterId],life=state.lives[characterId];
     if(current?.transactionId!==pending.transactionId||life?.id!==pending.rollbackScope.lifeId||life.operationId!==pending.rollbackScope.operationId)throw Error('人生回退待办已经失效');
     delete state.pendingLifeRollbacks[characterId];
     if(!Object.keys(state.pendingLifeRollbacks).length)delete state.pendingLifeRollbacks;
    },{storeImages:false});
    return true;
   }catch(error){audit({type:'life-rollback-economy-deferred',characterId,transactionId:pending.transactionId,code:error.code??null,message:String(error.message??error).slice(0,500)});return false;}
  })();rollbackFlights.set(characterId,task);try{return await task;}finally{if(rollbackFlights.get(characterId)===task)rollbackFlights.delete(characterId);}
 }
 async function retryPendingRollbacks(){const result={};for(const characterId of Object.keys(store.state.pendingLifeRollbacks??{}))result[characterId]=await finishPendingRollback(characterId);return result;}
 coreStateBridge?.registerPendingRollbackRecovery?.(retryPendingRollbacks);
 const quiesceAll=async(characterId,options)=>{await quiesce(characterId,options);if(coreStateBridge)await coreStateBridge.quiesce(scopeOf(characterId));};
 async function validateCore(coreState,characterId,lifeId){validateSocialCoreState(coreState,{characterId,lifeId});if(!coreStateBridge)throw Error('此人生包含本体状态，请使用支持心情与投喂的版本恢复');const valid=await coreStateBridge.validate(coreState,{characterId,lifeId});if(valid===false)throw Error('人生本体状态验证失败');}
 async function upgradeTargetCore(target,characterId){
  if(!coreStateBridge||target.coreState)return target;
  const scope=scopeOf(characterId,target.life),coreState=await coreStateBridge.initial(scope);await validateCore(coreState,characterId,target.life.id);
  target.version=3;target.coreState=copy(coreState);target.requiredCapabilities=['social-core-state-v1',...(target.workEvidence?['work-task-evidence-v1']:[])];return target;
 }
 const transferOptions={...archiveInput};
 async function finishPortableImport(id){
  return transfers.finishImport(id,async entry=>{
   const {archive,target}=await store.prepareLifeImport({id,bytes:entry.bytes,encoding:entry.encoding,...transferOptions},archiveCallbacks);
   try{
    await validateBridges(target,target.characterId);
    if(!store.state.cards[target.characterId])throw Error('请先创建或安装存档对应角色：'+target.characterId);
    await checked('companion-life-validate',{characterId:target.characterId,content:target.content});
    await store.mutate((state,tx)=>{
     if(entry.cancelled)throw Error('人生存档不存在');
     saveArchive(state,tx,archive);
    });
   }catch(error){if(!archiveMeta(archive.id))await repository.remove(archive.id);throw error;}
   return archive;
  });
 }
 function beginPortableExport(id){
  const meta=archiveMeta(id);if(!meta)throw Error('人生存档不存在');
  return transfers.beginExport(meta.bytes,transferId=>store.prepareLifeExport({id,sha256:meta.sha256,transferId,...transferOptions},archiveCallbacks));
 }
 async function exportLegacy(id){
  const transfer=await beginPortableExport(id),parts=[];
  let offset=0,remainder=Buffer.alloc(0);
  try{
   while(offset<transfer.bytes){
    const {data}=await transfers.next(transfer.id,offset);offset+=data.length;
    const joined=remainder.length?Buffer.concat([remainder,data]):data,usable=joined.length-joined.length%3;
    parts.push(joined.subarray(0,usable).toString('base64'));
    remainder=joined.subarray(usable);
   }
   if(remainder.length)parts.push(remainder.toString('base64'));
   let base64='';for(const part of parts)base64+=part;
   return {fileName:transfer.fileName,base64,bytes:transfer.bytes,sha256:transfer.sha256};
  }finally{await transfers.abort(transfer.id);}
 }
 function coreSpec(transaction){return {transactionId:transaction.id,characterId:transaction.characterId,beforeScope:copy(transaction.beforeScope),targetScope:copy(transaction.targetScope),coreState:copy(transaction.target.coreState),kind:transaction.kind};}
 async function snapshotInputs(characterId){
  if(store.state.pendingLifeRollbacks?.[characterId]){await finishPendingRollback(characterId);if(store.state.pendingLifeRollbacks?.[characterId])throw Object.assign(Error('人生经济回退待恢复，暂不能保存饱腹和经历'),{code:'FEEDING_ROLLBACK_PENDING'});}
  const token=lifeToken(store.state,characterId),content=await checked('companion-life-content',{characterId});
  const scope=scopeOf(characterId,assertLife(store.state,characterId,token));
  const workEvidence=workBridge?.snapshot?await workBridge.snapshot({characterId,lifeId:scope.lifeId,operationId:token.operationId}):null;
  const coreState=coreStateBridge?await coreStateBridge.snapshot(scope):null;
  if(coreState)await validateCore(coreState,characterId,scope.lifeId);
  assertLife(store.state,characterId,token);
  const draftsById=drafts?Object.fromEntries(lifeConversations(store.state,characterId).map(({id})=>[id,drafts.get(id)])):null;
  return {characterId,token,scope,content:content?.content??{},workEvidence,coreState,canRestoreWork:typeof workBridge?.restore==='function',drafts:draftsById,savedAt:now()};
 }
 async function snapshot(characterId){
  const input=await snapshotInputs(characterId),state=await snapshotRows({characterId});
  assertLife(store.state,characterId,input.token);
  return buildLifeArchiveSnapshot(state,input);
 }
 async function save(characterId,{name,note}={}){
  knownCard(characterId);assertRollbackClear(characterId);busy(characterId);switching.add(characterId);
  try{
   await quiesceAll(characterId,{snapshot:true});
   let token,archive,artwork;
   if(store.snapshotLifeArchive){
    const input=await snapshotInputs(characterId);token=input.token;
    ({archive,artwork}=splitArchiveArtwork(await store.snapshotLifeArchive({...archiveInput,...input,metadata:{name,note}},archiveCallbacks)));
   }else{
    const value=await snapshot(characterId),file=await repository.save(value);
    token={lifeId:value.life.id,operationId:value.life.operationId};
    archive=lifeArchiveMetadata(value,file,{name,note});
   }
   await store.mutate((state,tx)=>{assertLife(state,characterId,token);saveArchive(state,tx,archive,artwork);});
   return publicArchive(archive,artwork);
  }finally{switching.delete(characterId);await activateCurrent(characterId);}
 }
 async function validateBridges(target,characterId){
  if((target.requiresWorkBridge||target.workEvidence)&&typeof workBridge?.restore!=='function')throw Error('此人生包含工作证据，请启用支持工作任务的版本后恢复');
  if(target.coreState)await validateCore(target.coreState,characterId,target.life.id);
 }
 async function validateTarget(target,characterId){
  validateLifeArchiveTarget(target,characterId);
  await validateBridges(target,characterId);
 }
 async function projectTargetLife(transaction){
  const target=transaction.target;
  if(!target.coreState||transaction.coreLifeProjected||transaction.phase==='character-published')return;
  if(typeof coreStateBridge.projectLife==='function'){
   const projected=await coreStateBridge.projectLife({life:copy(target.life),coreState:copy(target.coreState),savedAt:target.savedAt,kind:transaction.kind,at:now(),transactionId:transaction.id});
   if(!projected||projected.id!==target.life.id||projected.operationId!==target.life.operationId||projected.mode!==target.life.mode)throw Error('人生本体时间投影不得改写角色身份');
   target.life=copy(projected);
  }
  transaction.coreLifeProjected=true;
 }
 async function complete(transaction){
  const {characterId,target}=transaction;
  const legacySqlite=!transaction.staging&&!!store.readStagedLife;
  const alreadyPublished=transaction.phase==='character-published';
  if(!alreadyPublished)await upgradeTargetCore(target,characterId);
  if(transaction.staging||legacySqlite||alreadyPublished)await validateBridges(target,characterId);
  else await validateTarget(target,characterId);
  const hasCore=!!target.coreState;
  if(hasCore&&!transaction.beforeScope){
   const before=await readArchiveContent(transaction.archiveId,archiveMeta(transaction.archiveId)?.sha256);
   transaction.beforeScope=scopeOf(characterId,before.life);
  }
  if(hasCore&&!transaction.targetScope)
   transaction.targetScope={...transaction.beforeScope,characterId,lifeId:target.life.id,operationId:transaction.operationId};
  if(!alreadyPublished){
   await projectTargetLife(transaction);
   if(legacySqlite){
    const phase=transaction.phase;
    transaction.staging={cursor:0,complete:false,planVersion:2};
    const {life,coreState,version,requiredCapabilities,legacyTargetHash}=target;
    await store.mutate(state=>{
     if(state.lifeTransaction?.id!==transaction.id||state.lifeTransaction.phase!==phase||state.lifeTransaction.staging)
      throw Error('人生事务已失效');
     writeStagedMetadata(state,transaction);
    },{storeImages:false,operation:'life-restore-prepare',prepareLegacyLife:{life,coreState,version,requiredCapabilities,legacyTargetHash}});
    transaction.staging=copy(store.state.lifeTransaction.staging);
   }
  }
  const plan=transaction.staging&&!alreadyPublished?await stageLifeRestore(transaction):null;
  // The character's conversations are replaced; their drafts come from the archive.
  const replaced=new Set([...Object.values(store.state.conversations).filter(row=>row.characterId===characterId).map(row=>row.id),...(target.conversations??[]).map(row=>row.id)]);
  if(transaction.phase!=='character-published'){
  if(hasCore)await coreStateBridge.prepare(coreSpec(transaction));
  if(hasCore){transaction.engineProjection='pending';await store.mutate((state,tx)=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');writeLifeTransaction(state,tx,transaction);});}
  await checked('companion-life-project',{characterId,content:target.content,operationId:transaction.operationId});
  if(hasCore){transaction.engineProjection='applied';await store.mutate((state,tx)=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');writeLifeTransaction(state,tx,transaction);});}
  // Import only sealed task evidence. The bridge must never write or restore
  // files in the external project and must be idempotent for transactionId.
  if(target.workEvidence)await workBridge.restore({characterId,lifeId:target.life.id,operationId:transaction.operationId,evidence:copy(target.workEvidence),transactionId:transaction.id});
  if(hasCore)await coreStateBridge.apply(coreSpec(transaction));
  await store.mutate((state,tx)=>{
   if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');
   const oldCard=state.cards[characterId],cardArtwork=resetArtwork.get(transaction);
   const modelBinding=copy(oldCard.modelBinding),cardRevision=Math.max(oldCard.revision,target.card.revision||1)+1;
   if(cardArtwork){
    if(readLifeCardArtwork(state,cardArtwork.locator)!==cardArtwork.avatar)
     throw Object.assign(Error('操作失败。'),{code:'LIFE_ARCHIVE_CARD_ARTWORK_STALE'});
    const prepared=copy(target.card);
    for(const key of Object.keys(oldCard))if(key!=='avatar'&&!Object.hasOwn(prepared,key))delete oldCard[key];
    for(const [key,value] of Object.entries(prepared))if(key!=='avatar')oldCard[key]=value;
   }else state.cards[characterId]=copy(target.card);
   state.cards[characterId].modelBinding=modelBinding;state.cards[characterId].revision=cardRevision;
   // Restored group evidence belongs to this life alone. Its messages and the
   // life records must replace the same owners, without touching shared history.
   tx?.deletePartitions(['lives',characterId]);
   if(plan)state.lives[characterId]=plan.state.lives[characterId];
   else{
    const life={...copy(target.life),groupIntervals:{},restoredGroupEvidence:copy(target.groupEvidence??[]),legacyImportEnabled:false,operationId:transaction.operationId};
    state.lives[characterId]=writeParts(tx,{lives:{[characterId]:life}}).lives[characterId];
   }
   state.relationships[characterId]=copy(target.relationships);
   for(const [id,p]of Object.entries(target.personas??{})){if(!state.personas[id])state.personas[id]=copy(p);else{state.personas[id].relationships??={};if(p.relationships?.[characterId])state.personas[id].relationships[characterId]=copy(p.relationships[characterId]);}}
   // Character-owned conversations are part of the sealed archive; all other
   // characters, quotas and actual-use ledgers remain untouched.
   for(const [id,row]of Object.entries(state.conversations))if(row.characterId===characterId){tx?.messages.deleteOwner('private',id);delete state.conversations[id];}
   if(plan){
    for(const [id,row] of Object.entries(plan.state.conversations)){
     if(state.conversations[id])throw Error('人生会话 ID 冲突');
     state.conversations[id]=row;
    }
    for(const {from,to} of plan.messageOwners)tx.moveMessages(from,to);
    for(const {from,to} of plan.recordOwners)tx.moveRecords(from,to);
   }else{
    for(const row of target.conversations){const restored=copy(row);for(const message of restored.messages??[]){if(message.presentation==='pending'){message.presentation='discarded';message.status='interrupted';restored.choices=[];}if(message.status==='pending')message.status='interrupted';}if(state.conversations[restored.id])throw Error('人生会话 ID 冲突');state.conversations[restored.id]=restored;if(tx?.messages&&Array.isArray(restored.messages)){const messages=restored.messages;tx.messages.define('private',restored.id,['conversations',restored.id]);for(const message of messages)appendMessage(state,'private',restored.id,message,tx,{preserveDuplicate:true});delete state.conversations[restored.id].messages;}}
   }
   resetGroupKnowledge(state,characterId,target.life.groupIntervals,tx);
   if(tx)delete state.lives[characterId].groupIntervals;
   if(state.activeCharacterId===characterId){state.activeConversationId=conversationFor(state,characterId,state.activePersonaId,{tx}).id;}
   for(const [id,draft]of Object.entries(state.draftCards))if(id===characterId||draft.id===characterId)delete state.draftCards[id];
   state.lastLifeTransaction={id:transaction.id,characterId,at:now(),archiveId:transaction.archiveId,kind:transaction.kind,status:hasCore?'publishing':'committed'};
   if(hasCore){transaction.phase='character-published';writeLifeTransaction(state,tx,transaction);}else if(plan)delete state.lifeTransaction;else writeLifeTransaction(state,tx,null);
  },{operation:'life-restore-publish',publishLifeRestore:!!plan,storeImages:!transaction.archiveLocator});
  }
  if(hasCore){
   await coreStateBridge.finalize(coreSpec(transaction));
   await store.mutate((state,tx)=>{
    if(state.lifeTransaction?.id!==transaction.id||state.lives[characterId].id!==target.life.id||state.lives[characterId].operationId!==transaction.operationId)
     throw Error('人生收尾上下文已失效');
    state.lastLifeTransaction={id:transaction.id,characterId,at:now(),archiveId:transaction.archiveId,kind:transaction.kind,status:'committed'};
    if(legacySqlite)delete state.lifeTransaction;
    else writeLifeTransaction(state,tx,null);
   },{storeImages:false,clearLifeRestore:legacySqlite});
  }
  await clearRestoreSource(transaction);
  for(const id of replaced)drafts?.delete(id);
  await syncCard(store.state.cards[characterId]);await projectPersona(store.state.activePersonaId);await activateCurrent(characterId);onChanged(characterId);
 }
 // Restore the exact verified pre-switch character (never whole-account data).
 async function rollbackTransaction(transaction,reason){
  if(transaction.phase==='character-published')throw Error('新人生已提交，请重试本体状态收尾；不能回退共享状态');
  const {characterId}=transaction;
  let before;if(repository.has(transaction.archiveId))before=await readArchiveContent(transaction.archiveId,archiveMeta(transaction.archiveId)?.sha256);
  else if(transaction.target.coreState&&transaction.rollbackContent&&contentHash(transaction.rollbackContent)===transaction.rollbackContentSha256)before={content:copy(transaction.rollbackContent)};
  else throw Error('切换前人生档案和可校验回退内容均不可用，不能伪造恢复成功');
  if(transaction.target.coreState&&!transaction.beforeScope&&before.life){
   transaction.beforeScope=scopeOf(characterId,before.life);
   await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lifeTransaction.beforeScope=copy(transaction.beforeScope);},{storeImages:false});
  }
  if(transaction.target.coreState&&coreStateBridge){
   // The rollback generation must survive a crash after the economy rebind.
   const rollbackOperationId=transaction.rollbackOperationId??randomUUID();
   const beforeScope=transaction.beforeScope,rollbackScope=beforeScope?{...beforeScope,operationId:rollbackOperationId}:null;
   await store.mutate(state=>{
    if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');
    // Retain the legacy target's message and record partitions in place.
    state.lifeTransaction.phase='rolling-back';
    state.lifeTransaction.rollbackOperationId=rollbackOperationId;
    if(rollbackScope){state.pendingLifeRollbacks??={};const previous=state.pendingLifeRollbacks[characterId];if(previous&&previous.transactionId!==transaction.id)throw Error('另一笔人生经济回退尚未完成');state.pendingLifeRollbacks[characterId]={transactionId:transaction.id,characterId,beforeScope:copy(beforeScope),rollbackScope:copy(rollbackScope)};}
   },{storeImages:false});
   Object.assign(transaction,{phase:'rolling-back',rollbackOperationId});
   if(!rollbackScope)audit({type:'life-rollback-rebind-skipped',characterId,transactionId:transaction.id,reason:'verified-before-scope-unavailable'});
  }
  await checked('companion-life-project',{characterId,content:before.content,operationId:transaction.rollbackOperationId??randomUUID()});
  let economyComplete=false;
  if(transaction.target.coreState&&coreStateBridge){
   try{await coreStateBridge.recover({...coreSpec(transaction),decision:'rollback'});if(transaction.beforeScope&&coreStateBridge.rebindRollback){await coreStateBridge.rebindRollback({transactionId:transaction.id,beforeScope:copy(transaction.beforeScope),rollbackScope:{...transaction.beforeScope,operationId:transaction.rollbackOperationId}});economyComplete=true;}}
   catch(error){audit({type:'life-rollback-economy-deferred',characterId,transactionId:transaction.id,code:error.code??null,message:String(error.message??error).slice(0,500)});}
  }
  await clearTransaction(transaction,'rolled-back',reason);
  await clearRestoreSource(transaction);
  if(economyComplete)await finishPendingRollback(characterId,{economyComplete:true});
  else await activateCurrent(characterId);
 }
 async function clearTransaction(transaction,status,reason){
  const workerCleanup=!!store.stageLifeRestore;
  await store.mutate((state,tx)=>{
   if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');
   state.lives[transaction.characterId].operationId=status==='rolled-back'&&transaction.rollbackOperationId?transaction.rollbackOperationId:randomUUID();
   state.lastLifeTransaction={id:transaction.id,characterId:transaction.characterId,at:now(),status,error:String(reason?.message??reason??'')};
   if(status==='abandoned')Object.assign(state.lastLifeTransaction,{archiveId:transaction.archiveId,kind:transaction.kind});
   if(workerCleanup)delete state.lifeTransaction;
   else writeLifeTransaction(state,tx,null);
  },{operation:'life-restore-'+status,storeImages:false,clearLifeRestore:workerCleanup});
 }
 async function markReplayFailed(transaction,error){
  await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)return;state.lifeTransaction.replayFailed={at:now(),error:String(error?.message??error).slice(0,2000),attempts:(state.lifeTransaction.replayFailed?.attempts??0)+1};});
  audit({type:'life-transaction-replay-failed',characterId:transaction.characterId,transactionId:transaction.id,message:String(error?.message??error)});
 }
 async function change(characterId,targetFactory,kind,args={},locator=null){
  knownCard(characterId);assertRollbackClear(characterId);busy(characterId);if(store.state.lifeTransaction?.replayFailed)throw Error('另一个角色（'+(store.state.cards[store.state.lifeTransaction.characterId]?.name??store.state.lifeTransaction.characterId)+'）的人生切换还没有处理。请先对它选择重试、回到切换前或放弃，再切换其他角色的人生');if(switching.size||store.state.lifeTransaction)throw Error('已有一次人生存档操作正在执行，请完成后再操作');switching.add(characterId);let transaction;
  try{
   const id=randomUUID(),operationId=randomUUID();
   let archive,artwork,beforeScope,token,beforeContent,target,staging,resetCardArtwork;
   // A saved target is verified before quiescing the current character. Its
   // messages and derived records remain in the worker and the sealed source.
   if(locator){
    const prepared=await store.prepareArchiveRestore({...archiveInput,id,characterId,archiveId:locator.id,sha256:locator.sha256},archiveCallbacks);
    target=prepared.target;
    staging={sha256:prepared.sha256,cursor:0,complete:false,planVersion:2};
    transaction={id,staging};
   }
   await quiesceAll(characterId);
   if(locator){
    const input=await snapshotInputs(characterId);
    ({token,scope:beforeScope,content:beforeContent}=input);
    ({archive,artwork}=splitArchiveArtwork(await store.snapshotLifeArchive({...archiveInput,...input,kind,metadata:{name:args.name}},archiveCallbacks)));
    await upgradeTargetCore(target,characterId);
    await validateBridges(target,characterId);
   }else if(kind==='reset'&&store.snapshotLifeArchive){
    const input=await snapshotInputs(characterId);
    ({token,scope:beforeScope,content:beforeContent}=input);
    const saved=await store.snapshotLifeArchive({...archiveInput,...input,kind,keepResetArtwork:args.keepResetArtwork,metadata:{name:args.name}},archiveCallbacks);
    ({archive,artwork}=splitArchiveArtwork(saved.archive));resetCardArtwork=saved.resetCardArtwork;
    target=await upgradeTargetCore(repairLifeArchiveTimes(await targetFactory(saved.resetBase)),characterId);
    await validateTarget(target,characterId);
   }else{
    const before=await snapshot(characterId),beforeFile=await repository.save(before);
    archive=lifeArchiveMetadata(before,beforeFile,{name:args.name??before.card.name+' · '+(kind==='restore'?'恢复前':'重置前')});
    token={lifeId:before.life.id,operationId:before.life.operationId};beforeScope=scopeOf(characterId,before.life);beforeContent=before.content;
    target=await upgradeTargetCore(repairLifeArchiveTimes(await targetFactory(copy(before))),characterId);
    await validateTarget(target,characterId);
   }
   await checked('companion-life-validate',{characterId,content:target.content});
   transaction={id,characterId,operationId,kind,archiveId:archive.id,target,at:now(),...(staging?{staging,archiveLocator:true}:{}),...(target.coreState?{beforeScope,phase:'prepared',rollbackContent:copy(beforeContent),rollbackContentSha256:contentHash(beforeContent)}:{})};
   if(resetCardArtwork)resetArtwork.set(transaction,{locator:resetCardArtwork,avatar:readLifeCardArtwork(store.state,resetCardArtwork)});
   if(store.sealLifeRestoreSource){
    await projectTargetLife(transaction);
    if(staging){
     // No durable transaction references the draft digest before this step.
     staging.sha256=await store.projectStagedLife({id,characterId,sha256:staging.sha256,life:target.life,
      coreState:target.coreState,version:target.version,requiredCapabilities:target.requiredCapabilities});
    }else await sealStagedTarget(transaction);
   }
   await store.mutate((state,tx)=>{assertLife(state,characterId,token);saveArchive(state,tx,archive,artwork);state.lives[characterId].operationId=operationId;writeLifeTransaction(state,tx,transaction);});
   await complete(transaction);return publicArchive(archive,artwork);
  }catch(error){
   // A durable prepared transaction remains replayable after process failure.
   // If the target projection failed before publication, restore the exact
   // verified pre-switch character (never whole-account data).
   if(transaction&&store.state.lifeTransaction?.id===transaction.id){
    if(store.state.lifeTransaction.phase==='character-published'){await markReplayFailed(copy(store.state.lifeTransaction),error);throw Error('新人生已经保存，本体状态收尾待重试：'+error.message);}
    try{await rollbackTransaction(transaction,error);}catch(rollback){
     if(transaction.target.coreState)await store.mutate(state=>{if(state.lifeTransaction?.id===transaction.id)state.lifeTransaction.replayFailed={at:now(),error:String(rollback?.message??rollback).slice(0,2000),attempts:state.lifeTransaction.replayFailed?.attempts??0};});
     throw Error('人生切换失败，恢复待完成；重启将重试事务：'+rollback.message);
    }
   }
   if(transaction&&store.state.lifeTransaction?.id!==transaction.id)await clearRestoreSource(transaction);
   throw error;
  }finally{switching.delete(characterId);await activateCurrent(characterId);}
 }
 // A replay that keeps failing must not stop the app: the transaction stays,
 // only this character is locked, and the user chooses how to resolve it.
 if(store.state.lifeTransaction){let transaction=store.state.lifeTransaction;try{transaction=await fullTransaction({bridgeOnly:transaction.phase==='rolling-back'});if(transaction.phase==='rolling-back')await rollbackTransaction(transaction,'重新完成回退');else await complete(transaction);}catch(error){await markReplayFailed(transaction,error);}}
 if(Object.keys(store.state.pendingLifeRollbacks??{}).length)await retryPendingRollbacks();
 const isBusy=id=>switching.has(id)||store.state.lifeTransaction?.characterId===id;
 return {
  busy,assertStable,retryPendingRollbacks,save:(...args)=>scopedLifeWrite(()=>save(...args)),isBusy,
  // Wait for a save or switch of this character to finish. A failed replay
  // needs the user's decision, so it is reported instead of waited for.
  async whenIdle(id,timeoutMs=60000){
   const until=Date.now()+timeoutMs;
   while(isBusy(id)){
    if(store.state.lifeTransaction?.replayFailed&&store.state.lifeTransaction.characterId===id)busy(id);
    if(Date.now()>=until)throw Error('人生存档保存超过 60 秒仍未完成，请稍后重发');
    await new Promise(resolve=>setTimeout(resolve,200));
   }
  },
  recovery(){const t=store.state.lifeTransaction;if(!t?.replayFailed)return null;const archiveAvailable=!!(t.archiveId&&archiveMeta(t.archiveId)&&repository.has(t.archiveId)),rollbackContentAvailable=!!(t.rollbackContent&&contentHash(t.rollbackContent)===t.rollbackContentSha256),canRollback=t.phase!=='character-published'&&(archiveAvailable||rollbackContentAvailable);return {characterId:t.characterId,kind:t.kind,phase:t.phase??'prepared',engineProjection:t.engineProjection??'unknown',canRollback,canAbandon:t.phase!=='character-published'&&(!t.target?.coreState||canRollback),at:t.replayFailed.at,error:t.replayFailed.error,attempts:t.replayFailed.attempts,archiveAvailable,rollbackContentAvailable};},
  async recover(characterId,action){
   const current=store.state.lifeTransaction;
  if(!current?.replayFailed||current.characterId!==characterId)throw Error('该角色没有待处理的人生切换');
  const transaction=await fullTransaction({bridgeOnly:action!=='retry'});
   if(switching.size)throw Error('已有一次人生存档操作正在执行，请稍候');switching.add(characterId);
   try{
    if(action==='retry'){try{if(transaction.phase==='rolling-back')await rollbackTransaction(transaction,transaction.replayFailed.error);else await complete(transaction);}catch(error){await markReplayFailed(transaction,error);throw error;}}
    else if(action==='rollback')await rollbackTransaction(transaction,transaction.replayFailed.error);
    else if(action==='abandon'){if(transaction.target.coreState){await rollbackTransaction(transaction,transaction.replayFailed.error);await store.mutate(state=>{state.lastLifeTransaction.status='abandoned';});}else await clearTransaction(transaction,'abandoned',transaction.replayFailed.error);}
    else throw Error('未知的人生恢复操作');
    if(action==='abandon')await clearRestoreSource(transaction);
    audit({type:'life-transaction-'+action,characterId,transactionId:transaction.id});onChanged(characterId);
   }finally{switching.delete(characterId);await activateCurrent(characterId);}
  },
  list(characterId){
   knownCard(characterId);
   if(store.records)return store.records.query('root.lifeArchives','',{field:'characterId',value:characterId}).then(rows=>rows.map(row=>row.value).sort((a,b)=>b.createdAt-a.createdAt));
   return Object.values(store.state.lifeArchives).filter(a=>a.characterId===characterId).map(copy).sort((a,b)=>b.createdAt-a.createdAt);
  },
  preview(id,{personaId=store.state.activePersonaId}={}){
   if(store.readLifePreview)return this.previewForPersona(id,personaId);
   const meta=archiveMeta(id);if(!meta)throw Error('人生存档不存在');const {snapshot}=repository.read(id,meta.sha256);return {...copy(meta),...snapshot};},
  async previewForPersona(id,personaId){
   const meta=archiveMeta(id);if(!meta)throw Error('人生存档不存在');
   const preview=store.readLifePreview
    ?await store.readLifePreview({id,sha256:meta.sha256,personaId,...archiveInput},archiveCallbacks)
    :projectLifeArchivePreview(repository.read(id,meta.sha256).snapshot,personaId);
   const {avatar,...visible}=meta;return {...copy(visible),...preview};
  },
  beginExport:beginPortableExport,
  nextExport:(id,offset)=>transfers.next(id,offset),
  beginImport:bytes=>transfers.beginImport(bytes),
  appendImport:(id,offset,value)=>transfers.append(id,offset,value),
  finishImport:finishPortableImport,
  abortTransfer:id=>transfers?.abort(id),
  closeTransfers:()=>transfers?.close(),
  async label(id,args){if(!archiveMeta(id))throw Error('人生存档不存在');await store.mutate((state,tx)=>{const meta=archiveMeta(id,state,tx);if(args.name!==undefined)meta.name=String(args.name).slice(0,200);if(args.note!==undefined)meta.note=String(args.note).slice(0,4000);saveArchive(state,tx,meta);});},
  export(id){if(transfers)return exportLegacy(id);const meta=archiveMeta(id);if(!meta)throw Error('人生存档不存在');const {bytes}=repository.read(id,meta.sha256);return {fileName:meta.fileName,base64:bytes.toString('base64'),bytes:meta.bytes,sha256:meta.sha256};},
  async import(base64){
   if(transfers){
    if(typeof base64!=='string')throw Error('人生 ZIP 编码或大小无效');
    const transfer=await transfers.beginImport(base64.length,'base64');
    try{
     for(let offset=0;offset<base64.length;offset+=transfer.chunkBytes)
      await transfers.append(transfer.id,offset,base64.slice(offset,offset+transfer.chunkBytes));
     return await finishPortableImport(transfer.id);
    }finally{await transfers.abort(transfer.id);}
   }
   const bytes=archiveBase64Bytes(base64),{snapshot:target}=repository.decode(bytes);await validateTarget(target,target.characterId);if(!store.state.cards[target.characterId])throw Error('请先创建或安装存档对应角色：'+target.characterId);await checked('companion-life-validate',{characterId:target.characterId,content:target.content});const file=await repository.import(bytes),archive=lifeArchiveMetadata(target,file,{name:target.card.name+' · 导入'});await store.mutate((state,tx)=>saveArchive(state,tx,archive));return archive;},
  async restore(id){return scopedLifeWrite(async()=>{
   const archive=archiveMeta(id);
   if(!archive)throw Error('人生存档不存在');
   if(store.prepareArchiveRestore)return change(archive.characterId,null,'restore',{},archive);
   const target=repository.read(id,archive.sha256).snapshot;
   return change(archive.characterId,async()=>copy(target),'restore');
  });},
  async reset(characterId,{mode='normal',card}={}){return scopedLifeWrite(async()=>{
   if(!['normal','seed','blank'].includes(mode))throw Error('新人生模式无效');
   const keepResetArtwork=!card||card.avatar===store.state.cards[characterId]?.avatar;
   return change(characterId,async before=>{
    const independent=before.card;
    let input=card??independent;
    if(card&&keepResetArtwork&&!Object.hasOwn(independent,'avatar')){
     const {avatar,...rest}=card;input=rest;
    }
    let nextCard=copy(input);nextCard.id=characterId;nextCard.modelBinding=copy(independent.modelBinding);nextCard.revision=(independent.revision??1)+1;
    const target={...before,version:1,card:nextCard,life:{...makeLife(nextCard,{at:now()}),selectedCgIds:[]},relationships:{mode:'independent',byPersona:Object.fromEntries(Object.keys(store.state.personas).map(id=>[id,{level:1,affection:0}]))},conversations:[],groupEvidence:[],content:{}};delete target.workEvidence;delete target.requiredCapabilities;delete target.coreState;
    if(mode!=='normal'){const temporary={cards:{[characterId]:nextCard},lives:{[characterId]:target.life}};enableGrowth(temporary,characterId,mode,now());target.card=temporary.cards[characterId];target.life=temporary.lives[characterId];}
    // Presentation/API choice is independent of the life reset. The engine
    // initializes its actual default progress and preserves appearance fields.
    target.content={reset:true,preserveAppearance:true};return target;
   },'reset',{keepResetArtwork});
  });},
 };
}
