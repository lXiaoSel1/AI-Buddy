import {randomUUID,createHash} from 'node:crypto';
import {currentLife,ensureLives,lifeToken,assertLife,makeLife,lifeConversations,resetGroupKnowledge} from './companion-life.mjs';
import {conversationFor,effectiveCard,progress,relationshipFor,companionId,repairMessageTimes} from './companion-store.mjs';
import {createLifeArchiveRepository,validateWorkEvidence,validateSocialCoreState,lifeArchiveCapabilities} from './companion-life-archive.mjs';

const copy=value=>structuredClone(value);
const contentHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A repeated-group regexp can exhaust V8's regexp stack on a valid multi-MiB
// archive. Scan canonical Base64 in constant stack space before allocating the
// ZIP buffer; the archive decoder still verifies all structure and file hashes.
function archiveBase64Bytes(value){
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
function repairTimes(target){
 const now=Date.now(),messages=rows=>Array.isArray(rows)?rows.map(row=>row&&typeof row==='object'?repairMessageTimes(row,now,{unknown:true}):row):rows;
 for(const row of target.conversations??[])row.messages=messages(row.messages);
 for(const group of [...(target.groupEvidence??[]),...(target.life?.restoredGroupEvidence??[])])group.messages=messages(group.messages);
 if(target.life&&Array.isArray(target.life.personalEvents))target.life.personalEvents=messages(target.life.personalEvents);
 return target;
}
export async function createCompanionLives({store,dataRoot,imageCodec,imageConverter=null,media=null,drafts=null,workBridge=null,coreStateBridge=null,call,syncCard,projectPersona,quiesce=async()=>{},onChanged=()=>{},enableGrowth,now=Date.now,audit=()=>{}}){
 const repository=createLifeArchiveRepository({dataRoot,imageCodec,imageConverter,media}),switching=new Set();
 const knownCard=id=>{companionId(id);if(!store.state.cards[id])throw Error('角色不存在');return id;};
 const assertStable=id=>{if(store.state.lifeTransaction?.replayFailed&&store.state.lifeTransaction.characterId===id)throw Error('该角色的人生切换没有完成，请先选择重试、回到切换前或放弃这次切换');if(switching.has(id)||store.state.lifeTransaction?.characterId===id)throw Error('正在保存或切换此角色人生，请稍候');};
 const busy=id=>{assertStable(id);workBridge?.assertIdle?.(id);};
 const checked=async(action,args)=>{const result=await call(action,args);if(result?.ok===false)throw Error(result.error??'人生内容验证或保存失败');return result;};
 const scopeOf=(characterId,life=currentLife(store.state,characterId))=>({characterId,personaId:store.state.activePersonaId??'default',lifeId:life.id,operationId:life.operationId});
 const activateCurrent=async characterId=>{if(!coreStateBridge?.activate||store.state.lifeTransaction?.characterId===characterId)return;await coreStateBridge.activate(scopeOf(characterId));};
 const quiesceAll=async(characterId,options)=>{await quiesce(characterId,options);if(coreStateBridge)await coreStateBridge.quiesce(scopeOf(characterId));};
 async function validateCore(coreState,characterId,lifeId){validateSocialCoreState(coreState,{characterId,lifeId});if(!coreStateBridge)throw Error('此人生包含本体状态，请使用支持心情与投喂的版本恢复');const valid=await coreStateBridge.validate(coreState,{characterId,lifeId});if(valid===false)throw Error('人生本体状态验证失败');}
 async function upgradeTargetCore(target,characterId){
  if(!coreStateBridge||target.coreState)return target;
  const scope=scopeOf(characterId,target.life),coreState=await coreStateBridge.initial(scope);await validateCore(coreState,characterId,target.life.id);
  target.version=3;target.coreState=copy(coreState);target.requiredCapabilities=['social-core-state-v1',...(target.workEvidence?['work-task-evidence-v1']:[])];return target;
 }
 function coreSpec(transaction){return {transactionId:transaction.id,characterId:transaction.characterId,beforeScope:copy(transaction.beforeScope),targetScope:copy(transaction.targetScope),coreState:copy(transaction.target.coreState),kind:transaction.kind};}
 function metadata(snapshot,file,{name,note}={}){
  const relations=copy(snapshot.relationships),personas=Object.values(snapshot.personas??{}).map(p=>({id:p.id,name:p.name,nickname:p.nickname}));
  return {...file,characterId:snapshot.characterId,lifeId:snapshot.life.id,mode:snapshot.life.mode,name:String(name??snapshot.card.name).slice(0,200),note:String(note??'').slice(0,4000),avatar:snapshot.card.avatar||effectiveCard(snapshot.card).sprite||snapshot.card.sprite,createdAt:snapshot.savedAt,personas,relations,level:Math.max(1,...Object.values(relations.byPersona??{}).map(p=>p.level||1),relations.shared?.level||1),unlocks:(snapshot.content?.cgs??[]).map(cg=>({id:cg.id,level:cg.level,status:cg.status})),overview:Object.entries(effectiveCard(snapshot.card)).filter(([key,v])=>['personality','interests','tone'].includes(key)&&v).map(([key,v])=>key+': '+v).join('\n'),importantExperiences:[],dependencies:snapshot.dependencies??[]};
 }
 async function snapshot(characterId){
  const token=lifeToken(store.state,characterId),content=await call('companion-life-content',{characterId});assertLife(store.state,characterId,token);
  if(content?.ok===false)throw Error(content.error);const state=copy(store.state),life=copy(currentLife(state,characterId));
  const conversations=lifeConversations(state,characterId),personaIds=new Set([...conversations.map(c=>c.personaId),...Object.keys(state.relationships[characterId]?.byPersona??{})]);
  const groupEvidence=Object.values(state.groups).filter(g=>life.groupIntervals[g.id]?.length).map(g=>({id:g.id,name:g.name,personaId:g.personaId,scene:g.scene,background:g.background,seq:g.seq,intervals:copy(life.groupIntervals[g.id]).map(row=>({...row,end:row.end===null?g.seq:row.end})),messages:copy(g.messages.filter(m=>life.groupIntervals[g.id].some(i=>m.seq>=i.start&&(i.end===null||m.seq<=i.end))))}));
  for(const group of groupEvidence)personaIds.add(group.personaId);
  const workEvidence=workBridge?.snapshot?await workBridge.snapshot({characterId,lifeId:life.id,operationId:token.operationId}):null;
  if(workEvidence){validateWorkEvidence(workEvidence,{characterId,lifeId:life.id});for(const task of workEvidence.tasks)personaIds.add(task.scope.personaId);}
  if((life.workExperiences??[]).length&&!workEvidence)throw Error('工作经历缺少完整任务证据，不能创建不完整人生存档');
  const hasWork=!!workEvidence?.tasks?.length;
  if(hasWork&&typeof workBridge?.restore!=='function')throw Error('工作档案恢复服务尚未就绪');
  let coreState=null;if(coreStateBridge){coreState=await coreStateBridge.snapshot(scopeOf(characterId,life));await validateCore(coreState,characterId,life.id);for(const event of coreState.feeding?.mealEvidence??[])personaIds.add(event.scope.personaId);}
  assertLife(store.state,characterId,token);
  // Seal the old open intervals at this precise snapshot cutoff. Restore will
  // reopen at the present boundary, never grant knowledge of the gap.
  life.groupIntervals=Object.fromEntries(groupEvidence.map(g=>[g.id,g.intervals]));life.selectedCgIds=[...new Set([...(content.content?.cgs??[]),...(content.content?.sharedCgs??[])].map(cg=>cg.id))];
  return {format:'ai-buddy-life-state',version:coreState?3:hasWork?2:1,...(coreState?{requiredCapabilities:['social-core-state-v1',...(hasWork?['work-task-evidence-v1']:[])],coreState:copy(coreState)}:hasWork?{requiredCapabilities:['work-task-evidence-v1']} :{}),...(hasWork?{workEvidence:copy(workEvidence)}:{}),characterId,savedAt:now(),card:copy(state.cards[characterId]),life,relationships:copy(state.relationships[characterId]??{mode:'independent',byPersona:{}}),personas:Object.fromEntries([...personaIds].filter(id=>state.personas[id]).map(id=>[id,{...copy(state.personas[id]),relationships:{[characterId]:copy(state.personas[id].relationships?.[characterId]??{})}}])),conversations:copy(conversations).map(row=>({...row,draft:drafts?.get(row.id)??row.draft??''})),groupEvidence,content:copy(content?.content??{}),dependencies:[{type:'builtin-character-resources',version:'1.8.0',characterId,optional:state.cards[characterId].builtin!==true}]};
 }
 async function save(characterId,args={}){knownCard(characterId);busy(characterId);switching.add(characterId);try{await quiesceAll(characterId,{snapshot:true});const value=await snapshot(characterId),file=await repository.save(value),archive=metadata(value,file,args);await store.mutate(state=>{assertLife(state,characterId,{lifeId:value.life.id,operationId:value.life.operationId});state.lifeArchives[archive.id]=archive;});return archive;}finally{switching.delete(characterId);await activateCurrent(characterId);}}
 async function validateTarget(target,characterId){
  if(target.characterId!==characterId||target.card?.id!==characterId||!['normal','seed','blank'].includes(target.life?.mode))throw Error('人生存档角色或模式不匹配');
  lifeArchiveCapabilities(target);
  if(target.workEvidence){validateWorkEvidence(target.workEvidence,{characterId,lifeId:target.life.id});if(typeof workBridge?.restore!=='function')throw Error('此人生包含工作证据，请启用支持工作任务的版本后恢复');for(const task of target.workEvidence.tasks)if(!target.personas?.[task.scope.personaId])throw Error('人生工作任务缺少对应身份');}
  if(target.coreState){await validateCore(target.coreState,characterId,target.life.id);for(const event of target.coreState.feeding?.mealEvidence??[])if(!target.personas?.[event.scope.personaId])throw Error('人生进食经历缺少对应身份');}
  for(const [id,p]of Object.entries(target.personas??{})){companionId(id);if(id!==p.id)throw Error('人生身份数据无效');}
  for(const row of target.conversations){companionId(row.id);if(row.characterId!==characterId||row.lifeId!==target.life.id||!target.personas[row.personaId]||!Array.isArray(row.messages)||new Set(row.messages.map(m=>m.id)).size!==row.messages.length)throw Error('人生会话归属或消息无效');}
  for(const relation of [...Object.values(target.relationships.byPersona??{}),...(target.relationships.shared?[target.relationships.shared]:[])])if(!Number.isFinite(relation.level)||relation.level<1||!Number.isFinite(relation.affection)||relation.affection<0)throw Error('人生进度无效');
 }
 async function complete(transaction){
  const {characterId}=transaction;await upgradeTargetCore(transaction.target,characterId);const target=transaction.target;await validateTarget(target,characterId);const hasCore=!!target.coreState;
  if(hasCore&&!transaction.beforeScope){const before=repository.read(transaction.archiveId,store.state.lifeArchives[transaction.archiveId]?.sha256).snapshot;transaction.beforeScope=scopeOf(characterId,before.life);await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lifeTransaction=copy(transaction);});}
  if(hasCore&&!transaction.targetScope){transaction.targetScope={...transaction.beforeScope,characterId,lifeId:target.life.id,operationId:transaction.operationId};await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lifeTransaction=copy(transaction);});}
  if(hasCore&&!transaction.coreLifeProjected&&transaction.phase!=='character-published'){
   if(typeof coreStateBridge.projectLife==='function'){
    const projected=await coreStateBridge.projectLife({life:copy(target.life),coreState:copy(target.coreState),savedAt:target.savedAt,kind:transaction.kind,at:now(),transactionId:transaction.id});
    if(!projected||projected.id!==target.life.id||projected.operationId!==target.life.operationId||projected.mode!==target.life.mode)throw Error('人生本体时间投影不得改写角色身份');target.life=copy(projected);
   }
   transaction.coreLifeProjected=true;await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lifeTransaction=copy(transaction);});
  }
  // The character's conversations are replaced; their drafts come from the archive.
  const replaced=new Set([...Object.values(store.state.conversations).filter(row=>row.characterId===characterId).map(row=>row.id),...target.conversations.map(row=>row.id)]);
  if(transaction.phase!=='character-published'){
  if(hasCore)await coreStateBridge.prepare(coreSpec(transaction));
  if(hasCore){transaction.engineProjection='pending';await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lifeTransaction=copy(transaction);});}
  await checked('companion-life-project',{characterId,content:target.content,operationId:transaction.operationId});
  if(hasCore){transaction.engineProjection='applied';await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lifeTransaction=copy(transaction);});}
  // Import only sealed task evidence. The bridge must never write or restore
  // files in the external project and must be idempotent for transactionId.
  if(target.workEvidence)await workBridge.restore({characterId,lifeId:target.life.id,operationId:transaction.operationId,evidence:copy(target.workEvidence),transactionId:transaction.id});
  if(hasCore)await coreStateBridge.apply(coreSpec(transaction));
  await store.mutate(state=>{
   if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');
   const oldCard=state.cards[characterId];state.cards[characterId]=copy(target.card);state.cards[characterId].modelBinding=copy(oldCard.modelBinding);state.cards[characterId].revision=Math.max(oldCard.revision,target.card.revision||1)+1;
   state.lives[characterId]={...copy(target.life),legacyImportEnabled:false,operationId:transaction.operationId};state.relationships[characterId]=copy(target.relationships);
   for(const [id,p]of Object.entries(target.personas??{})){if(!state.personas[id])state.personas[id]=copy(p);else{state.personas[id].relationships??={};if(p.relationships?.[characterId])state.personas[id].relationships[characterId]=copy(p.relationships[characterId]);}}
   // Character-owned conversations are part of the sealed archive; all other
   // characters, quotas and actual-use ledgers remain untouched.
   for(const [id,row]of Object.entries(state.conversations))if(row.characterId===characterId)delete state.conversations[id];
   for(const row of target.conversations){const restored=copy(row);for(const message of restored.messages??[]){if(message.presentation==='pending'){message.presentation='discarded';message.status='interrupted';restored.choices=[];}if(message.status==='pending')message.status='interrupted';}if(state.conversations[restored.id])throw Error('人生会话 ID 冲突');state.conversations[restored.id]=restored;}
   resetGroupKnowledge(state,characterId,target.life.groupIntervals);
   // Imported group evidence belongs to this life only. Do not overwrite a
   // shared group's history, membership or anyone else's knowledge.
   state.lives[characterId].restoredGroupEvidence=copy(target.groupEvidence??[]);
   if(state.activeCharacterId===characterId){state.activeConversationId=conversationFor(state,characterId,state.activePersonaId).id;}
   for(const [id,draft]of Object.entries(state.draftCards))if(id===characterId||draft.id===characterId)delete state.draftCards[id];
   state.lastLifeTransaction={id:transaction.id,characterId,at:now(),archiveId:transaction.archiveId,kind:transaction.kind,status:hasCore?'publishing':'committed'};
   if(hasCore){transaction.phase='character-published';state.lifeTransaction=copy(transaction);}else delete state.lifeTransaction;
  });
  }
  if(hasCore){
   await coreStateBridge.finalize(coreSpec(transaction));
   await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id||state.lives[characterId].id!==target.life.id||state.lives[characterId].operationId!==transaction.operationId)throw Error('人生收尾上下文已失效');state.lastLifeTransaction={id:transaction.id,characterId,at:now(),archiveId:transaction.archiveId,kind:transaction.kind,status:'committed'};delete state.lifeTransaction;});
  }
  for(const id of replaced)drafts?.delete(id);
  await syncCard(store.state.cards[characterId]);await projectPersona(store.state.activePersonaId);await activateCurrent(characterId);onChanged(characterId);
 }
 // Restore the exact verified pre-switch character (never whole-account data).
 async function rollbackTransaction(transaction,reason){
  if(transaction.phase==='character-published')throw Error('新人生已提交，请重试本体状态收尾；不能回退共享状态');
  const {characterId}=transaction;
  let before;if(repository.has(transaction.archiveId))before=repository.read(transaction.archiveId,store.state.lifeArchives[transaction.archiveId]?.sha256).snapshot;
  else if(transaction.target.coreState&&transaction.rollbackContent&&contentHash(transaction.rollbackContent)===transaction.rollbackContentSha256)before={content:copy(transaction.rollbackContent)};
  else throw Error('切换前人生档案和可校验回退内容均不可用，不能伪造恢复成功');
  if(transaction.target.coreState&&coreStateBridge){transaction.phase='rolling-back';await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lifeTransaction=copy(transaction);});await coreStateBridge.recover({...coreSpec(transaction),decision:'rollback'});}
  await checked('companion-life-project',{characterId,content:before.content,operationId:randomUUID()});
  await store.mutate(state=>{state.lives[characterId].operationId=randomUUID();state.lastLifeTransaction={id:transaction.id,characterId,at:now(),status:'rolled-back',error:String(reason?.message??reason??'')};delete state.lifeTransaction;});
  await activateCurrent(characterId);
 }
 async function markReplayFailed(transaction,error){
  await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)return;state.lifeTransaction.replayFailed={at:now(),error:String(error?.message??error).slice(0,2000),attempts:(state.lifeTransaction.replayFailed?.attempts??0)+1};});
  audit({type:'life-transaction-replay-failed',characterId:transaction.characterId,transactionId:transaction.id,message:String(error?.message??error)});
 }
 async function change(characterId,targetFactory,kind,args={}){
  knownCard(characterId);busy(characterId);if(store.state.lifeTransaction?.replayFailed)throw Error('另一个角色（'+(store.state.cards[store.state.lifeTransaction.characterId]?.name??store.state.lifeTransaction.characterId)+'）的人生切换还没有处理。请先对它选择重试、回到切换前或放弃，再切换其他角色的人生');if(switching.size||store.state.lifeTransaction)throw Error('已有一次人生存档操作正在执行，请完成后再操作');switching.add(characterId);let transaction;
  try{
   await quiesceAll(characterId);const before=await snapshot(characterId),beforeFile=await repository.save(before),archive=metadata(before,beforeFile,{name:args.name??before.card.name+' · '+(kind==='restore'?'恢复前':'重置前')});
   const target=await upgradeTargetCore(repairTimes(await targetFactory(copy(before))),characterId);await validateTarget(target,characterId);
   // Content decoder validates the whole target before changing either store.
   await checked('companion-life-validate',{characterId,content:target.content});
   transaction={id:randomUUID(),characterId,operationId:randomUUID(),kind,archiveId:archive.id,target,at:now(),...(target.coreState?{beforeScope:scopeOf(characterId,before.life),phase:'prepared',rollbackContent:copy(before.content),rollbackContentSha256:contentHash(before.content)}:{})};
   await store.mutate(state=>{assertLife(state,characterId,{lifeId:before.life.id,operationId:before.life.operationId});state.lifeArchives[archive.id]=archive;state.lives[characterId].operationId=transaction.operationId;state.lifeTransaction=transaction;});
   await complete(transaction);return archive;
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
   throw error;
  }finally{switching.delete(characterId);await activateCurrent(characterId);}
 }
 // A replay that keeps failing must not stop the app: the transaction stays,
 // only this character is locked, and the user chooses how to resolve it.
 if(store.state.lifeTransaction){const transaction=copy(store.state.lifeTransaction);try{if(transaction.phase==='rolling-back')await rollbackTransaction(transaction,'重新完成回退');else await complete(transaction);}catch(error){await markReplayFailed(transaction,error);}}
 const isBusy=id=>switching.has(id)||store.state.lifeTransaction?.characterId===id;
 return {
  busy,assertStable,save,isBusy,
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
  recovery(){const t=store.state.lifeTransaction;if(!t?.replayFailed)return null;const archiveAvailable=!!(t.archiveId&&store.state.lifeArchives[t.archiveId]&&repository.has(t.archiveId)),rollbackContentAvailable=!!(t.rollbackContent&&contentHash(t.rollbackContent)===t.rollbackContentSha256),canRollback=t.phase!=='character-published'&&(archiveAvailable||rollbackContentAvailable);return {characterId:t.characterId,kind:t.kind,phase:t.phase??'prepared',engineProjection:t.engineProjection??'unknown',canRollback,canAbandon:t.phase!=='character-published'&&(!t.target.coreState||canRollback),at:t.replayFailed.at,error:t.replayFailed.error,attempts:t.replayFailed.attempts,archiveAvailable,rollbackContentAvailable};},
  async recover(characterId,action){
   const transaction=copy(store.state.lifeTransaction??null);if(!transaction?.replayFailed||transaction.characterId!==characterId)throw Error('该角色没有待处理的人生切换');
   if(switching.size)throw Error('已有一次人生存档操作正在执行，请稍候');switching.add(characterId);
   try{
    if(action==='retry'){try{if(transaction.phase==='rolling-back')await rollbackTransaction(transaction,transaction.replayFailed.error);else await complete(transaction);}catch(error){await markReplayFailed(transaction,error);throw error;}}
    else if(action==='rollback')await rollbackTransaction(transaction,transaction.replayFailed.error);
    else if(action==='abandon'){if(transaction.target.coreState){await rollbackTransaction(transaction,transaction.replayFailed.error);await store.mutate(state=>{state.lastLifeTransaction.status='abandoned';});}else await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lives[characterId].operationId=randomUUID();state.lastLifeTransaction={id:transaction.id,characterId,at:now(),archiveId:transaction.archiveId,kind:transaction.kind,status:'abandoned',error:transaction.replayFailed.error};delete state.lifeTransaction;});}
    else throw Error('未知的人生恢复操作');
    audit({type:'life-transaction-'+action,characterId,transactionId:transaction.id});onChanged(characterId);
   }finally{switching.delete(characterId);await activateCurrent(characterId);}
  },
  list(characterId){knownCard(characterId);return Object.values(store.state.lifeArchives).filter(a=>a.characterId===characterId).map(copy).sort((a,b)=>b.createdAt-a.createdAt);},
  preview(id){const meta=store.state.lifeArchives[id];if(!meta)throw Error('人生存档不存在');const {snapshot}=repository.read(id,meta.sha256);return {...copy(meta),...snapshot};},
  async label(id,args){if(!store.state.lifeArchives[id])throw Error('人生存档不存在');await store.mutate(state=>{if(args.name!==undefined)state.lifeArchives[id].name=String(args.name).slice(0,200);if(args.note!==undefined)state.lifeArchives[id].note=String(args.note).slice(0,4000);});},
  export(id){const meta=store.state.lifeArchives[id];if(!meta)throw Error('人生存档不存在');const {bytes}=repository.read(id,meta.sha256);return {fileName:meta.fileName,base64:bytes.toString('base64'),bytes:meta.bytes,sha256:meta.sha256};},
  async import(base64){const bytes=archiveBase64Bytes(base64),{snapshot:target}=repository.decode(bytes);await validateTarget(target,target.characterId);if(!store.state.cards[target.characterId])throw Error('请先创建或安装存档对应角色：'+target.characterId);await checked('companion-life-validate',{characterId:target.characterId,content:target.content});const file=await repository.import(bytes),archive=metadata(target,file,{name:target.card.name+' · 导入'});await store.mutate(state=>{state.lifeArchives[archive.id]=archive;});return archive;},
  async restore(id){const archive=store.state.lifeArchives[id];if(!archive)throw Error('人生存档不存在');const target=repository.read(id,archive.sha256).snapshot;return change(archive.characterId,async()=>copy(target),'restore');},
  async reset(characterId,{mode='normal',card}={}){
   if(!['normal','seed','blank'].includes(mode))throw Error('新人生模式无效');
   return change(characterId,async before=>{
    const independent=before.card;let nextCard=copy(card??independent);nextCard.id=characterId;nextCard.modelBinding=copy(independent.modelBinding);nextCard.revision=(independent.revision??1)+1;
    const target={...before,version:1,card:nextCard,life:{...makeLife(nextCard,{at:now()}),selectedCgIds:[]},relationships:{mode:'independent',byPersona:Object.fromEntries(Object.keys(store.state.personas).map(id=>[id,{level:1,affection:0}]))},conversations:[],groupEvidence:[],content:{}};delete target.workEvidence;delete target.requiredCapabilities;delete target.coreState;
    if(mode!=='normal'){const temporary={cards:{[characterId]:nextCard},lives:{[characterId]:target.life}};enableGrowth(temporary,characterId,mode,now());target.card=temporary.cards[characterId];target.life=temporary.lives[characterId];}
    // Presentation/API choice is independent of the life reset. The engine
    // initializes its actual default progress and preserves appearance fields.
    target.content={reset:true,preserveAppearance:true};return target;
   },'reset');
  },
 };
}
