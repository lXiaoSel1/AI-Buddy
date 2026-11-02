import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';
import {sanitizePluginValue} from './buddy-plugin-services/model-broker.mjs';

const fail=(message,code='PLUGIN_USAGE_INVALID')=>Object.assign(Error(message),{code});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const optionalId=value=>typeof value==='string'&&value&&value.length<=500&&!value.includes('\0')?value:null;
const counterNames={inputTokens:['inputTokens','input_tokens','input'],outputTokens:['outputTokens','output_tokens','output'],totalTokens:['totalTokens','total_tokens','total'],cachedInputTokens:['cachedInputTokens','cached_input_tokens','cache_read_input_tokens','cacheReadTokens','cacheRead'],cacheWriteInputTokens:['cacheWriteInputTokens','cache_write_input_tokens','cache_creation_input_tokens','cacheWriteTokens','cacheWrite'],reasoningOutputTokens:['reasoningOutputTokens','reasoning_output_tokens','reasoning']};
function counters(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {value:null,known:false,invalid:false};
  const result={};let invalid=false,known=false;
  for(const[name,aliases]of Object.entries(counterNames)){const key=aliases.find(k=>Object.hasOwn(value,k)&&value[k]!=null);if(!key)continue;const count=value[key];if(!Number.isSafeInteger(count)||count<0){invalid=true;continue;}result[name]=count;known=true;}
  return {value:known?result:null,known,invalid};
}
function observedTime(value){if(typeof value!=='string'&&typeof value!=='number')return null;const time=typeof value==='number'?value:Date.parse(value);return Number.isFinite(time)&&time>=0&&time<=8.64e15?new Date(time).toISOString():null;}
function receiptFingerprint(value){const {receiptId,recordedAt,sourceEvidenceId,timestamp,...body}=value;return hash({...body,...(['native-event','host-observed-transport'].includes(value.timestampBasis)?{timestamp}:{})});}
function nativeApiRecord(receipt){
  const authority=receipt?.authority,scope=authority?.scope,binding=authority?.capturedModelBinding;
  if(receipt?.version!==1||receipt.origin!=='core-native-tool-transport'||receipt.inference!==true||!['complete','partial','unknown'].includes(receipt.state)||!authority||!['pluginId','callId','contextSessionId'].every(key=>optionalId(authority[key]))||!optionalId(authority.nativeProfileId??authority.profileId)||!['characterId','personaId','lifeId','operationId'].every(key=>optionalId(scope?.[key]))||!['leaseId','transportRequestId','nativeStreamId','sourceEvidenceId'].every(key=>optionalId(receipt[key]))||!optionalId(receipt.provider)||binding?.engine!=='dsh'||!optionalId(binding.fingerprint)||!optionalId(binding.model)||!optionalId(binding.connectionRef))throw fail('Native API accounting requires an actual Core transport, DSH profile, scoped context and source evidence','PLUGIN_USAGE_NATIVE_API_IDENTITY_REQUIRED');
  if(receipt.jobId!==authority.jobId||receipt.runId!==authority.runId||receipt.nativeStreamId!==authority.nativeStreamId||receipt.transportRequestId!==authority.transportRequestId||receipt.requestedModel!==binding.model||receipt.usage?.mode!=='cumulative'||receipt.usage?.cumulative!==true)throw fail('Native API transport and captured authority identities differ','PLUGIN_USAGE_IDENTITY_MISMATCH');
  const nativeProfileId=authority.nativeProfileId??authority.profileId,key='native-api:'+hash([authority.pluginId,nativeProfileId,receipt.transportRequestId]);
  const sourceCounters=Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'].map(key=>[key,receipt.usage[key]??null]));
  // Each record is the final cumulative observation of ONE actual HTTP request,
  // not a cross-request native-session high-water counter series.
  return {pluginId:authority.pluginId,sessionId:authority.contextSessionId,contextSessionId:authority.contextSessionId,nativeRequestId:receipt.transportRequestId,nativeSessionId:null,engine:'dsh',nativeProfileId,idempotencyKey:key,
    ...Object.fromEntries(['characterId','personaId','lifeId','operationId'].map(key=>[key,scope[key]])),taskId:authority.taskId,workspaceId:authority.workspace?.id,workspace:authority.workspace,provider:receipt.provider,model:optionalId(receipt.model)??receipt.requestedModel,usageMode:'request',usage:sourceCounters,accounting:'independent',origin:'native-api',purpose:'work',cacheIncluded:false,sourceEvidenceId:receipt.sourceEvidenceId,timestamp:receipt.completedAt??receipt.startedAt,
    nativeApiEvidence:{origin:receipt.origin,state:receipt.state,reason:optionalId(receipt.reason),contextRevision:scope.contextRevision,jobId:receipt.jobId,runId:receipt.runId,memberId:optionalId(authority.memberId),runtimeId:optionalId(authority.runtimeId),contextSessionId:authority.contextSessionId,nativeProfileId,nativeToolCallId:authority.callId,nativeStreamId:receipt.nativeStreamId,transportRequestId:receipt.transportRequestId,providerRequestId:optionalId(receipt.providerRequestId),providerMessageId:optionalId(receipt.providerMessageId),requestIdEvidence:optionalId(receipt.providerMessageId)?'provider-message-id':optionalId(receipt.providerRequestId)?'provider-header':'host-observed-http-dispatch',modelEvidence:optionalId(receipt.model)?'provider-reported':'captured-binding-unreported',capturedBindingFingerprint:binding.fingerprint,capturedModel:binding.model,bindingMatched:!receipt.model||receipt.model===binding.model,sourceId:optionalId(authority.sourceId),sourceTrustDigest:optionalId(authority.sourceTrustDigest),sourceCounters,counterSemantics:'per-http-final-cumulative',totalTokensDefinition:optionalId(receipt.totalTokensDefinition),sourceEvidencePath:typeof receipt.sourceEvidencePath==='string'&&isAbsolute(receipt.sourceEvidencePath)?receipt.sourceEvidencePath:null}};
}
function normalize(raw,{nativeApi=false}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!optionalId(raw.pluginId))throw fail('A trusted plugin identity is required');
  if((raw.origin??raw.usageOrigin)==='native-api'&&!nativeApi)throw fail('Native API usage is accepted only through the Core host recorder method','PLUGIN_USAGE_NATIVE_API_AUTHORITY_REQUIRED');
  const pluginId=raw.pluginId,sessionId=optionalId(raw.sessionId),nativeRequestId=optionalId(raw.nativeRequestId),nativeSessionId=optionalId(raw.nativeSessionId),nativeEngine=optionalId(raw.engine??raw.nativeEngine),nativeProfileId=optionalId(raw.nativeProfileId),idempotencyKey=nativeApi?'native-api:'+hash([pluginId,nativeProfileId,nativeRequestId]):sessionId&&nativeRequestId?pluginId+':'+sessionId+':'+nativeRequestId:null;
  if(idempotencyKey&&raw.idempotencyKey!=null&&raw.idempotencyKey!==idempotencyKey)throw fail('Usage idempotency key does not match its trusted identity','PLUGIN_USAGE_IDENTITY_MISMATCH');
  const usage=counters(raw.usage),cumulative=counters(raw.cumulative),usageMode=['request','delta','cumulative'].includes(raw.usageMode)?raw.usageMode:'unknown',origin=['plugin-request','managed-receipt','native-log','core-model-router',...nativeApi?['native-api']:[]].includes(raw.origin??raw.usageOrigin)?(raw.origin??raw.usageOrigin):'unknown',accounting=['independent','parent-total','child-detail'].includes(raw.accounting)?raw.accounting:'unknown';
  const reasons=[];if(!sessionId)reasons.push('missing-context-session');if(!nativeRequestId)reasons.push('missing-native-request-id');if(usageMode==='unknown')reasons.push('unknown-counter-mode');if(origin==='unknown')reasons.push('unknown-accounting-origin');if(accounting==='unknown')reasons.push('unknown-parent-child-accounting');
  const selected=usageMode==='cumulative'?cumulative.value:usage.value,selectedKnown=usageMode==='cumulative'?cumulative.known:usage.known;
  if(!selectedKnown)reasons.push('missing-counters');if(usage.invalid||cumulative.invalid)reasons.push('invalid-counters');
  if(selectedKnown&&selected.totalTokens==null&&(selected.inputTokens==null||selected.outputTokens==null))reasons.push('incomplete-counter-total');
  if(selectedKnown&&selected.totalTokens==null&&selected.inputTokens!=null&&selected.outputTokens!=null&&!Number.isSafeInteger(selected.inputTokens+selected.outputTokens+(raw.cacheIncluded===false?(selected.cachedInputTokens??0)+(selected.cacheWriteInputTokens??0):0)+(raw.reasoningIncluded===false?(selected.reasoningOutputTokens??0):0)))reasons.push('counter-total-overflow');
  if(origin==='managed-receipt'&&(!nativeEngine||!nativeSessionId))reasons.push('incomplete-managed-native-identity');
  if(nativeApi&&raw.nativeApiEvidence.state!=='complete')reasons.push('native-api-'+raw.nativeApiEvidence.state);
  if(nativeApi&&raw.nativeApiEvidence.totalTokensDefinition!=='input_tokens+output_tokens;cache_tokens_separate')reasons.push('native-api-total-definition-unverified');
  if(nativeApi&&(selected?.inputTokens==null||selected?.outputTokens==null))reasons.push('native-api-request-counters-incomplete');
  if(nativeApi&&selected?.inputTokens!=null&&selected?.outputTokens!=null&&selected?.totalTokens!==selected.inputTokens+selected.outputTokens)reasons.push('native-api-counter-total-definition-mismatch');
  if(origin==='plugin-request'&&['codex','claude','dsh','kimi','gemini','opencode','cline','roo'].includes(nativeEngine))reasons.push('native-engine-needs-explicit-accounting-origin');
  let monitorDisposition='count';
  if(accounting==='child-detail'){monitorDisposition='diagnostic';reasons.push('child-already-in-parent-total');}
  else if(origin==='native-log'||origin==='core-model-router'){monitorDisposition='diagnostic';reasons.push('already-accounted-'+origin);}
  else if(raw.billable===false){monitorDisposition='diagnostic';reasons.push('source-marked-nonbillable');}
  else if(reasons.length)monitorDisposition='unknown';
  const sourceTimestamp=observedTime(raw.timestamp??raw.at),recordedAt=new Date().toISOString(),receiptId='plugin-usage-'+randomUUID();
  const value=sanitizePluginValue({schemaVersion:1,type:'plugin-usage',receiptId,pluginId,sessionId,nativeRequestId,nativeSessionId,engine:nativeEngine,nativeProfileId,idempotencyKey,...nativeApi?{contextSessionId:raw.contextSessionId,nativeApiEvidence:raw.nativeApiEvidence}:{},
    characterId:optionalId(raw.characterId),personaId:optionalId(raw.personaId),lifeId:optionalId(raw.lifeId),operationId:optionalId(raw.operationId),taskId:optionalId(raw.taskId),workspaceId:optionalId(raw.workspaceId),workspace:typeof raw.workspace==='string'?raw.workspace:typeof raw.workspace?.path==='string'?raw.workspace.path:null,
    parentNativeRequestId:optionalId(raw.parentNativeRequestId),accounting,usageMode,origin,usage:usage.value,cumulative:cumulative.value,accountedCounters:monitorDisposition==='count'?selected:null,monitorDisposition,billable:monitorDisposition==='count',qualityReasons:reasons,
    model:optionalId(raw.model),provider:optionalId(raw.provider),connectionIdentity:raw.connectionIdentity&&typeof raw.connectionIdentity==='object'?raw.connectionIdentity:null,
    cacheIncluded:typeof raw.cacheIncluded==='boolean'?raw.cacheIncluded:undefined,reasoningIncluded:typeof raw.reasoningIncluded==='boolean'?raw.reasoningIncluded:undefined,sourceEvidenceId:optionalId(raw.sourceEvidenceId),purpose:raw.purpose==='work'?'work':'plugin',recordedAt,timestamp:sourceTimestamp??recordedAt,timestampBasis:sourceTimestamp?(nativeApi?'host-observed-transport':'native-event'):'host-recorded'});
  return {value,key:idempotencyKey??'unknown:'+receiptId};
}

