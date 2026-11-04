import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const name = 'ai-buddy-dsh-platform-bridge';
export const inject = ['tools', 'pluginManager', 'agents', 'llm'];
const CHANNEL = 'ai-buddy-dsh-platform-v1';
const MODEL_CAPACITY_CAUSES=new Set(['MEMORY_CONTEXT_CAPACITY','MODEL_CONTEXT_CAPACITY','BILI_FULL_MODEL_CAPACITY','MODEL_IMAGE_TOO_LARGE']);
// The main host supplies a branded cause for the first IPC boundary. Later
// protected RPC hops carry only this diagnostic whitelist, never release proof.
export function dshModelError(error,{causeCode=error?.causeCode,stack=false}={}){
  const code=typeof error?.code==='string'?error.code:'DSH_BRIDGE_FAILED',value={code,message:code==='SOCIAL_MODEL_NOT_SUBMITTED'?code:typeof error?.message==='string'?error.message:'Native bridge request failed'};
  if(code==='SOCIAL_MODEL_NOT_SUBMITTED'&&MODEL_CAPACITY_CAUSES.has(causeCode))value.causeCode=causeCode;
  if(stack&&code!=='SOCIAL_MODEL_NOT_SUBMITTED'&&typeof error?.stack==='string')value.stack=error.stack;
  return value;
}

const STAGE_METHODS=new Set('tools.list tools.call tools.cancel management.snapshot management.inspect management.install management.enable management.disable management.uninstall management.cancelInstall bridge.schemaSnapshot runtime.identity runtime.shutdown buddy.invoke'.split(' '));
const STAGE_PHASES=new Set('rpc.sent rpc.received rpc.reply rpc.error buddy.sent buddy.reply buddy.error buddy-main.begin buddy-main.end buddy-main.error native-scope.begin native-scope.end tools-resolve.begin tools-resolve.end tools-execute.begin tools-execute.end tool-guard.begin tool-guard.end tool-body.begin tool-body.end pm-list-bundles.begin pm-list-bundles.end pm-list-plugins.begin pm-list-plugins.end'.split(' '));
const stageRequestId=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
/** Diagnostic metadata only. Never serializes caller payloads or error text. */
export function createDshStageDiagnostics({enabled=false,emit=()=>{}}={}){
  return Object.freeze({record(method,requestId,phase,details={}){
    if(enabled!==true||!STAGE_METHODS.has(method)||!stageRequestId(requestId)||!STAGE_PHASES.has(phase))return false;
    const row={kind:'rpc-stage',method,requestId,phase};
    if(Number.isFinite(details.elapsedMs)&&details.elapsedMs>=0)row.elapsedMs=details.elapsedMs;
    if(stageRequestId(details.parentRequestId))row.parentRequestId=details.parentRequestId;
    try{emit(row);}catch{}
    return true;
  }});
}

