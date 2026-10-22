import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createSnapshotStorage,readJson} from './storage.mjs';
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
const copy=value=>structuredClone(value);
const text=(value,limit=20000)=>{if(typeof value!=='string')throw Error('文本字段格式无效');if([...value].length>limit)throw Error(`文本超过 ${limit} 字符；原文未截断`);return value.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');};
export const progress=(value={})=>({level:Math.max(1,Math.floor(Number(value.level)||1)),affection:Math.max(0,Number(value.affection)||0)});
export const cap=level=>30+(Math.max(1,level)-1)*15;
export function advanceProgress(value,delta){const next=progress(value);next.affection=Math.max(0,next.affection+delta);const levels=[];while(next.affection>=cap(next.level)){next.affection-=cap(next.level);next.level++;levels.push(next.level);}return {...next,levels};}
function initial(){return {schema:1,migrated:false,activeCharacterId:'deepseek',activePersonaId:DEFAULT_PERSONA_ID,activeConversationId:null,activeGroupId:null,cards:{},personas:{[DEFAULT_PERSONA_ID]:{id:DEFAULT_PERSONA_ID,name:'默认身份',nickname:'你',createdAt:Date.now(),relationships:{}}},relationships:{},conversations:{},groups:{},touchQuotas:{},events:{},draftCards:{},settings:{allowUserMessageEdit:false}};}
export async function openCompanionStore(dataRoot,{media=null}={}){
 const disk=createSnapshotStorage(join(dataRoot,'galgame','companion.json'));let state=await readJson(disk,null);if(!state)state=initial();if(state.schema!==1)throw Error('不支持的角色／身份存档版本');
 // One serialization per change (B4): the body is compared without the revision,
 // which is then written first.
 const body=value=>{const {revision,...rest}=value;return JSON.stringify(rest);};
 let tail=Promise.resolve(),current=body(state);
 // A picture newly set as a data URL is stored as a media file and replaced by its
 // URL. Pictures already in the state stay until the T2 migration moves them.
 function storeImages(next){
  if(!media)return;const before=new Map();for(const [holder,key,path]of imageSlots(state))before.set(path,holder[key]);
  for(const [holder,key,path]of imageSlots(next)){const value=holder[key];if(typeof value!=='string'||!value.startsWith('data:image/')||before.get(path)===value)continue;const url=media.put(value);if(url)holder[key]=url;}
 }
 const api={get state(){return state;},async mutate(fn,{storeImages:convert=true}={}){const task=tail.then(async()=>{const next=copy(state);const result=await fn(next);if(convert)storeImages(next);const text=body(next);if(text===current)return result;next.revision=(Number(state.revision)||0)+1;await disk.writeText('{"revision":'+next.revision+(text==='{}'?'}':','+text.slice(1)));state=next;current=text;return result;});tail=task.catch(()=>{});return task;},async flush(){await tail;},snapshot:()=>copy(state)};
 return api;
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
export function relationshipFor(state,characterId,personaId=state.activePersonaId){const entry=state.relationships[characterId]??={mode:'independent',byPersona:{}};if(entry.mode==='shared')return entry.shared??={level:1,affection:0};return entry.byPersona[personaId]??={level:1,affection:0};}
export function conversationFor(state,characterId=state.activeCharacterId,personaId=state.activePersonaId,{fresh=false,title=''}={}){
 if(!Object.hasOwn(state.cards,characterId)||!Object.hasOwn(state.personas,personaId))throw Error('角色或身份不存在');const lifeId=state.lives?.[characterId]?.id;let row=!fresh&&Object.values(state.conversations).filter(row=>row.characterId===characterId&&row.personaId===personaId&&(!lifeId||row.lifeId===lifeId)&&!row.archived).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
 if(!row){const at=Date.now();row={id:'conversation-'+randomUUID(),characterId,personaId,...(lifeId?{lifeId}:{}),title:title||state.cards[characterId].name,createdAt:at,updatedAt:at,archived:false,draft:'',messages:[]};state.conversations[row.id]=row;}
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
  const owner={characterId,personaId,conversationId:id},messages=raw.messages.map(row=>({...safeMessage(row,owner),conversationId:id}));if(new Set(messages.map(row=>row.id)).size!==messages.length)throw Error('会话消息身份重复');
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
  if(new Set(messages.map(row=>row.id)).size!==messages.length)throw Error('群消息身份重复');if(Object.hasOwn(state.groups,id)){if(JSON.stringify(state.groups[id])===JSON.stringify(raw))continue;id='import-'+randomUUID();}
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
