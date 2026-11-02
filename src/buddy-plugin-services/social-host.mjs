import {assertR95DatabaseCompatible} from '../r95-data-compatibility.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {SOCIAL_METHODS,SOCIAL_CAPABILITIES,SOCIAL_STAGES,SOCIAL_CHANNELS,validateSocialScope,socialError,socialId} from './social-contract.mjs';

const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeKeys=['characterId','personaId','lifeId','operationId','sessionId','channel','conversationId','accountBindingId','actorId','bindingGeneration','activityGeneration','visibilityScope'];
const scopeOf=value=>Object.fromEntries(scopeKeys.map(k=>[k,clone(value[k])]));
/** Private Core authority. Transport/evidence registration is NEVER part of the serialized SDK. */
export function createSocialHost({dataRoot,now=Date.now,resolveLife,readContext,model,appendExperience,offer,search,work,onActivity=()=>{}}={}){
 if(typeof resolveLife!=='function')throw socialError('A host life resolver is required');
 mkdirSync(join(dataRoot,'social-core'),{recursive:true});
 const databasePath=join(dataRoot,'social-core','events.sqlite');assertR95DatabaseCompatible(databasePath,{schemaKey:'schema',versions:[1],writer:'r95-social-events-v1'});const db=new DatabaseSync(databasePath);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,nativeKey TEXT UNIQUE NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,committed INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,plugin TEXT NOT NULL,activity TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(plugin,activity));`);
 const schema=db.prepare("SELECT value FROM meta WHERE key='schema'").get();if(schema&&schema.value!=='1'){db.close();throw socialError('Unsupported social evidence schema');}
 db.prepare("INSERT OR IGNORE INTO meta VALUES('schema','1')").run();db.exec("UPDATE leases SET state='interrupted' WHERE state='active'");
 db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare("INSERT OR IGNORE INTO meta VALUES('schema','1')").run();db.prepare("INSERT OR IGNORE INTO meta VALUES('minimumWriter','\"r95-social-events-v1\"')").run();
 const transports=new Map(),controllers=new Map(),pending=new Map(),contexts=new Map();let closed=false;
 function transportKey(pluginId,binding){return pluginId+'\0'+binding;}
 function ensure(){if(closed)throw socialError('Social host closed','BUDDY_SERVICE_CLOSED');}
 function current(record){
  ensure();if(record.contextAuthority)return {...record,...currentContext(record.pluginId,record.contextAuthority)};const adapter=transports.get(transportKey(record.pluginId,record.accountBindingId));
  if(!adapter||adapter.revoked||adapter.generation!==record.bindingGeneration)throw socialError('Social transport revoked or generation changed','BUDDY_CONTEXT_EXPIRED');
  const life=resolveLife(record);if(!life||life.characterId!==record.characterId||life.lifeId!==record.lifeId||life.operationId!==record.operationId)throw socialError('Social life or operation changed','BUDDY_CONTEXT_STALE');
  return {...record,...life};
 }
 function readEvidence(pluginId,eventRef){ensure();const row=db.prepare('SELECT * FROM events WHERE id=?').get(socialId(eventRef,'event reference'));if(!row||row.plugin!==pluginId)throw socialError('Social evidence belongs to another plugin or is missing','BUDDY_EVIDENCE_MISSING');return {...JSON.parse(row.body),eventRef:row.id,sourceHash:row.digest};}
 function persist(record,nativeKey){
  const value=clone(record);delete value.eventRef;const digest=hash(value),old=db.prepare('SELECT id,digest FROM events WHERE nativeKey=?').get(nativeKey);
  if(old){if(old.digest!==digest)throw socialError('Native evidence changed under the same identity','BUDDY_EVIDENCE_CONFLICT');return {eventRef:old.id,duplicate:true};}
  const id=randomUUID();db.prepare('INSERT INTO events(id,plugin,nativeKey,body,digest) VALUES(?,?,?,?,?)').run(id,record.pluginId,nativeKey,JSON.stringify(value),digest);return {eventRef:id,duplicate:false};
 }
 function registerTransport({pluginId,channel,accountBindingId,generation,verify}){
  ensure();socialId(pluginId,'plugin');socialId(accountBindingId,'account binding');if(!SOCIAL_CHANNELS.includes(channel)||!Number.isSafeInteger(generation)||generation<1||typeof verify!=='function')throw socialError('A verified transport adapter is required');
  const key=transportKey(pluginId,accountBindingId),old=transports.get(key);if(old&&generation<=old.generation)throw socialError('Transport generation must increase');
  if(old){old.revoked=true;for(const[id,row]of controllers)if(row.pluginId===pluginId&&row.scope.accountBindingId===accountBindingId){row.controller.abort();controllers.delete(id);db.prepare("UPDATE leases SET state='cancelled' WHERE id=?").run(id);onActivity({id,active:false,scope:row.scope,kind:'social'});}}const adapter={pluginId,channel,accountBindingId,generation,revoked:false};transports.set(key,adapter);
  return Object.freeze({async observe(raw){
   if(closed||adapter.revoked||transports.get(key)!==adapter)throw socialError('Transport revoked','BUDDY_CONTEXT_EXPIRED');
   const verified=await verify(raw);if(!verified||typeof verified!=='object')throw socialError('Transport event is not verified','BUDDY_EVIDENCE_INVALID');
   if(adapter.revoked||transports.get(key)!==adapter)throw socialError('Transport generation changed','BUDDY_CONTEXT_EXPIRED');
   const life=resolveLife(verified),record={...clone(verified),...life,pluginId,contextKind:'social',channel,accountBindingId,bindingGeneration:generation,activityGeneration:verified.activityGeneration??1,sourceKind:verified.sourceKind??'social-message',stage:verified.stage??'received',status:verified.status??'received',visibilityScope:verified.visibilityScope??'private',taskId:null};
   for(const key of ['owner','isOwner','approvedPlanRevision','workspace','workAuthority'])delete record[key];
   socialId(record.nativeMessageId,'native message');validateSocialScope({...record,permissionScope:SOCIAL_CAPABILITIES});
   if(!SOCIAL_STAGES.includes(record.stage)||typeof record.text!=='string'||record.text.length>200000||!Number.isFinite(record.occurredAt))throw socialError('Invalid transport event evidence');
   const nativeKey=JSON.stringify([pluginId,accountBindingId,generation,record.nativeMessageId]);return persist(record,nativeKey);
  },revoke(){adapter.revoked=true;revokePlugin(pluginId);}});
 }
 async function observeEvidence({pluginId,eventRef,sourceKind,nativeEvidenceId,stage,status,text,evidenceRefs=[],presentationState='not-presented',deliveryState='not-sent'}){
  const parent=readEvidence(pluginId,eventRef);current(parent);socialId(nativeEvidenceId,'native evidence');
  if(!SOCIAL_STAGES.includes(stage)||typeof text!=='string'||text.length>200000||!Array.isArray(evidenceRefs))throw socialError('Invalid evidence stage or text');
  if(stage==='understood'&&(status!=='completed'||!evidenceRefs.length))throw socialError('Understood material requires completed source evidence');
  const record={...parent,sourceKind,stage,status,text,evidenceRefs:clone(evidenceRefs),presentationState,deliveryState,parentEventRef:eventRef};delete record.eventRef;
  return persist(record,JSON.stringify([pluginId,parent.accountBindingId,parent.bindingGeneration,'evidence',nativeEvidenceId]));
 }
 async function resolveContext(spec){
  const actual=spec.contextRef?currentContext(spec.pluginId,spec.contextRef):current(readEvidence(spec.pluginId,spec.eventRef));
  const context={...scopeOf(actual),contextKind:'social',taskId:null,contextRevision:actual.contextRevision??1,permissionScope:clone(spec.permissionScope??SOCIAL_CAPABILITIES),connectionRefs:clone(actual.connectionRefs??[]),planState:'planning',readOnlyToolNames:[]};
  validateSocialScope(context);return context;
 }
 // App-authorized activity contexts are not past experiences. Keep their
 // authority in Core memory, separate from the immutable observed event table.
 function currentContext(pluginId,contextRef){
  ensure();const row=contexts.get(contextRef);
  if(!row||row.pluginId!==pluginId||row.check()!==true)throw socialError('Activity context revoked','BUDDY_CONTEXT_EXPIRED');
  const live=resolveLife(row.scope);
  for(const key of ['characterId','personaId','lifeId','operationId'])if(live?.[key]!==row.scope[key])throw socialError('Activity life changed','BUDDY_CONTEXT_STALE');
  return {...row.scope,...live,pluginId};
 }
 function registerContext({pluginId,scope,check,restoreRef}){
  ensure();if(typeof check!=='function'||check()!==true)throw socialError('Private activity admission required');
  const actual={...clone(scope),...resolveLife(scope),pluginId,contextKind:'social',taskId:null};
  validateSocialScope({...actual,permissionScope:SOCIAL_CAPABILITIES});
  if(contexts.size>=1000)throw socialError('Too many active social contexts','BUDDY_CONTEXT_LIMIT');
  const contextRef=restoreRef===undefined?randomUUID():socialId(restoreRef,'private restored context');
  if(contexts.has(contextRef))throw socialError('Context already active','BUDDY_CONTEXT_CONFLICT');
  contexts.set(contextRef,{pluginId,scope:actual,check});
  return {contextRef,revoke(){contexts.delete(contextRef);}};
 }
 function recordContextEvidence({pluginId,contextRef,nativeEvidenceId,sourceKind,stage,status,text,occurredAt=now(),evidenceRefs=[],presentationState='not-presented',deliveryState='not-sent',quoted=false,forwarded=false}){
  const actual=currentContext(pluginId,contextRef);socialId(nativeEvidenceId,'native evidence');
  if(!SOCIAL_STAGES.includes(stage)||typeof text!=='string'||text.length>200000||!Number.isFinite(occurredAt)||!Array.isArray(evidenceRefs))throw socialError('Invalid observed context evidence');
  if(stage==='understood'&&(status!=='completed'||!evidenceRefs.length))throw socialError('Understanding needs actual completed source evidence');
  const record={...actual,nativeMessageId:nativeEvidenceId,sourceKind,stage,status,text,occurredAt,evidenceRefs:clone(evidenceRefs),presentationState,deliveryState,quoted:!!quoted,forwarded:!!forwarded,contextAuthority:contextRef};
  return persist(record,JSON.stringify([pluginId,actual.accountBindingId,actual.bindingGeneration,nativeEvidenceId,stage]));
 }
 function sameScope(a,b){return scopeKeys.every(key=>JSON.stringify(a[key])===JSON.stringify(b[key]));}
 function finishOwnedLease(pluginId,leaseId,scope,controller,status){
  ensure();if(!['completed','failed','cancelled','unknown'].includes(status))throw socialError('Invalid activity terminal state');
  const row=db.prepare('SELECT * FROM leases WHERE id=? AND plugin=?').get(leaseId,pluginId);
  if(!row||!sameScope(JSON.parse(row.scope),scope))throw socialError('Activity owner changed');
  if(row.state!=='active')return {finished:true,duplicate:true};
  const live=controllers.get(leaseId);if(!live||live.controller!==controller||live.pluginId!==pluginId||!sameScope(live.scope,scope))throw socialError('Activity owner changed');
  db.prepare("UPDATE leases SET state=? WHERE id=? AND state='active'").run(status,leaseId);
  controller.abort();controllers.delete(leaseId);onActivity({id:leaseId,active:false,scope:clone(scope),kind:'social'});return {finished:true};
 }
 // A closure obtained while the exact admitted lease is still owned. It can
 // only terminate that lease; revocation never turns it into read authority.
 function ownLease({pluginId,context,leaseId}){
  ensure();const live=controllers.get(socialId(leaseId,'lease')),row=db.prepare('SELECT * FROM leases WHERE id=? AND plugin=?').get(leaseId,pluginId);
  if(!live||!row||live.pluginId!==pluginId||!sameScope(live.scope,context)||!sameScope(JSON.parse(row.scope),context))throw socialError('Activity owner changed');
  const controller=live.controller,scope=clone(live.scope);
  return Object.freeze({check(){ensure();const active=controllers.get(leaseId);if(!active||active.controller!==controller||controller.signal.aborted)throw socialError('Activity lease ended','BUDDY_ACTIVITY_LEASE_REQUIRED');},finish:status=>finishOwnedLease(pluginId,leaseId,scope,controller,status)});
 }
 function checkEvent(pluginId,eventRef,context){const event=readEvidence(pluginId,eventRef);current(event);if(!sameScope(event,context))throw socialError('Evidence identity or scope differs from the trusted social context');return event;}
 function leaseFor(pluginId,context,leaseId){const matches=[...controllers.entries()].filter(([id,row])=>row.pluginId===pluginId&&(!leaseId||id===leaseId)&&sameScope(row.scope,context)&&!row.controller.signal.aborted);if(matches.length!==1)throw socialError('A unique active social lease is required','BUDDY_ACTIVITY_LEASE_REQUIRED');return matches[0];}
 async function once(key,fn){if(pending.has(key))return pending.get(key);const promise=Promise.resolve().then(fn);pending.set(key,promise);try{return await promise;}finally{if(pending.get(key)===promise)pending.delete(key);}}
 const services=Object.fromEntries(SOCIAL_METHODS.map(method=>[method,{capability:method,handler:async call=>{
  const {pluginId,context,payload,signal,check}=call;validateSocialScope(context);await check();
  const activeEvent=()=>{if(!payload.eventRef)throw socialError('An actual evidence reference is required','BUDDY_EVIDENCE_MISSING');return checkEvent(pluginId,payload.eventRef,context);};
  if(method==='social.context.read'){if(!readContext)throw socialError('Social context service unavailable','BUDDY_SERVICE_UNAVAILABLE');return readContext(clone(context),{query:payload.query??'',signal});}
  if(method==='models.request'){if(!model)throw socialError('Social model service unavailable','BUDDY_SERVICE_UNAVAILABLE');const [id,lease]=leaseFor(pluginId,context,payload.leaseId);const guarded=async()=>{await check();leaseFor(pluginId,context,id);};return model({context,payload,signal:AbortSignal.any([signal,lease.controller.signal].filter(Boolean)),check:guarded});}
  if(method==='experience.append'){
   const event=activeEvent();if(!appendExperience)throw socialError('Experience storage unavailable','BUDDY_SERVICE_UNAVAILABLE');
   return once('experience:'+event.eventRef,async()=>{const old=db.prepare('SELECT committed FROM events WHERE id=?').get(event.eventRef);if(old.committed)return {recorded:true,duplicate:true,eventId:event.eventRef};
    await check();await appendExperience({...event,eventId:event.eventRef,kind:'social',scope:scopeOf(event),presentationState:event.presentationState??(event.stage==='presented'?'presented':'not-presented'),deliveryState:event.deliveryState??(event.stage==='sent'?'sent':'not-sent')});await check();db.prepare('UPDATE events SET committed=1 WHERE id=?').run(event.eventRef);return {recorded:true,eventId:event.eventRef};});
  }
  if(method==='proactive.offer'){const event=activeEvent();if(!offer)throw socialError('Proactive service unavailable','BUDDY_SERVICE_UNAVAILABLE');return offer({scope:scopeOf(event),eventId:event.eventRef,sourcePluginId:pluginId,text:payload.text??'',kind:payload.kind??'share',expiresAt:payload.expiresAt??null});}
  if(method==='activity.lease'){
   const activity=socialId(payload.activityId,'activity id');return once('lease:'+pluginId+':'+activity,async()=>{
    const previous=db.prepare('SELECT * FROM leases WHERE plugin=? AND activity=?').get(pluginId,activity);if(previous){if(previous.state!=='active'||!sameScope(JSON.parse(previous.scope),context))throw socialError('Activity already ended or belongs to another scope');leaseFor(pluginId,context,previous.id);return {leaseId:previous.id,generation:context.bindingGeneration,scope:JSON.parse(previous.scope),duplicate:true};}
    const leaseId=randomUUID(),controller=new AbortController(),scope=scopeOf(context);db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(leaseId,pluginId,activity,JSON.stringify(scope),'active');controllers.set(leaseId,{controller,pluginId,scope});signal?.addEventListener('abort',()=>controller.abort(signal.reason),{once:true});onActivity({id:leaseId,active:true,scope,kind:'social'});return {leaseId,generation:context.bindingGeneration,scope};});
  }
  if(method==='activity.check'){
   leaseFor(pluginId,context,socialId(payload.leaseId,'lease'));
   if(payload.generation!==context.bindingGeneration)throw socialError('Activity generation changed','BUDDY_CONTEXT_STALE');
   for(const key of ['characterId','personaId','lifeId','operationId'])if(payload[key]!=null&&payload[key]!==context[key])throw socialError('Activity identity changed','BUDDY_CONTEXT_STALE');
   return {valid:true,leaseId:payload.leaseId,generation:context.bindingGeneration,...scopeOf(context)};
  }
  if(method==='activity.finish'){
   const row=db.prepare('SELECT * FROM leases WHERE id=? AND plugin=?').get(socialId(payload.leaseId,'lease'),pluginId);if(!row)throw socialError('Activity lease unavailable');const scope=JSON.parse(row.scope);for(const key of scopeKeys)if(JSON.stringify(scope[key])!==JSON.stringify(context[key]))throw socialError('Activity scope changed');
   if(row.state!=='active')return {finished:true,duplicate:true};if(!['completed','failed','cancelled','unknown'].includes(payload.status))throw socialError('Invalid activity terminal state');
   return finishOwnedLease(pluginId,row.id,scope,controllers.get(row.id)?.controller,payload.status);
  }
  if(method==='search.native'){if(!search)throw socialError('Native search unavailable','BUDDY_SERVICE_UNAVAILABLE');const [id,lease]=leaseFor(pluginId,context,payload.leaseId);const guarded=async()=>{await check();leaseFor(pluginId,context,id);};return search({context,payload,signal:AbortSignal.any([signal,lease.controller.signal].filter(Boolean)),check:guarded});}
  if(method.startsWith('owner.work.')){const event=activeEvent();if(!work)throw socialError('Trusted owner work service unavailable','BUDDY_SERVICE_UNAVAILABLE');return work({method,event,context,payload,signal,check});}
  throw socialError('Unknown social service');
 }}]));
 // Read-only, for the APP's trusted-owner picker: the private QQ senders already recorded for one connected
 // account (received messages only), newest first. Ids and times only; message text never leaves here.
 function privateContacts({accountBindingId,limit=50}={}){ensure();socialId(accountBindingId,'account binding');return db.prepare("SELECT json_extract(body,'$.actorId') AS actorId,MAX(json_extract(body,'$.occurredAt')) AS lastAt,COUNT(*) AS count FROM events WHERE json_extract(body,'$.channel')='qq-private' AND json_extract(body,'$.accountBindingId')=? AND json_extract(body,'$.sourceKind')='social-message' AND json_extract(body,'$.stage')='received' AND json_extract(body,'$.actorId') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ?").all(accountBindingId,Math.max(1,Math.min(200,Number.isSafeInteger(limit)?limit:50))).map(row=>({actorId:String(row.actorId),lastAt:Number.isFinite(row.lastAt)?row.lastAt:null,count:Number(row.count)}));}
 function revokePlugin(pluginId){for(const [id,row]of contexts)if(row.pluginId===pluginId)contexts.delete(id);for(const row of transports.values())if(row.pluginId===pluginId)row.revoked=true;for(const[id,row]of controllers)if(row.pluginId===pluginId){row.controller.abort();controllers.delete(id);db.prepare("UPDATE leases SET state='cancelled' WHERE id=?").run(id);onActivity({id,active:false,scope:row.scope,kind:'social'});}}
 return {findContextEvidence({pluginId,accountBindingId,bindingGeneration,nativeEvidenceId,stage}){ensure();const nativeKey=JSON.stringify([socialId(pluginId,'plugin'),socialId(accountBindingId,'account binding'),bindingGeneration,socialId(nativeEvidenceId,'native evidence'),stage]),row=db.prepare('SELECT id FROM events WHERE plugin=? AND nativeKey=?').get(pluginId,nativeKey);return row?{eventRef:row.id}:null;},evidenceState(pluginId,eventRef){const record=readEvidence(pluginId,eventRef),row=db.prepare('SELECT committed FROM events WHERE id=?').get(eventRef);return {record,committed:row.committed===1};},services,capabilities:SOCIAL_CAPABILITIES,resolveContext,registerContext,ownLease,recordContextEvidence,registerTransport,observeEvidence,readEvidence,privateContacts,revokePlugin,allowsScope:scope=>[...controllers.values()].some(row=>{if(row.controller.signal.aborted||!sameScope(row.scope,scope))return false;try{const anchor=[...contexts.entries()].find(([,value])=>value.pluginId===row.pluginId&&sameScope(value.scope,row.scope));if(anchor)currentContext(row.pluginId,anchor[0]);else current({...row.scope,pluginId:row.pluginId});return true;}catch{return false;}}),activeCount:()=>controllers.size,close(){if(closed)return;for(const row of controllers.values())row.controller.abort();controllers.clear();contexts.clear();for(const row of transports.values())row.revoked=true;db.exec("UPDATE leases SET state='interrupted' WHERE state='active'");db.close();closed=true;}};
}
