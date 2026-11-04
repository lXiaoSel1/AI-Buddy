import {validFullReadingUnderstanding} from './bili-full-reading.mjs';
import {fullReadingAuthority,fullReadingModel,assertFullReadingModel} from './bili-full-reading-authority.mjs';
import {buildQqMessageEnvelope,parseQqMessageSegments,validateQqReplyStylePolicy} from './qq-message-envelope.mjs';
import {createSocialRuntimeJournal,socialScopeSnapshot,markModelNotSubmitted,modelNotSubmittedError} from './social-runtime-journal.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {imageInputCapability,registerHostImages,registerHostSubmission,releaseHostImages} from '../model-images.mjs';
import {withR95ModelObservation,withR95ModelLifecycle} from '../r95-model-request.mjs';
import {getModelSubmissionState} from '../model-submission.mjs';
import {sanitizePluginValue} from './model-broker.mjs';
import {filterReplySourceLabels} from '../reply-source-labels.mjs';
const fail=(code,message=code)=>Object.assign(Error(message),{code});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const copy=x=>structuredClone(x);
const scalar=x=>typeof x==='string'?x:Number.isSafeInteger(x)?String(x):'';
const terminals=new Map([['completed','completed'],['sent','completed'],['observed','completed'],['partial','completed'],['cancelled','cancelled'],['paused','cancelled'],['unknown','unknown'],['failed-before-send','failed'],['failed','failed']]);
export const SOCIAL_RUNTIME_METHODS=Object.freeze(['social.context.read','activity.lease','activity.check','activity.finish','models.request','experience.append','proactive.offer','proactive.claim','search.native','owner.work.propose','owner.work.read','owner.work.approve','owner.work.cancel','connections.request','connections.open','connections.events','connections.close','ui.bubble']);

/** Adapt native plugin requests to the existing Core authority. This module
 * observes transport/model results itself: plugin claims never mint evidence. */
