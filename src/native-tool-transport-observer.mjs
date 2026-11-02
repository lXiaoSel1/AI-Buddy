import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

const fail=(message,code)=>Object.assign(Error(message),{code});
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const text=value=>typeof value==='string'&&value.length<=512?value:null;
const fields=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];

/** Observes only provider-owned Messages metadata. The caller forwards original
 * buffers unchanged. Unknown counters stay null; SSE output counters are native
 * cumulative values, never a sum of deltas or fabricated zeroes. */
export function createMessagesUsageObserver({maxBytes=32*1024*1024,maxEventBytes=128*1024,maxJsonBytes=256*1024}={}){
  const decoder=new StringDecoder('utf8'),usage=Object.fromEntries(fields.map(k=>[k,null]));
  let contentType='',encoding='',buffer='',json='',bytes=0,ended=false,stopped=false,reason=null,providerRequestId=null,providerMessageId=null,model=null,statusCode=null;
  const unknown=value=>{reason??=value;buffer='';json='';};
  function merge(value){if(!value||typeof value!=='object')return;for(const [source,target]of [['input_tokens','inputTokens'],['output_tokens','outputTokens'],['cache_read_input_tokens','cacheReadTokens'],['cache_creation_input_tokens','cacheWriteTokens']])if(Object.hasOwn(value,source)){const v=count(value[source]);if(v===null)unknown('invalid-provider-counter');else usage[target]=v;}}
  function event(raw){if(!raw.trim())return;const lines=raw.split(/\r?\n/),data=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');if(!data||data==='[DONE]')return;let value;try{value=JSON.parse(data);}catch{unknown('malformed-provider-event');return;}if(value.type==='message_start'){const message=value.message??{};providerMessageId=text(message.id);model=text(message.model);merge(message.usage);}else if(value.type==='message_delta')merge(value.usage);else if(value.type==='message_stop')stopped=true;else if(value.type==='error')unknown('provider-error-event');}
  return {
    headers(headers,status){statusCode=status;contentType=String(headers['content-type']??'').toLowerCase();encoding=String(headers['content-encoding']??'identity').toLowerCase();providerRequestId=text(headers['request-id']??headers['x-request-id']??headers['x-deepseek-request-id']);if(!['identity',''].includes(encoding))unknown('encoded-provider-body-unobserved');if(status<200||status>=300)unknown('provider-http-error');},
    chunk(chunk){bytes+=chunk.length;if(reason)return;if(bytes>maxBytes){unknown('observer-byte-limit');return;}const value=decoder.write(chunk);if(contentType.includes('text/event-stream')){buffer+=value;if(Buffer.byteLength(buffer)>maxEventBytes){unknown('observer-event-limit');return;}let match;while((match=/\r?\n\r?\n/.exec(buffer))){const raw=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);event(raw);if(reason)return;}}else if(contentType.includes('application/json')){json+=value;if(Buffer.byteLength(json)>maxJsonBytes)unknown('observer-json-limit');}else unknown('unsupported-provider-content-type');},
    end(){ended=true;if(!reason){const tail=decoder.end();if(contentType.includes('text/event-stream')){buffer+=tail;if(buffer.trim())event(buffer);if(!stopped)unknown('provider-message-stop-missing');}else if(contentType.includes('application/json')){json+=tail;try{const value=JSON.parse(json);providerMessageId=text(value.id);model=text(value.model);merge(value.usage);stopped=value.type==='message';if(!stopped)unknown('provider-message-envelope-missing');}catch{unknown('malformed-provider-json');}}}},
    finish({aborted=false,errorCode=null}={}){if(aborted)unknown('transport-cancelled');else if(errorCode)unknown('transport-failed');else if(!ended)unknown('provider-response-incomplete');const known=fields.some(k=>usage[k]!==null),complete=!reason&&ended&&stopped&&usage.inputTokens!==null&&usage.outputTokens!==null;return {state:complete?'complete':known?'partial':'unknown',reason:reason??(complete?null:'provider-counters-incomplete'),statusCode,providerRequestId,providerMessageId,model,responseBytesObserved:bytes,usage:{...usage,totalTokens:usage.inputTokens!==null&&usage.outputTokens!==null?usage.inputTokens+usage.outputTokens:null,mode:'cumulative',cumulative:true,quality:complete?'complete':known?'partial':'unknown'}};}
  };
}