/** Durable receipt/outbox index. The monitor JSONL is a derived, idempotent view.
 * One application-owned recorder writes it; monitor readers never write here.
 * A crash after append but before the SQLite export mark is repaired by checking
 * the exact recorded offset/bytes. Partial tails are preserved, never truncated.
 */
export function createPluginUsageRecorder({dataRoot,onRecorded=()=>{}}={}){
  if(!isAbsolute(dataRoot??''))throw TypeError('Plugin usage dataRoot must be absolute');if(typeof onRecorded!=='function')throw TypeError('onRecorded must be a callback');
  const directory=join(dataRoot,'plugin-usage-index-v1'),logPath=join(dataRoot,'plugin-usage.jsonl');let db,log,initializing,closed=false,tail=Promise.resolve();
  async function exportRow(row){
    const bytes=Buffer.from(row.value+'\n');let offset=row.log_offset;
    if(offset!=null){const found=Buffer.alloc(bytes.length),read=await log.read(found,0,found.length,offset);if(read.bytesRead===bytes.length&&found.equals(bytes)){db.prepare('UPDATE receipts SET exported=1 WHERE key=?').run(row.key);return;}}
    const size=(await log.stat()).size;if(size){const last=Buffer.alloc(1);await log.read(last,0,1,size-1);if(last[0]!==10){await log.writeFile('\n');await log.sync();}}
    offset=(await log.stat()).size;db.prepare('UPDATE receipts SET log_offset=? WHERE key=?').run(offset,row.key);await log.writeFile(bytes);await log.sync();db.prepare('UPDATE receipts SET exported=1 WHERE key=?').run(row.key);
  }
  async function initialize(){
    await assertPluginTreeNoLinks(directory);await assertPluginTreeNoLinks(logPath);await mkdir(directory,{recursive:true});db=new DatabaseSync(join(directory,'receipts.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL,exported INTEGER NOT NULL DEFAULT 0,log_offset INTEGER); CREATE TABLE IF NOT EXISTS streams(identity TEXT PRIMARY KEY,usage_mode TEXT NOT NULL);');
    const version=db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value;if(version!=null&&version!=='1')throw fail('Unsupported plugin usage receipt index','PLUGIN_USAGE_SCHEMA_UNSUPPORTED');db.prepare("INSERT OR IGNORE INTO meta VALUES('schemaVersion','1')").run();log=await open(logPath,'a+');
    for(const row of db.prepare('SELECT * FROM receipts WHERE exported=0 ORDER BY sequence').all())await exportRow(row);
  }
  function ready(){return initializing??=initialize();}
  async function recordOnce(input,options){
    const {value,key}=normalize(input,options);await ready();const stream=hash([value.engine??value.pluginId,value.nativeProfileId??'',value.nativeSessionId??value.sessionId,value.origin]),mode=db.prepare('SELECT usage_mode FROM streams WHERE identity=?').get(stream)?.usage_mode;
    if(value.monitorDisposition==='count'&&mode&&mode!==value.usageMode){value.monitorDisposition='unknown';value.billable=false;value.accountedCounters=null;value.qualityReasons.push('counter-mode-changed-within-stream');}
    const fingerprint=receiptFingerprint(value),old=db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
    if(old){if(old.fingerprint!==fingerprint)throw fail('Native request already has different immutable usage evidence','PLUGIN_USAGE_CONFLICT');if(!old.exported)await exportRow(old);return {recorded:true,duplicate:true,receiptId:JSON.parse(old.value).receiptId,idempotencyKey:value.idempotencyKey,monitorDisposition:JSON.parse(old.value).monitorDisposition};}
    db.exec('BEGIN IMMEDIATE');try{if(value.monitorDisposition==='count')db.prepare('INSERT OR IGNORE INTO streams(identity,usage_mode) VALUES(?,?)').run(stream,value.usageMode);db.prepare('INSERT INTO receipts(key,fingerprint,value) VALUES(?,?,?)').run(key,fingerprint,JSON.stringify(value));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}const row=db.prepare('SELECT * FROM receipts WHERE key=?').get(key);await exportRow(row);
    let notificationError=null;try{await onRecorded(structuredClone(value));}catch(error){notificationError=String(error.message);}
    return {recorded:true,duplicate:false,receiptId:value.receiptId,idempotencyKey:value.idempotencyKey,monitorDisposition:value.monitorDisposition,...(notificationError?{notificationError}:{} )};
  }
  function enqueue(value,options){if(closed)return Promise.reject(fail('Plugin usage recorder is closed','PLUGIN_USAGE_CLOSED'));const input=structuredClone(value),result=tail.catch(()=>{}).then(()=>recordOnce(input,options));tail=result.catch(()=>{});return result;}
  function record(value){return enqueue(value);}
  // Core-only: never wire this method to plugin usage.record or renderer IPC.
  function recordNativeApi(receipt){try{return enqueue(nativeApiRecord(receipt),{nativeApi:true});}catch(error){return Promise.reject(error);}}
  return {record,recordNativeApi,async close(){if(closed)return;closed=true;await tail;await initializing?.catch(()=>{});await log?.close();if(db){try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}}}};
}