export function createSocialPluginBroker({dataRoot,accounts,transport,bridge,getR95,getProvider,onBubble=async()=>{},onEvent=()=>{},onSetup=null,verifyBilibiliAccount=null,biliVision=null,requireBiliMedia=null,onReadingOpen=async()=>({opened:false}),automaticWorkAllowed=()=>true,now=Date.now}={}){
 const journal=createSocialRuntimeJournal({dataRoot});
  const offers=new Map(),deliveryAdapters=new Map(),candidateAdmissions=new Map(),coreCalls=new WeakMap(),deferredEvidenceReleases=new WeakMap(),activityAttempts=new WeakMap(),activityAdmissions=new WeakMap(),pendingAdmissions=new Set();
 const contexts=new Map(),management=new Map(),operators=new Map(),operatorBindings=new Map(),qqReplyObservations=new Map();let closed=false;
 let memoryTimer=null,memoryTask=null,memoryClosing=false,legacySeeded=false;const memoryAbort=new AbortController(),memoryBackoff=[10000,60000,300000];
 const qqReplyKey=row=>hash([row.account.ref,row.account.generation,row.characterId,row.lifeId,row.operationId,row.conversationId,row.sourceMessageId]);
 const qqExpressionIntroName=characterId=>{const label=r95().socialCatalog?.()?.find(c=>c.id===characterId)?.label;return typeof label==='string'&&label.trim()&&label!==characterId&&label.length<=200&&!/[\u0000-\u001f\u007f]/u.test(label)?label:'当前接管者';};
 const qqExpressionWireMatches=(entry,wire)=>wire===entry.text||wire===('现在由'+entry.expressionIntroName+'陪你聊天。\n'+entry.text);
 const visionReady=()=>!!biliVision&&biliVision.available===true&&['prepare','read','resolve','claim','finish'].every(k=>typeof biliVision[k]==='function');
 const fullReady=()=>visionReady()&&!!biliVision.fullReading;
 const fullManagement=['get','image','open','confirm','continue','pause','stop'].map(op=>'video.fullReading.'+op);
 const capturedModel=row=>getProvider().captureConnection({enabled:true,connectionId:row.modelConnectionRef??row.connectionRef});
  const safeModelResult=(row,value)=>{const profile=capturedModel(row);return sanitizePluginValue(value,[profile?.keyCiphertext,profile?.key,getProvider().materialize?.(profile)?.key]);};
 const visionScope=row=>({...socialScopeSnapshot(row),accountRef:row.account.ref,accountId:row.account.accountId,generation:row.account.generation});
 const r95=()=>{const value=getR95();if(closed||!value?.socialHost)throw fail('BUDDY_SERVICE_UNAVAILABLE');return value;};
 function saveContext(row){
  const {models,evidence,revoke,observations,leases,...data}=row;
  journal.saveContext(row.persistedToken??row.contextToken,{...data,evidence:[...evidence],facts:row.facts??[]});
 }
 async function restoreForEvidence(identity,token,{onCreated}={}){
  let saved=journal.context(token);if(!saved)return null;
  const live=contexts.get(token);if(live){try{return verify(live,identity);}catch{await Promise.allSettled([...attempts(live).values()].map(attempt=>finishAttempt(attempt,'cancelled')));live.revoke();bridge.authority?.revoke?.(live.contextToken);contexts.delete(token);}}
  const row={...saved,persistedToken:token,recoveredEvidenceOnly:true,models:new Map(),evidence:new Map(saved.evidence),observations:[],leases:new Set()};
  verify(row,identity);
  // Restore only an existing host-issued identity for committing observed facts.
  // This does not restore a lease or authorize a model/send/owner-work replay.
  const anchor=r95().socialHost.registerContext({pluginId:identity.pluginId,scope:socialScopeSnapshot(row),restoreRef:row.contextRef,check:()=>{try{verify(row,identity);return true;}catch{return false;}}});
  row.revoke=anchor.revoke;
  try{const issued=await bridge.issueContext({pluginId:identity.pluginId,contextKind:'social',contextRef:anchor.contextRef});row.contextToken=issued.contextToken;contexts.set(token,row);onCreated?.(row);return row;}catch(error){anchor.revoke();if(contexts.get(token)===row)contexts.delete(token);if(row.contextToken!==saved.contextToken)bridge.authority?.revoke?.(row.contextToken);throw error;}
 }
 function releaseOwnedEvidence(handle){if(!handle)return;const {row,token}=handle;if(coreCalls.get(row)){deferredEvidenceReleases.set(row,()=>releaseOwnedEvidence(handle));return;}row.revoke();bridge.authority?.revoke?.(row.contextToken);if(contexts.get(token)===row)contexts.delete(token);deferredEvidenceReleases.delete(row);}
 function memoryContext(row){const {models,evidence,revoke,observations,leases,facts,raw,inboundEvent,ownerRoute,...data}=row;return {...data,evidence:[],facts:[]};}
 const memoryScopeKeys=['pluginId','characterId','personaId','lifeId','operationId','sessionId','channel','conversationId','accountBindingId','actorId','bindingGeneration','activityGeneration','visibilityScope'];
 function verifyMemoryContext(value){
  if(!value||value.packageName!=='@ai-buddy/qq-connect'||!['qq-private','qq-group'].includes(value.channel)||['pluginId','characterId','personaId','lifeId','operationId','sessionId','conversationId','actorId','contextRef','contextToken','connectionRef'].some(key=>typeof value[key]!=='string'||!value[key])||!value.account?.ref||value.account.accountId!==value.accountBindingId||value.account.generation!==value.bindingGeneration||value.channel!=='qq-'+value.conversationType||value.conversationId!==value.conversationType+':'+value.peerId)throw fail('QQ_MEMORY_ORIGINAL_CONTEXT_INVALID');
  try{return verify({...value,recoveredEvidenceOnly:true},{pluginId:value.pluginId,packageName:value.packageName});}catch(error){if(error.code==='BUDDY_SERVICE_UNAVAILABLE')throw error;throw fail(error.code??'QQ_MEMORY_ORIGINAL_CONTEXT_INVALID');}
 }
 function memoryEvidence(row,proof,ref){
  const value=r95().socialHost.readEvidence(row.pluginId,ref);
  if(value.contextAuthority!==row.contextRef||value.sourceKind!=='qq-outbound'||value.nativeMessageId!==proof.messageId||value.text!==proof.text||value.occurredAt!==proof.occurredAt||value.stage!=='sent'||value.status!=='completed'||value.deliveryState!=='sent'||memoryScopeKeys.some(key=>value[key]!==row[key]))throw fail('BUDDY_EVIDENCE_CONFLICT');return value;
 }
 function existingMemoryRef(saved,messageId){return saved?.outboundEvidenceRefs?.find(([id])=>id===messageId)?.[1]??(saved?.evidence??[]).map(([,ref])=>ref).find(ref=>{try{const e=r95().socialHost.readEvidence(saved.pluginId,ref);return e.sourceKind==='qq-outbound'&&e.nativeMessageId===messageId;}catch{return false;}});}
 function seedLegacyMemory(){
  if(legacySeeded||typeof transport.qqMemoryImport!=='function')return;try{r95();}catch{return;}const batch=journal.contexts({packageName:'@ai-buddy/qq-connect',after:journal.legacyCursor(),limit:100});legacySeeded=batch.length<100;
  for(const saved of batch)for(const fact of saved.facts??[]){
   if(fact?.kind!=='qq-send')continue;try{verifyMemoryContext(saved);const ref=existingMemoryRef(saved,fact.messageId),e=ref?r95().socialHost.evidenceState?.(saved.pluginId,ref):null,occurredAt=fact.occurredAt??e?.record.occurredAt;
    if(!Number.isFinite(occurredAt))continue;if(ref)memoryEvidence(saved,{...fact,occurredAt},ref);transport.qqMemoryImport(saved,fact,{eventRef:ref,occurredAt,committed:e?.committed===true});
   }catch{}
  }
  if(batch.length)journal.advanceLegacyCursor(batch.at(-1).cursor);
 }
 function scheduleMemory(delay=0){if(memoryClosing||closed||typeof transport.qqMemoryList!=='function')return;clearTimeout(memoryTimer);memoryTimer=setTimeout(()=>{memoryTimer=null;if(!automaticWorkAllowed()){scheduleMemory(10000);return;}recoverQqMemory().catch(()=>{});},Math.min(300000,Math.max(0,delay)));memoryTimer.unref?.();}
 async function appendMemoryIntent(intent){
  const proof=intent.proof;if(hash(proof)!==intent.proof_digest||proof.version!==1||!proof.requestId||!proof.messageId||typeof proof.text!=='string'||!Number.isFinite(proof.occurredAt)||proof.accountRef!==proof.context?.account?.ref)throw fail('QQ_MEMORY_PROOF_INVALID');
  verifyMemoryContext(proof.context);const identity={pluginId:proof.context.pluginId,packageName:proof.context.packageName},token=proof.context.persistedToken??proof.context.contextToken,saved=journal.context(token);
  if(!saved||saved.contextRef!==proof.context.contextRef||memoryScopeKeys.some(key=>saved[key]!==proof.context[key])||saved.connectionRef!==proof.context.connectionRef||saved.modelConnectionRef!==proof.context.modelConnectionRef||saved.modelFingerprint!==proof.context.modelFingerprint)throw fail('QQ_MEMORY_ORIGINAL_CONTEXT_INVALID');
  let owned=null;const row=await restoreForEvidence(identity,token,{onCreated:value=>{owned={row:value,token};}});try{verifyMemoryContext(row);let ref=intent.event_ref??existingMemoryRef(saved,proof.messageId)??r95().socialHost.findContextEvidence?.({pluginId:row.pluginId,accountBindingId:row.accountBindingId,bindingGeneration:row.bindingGeneration,nativeEvidenceId:proof.messageId,stage:'sent'})?.eventRef;
  if(ref)memoryEvidence(row,proof,ref);else ref=r95().socialHost.recordContextEvidence({pluginId:row.pluginId,contextRef:row.contextRef,nativeEvidenceId:proof.messageId,sourceKind:'qq-outbound',stage:'sent',status:'completed',text:proof.text,occurredAt:proof.occurredAt,deliveryState:'sent'}).eventRef;
  transport.qqMemoryUpdate(intent.id,{eventRef:ref});row.outboundEvidenceRefs??=[];if(!row.outboundEvidenceRefs.some(([id])=>id===proof.messageId))row.outboundEvidenceRefs.push([proof.messageId,ref]);saveContext(row);const result=await core(row,'experience.append',{eventRef:ref},{signal:memoryAbort.signal});if(result?.recorded!==true)throw fail('QQ_MEMORY_APPEND_UNCONFIRMED');transport.qqMemoryUpdate(intent.id,{state:'committed',eventRef:ref,nextAt:0});return result;}finally{releaseOwnedEvidence(owned);}
 }
 function recoverQqMemory(){
  if(memoryClosing||closed||typeof transport.qqMemoryList!=='function')return Promise.resolve({closed:memoryClosing||closed});if(memoryTask)return memoryTask;
  memoryTask=(async()=>{seedLegacyMemory();const rows=transport.qqMemoryList({pending:true,due:now(),limit:100});
   for(const intent of rows){if(memoryClosing||closed)break;if(transport.qqMemoryState(intent.id)!=='pending')continue;try{await appendMemoryIntent(intent);}catch(error){if(memoryClosing||closed)break;const attempts=intent.attempts+1,permanent=['QQ_MEMORY_PROOF_INVALID','QQ_MEMORY_ORIGINAL_CONTEXT_INVALID','BUDDY_CONTEXT_REQUIRED','BUDDY_CONTEXT_STALE','BUDDY_CONTEXT_EXPIRED','SOCIAL_ACCOUNT_CHANGED','R95_CONNECTION_CHANGED','BUDDY_EVIDENCE_CONFLICT','BUDDY_EVIDENCE_MISSING'].includes(error.code);transport.qqMemoryUpdate(intent.id,{expectedState:'pending',state:permanent||attempts>memoryBackoff.length?'needs-review':'pending',attempts,nextAt:now()+(memoryBackoff[attempts-1]??0),error:error.code??'QQ_MEMORY_APPEND_FAILED'});}}
   if(!memoryClosing&&!closed){const pending=transport.qqMemoryList({pending:true,limit:1000});if(pending.length||!legacySeeded)scheduleMemory(Math.min(...pending.map(row=>row.next_at-now()),...(!legacySeeded?[1000]:[])));}return {processed:rows.length};
  })().finally(()=>{memoryTask=null;});return memoryTask;
 }
 function verify(row,identity){
  if(!row||row.pluginId!==identity.pluginId||row.packageName!==identity.packageName)throw fail('BUDDY_CONTEXT_REQUIRED');
  const a=accounts.get(row.account.ref);if(!a?.enabled||a.generation!==row.account.generation)throw fail('SOCIAL_ACCOUNT_CHANGED');
  if(row.channel.startsWith('qq-')&&!row.recoveredEvidenceOnly){const operator=operators.get(identity.pluginId);if(!operator||operator.characterId!==row.characterId||operator.operatorGeneration!==row.operatorGeneration)throw fail('QQ_OPERATOR_CHANGED');}
  if(row.modelConnectionRef&&hash(getProvider().captureConnection({enabled:true,connectionId:row.modelConnectionRef}))!==row.modelFingerprint)throw fail('R95_CONNECTION_CHANGED');
  const current=r95().socialProfile(row.characterId,{channel:row.channel,conversationId:row.conversationId});
  if(['personaId','lifeId','operationId','connectionRef'].some(k=>current[k]!==row[k]))throw fail('BUDDY_CONTEXT_STALE');
  return row;
 }
  function attempts(row){let value=activityAttempts.get(row);if(!value)activityAttempts.set(row,value=new Map());return value;}
  function attemptFor(row,leaseId){const values=attempts(row);if(leaseId)return values.get(leaseId);const live=[...values.values()].filter(value=>!value.releasing);return live.length===1?live[0]:null;}
  function dropAttempt(attempt){if(attempt.issued)bridge.releaseActiveContext(attempt.issued);attempt.controller.abort();if(attempt.leaseId){attempts(attempt.row).delete(attempt.leaseId);attempt.row.leases.delete(attempt.leaseId);}}
  async function finishAttempt(attempt,status){
   if(attempt.releasing)return attempt.releasing;
   if(attempt.admitting&&!attempt.owner){attempt.releaseStatus=status;attempt.controller.abort();return {finished:false,pending:true};}
   const task=Promise.resolve().then(()=>{const result=attempt.owner?attempt.owner.finish(status):{finished:true};dropAttempt(attempt);return result;});attempt.releasing=task;
   try{return await task;}catch(error){attempt.releasing=null;throw error;}
  }
  async function invokeCore(row,method,payload,options={},token=row.contextToken){coreCalls.set(row,(coreCalls.get(row)??0)+1);try{return await bridge.invoke({pluginId:row.pluginId,contextToken:token,method,payload},options);}finally{const active=(coreCalls.get(row)??1)-1;if(active)coreCalls.set(row,active);else{coreCalls.delete(row);deferredEvidenceReleases.get(row)?.();}}}
  async function admitAttempt(row,payload,options={}){
   if(memoryClosing||closed)throw fail('SOCIAL_HOST_CLOSED');
   let admissions=activityAdmissions.get(row);if(!admissions)activityAdmissions.set(row,admissions=new Map());
   if(admissions.has(payload.activityId))return admissions.get(payload.activityId);
   const existing=[...attempts(row).values()].find(value=>value.activityId===payload.activityId&&!value.releasing);
   if(existing){await options.check?.();await invokeCore(row,'activity.check',{leaseId:existing.leaseId,generation:row.account.generation},options,existing.issued.contextToken);return {...copy(existing.lease),duplicate:true};}
   coreCalls.set(row,(coreCalls.get(row)??0)+1);const task=performAdmission(row,payload,options);pendingAdmissions.add(task);admissions.set(payload.activityId,task);try{return await task;}finally{pendingAdmissions.delete(task);if(admissions.get(payload.activityId)===task)admissions.delete(payload.activityId);const active=(coreCalls.get(row)??1)-1;if(active)coreCalls.set(row,active);else{coreCalls.delete(row);deferredEvidenceReleases.get(row)?.();}}
  }
  async function performAdmission(row,payload,options={}){
   const host=r95().socialHost;if(typeof bridge.issueActiveContext!=='function'||typeof host.ownLease!=='function')return invokeCore(row,'activity.lease',payload,options);
   if(Number.isSafeInteger(row.grantGeneration))bridge.grants.assertGeneration(row.pluginId,row.grantGeneration);
   const controller=new AbortController(),attempt={row,controller,activityId:payload.activityId,admitting:true,owner:null,leaseId:null,issued:null,releasing:null};
   const checkCurrent=async()=>{if(controller.signal.aborted||closed||memoryClosing)throw fail('BUDDY_CONTEXT_EXPIRED');if(Number.isSafeInteger(row.grantGeneration))bridge.grants.assertGeneration(row.pluginId,row.grantGeneration);verify(row,{pluginId:row.pluginId,packageName:row.packageName});await options.check?.();if(controller.signal.aborted||memoryClosing)throw fail('BUDDY_CONTEXT_EXPIRED');attempt.owner?.check();};
   try{
    attempt.issued=await bridge.issueActiveContext({pluginId:row.pluginId,contextKind:'social',contextRef:row.contextRef},{callId:randomUUID(),signal:controller.signal,checkCurrent,onRevoke:()=>{void finishAttempt(attempt,'cancelled').catch(()=>{});}});
    const lease=await invokeCore(row,'activity.lease',payload,{...options,observeResult:(value,context)=>{attempt.leaseId=value.leaseId;attempt.owner=host.ownLease({pluginId:row.pluginId,context,leaseId:value.leaseId});attempts(row).set(value.leaseId,attempt);row.leases.add(value.leaseId);}},attempt.issued.contextToken);
    attempt.lease=copy(lease);attempt.admitting=false;if(attempt.releaseStatus){await finishAttempt(attempt,attempt.releaseStatus);throw fail('BUDDY_CONTEXT_EXPIRED');}return lease;
   }catch(error){attempt.admitting=false;await finishAttempt(attempt,'cancelled').catch(()=>{});throw error;}
  }
  async function core(row,method,payload,options={}){
   if(method==='activity.lease')return admitAttempt(row,payload,options);
   const attempt=attemptFor(row,payload.leaseId);
   if(method==='activity.finish'&&attempt)return finishAttempt(attempt,payload.status);
   return invokeCore(row,method,payload,options,attempt?.issued.contextToken??row.contextToken);
  }
 function publicContext(row){return {contextToken:row.contextToken,characterId:row.characterId,personaId:row.personaId,lifeId:row.lifeId,operationId:row.operationId,accountId:row.account.accountId,generation:row.account.generation,connectionRef:row.modelConnectionRef??row.connectionRef,modelCapabilities:imageInputCapability(getProvider?.()?.captureConnection?.({enabled:true,connectionId:row.modelConnectionRef??row.connectionRef})).supported?['image']:[],permissions:[],conversationId:row.conversationId,conversationType:row.conversationType,sourceMessageId:row.sourceMessageId,senderId:row.senderId,ownerVerified:row.ownerVerified===true,operatorGeneration:row.operatorGeneration};}
 async function createContext(identity,characterId,a,extra={}){
   if(contexts.size>=900){for(const [token,row]of contexts){if(row.leases?.size||coreCalls.get(row)||[...operators.values()].includes(row)||[...candidateAdmissions.values()].some(v=>v.row===row))continue;row.revoke();bridge.authority?.revoke?.(row.contextToken);contexts.delete(token);if(contexts.size<500)break;}}
  const channel=extra.conversationType==='private'?'qq-private':extra.conversationType==='group'?'qq-group':'bilibili',conversationId=extra.conversationId??'bilibili:'+randomUUID();
  const profile=r95().socialProfile(characterId,{channel,conversationId});
   const row={...profile,...extra,pluginId:identity.pluginId,packageName:identity.packageName,grantGeneration:bridge.grants?.get?.(identity.pluginId)?.generation??null,account:a,channel,conversationId,sessionId:randomUUID(),actorId:extra.senderId??'app-owner',accountBindingId:a.accountId,bindingGeneration:a.generation,activityGeneration:1,visibilityScope:extra.public?'public':channel==='qq-group'?'group':'conversation',observations:[],models:new Map(),evidence:new Map(),leases:new Set()};
  if(channel.startsWith('qq-')&&row.connectionRef&&typeof getProvider()?.captureConnection==='function'){row.modelConnectionRef=row.connectionRef;row.modelFingerprint=hash(getProvider().captureConnection({enabled:true,connectionId:row.connectionRef}));}
  const scope=socialScopeSnapshot(row);
  const anchor=r95().socialHost.registerContext({pluginId:identity.pluginId,scope,check:()=>{try{verify(row,identity);return true;}catch{return false;}}});
  row.contextRef=anchor.contextRef;row.revoke=anchor.revoke;
   let issued;try{issued=await bridge.issueContext({pluginId:identity.pluginId,contextKind:'social',contextRef:anchor.contextRef});row.contextToken=issued.contextToken;}catch(error){anchor.revoke();throw error;}
   if(contexts.size>=1000){anchor.revoke();bridge.authority?.revoke?.(row.contextToken);throw fail('SOCIAL_CONTEXT_LIMIT');}contexts.set(row.contextToken,row);try{saveContext(row);}catch(error){contexts.delete(row.contextToken);anchor.revoke();bridge.authority?.revoke?.(row.contextToken);throw error;}return row;
 }
 async function contextProvider({identity,method,payload,authority}){
   if(memoryClosing&&method!=='activity.finish')throw fail('SOCIAL_HOST_CLOSED');
  if(method==='social.context.read')return {authority};
  if(['connections.open','connections.events','connections.close','proactive.claim'].includes(method)){
   const operator=operators.get(identity.pluginId);if(!operator)throw fail('QQ_OPERATOR_REQUIRED');return verify(operator,identity);
  }
  if(method==='proactive.offer'&&management.has(payload.contextToken)){
   const principal=management.get(payload.contextToken);
   if(principal.pluginId!==identity.pluginId||principal.expiresAt<=now())throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');
   const row=[...contexts.values()].find(r=>r.pluginId===identity.pluginId&&r.channel.startsWith('qq-')&&r.conversationId===payload.conversationId&&(r.inboundEvent?.eventRef===payload.sourceEventId||r.sourceMessageId===payload.sourceEventId||[...r.evidence.values()].includes(payload.sourceEventId)));
   return verify(row,identity);
  }
  if(method==='connections.request'&&['qq.memory.status','qq.memory.retry'].includes(payload.operation)){const p=management.get(payload.contextToken);if(identity.packageName!=='@ai-buddy/qq-connect'||!p||p.pluginId!==identity.pluginId||p.expiresAt<=now()||p.kind!=='app'||payload.operation==='qq.memory.retry'&&p.action!=='memory.retry')throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');return {management:p};}
  if(method==='connections.request'&&[...fullManagement,'video.storyboard.get','video.storyboard.image','video.storyboard.open','video.storyboard.continue','video.storyboard.stop'].includes(payload.operation)&&management.has(payload.contextToken)){const p=management.get(payload.contextToken);if(!p||p.pluginId!==identity.pluginId||p.expiresAt<=now()||p.kind!=='app')throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');return {management:p};}
  let row=contexts.get(payload.contextToken);
   if(method==='activity.finish'&&row?.pluginId===identity.pluginId&&row.packageName===identity.packageName&&attemptFor(row,payload.leaseId))return row;
  if(!row&&method==='experience.append')row=await restoreForEvidence(identity,payload.contextToken);
  if(row?.recoveredEvidenceOnly&&method!=='experience.append')throw fail('SOCIAL_RESTART_REQUIRES_NEW_ACTIVITY');
   try{return verify(row,identity);}catch(error){if(row)await Promise.allSettled([...attempts(row).values()].map(attempt=>finishAttempt(attempt,'cancelled')));throw error;}
 }
 async function requireBilibiliLogin(a,{signal,check=async()=>{}}={}){
  await check();signal?.throwIfAborted();
  const cookie=accounts.secret(a.ref)?.cookie;if(typeof cookie!=='string'||!cookie.trim())throw fail('SOCIAL_ACCOUNT_REQUIRED');
  if(typeof verifyBilibiliAccount!=='function')throw fail('SOCIAL_LOGIN_VERIFICATION_REQUIRED');
  const proof=await verifyBilibiliAccount(a.ref,{signal});
  await check();signal?.throwIfAborted();if(closed)throw fail('SOCIAL_HOST_CLOSED');
  const current=accounts.get(a.ref);if(!current?.enabled||current.generation!==a.generation||current.accountId!==a.accountId)throw fail('SOCIAL_ACCOUNT_CHANGED');
  if(proof?.connected!==true||String(proof.accountId)!==a.accountId)throw fail('SOCIAL_LOGIN_EXPIRED');
 }
 async function readContext({identity,payload,context,signal,check=async()=>{}}){
  if(memoryClosing||closed)throw fail('SOCIAL_HOST_CLOSED');
  const kind=payload.purpose;
  if(kind==='manage-plugin'||kind==='plugin-background'){
   for(const [token,value]of management)if(value.expiresAt<=now())management.delete(token);
   if(management.size>=1000)management.delete(management.keys().next().value);
   if(!context.authority||kind==='manage-plugin'&&context.authority.kind!=='app')throw fail('PLUGIN_MANAGE_DENIED');
   const token=randomUUID(),a=accounts.list().find(a=>a.pluginId===identity.packageName&&a.enabled);
   if(kind==='plugin-background'&&a?.activityApprovalRequired)throw fail('PLUGIN_ACTIVITY_DENIED');
   management.set(token,{pluginId:identity.pluginId,expiresAt:now()+300000,kind:context.authority.kind,action:context.authority.action});
   const modelProfiles=getProvider()?.state?.profiles??[];let onboarding;
   if(payload.setupAction){
    const permitted={open:'onboarding.open',contacts:'onboarding.contacts',complete:identity.packageName==='@ai-buddy/bilibili-companion'?'settings.update':'setup.finish'};
    // QQ 2.0.2 switches resume-on-start from its status card; it records the same autoResume as setup.finish.
    if(identity.packageName==='@ai-buddy/qq-connect'&&payload.setupAction==='complete'&&context.authority?.action==='startup.update')permitted.complete='startup.update';
    if(!onSetup||kind!=='manage-plugin'||context.authority.kind!=='app'||!Object.hasOwn(permitted,payload.setupAction)||context.authority.action!==permitted[payload.setupAction])throw fail('SOCIAL_SETUP_DENIED');
    const scope=payload.setupAction==='complete'&&identity.packageName==='@ai-buddy/qq-connect'?publicContext(verify(operators.get(identity.pluginId),identity)):null;
    const accountAtStart=a&&{ref:a.ref,generation:a.generation};
    const checkSetup=async()=>{await check();signal?.throwIfAborted();if(closed)throw fail('SOCIAL_HOST_CLOSED');const current=accountAtStart&&accounts.get(accountAtStart.ref);if(accountAtStart&&(!current?.enabled||current.generation!==accountAtStart.generation))throw fail('SOCIAL_ACCOUNT_CHANGED');if(scope){const operator=publicContext(verify(operators.get(identity.pluginId),identity));if(['characterId','lifeId','operationId','operatorGeneration'].some(key=>operator[key]!==scope[key]))throw fail('QQ_OPERATOR_BIND_CANCELLED');}};
    await checkSetup();onboarding=await onSetup({packageName:identity.packageName,action:payload.setupAction,payload:{...payload,...scope?{scope}:{}},signal,check:checkSetup});await checkSetup();
   }
   return {contextToken:token,accountId:a?.accountId??'',...(identity.packageName==='@ai-buddy/qq-connect'?{globalReplyStyle:r95().replyStyle?.()??'natural',memoryRecoveryAvailable:typeof transport.qqMemoryList==='function'}:{}),sourceMode:'host-managed-transport',onboardingAvailable:!!onSetup,...onboarding?{onboarding}:{},permissions:[kind==='manage-plugin'?'plugin.manage':'plugin.activity'],availableCharacters:r95().socialCatalog(),managedConnections:[...accounts.list().filter(a=>a.pluginId===identity.packageName&&a.enabled).map(({ref,label,platform,accountId})=>({ref,label,platform,accountId})),...modelProfiles.map(p=>({ref:p.id,label:p.name??p.id,platform:'model',provider:p.kind}))]};
  }
  let a=accounts.forPlugin(identity.packageName);
  if(kind==='qq-message'){
   const operator=verify(operators.get(identity.pluginId),identity),native=transport.inbound(payload.connectionId,payload.sourceMessageId,operator),raw=native.raw;
   const senderId=scalar(raw.user_id??raw.sender?.user_id),type=raw.message_type,peerId=type==='group'?scalar(raw.group_id):senderId,conversationId=type+':'+peerId;
   if(!senderId||raw.sender?.user_id!=null&&scalar(raw.sender.user_id)!==senderId||senderId===a.accountId||payload.accountId!==a.accountId||payload.senderId!==senderId||payload.conversationId!==conversationId||payload.conversationType!==type||payload.characterId!==operator.characterId||payload.lifeId!==operator.lifeId||payload.operationId!==operator.operationId)throw fail('QQ_TRUSTED_CONTEXT_MISMATCH');
   const segments=parseQqMessageSegments(raw.message);if(!Array.isArray(segments)||segments.length>128)throw fail('QQ_NATIVE_EVENT_INVALID');
   const text=segments.filter(s=>s.type==='text').map(s=>String(s.data?.text??'')).join(''),quoted=segments.some(s=>s.type!=='text');
   const row=await createContext(identity,operator.characterId,a,{senderId,conversationType:type,conversationId,peerId,sourceMessageId:payload.sourceMessageId,raw,quoted,operatorGeneration:operator.operatorGeneration});
   const binding=r95().owner.owner(a.accountId);row.ownerVerified=type==='private'&&!quoted&&binding?.actorId===senderId&&binding?.personaId===row.personaId;
   row.inboundEvent=r95().socialHost.recordContextEvidence({pluginId:identity.pluginId,contextRef:row.contextRef,nativeEvidenceId:payload.sourceMessageId,sourceKind:'social-message',stage:'received',status:'received',text,occurredAt:raw.time*1000,quoted});
   saveContext(row);
   return publicContext(row);
  }
  const principal=payload.contextToken?management.get(payload.contextToken):null;
  if(!context.authority&&(!principal||principal.pluginId!==identity.pluginId||principal.expiresAt<=now()))throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');
  if(!['qq-operator-bind','bilibili-activity','bilibili-public-comment'].includes(kind))throw fail('SOCIAL_CONTEXT_PURPOSE_INVALID');
  if(kind==='bilibili-activity'||kind==='bilibili-public-comment')await requireBilibiliLogin(a,{signal,check});
  const bindingGeneration=kind==='qq-operator-bind'?(operatorBindings.get(identity.pluginId)??0)+1:null;
  if(bindingGeneration!==null)operatorBindings.set(identity.pluginId,bindingGeneration);
  const startingAccount={ref:a.ref,accountId:a.accountId};
  const checkBinding=async()=>{
   if(bindingGeneration===null)return;
   await check();signal?.throwIfAborted();
   if(closed||operatorBindings.get(identity.pluginId)!==bindingGeneration)throw fail('QQ_OPERATOR_BIND_CANCELLED');
   const current=accounts.forPlugin(identity.packageName);
   if(current.ref!==startingAccount.ref||current.accountId!==startingAccount.accountId)throw fail('SOCIAL_ACCOUNT_CHANGED');
  };
  await checkBinding();
  if(kind==='qq-operator-bind'&&principal?.kind==='background'){
   const profile=r95().socialProfile(payload.characterId,{channel:'qq-group',conversationId:'restore-check'});
   if(payload.restore!==true||payload.expectedLifeId!==profile.lifeId||payload.expectedOperationId!==profile.operationId)throw fail('QQ_RESTORE_LIFE_CHANGED');
  }
  if(kind==='qq-operator-bind'&&onSetup){await onSetup({packageName:identity.packageName,action:'ensure',payload:{restore:principal?.kind==='background',scope:{characterId:payload.characterId,lifeId:payload.expectedLifeId,operationId:payload.expectedOperationId}}});await checkBinding();a=accounts.forPlugin(identity.packageName);}
  let selected={};
  if(kind.startsWith('bilibili')&&payload.modelConnectionRef){
   const profile=getProvider().captureConnection({enabled:true,connectionId:payload.modelConnectionRef});
   if(!profile||profile.id!==payload.modelConnectionRef||profile.enabled===false)throw fail('R95_CONNECTION_UNAVAILABLE');
   selected={modelConnectionRef:profile.id,modelFingerprint:hash(profile)};
  }
  const row=await createContext(identity,payload.characterId,a,{public:kind==='bilibili-public-comment',...selected});
  if(kind==='qq-operator-bind'){
   try{
    await checkBinding();verify(row,identity);
    if(payload.expectedLifeId&&payload.expectedLifeId!==row.lifeId||payload.expectedOperationId&&payload.expectedOperationId!==row.operationId)throw fail('QQ_RESTORE_LIFE_CHANGED');
   }catch(cause){row.revoke();bridge.authority?.revoke?.(row.contextToken);contexts.delete(row.contextToken);throw cause;}
   const previous=operators.get(identity.pluginId);row.operatorGeneration=(previous?.operatorGeneration??0)+1;previous?.revoke();if(previous)bridge.authority?.revoke?.(previous.contextToken);
   for(const adapter of deliveryAdapters.get(identity.pluginId)??[])adapter.revoke();operators.set(identity.pluginId,row);
   const adapters=['qq-private','qq-group'].map(channel=>r95().registerSocialDelivery({channel,accountBindingId:a.accountId,generation:a.generation,
    check:scope=>{verify(row,identity);if(scope.characterId!==row.characterId||scope.lifeId!==row.lifeId||scope.personaId!==row.personaId||scope.operationId!==row.operationId)throw fail('SOCIAL_CONTEXT_STALE');},
    finish:async scope=>{for(const [id,admission]of candidateAdmissions)if(['characterId','personaId','lifeId','operationId','sessionId','conversationId','channel'].every(k=>admission.row[k]===scope[k])){clearTimeout(admission.timer);candidateAdmissions.delete(id);await core(admission.row,'activity.finish',{leaseId:admission.lease.leaseId,status:'completed'});}},
    send:async value=>{
     verify(row,identity);const target=[...contexts.values()].find(c=>c.pluginId===identity.pluginId&&['characterId','personaId','lifeId','operationId','sessionId','conversationId','channel'].every(k=>c[k]===value.scope[k]));
     verify(target,identity);const offerId=randomUUID(),lease=await core(target,'activity.lease',{activityId:'delivery:'+offerId});
     return new Promise((resolve,reject)=>{
      const entry={offerId,row:target,lease,text:value.text,sourceEventId:value.sourceRefs?.[0],expressionMessageId:value.messageId,expressionCandidateId:value.candidateId,expressionIntroName:qqExpressionIntroName(row.characterId),operatorGeneration:row.operatorGeneration,identity,claimed:false,resolve,reject};
      entry.timer=setTimeout(()=>{offers.delete(offerId);reject(fail('SOCIAL_DELIVERY_RESULT_UNKNOWN'));void core(target,'activity.finish',{leaseId:lease.leaseId,status:'unknown'}).catch(()=>{});},30000);
      offers.set(offerId,entry);onEvent(identity,{type:'proactive.deliver',offerId});
     });
    }}));deliveryAdapters.set(identity.pluginId,adapters);
  }
  return publicContext(row);
 }
 async function checkLease(row,payload,options){if(!r95().socialProfile(row.characterId,{channel:row.channel,conversationId:row.conversationId}).available)throw fail('SOCIAL_ACTIVITY_DEFERRED');return core(row,'activity.check',{leaseId:payload.leaseId,generation:payload.generation??row.account.generation},options);}
 const handlers={'social.context.read':readContext};
  async function recoverFullReading(identity,owner,{signal,check}){
   const api=biliVision.fullReading;let reading=api.getForAccount(owner);const latest=reading.calls?.at(-1)?.stepId;
   if(!latest||reading.phase==='cancelled'||typeof api.verifyRecoveryMaterial!=='function'||typeof api.reconcile!=='function')return reading;
   const currentAccount=accounts.forPlugin(identity.packageName),records=journal.recoveryModels({pluginId:identity.pluginId,accountBindingId:currentAccount.accountId,bindingGeneration:currentAccount.generation,readingId:owner.readingId,stepId:latest});
   for(const record of records){
    if(record.input.readingId!==owner.readingId||record.input.stepId!==latest||record.result.hostReadingMode!=='full-v1'||hash(record.input)!==record.digest||hash(record.input.material)!==hash(record.result.hostMaterial))continue;
    const original=journal.recoveryContext(record.scope);let proof,understanding,schemaValid;
    try{
     if(!original||original.account.ref!==owner.accountRef||original.account.accountId!==owner.accountBindingId||!Number.isSafeInteger(original.grantGeneration))continue;
     bridge.grants.assertGeneration(identity.pluginId,original.grantGeneration);bridge.grants.require(identity.pluginId,'models.request',{permissionScope:['models.request']});verify(original,identity);
     const exact=api.get({scope:visionScope(original),readingId:owner.readingId});if(exact.phase==='cancelled'||exact.planHash!==reading.planHash||record.input.material?.readRange?.planHash!==exact.planHash)continue;
     assertFullReadingModel(exact,capturedModel(original));proof=api.verifyRecoveryMaterial({scope:visionScope(original),readingId:owner.readingId,batchId:latest,material:record.input.material,visualMaterialRefs:record.input.visualMaterialRefs});
     if(proof.stepKind!==record.input.stepKind)continue;understanding=record.result.understanding;try{understanding??=JSON.parse(record.result.text??'null');}catch{understanding=null;}
     schemaValid=validFullReadingUnderstanding(understanding,new Set(record.input.material.items.map(item=>item.id)));
    }catch{continue;}
    await check();signal?.throwIfAborted();verify(original,identity);bridge.grants.assertGeneration(identity.pluginId,original.grantGeneration);
    const accountNow=accounts.forPlugin(identity.packageName);if(accountNow.ref!==currentAccount.ref||accountNow.generation!==currentAccount.generation||api.getForAccount(owner).phase==='cancelled')return api.getForAccount(owner);
    const {hostMaterial,hostVideo,hostReadingMode,hostReadingId,completedAt,...result}=record.result;
    const processed=!!(schemaValid&&understanding.completedMaterial===true),existing=api.get({scope:visionScope(original),readingId:owner.readingId}),completed=existing.calls?.find(call=>call.stepId===latest&&call.status==='completed');
    if(completed){if(completed.providerRequestId!==result.requestId||completed.processed!==processed)continue;reading=existing;}
    else reading=api.reconcile({scope:visionScope(original),readingId:owner.readingId,batchId:latest,inputHash:proof.inputHash,providerRequestId:result.requestId,result});
    if(!reading.calls?.some(call=>call.stepId===latest&&call.status==='completed'&&call.processed===processed&&call.providerRequestId===result.requestId))return reading;
    journal.markReconciled({id:record.id,input:record.input,scope:record.scope});
    return {...reading,recoveredResults:[{readingId:owner.readingId,planHash:reading.planHash,stepId:latest,stepKind:proof.stepKind,inputHash:proof.inputHash,providerRequestId:result.requestId,material:copy(record.input.material),understanding:safeModelResult(original,understanding),...(!processed?{receiptKind:'invalid',schemaInvalid:!schemaValid,result:safeModelResult(original,result)}:{})}]};
   }
   return reading;
  }
  handlers['activity.lease']=async({context:row,payload,signal,check})=>{
  if(!r95().socialProfile(row.characterId,{channel:row.channel,conversationId:row.conversationId}).available)throw fail('SOCIAL_ACTIVITY_DEFERRED','Character is asleep or another interaction is active');
   const activityId=payload.activityId??hash([row.contextRef,payload.purpose,payload.sourceMessageId]);const lease=await core(row,'activity.lease',{activityId},{signal,check});row.leases.add(lease.leaseId);return lease;
 };
 handlers['activity.check']=({context,payload,signal})=>checkLease(context,payload,{signal});
 handlers['activity.finish']=async({context,payload,signal})=>{
  for(const [id,entry]of offers)if(entry.lease.leaseId===payload.leaseId&&entry.row===context){clearTimeout(entry.timer);offers.delete(id);entry.reject(fail('SOCIAL_DELIVERY_RESULT_UNKNOWN'));}
   try{const result=await core(context,'activity.finish',{leaseId:payload.leaseId,status:terminals.get(payload.status)??'failed'},{signal});context.leases.delete(payload.leaseId);return result;}finally{if(context.channel==='bilibili'&&fullReady())await biliVision.fullReading.cancelScope(visionScope(context));}
 };
 handlers['connections.open']=({context,payload,signal})=>{if(payload.connectionRef!==context.account.ref||payload.accountId!==context.account.accountId)throw fail('SOCIAL_ACCOUNT_CHANGED');return transport.open(payload,context,{signal});};
 handlers['connections.events']=({identity,context,payload,signal,check})=>transport.events(payload,context,{signal,check:async()=>{await check();verify(context,identity);}});
 handlers['connections.close']=({context,payload})=>transport.closeConnection(payload.connectionId,context);
 handlers['connections.request']=async({identity,context:row,payload,signal,check=async()=>{}})=>{
  if(['qq.memory.status','qq.memory.retry'].includes(payload.operation)){
   await check();if(!row.management||identity.packageName!=='@ai-buddy/qq-connect'||row.management.kind!=='app'||payload.operation==='qq.memory.retry'&&row.management.action!=='memory.retry')throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');const a=accounts.forPlugin(identity.packageName);if(payload.accountId!==a.accountId)throw fail('SOCIAL_ACCOUNT_CHANGED');seedLegacyMemory();
   if(payload.operation==='qq.memory.retry'){if(typeof payload.requestId!=='string'||!payload.requestId)throw fail('QQ_MEMORY_REQUEST_REQUIRED');const intent=transport.qqMemoryList?.({pluginId:identity.pluginId,accountRef:a.ref,requestIds:[payload.requestId],limit:1})[0];if(!intent)throw fail('QQ_MEMORY_PROOF_MISSING');if(intent.state!=='committed'){try{verifyMemoryContext(intent.proof.context);}catch(error){transport.qqMemoryUpdate(intent.id,{state:'needs-review',error:error.code??'QQ_MEMORY_ORIGINAL_CONTEXT_INVALID'});throw error;}transport.qqMemoryUpdate(intent.id,{state:'pending',attempts:0,nextAt:0});await recoverQqMemory();}}
   const requestIds=payload.operation==='qq.memory.retry'?[payload.requestId]:Array.isArray(payload.requestIds)?payload.requestIds.filter(id=>typeof id==='string').slice(0,200):[];return {items:(requestIds.length?transport.qqMemoryList?.({pluginId:identity.pluginId,accountRef:a.ref,requestIds,limit:200})??[]:[]).map(value=>({requestId:value.proof.requestId,memoryState:value.state,attempts:value.attempts,nextAt:value.next_at,errorCode:value.last_error,eventRef:value.event_ref}))};
  }
  if(payload.operation?.startsWith('video.fullReading.')){
   if(identity.packageName!=='@ai-buddy/bilibili-companion'||!fullReady())throw fail('BILI_VISION_UNAVAILABLE');const api=biliVision.fullReading,op=payload.operation.slice('video.fullReading.'.length),p={...payload,...payload.parameters};
   if(row.management){await check();const a=accounts.forPlugin(identity.packageName),owner={pluginId:identity.pluginId,accountRef:a.ref,accountBindingId:a.accountId,readingId:p.readingId};
    if(op==='get')return recoverFullReading(identity,owner,{signal,check});
    if(op==='image')return api.readImageForAccount({...owner,ref:p.ref});
    if(op==='open'){if(row.management.action!=='reading.open'||typeof p.activityId!=='string'||p.activityId.length>300)throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');api.getForAccount(owner);return onReadingOpen({activityId:p.activityId});}
    if(op==='confirm'||op==='continue'){if(row.management.action!=='reading.'+op||p.confirmed!==true)throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');return api.confirmForAccount({...owner,planHash:p.planHash,confirmed:true});}
    if(op==='pause'||op==='stop'){if(row.management.action!=='reading.'+op&&!(op==='stop'&&row.management.action==='reading.replan'))throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');return api[op+'ForAccount'](owner);}throw fail('BILI_VISION_OPERATION_INVALID');
   }
   if(row.channel!=='bilibili'||p.connectionRef&&p.connectionRef!==row.account.ref)throw fail('BILI_VISION_SCOPE_DENIED');const guarded=async()=>{await check();verify(row,identity);await checkLease(row,p,{signal});};await guarded();
   const scope=visionScope(row),profile=capturedModel(row),capability=imageInputCapability(profile);if(!capability.supported)throw fail(capability.reason);
   if(op==='prepare'){const authority=fullReadingAuthority(p,row.observations.map(id=>transport.observation(id)).filter(Boolean));if(requireBiliMedia){await requireBiliMedia({signal});await guarded();}return api.prepare({scope,...authority,config:p.config,model:fullReadingModel(profile),readingId:p.readingId,signal,check:guarded});}
   const reading=api.get({scope,readingId:p.readingId});assertFullReadingModel(reading,profile);
   if(op==='get')return reading;if(op==='read')return api.read({scope,readingId:p.readingId,shrink:p.shrink===true,signal,check:guarded});throw fail('BILI_VISION_OPERATION_INVALID');
  }
  if(payload.operation?.startsWith('video.storyboard.')){
   const parameters=payload.parameters??{};payload={...payload,...Object.fromEntries(['readingId','from','to','stepKind','ref','activityId','confirmed','additionalCalls','subtitles','hasSubtitles'].filter(k=>Object.hasOwn(parameters,k)).map(k=>[k,parameters[k]]))};
   if(identity.packageName!=='@ai-buddy/bilibili-companion'||!visionReady())throw fail('BILI_VISION_UNAVAILABLE');
   if(row.management){await check();const a=accounts.forPlugin(identity.packageName),owner={pluginId:identity.pluginId,accountRef:a.ref,accountBindingId:a.accountId,readingId:payload.readingId};
    if(payload.operation==='video.storyboard.open'){const activityId=payload.activityId??payload.readingId;if(row.management.action!=='reading.open'||typeof activityId!=='string'||activityId.length>300)throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');biliVision.getForAccount(owner);return onReadingOpen({activityId});}
    if(payload.operation==='video.storyboard.continue'){if(row.management.action!=='reading.continue'||payload.confirmed!==true||payload.additionalCalls!==16)throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');return biliVision.grantForAccount({...owner,additionalCalls:16});}
    if(payload.operation==='video.storyboard.stop'){if(row.management.action!=='reading.stop')throw fail('TRUSTED_UI_PRINCIPAL_REQUIRED');return biliVision.stopForAccount(owner);}
    if(payload.operation==='video.storyboard.get')return biliVision.getForAccount(owner);
    if(payload.operation==='video.storyboard.image')return biliVision.readImageForAccount({...owner,ref:payload.ref});throw fail('BILI_VISION_OPERATION_INVALID');}
   if(row.channel!=='bilibili'||payload.connectionRef&&payload.connectionRef!==row.account.ref)throw fail('BILI_VISION_SCOPE_DENIED');await checkLease(row,payload,{signal});const guarded=async()=>{await check();verify(row,identity);await checkLease(row,payload,{signal});};await guarded();
   if(payload.operation==='video.storyboard.get')return biliVision.get({scope:visionScope(row),readingId:payload.readingId});
   if(payload.operation==='video.storyboard.prepare'){const capability=imageInputCapability(getProvider?.()?.captureConnection?.({enabled:true,connectionId:row.modelConnectionRef??row.connectionRef}));if(!capability.supported)throw fail(capability.reason);const actual=row.observations.map(id=>transport.observation(id)).filter(Boolean).map(o=>{try{return JSON.parse(o.body)?.data;}catch{return null;}}).find(v=>v?.bvid===payload.video?.videoId&&Number.isSafeInteger(v.cid));if(!actual)throw fail('SOCIAL_UNOBSERVED_MATERIAL');if(requireBiliMedia){await requireBiliMedia({signal});await guarded();}return biliVision.prepare({scope:visionScope(row),video:{videoId:actual.bvid,cid:actual.cid,duration:actual.pages?.find(p=>p.cid===actual.cid)?.duration??actual.duration,title:actual.title},hasSubtitles:payload.hasSubtitles===true,readingId:payload.readingId,signal,check:guarded});}
   if(payload.operation==='video.storyboard.read'){const subtitles=payload.subtitles??[],reading=biliVision.get({scope:visionScope(row),readingId:payload.readingId}),observed=row.observations.map(id=>transport.observation(id)).filter(Boolean).flatMap(o=>{try{return JSON.parse(o.body)?.body??[];}catch{return[];}});if(!Array.isArray(subtitles)||subtitles.length>20000||subtitles.some(x=>typeof x.text!=='string'||!Number.isFinite(x.start)||!Number.isFinite(x.end)||x.start<0||x.start>x.end||x.end>reading.duration||!observed.some(y=>y.content===x.text&&y.from===x.start&&y.to===x.end)))throw fail('SOCIAL_UNOBSERVED_MATERIAL');return biliVision.read({scope:visionScope(row),readingId:payload.readingId,from:payload.from,to:payload.to,stepKind:payload.stepKind,subtitles,signal,check:guarded});}
   throw fail('BILI_VISION_OPERATION_INVALID');
  }
  await checkLease(row,payload,{signal});const guarded=async()=>{await check();await checkLease(row,payload,{signal});};
  if(payload.platform==='bilibili'&&payload.method==='POST'){
   const actual=[...row.models.values()].find(model=>{try{return JSON.parse(model.result.text).text===payload.form?.message;}catch{return false;}});
   if(row.visibilityScope!=='public'||!actual||String(actual.video?.aid)!==String(payload.form?.oid))throw fail('SOCIAL_COMMENT_SCOPE_DENIED');
  }
  const result=await transport.request(payload,row,{signal,check:guarded,...(row.channel.startsWith('qq-')?{memoryContext:memoryContext(row)}:{})});if(row.channel.startsWith('qq-')&&payload.action==='get_msg'){const verified=buildQqMessageEnvelope({raw:row.raw,accountId:row.account.accountId,conversationId:row.conversationId,verifiedReplies:[result]}).replyTo;if(verified?.resolution==='verified'){qqReplyObservations.set(qqReplyKey(row),verified);if(qqReplyObservations.size>128)qqReplyObservations.delete(qqReplyObservations.keys().next().value);}}if(result.observationId){row.observations.push(result.observationId);row.facts??=[];row.facts.push(transport.observation(result.observationId));saveContext(row);}
  for(const [id,entry]of offers)if(entry.row===row&&entry.lease.leaseId===payload.leaseId){
   clearTimeout(entry.timer);offers.delete(id);
   if(result.status==='sent'&&result.messageId){try{const observed=(row.facts??[]).find(o=>o?.kind==='qq-send'&&o.requestId===payload.requestId&&o.messageId===result.messageId);if(!observed||typeof entry.expressionMessageId!=='string'||typeof entry.expressionCandidateId!=='string'){entry.reject(fail('SOCIAL_DELIVERY_RESULT_UNKNOWN'));continue;}const projected=qqExpressionWireMatches(entry,observed.text),anchor={id:entry.expressionMessageId,kind:'qq-expression-projection',sha256:hash(entry.text),candidateId:entry.expressionCandidateId},record=r95().socialHost.recordContextEvidence({pluginId:identity.pluginId,contextRef:row.contextRef,nativeEvidenceId:observed.messageId,sourceKind:'qq-outbound',stage:'sent',status:'completed',text:observed.text,...(Number.isFinite(observed.occurredAt)?{occurredAt:observed.occurredAt}:{}),deliveryState:'sent',evidenceRefs:projected?[anchor]:[]}),actual=r95().socialHost.readEvidence(identity.pluginId,record.eventRef);row.outboundEvidenceRefs??=[];row.outboundEvidenceRefs.push([observed.messageId,record.eventRef]);saveContext(row);entry.resolve({status:'sent',nativeMessageId:result.messageId,...(projected?{eventRef:record.eventRef,sourcePluginId:identity.pluginId,sourceHash:actual.sourceHash,sourceVersion:actual.sourceVersion??1}:{})});}catch(error){entry.reject(error);throw error;}}else entry.reject(fail('SOCIAL_DELIVERY_RESULT_UNKNOWN'));
  }
  if(row.channel.startsWith('qq-')&&result.status==='sent')scheduleMemory(1000);return result;
 };
 handlers['models.request']=async({identity,context:row,payload,signal,check})=>{
  const qqReply=row.channel.startsWith('qq-')&&payload.purpose==='qq-reply',replyStylePolicy=qqReply?validateQqReplyStylePolicy(payload.replyStylePolicy):undefined;
   if(payload.replyStylePolicy!==undefined&&!qqReply)throw fail('QQ_REPLY_STYLE_SCOPE_DENIED');
   const full=payload.readingMode==='full-v1',vision=payload.visualMaterialRefs!==undefined;let fullProof=null,enteredJournal=false;try{
  if(row.channel==='bilibili')await requireBilibiliLogin(row.account,{signal,check});
  await checkLease(row,payload,{signal});
  const connectionRef=row.modelConnectionRef??row.connectionRef;
  if(payload.connectionRef&&payload.connectionRef!==connectionRef)throw fail('R95_CONNECTION_UNAVAILABLE','Selected activity model differs from the current character binding');
  if(vision&&(row.channel!=='bilibili'||identity.packageName!=='@ai-buddy/bilibili-companion'||!visionReady()))throw fail('BILI_VISION_UNAVAILABLE');
  if(vision){const capability=imageInputCapability(getProvider?.()?.captureConnection?.({enabled:true,connectionId:connectionRef}));if(!capability.supported)throw fail(capability.reason);if(typeof payload.readingId!=='string'||typeof payload.stepId!=='string'||!['overview','segment','zoom','summary'].includes(payload.stepKind))throw fail('BILI_VISION_STEP_INVALID');}
  let messages,system=String(payload.system??'');
  if(row.channel.startsWith('qq-')){const envelope=buildQqMessageEnvelope({raw:row.raw,accountId:row.account.accountId,conversationId:row.conversationId}),quoted=qqReplyObservations.get(qqReplyKey(row));if(quoted&&envelope.replyTo?.messageId===quoted.messageId)envelope.replyTo=copy(quoted);messages=[{role:'user',content:JSON.stringify(envelope)}];}
   else if(full){
    if(!vision||!fullReady()||!Array.isArray(payload.messages)||!payload.messages.length)throw fail('BILI_VISION_UNAVAILABLE');
    const scope=visionScope(row),reading=biliVision.fullReading.get({scope,readingId:payload.readingId});assertFullReadingModel(reading,capturedModel(row));fullProof=biliVision.fullReading.verifyMaterial({scope,readingId:payload.readingId,batchId:payload.stepId,material:payload.material,visualMaterialRefs:payload.visualMaterialRefs});if(fullProof.stepKind!==payload.stepKind)throw fail('SOCIAL_UNOBSERVED_MATERIAL');messages=[{role:'user',content:JSON.stringify({readingMode:'full-v1',stepKind:fullProof.stepKind,finalSummary:fullProof.finalSummary===true,planHash:reading.planHash,material:payload.material})}];
   }else {
    if(!Array.isArray(payload.messages)||!payload.material?.items?.length)throw fail('SOCIAL_MATERIAL_REQUIRED');
   const observations=row.observations.map(id=>transport.observation(id)).filter(Boolean);
   const actualTexts=[];for(const observation of observations){try{const value=JSON.parse(observation.body);for(const item of value.body??[])if(typeof item.content==='string')actualTexts.push(item.content);if(value.data?.title)actualTexts.push('标题：'+value.data.title+'\n简介：'+(value.data.desc||'未提供简介'));}catch{}}
   const materialAccount=hash([identity.pluginId,row.account.ref,row.account.generation]);
   const speech=payload.material.items.filter(x=>typeof x.id==='string'&&x.id.startsWith('speech:'));
   if(speech.length&&(!vision||!biliVision.verifySpeech?.({scope:visionScope(row),readingId:payload.readingId,items:speech})))throw fail('SOCIAL_UNOBSERVED_MATERIAL');
   if(!journal.material(materialAccount,payload.material)){
    if(payload.material.items.filter(item=>!speech.includes(item)).some(item=>vision&&typeof item.imageRef==='string'?!(item.text===undefined&&Array.isArray(payload.visualMaterialRefs)&&payload.visualMaterialRefs.includes(item.imageRef)):typeof item.text!=='string'||!actualTexts.includes(item.text)))throw fail('SOCIAL_UNOBSERVED_MATERIAL','Material was not obtained by the host transport');
    journal.rememberMaterial(materialAccount,payload.material);
   }
   messages=payload.messages;
  }
  const stableId=vision?payload.readingId+':'+payload.stepId:payload.requestId??payload.activityId;
  if(typeof stableId!=='string'||!stableId)throw fail('SOCIAL_MODEL_REQUEST_ID_REQUIRED');
  const requestKey=hash([identity.pluginId,row.account.ref,row.account.generation,row.characterId,row.personaId,row.lifeId,row.operationId,stableId,payload.purpose]);
   const journalInput={connectionRef,messages,system,purpose:payload.purpose,...(qqReply?{replyStylePolicy}:{}),material:payload.material??null,...(vision?{readingId:payload.readingId,stepId:payload.stepId,stepKind:payload.stepKind,visualMaterialRefs:payload.visualMaterialRefs}:{})};
   const receipt=value=>({...value,hostMaterial:copy(payload.material??null),hostVideo:copy(payload.video??null),...(full?{hostReadingMode:'full-v1',hostReadingId:payload.readingId}:{}),completedAt:now()});
   enteredJournal=true;const result=await journal.model({id:requestKey,input:journalInput,scope:row},async({observeLifecycle})=>{
   await check();await checkLease(row,payload,{signal});
   let ticket=null,claimed=false,lifecycleNotSent=false,observed=false;const scope=vision?visionScope(row):null,api=full?biliVision.fullReading:biliVision;
   try{if(full){const beforeSubmit=async()=>{await check();verify(row,identity);await checkLease(row,payload,{signal});assertFullReadingModel(api.get({scope,readingId:payload.readingId}),capturedModel(row));const claim=api.claim({scope,readingId:payload.readingId,batchId:payload.stepId,inputHash:fullProof.inputHash});if(!claim.claimed)throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');claimed=true;};const images=api.resolve({scope,readingId:payload.readingId,visualMaterialRefs:payload.visualMaterialRefs});ticket=images.length?registerHostImages(images,row,{beforeSubmit}):registerHostSubmission(row,{beforeSubmit});}else if(vision){const images=await biliVision.resolve({scope,readingId:payload.readingId,visualMaterialRefs:payload.visualMaterialRefs});for(const item of payload.material.items.filter(x=>typeof x.imageRef==='string')){const image=images.find(x=>x.ref===item.imageRef);if(!image||item.start!==image.from||item.end!==image.to)throw fail('SOCIAL_UNOBSERVED_MATERIAL');}ticket=registerHostImages(images,row,{beforeSubmit:async()=>{await check();verify(row,identity);await checkLease(row,payload,{signal});const claim=biliVision.claim({scope,readingId:payload.readingId,stepId:payload.stepId,stepKind:payload.stepKind,inputHash:hash([messages,system,payload.visualMaterialRefs])});if(!claim.claimed)throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');claimed=true;}});}
    const observe=value=>{journal.observeModel({id:requestKey,input:journalInput,scope:row,result:receipt(value)});observed=true;};
    const matches=value=>{if(!['social-chat','bilibili-vision'].includes(value.input?.kind)||hash(value.input.messages)!==hash(messages))return false;const keys=['pluginId','characterId','personaId','lifeId','operationId','sessionId','channel','conversationId','accountBindingId','actorId','bindingGeneration','activityGeneration','visibilityScope'];return !keys.some(key=>value.scope?.[key]!==row[key]);};
    const value=await withR95ModelLifecycle(value=>{if(!matches(value))return;observeLifecycle(value.event);if(value.event.phase==='not-sent')lifecycleNotSent=true;},()=>withR95ModelObservation(async value=>{if(matches(value))observe(value.result);},()=>core(row,'models.request',{connectionRef,messages,system,leaseId:payload.leaseId,...(qqReply?{purpose:'qq-reply',replyStylePolicy}:{}),...(ticket?{hostVisionToken:ticket}:{})},{signal,observeResult:value=>{if(!observed)observe(value);}})));if(claimed)api.finish({scope,readingId:payload.readingId,...(full?{batchId:payload.stepId,result:value}:{stepId:payload.stepId}),status:'completed',providerRequestId:value.requestId});
    return receipt(value);
   }catch(error){
    const submission=getModelSubmissionState(error),unsent=submission?.phase==='not-sent'&&lifecycleNotSent&&!observed;
    if(unsent){
     if(claimed){
      if(full&&typeof api.releaseUnsent==='function'){try{const released=api.releaseUnsent({scope,readingId:payload.readingId,batchId:payload.stepId,inputHash:fullProof.inputHash});if(released?.released===false)throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');claimed=false;}catch{api.finish({scope,readingId:payload.readingId,batchId:payload.stepId,status:'unknown'});throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');}}
      // Older visual stores have no exact durable release operation.
      else {api.finish({scope,readingId:payload.readingId,...(full?{batchId:payload.stepId}:{stepId:payload.stepId}),status:'unknown'});throw fail('SOCIAL_MODEL_RESULT_UNKNOWN');}
     }
     throw markModelNotSubmitted(error);
    }
    if(claimed)api.finish({scope,readingId:payload.readingId,...(full?{batchId:payload.stepId}:{stepId:payload.stepId}),status:'unknown'});
    throw vision&&!claimed?markModelNotSubmitted(error):vision&&claimed&&error?.code==='SOCIAL_MODEL_NOT_SUBMITTED'?fail('SOCIAL_MODEL_RESULT_UNKNOWN'):error;
   }finally{if(ticket)releaseHostImages(ticket);}
  },{beforePrepare:async()=>{if(row.channel==='bilibili'&&row.public!==true&&identity.packageName==='@ai-buddy/bilibili-companion'&&requireBiliMedia){await check();verify(row,identity);await checkLease(row,payload,{signal});try{await requireBiliMedia({signal});}catch(cause){if(cause.code?.startsWith('FFMPEG_COMPONENT_'))throw modelNotSubmittedError(cause);throw cause;}await check();verify(row,identity);await checkLease(row,payload,{signal});}}});
  row.models.set(result.requestId,{result:copy(result),material:copy(payload.material??null),video:copy(payload.video??null),observations:[...row.observations]});
   await check();await checkLease(row,payload,{signal});verify(row,identity);signal?.throwIfAborted();attemptFor(row,payload.leaseId)?.owner?.check();
   const {hostMaterial,hostVideo,hostReadingMode,hostReadingId,completedAt,...publicResult}=result;
   if(full&&typeof biliVision.fullReading.reconcile==='function')biliVision.fullReading.reconcile({scope:visionScope(row),readingId:payload.readingId,batchId:payload.stepId,inputHash:fullProof.inputHash,providerRequestId:publicResult.requestId,result:publicResult});
   journal.completeObserved({id:requestKey,input:journalInput,scope:row});const safe=safeModelResult(row,publicResult);if(qqReply&&typeof safe.text==='string')safe.text=filterReplySourceLabels(safe.text,{requestText:messages.map(message=>{try{const envelope=JSON.parse(message.content);return envelope.kind==='qq-message'?envelope.segments.filter(part=>part.type==='text').map(part=>part.text).join('\n'):message.content;}catch{return message.content;}}).join('\n')});return safe;
  }catch(error){throw vision&&!enteredJournal?modelNotSubmittedError(error):error;}
 };
 handlers['experience.append']=async({identity,context:row,payload,signal})=>{
  let owned=null;try{if(row?.recoveredEvidenceOnly&&row.channel.startsWith('qq-')&&contexts.get(row.persistedToken)!==row){const token=row.persistedToken;row=await restoreForEvidence(identity,token,{onCreated:value=>{owned={row:value,token};}});verify(row,identity);}
  let ref;
  if(row.channel==='bilibili'){
   let model=row.models.get(payload.providerRequestId);
   if(!model){const saved=journal.result(payload.providerRequestId);if(saved&&['pluginId','characterId','personaId','lifeId','operationId','sessionId','accountBindingId','bindingGeneration'].every(k=>saved.scope[k]===row[k]))model={result:saved.result,material:saved.result.hostMaterial,video:saved.result.hostVideo};}
   if(!model)throw fail('BUDDY_EVIDENCE_MISSING');let parsed;try{parsed=JSON.parse(model.result.text);}catch{throw fail('SOCIAL_UNDERSTANDING_INVALID');}
   if(payload.sourceKind==='bilibili-comment'){
    const observed=(row.facts??[]).find(o=>{try{const body=JSON.parse(o.body);return o.method==='POST'&&body.code===0&&String(body.data?.rpid??body.data?.reply?.rpid)===payload.platformMessageId;}catch{return false;}});
    if(row.visibilityScope!=='public'||payload.deliveryState!=='sent'||!observed||parsed.text!==payload.text)throw fail('BUDDY_EVIDENCE_MISSING');
    ref=r95().socialHost.recordContextEvidence({pluginId:identity.pluginId,contextRef:row.contextRef,nativeEvidenceId:payload.platformMessageId,sourceKind:'bilibili-comment',stage:'sent',status:'completed',text:parsed.text,occurredAt:model.result.completedAt,deliveryState:'sent'}).eventRef;
   }else{
   if(model.result.hostReadingMode==='full-v1'){const reading=biliVision.fullReading.get({scope:visionScope(row),readingId:model.result.hostReadingId});if(payload.activityId!==model.result.hostReadingId||reading.phase!=='completed'||reading.coverage?.complete!==true||reading.finalProcessed!==true||!validFullReadingUnderstanding(parsed,new Set(model.material.items.map(item=>item.id)))||reading.finalProviderRequestId!==payload.providerRequestId)throw fail('BILI_FULL_COVERAGE_INCOMPLETE');}
   if(parsed.summary!==payload.summaryCandidate||!Array.isArray(parsed.evidenceRefs)||!parsed.evidenceRefs.length||parsed.evidenceRefs.some(id=>!model.material.items.some(i=>i.id===id)))throw fail('BUDDY_EVIDENCE_CONFLICT');
   const evidence=r95().socialHost.recordContextEvidence({pluginId:identity.pluginId,contextRef:row.contextRef,nativeEvidenceId:model.result.requestId,sourceKind:'bilibili-watch',stage:'understood',status:'completed',text:parsed.summary,occurredAt:model.result.completedAt,evidenceRefs:parsed.evidenceRefs});ref=evidence.eventRef;
   }
  }else if(payload.deliveryState==='sent'||payload.status==='sent'){
   const observed=(row.facts??[]).find(o=>o?.kind==='qq-send'&&o.requestId===payload.providerRequestId&&o.messageId===payload.sourceMessageId);if(!observed)throw fail('BUDDY_EVIDENCE_MISSING');
   const saved=(row.outboundEvidenceRefs??[]).find(([nativeId])=>nativeId===observed.messageId)?.[1];if(saved){const actual=r95().socialHost.readEvidence(identity.pluginId,saved);if(actual.sourceKind!=='qq-outbound'||actual.nativeMessageId!==observed.messageId||actual.text!==observed.text||actual.status!=='completed'||actual.stage!=='sent'||['characterId','personaId','lifeId','operationId','channel','conversationId','accountBindingId','actorId'].some(key=>actual[key]!==row[key]))throw fail('BUDDY_EVIDENCE_CONFLICT');ref=saved;}else ref=r95().socialHost.recordContextEvidence({pluginId:identity.pluginId,contextRef:row.contextRef,nativeEvidenceId:observed.messageId,sourceKind:'qq-outbound',stage:'sent',status:'completed',text:observed.text,...(Number.isFinite(observed.occurredAt)?{occurredAt:observed.occurredAt}:{}),deliveryState:'sent'}).eventRef;
  }else{if(!row.inboundEvent)throw fail('BUDDY_EVIDENCE_MISSING');ref=row.inboundEvent.eventRef;}
  if(row.channel.startsWith('qq-')&&(payload.deliveryState==='sent'||payload.status==='sent')){row.outboundEvidenceRefs??=[];if(!row.outboundEvidenceRefs.some(([id])=>id===payload.sourceMessageId))row.outboundEvidenceRefs.push([payload.sourceMessageId,ref]);saveContext(row);}
  const result=await core(row,'experience.append',{eventRef:ref},{signal});if(result?.recorded===true&&(payload.deliveryState==='sent'||payload.status==='sent')){const intent=transport.qqMemoryList?.({pluginId:row.pluginId,accountRef:row.account.ref,requestIds:[payload.providerRequestId],limit:1})?.find(value=>value.proof.messageId===payload.sourceMessageId);if(intent)transport.qqMemoryUpdate(intent.id,{state:'committed',eventRef:ref,nextAt:0});}if(payload.eventId)row.evidence.set(payload.eventId,ref);saveContext(row);return result;}finally{releaseOwnedEvidence(owned);}
 };
 handlers['proactive.offer']=async({context:row,payload,signal})=>{
  const ref=row.evidence.get(payload.eventId)??payload.eventId??row.inboundEvent?.eventRef;if(!ref)throw fail('BUDDY_EVIDENCE_MISSING');
  let admission;
  if(row.channel.startsWith('qq-'))admission=await core(row,'activity.lease',{activityId:'proactive-admission:'+randomUUID()},{signal});
  try{
   const value=await core(row,'proactive.offer',{eventRef:ref,kind:'share',text:payload.text??'',expiresAt:payload.expiresAt},{signal}),offerId=value.candidate?.id??value.offerId;
   if(admission){const id=admission.leaseId,timer=setTimeout(()=>{candidateAdmissions.delete(id);void core(row,'activity.finish',{leaseId:id,status:'cancelled'}).catch(()=>{});},300000);candidateAdmissions.set(id,{row,lease:admission,timer});}
   return {accepted:true,offerId,...value};
  }catch(error){if(admission)await core(row,'activity.finish',{leaseId:admission.leaseId,status:'failed'}).catch(()=>{});throw error;}
 };
 handlers['proactive.claim']=async({identity,context:operator,payload,signal})=>{
  const entry=offers.get(payload.offerId);
  if(!entry||entry.claimed||entry.identity.pluginId!==identity.pluginId||payload.accountId!==operator.account.accountId||payload.operatorGeneration!==operator.operatorGeneration||entry.operatorGeneration!==operator.operatorGeneration)return {admitted:false};
  verify(entry.row,identity);await checkLease(entry.row,entry.lease,{signal});entry.claimed=true;
  return {admitted:true,offerId:entry.offerId,operatorGeneration:entry.operatorGeneration,sourceEventId:entry.sourceEventId,text:entry.text,context:publicContext(entry.row),lease:entry.lease,recipient:{conversationType:entry.row.conversationType,peerId:entry.row.peerId,conversationId:entry.row.conversationId}};
 };
 handlers['search.native']=({context:row,payload,signal})=>core(row,'search.native',{query:payload.query,leaseId:payload.leaseId},{signal});
 for(const method of ['owner.work.propose','owner.work.read','owner.work.approve','owner.work.cancel'])handlers[method]=async({context:row,payload,signal})=>{
  await checkLease(row,payload,{signal});if(!row.ownerVerified||!row.inboundEvent)throw fail('BUDDY_OWNER_DENIED');
  const route=row.ownerRoute?.[row.account.accountId];
  return core(row,method,{eventRef:row.inboundEvent.eventRef,...(method==='owner.work.propose'?{projectId:route?.projectId}:{taskId:payload.taskId,planVersion:payload.planVersion,...(payload.challengeId?{challengeId:payload.challengeId}:{})})},{signal});
 };
 handlers['ui.bubble']=async({identity,context:row,payload})=>{if(payload.characterId!==row.characterId||typeof payload.title!=='string'||payload.title.length>1000)throw fail('SOCIAL_BUBBLE_INVALID');return onBubble({pluginId:identity.pluginId,characterId:row.characterId,title:payload.title,clear:payload.clear===true,activityId:payload.activityId,...(typeof payload.detail==='string'&&payload.detail.trim()?{detail:payload.detail.trim().slice(0,120)}:{})});};
 scheduleMemory(0);
 let closePromise;
 return {recoverQqMemory,handlers,contextProvider,features:()=>[...(typeof transport.qqMemoryList==='function'?['qq-memory-recovery-v1']:[]),...(visionReady()?['bilibili-vision-v1',...(fullReady()?['bilibili-full-reading-v1']:[])]:[])],close(){if(closePromise)return closePromise;const task=(async()=>{
  if(closed)return;memoryClosing=true;clearTimeout(memoryTimer);memoryTimer=null;memoryAbort.abort(fail('SOCIAL_HOST_CLOSED'));await memoryTask?.catch(()=>{});await Promise.allSettled([...pendingAdmissions]);
  const failures=[];
  for(const [id,admission]of candidateAdmissions){clearTimeout(admission.timer);try{await core(admission.row,'activity.finish',{leaseId:admission.lease.leaseId,status:'cancelled'});candidateAdmissions.delete(id);}catch(error){failures.push(error);}}
  for(const [id,entry]of offers){clearTimeout(entry.timer);entry.reject(fail('SOCIAL_HOST_CLOSED'));try{await core(entry.row,'activity.finish',{leaseId:entry.lease.leaseId,status:'unknown'});offers.delete(id);}catch(error){failures.push(error);}}
  for(const row of contexts.values())for(const leaseId of row.leases??[])try{await core(row,'activity.finish',{leaseId,status:'cancelled'});row.leases.delete(leaseId);}catch(error){failures.push(error);}
  if(failures.length)throw Object.assign(new AggregateError(failures,'Social activity cleanup is not confirmed'),{code:'SOCIAL_LEASE_RELEASE_UNCONFIRMED'});
  for(const adapters of deliveryAdapters.values())for(const adapter of adapters)adapter.revoke();deliveryAdapters.clear();
   for(const row of contexts.values()){row.revoke();bridge.authority?.revoke?.(row.contextToken);}contexts.clear();management.clear();operators.clear();operatorBindings.clear();closed=true;await journal.close();await biliVision?.close?.();
 })();closePromise=task;task.catch(()=>{if(closePromise===task)closePromise=null;});return task;}};
}