/** A separate Core receipt ledger, never the native account vault. It stores
 * metadata only, before notifying a possibly cross-checking usage consumer. */
export async function createNativeTransportReceiptStore(directory){
  await mkdir(directory,{recursive:true});const db=new DatabaseSync(join(directory,'native-transports-v1.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS receipts (transport_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, body TEXT NOT NULL);');
  const get=db.prepare('SELECT body FROM receipts WHERE transport_id=? AND lease_id=?'),insert=db.prepare('INSERT INTO receipts(transport_id,lease_id,body) VALUES(?,?,?)'),update=db.prepare('UPDATE receipts SET body=? WHERE transport_id=? AND lease_id=?');
  const list=()=>db.prepare('SELECT body FROM receipts ORDER BY rowid').all().map(row=>JSON.parse(row.body));
  // A previous Core stopped before transport completion. Its inference outcome
  // is unknown: never replay HTTP/model work or invent zero usage on restart.
  for(const value of list())if(value.state==='pending'){Object.assign(value,{state:'unknown',reason:'core-restarted-transport-outcome-unknown',completedAt:new Date().toISOString(),usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,totalTokens:null,mode:'cumulative',cumulative:true,quality:'unknown'}});update.run(JSON.stringify(value),value.transportRequestId,value.leaseId);}
  return {begin(value){try{insert.run(value.transportRequestId,value.leaseId,JSON.stringify(value));}catch(error){if(String(error.code).includes('CONSTRAINT')||String(error.message).includes('UNIQUE'))throw fail('Native transport attempt ID was already used','WORK_NATIVE_TRANSPORT_REPLAY');throw error;}},put(value){update.run(JSON.stringify(value),value.transportRequestId,value.leaseId);},get({leaseId,transportRequestId}){const row=get.get(transportRequestId,leaseId);return row?JSON.parse(row.body):null;},pending(){return list().filter(value=>value.state!=='pending'&&value.recording?.state==='pending');},close(){db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();}};
}

export function nativeTransportAuthority(value){
  if(value?.allowed!==true)throw fail('Native transport was not admitted by Core','WORK_NATIVE_TRANSPORT_DENIED');const source=value.authority??value,keys=['pluginId','taskId','memberId','callId','runtimeId','jobId','runId','bindingFingerprint','connectionRef','provider','model'];const result={};for(const key of keys)if(typeof source[key]==='string'&&source[key].length<=2048)result[key]=source[key];
  for(const key of ['sourceId','sourceTrustDigest','sourceDigest','packageHash','packageKey','packageName','exactVersion','schemaHash','nativeToolCallId','nativeToolName','approvedPlanRevision','contextSessionId','profileId','nativeProfileId','nativeStreamId','transportRequestId','jobId','runId'])if(typeof source[key]==='string'&&source[key].length<=2048||key==='approvedPlanRevision'&&Number.isSafeInteger(source[key]))result[key]=source[key];
  if(source.scope&&typeof source.scope==='object'){result.scope={};for(const key of ['characterId','personaId','lifeId','operationId','contextRevision','revision'])if(['string','number'].includes(typeof source.scope[key]))result.scope[key]=source.scope[key];}
  if(source.workspace&&typeof source.workspace==='object'){result.workspace={};for(const key of ['id','path'])if(typeof source.workspace[key]==='string')result.workspace[key]=source.workspace[key];}
  if(source.capturedModelBinding&&typeof source.capturedModelBinding==='object'){result.capturedModelBinding={};for(const key of ['engine','provider','model','connectionRef','fingerprint'])if(typeof source.capturedModelBinding[key]==='string')result.capturedModelBinding[key]=source.capturedModelBinding[key];}
  if(!result.pluginId||!result.callId||!result.scope?.characterId||!result.scope?.lifeId)throw fail('Native transport authority lacks the actual plugin and life scope','WORK_NATIVE_TRANSPORT_DENIED');return result;
}
