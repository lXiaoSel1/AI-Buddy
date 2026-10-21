import {createHash} from 'node:crypto';
import {effectiveCard} from './companion-store.mjs';

// These are conservative engineering gates, not a psychological growth model.
// Source validity and a small diff do not prove that a change is semantically natural.
export const GROWTH_FIELDS=Object.freeze(['personality','interests','likes','dislikes','tone','selfAddress','speechHabits']);
export const GROWTH_LOCKED_FIELDS=Object.freeze(['intro','identity','background','personality','interests','likes','dislikes','tone','selfAddress','speechHabits','address','relationship','meeting','greeting']);
export const GROWTH_POLICY=Object.freeze({version:1,independentExperiences:3,activeDays:2,deepActiveDays:7,ownExperiences:2,dailyChanges:2,maxDelta:180,maxField:12000});
const OWN=Object.hasOwn;
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fieldState=value=>value?.mode==='custom'?{mode:'custom',value:value.value??''}:{mode:value?.mode??'inherit'};
const validText=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const dayText=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const unique=values=>[...new Set(values)];
const scopeOf=event=>event.scope??(event.groupId?'group:'+event.groupId:event.personaId?'persona:'+event.personaId:'personal');
function getLife(state,id){if(!OWN(state.cards??{},id)||!OWN(state.lives??{},id))throw Error('角色或当前人生不存在');return state.lives[id];}
function isGrowth(life){return life?.mode==='seed'||life?.mode==='blank';}

/** Called by every user card-save/import/mode entry before makeCard or mutation. */
export function assertCardEditAllowed(previous,args,life){
 const raw=plain(args?.card)?args.card:args;if(!plain(raw))throw Error('角色卡格式无效');
 if(!isGrowth(life))return true;
 const deny=()=>{throw Error('成长角色设定只读；重新填写请先完整归档并重置人生');};
 for(const key of ['mode','growthMode'])if(OWN(raw,key)&&raw[key]!==life.mode)deny();
 if(OWN(raw,'growth')&&!same(raw.growth,previous?.growth))deny();
 if(OWN(raw,'life')&&!same(raw.life,previous?.life))deny();
 if(OWN(raw,'id')&&raw.id!==previous?.id)deny();
 for(const key of ['name','examples'])if(OWN(raw,key)&&!same(raw[key],previous?.[key]))deny();
 if(OWN(raw,'fields')){
  if(!plain(raw.fields))throw Error('角色字段格式无效');
  for(const field of GROWTH_LOCKED_FIELDS)if(OWN(raw.fields,field)&&!same(fieldState(raw.fields[field]),fieldState(previous?.fields?.[field])))deny();
 }
 if(OWN(raw,'defaults')){
  if(!plain(raw.defaults))throw Error('角色默认字段格式无效');
  for(const field of GROWTH_LOCKED_FIELDS)if(OWN(raw.defaults,field)&&!same(raw.defaults[field],previous?.defaults?.[field]))deny();
 }
 // Some importers pass effective fields directly instead of {fields:{...}}.
 const effective=effectiveCard(previous??{});
 for(const field of GROWTH_LOCKED_FIELDS)if(OWN(raw,field)&&!same(raw[field],effective[field]))deny();
 return true;
}

/** Explicit opt-in only. The caller archives before blank/reset and rotates operationId. */
export function enableGrowth(state,characterId,mode,at=Date.now()){
 if(!['seed','blank'].includes(mode))throw Error('请选择初始设定起步或白板起步');
 const life=getLife(state,characterId),card=state.cards[characterId];
 if(isGrowth(life)){if(life.mode===mode)return life;throw Error('成长模式不能直接切换；请先完整归档并重置人生');}
 if(life.mode&&life.mode!=='normal')throw Error('当前人生模式无效');
 life.seedCard=clone(card);life.mode=mode;
 life.growth={schema:1,policyVersion:GROWTH_POLICY.version,enabledAt:at,history:[],observations:{},batches:{},evidenceUse:{},daily:{}};
 if(mode==='blank'){
  card.fields??={};for(const field of GROWTH_LOCKED_FIELDS)card.fields[field]={mode:'empty'};
  card.examples=[];
 }
 card.revision=(Number(card.revision)||0)+1;card.updatedAt=at;
 return life;
}

