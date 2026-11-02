import {createHash} from 'node:crypto';
export const REWARD_UNITS_PER_POINT=10000;
const safe=n=>Number.isSafeInteger(n)&&n>=0;
const text=(value,label)=>{if(typeof value!=='string'||!value||value.length>512)throw Error(label+'无效');return value;};
export function normalizeRewardFact(raw,{trusted=false,baseline=raw?.baseline===true}={}){
 if(trusted!==true)throw Object.assign(Error('积分只接受本体核验的可信用量事实'),{code:'REWARD_TRUST_REQUIRED'});
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('用量事实无效');
 const id=text(raw.canonicalRequestId,'规范请求身份'),revision=raw.revision??1;
 if(!safe(revision))throw Error('用量修订版本无效');
 if(raw.accounting==='child-detail'||raw.monitorDisposition&&raw.monitorDisposition!=='count'||raw.billable===false||raw.replay===true)return {accepted:false,id,reason:'diagnostic-or-replay'};
 const basis=raw.basis??'actual';let units;
 if(basis==='actual')units=raw.usage?.total??raw.totalTokens??raw.units;
 else if(basis==='cg-fallback'){
  if(raw.status!=='ready'||!Array.isArray(raw.completedImageIds)||!raw.completedImageIds.length||new Set(raw.completedImageIds).size!==raw.completedImageIds.length||raw.completedImageIds.some(v=>typeof v!=='string'||!v||v.length>512))return {accepted:false,id,reason:'no-verified-completed-images'};
  units=raw.completedImageIds.length*1300;
 }else if(basis==='official-equivalent'){
  if(typeof raw.ruleRef!=='string'||!raw.ruleRef||typeof raw.ruleSha256!=='string'||!/^[a-f0-9]{64}$/i.test(raw.ruleSha256))return {accepted:false,id,reason:'official-rule-evidence-required'};
  units=raw.units;
 }else throw Error('计奖依据无效');
 if(units==null)return {accepted:false,id,reason:'usage-not-provided'};
 if(!safe(units))throw Error('计奖量须为非负安全整数');
 const value={id,revision,basis,units,origin:raw.origin??'host-normalized',baseline:baseline===true,scope:raw.scope??null,evidenceRef:raw.evidenceRef??null,sourceId:raw.sourceId??null,occurredAt:raw.occurredAt??null,live:raw.live===true,purpose:raw.purpose??null,activityOriginId:raw.activityOriginId??null};
 const fingerprint=createHash('sha256').update(JSON.stringify({basis,units,origin:value.origin,scope:value.scope,evidenceRef:value.evidenceRef})).digest('hex');
 return {accepted:true,...value,fingerprint};
}
export function rewardDelta(wallet,delta){
 if(!Number.isSafeInteger(delta))throw Error('计奖差额无效');
 let {balance,remainder,debtUnits}=wallet;
 if(![balance,remainder,debtUnits].every(safe)||remainder>=REWARD_UNITS_PER_POINT)throw Error('积分钱包状态无效');
 let liquid=balance*REWARD_UNITS_PER_POINT+remainder;
 if(!Number.isSafeInteger(liquid)||!Number.isSafeInteger(liquid+delta)||!Number.isSafeInteger(debtUnits+Math.abs(delta)))throw Error('积分计量超出安全范围');
 if(delta>=0){const paid=Math.min(debtUnits,delta);debtUnits-=paid;liquid+=delta-paid;}
 else{liquid+=delta;if(liquid<0){debtUnits-=liquid;liquid=0;}}
 return {balance:Math.floor(liquid/REWARD_UNITS_PER_POINT),remainder:liquid%REWARD_UNITS_PER_POINT,debtUnits};
}
