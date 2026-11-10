import {randomBytes,createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join,toNamespacedPath} from 'node:path';
import {modelNotSubmittedError} from './social-runtime-journal.mjs';

const fail=(code,message=code)=>Object.assign(Error(message),{code});
const key=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
const same=(a,b)=>a?.runtimeId===b?.runtimeId&&a?.profileId===b?.profileId&&a?.pid===b?.pid;

/** Core private admission, not a second model/work executor. A runtime supplies
 * exact installed identities; an HTTP body cannot select a source or account.
 * Missing implementations are excluded from the capability advertisement. */
export function createNativeSocialFacade({dataRoot,contract,handlers,authorizeUI,resolveGrant,contextProvider,features=[],now=Date.now}={}){
  if(!contract?.hash||!Array.isArray(contract.methods)||typeof authorizeUI!=='function'||typeof resolveGrant!=='function'||typeof contextProvider!=='function')throw TypeError('Native social host dependencies required');
  const sessions=new Map(),principals=new Map();let closed=false;
  const available=contract.methods.filter(name=>typeof handlers?.[name]==='function');
  function prunePrincipals(){for(const [token,p]of principals)if(p.expiresAt<=now()||!sessions.has(p.session))principals.delete(token);}
  function session(token,origin){const row=sessions.get(token);if(closed||!row||!same(row.origin,origin))throw fail('SOCIAL_RUNTIME_SCOPE_DENIED');return row;}
  async function granted(row,method){
    const grant=await resolveGrant(row.identity);
    if(!grant?.enabled||grant.sourceDigest!==row.identity.sourceDigest||grant.exactVersion!==row.identity.exactVersion||!grant.granted?.includes(method))throw fail('BUDDY_CAPABILITY_DENIED');
    return grant;
  }
  function principal(row,token){const value=principals.get(token);if(!value||value.session!==row.token||value.expiresAt<=now())throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');return value;}
  async function open({identity,origin,contractHash}){
    if(closed)throw fail('SOCIAL_HOST_CLOSED');
    if(sessions.size>=64)throw fail('SOCIAL_SESSION_LIMIT');
    if(contractHash!==contract.hash)throw fail('SOCIAL_CONTRACT_MISMATCH');
    if(!identity?.pluginId||!identity.packageName||!identity.exactVersion||!/^[a-f0-9]{64}$/.test(identity.sourceDigest??'')||!origin?.runtimeId||!origin.profileId||!Number.isSafeInteger(origin.pid))throw fail('SOCIAL_PACKAGE_IDENTITY_REQUIRED');
    // Native bootstrap is allowed before enable finishes; no capability or
    // identity authority is issued here. Every later call checks live grants.
    const token=key(),directory=join(dataRoot,'plugin-data','social-v1',digest([identity.pluginId,identity.sourceId??identity.pluginId]));
    await mkdir(directory,{recursive:true});if(closed)throw fail('SOCIAL_HOST_CLOSED');
    const row={token,identity:clone(identity),origin:clone(origin),pending:new Set(),events:[],waiters:new Set(),closing:false};sessions.set(token,row);
    return {sessionToken:token,dataDirectory:process.platform==='win32'?toNamespacedPath(directory):directory,description:{mode:'runtime',pluginId:identity.packageName,contractHash:contract.hash,capabilities:available,features:[...features],contractAcknowledgement:{owner:'B',hash:contract.hash},missingCapabilities:contract.methods.filter(name=>!available.includes(name))}};
  }
  async function dispatch({sessionToken,method,payload={}},origin,{signal}={}){
    const row=session(sessionToken,origin);if(row.closing&&method!=='close')throw fail('SOCIAL_HOST_CLOSED');
    if(method==='close'){row.closing=true;for(const pending of row.pending)pending.controller.abort();for(const notify of row.waiters)notify();await Promise.allSettled([...row.pending].map(p=>p.promise));sessions.delete(row.token);for(const [id,p]of principals)if(p.session===row.token)principals.delete(id);return {closed:true};}
    if(method==='authorize'){
      prunePrincipals();if(principals.size>=4096)throw fail('SOCIAL_PRINCIPAL_LIMIT');
      await granted(row,'social.context.read');
      if(await authorizeUI({identity:row.identity,origin:row.origin,request:payload.request,action:payload.action})!==true)throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');
      const value={session:row.token,kind:'app',expiresAt:now()+300000,action:payload.action},contextToken=key();principals.set(contextToken,value);return {contextToken};
    }
    if(method==='events'){
      await granted(row,'social.context.read');
      if(!row.events.length&&!signal?.aborted)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);row.waiters.delete(done);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,Math.min(20000,Math.max(0,payload.waitMs??20000)));row.waiters.add(done);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
      signal?.throwIfAborted();if(row.closing)throw fail('SOCIAL_HOST_CLOSED');await granted(row,'social.context.read');return {events:row.events.splice(0,50)};
    }
    if(!available.includes(method))throw fail('SOCIAL_CAPABILITY_UNAVAILABLE',method);
    if(row.pending.size>=64)throw fail('SOCIAL_REQUEST_LIMIT');
    let grant;try{grant=await granted(row,method);}catch(error){throw method==='models.request'&&payload.visualMaterialRefs!==undefined?modelNotSubmittedError():error;}const controller=new AbortController(),combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    const check=async()=>{combined.throwIfAborted();if(row.closing||session(row.token,origin)!==row)throw fail('SOCIAL_HOST_CLOSED');const live=await granted(row,method);if(live.generation!==grant.generation)throw fail('BUDDY_PLUGIN_DISABLED');};
    const request=clone(payload);
    // Only opaque, Core-issued UI principals may bootstrap a management or
    // activity context. Body-supplied owner/identity/permission claims are data.
    let authority;
    if(method==='social.context.read'&&request.principal){authority=principal(row,request.principal.contextToken);delete request.principal;}
    const pending={controller};
    pending.promise=Promise.resolve().then(async()=>{let handlerStarted=false;try{await check();const context=await contextProvider({identity:row.identity,method,payload:request,authority:authority?clone(authority):null,signal:combined,check});await check();handlerStarted=true;return await handlers[method]({identity:row.identity,context,payload:request,signal:combined,check});}catch(error){throw method==='models.request'&&request.visualMaterialRefs!==undefined&&!handlerStarted?modelNotSubmittedError():error;}});
    row.pending.add(pending);try{return await pending.promise;}finally{row.pending.delete(pending);}
  }
  function emit(identity,event){
    prunePrincipals();
    for(const row of sessions.values())if(row.identity.pluginId===identity.pluginId&&!row.closing){
      if(principals.size>=4096)continue;
      const contextToken=key();principals.set(contextToken,{session:row.token,kind:'background',expiresAt:now()+60000});
      if(row.events.length>=100)row.events.shift();row.events.push({...clone(event),principal:{contextToken}});for(const notify of row.waiters)notify();
    }
    for(const [token,p]of principals)if(p.expiresAt<=now())principals.delete(token);
  }
  async function close(){if(closed)return;for(const row of [...sessions.values()])await dispatch({sessionToken:row.token,method:'close'},row.origin);closed=true;principals.clear();}
  return {open,dispatch,emit,close,available:()=>[...available]};
}
