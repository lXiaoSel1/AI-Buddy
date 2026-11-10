import {randomUUID} from 'node:crypto';

const fail=code=>Object.assign(Error(code),{code});
export const SOCIAL_LOGIN_PLUGINS=Object.freeze({bilibili:'@ai-buddy/bilibili-companion',qq:'@ai-buddy/qq-connect'});
const active=new Set(['preparing','waiting-qr','waiting-confirmation','verifying','cleaning-up']);
function preparationDiagnostic(cause){
 if(cause?.code!=='QQ_COMPONENT_COMMIT_RENAME'||!['EPERM','EACCES','EBUSY'].includes(cause.systemCode)||cause.syscall!=='rename'||!/^stage-[a-f0-9-]{36}$/.test(cause.source??'')||!/^napcat-\d+\.\d+\.\d+$/.test(cause.target??''))return {};
 return {errorDiagnostic:{systemCode:cause.systemCode,syscall:'rename',source:cause.source,target:cause.target}};
}
// Only this coordinator may commit a verified identity. A cancelled driver can
// finish late, but never creates or replaces a managed account.
export function createSocialLogin({accounts,drivers,onUpdate=()=>{},now=Date.now}={}){
 const rows=new Map();let closed=false,requestedPlatform=null,requestId=null;
 function valid(platform){if(!Object.hasOwn(SOCIAL_LOGIN_PLUGINS,platform))throw fail('SOCIAL_LOGIN_PLATFORM_INVALID');if(closed)throw fail('SOCIAL_LOGIN_CLOSED');}
 function status(platform){valid(platform);const row=rows.get(platform);return row?structuredClone(row.public):{platform,phase:'not-connected'};}
 function publish(row,patch){row.public={...row.public,...patch,updatedAt:now()};onUpdate();}
 function current(row){return !closed&&rows.get(row.platform)===row&&!row.abort.signal.aborted;}
 function fingerprint(platform){return JSON.stringify(accounts.list().filter(row=>row.pluginId===SOCIAL_LOGIN_PLUGINS[platform]).map(({ref,accountId,enabled,generation})=>({ref,accountId,enabled,generation})));}
 function start(platform,options={}){
  const {official=false,retryAttemptId}=options;let expectedAccountId=options.expectedAccountId??null;
  valid(platform);const previous=rows.get(platform);
  if(typeof official!=='boolean'||retryAttemptId!==undefined&&!official)throw fail('SOCIAL_LOGIN_RETRY_STALE');
  if(official){
   if(platform!=='qq'||!previous||previous.draining||previous.public.phase!=='failed'||previous.public.errorCode!=='NETWORK_MIRROR_MISMATCH'||previous.public.retryOfficial!==true||retryAttemptId!==previous.public.attemptId||previous.fingerprint!==fingerprint(platform)||options.expectedAccountId!==undefined&&expectedAccountId!==previous.expectedAccountId)throw fail('SOCIAL_LOGIN_RETRY_STALE');
   expectedAccountId=previous.expectedAccountId;
  }
  if(previous?.draining||previous&&active.has(previous.public.phase))return status(platform);
  if(expectedAccountId!==null&&(typeof expectedAccountId!=='string'||!/^\d{1,20}$/.test(expectedAccountId)))throw fail('SOCIAL_LOGIN_ACCOUNT_INVALID');
  const row={platform,expectedAccountId,fingerprint:fingerprint(platform),abort:new AbortController(),public:{platform,attemptId:randomUUID(),phase:'preparing',startedAt:now()}};
  rows.set(platform,row);onUpdate();
  row.pending=Promise.resolve().then(async()=>{
   const result=await drivers[platform].start({attemptId:row.public.attemptId,signal:row.abort.signal,expectedAccountId,official,update:patch=>{
    if(!current(row))return;const safe={};
    if(active.has(patch.phase))safe.phase=patch.phase;
    if(typeof patch.qr==='string'&&/^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(patch.qr)&&patch.qr.length<200000)safe.qr=patch.qr;
    if(Number.isFinite(patch.downloadedBytes))safe.downloadedBytes=patch.downloadedBytes;
    if(Number.isFinite(patch.totalBytes))safe.totalBytes=patch.totalBytes;
    if(patch.clearQr)safe.qr=undefined;
    publish(row,safe);
   }});
   if(!current(row)){await drivers[platform].discard?.(result);return;}
   if(!result||!/^\d{1,20}$/.test(result.accountId)||!result.label||expectedAccountId&&result.accountId!==expectedAccountId)throw fail('SOCIAL_LOGIN_IDENTITY_MISMATCH');
   if(fingerprint(platform)!==row.fingerprint)throw fail('SOCIAL_LOGIN_CONNECTION_CHANGED');
   const account=accounts.commitLogin({...result,pluginId:SOCIAL_LOGIN_PLUGINS[platform]});
   // commitLogin is synchronous, so cancellation cannot interleave its transaction.
   row.result=result;publish(row,{phase:'connected',account:{ref:account.ref,accountId:account.accountId,label:account.label,avatar:account.avatar},qr:undefined});
   const completion=await drivers[platform].committed?.(result,account);
   if(current(row))publish(row,{phase:'connected',account:{ref:account.ref,accountId:account.accountId,label:account.label,avatar:account.avatar},qr:undefined,...completion?.warningCode?{errorCode:completion.warningCode}:{}});
  }).catch(async cause=>{
   if(!current(row))return;
   row.draining=true;publish(row,{phase:'cleaning-up',qr:undefined});
   try{await drivers[platform].stop?.({attemptId:row.public.attemptId});row.draining=false;}catch{publish(row,{phase:'failed',errorCode:'SOCIAL_LOGIN_STOP_PENDING'});return;}
   if(current(row)){
    const errorCode=typeof cause?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(cause.code)?cause.code:'SOCIAL_LOGIN_FAILED',host=cause?.host??cause?.details?.host;
    publish(row,{phase:errorCode==='SOCIAL_LOGIN_EXPIRED'?'needs-login':errorCode==='SOCIAL_LOGIN_CANCELLED'?'cancelled':'failed',errorCode,...preparationDiagnostic(cause),retryOfficial:platform==='qq'&&!official&&errorCode==='NETWORK_MIRROR_MISMATCH'&&cause?.retryOfficial===true,...typeof host==='string'&&/^[a-zA-Z0-9.-]{1,253}$/.test(host)?{errorHost:host}:{}});
   }
  });
  return status(platform);
 }
 async function cancel(platform){valid(platform);const row=rows.get(platform);if(row){row.abort.abort();row.draining=true;publish(row,{phase:'cleaning-up',qr:undefined});try{await drivers[platform].stop?.({attemptId:row.public.attemptId});row.draining=false;publish(row,{phase:'cancelled'});}catch{publish(row,{phase:'failed',errorCode:'SOCIAL_LOGIN_STOP_PENDING'});throw fail('SOCIAL_LOGIN_STOP_PENDING');}}return status(platform);}
 async function refresh(platform){valid(platform);const row=rows.get(platform);if(!row||!active.has(row.public.phase))throw fail('SOCIAL_LOGIN_NOT_PENDING');await drivers[platform].refresh?.({attemptId:row.public.attemptId});return status(platform);}
 return {start,status,cancel,refresh,
  async check(ref,{signal}={}){signal?.throwIfAborted();const account=accounts.get(ref);if(!account?.enabled)throw fail('SOCIAL_ACCOUNT_REQUIRED');valid(account.platform);const existing=rows.get(account.platform);if(existing&&active.has(existing.public.phase))throw fail('SOCIAL_LOGIN_BUSY');const result=await drivers[account.platform].check(account,accounts.secret(ref),{signal});signal?.throwIfAborted();if(closed||accounts.get(ref)?.generation!==(result?.generation??account.generation))throw fail('SOCIAL_LOGIN_CONNECTION_CHANGED');return {connected:true,accountId:account.accountId};},
  async disconnect(platform){await cancel(platform);await drivers[platform].stop?.();return status(platform);},
  request(platform){valid(platform);requestedPlatform=platform;requestId=randomUUID();onUpdate();return {opened:true,platform};},
  snapshot(){return {requestedPlatform,requestId,states:Object.keys(SOCIAL_LOGIN_PLUGINS).map(status)};},
  async close(){if(closed)return;closed=true;for(const row of rows.values())row.abort.abort();await Promise.all(Object.values(drivers).map(driver=>driver.close?.()??driver.stop?.()));},
 };
}
