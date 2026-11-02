import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assertR95DatabaseCompatible} from '../r95-data-compatibility.mjs';
const fail=code=>Object.assign(Error(code),{code});
const neverSubmitted=new WeakSet(),publicNotSubmitted=new WeakMap();
const capacityCauses=new Set(['MEMORY_CONTEXT_CAPACITY','MODEL_CONTEXT_CAPACITY','BILI_FULL_MODEL_CAPACITY','MODEL_IMAGE_TOO_LARGE']);
export const modelNotSubmittedCause=error=>error&&typeof error==='object'?publicNotSubmitted.get(error)??null:null;
export function modelNotSubmittedError(error){const value=fail('SOCIAL_MODEL_NOT_SUBMITTED'),causeCode=error?.causeCode??error?.code;if(typeof causeCode==='string'&&causeCode!=='SOCIAL_MODEL_NOT_SUBMITTED')value.causeCode=causeCode;if(capacityCauses.has(causeCode))publicNotSubmitted.set(value,causeCode);return value;}
export function markModelNotSubmitted(error){const value=error&&typeof error==='object'?error:Error(String(error));neverSubmitted.add(value);return value;}
export const socialDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const socialScopeSnapshot=value=>Object.fromEntries(['pluginId','packageName','characterId','personaId','lifeId','operationId','channel','conversationId','conversationType','peerId','actorId','senderId','sourceMessageId','sessionId','accountBindingId','bindingGeneration','activityGeneration','visibilityScope','connectionRef','modelConnectionRef'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
/** Private host facts. A submitted model call is never retried on restart or
 * connection loss. Cached public material is reusable, understanding is not. */
export function createSocialRuntimeJournal({dataRoot}){
 mkdirSync(join(dataRoot,'social-core'),{recursive:true});
 const path=join(dataRoot,'social-core','runtime-v1.sqlite');
 assertR95DatabaseCompatible(path,{schemaKey:'schema',versions:[1],writer:'r95-social-runtime-v1'});
 const db=new DatabaseSync(path),pending=new Map(),activeAttempts=new Map();let closed=false;
 db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
 INSERT OR IGNORE INTO meta VALUES('schema','1');
 INSERT OR IGNORE INTO meta VALUES('minimumWriter','"r95-social-runtime-v1"');
 CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,digest TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,result TEXT,requestId TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS materials(id TEXT PRIMARY KEY,account TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS contexts(token TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS model_inputs(id TEXT PRIMARY KEY,input TEXT NOT NULL,reconciled INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS model_transport_attempts(id TEXT NOT NULL,attempt INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,attempt));
 CREATE TABLE IF NOT EXISTS model_transport_events(id TEXT NOT NULL,attempt INTEGER NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,attempt,sequence));
 UPDATE models SET state='unknown' WHERE state IN ('submitted','preparing','send-attempt','confirmed','transport-complete');
 UPDATE model_transport_attempts SET state='unknown' WHERE state IN ('preparing','send-attempt','confirmed','transport-complete');`);
 const ensure=()=>{if(closed)throw fail('SOCIAL_JOURNAL_CLOSED');};
 function exactRow({id,input,scope}){
  ensure();const row=db.prepare('SELECT * FROM models WHERE id=?').get(id);
  if(!row||row.digest!==socialDigest(input)||socialDigest(JSON.parse(row.scope))!==socialDigest(socialScopeSnapshot(scope)))throw fail('SOCIAL_MODEL_ID_CONFLICT');return row;
 }
 // Only private transport callbacks reach this writer. Metadata is allow-listed;
 // original terminal events stay bounded in this database, never in an audit log.
 function lifecycle({id,input,scope,event,attempt=activeAttempts.get(id)}){
  exactRow({id,input,scope});const active=activeAttempts.get(id)===attempt&&pending.has(id);
  const phases=['preparing','send-attempt','confirmed','complete','unknown','not-sent','terminal-evidence'];
  if(!attempt||!db.prepare('SELECT 1 FROM model_transport_attempts WHERE id=? AND attempt=?').get(id,attempt)||event?.source!=='core-transport'||!phases.includes(event.phase)||!['api','codex'].includes(event.transport))throw fail('SOCIAL_MODEL_LIFECYCLE_INVALID');
  const body={phase:event.phase,source:'core-transport',transport:event.transport};
  for(const key of ['requestId','providerRequestId','threadId','turnId','requestKind','correlation'])if(typeof event[key]==='string'&&event[key].length<=500||Number.isSafeInteger(event[key]))body[key]=event[key];
  for(const key of ['status','round'])if(Number.isSafeInteger(event[key]))body[key]=event[key];
  if(typeof event.error?.code==='string')body.error={code:event.error.code.slice(0,200)};
  if(event.phase==='terminal-evidence'){
   const evidence=event.evidence??{},events=[];let bytes=0,overflow=evidence.overflow===true;
   for(const raw of Array.isArray(evidence.events)?evidence.events:[]){const text=JSON.stringify(raw),size=Buffer.byteLength(text,'utf8');if(events.length>=4096||bytes+size>8*1024*1024){overflow=true;break;}events.push(JSON.parse(text));bytes+=size;}
   body.evidence={transport:event.transport,complete:evidence.complete===true&&!overflow,overflow,events};
   for(const key of ['requestId','threadId','turnId','correlation'])if(evidence[key]===null||typeof evidence[key]==='string'&&evidence[key].length<=500||Number.isSafeInteger(evidence[key]))body.evidence[key]=evidence[key];
  }
  const text=JSON.stringify(body),usage=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(length(CAST(body AS BLOB))),0) bytes FROM model_transport_events WHERE id=? AND attempt=?').get(id,attempt);
  if(usage.count>=1024||usage.bytes+Buffer.byteLength(text,'utf8')>16*1024*1024)throw fail('SOCIAL_MODEL_LIFECYCLE_LIMIT');
  const phase=event.phase==='complete'?'transport-complete':event.phase;
  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT INTO model_transport_events VALUES(?,?,?,?)').run(id,attempt,usage.count+1,text);
   if(active&&event.phase!=='terminal-evidence')db.prepare("UPDATE model_transport_attempts SET state=? WHERE id=? AND attempt=? AND state NOT IN ('observed','completed')").run(phase,id,attempt);
   if(active&&['preparing','send-attempt','confirmed','transport-complete'].includes(phase))db.prepare("UPDATE models SET state=? WHERE id=? AND result IS NULL AND state NOT IN ('observed','completed')").run(phase,id);
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 function observed({id,input,scope,result}){
  ensure();const row=db.prepare('SELECT * FROM models WHERE id=?').get(id),snapshot=socialScopeSnapshot(scope);
  if(!row||row.digest!==socialDigest(input)||socialDigest(JSON.parse(row.scope))!==socialDigest(snapshot))throw fail('SOCIAL_MODEL_ID_CONFLICT');
  if(typeof result?.requestId!=='string'||!result.requestId)throw fail('CORE_MODEL_ACCOUNTING_REQUIRED');
  const text=JSON.stringify(result);
  if(row.result!==null){if(row.requestId!==result.requestId||row.result!==text)throw fail('SOCIAL_MODEL_RECEIPT_CONFLICT');return;}
  db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE models SET state='observed',result=?,requestId=? WHERE id=? AND result IS NULL").run(text,result.requestId,id);const attempt=activeAttempts.get(id);if(attempt)db.prepare("UPDATE model_transport_attempts SET state='observed' WHERE id=? AND attempt=?").run(id,attempt);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 }
 return {
  observeModel:observed,
  observeModelLifecycle:lifecycle,
  recoveryModels({pluginId,accountBindingId,bindingGeneration,readingId,stepId}){ensure();return db.prepare("SELECT m.*,i.input,i.reconciled FROM models m JOIN model_inputs i ON i.id=m.id WHERE json_extract(m.scope,'$.pluginId')=? AND json_extract(m.scope,'$.accountBindingId')=? AND json_extract(m.scope,'$.bindingGeneration')=? AND json_extract(m.result,'$.hostReadingId')=? AND json_extract(i.input,'$.stepId')=? AND m.state IN ('observed','completed') ORDER BY m.rowid DESC LIMIT 8").all(pluginId,accountBindingId,bindingGeneration,readingId,stepId).filter(row=>!pending.has(row.id)).map(row=>({id:row.id,digest:row.digest,scope:JSON.parse(row.scope),input:JSON.parse(row.input),result:JSON.parse(row.result),reconciled:row.reconciled===1}));},
  recoveryContext(scope){ensure();const row=db.prepare("SELECT body FROM contexts WHERE json_extract(body,'$.pluginId')=? AND json_extract(body,'$.sessionId')=? ORDER BY rowid DESC LIMIT 1").get(scope.pluginId,scope.sessionId);if(!row)return null;const value=JSON.parse(row.body);return socialDigest(socialScopeSnapshot(value))===socialDigest(socialScopeSnapshot(scope))?value:null;},
  markReconciled({id,input,scope}){ensure();const row=db.prepare('SELECT * FROM models WHERE id=?').get(id);if(!row||row.digest!==socialDigest(input)||socialDigest(JSON.parse(row.scope))!==socialDigest(socialScopeSnapshot(scope))||row.result===null||!['observed','completed'].includes(row.state))throw fail('SOCIAL_MODEL_ID_CONFLICT');db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE models SET state='completed' WHERE id=?").run(id);db.prepare('UPDATE model_inputs SET reconciled=1 WHERE id=?').run(id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}},
  completeObserved({id,input,scope}){ensure();const row=db.prepare('SELECT * FROM models WHERE id=?').get(id);if(!row||row.digest!==socialDigest(input)||socialDigest(JSON.parse(row.scope))!==socialDigest(socialScopeSnapshot(scope))||row.result===null||!['observed','completed'].includes(row.state))throw fail('SOCIAL_MODEL_ID_CONFLICT');db.prepare("UPDATE models SET state='completed' WHERE id=?").run(id);},
  saveContext(token,value){ensure();db.prepare('INSERT INTO contexts VALUES(?,?) ON CONFLICT(token) DO UPDATE SET body=excluded.body').run(token,JSON.stringify(value));},
  legacyCursor(){ensure();return Number(db.prepare("SELECT value FROM meta WHERE key='qq-memory-legacy-cursor'").get()?.value??0);},
  advanceLegacyCursor(cursor){ensure();db.prepare("INSERT INTO meta(key,value) VALUES('qq-memory-legacy-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(cursor));},
  contexts({packageName,after=0,limit=100}={}){ensure();return db.prepare("SELECT rowid AS cursor,token,body FROM contexts WHERE rowid>? AND (? IS NULL OR json_extract(body,'$.packageName')=?) ORDER BY rowid LIMIT ?").all(after,packageName??null,packageName??null,Math.min(100,limit)).map(row=>({token:row.token,...JSON.parse(row.body),cursor:row.cursor}));},
  context(token){ensure();const row=db.prepare('SELECT body FROM contexts WHERE token=?').get(token);return row?JSON.parse(row.body):null;},
  async model({id,input,scope},operation,{beforePrepare}={}){
   ensure();const digest=socialDigest(input),snapshot=JSON.stringify(socialScopeSnapshot(scope));let old=db.prepare('SELECT * FROM models WHERE id=?').get(id);
   if(old){if(old.digest!==digest||socialDigest(JSON.parse(old.scope))!==socialDigest(socialScopeSnapshot(scope)))throw fail('SOCIAL_MODEL_ID_CONFLICT');if(pending.has(id))return pending.get(id);if(['observed','completed'].includes(old.state)&&old.result!==null)return JSON.parse(old.result);if(old.state!=='not-sent'||old.result!==null)throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');}
   // Host-only verify-before-write hook. Old receipts/unknowns win above, and
   // all identity/pending checks run again after its asynchronous verification.
   if(beforePrepare){await beforePrepare();ensure();old=db.prepare('SELECT * FROM models WHERE id=?').get(id);if(old){if(old.digest!==digest||socialDigest(JSON.parse(old.scope))!==socialDigest(socialScopeSnapshot(scope)))throw fail('SOCIAL_MODEL_ID_CONFLICT');if(pending.has(id))return pending.get(id);if(['observed','completed'].includes(old.state)&&old.result!==null)return JSON.parse(old.result);if(old.state!=='not-sent'||old.result!==null)throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');}}
   const attempt=db.prepare('SELECT COALESCE(MAX(attempt),0)+1 next FROM model_transport_attempts WHERE id=?').get(id).next;
   db.exec('BEGIN IMMEDIATE');try{if(old)db.prepare("UPDATE models SET state='preparing' WHERE id=? AND state='not-sent' AND result IS NULL").run(id);else{db.prepare("INSERT INTO models VALUES(?,?,?,'preparing',NULL,NULL)").run(id,digest,snapshot);db.prepare('INSERT INTO model_inputs(id,input) VALUES(?,?)').run(id,JSON.stringify(input));}db.prepare("INSERT INTO model_transport_attempts VALUES(?,?,'preparing',?)").run(id,attempt,Date.now());db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
   activeAttempts.set(id,attempt);
   const observeLifecycle=event=>lifecycle({id,input,scope,event,attempt});
   const task=Promise.resolve().then(()=>operation({observeLifecycle})).then(result=>{
    if(typeof result.requestId!=='string'||!result.requestId)throw fail('CORE_MODEL_ACCOUNTING_REQUIRED');
    db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE models SET state='completed',result=?,requestId=? WHERE id=?").run(JSON.stringify(result),result.requestId,id);db.prepare("UPDATE model_transport_attempts SET state='completed' WHERE id=? AND attempt=?").run(id,attempt);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return result;
   }).catch(error=>{
    const row=db.prepare('SELECT state,result FROM models WHERE id=?').get(id),trusted=neverSubmitted.has(error);if(trusted)neverSubmitted.delete(error);
    const sent=db.prepare("SELECT 1 FROM model_transport_events WHERE id=? AND attempt=? AND json_extract(body,'$.phase') IN ('confirmed','complete') LIMIT 1").get(id,attempt);
    const unsent=trusted&&row?.result===null&&!sent;
    db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE models SET state=? WHERE id=? AND result IS NULL AND state NOT IN ('observed','completed')").run(unsent?'not-sent':'unknown',id);db.prepare('UPDATE model_transport_attempts SET state=? WHERE id=? AND attempt=?').run(row?.result!==null?'observed':unsent?'not-sent':'unknown',id,attempt);db.exec('COMMIT');}catch(cause){db.exec('ROLLBACK');throw cause;}
    if(unsent)throw modelNotSubmittedError(error);if(trusted)throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');throw error;
   }).finally(()=>{pending.delete(id);activeAttempts.delete(id);});
   pending.set(id,task);return task;
  },
   result(requestId){ensure();const row=db.prepare("SELECT scope,result FROM models WHERE requestId=? AND state='completed'").get(requestId);return row?{scope:JSON.parse(row.scope),result:JSON.parse(row.result)}:null;},
  rememberMaterial(account,material){ensure();const id=socialDigest(material);db.prepare('INSERT OR IGNORE INTO materials VALUES(?,?,?)').run(socialDigest([account,id]),account,JSON.stringify(material));return id;},
  material(account,material){ensure();const id=socialDigest([account,socialDigest(material)]);return !!db.prepare('SELECT id FROM materials WHERE id=? AND account=?').get(id,account);},
  async close(){if(closed)return;closed=true;await Promise.allSettled(pending.values());db.close();}
 };
}
