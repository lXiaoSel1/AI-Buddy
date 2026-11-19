import {copyCompanionValue} from './companion-draft.mjs';
import {randomUUID} from 'node:crypto';

const clone=value=>copyCompanionValue(value);
export function currentLife(state,characterId){const life=state.lives?.[characterId];if(!life)throw Error('角色人生尚未初始化');return life;}
export function lifeToken(state,characterId){const life=currentLife(state,characterId);return {lifeId:life.id,operationId:life.operationId};}
export function assertLife(state,characterId,token){const life=currentLife(state,characterId);if(!token||token.lifeId!==life.id||token.operationId!==life.operationId)throw Error('此请求属于旧人生，未写入当前状态');return life;}
export function makeLife(card,{at=Date.now(),mode='normal',id='life-'+randomUUID(),groupIntervals={}}={}){
 if(!['normal','seed','blank'].includes(mode))throw Error('人生模式无效');
 return {id,operationId:randomUUID(),startedAt:at,mode,seedCard:clone(card),groupIntervals:clone(groupIntervals),memory:{},growth:{},personalEvents:[]};
}
export function ensureLives(state,at=Date.now(),tx){
 state.lives??={};state.lifeArchives??={};state.memorySettings??={timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'};
 // Persist the actual IANA timezone; DST and clock changes never rename a day.
 new Intl.DateTimeFormat('en-CA',{timeZone:state.memorySettings.timeZone}).format(at);
 let count=0;
 for(const card of Object.values(state.cards))if(!state.lives[card.id]){
  state.lives[card.id]={...makeLife(card,{at}),legacyImportEnabled:true};count++;
 }
 for(const group of Object.values(state.groups)){
  const members=tx?.records?new Set([...Object.keys(group.intervals??{}),...group.memberIds??[],...group.stageOrder??[]]):Object.keys(group.intervals??{});
  for(const id of members){
   if(!state.lives[id]||knownGroupIntervals(state,id,group.id,tx)!==undefined)continue;
   const intervals=groupMembershipIntervals(group,id,tx);
   if(intervals!==undefined)saveKnownGroupIntervals(state,id,group.id,intervals,tx);
  }
 }
 for(const conversation of Object.values(state.conversations)){
  const life=state.lives[conversation.characterId];if(!life)continue;
  if(!conversation.lifeId)conversation.lifeId=life.id;
  for(const message of conversation.messages??[])normalizeLegacyPrivateMessage(message,conversation,life,state.cards[conversation.characterId]);
 }
 if(!state.lifeMigration)state.lifeMigration={version:1,at,characters:count,originalSchema:state.schema,timezone:state.memorySettings.timeZone};
 return state;
}
export function normalizeLegacyPrivateMessage(message,conversation,life,card){
 message.lifeId??=conversation.lifeId;
 if(!Number(message.createdAt)){
  message.recordedAt??=life.startedAt;message.dateBasis??='migration-undated';
  const field=card.fields?.greeting,greeting=field?.mode==='empty'?'':field?.mode==='custom'?field.value:card.defaults?.greeting;
  if(message.legacy&&message.role==='assistant'&&greeting&&message.text===greeting)message.bootstrapGreeting=true;
 }
 // Old committed lines were already shown by the previous application.
 if(message.role==='assistant'&&!message.presentation&&!['pending','failed','interrupted'].includes(message.status))message.presentation='presented';
}
export function groupMembershipIntervals(group,characterId,tx){
 return tx?.records?.values('group.intervals',JSON.stringify([group.id,characterId]))??group.intervals?.[characterId];
}
export function knownGroupIntervals(state,characterId,groupId,tx){
 return tx?.records?.get('life.groupIntervals',characterId,groupId)??state.lives[characterId]?.groupIntervals?.[groupId];
}
function saveKnownGroupIntervals(state,characterId,groupId,rows,tx){
 if(tx?.records){
  tx.records.put('life.groupIntervals',characterId,groupId,rows,{at:['lives',characterId,'groupIntervals']});
  if(state.lives[characterId].groupIntervals)delete state.lives[characterId].groupIntervals;
 }else (state.lives[characterId].groupIntervals??={})[groupId]=clone(rows);
}
export function saveGroupMembershipIntervals(state,group,characterId,rows,tx){
 if(tx?.records){
  const owner=JSON.stringify([group.id,characterId]),namespace='group.intervals';
  group.intervals??={};
  delete group.intervals[characterId];
  tx.records.clear(namespace,owner);
  const descriptor={array:true,at:['groups',group.id,'intervals',characterId]};
  tx.records.define(namespace,owner,descriptor);
  for(const [index,row] of rows.entries())tx.records.put(namespace,owner,String(index),row,descriptor);
 }else (group.intervals??={})[characterId]=clone(rows);
 if(state.lives?.[characterId])saveKnownGroupIntervals(state,characterId,group.id,rows,tx);
}
export function lifeConversations(state,characterId,personaId){const life=currentLife(state,characterId);return Object.values(state.conversations).filter(row=>row.characterId===characterId&&row.lifeId===life.id&&(!personaId||row.personaId===personaId));}
export function lifeGroupMessages(state,group,characterId){
 const known=knownGroupIntervals(state,characterId,group.id)??[];
 return group.messages.filter(message=>known.some(row=>message.seq>=row.start&&(row.end===null||message.seq<=row.end)));
}
export function resetGroupKnowledge(state,characterId,restoredIntervals=null,tx){
 const life=currentLife(state,characterId);life.groupIntervals={};
 if(tx?.records)tx.records.clear('life.groupIntervals',characterId);
 for(const group of Object.values(state.groups)){
  const saved=(restoredIntervals?.[group.id]??[]).map(row=>({...row,end:row.end===null?Math.min(group.seq,Math.max(0,row.snapshotEnd??group.seq)):row.end}));
  if(group.memberIds.includes(characterId))saved.push({start:group.seq+1,end:null});
  saveGroupMembershipIntervals(state,group,characterId,saved,tx);
 }
}
