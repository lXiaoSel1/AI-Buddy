import {assertR95DatabaseCompatible} from '../r95-data-compatibility.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {socialError,socialId} from './social-contract.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
const scopeOf=e=>Object.fromEntries(['characterId','personaId','lifeId','operationId'].map(k=>[k,e[k]]));
const sameScope=(a,b)=>['characterId','personaId','lifeId','operationId'].every(k=>a?.[k]===b?.[k]);
/** Only Core owns binding, challenge issuance and the non-serializable work proof. */
export function createOwnerWorkAuthority({dataRoot,readEvidence,assertScope,getPlan,propose,approve,cancel,now=Date.now}={}){
 mkdirSync(join(dataRoot,'social-core'),{recursive:true});const databasePath=join(dataRoot,'social-core','owner.sqlite');assertR95DatabaseCompatible(databasePath,{schemaKey:'schemaVersion',versions:[1],writer:'r95-owner-work-v1'});const db=new DatabaseSync(databasePath);
 db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS owners(account TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,state TEXT NOT NULL,body TEXT,result TEXT);`);
 db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare("INSERT OR IGNORE INTO meta VALUES('schemaVersion','1')").run();db.prepare("INSERT OR IGNORE INTO meta VALUES('minimumWriter','\"r95-owner-work-v1\"')").run();
 const proofs=new WeakMap(),pending=new Map();let closed=false;
 const check=()=>{if(closed)throw socialError('Owner authority closed');};
 function bindOwner(binding){check();for(const key of ['accountBindingId','actorId','personaId'])socialId(binding[key],key);if(!Number.isSafeInteger(binding.version)||binding.version<1)throw socialError('Invalid owner binding version');const old=owner(binding.accountBindingId);if(old&&old.version>=binding.version)throw socialError('Owner binding version must increase');db.prepare('INSERT INTO owners VALUES(?,?) ON CONFLICT(account) DO UPDATE SET body=excluded.body').run(binding.accountBindingId,JSON.stringify(binding));return {bound:true,version:binding.version};}
 function owner(account){const row=db.prepare('SELECT body FROM owners WHERE account=?').get(account);return row?JSON.parse(row.body):null;}
 function principal(pluginId,eventRef){check();const e=readEvidence(pluginId,eventRef),binding=e&&owner(e.accountBindingId);
  if(!e||e.pluginId!==pluginId||e.channel!=='qq-private'||!binding||e.actorId!==binding.actorId||e.personaId!==binding.personaId||e.stage!=='received'||e.forwarded||e.quoted||['webpage','ocr','forward','quote','card-content'].includes(e.sourceKind))throw socialError('Only the bound owner direct private message is a work principal','BUDDY_OWNER_DENIED');
  assertScope?.(scopeOf(e));return {event:e,binding};
 }
 async function once(id,fn){if(pending.has(id))return pending.get(id);const task=Promise.resolve().then(fn);pending.set(id,task);try{return await task;}finally{pending.delete(id);}}
 function stored(id){const row=db.prepare('SELECT * FROM operations WHERE id=?').get(id);return row&&{...row,body:row.body?JSON.parse(row.body):null,result:row.result?JSON.parse(row.result):null};}
 function put(id,state,body,result=null){db.prepare('INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body,result=excluded.result').run(id,state,JSON.stringify(body),result==null?null:JSON.stringify(result));}
 function proof(operation,body){const value=Object.freeze({});proofs.set(value,{operation,...body,expiresAt:now()+300000});return value;}
 function verifyProof(value,operation,payload={}){check();const p=value&&proofs.get(value);if(!p||p.operation!==operation||now()>=p.expiresAt||operation!=='tasks.create'&&p.taskId&&p.taskId!==payload.taskId||p.planVersion!=null&&p.planVersion!==(payload.planVersion??payload.planRevision)||operation==='tasks.create'&&(payload.projectId!==p.projectId||digest(payload.instruction)!==p.instructionHash))throw socialError('Invalid private owner work authority','BUDDY_OWNER_DENIED');assertScope?.(p.scope);const binding=owner(p.accountBindingId);if(!binding||binding.version!==p.ownerBindingVersion||binding.actorId!==p.actorId)throw socialError('Owner binding changed','BUDDY_OWNER_DENIED');return clone(p);}
 async function proposeWork({pluginId,eventRef,projectId}){const {event,binding}=principal(pluginId,eventRef);socialId(projectId,'registered project');if(!propose)throw socialError('Work plugin unavailable','BUDDY_SERVICE_UNAVAILABLE');const id='propose:'+digest([pluginId,event.accountBindingId,event.nativeMessageId]);
  return once(id,async()=>{const old=stored(id);if(old?.state==='completed')return old.result;if(old)throw socialError('Previous work submission result is unknown; inspect the task before retrying','BUDDY_EXTERNAL_RESULT_UNKNOWN');
   const taskId='social-task-'+digest(id).slice(0,32),body={scope:scopeOf(event),taskId,projectId,instruction:event.text,instructionHash:digest(event.text),accountBindingId:event.accountBindingId,actorId:event.actorId,ownerBindingVersion:binding.version};put(id,'submitted',body);
   const authority=proof('tasks.create',body);try{const result=await propose({...body,instruction:event.text,authority});put(id,'completed',body,result);return result;}catch(error){put(id,'unknown',body);throw error;}finally{proofs.delete(authority);}});
 }
 async function issueApproval({pluginId,eventRef,taskId,versionCommand=false}){const {event,binding}=principal(pluginId,eventRef);if(!getPlan)throw socialError('Work plugin unavailable','BUDDY_SERVICE_UNAVAILABLE');const plan=await getPlan({taskId,scope:scopeOf(event)});
  if(!plan||plan.taskId!==taskId||!sameScope(plan.scope,scopeOf(event))||!plan.planHash||plan.planVersion==null||!plan.workspace)throw socialError('Plan scope or revision unavailable','BUDDY_PLAN_STALE');
  principal(pluginId,eventRef);
  const challengeId=randomBytes(24).toString('base64url'),body={...plan,pluginId,scope:scopeOf(event),accountBindingId:event.accountBindingId,actorId:event.actorId,conversationId:event.conversationId,ownerBindingVersion:binding.version,versionCommand:versionCommand===true,expiresAt:now()+300000};put('challenge:'+challengeId,'pending',body);return {challengeId,taskId,planVersion:plan.planVersion,planHash:plan.planHash,workspace:plan.workspace,expiresAt:body.expiresAt};
 }
 async function approveWork({pluginId,eventRef,challengeId}){const {event,binding}=principal(pluginId,eventRef);socialId(challengeId,'approval challenge');const id='challenge:'+challengeId;
  return once(id,async()=>{const row=stored(id);if(!row||row.body.pluginId!==pluginId)throw socialError('Approval challenge unavailable','BUDDY_OWNER_DENIED');const body=row.body;
   if(body.accountBindingId!==event.accountBindingId||body.actorId!==event.actorId||body.ownerBindingVersion!==binding.version||body.conversationId!==event.conversationId)throw socialError('Owner binding or conversation changed','BUDDY_OWNER_DENIED');
   if(event.text?.trim()!==`批准 ${challengeId}`&&event.text?.trim()!==`approve ${challengeId}`&&!(body.versionCommand===true&&event.text?.trim()===`/批准 ${body.taskId} ${body.planVersion}`))throw socialError('An explicit direct approval is required','BUDDY_OWNER_DENIED');
   if(row.state==='completed')return row.result;if(row.state!=='pending')throw socialError('Approval result unknown; inspect existing task','BUDDY_EXTERNAL_RESULT_UNKNOWN');if(now()>=body.expiresAt)throw socialError('Approval expired','BUDDY_CONTEXT_EXPIRED');
   const actual=await getPlan({taskId:body.taskId,scope:body.scope});if(!actual||actual.planVersion!==body.planVersion||actual.planHash!==body.planHash||actual.workspace!==body.workspace||!sameScope(actual.scope,body.scope))throw socialError('Plan revision or scope changed','BUDDY_PLAN_STALE');
   if(!approve)throw socialError('Work plugin unavailable','BUDDY_SERVICE_UNAVAILABLE');put(id,'submitted',body);const authority=proof('plans.approve',body);
   try{const result=await approve({...body,authority});put(id,'completed',body,result);return result;}catch(error){put(id,'unknown',body);throw error;}finally{proofs.delete(authority);}
  });
 }
 async function readWork({pluginId,eventRef,taskId}){
  const {event}=principal(pluginId,eventRef);socialId(taskId,'task');
  if(!getPlan)throw socialError('Work plugin unavailable','BUDDY_SERVICE_UNAVAILABLE');
  const plan=await getPlan({taskId,scope:scopeOf(event)});
  principal(pluginId,eventRef);
  if(!plan||plan.taskId!==taskId||!sameScope(plan.scope,scopeOf(event)))throw socialError('Plan scope changed','BUDDY_PLAN_STALE');
  // Do not expose arbitrary plugin response fields or grant execution here.
  return issueApproval({pluginId,eventRef,taskId,versionCommand:true});
 }
 async function approveVersion({pluginId,eventRef,taskId,planVersion}){
  const {event}=principal(pluginId,eventRef);
  if(!Number.isSafeInteger(planVersion)||planVersion<1||event.text.trim()!==`/批准 ${taskId} ${planVersion}`)throw socialError('An exact direct approval is required','BUDDY_OWNER_DENIED');
  const found=db.prepare("SELECT id FROM operations WHERE id LIKE 'challenge:%' AND json_extract(body,'$.versionCommand')=1 AND json_extract(body,'$.pluginId')=? AND json_extract(body,'$.accountBindingId')=? AND json_extract(body,'$.actorId')=? AND json_extract(body,'$.conversationId')=? AND json_extract(body,'$.taskId')=? AND json_extract(body,'$.planVersion')=? ORDER BY rowid DESC LIMIT 1").get(pluginId,event.accountBindingId,event.actorId,event.conversationId,taskId,planVersion);
  if(!found)throw socialError('Read the current plan before approving its version','BUDDY_PLAN_STALE');
  return approveWork({pluginId,eventRef,challengeId:found.id.slice('challenge:'.length)});
 }
 async function cancelWork({pluginId,eventRef,taskId,planVersion}){
  const {event,binding}=principal(pluginId,eventRef);socialId(taskId,'task');
  if(!Number.isSafeInteger(planVersion)||planVersion<1||event.text.trim()!==`/取消 ${taskId} ${planVersion}`)throw socialError('An exact direct cancellation is required','BUDDY_OWNER_DENIED');
  if(!getPlan||!cancel)throw socialError('Work plugin unavailable','BUDDY_SERVICE_UNAVAILABLE');
  const id='cancel:'+digest([pluginId,event.accountBindingId,event.nativeMessageId]);
  return once(id,async()=>{
   const old=stored(id);if(old?.state==='completed')return old.result;if(old)throw socialError('Cancellation outcome unknown; inspect the task','BUDDY_EXTERNAL_RESULT_UNKNOWN');
   const plan=await getPlan({taskId,scope:scopeOf(event)});principal(pluginId,eventRef);
   if(!plan||plan.taskId!==taskId||plan.planVersion!==planVersion||!plan.planHash||!sameScope(plan.scope,scopeOf(event)))throw socialError('Plan revision or scope changed','BUDDY_PLAN_STALE');
   const body={...plan,scope:scopeOf(event),accountBindingId:event.accountBindingId,actorId:event.actorId,ownerBindingVersion:binding.version};
   put(id,'submitted',body);const authority=proof('tasks.cancel',body);
   try{const result=await cancel({...body,authority});put(id,'completed',body,result);return result;}catch(error){put(id,'unknown',body);throw error;}finally{proofs.delete(authority);}
  });
 }
 return {bindOwner,owner,list:()=>db.prepare('SELECT body FROM owners ORDER BY account').all().map(row=>JSON.parse(row.body)),proposeWork,readWork,cancelWork,issueApproval,approveWork,approveVersion,verifyProof,close(){if(closed)return;db.close();closed=true;}};
}