function growthState(life){
 const row=life.growth??={};row.schema??=1;row.policyVersion??=GROWTH_POLICY.version;
 row.history??=[];row.observations??={};row.batches??={};row.evidenceUse??={};row.daily??={};return row;
}
function eventMap(life){const value=life.memory?.events??{};return Array.isArray(value)?Object.fromEntries(value.map(row=>[row.id,row])):value;}
function original(event,life,id,scope){
 if(!plain(event)||event.dateUnknown===true||event.lifeId!==life.id||event.characterId!==id||scopeOf(event)!==scope)return false;
 // Original events survive restoring the same life under a fresh operation ID.
 // The pending *batch* token, not the event's historical operation, rejects stale work.
 if(event.presented!==true||['pending','pending-presentation','failed','interrupted','cancelled','discarded'].includes(event.status))return false;
 if(!['user-report','character-statement','shared-dialogue','personal-activity'].includes(event.sourceKind))return false;
 if(event.derived===true||event.generated===true&&event.presented!==true)return false;
 if(!validText(event.text??'',200000)||!dayText(event.day)||!event.sourceId)return false;
 return true;
}
function independentKey(event){
 // Fallback is intentionally conservative: many messages in a conversation/day
 // cannot masquerade as many independent experiences when a legacy turn ID is absent.
 return String(event.experienceId??event.source?.experienceId??event.source?.requestId??((event.conversationId??event.groupId??event.source?.id??event.sourceId)+':'+event.day));
}
function originalRows(rows){
 const uniqueSources=new Map();for(const row of rows){const previous=uniqueSources.get(row.sourceId);if(!previous||(Number(row.revision)||0)>(Number(previous.revision)||0))uniqueSources.set(row.sourceId,row);}return [...uniqueSources.values()];
}
function ownExperience(event,id){
 if(event.sourceKind==='personal-activity')return true;
 if(event.role!=='assistant')return false;
 if(event.sourceKind==='character-statement')return true;
 return (event.speakerCharacterId??event.source?.speakerId??event.source?.characterId)===id;
}
function diffParts(before,after){
 let left=0;while(left<before.length&&left<after.length&&before[left]===after[left])left++;
 let right=0;while(right<before.length-left&&right<after.length-left&&before[before.length-1-right]===after[after.length-1-right])right++;
 return {removed:before.slice(left,before.length-right),added:after.slice(left,after.length-right)};
}
function incremental(before,after,field){
 if(!validText(after,GROWTH_POLICY.maxField)||after===before||!after.trim())return false;
 const {removed,added}=diffParts(before,after);
 if(!added.trim()||added.length>GROWTH_POLICY.maxDelta||removed.length>120||removed.length>Math.max(24,Math.floor(before.length/3)))return false;
 if(removed.length+added.length>240)return false;
 // Keep a change expressed as a contextual behavior, not an unconditional flip.
 if(!/(逐渐|近期|有时|偶尔|更愿意|更倾向|开始|尝试|倾向于|在.{1,30}(?:时|中|上)|对.{1,35}(?:兴趣|好奇|偏好)|occasionally|sometimes|gradually|in familiar|more willing|tends? to|interested in|curious about|prefer)/i.test(added))return false;
 if(/(完全|彻底|终身|永远|从此|极度|无条件|所有人都|不再有任何|always|never|entirely|completely)/i.test(added))return false;
 if(field==='selfAddress'&&added.length>80)return false;
 return true;
}
function privateNames(state){
 const names=[];for(const row of Object.values(state.personas??{}))for(const key of ['name','nickname','occupation','identity']){
  const value=row?.[key];if(typeof value==='string'&&value.trim().length>=2&&!['默认身份','Default persona','Default','旅行者','你自己'].includes(value.trim()))names.push(value.trim());
 }
 for(const card of Object.values(state.cards??{}))if(typeof card?.name==='string'&&card.name.trim().length>=2)names.push(card.name.trim());
 return unique(names);
}
function safeAbstraction(state,candidate,events){
 const after=candidate.after,delta=diffParts(candidate.before,after).added;
 if(candidate.scope!=='general'||candidate.private===true||candidate.containsPrivateDetails===true||candidate.privacy&&candidate.privacy!=='general-behavior')return false;
 if(/(?:https?:\/\/|\b[A-Z]:\\|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d{3}[- ]?\d{4}[- ]?\d{4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|api[ _-]?key|system prompt|忽略.{0,20}指令|密码|秘密|好感值|约定|承诺|私聊|身份[甲乙丙AB]|Persona\s*[:：])/i.test(delta))return false;
 if(privateNames(state).some(name=>after.toLocaleLowerCase().includes(name.toLocaleLowerCase())))return false;
 // A quoted private utterance or uncommon literal span is not abstraction.
 if(/[“”「」『』]|["`]/.test(delta))return false;
 for(const event of events){
  if(scopeOf(event)==='personal')continue;
  const body=event.text??'';
  for(let start=0;start+14<=delta.length;start++){
   const segment=delta.slice(start,start+14);
   if(/[\p{L}\p{N}]{10}/u.test(segment)&&body.includes(segment))return false;
  }
 }
 return true;
}
function canonicalCandidate(raw){
 if(!plain(raw))return null;
 const field=raw.field,before=raw.before??raw.oldValue,after=raw.after??raw.newValue;
 const sourceEventIds=raw.sourceEventIds,counterEvidenceIds=raw.counterEvidenceIds??raw.counterevidenceIds??[];
 if(typeof field!=='string'||!validText(before,GROWTH_POLICY.maxField)||!validText(after,GROWTH_POLICY.maxField)||!Array.isArray(sourceEventIds)||!sourceEventIds.length||sourceEventIds.length>100||!Array.isArray(counterEvidenceIds)||counterEvidenceIds.length>100)return null;
 if([...sourceEventIds,...counterEvidenceIds].some(id=>typeof id!=='string'||!id||id.length>300))return null;
 if(!validText(raw.reason??'',1000)||!validText(raw.context??'',1000))return null;
 return {...raw,field,before,after,sourceEventIds:unique(sourceEventIds),counterEvidenceIds:unique(counterEvidenceIds),reason:raw.reason??'',context:raw.context??''};
}

/** Synchronous: run inside the same store transaction as the daily memory commit. */
export function applyGrowthCandidates(state,characterId,candidates,batch,at=Date.now()){
 const life=getLife(state,characterId),card=state.cards[characterId];
 const result={applied:[],observing:[],rejected:[],duplicate:false};
 if(!Array.isArray(candidates)||candidates.length>20)throw Error('成长候选格式无效');
 if(!plain(batch)||!validText(batch.id,300)||!dayText(batch.day)||!Array.isArray(batch.eventIds)||!validText(batch.scope,300))throw Error('成长整理批次格式无效');
 if(!isGrowth(life))return {...result,skipped:'normal-mode'};
 if(batch.lifeId!==life.id||batch.operationId!==life.operationId)return {...result,rejected:candidates.map((_,index)=>({index,code:'stale-life'}))};
 const growth=growthState(life),signature=hash({candidates,batch}),batchKey=hash(batch.id);
 if(OWN(growth.batches,batchKey))return growth.batches[batchKey].signature===signature?{...clone(growth.batches[batchKey].result),duplicate:true}:{...result,rejected:candidates.map((_,index)=>({index,code:'batch-conflict'}))};
 const events=eventMap(life),allowed=new Set(batch.eventIds);
 const startingRevision=Number(card.revision)||0;
 const reject=(index,code)=>result.rejected.push({index,code});
 for(const [index,raw]of candidates.entries()){
  const candidate=canonicalCandidate(raw);
  if(!candidate){reject(index,'invalid-candidate');continue;}
  if(!GROWTH_FIELDS.includes(candidate.field)){reject(index,'field-not-growable');continue;}
  if(candidate.lifeId!==life.id||candidate.operationId!==life.operationId){reject(index,'stale-life');continue;}
  if(candidate.expectedCardVersion!==startingRevision){reject(index,'stale-card');continue;}
  if(candidate.before!==String(effectiveCard(card)[candidate.field]??'')){reject(index,'before-mismatch');continue;}
  const allIds=unique([...candidate.sourceEventIds,...candidate.counterEvidenceIds]);
  if(allIds.some(id=>!allowed.has(id)||!OWN(events,id)||!original(events[id],life,characterId,batch.scope)||events[id].day>batch.day)){reject(index,'invalid-evidence');continue;}
  const supports=candidate.sourceEventIds.map(id=>events[id]);
  if(!incremental(candidate.before,candidate.after,candidate.field)){reject(index,'change-not-small-behavior');continue;}
  if(!safeAbstraction(state,candidate,supports)){reject(index,'unsafe-abstraction');continue;}
  const observationId=hash({lifeId:life.id,scope:batch.scope,field:candidate.field,before:candidate.before,after:candidate.after});
  const prior=growth.observations[observationId];
  const sourceIds=unique([...(prior?.sourceEventIds??[]),...candidate.sourceEventIds]).filter(id=>allowed.has(id)&&OWN(events,id)&&original(events[id],life,characterId,batch.scope));
  const counterIds=unique([...(prior?.counterEvidenceIds??[]),...candidate.counterEvidenceIds]).filter(id=>allowed.has(id)&&OWN(events,id)&&original(events[id],life,characterId,batch.scope));
  const rows=originalRows(sourceIds.map(id=>events[id])),independent=unique(rows.map(independentKey)),days=unique(rows.map(row=>row.day));
  const own=unique(rows.filter(row=>ownExperience(row,characterId)&&row.transient!==true).map(independentKey));
  const used=growth.evidenceUse[candidate.field]??=[];
  const newEvidence=independent.filter(key=>!used.includes(key));
  let status='observing',code='insufficient-independent-evidence';
  if(candidate.kind&&candidate.kind!=='small-behavior'){code='needs-staged-small-change';}
  else if(counterIds.length){code='counterevidence-needs-review';}
  else if(newEvidence.length<GROWTH_POLICY.independentExperiences){code='insufficient-independent-evidence';}
  else if(own.filter(key=>newEvidence.includes(key)).length<GROWTH_POLICY.ownExperiences){code='insufficient-character-behavior';}
  else if(days.length<(candidate.field==='personality'||candidate.depth==='deep'?GROWTH_POLICY.deepActiveDays:GROWTH_POLICY.activeDays)){code='insufficient-active-days';}
  else if((growth.daily[batch.day]??0)>=GROWTH_POLICY.dailyChanges){status='deferred';code='daily-character-limit';}
  else{
   const previousVersion=Number(card.revision)||0;card.fields??={};card.fields[candidate.field]={mode:'custom',value:candidate.after};card.revision=previousVersion+1;card.updatedAt=at;
   const entry={id:'growth-'+hash({batchId:batch.id,index,field:candidate.field}),field:candidate.field,before:candidate.before,after:candidate.after,at,day:batch.day,lifeId:life.id,operationId:life.operationId,previousVersion,version:card.revision,batchId:batch.id,scope:batch.scope,sourceEventIds:sourceIds,counterEvidenceIds:counterIds,reason:candidate.reason,context:candidate.context,evidenceCount:independent.length,activeDays:days.length,checks:'source-version-bounded-diff'};
   growth.history.push(entry);growth.daily[batch.day]=(growth.daily[batch.day]??0)+1;growth.evidenceUse[candidate.field]=unique([...used,...independent]);
   delete growth.observations[observationId];result.applied.push({id:entry.id,field:entry.field,version:entry.version});continue;
  }
  growth.observations[observationId]={id:observationId,...candidate,sourceEventIds:sourceIds,counterEvidenceIds:counterIds,status,code,scope:batch.scope,lifeId:life.id,operationId:life.operationId,createdAt:prior?.createdAt??at,updatedAt:at,lastBatchId:batch.id,evidenceCount:independent.length,activeDays:days.length};
  result.observing.push({id:observationId,field:candidate.field,status,code});
 }
 growth.batches[batchKey]={signature,result:clone(result),at,day:batch.day};return result;
}

/** Public read-only view: never include private source IDs, scope, reasons or text. */
export function growthView(state,characterId,_personaId){
 const life=getLife(state,characterId),card=state.cards[characterId],growth=life.growth??{};
 return {mode:life.mode??'normal',locked:isGrowth(life),lifeId:life.id,version:Number(card.revision)||0,startedAt:growth.enabledAt??life.startedAt,
  history:(growth.history??[]).map(row=>({id:row.id,field:row.field,before:row.before,after:row.after,at:row.at,day:row.day,version:row.version,previousVersion:row.previousVersion,summary:'依据多个日期的真实互动，逐步调整具体表达或偏好。',evidenceCount:row.evidenceCount,activeDays:row.activeDays})),
  observing:Object.values(growth.observations??{}).map(row=>({id:row.id,field:row.field,status:row.status,updatedAt:row.updatedAt,summary:row.status==='deferred'?'保留候选，等待后续整理。':'仍在观察真实经历与相反证据，暂未修改人格。'})),
  checks:'已核对来源、人生版本和局部变化幅度；人格连续性仍需结合实际交流检验。'};
}
