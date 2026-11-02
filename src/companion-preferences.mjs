import {randomUUID} from 'node:crypto';

const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const forbidden=new Set(['__proto__','constructor','prototype']);
export const PREFERENCE_OPERATIONS=Object.freeze(['introduce','refine','contextualize','revise']);
export function readGrowthEnvelope(output){
 if(!Object.hasOwn(output,'growthCandidates'))return {status:'missing',candidates:[],code:'missing-growth-candidates'};
 if(output.growthCandidates===null)return {status:'invalid',candidates:[],code:'null-growth-candidates'};
 if(!Array.isArray(output.growthCandidates))return {status:'invalid',candidates:[],code:'growth-candidates-not-array'};
 if(output.growthCandidates.length>8)return {status:'invalid',candidates:[],code:'too-many-growth-candidates'};
 return {status:output.growthCandidates.length?'provided':'empty',candidates:structuredClone(output.growthCandidates),code:null};
}
export function preferenceState(growth){
 const state=growth.preferences??={schema:1,traits:{},evidenceUseByTrait:{}};
 if(state.schema!==1||!plain(state.traits)||!plain(state.evidenceUseByTrait))throw Error('人格偏好状态格式无效');
 return state;
}
export function preferenceShape(raw){
 if(raw.schema!==2)return null;
 if(!PREFERENCE_OPERATIONS.includes(raw.operation)||!text(raw.subject,120)||!raw.subject.trim()||raw.traitId!==undefined&&raw.traitId!==null&&(!text(raw.traitId,100)||!/^pref-[a-zA-Z0-9-]+$/.test(raw.traitId)))return false;
 const attributes=raw.attributes??{};
 if(!plain(attributes)||Object.keys(attributes).length>12||Object.entries(attributes).some(([key,value])=>forbidden.has(key)||!text(key,80)||!key.trim()||!text(value,200)||!value.trim()))return false;
 if(raw.operation!=='introduce'&&!raw.traitId)return false;
 return {operation:raw.operation,traitId:raw.traitId??null,subject:raw.subject.trim(),attributes:structuredClone(attributes)};
}
const topic=value=>value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');
// Punctuation/spacing may change at the append boundary, but a refinement may
// not rewrite the current full field or another trait already present in it.
const refinementText=value=>value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{Z}]+/gu,'');
export function resolvePreference(growth,candidate,shape){
 const state=preferenceState(growth);
 let trait=shape.traitId?state.traits[shape.traitId]:Object.values(state.traits).find(row=>row.field===candidate.field&&topic(row.subject)===topic(shape.subject));
 if(shape.traitId&&!trait)return {code:'unknown-preference'};
 if(trait&&(trait.field!==candidate.field||topic(trait.subject)!==topic(shape.subject)))return {code:'preference-identity-mismatch'};
 if(!trait){trait={id:'pref-'+randomUUID(),field:candidate.field,subject:shape.subject,status:'observing',attributes:{},evidence:[],counterEvidence:[],versions:[]};state.traits[trait.id]=trait;}
 if(['refine','contextualize'].includes(shape.operation)){
  if(trait.status!=='established')return {code:'preference-not-established'};
  const before=trait.attributes??{},after=shape.attributes;
  if(Object.entries(before).some(([key,value])=>after[key]!==value))return {code:'refinement-requires-revision'};
  const additions=Object.keys(after).filter(key=>!Object.hasOwn(before,key));
  if(!additions.length)return {code:'refinement-has-no-new-detail'};
  const currentText=refinementText(candidate.before),nextText=refinementText(candidate.after),addedText=nextText.slice(currentText.length);
  if(!nextText.startsWith(currentText)||Object.values(before).some(value=>!nextText.includes(refinementText(value)))||additions.some(key=>!addedText.includes(refinementText(after[key]))))return {code:'refinement-text-requires-revision'};
  if(shape.operation==='contextualize'&&!additions.some(key=>/context|condition|when|场景|条件|情境/i.test(key)))return {code:'contextualization-needs-condition'};
 }
 if(shape.operation==='introduce'&&trait.status==='established')return {code:'preference-already-established'};
 return {state,trait};
}
export function publicPreferences(life){
 return Object.values(life.growth?.preferences?.traits??{}).map(row=>({id:row.id,field:row.field,subject:row.subject,status:row.status,attributes:structuredClone(row.status==='established'?row.attributes??{}:row.lastProposal?.attributes??{}),...(row.status==='established'?{text:row.text??''}:{}),evidenceCount:row.evidence?.length??0}));
}
