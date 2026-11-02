import {randomUUID,createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {createDshMcpExport,dshMcpDescriptor,dshMcpToolId,dshMcpSchemaHash,dshMcpSchemaDigest} from './dsh-platform/mcp-export.mjs';

const fail=(message,code='WORK_TOOL_LEASE_DENIED')=>Object.assign(Error(message),{code});
const clone=value=>structuredClone(value);
const ordered=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(ordered):Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,ordered(value[key])])):value;
const canonical=value=>JSON.stringify(ordered(value));
const scopeFields=['characterId','personaId','lifeId','operationId'];
const identityFields=['pluginId','sourceId','packageKey','packageName','exactVersion','sourceDigest'];
const same=(a,b)=>canonical(a)===canonical(b);
const pinSource=source=>Object.fromEntries(['sourceId','descriptorId','keyId','keyFingerprint','publicKey','url','generation','enabled','removed'].map(key=>[key,source[key]]));
export const workToolSourceTrustDigest=source=>createHash('sha256').update(canonical(pinSource(source))).digest('hex');
const reserved=new Set(['buddy_work_query','buddy_work_plan','buddy_work_run','buddy_work_control']);
const nativeSelection=binding=>({provider:binding.provider,model:binding.model,...binding.effort==null?{}:{reasoningEffort:binding.effort}});
const usageIdentity=value=>typeof value==='string'&&value.length>0&&value.length<=2000&&!value.includes('\0');
const transportIdentity=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const receiptKeys=new Set(['schemaVersion','origin','purpose','accounting','usageMode','provider','model','modelEvidence','capturedModel','capturedBindingFingerprint','bindingMatched','providerRequestId','providerMessageId','transportRequestId','requestId','requestIdEvidence','nativeStreamId','nativeSessionId','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens','usageKnown','completion','nativeUsage','startedAt','finishedAt']);

