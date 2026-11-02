import {createHash,randomUUID} from 'node:crypto';
import {BUDDY_BRIDGE_VERSION,createTrustedContextAuthority,contextFailure,plain,validateIdentityClaims} from './trusted-context.mjs';
import {createCapabilityGrantRegistry} from './capability-grants.mjs';
import {createModelReferenceBroker,sanitizePluginValue} from './model-broker.mjs';

export {BUDDY_BRIDGE_VERSION,createTrustedContextAuthority,validateIdentityClaims} from './trusted-context.mjs';
export {BUDDY_PLUGIN_CAPABILITIES,createCapabilityGrantRegistry} from './capability-grants.mjs';
export {createModelReferenceBroker,sanitizePluginValue} from './model-broker.mjs';
export {createColdWorkArchiveBridge} from './cold-work-archive.mjs';
const methods=Object.freeze({'character.context':'characters.getContext','characters.getContext':'characters.getContext','model.request':'models.request','models.request':'models.request','memory.appendEvent':'memory.appendEvent','usage.record':'usage.record','notifications.publish':'notifications.publish','pages.register':'ui.registerPage','ui.registerPage':'ui.registerPage','lifecycle.register':'lifecycle.register'});
const identity=context=>Object.fromEntries(['characterId','personaId','lifeId','operationId'].map(key=>[key,context[key]]));
const stable=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireText(value,name,max=200000){if(typeof value!=='string'||!value.trim()||value.length>max)throw contextFailure('Invalid '+name,'BUDDY_REQUEST_INVALID');return value;}
function safePayload(value){if(!plain(value)||Buffer.byteLength(JSON.stringify(value))>1024*1024)throw contextFailure('Invalid plugin request payload','BUDDY_REQUEST_INVALID');return structuredClone(value);}
function defaultResolve(getGame){return async spec=>{
  const game=getGame?.();if(!game?.workScope)throw contextFailure('Character authority is unavailable','BUDDY_SERVICE_UNAVAILABLE');
  return {...spec,...await game.workScope(spec.characterId,spec.personaId)};
};}
/** Host-only authority is deliberately separate from the serializable invoke surface. */
export function createBuddyPluginServices({resolveContext,getGame=()=>null,getProvider=()=>null,getCharacterContext,onEvidence=null,onUsage=null,onNotification=null,registerPage=null,registerLifecycle=null,hostServices={},now=Date.now}={}){
  const authority=createTrustedContextAuthority({resolveContext:resolveContext??defaultResolve(getGame),now}),grants=createCapabilityGrantRegistry({now}),broker=createModelReferenceBroker({getProvider});
  const controllers=new Map(),pendingCalls=new Map(),registrations=new Map(),evidence=new Map(),usageEvidence=new Map(),usageRequests=new Map(),commits=new Map();let closed=false;
  async function authorize({pluginId,contextToken,capability,payload={}}){
    if(closed)throw contextFailure('Buddy plugin services are closed','BUDDY_SERVICE_CLOSED');
    const context=await authority.verify(contextToken,{pluginId,payload});const generation=grants.require(pluginId,capability,context);return {context,generation};
  }
  async function checkAuthorization(spec){const result=await authorize(spec);if(spec.generation!=null&&result.generation!==spec.generation)throw contextFailure('Plugin activation changed','BUDDY_PLUGIN_DISABLED');return result;}
  async function issueActiveContext(spec,lease){
    const grant=grants.get(spec?.pluginId);if(!grant?.enabled)throw contextFailure('Plugin is not enabled','BUDDY_PLUGIN_DISABLED');
    for(const capability of spec.permissionScope??[])grants.require(spec.pluginId,capability,{permissionScope:spec.permissionScope});
    const check=lease?.checkCurrent;
    if(typeof check!=='function')throw contextFailure('A host active-call authority guard is required','BUDDY_ACTIVE_CALL_REQUIRED');
    return authority.issueActiveCall(spec,{...lease,checkCurrent:async()=>{grants.assertGeneration(spec.pluginId,grant.generation);await check();grants.assertGeneration(spec.pluginId,grant.generation);}});
  }
  const evidenceKey=(pluginId,id)=>pluginId+'\0'+id;
  async function registerEvidenceInto(target,{pluginId,contextToken,evidence:raw}){
    const context=await authority.verify(contextToken,{pluginId});const value=safePayload(raw);validateIdentityClaims(value,context);
    const evidenceContext=Object.fromEntries(['characterId','personaId','lifeId','operationId','sessionId','taskId','contextRevision','workspace'].filter(key=>context[key]!==undefined).map(key=>[key,structuredClone(context[key])]));
    const id=requireText(value.id??value.evidenceId,'evidence id',300),key=evidenceKey(pluginId,id),record={...sanitizePluginValue(value),id,pluginId,context:evidenceContext};
    const old=target.get(key);if(old&&stable(old)!==stable(record))throw contextFailure('Evidence identity cannot be reused with different content','BUDDY_EVIDENCE_CONFLICT');
    target.set(key,record);return {evidenceId:id};
  }
  function resolveEvidence(target,pluginId,id,context){
    const record=target.get(evidenceKey(pluginId,requireText(id,'evidence reference',300)));if(!record)throw contextFailure('Host evidence reference is unavailable','BUDDY_EVIDENCE_MISSING');
    for(const key of ['characterId','personaId','lifeId','operationId','sessionId','taskId'])if(record.context[key]!==context[key])throw contextFailure('Evidence belongs to another character, life or session','BUDDY_CONTEXT_DENIED');
    return record;
  }
  async function once(key,fn){if(commits.has(key))return commits.get(key);const result=Promise.resolve().then(fn);commits.set(key,result);try{return await result;}catch(error){if(commits.get(key)===result)commits.delete(key);throw error;}}
  async function dispatch({pluginId,contextToken,method,payload:raw={}},{signal,origin,observeResult}={}){
    if(observeResult!==undefined&&typeof observeResult!=='function')throw contextFailure('Result observation is host-only','BUDDY_REQUEST_INVALID');
    const extension=Object.hasOwn(hostServices,method)?hostServices[method]:null;
    const capability=methods[method]??extension?.capability;if(!capability)throw contextFailure('Unknown Buddy bridge method','BUDDY_METHOD_UNKNOWN');
    const payload=safePayload(raw),auth=await authorize({pluginId,contextToken,capability,payload}),context=auth.context;
    const check=()=>checkAuthorization({pluginId,contextToken,capability,generation:auth.generation,payload});
    if(signal?.aborted)throw contextFailure('Plugin call cancelled','ABORT_ERR');
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    let live=controllers.get(pluginId);if(!live)controllers.set(pluginId,live=new Set());live.add(controller);
    try{
      await check();
      if(extension){if(typeof extension.handler!=='function')throw contextFailure('Host service is unavailable','BUDDY_SERVICE_UNAVAILABLE');const result=await extension.handler({pluginId,context:structuredClone(context),payload,signal:controller.signal,origin,check});await observeResult?.(result,structuredClone(context));await check();return result;}
      if(capability==='characters.getContext'){
        const query=typeof payload.query==='string'?payload.query:'';if(query.length>200000)throw contextFailure('Context query is too large');
        let value;if(getCharacterContext)value=await getCharacterContext(context,{query,signal:controller.signal});
        else{const game=getGame();if(!game?.workContext||!context.workspace)throw contextFailure('Character context service requires a trusted project','BUDDY_SERVICE_UNAVAILABLE');value=await game.workContext({id:context.taskId??('plugin:'+pluginId),scope:identity(context),workspace:context.workspace,instruction:query},{query});}
        await check();return sanitizePluginValue(value);
      }
      if(capability==='models.request')return await broker.request(context,payload,{signal:controller.signal,check});
      if(capability==='memory.appendEvent'){
        const record=resolveEvidence(evidence,pluginId,payload.evidenceId,context),key=evidenceKey(pluginId,record.id)+':memory';
        return await once(key,async()=>{
          await check();if(record.presented!==true||record.status!=='completed'){
            if(onEvidence)await onEvidence(sanitizePluginValue({...record,context:undefined,scope:identity(context),stage:record.presented?'presented':'observed',longTermMemory:false}));
            return {evidenceId:record.id,recorded:false,longTermMemory:false,status:record.presented?'not-completed':'not-presented'};
          }
          if(!context.taskId||!context.workspace?.id)throw contextFailure('Work experience requires a trusted task and project','BUDDY_CONTEXT_DENIED');
          const source={id:pluginId+':'+record.id,kind:'work',taskId:context.taskId,workspaceId:context.workspace.id,...identity(context),visibility:'project',presented:true,createdAt:record.at??now(),text:requireText(record.text,'presented experience'),sourceVersion:record.sourceVersion??context.contextRevision,sourcePluginId:pluginId,sourceEvidenceId:record.id};
          const game=getGame();if(!game?.recordWorkExperience)throw contextFailure('Core memory service is unavailable','BUDDY_SERVICE_UNAVAILABLE');
          await game.recordWorkExperience(source);await check();return {evidenceId:record.id,recorded:true,longTermMemory:'candidate',sourceId:source.id};
        });
      }
      if(capability==='usage.record'){
        const record=resolveEvidence(usageEvidence,pluginId,payload.evidenceId,context),requestId=requireText(record.nativeRequestId,'native request id',300),nativeIdentity=context.sessionId+':'+requestId,key=evidenceKey(pluginId,nativeIdentity)+':usage';
        const nativeMetadata=Object.fromEntries(['engine','model','provider','nativeSessionId','nativeProfileId','usageMode','cumulative','origin','cacheIncluded','reasoningIncluded','connectionIdentity','timestamp','purpose'].filter(key=>record[key]!==undefined).map(key=>[key,structuredClone(record[key])]));
        if(nativeMetadata.timestamp===undefined&&record.at!==undefined)nativeMetadata.timestamp=record.at;
        const fingerprint=stable({usage:record.usage??null,accounting:record.accounting,parent:record.parentNativeRequestId??null,scope:identity(context),sessionId:context.sessionId,taskId:context.taskId,nativeMetadata});
        if(usageRequests.has(key)&&usageRequests.get(key)!==fingerprint)throw contextFailure('Native usage request has conflicting evidence','BUDDY_EVIDENCE_CONFLICT');usageRequests.set(key,fingerprint);
        return await once(key,async()=>{
          if(!onUsage)throw contextFailure('Core usage ledger is unavailable','BUDDY_SERVICE_UNAVAILABLE');
          if(!['independent','parent-total','child-detail'].includes(record.accounting))throw contextFailure('Usage accounting relationship is required','BUDDY_EVIDENCE_INVALID');
          const usage=record.usage??null;if(usage!=null&&(!plain(usage)||Object.values(usage).some(v=>v!=null&&(!Number.isFinite(v)||v<0))))throw contextFailure('Invalid observed native usage','BUDDY_EVIDENCE_INVALID');
          const billable=record.accounting!=='child-detail'&&(record.usageMode==='cumulative'?record.cumulative!=null:usage!==null);
          await check();
          const receipt=await onUsage(sanitizePluginValue({...nativeMetadata,idempotencyKey:pluginId+':'+nativeIdentity,pluginId,...identity(context),taskId:context.taskId,sessionId:context.sessionId,workspaceId:context.workspace?.id??null,workspace:context.workspace?.path??null,nativeRequestId:requestId,parentNativeRequestId:record.parentNativeRequestId??null,accounting:record.accounting,billable,usage,sourceEvidenceId:record.id}));
          await check();return {evidenceId:record.id,recorded:true,billable:receipt?.monitorDisposition?receipt.monitorDisposition==='count':billable};
        });
      }
      if(capability==='notifications.publish'){
        if(!onNotification)throw contextFailure('Notification service is unavailable','BUDDY_SERVICE_UNAVAILABLE');
        const notification={id:pluginId+':'+(payload.id??randomUUID()),pluginId,scope:identity(context),sessionId:context.sessionId,taskId:context.taskId,title:requireText(payload.title,'notification title',300),text:requireText(payload.text,'notification text',10000)};
        await onNotification(sanitizePluginValue(notification));await check();return {id:notification.id};
      }
      if(capability==='ui.registerPage'||capability==='lifecycle.register'){
        const id=requireText(payload.id,'registration id',300);if(!id.startsWith(pluginId+'.'))throw contextFailure('Registration must use the plugin namespace','BUDDY_NAMESPACE_DENIED');
        const key=pluginId+'\0'+capability+'\0'+id;if(registrations.has(key))throw contextFailure('Duplicate plugin registration','BUDDY_REGISTRATION_DUPLICATE');
        const register=capability==='ui.registerPage'?registerPage:registerLifecycle;if(typeof register!=='function')throw contextFailure('Host registration service is unavailable','BUDDY_SERVICE_UNAVAILABLE');
        registrations.set(key,{pluginId,dispose:null});let dispose;
        try{dispose=await register({pluginId,context:structuredClone(context),descriptor:sanitizePluginValue(payload),signal:controller.signal});await check();registrations.set(key,{pluginId,dispose:typeof dispose==='function'?dispose:()=>{}});return {id};}
        catch(error){registrations.delete(key);await dispose?.();throw error;}
      }
      throw contextFailure('Unavailable bridge method','BUDDY_METHOD_UNKNOWN');
    }finally{live.delete(controller);if(!live.size)controllers.delete(pluginId);signal?.removeEventListener('abort',abort);}
  }
  function invoke(request,options={}){
    if(!plain(request))return Promise.reject(contextFailure('Invalid plugin request','BUDDY_REQUEST_INVALID'));
    const {pluginId}=request,promise=dispatch(request,options);let pending=pendingCalls.get(pluginId);if(!pending)pendingCalls.set(pluginId,pending=new Set());pending.add(promise);
    const done=()=>{pending.delete(promise);if(!pending.size)pendingCalls.delete(pluginId);};promise.then(done,done);return promise;
  }
  async function revokePlugin(pluginId){
    grants.revoke(pluginId);authority.revokePlugin(pluginId);for(const controller of controllers.get(pluginId)??[])controller.abort();
    const callbacks=[];for(const[key,row]of registrations)if(row.pluginId===pluginId){registrations.delete(key);if(row.dispose)callbacks.push(Promise.resolve().then(row.dispose));}
    for(const target of [evidence,usageEvidence])for(const key of target.keys())if(key.startsWith(pluginId+'\0'))target.delete(key);
    await Promise.all(callbacks);await Promise.allSettled([...(pendingCalls.get(pluginId)??[])]);
  }
  return {version:BUDDY_BRIDGE_VERSION,authority,grants,issueContext:spec=>authority.issue(spec),issueActiveContext,releaseActiveContext:issued=>authority.releaseActiveCall(issued.contextToken,{pluginId:issued.pluginId,callId:issued.activeCallId}),authorize,checkAuthorization,invoke,
    registerEventEvidence:spec=>registerEvidenceInto(evidence,spec),registerUsageEvidence:spec=>registerEvidenceInto(usageEvidence,spec),revokePlugin,
    busy:pluginId=>pluginId==null?[...pendingCalls.values()].some(v=>v.size>0):(pendingCalls.get(pluginId)?.size??0)>0,
    async close(){if(closed)return;closed=true;const ids=new Set([...pendingCalls.keys(),...controllers.keys(),...[...registrations.values()].map(v=>v.pluginId)]);await Promise.all([...ids].map(revokePlugin));authority.close();grants.close();evidence.clear();usageEvidence.clear();usageRequests.clear();commits.clear();}};
}

export {createSocialClient} from './social-client.mjs';
export {SOCIAL_CONTRACT_VERSION,SOCIAL_METHODS,SOCIAL_CAPABILITIES} from './social-contract.mjs';
