import {randomUUID,createHash} from 'node:crypto';
import {groupPhotoPlanner,validatePhotoPlanner} from './group-cg-planner.mjs';
import {defaultContextCapacity} from './context-capacity.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ensureLives,currentLife,lifeToken,assertLife,lifeConversations,lifeGroupMessages,updateLifeIntervals} from './companion-life.mjs';
import {createCompanionMemory,estimateMemoryTokens} from './companion-memory.mjs';
import {assertCardEditAllowed,enableGrowth,applyGrowthCandidates,growthView} from './companion-growth.mjs';
import {createCompanionLives} from './companion-life-service.mjs';
import {replyEmotion,groupDialogueText} from './group-stage.mjs';
import {resolveMentionIds} from './group-mentions.mjs';
import {planLegacyDedupe,applyLegacyDedupe} from './legacy-dedupe.mjs';
import {createMaintenance} from './maintenance.mjs';
import {resolveCardImages,resolveStateImages} from './media-store.mjs';
import {mediaMaintenanceTasks} from './media-migration.mjs';
import {DEFAULT_PERSONA_ID,CARD_FIELDS,migrateCharacterTalkativeness,effectiveCard,makeCard,relationshipFor,conversationFor,progress,visibleGroupMessages,groupSpeakers,safeMessage,validTime,companionId,restoreCompanionExport,companionText as text,companionCopy as copy} from './companion-store.mjs';