// Pinned upstream Remote namespaces. A native plugin's own Remote namespace is
// still served unchanged; native Node packages are trusted installed code, not
// a JavaScript sandbox. These rules close the upstream owner's executable UI
// paths, including PTY and dynamic Cordis paths that bypass tools entirely.
const HOST_NAMESPACES = new Set('account actionCards agentPresets commands cotTranslation credentials cuaAccess directoryPicker dynamicCordisRunner fileReferences fileUploads goals job llm messageFeedback officeToPdf permissionPresets pluginInventory pluginManager pluginMarket pluginRecommendations pluginRegistryProbe productAnalytics remoteAccess schedule session sessionFeedback sessionReferenceResolver settings skills speech subagents terminal userQuestions workspace workspaceFiles'.split(' '));
const READ_REMOTE_ACTIONS = new Set([
  'account/getState','account/hasRunningAccountTasks','account/watch','account/watchExpiry',
  'agentPresets/list','agentPresets/read','cotTranslation/limits','credentials/describe',
  'job/list','job/follow','llm/listProviders','llm/listConfigurableProviders',
  'permissionPresets/catalog','pluginInventory/list','pluginManager/listBundles',
  'pluginManager/listPlugins','pluginManager/listVersionExemptions','pluginManager/registries',
  'pluginManager/readBundleDetail','pluginManager/listVersions','pluginMarket/listIndexes',
  'pluginMarket/readEntryDetail','pluginMarket/search','pluginRecommendations/describe',
  'productAnalytics/enabled','productAnalytics/watchPolicy','remoteAccess/follow',
  'schedule/catalog','schedule/list','schedule/history','session/list','session/search',
  'session/page','session/follow','session/control','session/projections','session/modelCatalog',
  'session/canOpenWorkspacePath','session/cancel','settings/describe','terminal/list',
  'terminal/retain','terminal/close','workspace/follow',
  'skills/list','sessionReferenceResolver/candidates','messageFeedback/list',
  'cuaAccess/systemStatus','cuaAccess/ptcConfiguration','speech/catalog','speech/follow',
  'job/kill','subagents/interruptByParent',
]);
export function normalizeDshUiPolicy(value = {}) {
  if (value.mode !== undefined && value.mode !== 'host-mediated') throw new Error('DSH_UI_POLICY_REQUIRED');
  return Object.freeze({mode:'host-mediated',version:1});
}
export function dshRemoteActionDecision(namespace, method, args = {}) {
  if (!/^[A-Za-z][\w.-]*$/.test(namespace ?? '') || !/^[A-Za-z][\w.-]*$/.test(method ?? '')) return 'DSH_HOST_REMOTE_DENIED';
  // Public welcome-notice acknowledgment is a pure UI fact. Do not open the
  // surrounding settings API or permit a batched model/credential mutation.
  const op=args?.ops?.[0];
  if (namespace==='settings' && method==='mutate' && args.ns==='ui-settings-general' && Array.isArray(args.ops) && args.ops.length===1 && op && Object.keys(op).sort().join(',')==='op,path,value' && op.op==='set' && Array.isArray(op.path) && op.path.length===1 && op.path[0]==='welcomeNoticeVersion' && op.value==='2026-09-28.1' && Object.keys(args).every(key=>['ns','ops','expectedRevision'].includes(key))) return undefined;
  if (HOST_NAMESPACES.has(namespace) && !READ_REMOTE_ACTIONS.has(`${namespace}/${method}`)) return 'DSH_HOST_REMOTE_ADMISSION_REQUIRED';
  return undefined;
}
export function installDshHostUiPolicy(ctx, { pendingAgentIds, onDenied = () => {} }) {
  const gateway = ctx.typertGateway[Symbol.for('cordis.original')] ?? ctx.typertGateway;
  const original = gateway.prepareInvocation;
  if (typeof original !== 'function') throw new Error('DSH_HOST_GATEWAY_SEAM_UNAVAILABLE');
  const own = Object.getOwnPropertyDescriptor(gateway, 'prepareInvocation');
  const guarded = async function(request, ...args) {
    const reason = dshRemoteActionDecision(request?.namespace, request?.method, request?.args);
    if (reason) {
      onDenied({surface:'remote',namespace:request?.namespace,method:request?.method,code:reason});
      throw Object.assign(new Error(reason), {code:reason});
    }
    return Reflect.apply(original, this, [request, ...args]);
  };
  Object.defineProperty(gateway, 'prepareInvocation', {configurable:true,writable:true,value:guarded});
  ctx.effect(() => () => {
    if (gateway.prepareInvocation !== guarded) return;
    if (own) Object.defineProperty(gateway, 'prepareInvocation', own);
    else delete gateway.prepareInvocation;
  });
  ctx.on('agent/created', ({agent}) => {
    // Only the private IPC scope builder can admit a discovery-only Agent.
    // A name prefix or an existing session discovered from the Web is no proof.
    if (!pendingAgentIds.delete(String(agent.id))) {
      onDenied({surface:'agent',code:'DSH_HOST_AGENT_ADMISSION_REQUIRED'});
      throw new Error('DSH_HOST_AGENT_ADMISSION_REQUIRED');
    }
  }, {prepend:true});
  ctx.on('llm/stream', async function* () {
    onDenied({surface:'llm',code:'DSH_HOST_MODEL_ADMISSION_REQUIRED'});
    throw new Error('DSH_HOST_MODEL_ADMISSION_REQUIRED');
  }, {prepend:true});
  return {mode:'host-mediated',version:1,gatewaySeam:'prepareInvocation',nativeInference:false};
}
/** Observe metadata only; forwarded response bytes and backpressure stay native. */
export function observeDshMessagesUsage(response, record) {
  record.providerRequestId=['request-id','x-request-id','x-deepseek-request-id'].map(key=>response.headers.get(key)).find(Boolean)??null;
  record.httpStatus=response.status;
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))return response;
  const decoder=new TextDecoder();let buffer='',discard=false;
  const accept=block=>{if(discard){discard=false;return;}const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return;let event;try{event=JSON.parse(data);}catch{return;}
    const take=usage=>{if(!usage||typeof usage!=='object')return;for(const [wire,key]of Object.entries({input_tokens:'inputTokens',output_tokens:'outputTokens',cache_read_input_tokens:'cacheReadTokens',cache_creation_input_tokens:'cacheWriteTokens'})){if(usage[wire]===undefined)continue;if(Number.isSafeInteger(usage[wire])&&usage[wire]>=0)record[key]=usage[wire];else record.metadataInvalid=true;}};
    if(event.type==='message_start'){const message=event.message??{};if(typeof message.id==='string'&&message.id.length<=512)record.providerMessageId=message.id;if(typeof message.model==='string'&&message.model.length<=512)record.actualModel=message.model;take(message.usage);}
    else if(event.type==='message_delta')take(event.usage);
    else if(event.type==='message_stop')record.messageStopped=true;
  };
  const consume=text=>{buffer+=text;let match;while((match=/\r?\n\r?\n/.exec(buffer))){const block=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);accept(block);}if(buffer.length>1024*1024){buffer='';discard=true;record.metadataOverflow=true;}};
  const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller){consume(decoder.decode(chunk,{stream:true}));controller.enqueue(chunk);},flush(){consume(decoder.decode());if(buffer)accept(buffer);}}));
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
export function installDshJobToolPolicy(ctx,{pendingAgentIds,trusted,executionScope,task,authorize,recordUsage=async()=>{},onDenied=()=>{}}){
  function active(){const row=executionScope.getStore();if(!row?.execution||trusted.get(row.execution.callId)!==row||!row.execution.token||row.execution.signal.aborted)throw new Error('DSH_NATIVE_MODEL_ADMISSION_DENIED');if(!task?.modelSelection)throw new Error('DSH_NATIVE_MODEL_CONFIGURATION_REQUIRED');return row;}
  // Rebind cancellation at the pinned dispatcher seam while preserving the
  // upstream prepared adapter generation. This also covers native AI plugins
  // whose original stream() call omitted a signal; their source stays native.
  const llm=ctx.llm[Symbol.for('cordis.original')]??ctx.llm,original=llm.streamWithRegistration;
  if(typeof original!=='function')throw new Error('DSH_NATIVE_LLM_SEAM_UNAVAILABLE');
  const own=Object.getOwnPropertyDescriptor(llm,'streamWithRegistration');
  const guarded=function(options,...args){const row=active(),signal=options.signal?AbortSignal.any([row.execution.signal,options.signal]):row.execution.signal;return Reflect.apply(original,this,[{...options,signal},...args]);};
  Object.defineProperty(llm,'streamWithRegistration',{configurable:true,writable:true,value:guarded});
  ctx.effect(()=>()=>{if(llm.streamWithRegistration!==guarded)return;if(own)Object.defineProperty(llm,'streamWithRegistration',own);else delete llm.streamWithRegistration;});
  ctx.on('agent/created',({agent})=>{if(!pendingAgentIds.delete(String(agent.id)))throw new Error('DSH_HOST_AGENT_ADMISSION_REQUIRED');},{prepend:true});
  const modelScope=new AsyncLocalStorage(),fetchOriginal=globalThis.fetch;
  const fetchGuarded=async function(input,init){const stream=modelScope.getStore();if(!stream)return Reflect.apply(fetchOriginal,this,[input,init]);const target=new URL(typeof input==='string'||input instanceof URL?input:input.url),base=new URL(task.modelEndpoint);if(target.origin!==base.origin||target.pathname.replace(/\/$/,'')!==base.pathname.replace(/\/$/,'')+'/v1/messages'&&target.pathname.replace(/\/$/,'')!==base.pathname.replace(/\/$/,'')+'/messages')throw new Error('DSH_NATIVE_MODEL_TRANSPORT_CHANGED');
    const row={transportRequestId:stream.requests.length?randomUUID():stream.firstRequestId,startedAt:new Date().toISOString(),providerRequestId:null,providerMessageId:null,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null};
    if(stream.requests.length)await authorize(stream.row,task.modelSelection,stream.signal,{nativeStreamId:stream.id,nativeRequestId:row.transportRequestId});
    stream.requests.push(row);const headers=new Headers(typeof input==='object'&&input?.headers?input.headers:undefined);for(const [key,value]of new Headers(init?.headers))headers.set(key,value);headers.set('x-ai-buddy-native-stream-id',stream.id);headers.set('x-ai-buddy-native-request-id',row.transportRequestId);
    try{return observeDshMessagesUsage(await Reflect.apply(fetchOriginal,this,[input,{...init,headers}]),row);}catch(error){row.transportFailed=true;throw error;}};
  globalThis.fetch=fetchGuarded;ctx.effect(()=>()=>{if(globalThis.fetch===fetchGuarded)globalThis.fetch=fetchOriginal;});
  ctx.on('llm/stream',async function*(options,next){const row=active(),selection=task.modelSelection;if(options.provider!==selection.provider||options.model!==selection.model||selection.reasoningEffort!=null&&options.reasoningEffort!==selection.reasoningEffort)throw new Error('DSH_NATIVE_MODEL_BINDING_CHANGED');const stream={id:randomUUID(),firstRequestId:randomUUID(),requests:[],row,signal:options.signal};await authorize(row,selection,options.signal,{nativeStreamId:stream.id,nativeRequestId:stream.firstRequestId});active();let nativeUsage,finish,error;
    let iterator,completed=false;try{iterator=modelScope.run(stream,()=>next()[Symbol.asyncIterator]());for(;;){const item=await modelScope.run(stream,()=>iterator.next());if(item.done){completed=true;break;}const chunk=item.value;if(chunk.type==='usage')nativeUsage=Object.fromEntries(['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'].filter(key=>Number.isSafeInteger(chunk.usage?.[key])&&chunk.usage[key]>=0).map(key=>[key,chunk.usage[key]]));if(chunk.type==='finish')finish=chunk.reason;yield chunk;}}
    catch(cause){error=cause;throw cause;}
    finally{let cleanupError;if(!completed&&iterator?.return)try{await modelScope.run(stream,()=>iterator.return());}catch(cause){cleanupError=cause;}for(const request of stream.requests){const usageKnown=request.messageStopped===true&&!request.metadataInvalid&&!request.metadataOverflow&&request.inputTokens!==null&&request.outputTokens!==null,actualModel=request.actualModel??selection.model;await recordUsage(row,{schemaVersion:1,origin:'managed-receipt',purpose:'native-community-tool',accounting:'independent',usageMode:'request',provider:selection.provider,model:actualModel,modelEvidence:request.actualModel?'provider-message-start':'captured-binding-unreported',capturedModel:selection.model,bindingMatched:actualModel===selection.model,providerRequestId:request.providerRequestId,providerMessageId:request.providerMessageId,transportRequestId:request.transportRequestId,requestId:request.providerMessageId??request.providerRequestId??request.transportRequestId,requestIdEvidence:request.providerMessageId?'provider-message-id':request.providerRequestId?'provider-header':'host-observed-http-dispatch',nativeStreamId:stream.id,nativeSessionId:options.sessionId==null?null:String(options.sessionId),inputTokens:request.inputTokens,outputTokens:request.outputTokens,cacheReadTokens:request.cacheReadTokens,cacheWriteTokens:request.cacheWriteTokens,totalTokens:usageKnown?request.inputTokens+request.outputTokens+(request.cacheReadTokens??0)+(request.cacheWriteTokens??0):null,usageKnown,completion:request.messageStopped?'completed':options.signal?.aborted?'aborted':error||finish?.kind==='error'?'failed':'incomplete',...(stream.requests.length===1&&nativeUsage?{nativeUsage}:{}),startedAt:request.startedAt,finishedAt:new Date().toISOString()});}if(cleanupError&&!error)throw cleanupError;if(!options.signal?.aborted)await authorize(row,selection,options.signal,{nativeStreamId:stream.id,nativeRequestId:stream.firstRequestId});}
  }, {prepend:true});
  return {mode:'job-tools',version:1,nativeInference:'host-admitted-active-call-only'};
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
}

