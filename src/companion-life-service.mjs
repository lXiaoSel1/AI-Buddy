import {randomUUID} from 'node:crypto';
import {currentLife,ensureLives,lifeToken,assertLife,makeLife,lifeConversations,resetGroupKnowledge} from './companion-life.mjs';
import {conversationFor,effectiveCard,progress,relationshipFor,companionId} from './companion-store.mjs';
import {createLifeArchiveRepository} from './companion-life-archive.mjs';

const copy=value=>structuredClone(value);
export async function createCompanionLives({store,dataRoot,imageCodec,call,syncCard,projectPersona,quiesce=async()=>{},onChanged=()=>{},enableGrowth,now=Date.now,audit=()=>{}}){
 const repository=createLifeArchiveRepository({dataRoot,imageCodec}),switching=new Set();
 const knownCard=id=>{companionId(id);if(!store.state.cards[id])throw Error('角色不存在');return id;};
 const busy=id=>{if(store.state.lifeTransaction?.replayFailed&&store.state.lifeTransaction.characterId===id)throw Error('该角色的人生切换没有完成，请先选择重试、回到切换前或放弃这次切换');if(switching.has(id)||store.state.lifeTransaction?.characterId===id)throw Error('正在保存或切换此角色人生，请稍候');};
 const checked=async(action,args)=>{const result=await call(action,args);if(result?.ok===false)throw Error(result.error??'人生内容验证或保存失败');return result;};
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
  // Seal the old open intervals at this precise snapshot cutoff. Restore will
  // reopen at the present boundary, never grant knowledge of the gap.
  life.groupIntervals=Object.fromEntries(groupEvidence.map(g=>[g.id,g.intervals]));life.selectedCgIds=[...new Set([...(content.content?.cgs??[]),...(content.content?.sharedCgs??[])].map(cg=>cg.id))];
  return {format:'ai-buddy-life-state',version:1,characterId,savedAt:now(),card:copy(state.cards[characterId]),life,relationships:copy(state.relationships[characterId]??{mode:'independent',byPersona:{}}),personas:Object.fromEntries([...personaIds].filter(id=>state.personas[id]).map(id=>[id,{...copy(state.personas[id]),relationships:{[characterId]:copy(state.personas[id].relationships?.[characterId]??{})}}])),conversations:copy(conversations),groupEvidence,content:copy(content?.content??{}),dependencies:[{type:'builtin-character-resources',version:'1.8.0',characterId,optional:state.cards[characterId].builtin!==true}]};
 }
 async function save(characterId,args={}){knownCard(characterId);busy(characterId);switching.add(characterId);try{await quiesce(characterId,{snapshot:true});const value=await snapshot(characterId),file=repository.save(value),archive=metadata(value,file,args);await store.mutate(state=>{assertLife(state,characterId,{lifeId:value.life.id,operationId:value.life.operationId});state.lifeArchives[archive.id]=archive;});return archive;}finally{switching.delete(characterId);}}
 function validateTarget(target,characterId){
  if(target.characterId!==characterId||target.card?.id!==characterId||!['normal','seed','blank'].includes(target.life?.mode))throw Error('人生存档角色或模式不匹配');
  for(const [id,p]of Object.entries(target.personas??{})){companionId(id);if(id!==p.id)throw Error('人生身份数据无效');}
  for(const row of target.conversations){companionId(row.id);if(row.characterId!==characterId||row.lifeId!==target.life.id||!target.personas[row.personaId]||!Array.isArray(row.messages)||new Set(row.messages.map(m=>m.id)).size!==row.messages.length)throw Error('人生会话归属或消息无效');}
  for(const relation of [...Object.values(target.relationships.byPersona??{}),...(target.relationships.shared?[target.relationships.shared]:[])])if(!Number.isFinite(relation.level)||relation.level<1||!Number.isFinite(relation.affection)||relation.affection<0)throw Error('人生进度无效');
 }
 async function complete(transaction){
  const {characterId,target}=transaction;validateTarget(target,characterId);
  await checked('companion-life-project',{characterId,content:target.content,operationId:transaction.operationId});
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
   state.lastLifeTransaction={id:transaction.id,characterId,at:now(),archiveId:transaction.archiveId,kind:transaction.kind,status:'committed'};delete state.lifeTransaction;
  });
  await syncCard(store.state.cards[characterId]);await projectPersona(store.state.activePersonaId);onChanged(characterId);
 }
 // Restore the exact verified pre-switch character (never whole-account data).
 async function rollbackTransaction(transaction,reason){
  const {characterId}=transaction,before=repository.read(transaction.archiveId,store.state.lifeArchives[transaction.archiveId]?.sha256).snapshot;
  await checked('companion-life-project',{characterId,content:before.content,operationId:randomUUID()});
  await store.mutate(state=>{state.lives[characterId].operationId=randomUUID();state.lastLifeTransaction={id:transaction.id,characterId,at:now(),status:'rolled-back',error:String(reason?.message??reason??'')};delete state.lifeTransaction;});
 }
 async function markReplayFailed(transaction,error){
  await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)return;state.lifeTransaction.replayFailed={at:now(),error:String(error?.message??error).slice(0,2000),attempts:(state.lifeTransaction.replayFailed?.attempts??0)+1};});
  audit({type:'life-transaction-replay-failed',characterId:transaction.characterId,transactionId:transaction.id,message:String(error?.message??error)});
 }
 async function change(characterId,targetFactory,kind,args={}){
  knownCard(characterId);busy(characterId);if(switching.size||store.state.lifeTransaction)throw Error('已有一次人生存档操作正在执行，请完成后再操作');switching.add(characterId);let transaction;
  try{
   await quiesce(characterId);const before=await snapshot(characterId),beforeFile=repository.save(before),archive=metadata(before,beforeFile,{name:args.name??before.card.name+' · '+(kind==='restore'?'恢复前':'重置前')});
   const target=await targetFactory(copy(before));validateTarget(target,characterId);
   // Content decoder validates the whole target before changing either store.
   await checked('companion-life-validate',{characterId,content:target.content});
   transaction={id:randomUUID(),characterId,operationId:randomUUID(),kind,archiveId:archive.id,target,at:now()};
   await store.mutate(state=>{assertLife(state,characterId,{lifeId:before.life.id,operationId:before.life.operationId});state.lifeArchives[archive.id]=archive;state.lives[characterId].operationId=transaction.operationId;state.lifeTransaction=transaction;});
   await complete(transaction);return archive;
  }catch(error){
   // A durable prepared transaction remains replayable after process failure.
   // If the target projection failed before publication, restore the exact
   // verified pre-switch character (never whole-account data).
   if(transaction&&store.state.lifeTransaction?.id===transaction.id){
    try{await rollbackTransaction(transaction,error);}catch(rollback){throw Error('人生切换失败，恢复待完成；重启将重试事务：'+rollback.message);}
   }
   throw error;
  }finally{switching.delete(characterId);}
 }
 // A replay that keeps failing must not stop the app: the transaction stays,
 // only this character is locked, and the user chooses how to resolve it.
 if(store.state.lifeTransaction){const transaction=copy(store.state.lifeTransaction);try{await complete(transaction);}catch(error){await markReplayFailed(transaction,error);}}
 const isBusy=id=>switching.has(id)||store.state.lifeTransaction?.characterId===id;
 return {
  busy,save,isBusy,
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
  recovery(){const t=store.state.lifeTransaction;if(!t?.replayFailed)return null;return {characterId:t.characterId,kind:t.kind,at:t.replayFailed.at,error:t.replayFailed.error,attempts:t.replayFailed.attempts,archiveAvailable:!!(t.archiveId&&store.state.lifeArchives[t.archiveId]&&repository.has(t.archiveId))};},
  async recover(characterId,action){
   const transaction=copy(store.state.lifeTransaction??null);if(!transaction?.replayFailed||transaction.characterId!==characterId)throw Error('该角色没有待处理的人生切换');
   if(switching.size)throw Error('已有一次人生存档操作正在执行，请稍候');switching.add(characterId);
   try{
    if(action==='retry'){try{await complete(transaction);}catch(error){await markReplayFailed(transaction,error);throw error;}}
    else if(action==='rollback')await rollbackTransaction(transaction,transaction.replayFailed.error);
    else if(action==='abandon')await store.mutate(state=>{if(state.lifeTransaction?.id!==transaction.id)throw Error('人生事务已失效');state.lives[characterId].operationId=randomUUID();state.lastLifeTransaction={id:transaction.id,characterId,at:now(),archiveId:transaction.archiveId,kind:transaction.kind,status:'abandoned',error:transaction.replayFailed.error};delete state.lifeTransaction;});
    else throw Error('未知的人生恢复操作');
    audit({type:'life-transaction-'+action,characterId,transactionId:transaction.id});onChanged(characterId);
   }finally{switching.delete(characterId);}
  },
  list(characterId){knownCard(characterId);return Object.values(store.state.lifeArchives).filter(a=>a.characterId===characterId).map(copy).sort((a,b)=>b.createdAt-a.createdAt);},
  preview(id){const meta=store.state.lifeArchives[id];if(!meta)throw Error('人生存档不存在');const {snapshot}=repository.read(id,meta.sha256);return {...copy(meta),...snapshot};},
  async label(id,args){if(!store.state.lifeArchives[id])throw Error('人生存档不存在');await store.mutate(state=>{if(args.name!==undefined)state.lifeArchives[id].name=String(args.name).slice(0,200);if(args.note!==undefined)state.lifeArchives[id].note=String(args.note).slice(0,4000);});},
  export(id){const meta=store.state.lifeArchives[id];if(!meta)throw Error('人生存档不存在');const {bytes}=repository.read(id,meta.sha256);return {fileName:meta.fileName,base64:bytes.toString('base64'),bytes:meta.bytes,sha256:meta.sha256};},
  async import(base64){if(typeof base64!=='string'||base64.length>715827884||!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw Error('人生 ZIP 编码或大小无效');const bytes=Buffer.from(base64,'base64'),{snapshot:target}=repository.decode(bytes);validateTarget(target,target.characterId);if(!store.state.cards[target.characterId])throw Error('请先创建或安装存档对应角色：'+target.characterId);await checked('companion-life-validate',{characterId:target.characterId,content:target.content});const file=repository.import(bytes),archive=metadata(target,file,{name:target.card.name+' · 导入'});await store.mutate(state=>{state.lifeArchives[archive.id]=archive;});return archive;},
  async restore(id){const archive=store.state.lifeArchives[id];if(!archive)throw Error('人生存档不存在');const target=repository.read(id,archive.sha256).snapshot;return change(archive.characterId,async()=>copy(target),'restore');},
  async reset(characterId,{mode='normal',card}={}){
   if(!['normal','seed','blank'].includes(mode))throw Error('新人生模式无效');
   return change(characterId,async before=>{
    const independent=before.card;let nextCard=copy(card??independent);nextCard.id=characterId;nextCard.modelBinding=copy(independent.modelBinding);nextCard.revision=(independent.revision??1)+1;
    const target={...before,card:nextCard,life:{...makeLife(nextCard,{at:now()}),selectedCgIds:[]},relationships:{mode:'independent',byPersona:Object.fromEntries(Object.keys(store.state.personas).map(id=>[id,{level:1,affection:0}]))},conversations:[],groupEvidence:[],content:{}};
    if(mode!=='normal'){const temporary={cards:{[characterId]:nextCard},lives:{[characterId]:target.life}};enableGrowth(temporary,characterId,mode,now());target.card=temporary.cards[characterId];target.life=temporary.lives[characterId];}
    // Presentation/API choice is independent of the life reset. The engine
    // initializes its actual default progress and preserves appearance fields.
    target.content={reset:true,preserveAppearance:true};return target;
   },'reset');
  },
 };
}
