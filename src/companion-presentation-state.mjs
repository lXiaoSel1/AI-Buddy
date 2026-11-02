// A runtime barrier reports actual presentation completion, never a guessed reading timer.
import {randomUUID} from 'node:crypto';

export function socialError(code,message){return Object.assign(Error(message),{code});}
export function assertSocialScope(state,scope){
 if(!scope||typeof scope.characterId!=='string')throw socialError('SOCIAL_SCOPE_INVALID','缺少可信角色范围');
 const life=state.lives?.[scope.characterId];
 if(!life||life.id!==scope.lifeId||life.operationId!==scope.operationId)throw socialError('SOCIAL_STALE_LIFE','此活动属于旧人生');
 if(scope.personaId&&!state.personas?.[scope.personaId])throw socialError('SOCIAL_PERSONA_INVALID','身份不存在');
 return life;
}
export function r95LifeState(state,scope){
 const life=assertSocialScope(state,scope);life.r95??={schemaVersion:1};return life.r95;
}
export function socialScopeKey(scope){return JSON.stringify([scope.characterId,scope.lifeId,scope.operationId,scope.personaId??'',scope.channel??'app',scope.conversationId??'']);}
export function sameSocialScope(a,b){return !!a&&!!b&&socialScopeKey(a)===socialScopeKey(b);}
export function createPresentationState(){
 const states=new Map();let revision=0;
 function state(scope){const key=socialScopeKey(scope);if(!states.has(key))states.set(key,{input:new Set(),requests:new Set(),presentations:new Map(),awaitingUser:false});return states.get(key);}
 function begin(scope,kind,id=randomUUID()){const row=state(scope);if(kind==='presentation')row.presentations.set(id,{textDone:false,audioDone:true});else row[kind].add(id);revision++;return id;}
 function end(scope,kind,id){const row=state(scope),changed=kind==='presentation'?row.presentations.delete(id):row[kind].delete(id);if(changed)revision++;return changed;}
 return {
  beginInput:(scope,id)=>begin(scope,'input',id),endInput:(scope,id)=>end(scope,'input',id),
  beginRequest:(scope,id)=>begin(scope,'requests',id),endRequest:(scope,id)=>end(scope,'requests',id),
  beginPresentation(scope,{id=randomUUID(),hasAudio=false,autoRequestId,characterId}={}){const row=state(scope);if(!row.presentations.has(id)){row.presentations.set(id,{textDone:false,audioDone:!hasAudio,autoRequestId,characterId});revision++;}return id;},
  presentation(scope,id){const value=state(scope).presentations.get(id);return value?{id,...value}:null;},
  cancelPresentation:(scope,id)=>end(scope,'presentation',id),
  cancelAutoPresentations(scope,{completed={},retiredRequests={}}={}){const row=state(scope);let changed=false;for(const [id,value]of row.presentations)if(value.autoRequestId&&(Object.hasOwn(completed,value.autoRequestId)||Object.hasOwn(retiredRequests,value.autoRequestId))){row.presentations.delete(id);changed=true;}if(changed)revision++;return changed;},
  finishText(scope,id){const value=state(scope).presentations.get(id);if(!value)return false;value.textDone=true;if(value.audioDone)state(scope).presentations.delete(id);revision++;return true;},
  finishAudio(scope,id){const value=state(scope).presentations.get(id);if(!value)return false;value.audioDone=true;if(value.textDone)state(scope).presentations.delete(id);revision++;return true;},
  setAwaitingUser(scope,value){state(scope).awaitingUser=value===true;revision++;},
  snapshot(scope){const row=state(scope),first=row.presentations.entries().next().value;return {revision,typing:row.input.size>0,waitingForReply:row.requests.size>0,presenting:row.presentations.size>0,...(first?{messageId:first[0],characterId:first[1].characterId}:{}),audioPlaying:[...row.presentations.values()].some(x=>!x.audioDone),awaitingUserAnswer:row.awaitingUser,canPresent:!row.input.size&&!row.requests.size&&!row.presentations.size&&!row.awaitingUser};},
  invalidate(scope){const deleted=states.delete(socialScopeKey(scope));if(deleted)revision++;return deleted;},
  clear(){states.clear();revision++;}
 };
}