/** The client never creates an APP principal or substitutes its own package
 * identity. Authentication and capability grants stay in the parent process. */
export async function openNativeSocialClient({pluginId,contractHash},invoke){
  const opened=await invoke({pluginId,contextToken:contractHash,method:'open',payload:{contractHash}},{},'social-request');
  if(!opened?.sessionToken||!opened.dataDirectory||!opened.description)throw new Error('SOCIAL_HOST_OPEN_INVALID');
  let closed=false,closing,subscription;
  const call=(method,payload={},options={})=>{
    if(closed&&method!=='close')throw Object.assign(Error('Social client closed'),{code:'SOCIAL_HOST_CLOSED'});
    return invoke({pluginId,contextToken:opened.sessionToken,method,payload},options,'social-request');
  };
  return Object.freeze({
    dataDirectory:opened.dataDirectory,
    describe:async()=>structuredClone(opened.description),
    invoke:call,
    authorizeRequest(request,{pluginId:claimed,action}){
      if(claimed!==pluginId||request.method!=='POST')throw new Error('SOCIAL_UI_REQUEST_INVALID');
      return call('authorize',{action,request:{url:request.url,method:request.method,headers:Object.fromEntries(['cookie','host','origin','sec-fetch-site','content-type'].map(name=>[name,request.headers.get(name)]).filter(([,v])=>v!=null))}});
    },
    async subscribeEvents({pluginId:claimed,contractHash:hash},listener){
      if(claimed!==pluginId||hash!==contractHash||typeof listener!=='function'||subscription)throw new Error('SOCIAL_SUBSCRIPTION_INVALID');
      const controller=new AbortController(),row={controller};subscription=row;
      row.task=(async()=>{const admissionDeadline=Date.now()+120000;while(!controller.signal.aborted&&!closed){
        let result;try{result=await call('events',{waitMs:20000},{signal:controller.signal});}
        catch(error){if(!['BUDDY_CAPABILITY_DENIED','BUDDY_PLUGIN_DISABLED'].includes(error.code)||Date.now()>=admissionDeadline||controller.signal.aborted)throw error;
          await new Promise(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,250);controller.signal.addEventListener('abort',done,{once:true});if(controller.signal.aborted)done();});continue;}
        for(const event of result.events??[]){if(controller.signal.aborted||closed)break;await listener(event);}
      }})();
      // Keep the rejection observed until the owning plugin awaits its drain.
      row.task.catch(()=>{});
      return async()=>{controller.abort();try{await row.task;}catch(error){if(!controller.signal.aborted)throw error;}if(subscription===row)subscription=null;};
    },
    close(){if(closing)return closing;closed=true;subscription?.controller.abort();closing=(async()=>{await subscription?.task.catch(()=>{});return call('close');})();return closing;},
  });
}

