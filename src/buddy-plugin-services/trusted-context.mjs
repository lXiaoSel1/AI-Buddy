import {randomBytes} from 'node:crypto';
import {SOCIAL_IDENTITY_FIELDS,validateSocialScope} from './social-contract.mjs';

export const BUDDY_BRIDGE_VERSION='buddy-bridge-v1';
export const contextFailure=(message,code='BUDDY_CONTEXT_DENIED')=>Object.assign(Error(message),{code});
export const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identityFields=['characterId','personaId','lifeId','operationId','sessionId','taskId','contextRevision'];
const id=(value,name,optional=false)=>{if(optional&&value==null)return null;if(typeof value!=='string'||!value||value.length>300||value.includes('\0'))throw contextFailure('Invalid trusted '+name);return value;};
const clone=value=>structuredClone(value);
function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
export function validateIdentityClaims(value,context){
  if(!plain(value))throw contextFailure('Plugin payload must be an object');
  for(const key of identityFields)if(Object.hasOwn(value,key)&&value[key]!==context[key])throw contextFailure('Plugin cannot change trusted '+key);
  for(const key of SOCIAL_IDENTITY_FIELDS)if(Object.hasOwn(value,key)&&JSON.stringify(value[key])!==JSON.stringify(context[key]))throw contextFailure('Plugin cannot change trusted '+key);
  if(value.scope!=null){if(!plain(value.scope))throw contextFailure('Invalid identity scope');validateIdentityClaims(value.scope,context);}
  if(value.workspace!=null&&JSON.stringify(value.workspace)!==JSON.stringify(context.workspace))throw contextFailure('Plugin cannot change trusted workspace');
  if(value.workspaceId!=null&&value.workspaceId!==context.workspace?.id)throw contextFailure('Plugin cannot change trusted workspace');
  if(Object.hasOwn(value,'planState')&&value.planState!==context.planState)throw contextFailure('Plugin cannot change trusted planning state');
  if(Object.hasOwn(value,'readOnlyToolNames')&&JSON.stringify(value.readOnlyToolNames)!==JSON.stringify(context.readOnlyToolNames))throw contextFailure('Plugin cannot change trusted read-only tools');
  if(Object.hasOwn(value,'approvedPlanRevision')&&value.approvedPlanRevision!==context.approvedPlanRevision)throw contextFailure('Plugin cannot change trusted plan approval');
}
/** Tokens are issued only by the host. No identity is reconstructed from a plugin request. */
export function createTrustedContextAuthority({resolveContext,now=Date.now,defaultTtlMs=300000,maxTtlMs=3600000}={}){
  if(typeof resolveContext!=='function')throw contextFailure('A host context resolver is required');
  const tokens=new Map(),activeCalls=new Map();let closed=false;
  function revoke(token){const record=tokens.get(token);if(!record)return false;tokens.delete(token);record.cleanup?.();if(record.activeCallKey&&activeCalls.get(record.activeCallKey)===token)activeCalls.delete(record.activeCallKey);return true;}
  function assertCurrentToken(token,record){if(closed||tokens.get(token)!==record||record.signal?.aborted)throw contextFailure('Plugin context was revoked','BUDDY_CONTEXT_EXPIRED');if(record.expiresAt!==null&&now()>=record.expiresAt){revoke(token);throw contextFailure('Plugin context expired','BUDDY_CONTEXT_EXPIRED');}}
  async function resolve(hostSpec){
    const raw=await resolveContext(clone(hostSpec));if(!plain(raw))throw contextFailure('Host context is unavailable');
    const result={};for(const key of ['characterId','personaId','lifeId','operationId','sessionId'])result[key]=id(raw[key],key);
    result.taskId=id(raw.taskId,'taskId',true);
    if(!(Number.isSafeInteger(raw.contextRevision)&&raw.contextRevision>=0)&&!(typeof raw.contextRevision==='string'&&raw.contextRevision&&raw.contextRevision.length<=300))throw contextFailure('Trusted context revision is required');
    result.contextRevision=raw.contextRevision;
    if(!Array.isArray(raw.permissionScope)||raw.permissionScope.some(v=>typeof v!=='string'||!v))throw contextFailure('Trusted permission scope is required');
    result.permissionScope=[...new Set(raw.permissionScope)];
    if(raw.workspace!=null){if(!plain(raw.workspace)||typeof raw.workspace.id!=='string'||typeof raw.workspace.path!=='string')throw contextFailure('Invalid trusted workspace');result.workspace=clone(raw.workspace);}
    result.connectionRefs=[...new Set(raw.connectionRefs??[])];if(result.connectionRefs.some(v=>typeof v!=='string'||!v))throw contextFailure('Invalid trusted connection references');
    // Only a host resolver can attest execution approval. Missing state is
    // deliberately planning; a plugin cannot choose execution through payloads.
    if(raw.planState!=null&&!['planning','execution'].includes(raw.planState))throw contextFailure('Invalid trusted planning state');
    result.planState=raw.planState??'planning';
    if(raw.readOnlyToolNames!=null&&(!Array.isArray(raw.readOnlyToolNames)||raw.readOnlyToolNames.length>1000||raw.readOnlyToolNames.some(v=>typeof v!=='string'||!v||v.length>300)))throw contextFailure('Invalid trusted read-only tools');
    result.readOnlyToolNames=[...new Set(raw.readOnlyToolNames??[])];
    result.approvedPlanRevision=id(raw.approvedPlanRevision,'approvedPlanRevision',true);
    if(raw.contextKind==='social'){
      for(const key of SOCIAL_IDENTITY_FIELDS)result[key]=clone(raw[key]);
      validateSocialScope(result);
    }else if(raw.contextKind!=null&&raw.contextKind!=='work')throw contextFailure('Unknown trusted context kind');
    return result;
  }
  async function issue(hostSpec){
    if(closed||!plain(hostSpec))throw contextFailure('Context authority is unavailable');id(hostSpec.pluginId,'pluginId');
    const ttl=hostSpec.ttlMs??defaultTtlMs;if(!Number.isSafeInteger(ttl)||ttl<=0||ttl>maxTtlMs)throw contextFailure('Invalid context expiration');
    const spec=clone(hostSpec),context=await resolve(spec);if(closed)throw contextFailure('Context authority is closed');
    const token=randomBytes(32).toString('base64url'),issuedAt=now(),record={pluginId:hostSpec.pluginId,context:freeze(context),hostSpec:freeze(spec),issuedAt,expiresAt:issuedAt+ttl};tokens.set(token,record);
    return {contextToken:token,pluginId:record.pluginId,context:clone(record.context),issuedAt,expiresAt:record.expiresAt,version:BUDDY_BRIDGE_VERSION};
  }
  /** Host-only active native call lease. Neither payload fields nor issue()
   * select this mode; a live host AbortSignal and authority closure are required. */
  async function issueActiveCall(hostSpec,{callId,signal,checkCurrent,onRevoke}={}){
    if(closed||!plain(hostSpec))throw contextFailure('Context authority is unavailable');id(hostSpec.pluginId,'pluginId');id(callId,'active call id');
    if(!(signal instanceof AbortSignal)||signal.aborted||typeof checkCurrent!=='function'||onRevoke!==undefined&&typeof onRevoke!=='function')throw contextFailure('A live host call and authority guard are required','BUDDY_ACTIVE_CALL_REQUIRED');
    const activeCallKey=hostSpec.pluginId+'\0'+callId;if(activeCalls.has(activeCallKey))throw contextFailure('This native call already owns an active context','BUDDY_ACTIVE_CALL_CONFLICT');
    const spec=clone(hostSpec);await checkCurrent();const context=await resolve(spec);await checkCurrent();
    if(closed||signal.aborted)throw contextFailure('Native call ended before context admission','BUDDY_CONTEXT_EXPIRED');if(activeCalls.has(activeCallKey))throw contextFailure('This native call already owns an active context','BUDDY_ACTIVE_CALL_CONFLICT');
    const token=randomBytes(32).toString('base64url'),issuedAt=now(),record={pluginId:hostSpec.pluginId,context:freeze(context),hostSpec:freeze(spec),issuedAt,expiresAt:null,activeCallKey,callId,signal,checkCurrent};
    const abort=()=>revoke(token);record.cleanup=()=>{signal.removeEventListener('abort',abort);onRevoke?.();};tokens.set(token,record);activeCalls.set(activeCallKey,token);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){revoke(token);throw contextFailure('Native call ended before context admission','BUDDY_CONTEXT_EXPIRED');}
    return {contextToken:token,pluginId:record.pluginId,context:clone(record.context),issuedAt,expiresAt:null,activeCallId:callId,version:BUDDY_BRIDGE_VERSION};
  }
  function releaseActiveCall(token,{pluginId,callId}={}){const record=tokens.get(token);if(!record)return false;if(!record.activeCallKey||record.pluginId!==pluginId||record.callId!==callId)throw contextFailure('Active context release does not match its host call');return revoke(token);}
  async function verify(token,{pluginId,payload={}}={}){
    const record=tokens.get(token);if(closed||!record||record.pluginId!==pluginId)throw contextFailure('Unknown or mismatched plugin context');
    assertCurrentToken(token,record);
    if(record.checkCurrent)try{await record.checkCurrent();}catch(error){revoke(token);throw error;}
    const actual=await resolve(record.hostSpec);
    assertCurrentToken(token,record);
    for(const key of identityFields)if(actual[key]!==record.context[key]){if(record.activeCallKey)revoke(token);throw contextFailure('Trusted identity or life changed','BUDDY_CONTEXT_STALE');}
    for(const key of SOCIAL_IDENTITY_FIELDS)if(JSON.stringify(actual[key])!==JSON.stringify(record.context[key])){revoke(token);throw contextFailure('Trusted social identity or generation changed','BUDDY_CONTEXT_STALE');}
    if(JSON.stringify(actual.workspace)!==JSON.stringify(record.context.workspace)||JSON.stringify(actual.permissionScope)!==JSON.stringify(record.context.permissionScope)||JSON.stringify(actual.connectionRefs)!==JSON.stringify(record.context.connectionRefs)||actual.planState!==record.context.planState||JSON.stringify(actual.readOnlyToolNames)!==JSON.stringify(record.context.readOnlyToolNames)||actual.approvedPlanRevision!==record.context.approvedPlanRevision){if(record.activeCallKey)revoke(token);throw contextFailure('Trusted context permissions changed','BUDDY_CONTEXT_STALE');}
    validateIdentityClaims(payload,record.context);return clone({...record.context,pluginId,issuedAt:record.issuedAt,expiresAt:record.expiresAt});
  }
  function revokePlugin(pluginId){for(const[token,value]of tokens)if(value.pluginId===pluginId)revoke(token);}
  function revokeSession(sessionId){for(const[token,value]of tokens)if(value.context.sessionId===sessionId)revoke(token);}
  return {issue,issueActiveCall,releaseActiveCall,verify,revokePlugin,revokeSession,revoke,close(){closed=true;for(const token of tokens.keys())revoke(token);},size:()=>tokens.size,activeCalls:()=>activeCalls.size};
}