/** Core-only composition: gate supplies persisted approval authority, never a renderer claim. */
export function createWorkCommunityToolLeases({getPlatform,platform:fixedPlatform,supervisor,onAudit=()=>{}}={}){
  const platform=()=>getPlatform?.()??fixedPlatform;
  if(typeof getPlatform!=='function'&&!fixedPlatform||!supervisor?.registerTaskRoot||!supervisor?.stopOwned)throw TypeError('Trusted platform and OS process supervisor are required');
  const rows=new Map(),byRun=new Map(),released=new Map();let closed=false;
  const audit=(type,row,extra={})=>onAudit({type,leaseId:row.leaseId,jobId:row.jobId,runId:row.runId,toolCount:row.tools.length,...extra});
  function meta(row){return {leaseId:row.leaseId,jobId:row.jobId,runId:row.runId,state:row.state,toolCount:row.tools.length,runtimeIds:[...row.runtimeIds]};}
  function revokeFromCall(row,code){if(code==='MCP_CANCELLED'||row.revoked)return;row.revoked=true;row.state='revoking';queueMicrotask(()=>{void closeRow(row).catch(error=>audit('work-tool-revoke-failed',row,{code:error.code??'WORK_TOOL_STOP_FAILED'}));});}
  function assertOwner(row,input){if(row.jobId!==input.jobId||row.runId!==input.runId)throw fail('Tool lease belongs to another admitted run','WORK_TOOL_SCOPE_DENIED');}
  async function authority(row,stage,signal){
    if(closed||row.revoked||signal?.aborted)throw fail('Task tool lease was revoked','WORK_TOOL_LEASE_CLOSED');
    try{
      await row.assertCurrent({jobId:row.jobId,runId:row.runId,taskId:row.taskId,scope:clone(row.scope),workspace:clone(row.workspace),approvedPlanRevision:row.approvedPlanRevision,tools:clone(row.tools),modelBinding:clone(row.modelBinding),stage,signal});
      if(closed||row.revoked||signal?.aborted)throw fail('Task tool lease was revoked','WORK_TOOL_LEASE_CLOSED');
      for(const record of row.records){
        const actual=await platform().resolveDshInstalled(record.packageKey),source=await platform().resolveTrustedSource(record.sourceId),grant=platform().bridge.grants.get(record.pluginId),selected=row.tools.filter(tool=>tool.packageKey===record.packageKey);
        if(actual.enabled!==true||identityFields.some(key=>actual[key]!==record[key])||actual.generation!==record.generation||actual.backendPlan?.artifactSha256!==record.backendPlan?.artifactSha256)throw fail('An approved package version or activation changed','WORK_TOOL_PACKAGE_CHANGED');
        if(source.enabled===false||source.removed===true||!same(pinSource(source),row.sourcePins.get(record.sourceId))||selected.some(tool=>tool.sourceTrustDigest!==workToolSourceTrustDigest(source)))throw fail('An approved tool source changed','WORK_TOOL_SOURCE_CHANGED');
        if(!grant?.enabled||!grant.granted.includes('tools.list')||!grant.granted.includes('tools.invoke')||selected.some(tool=>tool.grantGeneration!==grant.generation||tool.lifecycleGeneration!==record.generation||!same([...tool.capabilities].sort(),[...grant.granted].sort())))throw fail('An approved tool capability grant changed','WORK_TOOL_GRANT_CHANGED');
      }
    }catch(error){if(row.state==='active'&&!row.revoked){row.revoked=true;row.state='revoking';queueMicrotask(()=>{void closeRow(row).catch(cause=>audit('work-tool-revoke-failed',row,{code:cause.code??'WORK_TOOL_STOP_FAILED'}));});}throw error;}
  }
  async function issue(row,record,{signal,activeCall=false}={}){
    await authority(row,'context');const capabilities=row.tools.find(tool=>tool.packageKey===record.packageKey).capabilities;
    const spec={pluginId:record.pluginId,...row.scope,workspace:clone(row.workspace),taskId:row.taskId,sessionId:row.sessionId,permissionScope:[...capabilities],connectionRefs:row.modelBinding?[row.modelBinding.connectionRef]:[],planState:'execution',approvedPlanRevision:row.approvedPlanRevision};
    if(activeCall&&typeof platform().issueActiveToolContext!=='function')throw fail('Host active-call authority is unavailable','BUDDY_ACTIVE_CALL_REQUIRED');
    const issued=activeCall?await platform().issueActiveToolContext(spec,{callId:row.leaseId+':'+randomUUID(),signal,checkCurrent:()=>authority(row,'active-context',signal)}):await platform().issueToolContext(spec);
    if(issued?.contextToken)row.tokens.add(issued.contextToken);
    if(!issued?.contextToken||issued.pluginId!==record.pluginId||scopeFields.some(key=>issued.context?.[key]!==row.scope[key])||issued.context.taskId!==row.taskId||issued.context.sessionId!==row.sessionId||!same(issued.context.workspace,row.workspace)||issued.context.planState!=='execution'||issued.context.approvedPlanRevision!==row.approvedPlanRevision)throw fail('Fresh host context differs from the approved member scope','WORK_TOOL_SCOPE_DENIED');
    row.tokenContexts.set(issued.contextToken,{contextRevision:issued.context.contextRevision,sessionId:issued.context.sessionId});
    return issued;
  }
  function releaseToken(row,issued){if(issued?.contextToken){platform().bridge.authority.revoke(issued.contextToken);row.tokens.delete(issued.contextToken);row.tokenContexts.delete(issued.contextToken);}}
  async function authorizeModel(row,input,request){
    await assertActive({leaseId:row.leaseId,jobId:row.jobId,runId:row.runId,pluginId:request.pluginId,contextToken:request.contextToken,signal:request.signal});
    if(!row.modelBinding||typeof input.authorizeNativeModel!=='function')throw fail('Native AI requires a captured DSH model binding','DSH_NATIVE_MODEL_CONFIGURATION_REQUIRED');
    if(request.jobId!==row.jobId||request.runId!==row.runId||!row.runtimeIds.has(request.runtimeId)||!usageIdentity(request.profileId)||!usageIdentity(request.callId)||!transportIdentity(request.nativeStreamId)||!transportIdentity(request.nativeRequestId)||!row.tools.some(tool=>tool.pluginId===request.pluginId&&tool.nativeName===request.nativeToolName)||!same(request.modelSelection,nativeSelection(row.modelBinding)))throw fail('Native model admission differs from the exact leased run','WORK_TOOL_SCOPE_DENIED');
    const decision=await input.authorizeNativeModel({...request,leaseId:row.leaseId});
    if(decision?.allowed!==true)return decision;
    // This private receipt admits accounting for this existing call after
    // cancellation; it never permits a new call after context revocation.
    const context=row.tokenContexts.get(request.contextToken);if(!context)throw fail('Native model call lost its original scoped host context','WORK_TOOL_SCOPE_DENIED');
    const key=request.runtimeId+'\0'+request.callId,prior=row.modelAdmissions.get(key),admitted={runtimeId:request.runtimeId,profileId:request.profileId,callId:request.callId,nativeToolName:request.nativeToolName,pluginId:request.pluginId,contextToken:request.contextToken,contextRevision:context.contextRevision,contextSessionId:context.sessionId,modelSelection:clone(request.modelSelection),admittedAt:Date.now()};
    if(prior&&(prior.pluginId!==admitted.pluginId||prior.contextToken!==admitted.contextToken||prior.profileId!==admitted.profileId||prior.nativeToolName!==admitted.nativeToolName||!same(prior.modelSelection,admitted.modelSelection)))throw fail('A native call cannot change its accounting owner','WORK_TOOL_SCOPE_DENIED');
    const transportKey=request.nativeStreamId+'\0'+request.nativeRequestId,transportPrior=row.transportAdmissions.get(transportKey),transport={...admitted,nativeStreamId:request.nativeStreamId,transportRequestId:request.nativeRequestId,consumed:false};
    if(transportPrior&&(transportPrior.runtimeId!==admitted.runtimeId||transportPrior.callId!==admitted.callId||transportPrior.pluginId!==admitted.pluginId||transportPrior.contextToken!==admitted.contextToken))throw fail('A native HTTP identity cannot change its admitted owner','WORK_TOOL_SCOPE_DENIED');
    row.modelAdmissions.set(key,prior??admitted);if(!transportPrior)row.transportAdmissions.set(transportKey,transport);return decision;
  }
  function accountingAuthority(row,admitted){const record=row.records.find(value=>value.pluginId===admitted.pluginId),tool=row.tools.find(value=>value.pluginId===admitted.pluginId&&value.nativeName===admitted.nativeToolName);return {kind:'native-model-usage-admission',allowed:true,accountingOnly:true,leaseId:row.leaseId,jobId:row.jobId,runId:row.runId,taskId:row.taskId,memberId:row.memberId,scope:{...clone(row.scope),contextRevision:admitted.contextRevision},workspace:clone(row.workspace),contextSessionId:admitted.contextSessionId,approvedPlanRevision:row.approvedPlanRevision,modelBinding:clone(row.modelBinding),capturedModelBinding:clone(row.modelBinding),runtimeId:admitted.runtimeId,profileId:admitted.profileId,nativeProfileId:admitted.profileId,callId:admitted.callId,nativeToolCallId:admitted.callId,nativeToolName:admitted.nativeToolName,pluginId:admitted.pluginId,sourceId:record.sourceId,packageKey:record.packageKey,packageName:record.packageName,exactVersion:record.exactVersion,sourceDigest:record.sourceDigest,sourceTrustDigest:tool.sourceTrustDigest,nativeStreamId:admitted.nativeStreamId,transportRequestId:admitted.transportRequestId,admittedAt:admitted.admittedAt,leaseStateAtReceipt:row.state};}
  async function assertNativeTransport(input={}){
    const row=rows.get(input.leaseId);if(!row||row.state!=='active'||row.revoked)throw fail('Native model transport lease is no longer active','WORK_TOOL_LEASE_CLOSED');assertOwner(row,input);
    if(!transportIdentity(input.nativeStreamId)||!transportIdentity(input.transportRequestId))throw fail('Native model transport requires exact admitted request identities','WORK_TOOL_NATIVE_TRANSPORT_DENIED');
    const admitted=row.transportAdmissions.get(input.nativeStreamId+'\0'+input.transportRequestId);if(!admitted||admitted.consumed)throw fail('Native HTTP dispatch was not admitted or was already consumed','WORK_TOOL_NATIVE_TRANSPORT_DENIED');
    if(input.requestedModel!==undefined&&input.requestedModel!==row.modelBinding.model)throw fail('Actual native HTTP model differs from the captured work binding','WORK_TOOL_NATIVE_TRANSPORT_DENIED');
    await authority(row,'native-http-transport');if(row.revoked||admitted.consumed)throw fail('Native HTTP dispatch cannot be replayed','WORK_TOOL_NATIVE_TRANSPORT_DENIED');admitted.consumed=true;return {allowed:true,authority:{...accountingAuthority(row,admitted),kind:'native-model-transport-admission',accountingOnly:false}};
  }
  async function nativeUsage(row,input,event){
    const receipt=event.receipt,admitted=receipt&&row.transportAdmissions.get(event.nativeStreamId+'\0'+receipt.transportRequestId);
    if(!admitted||!admitted.consumed||row.state==='closed'||event.runtimeId!==admitted.runtimeId||event.nativeToolCallId!==admitted.callId||event.nativeToolName!==admitted.nativeToolName||event.jobId!==row.jobId||event.runId!==row.runId||event.pluginId!==admitted.pluginId||event.contextToken!==admitted.contextToken||event.profileId!==admitted.profileId||!transportIdentity(event.nativeStreamId))throw fail('Native usage has no exact prior model-call admission and actual HTTP dispatch','WORK_TOOL_USAGE_DENIED');
    if(!receipt||receipt.schemaVersion!==1||receipt.origin!=='managed-receipt'||receipt.purpose!=='native-community-tool'||receipt.accounting!=='independent'||receipt.usageMode!=='request'||receipt.provider!==row.modelBinding.provider||!usageIdentity(receipt.model)||!['provider-message-start','captured-binding-unreported'].includes(receipt.modelEvidence)||!usageIdentity(receipt.transportRequestId)||!usageIdentity(receipt.requestId)||!['provider-message-id','provider-header','host-observed-http-dispatch'].includes(receipt.requestIdEvidence)||!['completed','aborted','failed','incomplete'].includes(receipt.completion)||typeof receipt.usageKnown!=='boolean'||['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'].some(key=>receipt[key]!==null&&(!Number.isFinite(receipt[key])||receipt[key]<0)))throw fail('Native usage is not a supported actual transport receipt','WORK_TOOL_USAGE_DENIED');
    if(Object.keys(receipt).some(key=>!receiptKeys.has(key))||receipt.nativeUsage&&(typeof receipt.nativeUsage!=='object'||Array.isArray(receipt.nativeUsage)||Object.values(receipt.nativeUsage).some(value=>!Number.isFinite(value)||value<0))||receipt.capturedModel!==row.modelBinding.model||receipt.nativeStreamId!==event.nativeStreamId||receipt.capturedBindingFingerprint!==row.modelBinding.fingerprint||receipt.bindingMatched!==(receipt.model===row.modelBinding.model))throw fail('Native usage lost its bounded captured model evidence','WORK_TOOL_USAGE_DENIED');
    const key=event.nativeStreamId+'\0'+receipt.transportRequestId,safeEvent={runtimeId:event.runtimeId,profileId:event.profileId,jobId:row.jobId,runId:row.runId,pluginId:event.pluginId,nativeToolCallId:event.nativeToolCallId,nativeToolName:event.nativeToolName,nativeStreamId:event.nativeStreamId,receipt:clone(receipt),leaseId:row.leaseId},fingerprint=canonical(safeEvent),previous=row.modelUsage.get(key);
    if(previous){if(previous.fingerprint!==fingerprint)throw fail('A native usage receipt cannot change its counters or owner','WORK_TOOL_USAGE_CHANGED');return previous.promise;}
    const authorityProof=accountingAuthority(row,admitted);
    // The Core proxy observes and retains the actual upstream receipt first.
    // Co-resident native plugin/shim metadata is only a cross-check, never a
    // separate billable event or an authority to invent usage.
    const promise=Promise.resolve().then(async()=>{const result=await input.verifyNativeTransportUsage({event:safeEvent,authority:authorityProof});if(result?.verified!==true||result.recorded!==true)throw fail('Core transport did not verify and retain native usage','WORK_TOOL_USAGE_UNVERIFIED');if(input.onNativeModelUsage)await input.onNativeModelUsage({...safeEvent,authority:authorityProof,verifiedBy:'core-native-tool-proxy'});if(receipt.bindingMatched===false)revokeFromCall(row,'DSH_NATIVE_MODEL_BINDING_CHANGED');return {recorded:true,verified:true};});row.modelUsage.set(key,{fingerprint,promise});row.usagePending.add(promise);
    try{return await promise;}catch(error){row.modelUsage.delete(key);throw error;}finally{row.usagePending.delete(promise);}
  }
  async function closeResources(row){
    // Start both halves before awaiting either: ignored native aborts must not
    // deadlock an exporter waiting for actual drain before killing its Host.
    const results=await Promise.allSettled([row.exporter?.close(),row.backend?.close()]);
    const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
    const accounting=await Promise.allSettled([...row.usagePending]);for(const result of accounting)if(result.status==='rejected')failures.push(result.reason);
    for(const runtimeId of row.runtimeIds)try{const proof=await supervisor.stopOwned({jobId:row.jobId,runId:row.runId,runtimeId});if(proof.stopped!==true||proof.osActiveProcesses!==0||proof.registered===0)throw fail('Task tool OS descendants have no complete stop proof','WORK_PROCESS_STOP_UNCONFIRMED');}catch(error){failures.push(error);}
    if(failures.length){row.state='stop-unconfirmed';throw failures[0];}
    for(const token of row.tokens)platform().bridge.authority.revoke(token);row.tokens.clear();row.tokenContexts.clear();row.state='closed';rows.delete(row.leaseId);if(byRun.get(row.key)===row)byRun.delete(row.key);
    const result={released:true,drained:true,leaseId:row.leaseId,jobId:row.jobId,runId:row.runId,stopped:true,osActiveProcesses:0};released.set(row.leaseId,result);audit('work-tool-lease-released',row);return result;
  }
  function closeRow(row){
    if(row.closing)return row.closing;row.revoked=true;row.state='revoking';for(const token of row.tokens)platform().bridge.authority.revoke(token);row.controller.abort();
    row.closing=(async()=>{await row.prepared?.catch(()=>{});return closeResources(row);})();row.closing.catch(()=>{row.closing=null;});return row.closing;
  }
  async function prepare(row,input){
    if(!platform()?.createTaskToolBackend||!platform()?.issueToolContext)throw fail('Trusted plugin platform is not ready','WORK_TOOL_PLATFORM_UNAVAILABLE');
    for(const record of row.records){const source=await platform().resolveTrustedSource(record.sourceId);if(source.enabled===false||source.removed===true)throw fail('The tool source is disabled','WORK_TOOL_SOURCE_CHANGED');row.sourcePins.set(record.sourceId,pinSource(source));}
    await authority(row,'prepare');
    row.backend=await platform().createTaskToolBackend({jobId:row.jobId,runId:row.runId,records:row.records,assertCurrent:()=>authority(row,'runtime'),modelBinding:row.modelBinding,modelEnvironment:input.modelEnvironment,authorizeNativeModel:request=>authorizeModel(row,input,request),onNativeModelUsage:event=>nativeUsage(row,input,event),
      onProcessStart:async identity=>{await authority(row,'process-admission');const proof=await supervisor.registerTaskRoot(identity);if(proof.registered!==true||proof.guardReady!==true)throw fail('Task tool process guard is not ready','WORK_PROCESS_GUARD_REQUIRED');row.runtimeIds.add(identity.runtimeId);return proof;},
      onProcessStop:async identity=>{const proof=await supervisor.stopOwned({jobId:row.jobId,runId:row.runId,runtimeId:identity.runtimeId});if(proof.stopped!==true||proof.osActiveProcesses!==0||row.runtimeIds.has(identity.runtimeId)&&proof.registered===0)throw fail('Task tool descendants have not stopped','WORK_PROCESS_STOP_UNCONFIRMED');return proof;}});
    await authority(row,'native-discovery');const bindings=[];
    for(const record of row.records){
      const selected=row.tools.filter(tool=>tool.packageKey===record.packageKey);let issued,raw;
      try{issued=await issue(row,record);raw=await row.backend.listTools(issued);}finally{releaseToken(row,issued);}
      const values=Array.isArray(raw)?raw:raw?.tools??raw?.schemas??[],descriptors=values.map(tool=>dshMcpDescriptor(record,tool)).filter(Boolean),actual=new Map(descriptors.map(descriptor=>[descriptor.name,descriptor]));
      for(const tool of selected)if(!actual.has(tool.toolId)||!same(actual.get(tool.toolId),tool.mcpDescriptor)||dshMcpSchemaHash(actual.get(tool.toolId))!==tool.schemaHash)throw fail('Actual native tool differs from the approved descriptor','WORK_TOOL_SCHEMA_CHANGED');
      bindings.push({backend:row.backend,pluginId:record.pluginId,sourceId:record.sourceId,packageName:record.packageName,allowedToolIds:selected.map(tool=>tool.toolId),schemaDigest:dshMcpSchemaDigest(selected.map(tool=>tool.mcpDescriptor)),schemaHashes:Object.fromEntries(selected.map(tool=>[tool.toolId,tool.schemaHash])),beforeCall:({stage,signal})=>authority(row,stage,signal),onRevoke:({code})=>revokeFromCall(row,code),resolveContext:({stage,signal})=>issue(row,record,{signal,activeCall:stage==='call'}),releaseContext:issued=>releaseToken(row,issued)});
    }
    await authority(row,'export');row.exporter=await createDshMcpExport({bindings,onAudit:event=>audit('work-tool-mcp-'+event.type,row,{requestId:event.requestId,toolId:event.toolId,...event.error?{code:event.error.code}: {}})});await authority(row,'ready');row.state='active';audit('work-tool-lease-created',row);
    row.response={enabled:true,leaseId:row.leaseId,serverName:'buddy-community',url:row.exporter.url,headers:clone(row.exporter.headers),tools:clone(row.tools)};return clone(row.response);
  }
  async function acquire(input={}){
    if(closed)throw fail('Tool lease manager is closed','WORK_TOOL_LEASE_CLOSED');
    if(!input.jobId||!input.runId||!Array.isArray(input.tools)||typeof input.assertCurrent!=='function')throw fail('An admitted run and authority callback are required');
    if(!input.tools.length){await input.assertCurrent({jobId:input.jobId,runId:input.runId,stage:'empty-selection'});return {enabled:false,tools:[]};}
    if(input.modelBinding&&typeof input.verifyNativeTransportUsage!=='function')throw fail('Native AI requires independent Core transport accounting before paid calls','DSH_NATIVE_MODEL_USAGE_REQUIRED');
    if(!input.taskId||!input.approvedPlanRevision||scopeFields.some(key=>typeof input.scope?.[key]!=='string'||!input.scope[key])||typeof input.workspace?.id!=='string'||!isAbsolute(input.workspace?.path??'')||!Array.isArray(input.records))throw fail('Exact task, member life and private workspace are required','WORK_TOOL_SCOPE_DENIED');
    const tools=clone(input.tools),records=clone(input.records),recordMap=new Map(records.map(record=>[record.packageKey,record]));
    if(recordMap.size!==records.length||new Set(tools.map(tool=>tool.toolId)).size!==tools.length)throw fail('Approved tool identities conflict','WORK_TOOL_IDENTITY_CONFLICT');
    for(const tool of tools){const record=recordMap.get(tool.packageKey);if(!record||record.packageName==='@ai-buddy/work-collaboration'||identityFields.some(key=>tool[key]!==record[key])||typeof tool.nativeName!=='string'||!tool.nativeName||reserved.has(tool.nativeName)||tool.toolId!==dshMcpToolId(record,tool.nativeName)||tool.mcpDescriptor?.name!==tool.toolId||dshMcpSchemaHash(tool.mcpDescriptor)!==tool.schemaHash||!same(tool.inputSchema,tool.mcpDescriptor.inputSchema)||!/^[a-f0-9]{64}$/.test(tool.sourceTrustDigest??'')||!Array.isArray(tool.capabilities))throw fail('The approved full tool snapshot is invalid','WORK_TOOL_SNAPSHOT_CHANGED');}
    if(records.some(record=>!tools.some(tool=>tool.packageKey===record.packageKey)))throw fail('The task profile cannot deploy an unselected package','WORK_TOOL_SNAPSHOT_CHANGED');
    if(input.actualTools&&tools.some(tool=>!input.actualTools.some(actual=>same(actual,tool))))throw fail('The actual host catalog differs from approval','WORK_TOOL_SNAPSHOT_CHANGED');
    const key=input.jobId+'\0'+input.runId,old=byRun.get(key),fingerprint=canonical({tools,scope:input.scope,workspace:input.workspace,approvedPlanRevision:input.approvedPlanRevision,taskId:input.taskId,memberId:input.memberId??null,modelBinding:input.modelBinding??null});
    if(old){if(old.fingerprint!==fingerprint||old.revoked)throw fail('This run already owns a different or revoked tool lease','WORK_TOOL_LEASE_CHANGED');await authority(old,'reuse');return clone(await old.prepared);}
    const sourcePins=new Map();
    const row={leaseId:randomUUID(),sessionId:randomUUID(),jobId:input.jobId,runId:input.runId,taskId:input.taskId,memberId:input.memberId??null,tools,records,scope:clone(input.scope),workspace:clone(input.workspace),approvedPlanRevision:input.approvedPlanRevision,assertCurrent:input.assertCurrent,modelBinding:input.modelBinding?clone(input.modelBinding):null,key,fingerprint,sourcePins,runtimeIds:new Set(),tokens:new Set(),tokenContexts:new Map(),modelAdmissions:new Map(),transportAdmissions:new Map(),modelUsage:new Map(),usagePending:new Set(),controller:new AbortController(),state:'preparing',revoked:false};
    rows.set(row.leaseId,row);byRun.set(key,row);row.prepared=prepare(row,input);
    try{return await row.prepared;}catch(error){row.revoked=true;try{await closeRow(row);}catch(stopError){throw Object.assign(stopError,{cause:error});}throw error;}
  }
  async function release(input={}){const old=released.get(input.leaseId);if(old){assertOwner(old,input);return clone(old);}const row=rows.get(input.leaseId);if(!row)throw fail('Tool lease is unknown','WORK_TOOL_LEASE_UNKNOWN');assertOwner(row,input);return closeRow(row);}
  async function assertActive(input={}){const row=rows.get(input.leaseId);if(!row||row.state!=='active'||row.revoked)throw fail('Tool lease is no longer active','WORK_TOOL_LEASE_CLOSED');assertOwner(row,input);if(input.pluginId&&!row.records.some(record=>record.pluginId===input.pluginId)||input.contextToken&&!row.tokens.has(input.contextToken))throw fail('Native model call is outside its exact tool lease','WORK_TOOL_SCOPE_DENIED');await authority(row,'active-call',input.signal);return {active:true,leaseId:row.leaseId,jobId:row.jobId,runId:row.runId,scope:clone(row.scope),workspace:clone(row.workspace),approvedPlanRevision:row.approvedPlanRevision,modelBinding:clone(row.modelBinding)};}
  async function revoke(predicate=()=>true){const selected=[...rows.values()].filter(row=>predicate({...meta(row),scope:clone(row.scope),tools:clone(row.tools)}));const results=await Promise.allSettled(selected.map(closeRow));const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;return {revoked:selected.length,drained:true,stopped:true,osActiveProcesses:0};}
  return {acquire,release,revoke,assertActive,assertNativeTransport,snapshot:()=>({closed,leases:[...rows.values()].map(meta),released:released.size}),async close(){closed=true;return revoke();}};
}
