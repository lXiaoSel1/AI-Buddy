// This registry stays inside the host. The renderer/plugin cannot choose a sleep policy.
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {socialError,sameSocialScope} from './companion-presentation-state.mjs';

const policyFor=kind=>kind==='dream'||kind==='mood-asleep'?'preserve':kind==='feeding-temporary'?'temporary':'wake';
const kinds=new Set(['chat','group-chat','work','cg','cg-theme','mood','mood-asleep','dream','feeding','feeding-temporary','search','external']);
export function createActivityOriginRegistry({now=()=>Date.now(),validateScope=()=>true,maxFinished=4096}={}){
 const origins=new Map(),highWater=new Map(),samples=new Set(),secret=randomBytes(32),epoch=randomUUID();let sequence=0,wakeTokens=0,sleepPreservingTokens=0;
 function signature(value){return createHmac('sha256',secret).update(JSON.stringify([value.epoch,value.sequence,value.wakeTokens,value.sleepPreservingTokens])).digest('hex');}
 function resolve(id){const row=origins.get(id);if(!row||row.revoked)return null;try{if(validateScope(row.scope)===false)return null;}catch{return null;}return structuredClone(row);}
 function prune(){const finished=[...origins.values()].filter(row=>Number.isFinite(row.finishedAt)||row.revoked);if(finished.length>maxFinished)for(const row of finished.slice(0,finished.length-maxFinished))origins.delete(row.originId);}
 return {
  issue({scope,kind='chat',sleepIntentGeneration,parentOriginId}={}){
   if(!kinds.has(kind)||!scope||validateScope(scope)===false)throw socialError('ACTIVITY_ORIGIN_INVALID','活动来源无效');
   const parent=parentOriginId?resolve(parentOriginId):null;if(parentOriginId&&(!parent||!sameSocialScope(parent.scope,scope)))throw socialError('ACTIVITY_ORIGIN_INVALID','父活动已失效或范围不匹配');
   const row={originId:'activity-'+randomUUID(),scope:structuredClone(scope),kind,sleepPolicy:parent?.sleepPolicy??policyFor(kind),sleepIntentGeneration:parent?.sleepIntentGeneration??sleepIntentGeneration,createdAt:now(),revoked:false};
   if(row.sleepPolicy!=='wake'&&!Number.isSafeInteger(row.sleepIntentGeneration))throw socialError('ACTIVITY_SLEEP_INTENT_INVALID','保持睡眠需绑定有效睡眠意图');
   origins.set(row.originId,row);return row.originId;
  },resolve,
  finish(id){const row=origins.get(id);if(!row)return false;row.finishedAt??=now();prune();return true;},
  revoke(id){const row=origins.get(id);if(!row)return false;row.revoked=true;prune();return true;},
  revokeScope(scope){let count=0;for(const row of origins.values())if(row.scope.characterId===scope.characterId&&(!scope.lifeId||row.scope.lifeId===scope.lifeId)&&(!scope.operationId||row.scope.operationId===scope.operationId)){row.revoked=true;count++;}prune();return count;},
  recordUsage({originId,requestKey,totalTokens,cumulative=true,live=false,replay=false,sampleId}={}){
   // Called only after canonical usage dedup; this does not create billable or reward facts.
   if(!live||replay)return {added:0,reason:'not-live'};
   if(typeof requestKey!=='string'||!requestKey||!Number.isSafeInteger(totalTokens)||totalTokens<0)throw socialError('ACTIVITY_USAGE_INVALID','活动用量需规范化的请求与实际数量');
   const origin=originId?resolve(originId):null;if(originId&&!origin)return {added:0,reason:'stale-origin'};
   let added;if(cumulative){const old=highWater.get(requestKey)??0;added=Math.max(0,totalTokens-old);highWater.set(requestKey,Math.max(old,totalTokens));}
   else{if(typeof sampleId!=='string'||!sampleId)throw socialError('ACTIVITY_USAGE_INVALID','增量用量缺少稳定样本ID');const key=requestKey+'\0'+sampleId;if(samples.has(key))return {added:0,reason:'duplicate'};samples.add(key);added=totalTokens;}
   if(!added)return {added:0,reason:'duplicate-or-correction'};
   if(origin&&origin.sleepPolicy!=='wake')sleepPreservingTokens+=added;else wakeTokens+=added;sequence++;
   return {added,sleepPolicy:origin?.sleepPolicy??'wake',sequence};
  },
  summary(){const value={epoch,sequence,wakeTokens,sleepPreservingTokens};return {...value,signature:signature(value)};},
  verifySummary(value){if(!value||value.epoch!==epoch||!Number.isSafeInteger(value.sequence)||!Number.isSafeInteger(value.wakeTokens)||!Number.isSafeInteger(value.sleepPreservingTokens)||value.sequence<0||value.wakeTokens<0||value.sleepPreservingTokens<0||typeof value.signature!=='string'||!/^[a-f0-9]{64}$/.test(value.signature))return null;const expected=Buffer.from(signature(value),'hex'),actual=Buffer.from(value.signature,'hex');return timingSafeEqual(expected,actual)?structuredClone(value):null;},
  close(){origins.clear();highWater.clear();samples.clear();}
 };
}