export async function openNativeVoiceGamesClient({pluginId,contractHash,contractVersion},invoke){
 const opened=await invoke({pluginId,contextToken:contractHash,method:'open',payload:{contractHash,contractVersion}},{},'voice-games-request');
 if(!opened?.sessionToken||!opened.dataDirectory)throw new Error('VOICE_GAMES_OPEN_INVALID');let closed=false,closing;
 const call=(method,payload={},options={})=>{if(closed&&method!=='close')throw Object.assign(Error('Voice/games closed'),{code:'VOICE_GAMES_CLOSED'});return invoke({pluginId,contextToken:opened.sessionToken,method,payload},options,'voice-games-request');};
 return Object.freeze({dataDirectory:opened.dataDirectory,describe:()=>call('describe'),invoke:call,
  authorizeRequest(request,{pluginId:claimed,action}){if(claimed!==pluginId||request.method!=='POST')throw new Error('VOICE_GAMES_UI_INVALID');return call('ui.authorize',{action,request:{url:request.url,method:request.method,headers:Object.fromEntries(['cookie','host','origin','sec-fetch-site','content-type'].map(name=>[name,request.headers.get(name)]).filter(([,v])=>v!=null))}});},
  registerTranscriber(){throw Object.assign(Error('Voice development paused by user'),{code:'VOICE_DEFERRED'});},
  close(){if(closing)return closing;closed=true;closing=call('close');return closing;}
 });
}

