import {randomUUID} from 'node:crypto';
import {assertSocialScope,socialError} from './companion-presentation-state.mjs';
import {socialSettings} from './companion-proactive.mjs';
import {attentionAvailability} from './companion-attention.mjs';

const copy=value=>structuredClone(value),sameMembers=(a,b)=>a.length===b.length&&a.every((id,index)=>id===b[index]);
export function createAutoService({store,now=()=>Date.now(),dispatchTurn,cancelTurn=async()=>{},getRuntimeState=()=>({})}={}){
 const flights=new Map();
 function groupOf(state,id){const group=state.groups?.[id];if(!group)throw socialError('AUTO_GROUP_INVALID','群聊不存在');return group;}
 function autoOf(state,id){const group=groupOf(state,id);if(!group.auto)throw socialError('AUTO_NOT_STARTED','Auto尚未启动');return {group,auto:group.auto};}
 function retire(auto,reason,status){const pending=auto.pending;if(!pending)return null;auto.retiredRequests??={};auto.retiredRequests[pending.requestId]={...copy(pending),previousStatus:pending.status,status:status??(pending.status==='unknown'?'unknown':'cancelled'),reason,retiredAt:now()};auto.pending=null;return copy(auto.retiredRequests[pending.requestId]);}
 // This decision runs synchronously inside the store queue, before any archive
 // copy. A skipped wait leaves the state untouched; transitions still mutate.
 function nextDecision(state,groupId){
  const {group,auto}=autoOf(state,groupId);assertSocialScope(state,auto.scope);
  if(auto.status!=='active')return {skipped:auto.status};
  if(!socialSettings(state).auto)return {change:'disabled'};
  if(!sameMembers(group.memberIds,auto.groupMemberSnapshot))return {change:'members-changed'};
  if(auto.pending)return {skipped:'pending',requestId:auto.pending.requestId};
  if(attentionAvailability(state,now()).doNotDisturb)return {change:'do-not-disturb'};
  const runtime=getRuntimeState({groupId,scope:{...auto.scope}})??{};
  if(runtime.typing||runtime.presenting||runtime.audioPlaying||runtime.waitingForReply||runtime.awaitingUserAnswer||runtime.canPresent===false)return {skipped:'presentation-barrier'};
  return {change:'reserve'};
 }
 const api={
  async start({groupId,mode='rounds',rounds=6,memberIds,scope,authorizationId}={}){
   if(!['rounds','until-stopped','ai-end'].includes(mode)||mode==='rounds'&&(!Number.isSafeInteger(rounds)||rounds<1||rounds>100000)||typeof authorizationId!=='string'||!authorizationId)throw socialError('AUTO_AUTHORIZATION_REQUIRED','请选择有效的Auto模式并确认本次启动');
   return store.mutate(state=>{assertSocialScope(state,scope);if(!socialSettings(state).auto)throw socialError('AUTO_DISABLED','请先开启Auto');const group=groupOf(state,groupId);group.autoAuthorizations??={};if(group.autoAuthorizations[authorizationId]){if(group.auto?.authorizationId===authorizationId)return {...copy(group.auto),duplicate:true};throw socialError('AUTO_AUTHORIZATION_REUSED','此Auto启动授权已经使用');}if(group.auto&&['active','paused'].includes(group.auto.status))throw socialError('AUTO_ALREADY_RUNNING','请先结束现有Auto');const members=memberIds??group.memberIds;if(!Array.isArray(members)||!members.length||new Set(members).size!==members.length||members.some(id=>!group.memberIds.includes(id)))throw socialError('AUTO_MEMBERS_INVALID','请选择有效的当前成员');
    if(group.auto){if(group.auto.pending)retire(group.auto,'superseded-by-new-explicit-authorization','unknown');group.autoHistory??=[];if(!group.autoHistory.some(row=>row.id===group.auto.id))group.autoHistory.push(copy(group.auto));}
    group.auto={schemaVersion:1,id:'auto-'+randomUUID(),authorizationId,scope:copy(scope),mode,roundLimit:mode==='rounds'?rounds:null,members:[...members],groupMemberSnapshot:[...group.memberIds],roundIndex:0,opportunityIndex:0,completed:{},status:'active',generation:(group.auto?.generation??0)+1,createdAt:now(),pending:null};group.autoAuthorizations[authorizationId]={id:group.auto.id,at:now()};return copy(group.auto);});
  },
  async next({groupId}={}){
   if(flights.has(groupId))return flights.get(groupId);
   const task=(async()=>{let reservation,cancellation,decision;
    await store.mutate(state=>{const {group,auto}=autoOf(state,groupId),current=decision??nextDecision(state,groupId);if(current.skipped){reservation=current;return;}if(current.change==='disabled'){auto.status='paused';auto.pauseReason='disabled';reservation={skipped:'disabled'};return;}if(current.change==='members-changed'){cancellation=retire(auto,'members-changed');auto.status='ended';auto.endedReason='members-changed';auto.endedAt=now();auto.generation++;reservation={skipped:'members-changed'};return;}
     if(current.change==='do-not-disturb'){auto.status='paused';auto.pauseReason='do-not-disturb';reservation={skipped:'do-not-disturb'};return;}
     const characterId=auto.members[auto.opportunityIndex],life=state.lives?.[characterId];if(!life)throw socialError('AUTO_MEMBERS_INVALID','成员人生不可用');
     const requestId='auto-turn-'+randomUUID();auto.pending={requestId,characterId,lifeId:life.id,operationId:life.operationId,roundIndex:auto.roundIndex,opportunityIndex:auto.opportunityIndex,generation:auto.generation,status:'reserved',at:now()};reservation={...copy(auto.pending),autoSessionId:auto.id,groupId,personaId:group.personaId,muted:group.mutedIds?.includes(characterId)===true};
    },{guard:state=>{decision=nextDecision(state,groupId);if(decision.skipped){reservation=decision;return false;}return true;}});
    if(reservation.skipped){if(cancellation)await cancelTurn({...cancellation,groupId});return reservation;}
    const check=autoOf(store.state,groupId).auto;if(check.status!=='active'||check.generation!==reservation.generation){await store.mutate(state=>{const {auto}=autoOf(state,groupId);if(auto.pending?.requestId===reservation.requestId&&auto.pending.status==='reserved')auto.pending=null;});return {skipped:'authorization-changed'};}
    try{if(typeof dispatchTurn!=='function')throw socialError('AUTO_DISPATCH_UNAVAILABLE','群聊调度尚未接入');await dispatchTurn(reservation);return {dispatched:true,...reservation};}catch(error){await api.failOpportunity({groupId,requestId:reservation.requestId,error});throw error;}
   })();flights.set(groupId,task);try{return await task;}finally{flights.delete(groupId);}
  },
  async failOpportunity({groupId,requestId,error}={}){
   return store.mutate(state=>{const auto=state.groups?.[groupId]?.auto,pending=auto?.pending;if(!pending||pending.requestId!==requestId||pending.generation!==auto.generation||auto.status==='ended'||auto.retiredRequests?.[requestId])return {stale:true};pending.status='failed';pending.failedAt=now();auto.status='paused';auto.pauseReason='request-failed';auto.error={at:now(),message:String(error?.message??error??'Group request failed').slice(0,500)};return {failed:true,auto:copy(auto)};});
  },
  async retryOpportunity({groupId,requestId,characterId}={}){
   return store.mutate(state=>{const {group,auto}=autoOf(state,groupId);assertSocialScope(state,auto.scope);const pending=auto.pending;if(auto.status!=='paused'||pending?.status!=='failed'||pending.requestId!==requestId||pending.characterId!==characterId||pending.generation!==auto.generation||auto.retiredRequests?.[requestId])throw socialError('AUTO_REQUEST_STALE','只能重试当前失败成员的请求');if(!sameMembers(group.memberIds,auto.groupMemberSnapshot))throw socialError('AUTO_MEMBERS_CHANGED','群成员已变化，请重新启动Auto');if(!socialSettings(state).auto)throw socialError('AUTO_DISABLED','Auto已关闭');const life=state.lives?.[characterId];if(life?.id!==pending.lifeId||life.operationId!==pending.operationId)throw socialError('AUTO_STALE_LIFE','Auto成员人生已变化');pending.status='dispatched';pending.retryCount=(pending.retryCount??0)+1;pending.retriedAt=now();delete auto.error;return copy(pending);});
  },
  async commitOpportunity({groupId,requestId,status,messageId,evidenceId,topicEnded=false}={}){
   if(!['presented','silent'].includes(status)||status==='presented'&&!messageId||status==='silent'&&!evidenceId)throw socialError('AUTO_PRESENTATION_REQUIRED','机会完成须有真实呈现或沉默决定回执');
   return store.mutate(state=>{const {auto}=autoOf(state,groupId);assertSocialScope(state,auto.scope);if(auto.completed[requestId])return {duplicate:true,auto:copy(auto)};if(auto.retiredRequests?.[requestId])return {retired:true,status:auto.retiredRequests[requestId].status,auto:copy(auto)};const pending=auto.pending;if(!pending||pending.requestId!==requestId||pending.generation!==auto.generation||auto.status==='ended')throw socialError('AUTO_REQUEST_STALE','Auto请求已变化');const life=state.lives?.[pending.characterId];if(life?.id!==pending.lifeId||life.operationId!==pending.operationId)throw socialError('AUTO_STALE_LIFE','Auto成员人生已变化');
    auto.completed[requestId]={...copy(pending),status,messageId:messageId??null,evidenceId:evidenceId??null,at:now()};auto.pending=null;auto.opportunityIndex++;if(auto.opportunityIndex>=auto.members.length){auto.opportunityIndex=0;auto.roundIndex++;}
    if(topicEnded)auto.lastTopicEndedAt=now();if(topicEnded&&auto.mode!=='until-stopped'||auto.mode==='rounds'&&auto.roundIndex>=auto.roundLimit){auto.status='ended';auto.endedReason=topicEnded?'topic-ended':'round-limit';auto.endedAt=now();}
    return {committed:true,auto:copy(auto)};
   });
  },
  async pauseForUser({groupId}={}){return store.mutate(state=>{const {auto}=autoOf(state,groupId);if(auto.status==='ended')return copy(auto);auto.status='paused';auto.pauseReason='user-spoke';auto.pausedAt=now();return copy(auto);});},
  async continue({groupId}={}){return store.mutate(state=>{const {group,auto}=autoOf(state,groupId);assertSocialScope(state,auto.scope);if(auto.status!=='paused')throw socialError('AUTO_NOT_PAUSED','Auto不在暂停状态');if(auto.pending)throw socialError('AUTO_RECONCILE_REQUIRED','请先核对未完成的Auto请求，不能自动重发');if(!sameMembers(group.memberIds,auto.groupMemberSnapshot))throw socialError('AUTO_MEMBERS_CHANGED','群成员已变化，请重新启动Auto');if(!socialSettings(state).auto)throw socialError('AUTO_DISABLED','Auto已关闭');auto.status='active';delete auto.pauseReason;return copy(auto);});},
  async stop({groupId,reason='user-stopped'}={}){let retired;const result=await store.mutate(state=>{const {auto}=autoOf(state,groupId);if(auto.status==='ended'&&!auto.pending)return copy(auto);retired=retire(auto,reason);auto.status='ended';auto.endedReason=reason;auto.endedAt=now();auto.generation++;return copy(auto);});if(retired)try{await cancelTurn({...retired,groupId});}catch(error){await store.mutate(state=>{const {auto}=autoOf(state,groupId),row=auto.retiredRequests?.[retired.requestId];if(row){row.status='unknown';row.cancellationError=String(error.message).slice(0,500);}});throw error;}return result;},
  async membersChanged({groupId}={}){return api.stop({groupId,reason:'members-changed'});},
  async recover(){return store.mutate(state=>{for(const group of Object.values(state.groups??{})){const auto=group.auto;if(auto&&auto.status!=='ended'){auto.status='paused';auto.pauseReason='restart';if(auto.pending)auto.pending.status='unknown';}}});},
  view({groupId}={}){const group=groupOf(store.state,groupId);return {groupId,enabled:socialSettings(store.state).auto,auto:copy(group.auto??null),members:copy(group.memberIds)};}
 };
 return api;
}
