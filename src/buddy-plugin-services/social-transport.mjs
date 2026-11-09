import {parseQqMessageSegments} from './qq-message-envelope.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {assertR95DatabaseCompatible} from '../r95-data-compatibility.mjs';
import {qqOneBotUrl} from '../qq-onebot-url.mjs';
const fail=(code,message=code)=>Object.assign(Error(message),{code});
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const copy=v=>structuredClone(v);
// Preserve only the immutable identity, never live broker functions, maps or
// account secrets, in transport evidence and idempotency keys.
const memoryContextCopy=v=>Object.fromEntries(['pluginId','packageName','characterId','personaId','lifeId','operationId','channel','conversationId','conversationType','peerId','actorId','senderId','sourceMessageId','sessionId','accountBindingId','bindingGeneration','activityGeneration','visibilityScope','connectionRef','modelConnectionRef','modelFingerprint','contextRef','contextToken','persistedToken','operatorGeneration','account'].filter(k=>v?.[k]!==undefined).map(k=>[k,copy(v[k])]));
const scopeCopy=v=>Object.fromEntries(['pluginId','packageName','characterId','personaId','lifeId','operationId','channel','conversationId','conversationType','peerId','sourceMessageId','accountBindingId','bindingGeneration'].filter(k=>v[k]!==undefined).map(k=>[k,v[k]]));
const qqCaps=['events.private','events.group','identity.sender','identity.account','messages.id','messages.timestamp','send.receipt'];
const readPaths=new Set(['/x/web-interface/view','/x/web-interface/popular','/x/web-interface/nav','/x/player/wbi/v2','/x/player/v2']);
export function biliRequestPolicy(payload,account){
  let url;try{url=new URL(payload.url);}catch{throw fail('SOCIAL_HTTP_URL_INVALID');}
  const method=payload.method??'GET',api=url.hostname==='api.bilibili.com',cdn=/(^|\.)(hdslb\.com|bilibili\.com)$/.test(url.hostname);
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||!['GET','POST'].includes(method))throw fail('SOCIAL_HTTP_DESTINATION_DENIED');
  if(api?method==='GET'?!readPaths.has(url.pathname):url.pathname!=='/x/v2/reply/add':!cdn||method!=='GET'||payload.credentialBinding)throw fail('SOCIAL_HTTP_DESTINATION_DENIED');
  if(payload.anonymousReadOnly&&(method!=='GET'||payload.credentialBinding||payload.form))throw fail('SOCIAL_ANONYMOUS_WRITE_DENIED');
  if(payload.credentialBinding&&(payload.credentialBinding.connectionRef!==account.ref||payload.connectionRef!==account.ref||!api))throw fail('SOCIAL_CREDENTIAL_SCOPE_DENIED');
  if(method==='GET'&&payload.form)throw fail('SOCIAL_HTTP_BODY_DENIED');
  return {url,method,api};
}
export function biliResponseLimit(payload,url,observed=[]){
 const requested=Number.isSafeInteger(payload.maxResponseBytes)&&payload.maxResponseBytes>0?payload.maxResponseBytes:4*1024*1024;
 const subtitle=payload.method!=='POST'&&!payload.credentialBinding&&observed.some(o=>{try{const u=new URL(o.url),v=JSON.parse(o.body);return u.hostname==='api.bilibili.com'&&['/x/player/v2','/x/player/wbi/v2'].includes(u.pathname)&&v.code===0&&(v.data?.subtitle?.subtitles??[]).some(t=>new URL(t.subtitle_url.startsWith('//')?'https:'+t.subtitle_url:t.subtitle_url).href===url.href);}catch{return false;}});
 return Math.min(subtitle?64*1024*1024:4*1024*1024,requested);
}
async function responseBody(response,limit){
  const reader=response.body?.getReader();if(!reader)return '';const chunks=[];let bytes=0;
  try{for(;;){const row=await reader.read();if(row.done)break;bytes+=row.value.byteLength;if(bytes>limit)throw fail('SOCIAL_HTTP_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(row.value));}return Buffer.concat(chunks).toString('utf8');}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
/** Host-only HTTP/WebSocket custody. Endpoint credentials never cross IPC.
 * Accepted writes are journaled BEFORE dispatch; unknown results stay unknown. */
export function createSocialTransport({dataRoot,accounts,fetchImpl=fetch,WebSocketImpl=WebSocket,now=Date.now}={}){
  const path=join(dataRoot,'social-core','transport-v1.sqlite');
  assertR95DatabaseCompatible(path,{writer:'r95-social-transport-v1'});
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT); INSERT OR IGNORE INTO meta VALUES('schemaVersion','1'); INSERT OR IGNORE INTO meta VALUES('minimumWriter','"r95-social-transport-v1"');`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sends(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT); UPDATE sends SET state='unknown' WHERE state='submitted';");
  db.exec("CREATE TABLE IF NOT EXISTS qq_memory_intents(id TEXT PRIMARY KEY,send_id TEXT UNIQUE NOT NULL,proof_json TEXT NOT NULL,proof_digest TEXT NOT NULL,state TEXT NOT NULL,event_ref TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);CREATE INDEX IF NOT EXISTS qq_memory_due ON qq_memory_intents(state,next_at);CREATE INDEX IF NOT EXISTS qq_memory_request ON qq_memory_intents(json_extract(proof_json,'$.context.pluginId'),json_extract(proof_json,'$.accountRef'),json_extract(proof_json,'$.requestId'));");
  const connections=new Map(),observations=new Map(),writes=new Map();let closed=false;
  db.exec('CREATE TABLE IF NOT EXISTS qq_event_inbox(connection_id TEXT NOT NULL,cursor INTEGER NOT NULL,account_ref TEXT NOT NULL,account_generation INTEGER NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(connection_id,cursor));');
  function eventFilter(value){if(value===undefined)return null;if(!value||!['contacts','groups'].every(key=>Array.isArray(value[key])&&value[key].length<=10000&&value[key].every(id=>typeof id==='string'&&/^[1-9]\d{0,19}$/.test(id))))throw fail('QQ_EVENT_FILTER_INVALID');return {contacts:new Set(value.contacts),groups:new Set(value.groups)};}
  function notify(row){for(const wake of row.waiters)wake();}
  function inboxStatus(row){if(row.storageFailure)return {code:'QQ_EVENT_STORAGE_FAILED',pendingInMemory:row.pending.length,rejectedAdmissions:row.rejectedAdmissions};if(row.clockSkew)return {code:'QQ_CLOCK_SKEW',...row.clockSkew};if(row.storedCount+row.pending.length>=1000||row.storedBytes>=64*1024*1024)return {code:'QQ_EVENT_BACKPRESSURE',queued:row.storedCount+row.pending.length,bytes:row.storedBytes};return null;}
  function flushInbox(row){
    if(!row.pending.length)return;
    const batch=[];let batchBytes=0;for(const entry of row.pending){if(batch.length&&(batch.length>=100||batchBytes+entry.bytes>1024*1024))break;batch.push(entry);batchBytes+=entry.bytes;}const insert=db.prepare('INSERT INTO qq_event_inbox VALUES(?,?,?,?,?,?,?)');
    try{db.exec('BEGIN IMMEDIATE');for(const entry of batch)insert.run(row.id,entry.cursor,row.account.ref,row.account.generation,entry.payload,entry.bytes,entry.receivedAt);db.exec('COMMIT');row.pending.splice(0,batch.length);row.storedCount+=batch.length;row.storedBytes+=batch.reduce((sum,event)=>sum+event.bytes,0);row.storageFailure=false;}
    catch(error){try{db.exec('ROLLBACK');}catch{}row.storageFailure=true;}
    notify(row);
  }
  function scheduleInbox(row){if(row.flushScheduled)return;row.flushScheduled=true;setImmediate(()=>{row.flushScheduled=false;if(!closed){flushInbox(row);if(row.pending.length&&!row.storageFailure)scheduleInbox(row);}});}
  function account(ref,expected){if(closed)throw fail('SOCIAL_TRANSPORT_CLOSED');const a=accounts.get(ref);if(!a?.enabled||expected&&a.accountId!==expected)throw fail('SOCIAL_ACCOUNT_CHANGED');return a;}
  function connection(id){const row=connections.get(id);if(!row||row.closed||account(row.account.ref).generation!==row.account.generation)throw fail('SOCIAL_CONNECTION_CLOSED');return row;}
  // A connection belongs to the operator's original life, not merely the npm
  // package. Per-message peer/conversation fields may differ from the operator
  // anchor; identity and account-generation fields may never be rebound.
  function connectionScope(row,scope){
    if(['pluginId','packageName','characterId','personaId','lifeId','operationId','accountBindingId','bindingGeneration'].some(key=>scope?.[key]!==row.scope[key])||scope?.accountBindingId!==row.account.accountId||scope?.bindingGeneration!==row.account.generation)throw fail('SOCIAL_CONNECTION_SCOPE_DENIED');
    return row;
  }
  const linked=(signal,timeout=15000)=>AbortSignal.any([signal,AbortSignal.timeout(timeout)].filter(Boolean));
  function keep(scope,value){const id=randomUUID();observations.set(id,{...copy(value),scope:scopeCopy(scope)});if(observations.size>2000)observations.delete(observations.keys().next().value);return id;}
  function persistIntent(sendId,proof,{eventRef=null,state='pending'}={}){const id=hash(['qq-memory',sendId]),body=JSON.stringify(proof),digest=hash(proof),old=db.prepare('SELECT proof_digest FROM qq_memory_intents WHERE id=?').get(id);if(old&&old.proof_digest!==digest)throw fail('QQ_MEMORY_PROOF_CONFLICT');db.prepare('INSERT OR IGNORE INTO qq_memory_intents(id,send_id,proof_json,proof_digest,state,event_ref) VALUES(?,?,?,?,?,?)').run(id,sendId,body,digest,state,eventRef);return id;}
  async function submit(id,payload,operation,memoryContext){
    const digest=hash(payload),previous=db.prepare('SELECT * FROM sends WHERE id=?').get(id);
    if(previous){if(previous.digest!==digest)throw fail('SOCIAL_SEND_ID_CONFLICT');if(writes.has(id))return writes.get(id);return previous.state==='completed'?JSON.parse(previous.result):{status:'unknown'};}
    db.prepare("INSERT INTO sends VALUES(?,?,'submitted',NULL)").run(id,digest);
    const task=(async()=>{try{const result=await operation();db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE sends SET state='completed',result=? WHERE id=?").run(JSON.stringify(result),id);if(result.status==='sent'&&result.messageId){const observed=observations.get(result.observationId),proof={version:1,context:memoryContextCopy(memoryContext??observed.scope),accountRef:memoryContext?.account?.ref,requestId:observed.requestId,messageId:observed.messageId,text:observed.text,occurredAt:observed.occurredAt,observationId:result.observationId,sendDigest:digest};persistIntent(id,proof);}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return result;}catch{db.prepare("UPDATE sends SET state='unknown' WHERE id=?").run(id);return {status:'unknown'};}finally{writes.delete(id);}})();writes.set(id,task);return task;
  }
  async function qqCall(a,action,params,signal){
    const token=accounts.secret(a.ref).accessToken;
    const response=await fetchImpl(qqOneBotUrl(a.httpUrl,action),{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(params),redirect:'error',signal:linked(signal)});
    const text=await responseBody(response,4*1024*1024);if(!response.ok)throw fail('QQ_BACKEND_HTTP_FAILED');let body;try{body=JSON.parse(text);}catch{throw fail('QQ_BACKEND_REPLY_INVALID');}if(body.status!=='ok'||body.retcode!==0)throw fail('QQ_BACKEND_REQUEST_FAILED');return body.data;
  }
  async function open({connectionRef,accountId,newEventsOnly,eventFilter:filter},scope,{signal}={}){
    if(newEventsOnly!==true)throw fail('QQ_HISTORY_DISABLED');const a=account(connectionRef,accountId);if(a.platform!=='qq')throw fail('QQ_ACCOUNT_REQUIRED');
    const login=await qqCall(a,'get_login_info',{},signal);if(String(login?.user_id)!==a.accountId)throw fail('QQ_CONNECTION_ACCOUNT_MISMATCH');
    signal?.throwIfAborted();if(account(a.ref).generation!==a.generation)throw fail('SOCIAL_ACCOUNT_CHANGED');
    const id=randomUUID(),row={id,account:a,scope:scopeCopy(scope),filter:eventFilter(filter),pending:[],storedCount:0,storedBytes:0,storageFailure:false,rejectedAdmissions:0,cursor:0,deliveredCursor:0,ackCursor:0,waiters:new Set(),started:Math.ceil(now()/1000),closed:false};connections.set(id,row);
    const url=new URL(a.webSocketUrl),token=accounts.secret(a.ref).accessToken;if(token)url.searchParams.set('access_token',token);
    const socket=row.socket=new WebSocketImpl(url);
    try{await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',failed);error?reject(error):resolve();};
      const opened=()=>done(),failed=()=>done(fail('QQ_SOCKET_FAILED')),abort=()=>done(fail('ABORT_ERR')),timer=setTimeout(()=>done(fail('QQ_SOCKET_TIMEOUT')),15000);
      socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});socket.addEventListener('close',failed,{once:true});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });}catch(error){await closeConnection(id);throw error;}
    socket.addEventListener('message',event=>{
      if(row.closed)return;let raw;try{if(String(event.data).length>1024*1024)return;raw=JSON.parse(String(event.data));}catch{return;}
      if(raw.post_type!=='message'||!['private','group'].includes(raw.message_type)||String(raw.self_id)!==a.accountId||raw.message_id==null)return;
      const peer=String(raw.message_type==='group'?raw.group_id:raw.user_id??raw.sender?.user_id);if(row.filter&&!(raw.message_type==='group'?row.filter.groups:row.filter.contacts).has(peer))return;
      if(!Number.isSafeInteger(raw.time)||raw.time<row.started)return;
      if(raw.time*1000>now()+30000){row.clockSkew={eventTime:raw.time,receivedAt:now(),invalidUnit:raw.time>now()/10};notify(row);return;}
      if(row.pending.length>=1000)flushInbox(row);
      if(row.pending.length>=1000){row.rejectedAdmissions++;notify(row);return;}
      const payload=JSON.stringify(raw);row.pending.push({cursor:++row.cursor,payload,bytes:Buffer.byteLength(payload),receivedAt:now()});scheduleInbox(row);
    });socket.addEventListener('close',()=>{row.closed=true;for(const notify of row.waiters)notify();});
    return {connectionId:id,accountId:a.accountId,capabilities:qqCaps,cursor:0,generation:a.generation,epochSeconds:row.started};
  }
  async function events(payload,scope,{signal,check=async()=>{}}={}){
    await check();const row=connectionScope(connection(payload.connectionId),scope);if(payload.accountId!==row.account.accountId)throw fail('SOCIAL_CONNECTION_SCOPE_DENIED');
    if(payload.eventFilter!==undefined)row.filter=eventFilter(payload.eventFilter);flushInbox(row);
    if(payload.newEventsOnly!==true)throw fail('QQ_HISTORY_DISABLED');const cursor=payload.cursor??0;if(!Number.isSafeInteger(cursor)||cursor<0||cursor>row.cursor)throw fail('QQ_EVENT_CURSOR_INVALID');
    if(cursor<row.ackCursor)throw fail('QQ_EVENT_CURSOR_EXPIRED');
    // Fetching a batch is not acknowledgement: its source messages remain
    // available during model/quote processing. Only the next explicit ack,
    // sent after all handlers settle, releases that consumed prefix.
    if(payload.ackCursor!==undefined){const ack=payload.ackCursor;if(!Number.isSafeInteger(ack)||ack<row.ackCursor||ack>cursor||ack>row.deliveredCursor)throw fail('QQ_EVENT_ACK_INVALID');const removed=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM qq_event_inbox WHERE connection_id=? AND cursor<=?').get(row.id,ack);db.prepare('DELETE FROM qq_event_inbox WHERE connection_id=? AND cursor<=?').run(row.id,ack);row.ackCursor=ack;row.storedCount-=removed.count;row.storedBytes-=removed.bytes;}
    if(!inboxStatus(row)&&!db.prepare('SELECT 1 FROM qq_event_inbox WHERE connection_id=? AND cursor>? LIMIT 1').get(row.id,cursor))await new Promise(resolve=>{const done=()=>{clearTimeout(timer);row.waiters.delete(done);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,Math.min(20000,Math.max(0,payload.waitMs??20000)));row.waiters.add(done);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
    signal?.throwIfAborted();await check();connectionScope(connection(row.id),scope);
    flushInbox(row);const limit=Math.min(100,Math.max(1,Number.isSafeInteger(payload.limit)?payload.limit:100)),selected=db.prepare('SELECT cursor,payload FROM qq_event_inbox WHERE connection_id=? AND cursor>? ORDER BY cursor LIMIT ?').all(row.id,cursor,limit),nextCursor=selected.at(-1)?.cursor??cursor;row.deliveredCursor=Math.max(row.deliveredCursor,nextCursor);return {events:selected.map(e=>JSON.parse(e.payload)),cursor:nextCursor,transportStatus:inboxStatus(row)};
  }
  function inbound(connectionId,sourceMessageId,scope){const row=connectionScope(connection(connectionId),scope);flushInbox(row);const event=db.prepare("SELECT payload FROM qq_event_inbox WHERE connection_id=? AND CAST(json_extract(payload,'$.message_id') AS TEXT)=? ORDER BY cursor LIMIT 1").get(row.id,sourceMessageId);if(!event)throw fail('QQ_NATIVE_EVENT_MISSING');return {raw:JSON.parse(event.payload),account:copy(row.account)};}
  async function request(payload,scope,{signal,check=async()=>{},memoryContext}={}){
    await check();signal?.throwIfAborted();
    if(payload.platform==='bilibili'){
      const a=account(payload.connectionRef,payload.accountId);if(a.platform!=='bilibili')throw fail('SOCIAL_ACCOUNT_PLATFORM_MISMATCH');const {url,method}=biliRequestPolicy(payload,a);
      const headers={'user-agent':'AI-Buddy/2.0.0','referer':'https://www.bilibili.com/'},form=payload.form?{...payload.form}:undefined;
      if(payload.credentialBinding){headers.cookie=accounts.secret(a.ref).cookie??'';if(form){const csrf=headers.cookie.split(';').map(v=>v.trim().split('=')).find(v=>v[0]==='bili_jct')?.[1];if(!csrf)throw fail('BILI_CSRF_REQUIRED');form.csrf=csrf;form.csrf_token=csrf;}}
      if(form)headers['content-type']='application/x-www-form-urlencoded';
      const run=async()=>{await check();if(account(a.ref).generation!==a.generation)throw fail('SOCIAL_ACCOUNT_CHANGED');const response=await fetchImpl(url,{method,headers,body:form?new URLSearchParams(form):undefined,redirect:'error',signal:linked(signal)});const body=await responseBody(response,biliResponseLimit(payload,url,[...observations.values()].filter(o=>hash(o.scope)===hash(scopeCopy(scope)))));const observationId=keep(scope,{kind:'bilibili-http',url:url.href,method,status:response.status,body});return {status:response.status,body,observationId};};
      if(method==='POST'){if(!payload.idempotencyKey)throw fail('SOCIAL_SEND_ID_REQUIRED');return submit(hash([scope.pluginId,a.ref,payload.idempotencyKey]),{url:url.href,form,scope:scopeCopy(scope)},run);}return run();
    }
    const row=connectionScope(connection(payload.connectionId),scope),a=row.account;if(payload.accountId!==a.accountId)throw fail('SOCIAL_CONNECTION_SCOPE_DENIED');
    if(payload.action==='get_msg'){
      const actual=inbound(row.id,scope.sourceMessageId,scope).raw,reply=parseQqMessageSegments(actual.message).find(s=>s.type==='reply');
      if(!reply||String(reply.data?.id)!==String(payload.params?.message_id))throw fail('QQ_QUOTE_SCOPE_DENIED');return qqCall(a,'get_msg',payload.params,signal);
    }
    const type=scope.conversationType,action=type==='private'?'send_private_msg':type==='group'?'send_group_msg':null,field=type==='private'?'user_id':'group_id';
    if(!action||payload.action!==action||String(payload.params?.[field])!==scope.peerId||!payload.requestId||!Array.isArray(payload.params?.message)||payload.params.message.some(v=>v.type!=='text'||typeof v.data?.text!=='string')||JSON.stringify(payload.params).length>200000)throw fail('QQ_SEND_SCOPE_DENIED');
    return submit(hash([scope.pluginId,a.ref,payload.requestId]),{action,params:payload.params,scope:scopeCopy(scope)},async()=>{await check();const result=await qqCall(a,action,payload.params,signal);const messageId=result?.message_id==null?null:String(result.message_id);if(!messageId)return {status:'unknown'};const observationId=keep(scope,{kind:'qq-send',requestId:payload.requestId,messageId,text:payload.params.message.map(v=>v.data.text).join(''),occurredAt:now()});return {status:'sent',messageId,observationId};},memoryContext);
  }
  async function closeConnection(id){const row=connections.get(id);if(!row)return {closed:true};row.closed=true;row.socket?.close();do{flushInbox(row);if(row.pending.length&&!row.storageFailure)await new Promise(setImmediate);}while(row.pending.length&&!row.storageFailure);notify(row);if(row.storageFailure&&row.pending.length)throw fail('QQ_EVENT_STORAGE_FAILED');connections.delete(id);return {closed:true};}
  const unsubscribe=accounts.subscribe(({ref})=>{for(const row of connections.values())if(row.account.ref===ref)void closeConnection(row.id);});
  function qqMemoryList({pluginId=null,accountRef=null,pending=false,due=Number.MAX_SAFE_INTEGER,requestIds=null,limit=100}={}){if(closed)throw fail('SOCIAL_TRANSPORT_CLOSED');return db.prepare("SELECT * FROM qq_memory_intents WHERE (? IS NULL OR json_extract(proof_json,'$.context.pluginId')=?) AND (? IS NULL OR json_extract(proof_json,'$.accountRef')=?) AND (?=0 OR state='pending' AND next_at<=?) AND (? IS NULL OR json_extract(proof_json,'$.requestId') IN (SELECT value FROM json_each(?))) ORDER BY rowid LIMIT ?").all(pluginId,pluginId,accountRef,accountRef,pending?1:0,due,requestIds?JSON.stringify(requestIds.slice(0,200)):null,requestIds?JSON.stringify(requestIds.slice(0,200)):null,Math.min(1000,Math.max(1,limit))).map(row=>({...row,proof:JSON.parse(row.proof_json)}));}
  function qqMemoryState(id){if(closed)throw fail('SOCIAL_TRANSPORT_CLOSED');return db.prepare('SELECT state FROM qq_memory_intents WHERE id=?').get(id)?.state??null;}
  function qqMemoryUpdate(id,{state,eventRef,attempts,nextAt,error,expectedState=null}={}){if(closed)throw fail('SOCIAL_TRANSPORT_CLOSED');const row=db.prepare('SELECT * FROM qq_memory_intents WHERE id=?').get(id);if(!row)throw fail('QQ_MEMORY_PROOF_MISSING');db.prepare("UPDATE qq_memory_intents SET state=?,event_ref=?,attempts=?,next_at=?,last_error=? WHERE id=? AND state!='committed' AND (? IS NULL OR state=?)").run(state??row.state,eventRef??row.event_ref,attempts??row.attempts,nextAt??row.next_at,error??null,id,expectedState,expectedState);}
  function qqMemoryImport(context,observed,{eventRef=null,occurredAt,committed=false}={}){
   if(closed)throw fail('SOCIAL_TRANSPORT_CLOSED');if(observed?.kind!=='qq-send'||!context?.account?.ref||!observed.requestId||!observed.messageId||typeof observed.text!=='string'||!Number.isFinite(occurredAt))throw fail('QQ_MEMORY_LEGACY_PROOF_INCOMPLETE');
   const id=hash([context.pluginId,context.account.ref,observed.requestId]),send=db.prepare("SELECT * FROM sends WHERE id=? AND state='completed'").get(id);if(!send)throw fail('QQ_MEMORY_LEGACY_PROOF_INCOMPLETE');
   const result=JSON.parse(send.result),type=context.conversationType,field=type==='private'?'user_id':'group_id',expected=hash({action:'send_'+type+'_msg',params:{message:[{type:'text',data:{text:observed.text}}],[field]:context.peerId},scope:scopeCopy(context)});
   if(result.status!=='sent'||result.messageId!==observed.messageId||result.observationId!==observed.observationId&&observed.observationId!==undefined||send.digest!==expected||hash(scopeCopy(observed.scope??{}))!==hash(scopeCopy(context)))throw fail('QQ_MEMORY_LEGACY_PROOF_INCOMPLETE');
   if(db.prepare('SELECT id FROM qq_memory_intents WHERE send_id=?').get(id))return;
   return persistIntent(id,{version:1,context:memoryContextCopy(context),accountRef:context.account.ref,requestId:observed.requestId,messageId:observed.messageId,text:observed.text,occurredAt,observationId:result.observationId,sendDigest:send.digest},{eventRef,state:committed?'committed':'pending'});
  }
  return {open,events,inbound,request,qqMemoryList,qqMemoryState,qqMemoryUpdate,qqMemoryImport,observation:id=>copy(observations.get(id)??null),async closeConnection(id,scope){const row=connections.get(id);if(row&&scope.pluginId!==row.scope.pluginId)throw fail('SOCIAL_CONNECTION_SCOPE_DENIED');return closeConnection(id);},async close(){if(closed)return;closed=true;unsubscribe();await Promise.all([...connections.keys()].map(closeConnection));await Promise.allSettled(writes.values());observations.clear();db.close();}};
}