const affectionDelta=value=>/喜欢|爱|可爱|想你|陪你|晚安|早安|抱抱|亲亲|约会|月圆/.test(value)?1:/讨厌|烦|滚|走开|无聊|再见/.test(value)?-1:0;
const personaSnapshot=persona=>Object.fromEntries(Object.entries(persona).filter(([key])=>key!=='avatar'));
const promptPersona=(persona,characterId)=>({...Object.fromEntries(Object.entries(persona).filter(([key])=>!['avatar','relationships'].includes(key))),relationship:copy(persona.relationships?.[characterId]??{})});
const promptCard=(card,persona)=>{const value=effectiveCard(card),relation=persona.relationships?.[card.id];return {...value,...(relation?.address?{address:relation.address}:{}),...(relation?.relationship?{relationship:[value.relationship,relation.relationship].filter(Boolean).join('\n')}:{} )};};
// A JSON-looking reply that does not parse (for example one cut off mid-string)
// must never be shown as code: take its "text" value, or null for plain text.
export function lenientReplyText(raw){
 const body=String(raw??'').replace(/^```(?:json)?\s*|\s*```$/g,'').trim();
 // A reply that starts like a JSON object ('{' then a quoted key); '{叹气} 好吧' is dialogue.
 if(!/^\{\s*"/.test(body))return null;
 const match=/"text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(body);if(!match)return '';
 try{return JSON.parse('"'+match[1]+'"');}catch{return match[1].replace(/\\(["\\/])/g,'$1').replace(/\\n/g,'\n');}
}
function emotionReply(raw,speakerName){try{const value=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));if(typeof value.text==='string'&&value.text.trim())return {text:value.text,...replyEmotion(value.text,value.emotion,{speakerName}),affection:[-1,0,1].includes(value.affection)?value.affection:0};}catch{}const extracted=lenientReplyText(raw);if(extracted!==null){if(!extracted.trim())throw Error('模型回复格式不完整，请重试');return {text:extracted,...replyEmotion(extracted,undefined,{speakerName}),affection:0};}return {text:raw,...replyEmotion(raw,undefined,{speakerName}),affection:0};}
function groupEmotionReply(raw,speakerName,characterId,memberIds){
 const result=emotionReply(raw,speakerName);
 try{
  const value=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));
  if(typeof value.text!=='string'||!value.text.trim())return result;
  const peer=memberIds.includes(value.interactionTarget)&&value.interactionTarget!==characterId;
  if(['user','group'].includes(value.interactionTarget)||peer)result.interactionTarget=value.interactionTarget;
  // Older integrations return only text/emotion/affection. Keep that format,
  // while new target metadata prevents a disagreement with a peer from being
  // applied to the player's relationship. A real player reaction can coexist
  // with a peer-directed line and therefore explicitly takes precedence.
  if(Object.hasOwn(value,'affectionTarget')){
   result.affectionTarget=['user','member','none'].includes(value.affectionTarget)?value.affectionTarget:'none';
   if(result.affectionTarget!=='user')result.affection=0;
  }else if(peer){result.affectionTarget='none';result.affection=0;}
 }catch{}
 return result;
}
export async function createCompanionService({store,engine,provider,dataRoot=null,imageCodec=null,imageConverter=null,media=null,drafts=null,resources=null,onCharacter=()=>{},onChatCommitted=()=>{},onActivity=()=>{},getLanguage=()=> 'zh-CN',random=Math.random,now=Date.now,audit=()=>{}}){
 // Group turns in flight: SPEAKING_GROUP has a member producing a reply right now.
 const SPEAKING_GROUP=['generating','waiting-model','waiting-life-save'],ACTIVE_GROUP=['queued',...SPEAKING_GROUP];
 const spriteMetadata=new Map(),runtime=new Map(),privateBusy=new Set(),groupOperations=new Map(),roleTurns=new AsyncLocalStorage(),syncedCardVersions=new Map();let closing=false,relationTail=Promise.resolve(),lives,memory;
 const call=(action,args={})=>engine.handleAction(action,{...args,sessionId:'whale-companion-local'});
 const legacy=await call('companion-export');
 await store.mutate(state=>{
  for(const row of legacy.characters){if(!state.cards[row.id])state.cards[row.id]={id:row.id,name:row.profile.displayName,builtin:true,sprite:row.sprite,color:row.color,background:row.background,defaultName:row.builtIn?.displayName??row.profile.displayName,defaults:{personality:(row.builtIn??row.profile).persona,tone:(row.builtIn??row.profile).tone,address:(row.builtIn??row.profile).address,greeting:(row.builtIn??row.profile).greeting,visual:(row.builtIn??row.profile).visual},fields:{},examples:[],modelBinding:{enabled:false,connectionId:null},avatar:'',revision:1};
   else if(state.cards[row.id].builtin){const card=state.cards[row.id];if(!card.nameCustomized)card.name=row.profile.displayName;card.sprite=row.sprite;card.color=row.color;card.background=row.background;card.defaultName=row.builtIn?.displayName??card.defaultName;card.defaults={...card.defaults,personality:(row.builtIn??row.profile).persona,tone:(row.builtIn??row.profile).tone,address:(row.builtIn??row.profile).address,greeting:(row.builtIn??row.profile).greeting,visual:(row.builtIn??row.profile).visual};for(const [field,key]of Object.entries({personality:'persona',tone:'tone',address:'address',greeting:'greeting',visual:'visual'}))if(!card.fields[field]&&Object.hasOwn(row.overrides??{},key))card.fields[field]={mode:'custom',value:row.overrides[key]};}
   const migratedCard=state.cards[row.id];if(migratedCard.builtin){for(const [field,key]of Object.entries({personality:'persona',tone:'tone',address:'address',greeting:'greeting',visual:'visual'}))if(!migratedCard.fields[field]&&Object.hasOwn(row.overrides??{},key))migratedCard.fields[field]={mode:'custom',value:row.overrides[key]};if(Object.hasOwn(row.overrides??{},'displayName'))migratedCard.nameCustomized=true;}
   if(!state.relationships[row.id])state.relationships[row.id]={mode:'independent',byPersona:{[DEFAULT_PERSONA_ID]:progress(row)}};
   // Import the last legacy options once; later starts must not revive consumed
   // choices or expose another Persona's options through the character store.
   if(!state.migrated&&(row.personaId??DEFAULT_PERSONA_ID)===DEFAULT_PERSONA_ID&&Array.isArray(row.choices))conversationFor(state,row.id,DEFAULT_PERSONA_ID).choices=copy(row.choices);
   // Each legacy line is imported once. A per-character ledger counts the copies of
   // every line already imported, so a new or archived conversation, or a deleted
   // copy, never brings a line back; lines the engine adds later (greetings,
   // time-away notes) still arrive once.
   if((!state.lifeMigration||state.lives?.[row.id]?.legacyImportEnabled===true)&&row.history?.length){
    const conv=conversationFor(state,row.id,DEFAULT_PERSONA_ID),lineKey=(id,role,text)=>createHash('sha256').update(id?'id:'+id:'line:'+role+'\u0000'+text).digest('hex').slice(0,24);
    const lines=[...row.history.entries()].filter(([,m])=>!m.personaId&&!m.conversationId&&m.text).map(([index,m])=>{const role=m.who==='user'?'user':m.who==='heroine'?'assistant':'narrator';return {index,m,role,key:lineKey(m.id,role,m.text)};});
    state.legacyImports??={};
    if(!state.legacyImports[row.id]){
     // First start with a ledger: copies already in any of the character's
     // conversations, archived ones too, count as imported (at most once per line).
     const present=new Map(),wanted=new Map(),add=(map,k)=>map.set(k,(map.get(k)??0)+1);
     for(const c of Object.values(state.conversations))if(c.characterId===row.id)for(const entry of c.messages){if(entry.id)add(present,lineKey(entry.id));if(entry.legacy)add(present,lineKey(null,entry.role,entry.text));}
     for(const line of lines)add(wanted,line.key);
     state.legacyImports[row.id]=Object.fromEntries([...wanted].map(([k,n])=>[k,Math.min(n,present.get(k)??0)]).filter(([,n])=>n>0));
    }
    const ledger=state.legacyImports[row.id],seen=new Map();
    for(const {index,m,role,key}of lines){const n=(seen.get(key)??0)+1;seen.set(key,n);if(n<=(ledger[key]??0))continue;ledger[key]=n;conv.messages.push({id:m.id||'legacy-'+row.id+'-'+index+'-'+randomUUID(),role,text:m.text,characterId:row.id,personaId:DEFAULT_PERSONA_ID,createdAt:validTime(Number(m.at))?Number(m.at):0,legacy:true,revisions:[],emotion:m.emotion,emotionSource:m.emotionSource});}}}
  migrateCharacterTalkativeness(state,now());
  if(!state.migrated){state.activeCharacterId=legacy.current;state.migrated=true;}
  if(!Object.hasOwn(state.personas,state.defaultPersonaId??''))state.defaultPersonaId=DEFAULT_PERSONA_ID;
  if(!Object.hasOwn(state.personas,state.activePersonaId??''))state.activePersonaId=state.defaultPersonaId;
  if(!state.cards[state.activeCharacterId])state.activeCharacterId=legacy.current;
  if(!state.conversations[state.activeConversationId]||state.conversations[state.activeConversationId].characterId!==state.activeCharacterId||state.conversations[state.activeConversationId].personaId!==state.activePersonaId)state.activeConversationId=conversationFor(state).id;
  // A process restart never resubmits an uncertain model request.
  for(const conversation of Object.values(state.conversations))for(const message of conversation.messages)if(message.status==='pending'){message.status='interrupted';message.error='请求因重启中断；未自动重试';}
  for(const group of Object.values(state.groups)){if(group.pending?.settlement){state.pendingGroupSettlements??={};state.pendingGroupSettlements[group.id]=group.pending.settlement;}if(group.pending){group.lastInterruption={at:now(),reason:'restart'};delete group.pending;}}
  ensureLives(state,now());
 });
 async function syncCard(card){await call('companion-register',{card:{...card,effective:resolveCardImages(media,effectiveCard(card))}});syncedCardVersions.set(card.id,card.revision);}
 for(const card of Object.values(store.state.cards))await syncCard(card);
 for(const pending of Object.values(store.state.pendingInteractions??{})){const token=pending.lifeToken??lifeToken(store.state,pending.characterId);if(store.state.lives[pending.characterId]?.id===token.lifeId&&store.state.lives[pending.characterId]?.operationId===token.operationId){await delta(pending.characterId,pending.personaId,1,'touch:'+pending.eventId,pending.at,token);}else{await store.mutate(state=>{state.interruptedInteractions??={};state.interruptedInteractions[pending.eventId]={characterId:pending.characterId,lifeToken:token,reason:'old-life-not-replayed',at:now()};});}await store.mutate(state=>{delete state.pendingInteractions[pending.eventId];});}
 for(const [id,item] of Object.entries(store.state.pendingPrivateSettlements??{})){const token=item.lifeToken;if(token&&store.state.lives[item.characterId]?.id===token.lifeId&&store.state.lives[item.characterId]?.operationId===token.operationId)await delta(item.characterId,item.personaId,item.amount,item.eventId,item.at,token);await store.mutate(state=>{delete state.pendingPrivateSettlements[id];});}
 for(const [id,item] of Object.entries(store.state.pendingGroupSettlements??{})){const token=item.message.lifeToken??lifeToken(store.state,item.message.characterId),life=store.state.lives[item.message.characterId];if(life?.id===token.lifeId&&life?.operationId===token.operationId)await delta(item.message.characterId,item.message.personaId,item.amount,'group:'+item.message.id,now(),token);else await store.mutate(state=>{state.interruptedGroupSettlements??={};state.interruptedGroupSettlements[id]={messageId:item.message.id,lifeToken:token,at:now(),reason:'old-life-not-replayed'};});await store.mutate(state=>{delete state.pendingGroupSettlements[id];});}
 if(dataRoot)lives=await createCompanionLives({store,dataRoot,imageCodec,imageConverter,media,call,syncCard,projectPersona,enableGrowth,now,audit,onChanged:()=>onCharacter(followCharacter()),quiesce:async characterId=>{if([...privateBusy].some(id=>store.state.conversations[id]?.characterId===characterId))throw Error('请等待此角色当前回复完成，再保存或切换人生');for(const [id,live]of runtime)if(live.queue?.includes(characterId))await stopGroup(id);await store.flush();await relationTail;await absorbProgress();}});
 memory=createCompanionMemory({store,now,autoStart:false,onError:audit,getCapacity:id=>provider.resolveContextCapacity?.(store.state.cards[id]?.modelBinding)??defaultContextCapacity(),runModel:async(id,options)=>{
  if(!provider.enabled)throw Object.assign(Error('联网聊天关闭，记忆整理等待连接开启'),{code:'MEMORY_PROVIDER_DISABLED'});
  const token=lifeToken(store.state,id),card=copy(store.state.cards[id]);lives?.busy(id);
  return runModel(card,async()=>{assertLife(store.state,id,token);const selected=provider.currentSelection?.()??{};let output='';for await(const chunk of provider.stream({...options,provider:selected.provider,model:selected.model,messages:options.messages.map(row=>({...row,content:[{type:'text',text:row.text??row.content??''}]}))})){if(chunk.type==='text-delta')output+=chunk.text??'';if(chunk.type==='finish'&&['error','aborted'].includes(chunk.reason?.kind))throw Error(chunk.reason.failure?.message??'记忆模型请求失败');}assertLife(store.state,id,token);return output;},options.signal,{background:true});
 },onGrowth:(state,id,candidates,batch)=>{lives?.busy(id);return applyGrowthCandidates(state,id,candidates,batch,now());}});
 const memoryTimer=setInterval(()=>{const transaction=store.state.lifeTransaction;if(!closing&&provider.enabled&&(!transaction||transaction.replayFailed))void memory.tick({skip:transaction?.characterId}).then(async()=>{for(const card of Object.values(store.state.cards))if(syncedCardVersions.get(card.id)!==card.revision)await syncCard(card);}).catch(error=>audit({type:'memory-timer-error',message:String(error?.message??error).slice(0,500)}));},60000);memoryTimer.unref?.();
 function context(){return {personaId:store.state.activePersonaId,characterId:store.state.activeCharacterId,conversationId:store.state.activeConversationId};}
 function followCharacter(){return store.state.groups[store.state.activeGroupId]?.entryCharacterId??store.state.activeCharacterId;}
 function resourceInstalled(card){return !card.builtin||!resources||resources.available(card.id)!==false;}
 function missingGroupResources(group){
  const ids=[...new Set(group.memberIds)].filter(id=>store.state.cards[id]?.builtin===true);
  if(!resources||!ids.length)return null;
  try{if(resources.require)resources.require(ids);else{const missing=ids.filter(id=>!resources.available(id));if(missing.length)throw Object.assign(Error('角色资源待安装 / Character resources need installation'),{code:'CHARACTER_NOT_INSTALLED',characterIds:missing});}}
  catch(error){if(error.code!=='CHARACTER_NOT_INSTALLED')throw error;return {ok:false,code:error.code,characterIds:[...new Set(error.characterIds??ids.filter(id=>!resources.available(id)))],error:String(error.message)};}
  return null;
 }
 function groupMessageView(message){const value=copy(message);if(value?.role==='assistant'){const extracted=lenientReplyText(value.text);value.text=groupDialogueText(extracted===null?value.text:extracted||'（回复不完整）',value.characterName??store.state.cards[value.characterId]?.name);}return value;}
 function groupPromptMessage(row){const name=row.characterName??store.state.cards[row.characterId]?.name??row.characterId;return (row.role==='assistant'?name+'：'+groupDialogueText(row.text,name):'用户：'+row.text);}
 function viewState(){
  const state=store.state,conversation=state.conversations[state.activeConversationId],group=state.groups[state.activeGroupId],activeRuntime=group?runtime.get(group.id):null;
  return {revision:state.revision??0,characters:Object.values(state.cards).filter(card=>!card.draft).map(card=>({...copy(card),life:{id:currentLife(state,card.id).id,mode:currentLife(state,card.id).mode,startedAt:currentLife(state,card.id).startedAt},growth:growthView(state,card.id,state.activePersonaId),effective:effectiveCard(card),...spriteMetadata.get(card.id),effectiveConnection:provider.resolveConnection?.(card.modelBinding)??null,resourceInstalled:resourceInstalled(card),needsInstall:!resourceInstalled(card)})),draftCharacters:Object.values(state.draftCards).map(copy),personas:Object.values(state.personas).map(copy),...context(),activePersonaId:state.activePersonaId,defaultPersonaId:state.defaultPersonaId??DEFAULT_PERSONA_ID,activeCharacterId:state.activeCharacterId,activeConversationId:state.activeConversationId,conversations:Object.values(state.conversations).filter(row=>row.lifeId===state.lives[row.characterId]?.id).map(({messages,...row})=>({...copy(row),messageCount:messages.length})).sort((a,b)=>b.updatedAt-a.updatedAt),messages:copy(conversation?.messages??[]),draft:(conversation&&drafts?.get(conversation.id))??conversation?.draft??'',displayMode:state.activeGroupId?'group':'private',groups:Object.values(state.groups).map(({messages,pending,...row})=>({...copy(row),messageCount:messages.length})),activeGroupId:state.activeGroupId,groupMessages:(group?.messages??[]).map(groupMessageView),groupRuntime:group?{status:activeRuntime?.status??'idle',queue:copy(activeRuntime?.queue??[]),currentMessage:groupMessageView(group.messages.at(-1)??null),pendingMessage:groupMessageView(group.pending?.message??null),canRetry:activeRuntime?.status==='failed',canContinue:activeRuntime?.status==='awaiting-continue',error:activeRuntime?.error??null,waitDeadline:activeRuntime?.waitDeadline??null}:null,settings:copy(state.settings),relationship:{mode:state.relationships[state.activeCharacterId]?.mode??'independent',...progress(relationshipFor(copy(state),state.activeCharacterId))},busy:privateBusy.has(state.activeConversationId),lifeRecovery:lives?.recovery()??null};
 }
 async function absorbProgress(){
  const active=context(),blocked=store.state.lifeTransaction?.characterId,rows=(await call('companion-export')).characters,pending=rows.flatMap(row=>row.pendingRelationEvents??[]).filter(row=>row.characterId!==blocked);
  for(const row of rows)spriteMetadata.set(row.id,{hasCustomSprite:row.hasCustomSprite===true,spriteRevision:row.spriteRevision??0});
  const changes=rows.filter(row=>row.id!==blocked&&(row.personaId??'default')===active.personaId&&store.state.cards[row.id]&&JSON.stringify(progress(row))!==JSON.stringify(progress(relationshipFor(copy(store.state),row.id,active.personaId))));
  if(changes.length||pending.length)await store.mutate(state=>{
   for(const event of pending.sort((a,b)=>a.at-b.at)){if(!Object.hasOwn(state.cards,event.characterId)||!Object.hasOwn(state.personas,event.personaId))continue;if(!Object.hasOwn(state.events,event.eventId)){Object.assign(relationshipFor(state,event.characterId,event.personaId),progress(event));state.events[event.eventId]=copy(event);}}
   for(const row of changes)Object.assign(relationshipFor(state,row.id,active.personaId),progress(row));
  });
  if(pending.length)await call('companion-ack-events',{entries:pending.map(event=>({characterId:event.characterId,eventId:event.eventId}))});
 }
 async function decorate(value){const base=value?.current?value:value?.view??await call('view');await absorbProgress();const state=store.state,id=state.activeCharacterId,card=state.cards[id],effective=effectiveCard(card),conversation=state.conversations[state.activeConversationId],relation=progress(relationshipFor(copy(state),id));
  return {...base,current:id,name:card.name,...relation,cap:30+(relation.level-1)*15,characterId:id,characterMode:base.characterMode??'manual',choices:copy(conversation?.choices??[]),history:(conversation?.messages??[]).map(message=>({...message,who:message.role==='assistant'?'heroine':message.role==='user'?'user':'narrator'})),profileCustomized:Object.keys(card.fields??{}).length>0,...(!card.builtin?{sprite:null,moods:null,moodSprites:false,portrait:false,hasCustomSprite:base.hasCustomSprite===true,spriteKind:base.hasCustomSprite?'custom':'none',customCharacter:true,hasCustomBg:base.hasCustomBg===true,backgroundMode:base.backgroundMode,bg:base.backgroundMode==='builtin'?null:base.bg}:{}),companion:viewState()};
 }
 async function reply(extra={}){const view=await decorate();return {ok:true,...extra,companion:view.companion,view};}
 async function projectPersona(personaId){const state=copy(store.state);await call('companion-project',{personaId,relationships:Object.fromEntries(Object.keys(state.cards).map(id=>[id,progress(relationshipFor(state,id,personaId))]))});}
 async function stopGroup(id){if(!id)return;const live=runtime.get(id);live?.controller?.abort();if(live)runtime.set(id,{status:'idle',queue:[],roundId:randomUUID()});await store.mutate(state=>{if(state.groups[id])delete state.groups[id].pending;});}
 async function reconcileGroupQueue(id){
  const live=runtime.get(id),group=store.state.groups[id];if(!live||!group)return;
  const eligible=member=>group.memberIds.includes(member)&&(!group.mutedIds?.includes(member)||member===live.forceCharacterId);
  live.queue=live.queue.filter(eligible);
  const pending=group.pending?.message,discard=pending&&!eligible(pending.characterId);
  if(discard||!live.queue.length){await store.mutate(state=>{const row=state.groups[id];if(!row)return;if(!live.queue.length)delete row.pending;else if(discard&&row.pending?.message?.id===pending.id){row.pending={...row.pending,message:null,queue:copy(live.queue)};}});live.status=live.queue.length?'awaiting-continue':'idle';}
 }

 async function select(characterId,personaId=store.state.activePersonaId,conversationId=null,characterMode='manual'){if(!Object.hasOwn(store.state.cards,characterId)||!Object.hasOwn(store.state.personas,personaId))throw Error('角色或身份不存在');await stopGroup(store.state.activeGroupId);await absorbProgress();const changed=await call('settings-set',{characterMode,characterId});if(changed.ok===false)throw Object.assign(Error(changed.errors?.join('；')??'角色资源待安装'),{code:changed.code,characterIds:changed.characterIds});await store.mutate(state=>{state.activeCharacterId=characterId;state.activePersonaId=personaId;state.activeGroupId=null;delete state.groupReturnContext;state.activeConversationId=conversationId??conversationFor(state,characterId,personaId).id;});await projectPersona(personaId);onCharacter(characterId);}
 async function delta(characterId,personaId,amount,eventId,at=now(),token=lifeToken(store.state,characterId)){
  const task=relationTail.then(async()=>{
  assertLife(store.state,characterId,token);
  if(!Object.hasOwn(store.state.cards,characterId)||!Object.hasOwn(store.state.personas,personaId))throw Error('奖励角色或身份不存在');if(store.state.events[eventId])return copy(store.state.events[eventId]);
  const base=progress(relationshipFor(copy(store.state),characterId,personaId));const result=await call('companion-relationship',{characterId,personaId,base,delta:amount,eventId,at});
  await store.mutate(state=>{assertLife(state,characterId,token);Object.assign(relationshipFor(state,characterId,personaId),progress(result));state.events[eventId]={characterId,personaId,lifeId:token.lifeId,delta:amount,...progress(result),levels:result.levels??[],at};});return copy(store.state.events[eventId]);
  });relationTail=task.catch(()=>{});return task;
 }
 async function touch({characterId,personaId=store.state.activePersonaId,eventId=randomUUID(),at=now()}){
  if(!Object.hasOwn(store.state.cards,characterId)||!Object.hasOwn(store.state.personas,personaId))return {ok:false,reason:'unknown-character-or-persona'};try{lives?.busy(characterId);}catch{return {ok:true,awarded:false,reason:'life-switch-in-progress'};}const token=lifeToken(store.state,characterId);let eligible=false,reason='cooldown';
  await store.mutate(state=>{lives?.busy(characterId);assertLife(state,characterId,token);if(state.events['touch:'+eventId]){reason='duplicate';return;}if(state.pendingInteractions?.[eventId]){eligible=true;return;}const date=new Date(at),day=[date.getFullYear(),date.getMonth()+1,date.getDate()].join('-');const quota=state.touchQuotas[characterId]??={day,count:0,lastAt:null,events:[]};if(quota.events.includes(eventId)){reason='duplicate';return;}if(quota.day!==day){quota.day=day;quota.count=0;}if(quota.count>=30){reason='daily-limit';return;}if(quota.lastAt!==null&&at-quota.lastAt<60000){reason='cooldown';return;}quota.lastAt=at;quota.count++;quota.events.push(eventId);if(quota.events.length>1000)quota.events=quota.events.slice(-1000);state.pendingInteractions??={};state.pendingInteractions[eventId]={eventId,characterId,personaId,at,lifeToken:token};eligible=true;reason='awarded';});
  if(!eligible)return {ok:true,awarded:false,reason};const pending=store.state.pendingInteractions[eventId],result=await delta(pending.characterId,pending.personaId,1,'touch:'+eventId,pending.at,pending.lifeToken??token);await store.mutate(state=>{delete state.pendingInteractions[eventId];});return {ok:true,awarded:true,reason,...result};
 }
 // Room kept for the reply when trimming history: the user's output limit,
 // capped at a quarter of the context window, never below the old floor.
 function replyReserve(card,floor){const capacity=provider.resolveContextCapacity?.(card.modelBinding)?.tokens??8192,setting=provider.outputLimit?.()??8192;return Math.max(floor,Math.min(setting==='auto'?8192:Number(setting)||8192,Math.floor(capacity/4)));}
 async function runModel(card,fn,signal,options={}){if(!provider.enabled)throw Error('当前为离线模式；请先手动开启联网聊天');const route=provider.resolveConnection?.(card.modelBinding);if(route?.error)throw Error(route.error);if(roleTurns.getStore()===card.id)return fn();const run=()=>roleTurns.run(card.id,fn);if(card.modelBinding?.enabled){if(!provider.runProfile)throw Error('当前连接不支持角色专属模型');return provider.runProfile(card.modelBinding.connectionId,run,signal,options);}return provider.runTurn?provider.runTurn(run,signal,options):run();}
 async function chat(args={}){
  if(store.state.activeGroupId)throw Error('当前处于群聊，请使用群聊发送或先退出群聊');
  const captured=context(),conversation=store.state.conversations[captured.conversationId];if(!conversation||privateBusy.has(conversation.id))throw Error('请等待当前会话回复完成');lives?.busy(captured.characterId);const token=lifeToken(store.state,captured.characterId);const body=text(String(args.text??''),200000).trim();if(!body)return decorate();const card=copy(store.state.cards[captured.characterId]),persona=copy(store.state.personas[captured.personaId]),requestId=randomUUID(),at=now();
  const relation=progress(relationshipFor(copy(store.state),captured.characterId,captured.personaId));
  privateBusy.add(conversation.id);try{await store.mutate(state=>{assertLife(state,captured.characterId,token);const row=state.conversations[conversation.id];row.messages.push({id:requestId+':user',requestId,role:'user',text:body,...captured,lifeId:token.lifeId,createdAt:at,revisions:[],status:'pending',cardRevision:card.revision,personaRevision:persona.revision??1,personaSnapshot:personaSnapshot(persona)});row.draft='';row.updatedAt=at;});
  let memoryContext;const result=await runModel(card,async()=>{onActivity({id:requestId,active:true,kind:'chat'});try{
   memoryContext=await memory.context({...captured,query:body,excludeMessageIds:[requestId+':user'],systemTokens:estimateMemoryTokens(JSON.stringify(promptCard(card,persona))+JSON.stringify(promptPersona(persona,card.id)))+1600,reserveTokens:replyReserve(card,1600)});assertLife(store.state,captured.characterId,token);
   return await call('chat',{...args,text:body,companionContext:{...captured,requestId,lifeToken:token,modelText:memoryContext.queryText??body,memoryText:memoryContext.text,choices:copy(conversation.choices??[]),relationship:relation,profile:promptCard(store.state.cards[card.id],persona),persona:promptPersona(persona,card.id),log:memoryContext.messages.map(row=>({id:row.source?.messageId??row.id,revision:row.revision??0,role:row.role,text:row.text+(row.revision>0?'\n[用户更正记录：以上为当前更正版本；旧版本原文保留，不将旧说法当成当前事实。]':'')}))}});
  }finally{onActivity({id:requestId,active:false,kind:'chat'});}});
   const committed=result.companionCommit;if(!committed)throw Error('聊天缺少固定身份提交记录');await store.mutate(state=>{assertLife(state,captured.characterId,token);const row=state.conversations[conversation.id],user=row.messages.find(message=>message.id===requestId+':user');if(user)user.status='sent';row.choices=copy(committed.choices??[]);row.messages.push({id:requestId+':reply',requestId,role:'assistant',text:committed.text,...captured,lifeId:token.lifeId,lifeToken:token,presentation:'pending',pendingAffection:committed.delta??affectionDelta(body),emotion:committed.emotion,emotionSource:committed.emotionSource,createdAt:now(),revisions:[],cardRevision:store.state.cards[card.id].revision,personaRevision:persona.revision??1,personaSnapshot:personaSnapshot(persona),request:{connectionId:committed.connectionId,model:committed.model,cardRevision:store.state.cards[card.id].revision,personaRevision:persona.revision??1,inputUserText:body,inputUserRevision:0,inputMessageIds:(committed.inputVersions??[]).map(row=>row.id),inputVersions:committed.inputVersions??[],memoryEventIds:memoryContext?.inputEventIds,capacity:memoryContext?.capacity}});row.updatedAt=now();});return await decorate(result);
  }catch(error){await store.mutate(state=>{const message=state.conversations[conversation.id]?.messages.find(row=>row.id===requestId+':user');if(message){message.status='failed';message.error=String(error.message);}});throw error;}finally{privateBusy.delete(conversation.id);}
 }
 async function generateGroup(id){
  const live=runtime.get(id);if(!live||live.status!=='queued')return;const group=store.state.groups[id];live.queue=live.queue.filter(member=>group?.memberIds.includes(member)&&(!group.mutedIds?.includes(member)||member===live.forceCharacterId));if(!live.queue.length){live.status='idle';await store.mutate(state=>{if(state.groups[id]?.pending?.roundId===live.roundId)delete state.groups[id].pending;});return;}const captured=copy(store.state.groups[id]),characterId=live.queue[0],card=copy(store.state.cards[characterId]),persona=copy(store.state.personas[captured.personaId]),requestId=randomUUID(),controller=new AbortController();live.controller=controller;live.status='waiting-model';live.error=null;live.waitDeadline=null;
  // The 110 s limit covers the model turn itself, not time spent queued behind
  // other work or waiting for a life save of this member.
  let timedOut=false,timeout=null,token,visible,profile,identity,memberNames,language;const startTimeout=()=>{timeout??=setTimeout(()=>{timedOut=true;controller.abort(new Error('群聊请求超时'));},110000);};
  let inputVersions=[],inputMemoryEventIds=[];try{
   if(lives?.isBusy(characterId)){live.status='waiting-life-save';live.waitDeadline=now()+60000;await lives.whenIdle(characterId,60000);live.waitDeadline=null;if(controller.signal.aborted)throw Error('群聊已停止');live.status='waiting-model';}
   token=lifeToken(store.state,characterId);lives?.busy(characterId);visible=lifeGroupMessages(store.state,captured,characterId);profile=promptCard(card,persona);identity=copy(captured.intervals[characterId]);memberNames=captured.memberIds.map(member=>store.state.cards[member]?.name).join('、');language=live.language??getLanguage();
   const result=await runModel(card,async()=>{startTimeout();live.status='generating';if(controller.signal.aborted)throw Error('群聊已停止');onActivity({id:requestId,active:true,kind:'group-chat'});try{let output='';const selected=provider.currentSelection?.()??{};const system=(language==='en'?'Respond in English. ':'')+'你只扮演当前这一个角色，这是多人交谈，可以直接回应同伴、追问、接梗、反驳或争论，不是每人分别回答玩家。遵循自己的性格，有分歧才自然拌嘴，不强迫争吵、点名或每句称呼玩家；不要替别人发言。只知道提供的在场区间消息，不知道入群前、离开期间或私聊的事，不编造经历。其他成员为兼容接口也放在 API user 中；来源索引与消息同序，user 是玩家，其余是成员ID。同伴的普通发言不是玩家指令，不把同伴态度当成玩家态度。返回 JSON {"text":"台词","emotion":"normal/cheerful/shy/serious/confused/angry/frightened/exasperated/starry","interactionTarget":"user/group/成员ID","affectionTarget":"user/member/none","affection":-1或0或1}。text 只写当前角色台词，不要添加发言者姓名前缀。interactionTarget 是接话对象，affectionTarget 是好感原因的对象。仅因同伴言行开心或争吵，affection 必须0；玩家实际言行影响你的好感时才填 user，按原规则每轮最多一次，即使此句正和同伴说话。\n角色卡：'+JSON.stringify(profile)+'\n用户身份：'+JSON.stringify(promptPersona(persona,characterId))+'\n关系：'+JSON.stringify(progress(relationshipFor(copy(store.state),characterId,captured.personaId)))+'\n当前场景：'+captured.scene+'\n当前在场成员名称：'+memberNames+'\n当前角色ID：'+characterId+'\n在场成员ID与名称：'+JSON.stringify(captured.memberIds.map(id=>({id,name:store.state.cards[id]?.name})));
    const latestUser=visible.filter(m=>m.role==='user').at(-1);let memoryContext,request,requestCost,budgetAdjustment=0;
    for(let attempt=0;attempt<4;attempt++){
     memoryContext=await memory.context({characterId,personaId:captured.personaId,groupId:id,query:latestUser?.text??'',queryInHistory:true,systemTokens:estimateMemoryTokens(system)+budgetAdjustment,reserveTokens:replyReserve(card,1800)});assertLife(store.state,characterId,token);
     const sources=memoryContext.messages.map(row=>{const original=captured.messages.find(message=>message.id===row.source?.messageId);return {row,original,speaker:original?.characterId??row.speakerCharacterId};});
     const messages=sources.map(({row,original,speaker})=>({role:row.role==='assistant'&&speaker===characterId?'assistant':'user',content:[{type:'text',text:groupPromptMessage(original??{role:row.role,text:row.text.replace(/^\[[^\]\n]+\]\s*/,''),characterId:speaker})}],source:{kind:row.role==='assistant'&&speaker===characterId?'model':'user'}}));
     // The positional index distinguishes real player messages from peers using
     // the API user role, without duplicating full provenance UUIDs in the prompt.
     // Full source IDs/revisions remain in the local request receipt below.
     const sourceIndex=sources.map(({row,original,speaker})=>(original?.role??row.role)==='assistant'?speaker??'unknown-member':'user');
     request={provider:selected.provider,model:selected.model,system:system+'\n'+memoryContext.text+'\n消息来源索引（与消息同序）：'+JSON.stringify(sourceIndex),messages,maxTokens:1600,userLimit:true,temperature:.8,purpose:'group-chat'};
     requestCost=estimateMemoryTokens(request);
     if(requestCost+replyReserve(card,1800)<=memoryContext.capacity.tokens)break;
     // Re-budget the actual framing/index instead of truncating witnessed raw
     // history or pretending a fixed +400 covers an arbitrary number of rows.
     budgetAdjustment+=requestCost+replyReserve(card,1800)-memoryContext.capacity.tokens+256;request=null;
    }
    if(!request)throw Object.assign(Error('群聊请求整理后仍超出已知上下文预算；原文保留，请缩短本次角色设定后重试'),{code:'MEMORY_CONTEXT_CAPACITY'});
    inputVersions=memoryContext.messages.map(row=>({id:row.source?.messageId??row.id,revision:row.revision??0}));inputMemoryEventIds=memoryContext.inputEventIds;
    for await(const chunk of provider.stream({...request,signal:controller.signal})){if(controller.signal.aborted)throw Error('群聊已停止');if(chunk.type==='text-delta')output+=chunk.text??'';if(chunk.type==='finish'&&['error','aborted'].includes(chunk.reason?.kind))throw Error(chunk.reason.failure?.message??'群聊生成失败');}
    if(!output.trim())throw Error('群聊没有返回正文');return {...groupEmotionReply(output,card.name,characterId,captured.memberIds),connectionId:selected.provider,model:selected.model,capacity:{...memoryContext.capacity,estimatedInputTokens:requestCost,reserveTokens:replyReserve(card,1800)}};
   }finally{onActivity({id:requestId,active:false,kind:'group-chat'});}},controller.signal);
   if(controller.signal.aborted||runtime.get(id)!==live||closing)return;assertLife(store.state,characterId,token);
   const message={id:requestId,requestId,role:'assistant',characterId,characterName:card.name,personaName:persona.nickname??persona.name,personaId:captured.personaId,text:result.text,emotion:result.emotion,emotionSource:result.emotionSource,...(result.interactionTarget?{interactionTarget:result.interactionTarget}:{}),...(result.affectionTarget?{affectionTarget:result.affectionTarget}:{}),createdAt:now(),status:'pending-presentation',lifeId:token.lifeId,lifeToken:token,cardRevision:card.revision,personaRevision:persona.revision??1,personaSnapshot:personaSnapshot(persona),request:{connectionId:result.connectionId,model:result.model,inputMessageIds:inputVersions.map(row=>row.id),inputVersions,memoryEventIds:inputMemoryEventIds,intervals:identity,capacity:result.capacity}};
   await store.mutate(state=>{if(controller.signal.aborted||runtime.get(id)!==live)throw Error('群聊已停止');state.groups[id].pending={...state.groups[id].pending,message,affection:result.affection};});live.status='awaiting-presentation';

  }catch(error){if(runtime.get(id)===live){const cancelled=controller.signal.aborted&&!timedOut;live.status=cancelled?'idle':'failed';if(cancelled)live.queue=[];live.error=timedOut?'群聊请求超时，请重试当前成员或停止本轮':cancelled?'已停止':String(error.message);await store.mutate(state=>{if(state.groups[id])delete state.groups[id].pending;});}}finally{clearTimeout(timeout);live.controller=null;live.waitDeadline=null;}
 }
 async function presentGroup(id,requestId){
  const live=runtime.get(id),group=store.state.groups[id];if(group?.messages.some(m=>m.id===requestId))return;
  if(!live||live.status!=='awaiting-presentation'||group?.pending?.message?.id!==requestId||store.state.activeGroupId!==id)throw Error('待呈现消息已失效');
  const message=copy(group.pending.message),amount=group.pending.affection;if(message.lifeToken)assertLife(store.state,message.characterId,message.lifeToken);
  if(!group.memberIds.includes(message.characterId)||group.mutedIds?.includes(message.characterId)&&message.characterId!==live.forceCharacterId){await reconcileGroupQueue(id);throw Error('待呈现消息已失效');}
  await store.mutate(state=>{const row=state.groups[id];message.seq=++row.seq;message.status='presented';message.presentedAt=now();row.messages.push(message);row.updatedAt=now();row.pending={...row.pending,message:null,settlement:{message,amount}};});
  await delta(message.characterId,message.personaId,amount,'group:'+requestId);
  await store.mutate(state=>{const row=state.groups[id];delete row.pending;if(live.mode==='pool'){row.poolIndex=(row.poolIndex??0)+1;row.poolLastSpeakerId=message.characterId;}});
  if(runtime.get(id)===live){live.queue=live.queue.filter(id=>id!==message.characterId);live.status=live.queue.length?'awaiting-continue':'idle';}
  onChatCommitted({...groupMessageView(message),messageId:requestId,role:'heroine',group:true});
 }
 function photoScope(id,args={}){
  const group=store.state.groups[id];if(!group)throw Error('群聊不存在');
  if(runtime.get(id)&&runtime.get(id).status!=='idle')throw Error('请先完成或停止当前发言轮次');
  const start=args.range?.start??((group.lastEndedSeq??0)+1),end=args.range?.end??group.seq;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end>group.seq||start>end)throw Error('本次没有新对话可供合影');
  const messages=group.messages.filter(m=>m.seq>=start&&m.seq<=end),cast=[...new Set(messages.filter(m=>m.role==='assistant').map(m=>m.characterId))];
  if(!cast.length)throw Error('本次还没有已呈现的角色回复');
  const selected=args.characterIds??cast;if(!selected.length||selected.some(id=>!cast.includes(id)))throw Error('请选择本次实际参与对话的角色');
  // A set of participants has one identity regardless of checkbox toggle order.
  return {group,range:{start,end},messages,characterIds:cast.filter(id=>selected.includes(id)),allCharacterIds:cast};
 }
 async function groupPhoto(id,args={}){
  const scope=photoScope(id,args),baseEventId=`group:${id}:${scope.range.start}:${scope.range.end}:${scope.characterIds.join(',')}`;
  const requestId=args.regenerate?text(args.clientRequestId||randomUUID(),100):null;
  if(requestId&&!/^[a-zA-Z0-9_-]+$/.test(requestId))throw Error('合影请求编号无效');
  const sourceEventId=requestId?baseEventId+':new:'+requestId:baseEventId;
  const old=scope.group.photos?.find(p=>p.sourceEventId===sourceEventId||(!args.regenerate&&p.range?.start===scope.range.start&&p.range?.end===scope.range.end&&p.characterIds?.length===scope.characterIds.length&&p.characterIds.every(id=>scope.characterIds.includes(id))));if(old)return {...copy(old),reused:true};
  const plannerBinding=validatePhotoPlanner(scope.group,store.state.cards,provider,args.plannerBinding??scope.group.photoPlannerBinding??{enabled:false,connectionId:null},{requireOnline:true});
  if(args.plannerBinding!==undefined)await store.mutate(state=>{state.groups[id].photoPlannerBinding=copy(plannerBinding);});
  const source={groupId:id,groupName:scope.group.name,range:scope.range,characterIds:scope.characterIds,allCharacterIds:scope.allCharacterIds,personaId:scope.group.personaId,persona:promptPersona(store.state.personas[scope.group.personaId],scope.group.entryCharacterId),scene:{kind:scope.group.background?'uploaded':'builtin',description:scope.group.scene||'月夜图书室围桌交流',key:scope.group.sceneTemplate||'library',...(background=>background?.startsWith('data:')?{dataUrl:background}:{})(media?media.resolve(scope.group.background):scope.group.background),purpose:'environment-only',ignoreCharacters:true},messages:copy(scope.messages),cards:scope.characterIds.map(id=>({id,revision:store.state.cards[id].revision,profile:effectiveCard(store.state.cards[id])})),photoPlannerBinding:copy(plannerBinding),themeBinding:copy(plannerBinding.enabled?plannerBinding:store.state.cards[scope.group.entryCharacterId??scope.characterIds[0]]?.modelBinding),sourceEventId};
  const result=await call('group-photo',{source});if(result.ok===false)throw Error(result.error);
  const photo={cgId:result.cgId,sourceEventId,range:scope.range,characterIds:scope.characterIds,at:now()};
  await store.mutate(state=>{(state.groups[id].photos??=[]).push(photo);});return photo;
 }
 function locateMessage(state,args){
  const conversations=args.conversationId?[state.conversations[args.conversationId]].filter(Boolean):Object.values(state.conversations);
  const rows=conversations.flatMap(c=>c.messages.filter(m=>m.id===args.id));
  if(rows.length>1)throw Error('消息 ID 存在歧义，请指定会话 ID');
  return rows[0];
 }
 // A life archive that cannot include some CG images answers with the list (IPC drops
 // custom error fields), so the panel can offer to clean those records up.
 async function lifeArchiveFailure(error){if(error?.code!=='LIFE_ARCHIVE_MISSING_CG')throw error;const view=await decorate();return {ok:false,code:error.code,missing:error.missing,error:String(error.message),companion:view.companion,view};}
 function action(name,args={}){
  // Serialize commands, not model generation. Stop can still abort an active request.
  if(!name.startsWith('companion-group-')||name==='companion-group-export')return dispatch(name,args).catch(lifeArchiveFailure);
  const id=args.id??store.state.activeGroupId??'new';
  const previous=groupOperations.get(id)??Promise.resolve();
  const operation=previous.catch(()=>{}).then(()=>dispatch(name,{...args,...(name!=='companion-group-save'?{id}: {})}));
  groupOperations.set(id,operation);operation.finally(()=>{if(groupOperations.get(id)===operation)groupOperations.delete(id);}).catch(()=>{});return operation;
 }
 const LIFE_RECOVERY_ACTIONS=['companion-life-transaction-retry','companion-life-transaction-rollback','companion-life-transaction-abandon'];
 const UNSCOPED_ACTIONS=new Set(['companion-persona-save','companion-persona-select','companion-settings','companion-title-set','companion-character-select','companion-conversation-list','companion-conversation-select','companion-conversation-export','companion-group-select','companion-group-close','companion-group-stop','companion-group-export']);
 // The character an action works on: explicit ids, the owning conversation or
 // group members, otherwise the active character most actions default to.
 function touchesCharacter(action,args,id){
  if(UNSCOPED_ACTIONS.has(action))return false;
  const state=store.state,targets=[args.characterId,args.forceCharacterId,args.entryCharacterId].filter(Boolean);
  for(const key of ['memberIds','mentionIds','characterIds'])if(Array.isArray(args[key]))targets.push(...args[key]);
  const conversation=state.conversations[args.conversationId??(action.startsWith('companion-conversation-')?args.id:null)];if(conversation)targets.push(conversation.characterId);
  if(action.startsWith('companion-group-')){const group=state.groups[args.id??state.activeGroupId];if(group)targets.push(...(group.memberIds??[]));}
  return targets.length?targets.includes(id):state.activeCharacterId===id;
 }
 async function dispatch(action,args={}){
  const transaction=store.state.lifeTransaction;
  if(transaction&&!['companion-state','companion-memory-view','companion-life-list','companion-life-preview','companion-life-export',...LIFE_RECOVERY_ACTIONS].includes(action)){
   // A switch in progress blocks everything; a failed replay only blocks its own character.
   if(!transaction.replayFailed)throw Error('正在切换人生，请稍后操作');
   if(touchesCharacter(action,args,transaction.characterId))throw Error('该角色的人生切换没有完成，请先选择重试、回到切换前或放弃这次切换');
  }
  const ownedConversation=store.state.conversations[args.conversationId??(action.startsWith('companion-conversation-')?args.id:null)];if(ownedConversation&&['companion-message-edit','companion-message-favorite','companion-conversation-update'].includes(action))lives?.busy(ownedConversation.characterId);
  for(const key of ['id','characterId','personaId','sourcePersonaId','forceCharacterId','entryCharacterId','conversationId','clientRequestId','requestId'])if(args[key]!==undefined&&args[key]!==null)companionId(args[key]);
  for(const key of ['memberIds','mentionIds','mutedIds','characterIds'])if(args[key]!==undefined){if(!Array.isArray(args[key]))throw Error('成员列表格式无效');for(const id of args[key])companionId(id);}
  switch(action){
   case 'companion-state':return reply();
   case 'companion-memory-view':return reply({memory:await memory.view({...args,characterId:args.characterId??store.state.activeCharacterId,personaId:args.personaId??store.state.activePersonaId})});
   case 'companion-memory-retry':{const characterId=args.characterId??store.state.activeCharacterId,personaId=args.personaId??store.state.activePersonaId;await memory.view({characterId,personaId,groupId:args.groupId});const result=await memory.consolidate({characterId,personaId,groupId:args.groupId,day:args.day,...(args.scope==='personal'?{scope:'personal'}:{}),retry:true});await syncCard(store.state.cards[characterId]);return reply({memoryResult:result,memory:await memory.view({characterId,personaId,groupId:args.groupId})});}
   case 'companion-growth-mode':{const id=args.characterId??store.state.activeCharacterId;lives?.busy(id);if(args.mode==='blank'){if(!lives)throw Error('人生存档服务尚未就绪');await lives.reset(id,{mode:'blank'});}else{await store.mutate(state=>enableGrowth(state,id,args.mode,now()));await syncCard(store.state.cards[id]);}break;}
   case 'companion-life-list':return reply({archives:lives?.list(args.characterId??store.state.activeCharacterId)??[]});
   case 'companion-life-save':{await memory.sync(args.characterId??store.state.activeCharacterId);return reply({archive:await lives.save(args.characterId??store.state.activeCharacterId,args)});}
   case 'companion-life-preview':{const preview=lives.preview(args.id),personaId=store.state.activePersonaId,publicGrowth=growthView({...store.state,cards:{...store.state.cards,[preview.characterId]:preview.card},lives:{...store.state.lives,[preview.characterId]:preview.life}},preview.characterId,personaId);preview.conversations=preview.conversations.filter(c=>c.personaId===personaId);preview.groupEvidence=preview.groupEvidence.filter(g=>g.personaId===personaId);preview.life={id:preview.life.id,mode:preview.life.mode,startedAt:preview.life.startedAt,growth:publicGrowth};preview.personas=Object.fromEntries(Object.entries(preview.personas).map(([id,p])=>[id,{id,name:p.name,nickname:p.nickname}]));preview.content={level:preview.content.level,affection:preview.content.affection,cgs:(preview.content.cgs??[]).filter(cg=>!cg.personaId||cg.personaId===personaId).map(cg=>({id:cg.id,status:cg.status,level:cg.level,kind:cg.kind}))};return reply({preview});}
   case 'companion-life-label':await lives.label(args.id,args);break;
   case 'companion-life-clean-missing-cg':{const id=args.characterId??store.state.activeCharacterId;if(!store.state.cards[id])throw Error('角色不存在');lives?.busy(id);const cgIds=(Array.isArray(args.cgIds)?args.cgIds:[]).filter(value=>typeof value==='string'&&value&&value.length<=200).slice(0,10000),result=await call('cg-prune-missing',{characterId:id,cgIds});if(result?.ok===false)throw Error(result.error??'清理缺失 CG 失败');const removed=result.removed??[];if(removed.length)await store.mutate(state=>{const life=state.lives?.[id];if(Array.isArray(life?.selectedCgIds))life.selectedCgIds=life.selectedCgIds.filter(cgId=>!removed.includes(cgId));});audit({type:'life-clean-missing-cg',characterId:id,requested:cgIds.length,removed});return reply({removed});}
   case 'companion-life-transaction-retry':case 'companion-life-transaction-rollback':case 'companion-life-transaction-abandon':{if(!lives)throw Error('人生存档服务尚未就绪');await lives.recover(args.characterId,action.slice('companion-life-transaction-'.length));break;}
   case 'companion-life-reset':{await memory.sync(args.characterId??store.state.activeCharacterId);const id=args.characterId??store.state.activeCharacterId,card=args.card?makeCard({...args.card,id},store.state.cards[id]):null;await lives.reset(id,{mode:args.mode??'normal',...(card?{card}:{})});break;}
   case 'companion-life-restore':await lives.restore(args.id);break;
   case 'companion-life-export':return reply({archive:lives.export(args.id)});
   case 'companion-life-import':return reply({archive:await lives.import(args.base64)});
   case 'companion-private-present':{const row=store.state.conversations[args.conversationId],message=row?.messages.find(m=>m.id===args.id);lives?.busy(row?.characterId);if(!row||!message||message.role!=='assistant'||!['pending','presented'].includes(message.presentation)||['discarded','interrupted'].includes(message.status)||row.id!==store.state.activeConversationId||row.personaId!==store.state.activePersonaId||store.state.activeGroupId)throw Error('待呈现私聊已失效');const token=message.lifeToken??lifeToken(store.state,row.characterId);assertLife(store.state,row.characterId,token);await store.mutate(state=>{assertLife(state,row.characterId,token);const m=state.conversations[row.id].messages.find(m=>m.id===message.id);m.presentation='presented';m.presentedAt??=now();if(!state.events['chat:'+message.requestId]){state.pendingPrivateSettlements??={};state.pendingPrivateSettlements[message.id]={characterId:row.characterId,personaId:row.personaId,amount:message.pendingAffection??0,eventId:'chat:'+message.requestId,at:now(),lifeToken:token};}});await delta(row.characterId,row.personaId,message.pendingAffection??0,'chat:'+message.requestId,now(),token);await store.mutate(state=>{if(state.pendingPrivateSettlements)delete state.pendingPrivateSettlements[message.id];});break;}
   case 'companion-settings':await store.mutate(state=>{if(typeof args.allowUserMessageEdit==='boolean')state.settings.allowUserMessageEdit=args.allowUserMessageEdit;});break;
   case 'companion-title-set':await store.mutate(state=>{const id=companionId(args.characterId??state.activeCharacterId);if(!Object.hasOwn(state.cards,id))throw Error('角色不存在');const title=text(args.title??'',80).trim();state.settings.galgameTitles??={};if(title)state.settings.galgameTitles[id]=title;else delete state.settings.galgameTitles[id];});break;
   case 'companion-character-draft':{let saved;await store.mutate(state=>{const previous=state.cards[args.id]??state.draftCards[args.id];if(previous)lives?.busy(previous.id);assertCardEditAllowed(previous,args,state.lives?.[args.id]);saved=makeCard(args,previous,{draft:true});state.draftCards[saved.id]=saved;});return reply({card:copy(saved)});}
   case 'companion-character-save':{const previous=store.state.cards[args.id]??store.state.draftCards[args.id];if(previous)lives?.busy(previous.id);assertCardEditAllowed(previous,args,store.state.lives?.[args.id]);const saved=makeCard(args,previous);const route=provider.resolveConnection?.(saved.modelBinding);if(saved.modelBinding.enabled&&route?.error)throw Error(route.error);await syncCard(saved);await store.mutate(state=>{assertCardEditAllowed(state.cards[saved.id],args,state.lives?.[saved.id]);state.cards[saved.id]=saved;delete state.draftCards[saved.id];ensureLives(state,now());});if(args.chat||args.select)await select(saved.id);return reply({card:{...copy(saved),effective:effectiveCard(saved)}});}
   case 'companion-character-reset':{const old=store.state.cards[args.id];if(currentLife(store.state,old.id).mode!=='normal')throw Error('成长角色设定只读；请完整归档并重置人生');if(!old?.builtin)throw Error('自建角色没有内置默认设定');const saved={...old,name:old.defaultName??old.name,nameCustomized:false,talkativeness:.5,fields:{},examples:[],revision:old.revision+1};await call('profile-reset',{characterId:old.id});await syncCard(saved);await store.mutate(state=>{state.cards[old.id]=saved;});break;}
   case 'companion-character-select':await select(args.id);break;
   case 'companion-persona-save':{let persona;await store.mutate(state=>{const old=state.personas[args.id],id=old?.id??'persona-'+randomUUID(),name=text(args.name??old?.name??'',80).trim();if(!name)throw Error('身份管理名称必填');persona={...old,id,name,revision:(old?.revision??0)+1,createdAt:old?.createdAt??now(),updatedAt:now()};for(const key of ['nickname','avatar','occupation','identity','background','interests','preferences'])if(args[key]!==undefined)persona[key]=text(args[key],key==='avatar'?26_000_000:20000);if(args.relationships!==undefined){if(!args.relationships||typeof args.relationships!=='object'||Array.isArray(args.relationships))throw Error('专属关系格式无效');persona.relationships={};for(const [id,row]of Object.entries(args.relationships)){companionId(id);if(!Object.hasOwn(state.cards,id))throw Error('专属关系角色不存在');persona.relationships[id]={address:text(row.address??'',300),relationship:text(row.relationship??'',20000)};}}state.personas[id]=persona;if(args.default)state.defaultPersonaId=id;});return reply({persona:copy(persona)});}
   case 'companion-persona-select':await select(store.state.activeCharacterId,args.id);break;
   case 'companion-relationship-mode':{const id=args.characterId??store.state.activeCharacterId;if(!store.state.cards[id])throw Error('角色不存在');if(!['independent','shared'].includes(args.mode))throw Error('关系模式无效');await store.mutate(state=>{const relation=state.relationships[id]??={mode:'independent',byPersona:{}};if(args.mode==='shared'&&!relation.shared){if(!state.personas[args.sourcePersonaId])throw Error('首次共用请选择一份已有身份进度');relation.shared=progress(relation.byPersona[args.sourcePersonaId]);}relation.mode=args.mode;});await call('companion-project',{characterId:id,personaId:store.state.activePersonaId,relationship:progress(relationshipFor(copy(store.state),id))});break;}
   case 'companion-conversation-new':{let conv;await store.mutate(state=>{conv=conversationFor(state,args.characterId??state.activeCharacterId,args.personaId??state.activePersonaId??state.defaultPersonaId,{fresh:true,title:text(args.title??'',300)});});await select(conv.characterId,conv.personaId,conv.id);break;}
   case 'companion-conversation-select':{const row=store.state.conversations[args.id];if(!row||row.lifeId!==currentLife(store.state,row.characterId).id)throw Error('会话不属于当前人生；请从人生存档只读预览或恢复');await select(row.characterId,row.personaId,row.id);break;}
   case 'companion-conversation-update':{
    // Drafts go to their own small file (B4); only the other fields change the store.
    if(args.draft!==undefined&&drafts){if(!store.state.conversations[args.id])throw Error('会话不存在');drafts.set(args.id,text(args.draft,200000));if(args.title===undefined&&typeof args.archived!=='boolean')break;}
    await store.mutate(state=>{const row=state.conversations[args.id];if(!row)throw Error('会话不存在');if(args.title!==undefined)row.title=text(args.title,300);if(typeof args.archived==='boolean')row.archived=args.archived;if(args.draft!==undefined&&!drafts)row.draft=text(args.draft,200000);row.updatedAt=now();});break;}
   case 'companion-conversation-list':{const from=args.from?Date.parse(args.from):null,to=args.to?Date.parse(args.to)+(String(args.to).length===10?86399999:0):null,search=String(args.search??'').toLocaleLowerCase();const rows=Object.values(store.state.conversations).filter(row=>(args.archived===undefined||row.archived===args.archived)&&(!Number.isFinite(from)||row.updatedAt>=from)&&(!Number.isFinite(to)||row.updatedAt<=to)&&(!search||row.title.toLocaleLowerCase().includes(search)||row.messages.some(m=>m.text.toLocaleLowerCase().includes(search)))).map(({messages,...row})=>({...row,messageCount:messages.length}));return reply({conversations:copy(rows)});}
   case 'companion-group-export':
   case 'companion-conversation-export':{const groupId=action==='companion-group-export'?args.id:args.groupId;const data=resolveStateImages(media,{format:'ai-buddy-conversations',version:1,exportedAt:now(),defaultPersonaId:store.state.defaultPersonaId??DEFAULT_PERSONA_ID,personas:copy(store.state.personas),cards:Object.fromEntries(Object.values(store.state.cards).filter(row=>!row.builtin).map(row=>[row.id,copy(row)])),conversations:copy(groupId?[]:args.id?[store.state.conversations[args.id]].filter(Boolean):Object.values(store.state.conversations)),groups:copy(groupId?[store.state.groups[groupId]].filter(Boolean):args.id?[]:Object.values(store.state.groups)).map(({pending,...group})=>group)});if(args.id||groupId){
    if(!data.conversations.length&&!data.groups.length)throw Error('导出会话不存在');
    const personaIds=new Set([...data.conversations,...data.groups].map(row=>row.personaId));
    const characterIds=new Set([...data.conversations.map(row=>row.characterId),...data.groups.flatMap(row=>[...row.memberIds,...Object.keys(row.intervals??{}),...row.messages.map(m=>m.characterId),row.entryCharacterId])]);
    data.personas=Object.fromEntries(Object.entries(data.personas).filter(([id])=>personaIds.has(id)).map(([id,p])=>[id,{...p,relationships:Object.fromEntries(Object.entries(p.relationships??{}).filter(([characterId])=>characterIds.has(characterId)))}]));
    data.cards=Object.fromEntries(Object.entries(data.cards).filter(([id])=>characterIds.has(id)));
    for(const row of [...data.conversations,...data.groups])for(const message of row.messages??[])if(message.personaSnapshot?.relationships)message.personaSnapshot.relationships=Object.fromEntries(Object.entries(message.personaSnapshot.relationships).filter(([id])=>characterIds.has(id)));
    data.defaultPersonaId=[...personaIds][0];
   }
   const ids=[...new Set(data.groups.flatMap(group=>(group.photos??[]).map(photo=>photo.cgId)))];
   data.media=(await call('companion-media-export',{ids,all:!args.id&&!groupId})).media;
   if(Buffer.byteLength(JSON.stringify(data))>50*1024*1024)throw Error('导出文件超过 50 MiB，请分别导出群聊或备份完整数据目录 / Export exceeds 50 MiB');
   return reply({data});}
   case 'companion-conversation-import':{
    const data=copy(typeof args.data==='string'?JSON.parse(args.data):args.data);
    // Reject invalid history and malformed media before writing either store.
    for(const [id,card]of Object.entries(data.cards??{}))if(store.state.cards[id])assertCardEditAllowed(store.state.cards[id],card,store.state.lives[id]);const checked=copy(store.state);restoreCompanionExport(checked,data);ensureLives(checked,now());
    await call('companion-media-validate',{media:data.media,characterIds:Object.keys(checked.cards)});
    for(const card of Object.values(checked.cards))if(!card.builtin)await syncCard(card);
    const restored=await call('companion-media-import',{media:data.media,characterIds:Object.keys(checked.cards)});
    for(const group of data.groups??[])for(const photo of group.photos??[])photo.cgId=restored.idMap[photo.cgId]??photo.cgId;
    await store.mutate(state=>{restoreCompanionExport(state,data);ensureLives(state,now());});break;
   }
   case 'companion-message-edit':await store.mutate(state=>{if(!state.settings.allowUserMessageEdit)throw Error('请先在设置中允许更正自己的消息');const row=locateMessage(state,args);if(!row||row.role!=='user')throw Error('只能更正用户自己的消息');const value=text(args.text,200000);if(row.text===value)return;if(row.originalText===undefined)row.originalText=row.text;row.revisions??=[];row.revisions.push({text:row.text,at:now()});row.text=value;row.editedAt=now();});break;
   case 'companion-message-favorite':await store.mutate(state=>{const row=locateMessage(state,args);if(!row)throw Error('消息不存在');row.favorite=args.value!==undefined?!!args.value:!row.favorite;});break;
   case 'companion-group-camera':{if(!['focus','wide'].includes(args.cameraMode))throw Error('镜头模式无效');await store.mutate(state=>{const group=state.groups[args.id];if(!group)throw Error('群聊不存在');group.cameraMode=args.cameraMode;});break;}
   case 'companion-group-save':{if(args.talkativeness!==undefined)throw Error('健谈程度已移至角色卡，请到管理角色修改');let saved;await store.mutate(state=>{const old=state.groups[args.id],id=old?.id??'group-'+randomUUID();if(old&&runtime.get(id)?.status&&runtime.get(id).status!=='idle'&&args.mode!==undefined&&args.mode!==old.mode)throw Error('请先完成或停止当前轮次，再修改发言方式');if(old&&ACTIVE_GROUP.includes(runtime.get(id)?.status))throw Error('请先停止当前群聊生成');const members=[...new Set(args.memberIds??old?.memberIds??[])];if(!members.length||members.some(id=>!state.cards[id]))throw Error('请选择有效群成员');const personaId=args.personaId??old?.personaId??state.activePersonaId;if(!state.personas[personaId])throw Error('群聊身份不存在');if(old?.messages.length&&personaId!==old.personaId)throw Error('已有记录的群聊不能更换身份，请新建群聊');const mode=args.mode??old?.mode??'natural';if(!['natural','list','manual','pool'].includes(mode))throw Error('群聊模式无效');const planner=args.photoPlannerBinding===undefined?old?.photoPlannerBinding:validatePhotoPlanner(old??{memberIds:members},state.cards,provider,args.photoPlannerBinding);saved={...old,...(planner!==undefined?{photoPlannerBinding:copy(planner)}:{}),id,name:text(args.name??old?.name??'群聊',200),personaId,scene:text(args.scene??old?.scene??'',20000),background:text(args.background??old?.background??'',26_000_000),memberIds:members,stageOrder:[...new Set([...(old?.stageOrder??old?.memberIds??[]),...members])],cameraMode:old?.cameraMode??'focus',sceneTemplate:['library','plain'].includes(args.sceneTemplate)?args.sceneTemplate:old?.sceneTemplate??'library',autoPhoto:typeof args.autoPhoto==='boolean'?args.autoPhoto:old?.autoPhoto===true,mode,mutedIds:(args.mutedIds??old?.mutedIds??[]).filter(id=>members.includes(id)),createdAt:old?.createdAt??now(),updatedAt:now(),messages:old?.messages??[],seq:old?.seq??0,intervals:copy(old?.intervals??{})};for(const id of members){if(!old?.memberIds.includes(id))(saved.intervals[id]??=[]).push({start:saved.seq+1,end:null});}for(const id of old?.memberIds??[])if(!members.includes(id)){const last=saved.intervals[id]?.at(-1);if(last&&last.end===null)last.end=saved.seq;}state.groups[id]=saved;updateLifeIntervals(state,saved);});await reconcileGroupQueue(saved.id);return reply({group:copy(saved)});}
   case 'companion-group-select':{const group=store.state.groups[args.id];if(!group)throw Error('群聊不存在');const missing=missingGroupResources(group);if(missing)return reply(missing);const entry=args.entryCharacterId??store.state.activeCharacterId;if(!store.state.cards[entry])throw Error('入口角色不存在');if(store.state.activeGroupId&&store.state.activeGroupId!==group.id)await stopGroup(store.state.activeGroupId);await absorbProgress();const returnContext=store.state.groupReturnContext??{...context(),characterMode:(await call('view')).characterMode??'manual'};const changed=await call('settings-set',{characterMode:'manual',characterId:entry});if(changed.ok===false)throw Error(changed.errors?.join('；')??'角色资源待安装');await store.mutate(state=>{if(!state.activeGroupId)state.groupReturnContext=returnContext;state.activeGroupId=group.id;state.groups[group.id].entryCharacterId=entry;state.activePersonaId=group.personaId;});await projectPersona(group.personaId);onCharacter(entry);break;}
   case 'companion-group-close':{const returnMode=store.state.groupReturnContext?.characterMode??'manual';const id=store.state.activeGroupId;await stopGroup(id);await absorbProgress();await store.mutate(state=>{state.activeGroupId=null;if(state.groupReturnContext){state.activePersonaId=state.groupReturnContext.personaId;state.activeConversationId=state.groupReturnContext.conversationId;state.activeCharacterId=state.groupReturnContext.characterId;delete state.groupReturnContext;}});const current=context();await call('settings-set',{characterMode:returnMode,characterId:current.characterId});await projectPersona(current.personaId);onCharacter(store.state.activeCharacterId);break;}
   case 'companion-group-member':{const id=args.id??store.state.activeGroupId,live=runtime.get(id);if(SPEAKING_GROUP.includes(live?.status)&&live.queue[0]===args.characterId&&['leave','mute'].includes(args.op))throw Error('请先停止当前正在发言的成员');await store.mutate(state=>{const group=state.groups[id],member=args.characterId;if(!group||!state.cards[member])throw Error('群或角色不存在');if(args.op==='join'){if(!group.memberIds.includes(member)){group.memberIds.push(member);group.stageOrder=[...new Set([...(group.stageOrder??group.memberIds),member])];(group.intervals[member]??=[]).push({start:group.seq+1,end:null});}}else if(args.op==='leave'){group.memberIds=group.memberIds.filter(v=>v!==member);const interval=group.intervals[member]?.at(-1);if(interval?.end===null)interval.end=group.seq;}else if(args.op==='mute'){if(!group.mutedIds.includes(member))group.mutedIds.push(member);}else if(args.op==='unmute')group.mutedIds=group.mutedIds.filter(v=>v!==member);else throw Error('成员操作无效');updateLifeIntervals(state,group);});await reconcileGroupQueue(id);break;}
   case 'companion-group-send':{if(!provider.enabled)throw Error('当前为离线模式；请先手动开启联网聊天');const id=args.id??store.state.activeGroupId,group=store.state.groups[id];if(!group)throw Error('群聊不存在');const missing=missingGroupResources(group);if(missing)return reply(missing);const clientRequestId=args.clientRequestId??randomUUID();if(group.submissions?.[clientRequestId])return reply();if(runtime.get(id)?.status&&runtime.get(id).status!=='idle')throw Error('请先继续或停止当前轮次');const body=text(args.text??'',200000).trim();if(!body&&!args.forceCharacterId)throw Error('请输入消息或指定发言成员');const members=group.memberIds.map(id=>store.state.cards[id]);const mentionIds=[...new Set([...(Array.isArray(args.mentionIds)?args.mentionIds:[]),...resolveMentionIds(body,members,args.mentionBindings)])].filter(id=>group.memberIds.includes(id));const queue=groupSpeakers(group,{cards:store.state.cards,mentionIds,forceCharacterId:args.forceCharacterId,random});if(!queue.length)throw Error(group.mode==='manual'?'请先输入 @ 并选择至少一位在场且未静音的成员。':'当前没有可发言的成员，请先加入成员或取消静音。');const roundId=randomUUID(),live={status:'queued',queue,error:null,roundId,mode:group.mode,forceCharacterId:args.forceCharacterId,language:getLanguage()};runtime.set(id,live);try{await store.mutate(state=>{const row=state.groups[id];if(body)row.messages.push({id:randomUUID(),seq:++row.seq,role:'user',personaId:row.personaId,personaName:state.personas[row.personaId].nickname||state.personas[row.personaId].name,personaRevision:state.personas[row.personaId].revision??1,personaSnapshot:personaSnapshot(state.personas[row.personaId]),text:body,mentionIds:copy(mentionIds),createdAt:now()});row.submissions??={};row.submissions[clientRequestId]={roundId,at:now()};row.pending={queue:copy(queue),at:now(),roundId};});}catch(error){if(runtime.get(id)===live)runtime.delete(id);throw error;}if(queue.length)void generateGroup(id).catch(error=>audit({type:'group-generate-error',groupId:id,message:String(error?.message??error)}));else{live.status='idle';await store.mutate(state=>{delete state.groups[id].pending;});}break;}
   case 'companion-group-photo-preview':{const scope=photoScope(args.id??store.state.activeGroupId,args);return reply({photo:{range:scope.range,characterIds:scope.characterIds,messageCount:scope.messages.length,planner:groupPhotoPlanner(scope.group,store.state.cards,provider)}});}
   case 'companion-group-photo-planner':{const id=args.id??store.state.activeGroupId,group=store.state.groups[id];if(!group)throw Error('群聊不存在');const binding=validatePhotoPlanner(group,store.state.cards,provider,args.binding);await store.mutate(state=>{state.groups[id].photoPlannerBinding=copy(binding);});return reply({photoPlanner:groupPhotoPlanner(store.state.groups[id],store.state.cards,provider)});}
   case 'companion-group-photo':{return reply({photo:await groupPhoto(args.id??store.state.activeGroupId,args)});}
   case 'companion-group-end':{const id=args.id??store.state.activeGroupId,group=store.state.groups[id];if(runtime.get(id)&&runtime.get(id).status!=='idle')throw Error('请先完成或停止当前发言轮次');if(group.autoPhoto&&group.messages.some(m=>m.role==='assistant'&&m.seq>(group.lastEndedSeq??0)))await groupPhoto(id);await store.mutate(state=>{state.groups[id].lastEndedSeq=state.groups[id].seq;});break;}
   case 'companion-group-present':{await presentGroup(args.id??store.state.activeGroupId,args.requestId);break;}
   case 'companion-group-retry':{const id=args.id??store.state.activeGroupId,live=runtime.get(id);if(live?.status==='failed'){live.status='queued';void generateGroup(id).catch(error=>audit({type:'group-generate-error',groupId:id,message:String(error?.message??error)}));}break;}
   case 'companion-group-continue':{const id=args.id??store.state.activeGroupId,live=runtime.get(id);if(live?.status==='awaiting-continue'&&live.queue.length){live.status='queued';void generateGroup(id).catch(error=>audit({type:'group-generate-error',groupId:id,message:String(error?.message??error)}));}break;}
   case 'companion-group-stop':{await stopGroup(args.id??store.state.activeGroupId);break;}
   default:throw Error('未知角色管理操作：'+action);
  }
  return reply();
 }
 const maintenance=createMaintenance({store,dataRoot,audit,now,
  isBusy:()=>privateBusy.size>0||[...runtime.values()].some(live=>ACTIVE_GROUP.includes(live.status))||!!store.state.lifeTransaction||Object.keys(store.state.cards).some(id=>lives?.isBusy(id)),
  tasks:{...(media?mediaMaintenanceTasks({media,drafts}):{}),'legacy-dedupe':{plan:planLegacyDedupe,apply:applyLegacyDedupe,summary:({task,planId,total,characters,removals})=>({task,planId,total,characters,conversations:removals.map(row=>({conversationId:row.conversationId,characterId:row.characterId,count:row.messages.length}))})}}});
 return {action,chat,touch,decorate,context,followCharacter,viewState,maintenance,progress:(characterId,personaId)=>progress(relationshipFor(copy(store.state),characterId,personaId)),hasCharacter:id=>typeof id==='string'&&Object.hasOwn(store.state.cards,id)&&!store.state.cards[id].draft,history(characterId,personaId){return lifeConversations(store.state,characterId,personaId).flatMap(row=>row.messages).sort((a,b)=>a.createdAt-b.createdAt);},async reflectLegacy(action,args,result){
  if(action==='settings-set'&&result?.ok!==false&&(args.characterId||args.settings?.characterId)){const id=args.characterId??args.settings.characterId;if(store.state.cards[id])await select(id,store.state.activePersonaId,null,result.characterMode??args.characterMode??args.settings?.characterMode??'manual');}
  if(action==='view'&&result.characterMode==='follow'&&store.state.cards[result.current]&&store.state.activeCharacterId!==result.current)await store.mutate(state=>{state.activeCharacterId=result.current;state.activeConversationId=conversationFor(state).id;});
  if(action==='profile-set'||action==='profile-reset'){const id=args.characterId??store.state.activeCharacterId;await store.mutate(state=>{const card=state.cards[id];if(!card)return;if(action==='profile-reset'){card.fields={};card.name=card.defaultName??card.name;card.nameCustomized=false;}else for(const [legacy,value]of Object.entries(args.overrides??{})){if(legacy==='displayName'){if(value)card.name=value;continue;}const field=({persona:'personality',tone:'tone',address:'address',greeting:'greeting',visual:'visual'})[legacy];if(field)card.fields[field]=value?{mode:'custom',value}:{mode:'inherit'};}card.revision++;});await syncCard(store.state.cards[id]);}
  return result;
 },assertLife:(id,token)=>assertLife(store.state,id,token),guardProfile(action,args){const id=args.characterId??args.charId??store.state.activeCharacterId;if((action==='reset'&&Object.values(store.state.lives).some(l=>l.mode!=='normal'))||(currentLife(store.state,id).mode!=='normal'&&['profile-set','profile-reset'].includes(action)))throw Error('成长角色设定只读；请完整归档并重置人生');},close(){closing=true;drafts?.flush();clearInterval(memoryTimer);void memory?.close();for(const live of runtime.values())live.controller?.abort();}};
}
