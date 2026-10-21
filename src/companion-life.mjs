import {randomUUID} from 'node:crypto';

const clone=value=>structuredClone(value);
export function currentLife(state,characterId){const life=state.lives?.[characterId];if(!life)throw Error('角色人生尚未初始化');return life;}
export function lifeToken(state,characterId){const life=currentLife(state,characterId);return {lifeId:life.id,operationId:life.operationId};}
export function assertLife(state,characterId,token){const life=currentLife(state,characterId);if(!token||token.lifeId!==life.id||token.operationId!==life.operationId)throw Error('此请求属于旧人生，未写入当前状态');return life;}
export function makeLife(card,{at=Date.now(),mode='normal',id='life-'+randomUUID(),groupIntervals={}}={}){
 if(!['normal','seed','blank'].includes(mode))throw Error('人生模式无效');
 return {id,operationId:randomUUID(),startedAt:at,mode,seedCard:clone(card),groupIntervals:clone(groupIntervals),memory:{},growth:{},personalEvents:[]};
}
export function ensureLives(state,at=Date.now()){
 state.lives??={};state.lifeArchives??={};state.memorySettings??={timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'};
 // Persist the actual IANA timezone; DST and clock changes never rename a day.
 new Intl.DateTimeFormat('en-CA',{timeZone:state.memorySettings.timeZone}).format(at);
 let count=0;
 for(const card of Object.values(state.cards))if(!state.lives[card.id]){state.lives[card.id]={...makeLife(card,{at,groupIntervals:Object.fromEntries(Object.values(state.groups).filter(g=>g.intervals?.[card.id]).map(g=>[g.id,clone(g.intervals[card.id])]))}),legacyImportEnabled:true};count++;}
 for(const group of Object.values(state.groups))for(const [id,intervals]of Object.entries(group.intervals??{}))if(state.lives[id]&&!Object.hasOwn(state.lives[id].groupIntervals,group.id))state.lives[id].groupIntervals[group.id]=clone(intervals);
 for(const conversation of Object.values(state.conversations)){
  const life=state.lives[conversation.characterId];if(!life)continue;
  if(!conversation.lifeId)conversation.lifeId=life.id;
  for(const message of conversation.messages??[]){message.lifeId??=conversation.lifeId;
   if(!Number(message.createdAt)){
    message.recordedAt??=life.startedAt;message.dateBasis??='migration-undated';
    const card=state.cards[conversation.characterId],field=card.fields?.greeting,greeting=field?.mode==='empty'?'':field?.mode==='custom'?field.value:card.defaults?.greeting;
    if(message.legacy&&message.role==='assistant'&&greeting&&message.text===greeting)message.bootstrapGreeting=true;
   }
   // Old committed lines were already shown by the previous application.
   if(message.role==='assistant'&&!message.presentation&& !['pending','failed','interrupted'].includes(message.status))message.presentation='presented';
  }
 }
 if(!state.lifeMigration)state.lifeMigration={version:1,at,characters:count,originalSchema:state.schema,timezone:state.memorySettings.timeZone};
 return state;
}
export function updateLifeIntervals(state,group){
 for(const id of Object.keys(group.intervals??{})){const life=state.lives?.[id];if(life)life.groupIntervals[group.id]=clone(group.intervals[id]);}
}
export function lifeConversations(state,characterId,personaId){const life=currentLife(state,characterId);return Object.values(state.conversations).filter(row=>row.characterId===characterId&&row.lifeId===life.id&&(!personaId||row.personaId===personaId));}
export function lifeGroupMessages(state,group,characterId){
 const known=currentLife(state,characterId).groupIntervals[group.id]??[];
 return group.messages.filter(message=>known.some(row=>message.seq>=row.start&&(row.end===null||message.seq<=row.end)));
}
export function resetGroupKnowledge(state,characterId,restoredIntervals=null){
 const life=currentLife(state,characterId);life.groupIntervals={};
 for(const group of Object.values(state.groups)){
  const saved=(restoredIntervals?.[group.id]??[]).map(row=>({...row,end:row.end===null?Math.min(group.seq,Math.max(0,row.snapshotEnd??group.seq)):row.end}));
  if(group.memberIds.includes(characterId))saved.push({start:group.seq+1,end:null});
  group.intervals[characterId]=saved;life.groupIntervals[group.id]=clone(saved);
 }
}