/** Ordinary DSH Host plugin; the CLI and Cordis Loader remain upstream. */
export function apply(ctx, config = {}) {
  if (typeof process.send !== 'function') throw new Error('BUDDY_PLATFORM_IPC_REQUIRED');
  const active = new Map();
  const operations = new Set();
  const installations = new Set();
  let closing = false;
  const trusted = new Map();
  const buddyRequests = new Map();
  const nativeScopes = new Map();
  const pendingAgentIds = new Set();
  const executionScope=new AsyncLocalStorage();
  const send = message => process.connected && process.send({ channel: CHANNEL, ...jsonSafe(message) });
  const stage=createDshStageDiagnostics({enabled:config.stageDiagnostics===true,emit:send});
  normalizeDshUiPolicy(config.uiPolicy);
  const purpose=config.purpose??'ui';if(!['ui','job-tools'].includes(purpose))throw new Error('DSH_PURPOSE_INVALID');
  const uiPolicy = purpose==='ui'?installDshHostUiPolicy(ctx, {pendingAgentIds,onDenied:value=>send({kind:'host-policy-denied',...value})}):installDshJobToolPolicy(ctx,{pendingAgentIds,trusted,executionScope,task:config.task,authorize:(row,modelSelection,signal,transport)=>invokeBuddy({pluginId:row.pluginId,contextToken:row.contextToken,method:'models.nativeAuthorize',payload:{callId:row.execution.callId,modelSelection,...transport}},{signal},'native-model-request'),recordUsage:(row,receipt)=>invokeBuddy({pluginId:row.pluginId,contextToken:row.contextToken,method:'models.nativeUsage',payload:{callId:row.execution.callId,toolName:row.execution.name,nativeStreamId:receipt.nativeStreamId,receipt}},{},'native-model-usage')});
  async function invokeBuddy({ pluginId, contextToken, method, payload = {} }, { signal } = {}, kind = 'buddy-request') {
      if (!pluginId || !contextToken) throw new Error('BUDDY_TRUSTED_CONTEXT_REQUIRED');
      if (typeof method !== 'string') throw new Error('BUDDY_METHOD_REQUIRED');
      if (signal?.aborted) throw signal.reason ?? new Error('ABORTED');
      const id = randomUUID();
      const diagnosticStart=performance.now(),parentRequestId=executionScope.getStore()?.execution?.callId?.replace(/^buddy-external:/,'');
      return new Promise((resolve, reject) => {
        // Completion waits for the host's actual broker/provider drain. An
        // abort sends cancellation but never releases the native tool early.
        const abort = () => send({ kind: 'buddy-cancel', id });
        buddyRequests.set(id, { resolve, reject, diagnosticStart,parentRequestId,cleanup: () => signal?.removeEventListener('abort', abort) });
        signal?.addEventListener('abort', abort, { once: true });
        stage.record('buddy.invoke',id,'buddy.sent',{parentRequestId});
        send({ kind, id, params: { pluginId, contextToken, method, payload } });
      });
  }
  const bridge = Object.freeze({
    forCall(exec) {
      const admission = trusted.get(String(exec?.callId));
      function assertCall() {
        if (!admission || trusted.get(String(exec?.callId)) !== admission || !admission.execution || exec.token !== admission.execution.token || exec.name !== admission.execution.name || exec.agent !== admission.execution.agent || exec.callId !== admission.execution.callId || !admission.contextToken || !admission.pluginId) throw new Error('BUDDY_CALL_SCOPE_DENIED');
      }
      assertCall();
      return Object.freeze({invoke(method,payload={},options={}){assertCall();const signal=options.signal?AbortSignal.any([exec.signal,options.signal]):exec.signal;return invokeBuddy({pluginId:admission.pluginId,contextToken:admission.contextToken,method,payload},{signal});}});
    },
  });
  ctx.provide('buddyPluginServices', bridge);
  if(purpose==='ui'){ctx.provide('buddySocialServices',Object.freeze({openPlugin:spec=>openNativeSocialClient(spec,invokeBuddy)}));ctx.provide('buddyVoiceGamesServices',Object.freeze({openPlugin:spec=>openNativeVoiceGamesClient(spec,invokeBuddy)}));}
  // All Web profile execution must enter through the host's private IPC map.
  // Approved work roots run in their independently guarded SDK profiles.
  ctx.tools.guard(exec => {
    const requestId=String(exec.callId).replace(/^buddy-external:/,''),started=performance.now();stage.record('tools.call',requestId,'tool-guard.begin');
    try{
    if (!String(exec.callId).startsWith('buddy-external:')) return 'DSH_HOST_TOOL_ADMISSION_REQUIRED';
    const admission = trusted.get(String(exec.callId));
    if (!admission || !admission.allowedNames.includes(exec.name)) return 'BUDDY_TOOL_SCOPE_DENIED';
    if (admission.requestedName !== exec.name) return 'BUDDY_TOOL_SCOPE_DENIED';
    if (admission.contextKind !== 'social' && admission.planState === 'planning' && !admission.readOnlyToolNames.includes(exec.name)) return 'BUDDY_PLAN_READ_ONLY';
    admission.execution = {token:exec.token,name:exec.name,agent:exec.agent,callId:exec.callId,signal:exec.signal};
    return undefined;
    }finally{stage.record('tools.call',requestId,'tool-guard.end',{elapsedMs:performance.now()-started});}
  });
  ctx.on('tools/execute',(exec,next)=>{const row=trusted.get(String(exec.callId));if(!row?.execution||row.execution.token!==exec.token||row.execution.agent!==exec.agent||row.execution.name!==exec.name)return next();if(config.stageDiagnostics!==true)return executionScope.run(row,()=>next());const requestId=String(exec.callId).replace(/^buddy-external:/,''),started=performance.now();stage.record('tools.call',requestId,'tool-body.begin');return executionScope.run(row,async()=>{try{return await next();}finally{stage.record('tools.call',requestId,'tool-body.end',{elapsedMs:performance.now()-started});}});},{prepend:true});
  ctx.on('tools/change', () => send({ kind: 'tools-changed' }));
  ctx.on('plugin-manager/install-log', row => send({ kind: 'install-log', ...row }));
  ctx.on('plugin-manager/install-state', row => send({ kind: 'install-state', ...row }));

  async function acquireNativeScope(spec) {
    if (!spec) return undefined;
    if (!/^[a-f0-9]{64}$/.test(spec.key ?? '') || typeof spec.cwd !== 'string' || !spec.identity?.pluginId || !spec.modelSelection?.provider || !spec.modelSelection?.model) throw new Error('DSH_INVALID_HOST_TOOL_SCOPE');
    let row = nativeScopes.get(spec.key);
    const fingerprint = JSON.stringify(spec);
    if (row && row.fingerprint !== fingerprint) throw new Error('DSH_HOST_TOOL_SCOPE_CHANGED');
    if (!row) {
      if (nativeScopes.size >= 64) {
        const available = [...nativeScopes].filter(([, value]) => value.references === 0).sort((a,b) => a[1].lastUsed-b[1].lastUsed)[0];
        if (!available) throw new Error('DSH_NATIVE_TOOL_SCOPE_LIMIT');
        nativeScopes.delete(available[0]); await (await available[1].handle).dispose();
      }
      const sessionId = `buddy-tools-${randomUUID()}`;
      pendingAgentIds.add(sessionId);
      row = {fingerprint, references:0, lastUsed:Date.now(), handle:ctx.agents.create({sessionId,meta:{cwd:spec.cwd},agentOptions:spec.modelSelection}).finally(()=>pendingAgentIds.delete(sessionId))};
      nativeScopes.set(spec.key,row);
      row.handle.catch(() => {if(nativeScopes.get(spec.key)===row)nativeScopes.delete(spec.key);});
    }
    row.references++; row.lastUsed=Date.now();
    try { const handle = await row.handle; const selected=handle.agent.model.current(); if(JSON.stringify(selected)!==JSON.stringify(spec.modelSelection))throw new Error('DSH_NATIVE_MODEL_SELECTION_CHANGED'); return {agent:handle.agent,modelSelection:selected,release(){row.references--;row.lastUsed=Date.now();}}; }
    catch(error){row.references--;throw error;}
  }

  async function dispatch(method, params, requestId) {
    if (closing && !['tools.cancel', 'management.cancelInstall', 'runtime.shutdown'].includes(method)) throw new Error('DSH_BRIDGE_CLOSING');
    switch (method) {
      case 'runtime.identity': {
        if(!stageRequestId(config.runtimeId)||typeof config.profileId!=='string'||!config.profileId)throw new Error('DSH_RUNTIME_IDENTITY_REQUIRED');
        return {runtimeId:config.runtimeId,profileId:config.profileId,pid:process.pid,purpose,protocolVersion:1};
      }
      case 'management.snapshot': {
        let started=performance.now();stage.record(method,requestId,'pm-list-bundles.begin');const bundles=await ctx.pluginManager.listBundles();stage.record(method,requestId,'pm-list-bundles.end',{elapsedMs:performance.now()-started});
        started=performance.now();stage.record(method,requestId,'pm-list-plugins.begin');const plugins=await ctx.pluginManager.listPlugins();stage.record(method,requestId,'pm-list-plugins.end',{elapsedMs:performance.now()-started});return {bundles,plugins};
      }
      case 'management.inspect': return ctx.pluginManager.inspect(params.spec, params.options);
      case 'management.install': {
        installations.add(requestId);
        const operation = ctx.pluginManager.installBundle(params.spec, { saveExact: true, requestId, ...params.options });
        operations.add(operation);
        try { return await operation; } finally { operations.delete(operation); installations.delete(requestId); }
      }
      case 'management.enable': return ctx.pluginManager.setBundleEnabled(params.packageName, true);
      case 'management.disable': return ctx.pluginManager.setBundleEnabled(params.packageName, false);
      case 'management.uninstall': return ctx.pluginManager.removeBundle(params.packageName);
      case 'management.cancelInstall': return ctx.pluginManager.cancelInstall(params.requestId);
      case 'tools.list': {
        const allowed = new Set(params.admission.allowedNames);
        const controller = new AbortController();active.set(requestId,controller);
        let lease,toolSet;
        try {
          let started=performance.now();stage.record(method,requestId,'native-scope.begin');
          lease=await acquireNativeScope(params.nativeScope);
          stage.record(method,requestId,'native-scope.end',{elapsedMs:performance.now()-started});
          if(lease){started=performance.now();stage.record(method,requestId,'tools-resolve.begin');toolSet=await ctx.tools.resolve({agent:lease.agent,modelSelection:lease.modelSelection,signal:controller.signal});stage.record(method,requestId,'tools-resolve.end',{elapsedMs:performance.now()-started});}
          const schemas=ctx.tools.schemas(lease?.agent,toolSet).filter(tool=>allowed.has(tool.name));
          const tools=lease?schemas:schemas.filter(tool=>ctx.tools.executable(tool.name));
          return {tools,conditionalResolution:lease?'resolved-native-agent-scope':'requires-host-model-selection',...(lease?{nativeScope:{agentId:String(lease.agent.id),modelSelection:lease.modelSelection,inferenceStarted:false}}:{unresolvedTools:schemas.filter(tool=>!ctx.tools.executable(tool.name)).map(tool=>tool.name)})};
        }finally{toolSet?.dispose();lease?.release();active.delete(requestId);}
      }
      case 'tools.call': {
        const callId = `buddy-external:${requestId}`;
        const controller = new AbortController();
        active.set(requestId, controller);
        trusted.set(callId, {...params.admission,requestedName:params.name});
        let operation,lease,toolSet,executeStarted;
        try {
          let started=performance.now();stage.record(method,requestId,'native-scope.begin');
          lease=await acquireNativeScope(params.nativeScope);
          stage.record(method,requestId,'native-scope.end',{elapsedMs:performance.now()-started});
          if(lease){started=performance.now();stage.record(method,requestId,'tools-resolve.begin');toolSet=await ctx.tools.resolve({agent:lease.agent,modelSelection:lease.modelSelection,signal:controller.signal});stage.record(method,requestId,'tools-resolve.end',{elapsedMs:performance.now()-started});}
          executeStarted=performance.now();stage.record(method,requestId,'tools-execute.begin');
          operation = ctx.tools.execute({
            calls: [{ type: 'tool-call', id: callId, name: params.name, arguments: JSON.stringify(params.arguments ?? {}) }],
            signal: controller.signal, maxParallelToolCalls: 1,
            ...(lease?{agent:lease.agent,toolSet}:{}),
          });
          operations.add(operation);
          return await operation;
        } finally {
          if(executeStarted!==undefined)stage.record(method,requestId,'tools-execute.end',{elapsedMs:performance.now()-executeStarted});
          operations.delete(operation);
          toolSet?.dispose();lease?.release();
          trusted.delete(callId);
          active.delete(requestId);
        }
      }
      case 'tools.cancel': {
        const controller = active.get(params.requestId);
        if (controller) controller.abort(new Error('BUDDY_TOOL_CANCELLED'));
        return { status: controller ? 'cancelling' : 'not-running' };
      }
      case 'bridge.schemaSnapshot': return ctx.tools.schemas();
      case 'runtime.shutdown': {
        closing = true;
        for (const controller of active.values()) controller.abort(new Error('DSH_RUNTIME_SHUTDOWN'));
        for (const request of installations) ctx.pluginManager.cancelInstall(request);
        setImmediate(async () => {
          await Promise.allSettled([...operations]);
          await Promise.allSettled([...nativeScopes.values()].map(async row=>(await row.handle).dispose()));nativeScopes.clear();
          await ctx.root.fiber.dispose();
          if (process.connected) process.disconnect();
        });
        return { status: 'draining', activeCalls: active.size };
      }
      default: throw new Error(`BUDDY_UNKNOWN_PLATFORM_METHOD:${method}`);
    }
  }

  const onMessage = message => {
    if (message?.channel !== CHANNEL) return;
    if (message.kind === 'buddy-response') {
      const pending = buddyRequests.get(message.id);
      if (!pending) return;
      buddyRequests.delete(message.id);
      pending.cleanup();
      stage.record('buddy.invoke',message.id,message.error?'buddy.error':'buddy.reply',{parentRequestId:pending.parentRequestId,elapsedMs:performance.now()-pending.diagnosticStart});
      message.error ? pending.reject(Object.assign(new Error(message.error.message), dshModelError(message.error))) : pending.resolve(message.result);
      return;
    }
    if (message.kind !== 'request' || typeof message.id !== 'string' || typeof message.method !== 'string') return;
    const started=performance.now();stage.record(message.method,message.id,'rpc.received');
    const operation = dispatch(message.method, message.params ?? {}, message.id);
    const tracked = ['tools.list','tools.call','management.enable','management.disable','management.uninstall'].includes(message.method);
    if (tracked) operations.add(operation);
    operation.then(
      result => {stage.record(message.method,message.id,'rpc.reply',{elapsedMs:performance.now()-started});return send({ kind: 'response', id: message.id, result });},
      error => {stage.record(message.method,message.id,'rpc.error',{elapsedMs:performance.now()-started});return send({ kind: 'response', id: message.id, error: dshModelError(error,{stack:true}) });},
    ).finally(() => { if(tracked)operations.delete(operation); });
  };
  process.on('message', onMessage);
  ctx.effect(() => () => {
    process.off('message', onMessage);
    for (const controller of active.values()) controller.abort(new Error('DSH_BRIDGE_DISPOSED'));
    for (const pending of buddyRequests.values()) { pending.cleanup(); pending.reject(new Error('DSH_BRIDGE_DISPOSED')); }
    buddyRequests.clear();
  });
  send({ kind: 'bridge-ready', pid: process.pid, node: process.version, protocolVersion: 1, purpose, uiPolicy });
}
