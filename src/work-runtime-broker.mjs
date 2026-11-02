import {join,resolve,dirname,isAbsolute} from 'node:path';
import {readFile,writeFile,mkdir,copyFile,stat,realpath,readdir,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {createNativeCredentialVault,readPrivateCredentialFile,nativeClaudeCredentialMetadata,canonicalPrivateCredentialDirectory} from './native-credential-vault.mjs';
import {createNativeClaudeIdentityReader} from './native-claude-identity.mjs';
import {createMessagesUsageObserver,createNativeTransportReceiptStore,nativeTransportAuthority} from './native-tool-transport-observer.mjs';

const run=promisify(execFile),fail=(message,code='WORK_RUNTIME_UNAVAILABLE')=>Object.assign(Error(message),{code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const baseEnv=()=>Object.fromEntries(['SystemRoot','WINDIR','ComSpec','TEMP','TMP','PATH','PATHEXT','USERPROFILE','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const same=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function digest(path){const value=createHash('sha256');for await(const chunk of createReadStream(path))value.update(chunk);return value.digest('hex');}
function forwardNative(target,{method,headers,body,signal,observer},response){return new Promise((resolve,reject)=>{
  let handshakeTimer;const transport=target.protocol==='https:'?httpsRequest:httpRequest;
  const request=transport(target,{method,headers,signal},incoming=>{
    clearTimeout(handshakeTimer);const outgoing={'content-type':incoming.headers['content-type']??'application/json','cache-control':'no-store'};
    for(const name of ['content-encoding','retry-after','x-request-id','request-id','x-deepseek-request-id'])if(incoming.headers[name])outgoing[name]=incoming.headers[name];
    observer?.headers(incoming.headers,incoming.statusCode??502);if(observer)incoming.on('data',chunk=>observer.chunk(chunk));
    response.writeHead(incoming.statusCode??502,outgoing);incoming.once('error',reject);incoming.once('aborted',()=>reject(fail('Native provider response was interrupted','WORK_PROXY_RESPONSE_ABORTED')));incoming.once('end',()=>{observer?.end();resolve();});incoming.pipe(response);
  });
  // This bounds TCP/TLS establishment only. There is no model-thinking,
  // response-header or body inactivity deadline after the connection is ready.
  request.once('socket',socket=>{if(!socket.connecting)return;handshakeTimer=setTimeout(()=>request.destroy(Object.assign(Error('Model transport connection failed'),{code:'WORK_MODEL_CONNECT_TIMEOUT'})),60000);socket.once(target.protocol==='https:'?'secureConnect':'connect',()=>clearTimeout(handshakeTimer));});
  request.once('error',error=>{clearTimeout(handshakeTimer);reject(error);});response.once('close',()=>{if(!response.writableEnded)request.destroy();resolve();});request.end(body.length?body:undefined);
});}

/** Native executable/authentication references and a one-job credential proxy.
 * No work task, queue, engine SDK or project script is executed here.
 */
export function createWorkRuntimeBroker({dataRoot,getPlatform,getProvider,binaryResolver,nativeBinaryResolver,resolveKimi,validateJob,validateCredentialOperation,resolveNativeHistory,credentialCrypto,nativeIdentityProfileVerifier,nativeIdentityHome,requireNativeCredentialProtocol=false,env=process.env}={}){
  const proxies=new Map(),recordings=new Set(),recordingsById=new Map(),transportWaiters=new Map();let closed=false,vaultPromise,transportStorePromise,closePromise;
  function bindingConnectionIdentity(binding={}){if(binding.engine!=='claude'||binding.accountRef!=='host-env:claude')return null;const key=env.ANTHROPIC_API_KEY??env.ANTHROPIC_AUTH_TOKEN;if(typeof key!=='string'||!key)throw fail('The selected Claude environment account is unavailable','ENGINE_AUTH_PROFILE_REQUIRED');let endpoint;try{endpoint=new URL(env.ANTHROPIC_BASE_URL??'https://api.anthropic.com');}catch{throw fail('The selected Claude environment endpoint is invalid','WORK_CONNECTION_DENIED');}if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))throw fail('The selected Claude environment endpoint is invalid','WORK_CONNECTION_DENIED');return {accountRef:'host-env:claude',provider:'anthropic',baseUrl:endpoint.href,keySha256:hash(key)};}
  const transportStore=()=>transportStorePromise??=(createNativeTransportReceiptStore(join(dataRoot,'work-host','native-tool-transports')));
  async function getNativeTransportReceipt(query,transportRequestId){const value=typeof query==='string'?{leaseId:query,transportRequestId}:query;if(!value?.leaseId||!value?.transportRequestId)return null;return (await transportStore()).get(value);}
  async function waitNativeTransportReceipt(query,{signal}={}){signal?.throwIfAborted();const actual=await getNativeTransportReceipt(query);if(!actual)throw fail('Native transport attempt was not admitted','WORK_NATIVE_TRANSPORT_NOT_FOUND');if(actual.state!=='pending')return actual;return new Promise((resolve,reject)=>{const key=query.transportRequestId,listeners=transportWaiters.get(key)??new Set();let listener;const cleanup=()=>{listeners.delete(listener);if(!listeners.size)transportWaiters.delete(key);signal?.removeEventListener('abort',aborted);},aborted=()=>{cleanup();reject(signal.reason??fail('Native receipt wait was cancelled','ABORT_ERR'));};listener=value=>{if(value.leaseId!==query.leaseId)return;cleanup();resolve(structuredClone(value));};listeners.add(listener);transportWaiters.set(key,listeners);signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)return aborted();void getNativeTransportReceipt(query).then(value=>{if(value&&value.state!=='pending')listener(value);},error=>{cleanup();reject(error);});});}
  function recordTransport(store,value,onReceipt){if(recordingsById.has(value.transportRequestId))return;store.put(value);for(const listener of [...(transportWaiters.get(value.transportRequestId)??[])])listener(value);const recording=Promise.resolve().then(()=>onReceipt(structuredClone(value))).then(()=>{value.recording={state:'done'};store.put(value);},()=>{value.recording={state:'pending',reason:'CORE_USAGE_RECORDING_FAILED'};store.put(value);}).finally(()=>{recordings.delete(recording);recordingsById.delete(value.transportRequestId);});recordings.add(recording);recordingsById.set(value.transportRequestId,recording);}
  async function drainNativeTransportRecordings(){while(recordings.size)await Promise.allSettled([...recordings]);}
  async function replayNativeTransportRecordings(onReceipt){if(typeof onReceipt!=='function')throw fail('Core recording callback is required','WORK_NATIVE_TRANSPORT_CONFIGURATION');const store=await transportStore(),pending=store.pending();for(const receipt of pending)recordTransport(store,receipt,onReceipt);await drainNativeTransportRecordings();return {replayed:pending.length,pending:store.pending().length,modelCalls:0};}
  const credentialOwner=(payload,context)=>{if(payload.engine!=='claude'||payload.binding?.engine!=='claude'||payload.binding?.accountRef!=='native:claude-default'||!payload.runId||!context.pluginId||!(context.jobId??payload.jobId)||context.jobId&&payload.jobId&&context.jobId!==payload.jobId)throw fail('Native credential admission does not match the selected owner','WORK_NATIVE_CREDENTIAL_OWNER');return {pluginId:context.pluginId,jobId:context.jobId??payload.jobId,runId:payload.runId,bindingFingerprint:payload.binding.fingerprint};};
  const nativeIdentity=createNativeClaudeIdentityReader({env,home:nativeIdentityHome??homedir(),profileVerifier:nativeIdentityProfileVerifier,allowLegacyTopLevelOrganization:!requireNativeCredentialProtocol});
  async function nativeClaudeSource(binding,{strict=false}={}){return nativeIdentity.readSource({captured:binding?.hostRuntime?.accountSource??null,strict,trustCapturedProof:strict});}
  async function verifyNativeBindingSource(binding){if(binding?.engine!=='claude'||binding.accountRef!=='native:claude-default')return {verified:true,notNativeClaude:true};return nativeIdentity.verifyCapturedSource(binding.hostRuntime?.accountSource);}
  async function nativeVault(){if(!vaultPromise)vaultPromise=createNativeCredentialVault({directory:join(dataRoot,'work-host','native-credential-vault'),snapshotRoot:join(dataRoot,'work-host','runtime-profiles'),crypto:credentialCrypto??getProvider?.()?.crypto,verifyRefreshedCredential:spec=>nativeIdentity.verifyRefreshedCredential(spec),verifySelectedSource:source=>nativeIdentity.verifyCapturedSource({...source,accountIdentityHash:source.identityHash})}).catch(error=>{vaultPromise=null;throw error;});return vaultPromise;}
  async function credentialAdmission(payload,context,operation,authority){if(closed)throw fail('Native credential custody is closed');if(authority?.allowed!==true)throw fail('Native credential proof must be issued by the host','WORK_NATIVE_CREDENTIAL_PROOF');await (validateCredentialOperation??validateJob)?.(context,payload,operation,authority);if(payload.profileRoot){const requested=await canonicalPrivateCredentialDirectory(payload.profileRoot),expected=await canonicalPrivateCredentialDirectory(authority.profileRoot);if(process.platform==='win32'?requested.toLowerCase()!==expected.toLowerCase():requested!==expected)throw fail('Credential body cannot choose a different native profile','WORK_NATIVE_CREDENTIAL_PROOF');}return {owner:credentialOwner(payload,context),vault:await nativeVault()};}
  async function nativeCredentialBind(payload={},context={},authority={}){const admitted=await credentialAdmission(payload,context,'native.credentials.bind',authority),selected=await nativeClaudeSource(payload.binding,{strict:true});return admitted.vault.bind({leaseId:payload.leaseId,owner:admitted.owner,source:selected.source,authority});}
  async function nativeCredentialUpdate(payload={},context={},authority={}){const admitted=await credentialAdmission(payload,context,'native.credentials.update',authority),selected=await nativeClaudeSource(payload.binding,{strict:true});return admitted.vault.update({leaseId:payload.leaseId,owner:admitted.owner,source:selected.source,authority,checkCurrent:()=>credentialAdmission(payload,context,'native.credentials.update',authority)});}
  async function nativeCredentialLeaseForRun(payload={},context={},authority={}){if(closed||authority.allowed!==true||authority.stage!=='lookup')throw fail('Credential owner lookup requires independent Core authority','WORK_NATIVE_CREDENTIAL_PROOF');await (validateCredentialOperation??validateJob)?.(context,payload,'native.credentials.lookup',authority);const owner=credentialOwner(payload,context),found=(await nativeVault()).findOwnedLease(owner);if(!found)return {credentialLeaseIssued:false,lease:null};return {credentialLeaseIssued:true,lease:Object.fromEntries(['leaseId','sourceKey','generation','mode','status','expiresAt','profileBound'].filter(key=>found[key]!==undefined).map(key=>[key,found[key]]))};}
  async function nativeCredentialRelease(payload={},context={},authority={}){const admitted=await credentialAdmission(payload,context,'native.credentials.release',authority);if(authority.stage!=='closed'||authority.stopped!==true||authority.ownedChildrenStopped!==true||authority.osActiveProcesses!==0||typeof authority.nativeStarted!=='boolean')throw fail('Credential cleanup requires the actual native subtree stop proof','WORK_NATIVE_CREDENTIAL_PROOF');const leaseId=payload.leaseId??admitted.vault.findOwnedLease(admitted.owner)?.leaseId;if(!leaseId)return {released:true,empty:true,credentialLeaseIssued:false};let selected;try{selected=await nativeClaudeSource(payload.binding,{strict:true});}catch(error){return admitted.vault.invalidate({leaseId,owner:admitted.owner,authority});}if(selected.changed)return admitted.vault.invalidate({leaseId,owner:admitted.owner,authority});return admitted.vault.release({leaseId,owner:admitted.owner,source:selected.source,authority,checkCurrent:()=>credentialAdmission(payload,context,'native.credentials.release',authority)});}
  async function findBinary(engine,binding={}){
    if(nativeBinaryResolver){const selected=await nativeBinaryResolver(engine,binding);if(selected)return typeof selected==='string'?selected:selected.path;}
    if(engine==='codex'){
      if(binding.binaryRef==='desktop-core'){
        const root=join(env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'OpenAI','Codex','bin');
        // A captured binding keeps its exact executable. Discovery for a new
        // binding follows the installed desktop tree, never a machine-specific
        // build directory or a silent PATH fallback.
        if(binding.hostRuntime?.binaryPath){const selected=resolve(binding.hostRuntime.binaryPath),parent=dirname(selected);if(dirname(parent)!==resolve(root)||!/^[-A-Za-z0-9_]+$/.test(parent.slice(dirname(parent).length+1))||selected!==join(parent,'codex.exe')||(await lstat(parent)).isSymbolicLink()||(await lstat(selected)).isSymbolicLink())throw fail('The selected desktop Codex core identity is invalid');await stat(selected);return selected;}
        const candidates=[];
        for(const entry of await readdir(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink()||!/^[-A-Za-z0-9_]+$/.test(entry.name))continue;const path=join(root,entry.name,'codex.exe');try{const file=await lstat(path);if(file.isFile()&&!file.isSymbolicLink())candidates.push({path,mtimeMs:file.mtimeMs});}catch(error){if(error.code!=='ENOENT')throw error;}}
        candidates.sort((a,b)=>b.mtimeMs-a.mtimeMs||a.path.localeCompare(b.path));if(!candidates.length)throw fail('The selected desktop Codex core is unavailable');return candidates[0].path;
      }
      const found=await binaryResolver();return typeof found==='string'?found:found?.path??found?.binary;
    }
    if(engine==='claude'){
      const {stdout}=await run(join(env.SystemRoot??'C:\\Windows','System32','where.exe'),['claude'],{encoding:'utf8',windowsHide:true,env:baseEnv(),timeout:10000});
      const native=stdout.split(/\r?\n/).find(x=>x.toLowerCase().endsWith('.exe'));if(!native)throw fail('A native Claude CLI executable was not found');return native;
    }
    if(engine==='kimi'){const value=await resolveKimi();return value.binaryPath;}
    return null;
  }
  async function runtimeResolve(payload={},context={}){
    if(closed)throw fail('Runtime references are closed');const {engine,binding={},prepare=false}=payload;
    if(!['codex','claude','dsh','kimi'].includes(engine))throw fail('Unsupported work engine');
    const component=await getPlatform().runtimeDescriptor();
    let binaryPath=engine==='dsh'?component.nodePath:await findBinary(engine,binding);if(!isAbsolute(binaryPath??''))throw fail('Selected engine executable was not found');binaryPath=await realpath(binaryPath);
    const result={engine,binaryPath,nodePath:component.nodePath,cliEntry:engine==='dsh'?component.cliEntry:null,sdkEntry:engine==='dsh'?component.sdkEntry:null,sourceCommit:engine==='dsh'?component.sourceCommit:null,environment:baseEnv(),installationPerformed:false,prepared:false};
    result.sha256=await digest(binaryPath);
    if(engine!=='dsh'){const version=await run(binaryPath,['--version'],{encoding:'utf8',windowsHide:true,env:baseEnv(),timeout:15000,maxBuffer:65536});result.version=version.stdout.trim().slice(0,500);}else result.version=component.version;
    if(payload.probeAccount&&binding.accountRef==='host-env:claude')result.accountEnvironment=bindingConnectionIdentity(binding);
    if(payload.probeAccount&&(engine==='codex'&&binding.accountRef==='native:codex-default'||engine==='claude'&&binding.accountRef==='native:claude-default')){
      if(engine==='claude')result.accountSource=(await nativeClaudeSource(binding)).accountSource;else{const origin=join(env.CODEX_HOME??join(homedir(),'.codex'),'auth.json');let bytes;try{bytes=await readFile(origin);}catch{throw fail('The selected native account has no readable authentication file','ENGINE_AUTH_PROFILE_REQUIRED');}result.accountSource={path:await realpath(origin),sha256:hash(bytes),bytes:bytes.length};}
    }
    if(!prepare)return result;
    await validateJob?.(context,payload,'runtime.resolve');
    if(engine==='claude'&&binding.accountRef==='native:claude-default'&&payload.nativeCredentialProtocol===1&&(!binding.hostRuntime?.executableSha256||binding.hostRuntime.executableSha256!==result.sha256))throw fail('Native executable changed before credential custody admission','WORK_RUNTIME_CHANGED');
    const nativeHistory=engine==='dsh'?await resolveNativeHistory?.({context,runId:payload.runId}):null;
    const privateName=hash(JSON.stringify([context.pluginId,context.jobId,payload.runId??'runtime',engine])).slice(0,40),runtimeHome=join(dataRoot,'work-host','runtime-profiles',privateName);if(nativeHistory&&resolve(nativeHistory.jobConfigHome)!==resolve(runtimeHome))throw fail('Native history config must use its exact Core job directory','WORK_NATIVE_HISTORY_SCOPE');await mkdir(runtimeHome,{recursive:true});result.runtimeHome=runtimeHome;result.prepared=true;
    if(nativeHistory){const sandboxPolicyEntry=join(dirname(dirname(dirname(component.sdkEntry))),'dsh-sandbox-policy','lib','index.js');const lock=JSON.parse(await readFile(component.lockPath,'utf8')),relativePath=sandboxPolicyEntry.slice(dirname(component.lockPath).length+1).replaceAll('\\','/'),expected=lock.files?.find(f=>f.path===relativePath);if(!expected||(await lstat(sandboxPolicyEntry)).isSymbolicLink()||await digest(sandboxPolicyEntry)!==expected.sha256)throw fail('Native history sandbox policy differs from its verified component','WORK_RUNTIME_CHANGED');result.nativeHistory=structuredClone(nativeHistory);result.sandboxPolicyEntry=await realpath(sandboxPolicyEntry);result.sandboxPolicySha256=expected.sha256;}
    const accountRef=binding.accountRef;
    if(engine==='codex'&&accountRef==='native:codex-default'||engine==='claude'&&accountRef==='native:claude-default'){
      if(engine==='claude'&&payload.nativeCredentialProtocol===1){const selected=await nativeClaudeSource(binding,{strict:true}),owner=credentialOwner(payload,context),custody=await (await nativeVault()).checkout({source:selected.source,credentialBytes:selected.bytes,owner,snapshotDirectory:join(runtimeHome,'selected-account')});result.accountSource=selected.accountSource;result.credentialSnapshotDir=custody.credentialSnapshotDir;const {credentialSnapshotDir,...lease}=custody;result.nativeCredentialLease=lease;result.nativeCredentialProtocol=1;result.authentication='core-native-credential-vault';return result;}
      if(engine==='claude'&&requireNativeCredentialProtocol)throw fail('This native Claude driver must use credential custody protocol 1; data is retained','WORK_NATIVE_CREDENTIAL_PROTOCOL_REQUIRED');
      const filename=engine==='codex'?'auth.json':'.credentials.json',origin=engine==='codex'?join(env.CODEX_HOME??join(homedir(),'.codex'),filename):join(env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),filename);
      let bytes;try{bytes=await readFile(origin);}catch{throw fail('The selected native account has no readable authentication file','ENGINE_AUTH_PROFILE_REQUIRED');}
      if(binding.hostRuntime?.accountSource&&hash(bytes)!==binding.hostRuntime.accountSource.sha256)throw fail('The native authentication source changed after the approved binding was captured','WORK_NATIVE_ACCOUNT_CHANGED');
      const snapshot=join(runtimeHome,'selected-account');await mkdir(snapshot,{recursive:true});const target=join(snapshot,filename);try{await writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
      result.credentialSnapshotDir=snapshot;result.authentication='selected-account-file-snapshot';if(engine==='claude')result.nativeCredentialProtocol=0;
    }else if(accountRef==='host-env:claude'||binding.connectionRef){result.authentication='host-proxy-required';}
    else if(engine!=='kimi'&&engine!=='dsh')throw fail('Choose an explicit native account or connection reference','ENGINE_AUTH_PROFILE_REQUIRED');
    if(engine==='kimi')Object.assign(result,await resolveKimi());
    return result;
  }
  async function connectionLease(payload={},context={},options={}){
    if(closed)throw fail('Connection proxy is closed');await validateJob?.(context,payload,'connection.lease');
    const binding=payload.binding??{},engine=payload.engine??binding.engine;let baseUrl,key,provider=engine,protocol=engine==='claude'?'anthropic':'openai',modelListBase;
    const nativeToolUsage=options.nativeToolUsage;if(nativeToolUsage&&(engine!=='dsh'||typeof nativeToolUsage.authorizeTransport!=='function'||typeof nativeToolUsage.onReceipt!=='function'))throw fail('Native tool transport metering requires Core admission and recording callbacks','WORK_NATIVE_TRANSPORT_CONFIGURATION');
    if(binding.accountRef==='host-env:claude'){
      const selected=bindingConnectionIdentity({...binding,engine});if(binding.hostRuntime?.accountEnvironment&&['accountRef','provider','baseUrl','keySha256'].some(field=>binding.hostRuntime.accountEnvironment[field]!==selected[field]))throw fail('The selected Claude environment account changed after capture','WORK_ACCOUNT_ENVIRONMENT_CHANGED');key=env.ANTHROPIC_API_KEY??env.ANTHROPIC_AUTH_TOKEN;baseUrl=selected.baseUrl;
    }else{
      const id=payload.connectionRef??binding.connectionRef;if(!id||!context.connectionRefs?.includes(id))throw fail('Connection reference is outside this job','WORK_CONNECTION_DENIED');
      const router=getProvider(),captured=router.captureConnection({enabled:true,connectionId:id});if(!captured||captured.id!==id)throw fail('The selected connection no longer exists','WORK_CONNECTION_DENIED');
      const profile=router.materialize(captured);key=profile.key;baseUrl=profile.baseUrl;provider=profile.kind;if(!baseUrl)throw fail('The selected connection does not expose a compatible native endpoint');
      if(engine==='dsh'){
        const original=new URL(baseUrl);modelListBase=original.href;
        if(profile.kind==='deepseek'&&original.origin==='https://api.deepseek.com'){baseUrl=original.origin+'/anthropic';protocol='anthropic';}
        else if(profile.protocol==='anthropic-messages'||profile.protocol==='anthropic'){protocol='anthropic';}
        else throw fail('The chosen DSH connection has no explicitly configured Messages-compatible endpoint','WORK_CONNECTION_PROTOCOL_UNSUPPORTED');
      }
    }
    const upstream=new URL(baseUrl);if(upstream.protocol!=='https:'&&!(upstream.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(upstream.hostname)))throw fail('Unsupported credential endpoint');
    if(upstream.username||upstream.password||upstream.search||upstream.hash)throw fail('Credential endpoint must not contain credentials or query fields');
    const id=randomUUID(),token=randomBytes(32).toString('base64url'),controllers=new Set(),activeRequests=new Set();let origin;
    const server=createServer(async(req,res)=>{
      let finishRequest;const active=new Promise(r=>{finishRequest=r;});activeRequests.add(active);
      const respondError=(status,code)=>{if(!res.destroyed){if(res.headersSent){res.destroy();return;}res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:code,message:code}}));}};
      try{
        if(req.headers.origin||req.headers.host!==new URL(origin).host||!same(req.headers.authorization??req.headers['x-api-key']??'','Bearer '+token)&&!same(req.headers['x-api-key']??'',token))return respondError(403,'WORK_PROXY_DENIED');
        if(!['GET','POST'].includes(req.method)||!/^\/(?:v1\/)?(?:messages(?:\/count_tokens)?|responses(?:\/compact)?|chat\/completions|models)(?:\?.*)?$/.test(req.url??''))return respondError(404,'WORK_PROXY_PATH_DENIED');
        await validateJob?.(context,payload,'connection.request');let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>32*1024*1024)throw fail('Native request is too large');chunks.push(b);}const body=Buffer.concat(chunks);
        let requestedModel=null;if(body.length){const parsed=JSON.parse(body.toString('utf8')),allowed=[binding.model,...(binding.parameters?.allowedModels??[])].filter(Boolean);requestedModel=parsed.model??null;if(parsed.model&&allowed.length&&!allowed.includes(parsed.model))return respondError(403,'WORK_PROXY_MODEL_OUTSIDE_BINDING');}
        const tail=(req.url??'').replace(/^\//,''),isModelList=req.method==='GET'&&/^(?:v1\/)?models(?:\?|$)/.test(tail),route=isModelList&&modelListBase?new URL(modelListBase):upstream,prefix=route.pathname.replace(/\/$/,'');const suffix=prefix.endsWith('/v1')?tail.replace(/^v1\//,''):tail;const target=new URL(route.origin+prefix+'/'+suffix);
        const isInference=req.method==='POST'&&/^(?:v1\/)?messages(?:\?|$)/.test(tail);let receipt,store,observer;
        if(nativeToolUsage&&isInference){const nativeStreamId=req.headers['x-ai-buddy-native-stream-id'],transportRequestId=req.headers['x-ai-buddy-native-request-id'];if(![nativeStreamId,transportRequestId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(v)))return respondError(403,'WORK_NATIVE_TRANSPORT_IDS_REQUIRED');const authority=nativeTransportAuthority(await nativeToolUsage.authorizeTransport({leaseId:id,jobId:context.jobId,runId:payload.runId,nativeStreamId,transportRequestId,method:req.method,pathname:new URL(target).pathname,requestedModel}));store=await transportStore();receipt={version:1,leaseId:id,nativeStreamId,transportRequestId,jobId:context.jobId??null,runId:payload.runId??null,authority,provider,requestedModel,state:'pending',inference:true,origin:'core-native-tool-transport',startedAt:new Date().toISOString(),recording:{state:'pending'}};store.begin(receipt);observer=createMessagesUsageObserver();}
        else if(nativeToolUsage&&!isModelList&&!/^(?:v1\/)?messages\/count_tokens(?:\?|$)/.test(tail))return respondError(403,'WORK_NATIVE_TRANSPORT_PROTOCOL_DENIED');
        const controller=new AbortController();controllers.add(controller);res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        let transportError;
        try{
          const headers={'content-type':req.headers['content-type']??'application/json',...(protocol==='anthropic'&&!isModelList?{'x-api-key':key,'anthropic-version':req.headers['anthropic-version']??'2023-06-01',...(req.headers['anthropic-beta']?{'anthropic-beta':req.headers['anthropic-beta']}:{})}:{authorization:'Bearer '+key})};
          await forwardNative(target,{method:req.method,headers,body,signal:controller.signal,observer},res);
        }catch(error){transportError=error;throw error;}finally{controllers.delete(controller);if(receipt){Object.assign(receipt,observer.finish({aborted:controller.signal.aborted,errorCode:transportError?.code}),{completedAt:new Date().toISOString(),totalTokensDefinition:'input_tokens+output_tokens;cache_tokens_separate'});recordTransport(store,receipt,nativeToolUsage.onReceipt);}}
      }catch(error){respondError(/^WORK_NATIVE_TRANSPORT_/.test(error.code??'')?403:502,/^WORK_NATIVE_TRANSPORT_/.test(error.code??'')?error.code:'WORK_PROXY_UPSTREAM_FAILED');}finally{activeRequests.delete(active);finishRequest();}
    });server.requestTimeout=0;server.headersTimeout=30000;
    await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});origin='http://127.0.0.1:'+server.address().port;proxies.set(id,{server,controllers,context,activeRequests});
    return {leaseId:id,baseUrl:origin,apiKey:token,authentication:'ephemeral-local-proxy',upstreamCredentialsExposed:false,protocol,engine,model:binding.model};
  }
  async function closeProxy(row){for(const c of row.controllers)c.abort();row.server.closeAllConnections?.();await new Promise(r=>row.server.close(r));await Promise.allSettled([...row.activeRequests]);await drainNativeTransportRecordings();}
  async function revokeJob(jobId){for(const[id,row]of proxies)if(row.context.jobId===jobId){await closeProxy(row);proxies.delete(id);}}
  async function close(){return closePromise??=(async()=>{closed=true;for(const row of proxies.values())await closeProxy(row);proxies.clear();await drainNativeTransportRecordings();if(transportStorePromise)(await transportStorePromise).close();if(vaultPromise)(await vaultPromise).close();})();}
  return {runtimeResolve,verifyNativeBindingSource,bindingConnectionIdentity,connectionLease,nativeCredentialBind,nativeCredentialUpdate,nativeCredentialRelease,nativeCredentialLeaseForRun,getNativeTransportReceipt,waitNativeTransportReceipt,drainNativeTransportRecordings,replayNativeTransportRecordings,revokeJob,close};
}
