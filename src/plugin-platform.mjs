import {createNativeSocialFacade} from './buddy-plugin-services/native-social-facade.mjs';
import {createSocialAccounts} from './buddy-plugin-services/social-accounts.mjs';
import {createSocialTransport} from './buddy-plugin-services/social-transport.mjs';
import {createFfmpegComponentManager} from './media-components/ffmpeg-manager.mjs';
import {FFMPEG_COMPONENT_DESCRIPTOR} from './media-components/ffmpeg-descriptor.mjs';
import {createBiliMedia,biliPlayback} from './buddy-plugin-services/bili-media.mjs';
import {createBiliVision} from './buddy-plugin-services/bili-vision.mjs';
import {createSocialPluginBroker} from './buddy-plugin-services/social-plugin-broker.mjs';
import {createSocialLogin,SOCIAL_LOGIN_PLUGINS} from './social-login.mjs';
import {createBilibiliLoginDriver} from './bilibili-login.mjs';
import {createQqLoginRuntime} from './qq-login-runtime.mjs';
import {NATIVE_SOCIAL_CONTRACT,NATIVE_SOCIAL_CONTRACT_HASH} from './buddy-plugin-services/native-social-contract.mjs';
import {join,dirname,resolve} from 'node:path';
import {readFile,appendFile,mkdir,stat,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createDshBackend} from './dsh-platform/backend.mjs';
import {createDshClientHost} from './dsh-platform/client-host.mjs';
import {assertPublicDshComponentDescriptor} from './dsh-platform/component-download.mjs';
import {invalidateDshComponentVerification} from './dsh-platform/component-manager.mjs';
import {createManagedDshComponentManager,planHostDshComponent} from './dsh-platform/component-task-manager.mjs';
import {createDshMcpExport} from './dsh-platform/mcp-export.mjs';
import {createBuddyPluginServices} from './buddy-plugin-services/index.mjs';
import {SOCIAL_METHODS} from './buddy-plugin-services/social-contract.mjs';
import {createModelReferenceBroker} from './buddy-plugin-services/model-broker.mjs';
import {createCommunityService} from './community/service.mjs';
import {checkSocialAccountDraft} from './community/social-draft-check.mjs';
import {createWorkClientHost} from './work-client-host.mjs';
import {PANEL_PLUGIN} from './plugin-embed-targets.mjs';
import {trustedRuntimeDescriptor,prepareIsolatedWorkBackend,retireIsolatedWorkBackend,assertOnlyWorkBundle,nativeModulePolicyFromLock} from './dsh-platform/work-runtime.mjs';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';
import {prepareTaskToolBackend,taskToolModelScope} from './dsh-platform/task-tool-runtime.mjs';

const error=(message,code)=>Object.assign(Error(message),{code});
// Host preparation owns a separate admission lane; it never runs inside a native job.
export function createHostDependencyCoordinator({describe,prepare,busy=()=>false,onUpdate=()=>{}}={}){
 const plans=new Map(),finished=new Map();let active=null,closed=false,current={state:'idle',phase:'idle'};
 const snapshot=()=>structuredClone(current),publish=value=>{current={...current,...value};try{onUpdate(snapshot());}catch{}};
 const abort=()=>error('Host dependency preparation cancelled','ABORT_ERR');
 const check=async op=>{if(op.invalidated)throw op.invalidated;if(closed||op.controller.signal.aborted)throw abort();await op.assertCurrent();if(closed||op.controller.signal.aborted)throw abort();};
 async function plan(intent){if(closed)throw error('Plugin platform is closed','PLUGIN_CLOSED');const value=await describe(intent);if(closed)throw error('Plugin platform is closed','PLUGIN_CLOSED');const token=randomUUID();plans.set(token,structuredClone(value));while(plans.size>64)plans.delete(plans.keys().next().value);return {token,components:structuredClone(value.components)};}
 function run({token,planId,confirmation,assertCurrent,materialize,enqueue,cancelJob}){
  if(closed)return Promise.reject(error('Plugin platform is closed','PLUGIN_CLOSED'));
  const done=finished.get(planId);if(done){if(done.confirmation!==confirmation)return Promise.reject(error('Installation confirmation changed','COMMUNITY_PLAN_CHANGED'));return Promise.resolve(done.result);}
  if(active){if(active.planId===planId&&active.confirmation===confirmation)return active.promise;return Promise.reject(error('Another host dependency operation is running','HOST_DEPENDENCY_BUSY'));}
  const value=plans.get(token);if(!value)return Promise.reject(error('Host dependency plan expired','COMMUNITY_PLAN_NOT_FOUND'));
  const op={id:randomUUID(),planId,confirmation,controller:new AbortController(),assertCurrent,cancelJob,preparing:true,handoff:false,jobId:null,promise:null};active=op;
  let verifying=null;const watch=setInterval(()=>{if(active!==op||!op.preparing||verifying)return;verifying=Promise.resolve().then(()=>op.assertCurrent()).catch(cause=>{if(active===op&&op.preparing){op.invalidated=cause;op.controller.abort(cause);}}).finally(()=>{verifying=null;});},200);
  op.promise=(async()=>{try{
   publish({state:'preparing',phase:'waiting',operationId:op.id,planId,components:value.components,error:null,jobId:null});await check(op);
   while(await busy()){await check(op);await new Promise((yes,no)=>{const stop=()=>{clearTimeout(timer);op.controller.signal.removeEventListener('abort',stop);no(abort());},timer=setTimeout(()=>{op.controller.signal.removeEventListener('abort',stop);yes();},100);op.controller.signal.addEventListener('abort',stop,{once:true});if(op.controller.signal.aborted)stop();});}await check(op);
   await prepare(value,{signal:op.controller.signal,check:()=>check(op),phase:phase=>publish({phase})});await check(op);publish({phase:'checking-plugin'});
   const actual=await materialize({signal:op.controller.signal,check:()=>check(op)});await check(op);
   // The native queue may admit this job only after the preparation lane is released.
   op.preparing=false;op.handoff=true;publish({state:'handing-off',phase:'installing-plugin'});
   let result=await enqueue(actual);op.jobId=result.job?.id??null;
   if(op.controller.signal.aborted&&op.jobId){const cancelled=await cancelJob(op.jobId);result={...result,job:cancelled};}
   publish({state:result.job?.state==='cancelled'?'cancelled':'queued',phase:'installing-plugin',jobId:op.jobId});finished.set(planId,{confirmation,result});while(finished.size>64)finished.delete(finished.keys().next().value);return result;
  }catch(cause){publish({state:op.controller.signal.aborted?'cancelled':'failed',error:{code:cause.code??'HOST_DEPENDENCY_FAILED',message:String(cause.message).slice(0,500)}});throw cause;}finally{clearInterval(watch);if(verifying)await verifying;op.preparing=false;if(active===op)active=null;}})();return op.promise;
 }
 async function cancel({operationId}={}){const op=active;if(!op||operationId&&operationId!==op.id)return {cancelled:false};op.controller.abort(abort());publish({state:'cancelling'});if(op.handoff&&op.jobId){const job=await op.cancelJob(op.jobId);return {cancelled:job.state==='cancelled',job};}return {cancelled:!op.handoff,cancelling:true};}
 async function close(){if(closed)return;closed=true;if(active){active.controller.abort(abort());await Promise.allSettled([active.promise]);}plans.clear();}
 return {plan,run,cancel,close,snapshot,preparing:()=>active?.preparing===true,active:()=>active!==null};
}
/** Application composition only. Work business is supplied by its enabled plugin. */
export async function createPluginPlatform({root,build,dataRoot,legacyManager,getGame,getProvider,getSocialHost=()=>null,crypto,BrowserWindow,session,ipcMain,pluginClientPreloadPath,openExternal,openSocialSetup=()=>{},renderBiliSheet,analyzeBiliFrames,onReadingOpen=async()=>{},chooseComponentArchive,componentWorkerFactory,ffmpegWorkerFactory,ffmpegBundledNotices=join(build,'media-notices','ffmpeg'),ffmpegManagerFactory=createFfmpegComponentManager,qqLoginFactory=createQqLoginRuntime,runtimeLockPath,resolveToolScope,hostServices={},busy=()=>false,onUpdate=()=>{},onUsage=()=>{},onNotification=()=>{},audit=()=>{},pageAppearance=()=>null}){
  const pages=new Map(),lifecycles=new Map(),grantStates=new Map(),exports=new Map(),nativeEvents=new EventEmitter(),workBackends=new Map(),workPreparations=new Map(),workReleases=new Map(),releasedWorkBackends=new WeakMap(),taskToolBackends=new Set(),runtimeDescriptors=new Map();let communityCalls=0,currentBackend=null,currentLock=null,selectedComponentLock=null,componentChecked=false,componentChanging=false,componentGeneration=0,inflight=0,closed=false,platform,workClientHost,workClientOpener;
  let dshComponentState={state:'missing'};
  const componentManager=createManagedDshComponentManager({destinationRoot:join(dataRoot,'plugin-runtimes','dsh-components'),workerPath:join(build,'dsh-component-worker.mjs'),workerFactory:componentWorkerFactory,busy:()=>inflight>0||taskToolBackends.size>0||bridge.busy()||busy(),onUpdate:value=>{dshComponentState=value;onUpdate(platform?.snapshot());}});
  const ffmpegManager=ffmpegManagerFactory({directory:join(dataRoot,'media-components','ffmpeg'),bundledTools:join(build,'bili-media'),bundledNotices:ffmpegBundledNotices,workerPath:join(build,'ffmpeg-component-worker.mjs'),workerFactory:ffmpegWorkerFactory,onUpdate:()=>onUpdate(platform?.snapshot())});
  let dependencyCoordinator;
  // Pages report open/closed/failed; plugin-embed.mjs listens so a closed separate window can come back to the main window.
  const clientEvents=new EventEmitter(),embedScope=new AsyncLocalStorage();
  const clientHost=createDshClientHost({BrowserWindow,session,openExternal,audit,onState:event=>{audit({type:'plugin-client',...event});clientEvents.emit('state',{kind:'community',...event});},appearance:pageAppearance});
  const workModelBroker=createModelReferenceBroker({getProvider});
  const socialServices=Object.fromEntries(SOCIAL_METHODS.map(method=>[method,{capability:method,handler:request=>{if(method==='models.request'&&request.context.contextKind!=='social')return workModelBroker.request(request.context,request.payload,{signal:request.signal,check:request.check});const handler=getSocialHost()?.services?.[method]?.handler;if(!handler)throw error('社交宿主尚未就绪','BUDDY_SERVICE_UNAVAILABLE');return handler(request);}}]));
  const bridge=createBuddyPluginServices({getGame,getProvider,hostServices:{...hostServices,...socialServices},
    resolveContext:async spec=>{if(spec.contextKind==='social'){const host=getSocialHost();if(!host)throw error('社交宿主尚未就绪','BUDDY_SERVICE_UNAVAILABLE');return host.resolveContext(spec);}const game=getGame();if(!game?.pluginScope)throw error('角色服务尚未就绪','BUDDY_SERVICE_UNAVAILABLE');return {...spec,...await game.pluginScope(spec.characterId,spec.personaId),connectionRefs:(spec.connectionRefs??[]).filter(id=>getProvider()?.state?.profiles.some(p=>p.id===id))};},
    onEvidence:async value=>{await mkdir(join(dataRoot,'plugin-evidence'),{recursive:true});await appendFile(join(dataRoot,'plugin-evidence','events.jsonl'),JSON.stringify(value)+'\n');},
    onUsage,onNotification,
    registerPage:async value=>{const {id}=value.descriptor;if(pages.has(id))throw error('页面已经注册','BUDDY_REGISTRATION_DUPLICATE');pages.set(id,value);onUpdate(platform?.snapshot());return()=>{pages.delete(id);onUpdate(platform?.snapshot());};},
    registerLifecycle:async value=>{const {id}=value.descriptor;if(lifecycles.has(id))throw error('生命周期已经注册','BUDDY_REGISTRATION_DUPLICATE');lifecycles.set(id,value);return()=>lifecycles.delete(id);},
  });
  const socialAccounts=createSocialAccounts({dataRoot,crypto}),socialTransport=createSocialTransport({dataRoot,accounts:socialAccounts}),socialRecords=new Map();
  // A scan request from a plugin page waits here until the main window takes it (social-login-ack), at most two minutes.
  let loginRequest=null;const pendingLogin=()=>loginRequest&&Date.now()-loginRequest.at<120000?{requestedPlatform:loginRequest.platform,requestId:loginRequest.requestId,requestedAt:loginRequest.at}:{requestedPlatform:null,requestId:null};
  // B7: the last check of each account (a finished scan counts as one), kept across restarts; no credentials, only time and result.
  const checksPath=join(dataRoot,'social-account-checks.json');let accountChecks={};try{const raw=JSON.parse(await readFile(checksPath,'utf8'));if(raw&&typeof raw==='object'&&!Array.isArray(raw))for(const [ref,row]of Object.entries(raw))if(typeof ref==='string'&&ref.length<=200&&Number.isFinite(row?.at)&&typeof row.ok==='boolean')accountChecks[ref]={at:row.at,ok:row.ok,...(typeof row.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(row.code)?{code:row.code}:{})};}catch{}
  let checksTail=Promise.resolve();const recordCheck=(ref,ok,code=null)=>{if(typeof ref!=='string'||!ref)return;accountChecks={...accountChecks,[ref]:{at:Date.now(),ok,...(code&&/^[A-Z0-9_]{1,80}$/.test(code)?{code}:{})}};const value=JSON.stringify(accountChecks);checksTail=checksTail.then(()=>writeFile(checksPath,value)).catch(()=>{});};
  const loginsSeen=new Set();
  // C-4: open plugin pages re-read their accounts after a login, a removal or a change of account
  let accountsTimer=null;socialAccounts.subscribe(()=>{if(closed||accountsTimer)return;accountsTimer=setTimeout(()=>{accountsTimer=null;if(closed)return;void clientHost.notify('ai-buddy:social-accounts-changed').catch(()=>{});void workClientHost?.notify('ai-buddy:social-accounts-changed').catch(()=>{});},250);accountsTimer.unref?.();});
  const qqLogin=qqLoginFactory({dataRoot,build,accounts:socialAccounts,onState:()=>onUpdate(platform?.snapshot())});
  const socialLogin=createSocialLogin({accounts:socialAccounts,drivers:{bilibili:createBilibiliLoginDriver({BrowserWindow,session}),qq:qqLogin},onUpdate:()=>{try{for(const row of socialLogin.snapshot().states)if(row.phase==='connected'&&row.account?.ref&&row.attemptId&&!loginsSeen.has(row.attemptId)){loginsSeen.add(row.attemptId);recordCheck(row.account.ref,true);}}catch{}onUpdate(platform?.snapshot());}});
  const biliVision=createBiliVision({directory:join(dataRoot,'social-core','bili-vision-v1'),renderSheet:renderBiliSheet,analyzeFrames:analyzeBiliFrames,acquireMedia:createBiliMedia({resolveVerifiedExecutable:options=>ffmpegManager.resolveVerifiedExecutable(options),workerPath:join(build,'bili-full-media-worker.mjs'),tools:join(build,'bili-media'),tempRoot:join(dataRoot,'social-core','bili-media-temp'),playback:(request)=>biliPlayback(request,socialAccounts)})});
  const socialBroker=createSocialPluginBroker({dataRoot,accounts:socialAccounts,transport:socialTransport,biliVision,requireBiliMedia:async({signal}={})=>{try{return await ffmpegManager.resolveVerifiedExecutable({signal});}catch(cause){try{await onNotification({kind:'host-component-required',component:'ffmpeg',code:cause.code,title:'需要准备B站视频组件',page:'plugins'});}catch{}throw cause;}},onReadingOpen:async value=>{await onReadingOpen(value);await clientHost.notify('ai-buddy:bili-reading-open',{activityId:value.activityId});},verifyBilibiliAccount:(ref,options)=>socialLogin.check(ref,options),bridge,getR95:()=>getGame()?.r95,getProvider,onSetup:async({packageName,action,payload={},signal,check=async()=>{}})=>{
    const platformName=Object.keys(SOCIAL_LOGIN_PLUGINS).find(key=>SOCIAL_LOGIN_PLUGINS[key]===packageName);if(!platformName)throw error('不支持此账号入口','SOCIAL_LOGIN_PLATFORM_INVALID');
    if(action==='open'){loginRequest={platform:platformName,requestId:randomUUID(),at:Date.now()};onUpdate(platform?.snapshot());try{openSocialSetup({platform:platformName,requestId:loginRequest.requestId,at:loginRequest.at});}catch(cause){audit({type:'social-setup-open-failed',code:cause?.code??'SOCIAL_SETUP_OPEN_FAILED'});}return {opened:true,platform:platformName};}
    const account=socialAccounts.forPlugin(packageName);
    if(action==='contacts'&&platformName==='qq')return qqLogin.contacts(account.ref);
    if(action==='ensure'&&platformName==='qq')return qqLogin.ensureIfManaged(account.ref,payload);
    if(action==='complete'){await check();signal?.throwIfAborted();if(platformName==='qq')await qqLogin.setAutoResume(account.ref,payload.autoResume===true,payload.scope,{signal,check});await check();signal?.throwIfAborted();socialAccounts.approveActivities(account.ref);return {saved:true};}
    throw error('不支持此连接操作','SOCIAL_LOGIN_ACTION_INVALID');
  },onEvent:(identity,event)=>socialFacade.emit(identity,event),onBubble:value=>onNotification({...value,kind:'social-activity'})});
  const socialFacade=createNativeSocialFacade({dataRoot,features:['social-login-v1',...socialBroker.features()],contract:{hash:NATIVE_SOCIAL_CONTRACT_HASH,methods:NATIVE_SOCIAL_CONTRACT.methods},handlers:socialBroker.handlers,contextProvider:socialBroker.contextProvider,
    resolveGrant:identity=>{const row=socialRecords.get(identity.pluginId),grant=bridge.grants.get(identity.pluginId);return row&&grant?{...row,...grant}:null;},
    authorizeUI:request=>currentBackend?.verifySocialUI(request)??false});
  const socialTick=setInterval(()=>{for(const record of socialRecords.values())if(record.enabled)socialFacade.emit(record,{type:'tick',at:Date.now()});},10000);socialTick.unref?.();
  function assertComponentSelection(generation){
    if(closed)throw error('插件平台已关闭','PLUGIN_CLOSED');
    if(componentChanging||generation!==componentGeneration)throw error('运行组件忙碌，不能切换','DSH_COMPONENT_BUSY');
  }
  async function selectedRuntimeLock(){
    const generation=componentGeneration;assertComponentSelection(generation);let selected=runtimeLockPath;
    if(!selected){if(!componentChecked){const status=await componentManager.status();assertComponentSelection(generation);selectedComponentLock=status.state==='ready'?status.runtimeLockPath:null;componentChecked=true;}selected=selectedComponentLock??join(root,'runtime','dsh','runtime-lock.json');}
    assertComponentSelection(generation);return resolve(selected);
  }
  async function backend(){
    const generation=componentGeneration,selected=await selectedRuntimeLock();assertComponentSelection(generation);
    if(currentBackend&&selected===currentLock)return currentBackend;
    if(currentBackend){if(inflight||await busy())throw error('运行组件忙碌，不能切换','DSH_COMPONENT_BUSY');await currentBackend.close();}
    assertComponentSelection(generation);currentLock=selected;
    currentBackend=createDshBackend({runtimeLockPath:selected,dshHome:join(dataRoot,'plugin-runtimes','dsh'),profileId:'buddy-community-v1',stateDir:join(dataRoot,'plugin-platform','dsh'),hostBridgeSourcePath:join(build,'dsh-platform','native-bridge-host.mjs'),buddyServices:bridge,socialServices:socialFacade,resolveToolScope,onEvent:event=>{nativeEvents.emit('event',event);if(event.kind==='runtime-exit')for(const id of grantStates.keys())if(![...workBackends.values()].some(value=>value.record.pluginId===id))void bridge.revokePlugin(id);if(event.kind!=='runtime-log')audit({type:'dsh-runtime-event',...event});}});
    return currentBackend;
  }
  const dshBackend={};
  for(const name of ['probe','planInstall','install','enable','disable','rollback','uninstall','openClient','listTools','callTool'])dshBackend[name]=async(...args)=>{const generation=componentGeneration,live=await backend();assertComponentSelection(generation);inflight++;communityCalls++;try{return await live[name](...args);}finally{communityCalls--;inflight--;}};
  dshBackend.snapshot=async(...args)=>currentBackend?currentBackend.snapshot(...args):{phase:'not-started',installed:[],ready:false,code:'DSH_NOT_REQUESTED'};
  dshBackend.status=dshBackend.snapshot;
  dshBackend.on=(name,listener)=>{nativeEvents.on(name,listener);return()=>nativeEvents.off(name,listener);};
  dshBackend.close=async()=>{await currentBackend?.close();};
  async function onPackageState(record){
    const id=record.pluginId;if(!id)return;const previous=socialRecords.get(id);
    if(previous&&(previous.generation>record.generation||previous.generation===record.generation&&previous.enabled===true&&record.enabled!==true))return;
    const selected=structuredClone(record);socialRecords.set(id,selected);
    const state=JSON.stringify({enabled:record.enabled,declared:record.declaredCapabilities,granted:record.grantedCapabilities,digest:record.sourceDigest,generation:record.generation,phase:record.phase});if(grantStates.get(id)===state)return;
    if(!record.enabled){
      // Both authorities revoke synchronously before any login/owned-child wait.
      // Cleanup may fail, but no old grant or context survives that failure.
      const cleanup=[bridge.revokePlugin(id)];try{cleanup.push(Promise.resolve(getSocialHost()?.revokePlugin(id)));}catch(cause){cleanup.push(Promise.reject(cause));}
      for(const [name,packageName]of Object.entries(SOCIAL_LOGIN_PLUGINS))if(record.packageName===packageName)cleanup.push(socialLogin.disconnect(name));
      const failures=(await Promise.allSettled(cleanup)).filter(row=>row.status==='rejected').map(row=>row.reason);if(failures.length===1)throw failures[0];if(failures.length)throw Object.assign(new AggregateError(failures,'Plugin authority cleanup failed'),{code:'PLUGIN_CLEANUP_FAILED'});
      if(socialRecords.get(id)===selected)grantStates.set(id,state);return;
    }
    if(closed)throw error('插件平台已关闭','PLUGIN_CLOSED');
    const prior=bridge.grants.get(id);bridge.grants.set({pluginId:id,declared:record.declaredCapabilities??[],granted:record.grantedCapabilities??[],enabled:true,generation:Math.max((prior?.generation??0)+1,record.generation??1)});grantStates.set(id,state);
  }
  const community=await createCommunityService({root,dataRoot,legacyManager,dshBackend,hostDependencies:{plan:value=>dependencyCoordinator.plan(value),run:value=>dependencyCoordinator.run(value)},busy:(key,ref,activationPlugin)=>dependencyCoordinator?.preparing()||componentChanging||(activationPlugin?communityCalls>0||bridge.busy(activationPlugin)||[...taskToolBackends].some(b=>b.usesPlugin(activationPlugin)):inflight>0||taskToolBackends.size>0||bridge.busy()||busy()),onUpdate:value=>onUpdate(platform?.snapshot()??value),onPackageState,onOpenClient:(descriptor,{external=false}={})=>external?clientHost.external(descriptor):clientHost.open(descriptor,{surface:embedScope.getStore()?.surface??null,panel:embedScope.getStore()?.panel??null}),onOpenExternal:openExternal});
  async function installDshComponent({planId,signal}={}){if(componentChanging)throw error('运行组件忙碌，不能切换','DSH_COMPONENT_BUSY');componentChanging=true;componentGeneration++;try{const result=await componentManager.install({planId,signal});if(closed)return result;const revokeRuntime=!!currentBackend||workBackends.size>0||community.snapshot().dsh.installed.some(row=>row.runtimeVerified||bridge.grants.get(row.pluginId)?.enabled);if(currentBackend){await currentBackend.close();currentBackend=null;currentLock=null;}for(const value of workBackends.values()){await workClientHost?.closePackage(value.record.packageKey);await value.backend.close();}workBackends.clear();runtimeDescriptors.clear();invalidateDshComponentVerification();selectedComponentLock=result.runtimeLockPath;componentChecked=true;if(revokeRuntime)await community.invalidateRuntime?.({phase:'component-changed'});for(const row of clientHost.snapshot())await clientHost.closeRuntime(row.runtimeId);return result;}finally{componentChanging=false;}}
  async function readyDsh(){
    const status=await componentManager.status();dshComponentState=status;if(status.state==='ready')return status;
    try{const path=runtimeLockPath??join(root,'runtime','dsh','runtime-lock.json');await trustedRuntimeDescriptor(path);return {state:'ready',runtimeLockPath:path};}catch{return status;}
  }
  dependencyCoordinator=createHostDependencyCoordinator({busy:()=>inflight>0||taskToolBackends.size>0||bridge.busy()||busy(),onUpdate:()=>onUpdate(platform?.snapshot()),describe:async()=>{
    const dsh=await readyDsh(),ffmpeg=await ffmpegManager.status(),descriptor=JSON.parse(await readFile(join(build,'dsh-component.json'),'utf8')),dshPlan=await planHostDshComponent({descriptor,manager:componentManager}),ff=FFMPEG_COMPONENT_DESCRIPTOR;
    const dshPin=createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),ffmpegPin=createHash('sha256').update(JSON.stringify(ff)).digest('hex');
    return {dshPlanId:dshPlan.planId,dshPin,ffmpegPin,downloads:{dsh:{allowed:dsh.state!=='ready',bytes:dsh.state==='ready'?0:descriptor.bytes,identity:dshPin},ffmpeg:{allowed:ffmpeg.state!=='ready',bytes:ffmpeg.state==='ready'?0:ff.bytes,identity:ffmpegPin}},components:[{id:'dsh',label:'DSH运行组件',version:descriptor.sourceCommit,url:descriptor.url,noticeUrl:'https://github.com/deepseek-ai/DeepSeek-Harness',bytes:descriptor.bytes,downloadBytes:dsh.state==='ready'?0:descriptor.bytes,ready:dsh.state==='ready'},{id:'ffmpeg',label:'B站视频组件（FFmpeg）',version:ffmpeg.version,url:ff.url??ff.archive?.url,noticeUrl:ff.licenseUrl,bytes:ffmpeg.bytes,downloadBytes:ffmpeg.state==='ready'?0:ffmpeg.bytes,ready:ffmpeg.state==='ready'}]};
  },prepare:async(value,{signal,check,phase})=>{
    await check();const descriptor=JSON.parse(await readFile(join(build,'dsh-component.json'),'utf8'));if(createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')!==value.dshPin||createHash('sha256').update(JSON.stringify(FFMPEG_COMPONENT_DESCRIPTOR)).digest('hex')!==value.ffmpegPin)throw error('Host component identities changed','COMMUNITY_PLAN_CHANGED');
    const allowance=(id,state,identity,bytes)=>{const approved=value.downloads?.[id];if(state!=='ready'&&(!approved?.allowed||approved.identity!==identity||approved.bytes!==bytes))throw error('Host component readiness changed; refresh the plan and confirm the displayed download bytes','HOST_DEPENDENCY_PLAN_CHANGED');};
    // Verify every reuse-only assumption before starting any component download.
    const initialDsh=await readyDsh();await check();const initialFfmpeg=await ffmpegManager.status({signal});await check();allowance('dsh',initialDsh.state,value.dshPin,descriptor.bytes);allowance('ffmpeg',initialFfmpeg.state,value.ffmpegPin,FFMPEG_COMPONENT_DESCRIPTOR.bytes);
    phase('preparing-dsh');const dsh=await readyDsh();await check();allowance('dsh',dsh.state,value.dshPin,descriptor.bytes);if(dsh.state!=='ready')await installDshComponent({planId:value.dshPlanId,signal});await check();
    phase('preparing-ffmpeg');const ffmpeg=await ffmpegManager.status({signal});await check();allowance('ffmpeg',ffmpeg.state,value.ffmpegPin,FFMPEG_COMPONENT_DESCRIPTOR.bytes);if(ffmpeg.state!=='ready')await ffmpegManager.prepare({signal,repair:ffmpeg.state==='repair-required'});await check();await ffmpegManager.resolveVerifiedExecutable({signal});await check();
  }});
  async function runtimeDescriptor(){
    const generation=componentGeneration,lockPath=await selectedRuntimeLock();assertComponentSelection(generation);const raw=await readFile(lockPath),key=lockPath+'\0'+createHash('sha256').update(raw).digest('hex');
    if(!runtimeDescriptors.has(key)){const checking=trustedRuntimeDescriptor(lockPath);runtimeDescriptors.set(key,checking);checking.catch(()=>runtimeDescriptors.delete(key));}
    const descriptor=await runtimeDescriptors.get(key),inventory=JSON.parse(raw);
    for(const [field,name]of [['nodePath','node'],['sdkEntry','sdk'],['cliEntry','cli']]){await assertPluginTreeNoLinks(descriptor[field]);const entry=inventory.files.find(row=>row.path===inventory.paths[name]);if(!entry||createHash('sha256').update(await readFile(descriptor[field])).digest('hex')!==entry.sha256)throw error('DSH运行入口与已验组件不符','DSH_RUNTIME_HASH_MISMATCH');}
    assertComponentSelection(generation);return {...descriptor};
  }
  async function currentWorkRecord(input){
    if(closed)throw error('插件平台已关闭','PLUGIN_CLOSED');
    if(!input?.packageKey)throw error('缺少已安装的工作插件身份','WORK_PACKAGE_REQUIRED');
    const record=await community.resolveDshInstalled(input.packageKey);
    if(record.packageName!=='@ai-buddy/work-collaboration'||record.enabled!==true||record.sourceDigest!==input.sourceDigest||record.exactVersion!==input.exactVersion||record.generation!==input.generation||record.pluginId!==input.pluginId)throw error('工作插件登记或启用状态已变化','WORK_PACKAGE_CHANGED');
    return record;
  }
  async function createIsolatedWorkBackend(input){
    const record=await currentWorkRecord(input),lockPath=await selectedRuntimeLock(),existing=workBackends.get(record.packageKey);
    if(workReleases.has(record.packageKey)||existing?.retiring)throw error('工作运行实例正在释放或等待停止凭据','WORK_RUNTIME_BUSY');
    if(existing&&existing.lockPath===lockPath&&existing.record.sourceDigest===record.sourceDigest&&existing.record.generation===record.generation)return existing.backend;
    if(workPreparations.has(record.packageKey))return workPreparations.get(record.packageKey);
    const preparing=(async()=>{
      if(existing){if(await busy())throw error('工作任务仍在运行，不能切换工作插件实例','WORK_RUNTIME_BUSY');workBackends.delete(record.packageKey);await workClientHost?.closePackage(record.packageKey);await existing.backend.close();}
      // Native PM creates log/staging suffixes below HOME/profiles/profileId.
      // Keep this internal deployment shallow enough for Win32 tools while
      // the source-bound business database retains its existing data path.
      const identity=createHash('sha256').update(record.packageKey).digest('hex').slice(0,24),home=join(dataRoot,'wr',identity),stateDir=join(dataRoot,'ws',identity),profileId='buddy-work-ui-'+identity.slice(0,12);
      const live=createDshBackend({runtimeLockPath:lockPath,dshHome:home,profileId,stateDir,workClientMode:true,hostBridgeSourcePath:join(build,'dsh-platform','native-bridge-host.mjs'),buddyServices:bridge,resolveToolScope,onEvent:event=>{if(['runtime-verification','install-state'].includes(event.kind))nativeEvents.emit('event',{kind:'platform-progress',phase:event.phase});else if(event.kind==='tools-changed')nativeEvents.emit('event',{kind:'platform-progress',phase:'checking-plugin'});if(event.kind==='runtime-exit'){const active=workBackends.get(record.packageKey);if(active?.backend===live&&!active.retiring){workBackends.delete(record.packageKey);void community.invalidatePackageRuntime({packageKey:record.packageKey,generation:record.generation,phase:'work-runtime-exit'}).catch(cause=>audit({type:'work-runtime-revoke-failed',code:cause.code??'WORK_REVOKE_FAILED'}));void workClientHost?.closePackage(record.packageKey);}}if(event.kind!=='runtime-log')audit({type:'work-native-runtime-event',packageKey:record.packageKey,...event});}});
      inflight++;
      try{const nativePolicy=await nativeModulePolicyFromLock(lockPath,{hostBridgeSourcePath:join(build,'dsh-platform','native-bridge-host.mjs'),stateDir});await prepareIsolatedWorkBackend({record,backend:live,stateDir,isCurrent:currentWorkRecord,confirmActivation:value=>community.confirmNativeActivation(value),nativePolicy});workBackends.set(record.packageKey,{backend:live,record,lockPath,stateDir,home,profileId,nativePolicy});nativeEvents.emit('event',{kind:'platform-progress',phase:'ready'});return live;}
      catch(cause){await live.close();grantStates.delete(record.pluginId);await bridge.revokePlugin(record.pluginId);throw cause;}
      finally{inflight--;}
    })();workPreparations.set(record.packageKey,preparing);try{return await preparing;}finally{if(workPreparations.get(record.packageKey)===preparing)workPreparations.delete(record.packageKey);}
  }
  async function openWorkClient({record:input,backend:live,handlers,surface=null}){
    const record=await currentWorkRecord(input),owned=workBackends.get(record.packageKey);
    if(!owned||owned.backend!==live)throw error('工作页面必须来自已验独立运行实例','WORK_RUNTIME_REQUIRED');
    assertOnlyWorkBundle(await live.snapshot(),record.packageName,owned.nativePolicy);
    const preloadPath=pluginClientPreloadPath??join(build,'plugin-client-preload.cjs');await assertPluginTreeNoLinks(preloadPath);try{if(!(await stat(preloadPath)).isFile())throw error('缺少工作页面的受控接口','WORK_CLIENT_PRELOAD_REQUIRED');}catch(cause){throw error('本版本尚未编译工作页面的受控接口','WORK_CLIENT_PRELOAD_REQUIRED');}
    if(!workClientHost)workClientHost=createWorkClientHost({BrowserWindow,session,ipcMain,preloadPath,openExternal,audit,onState:event=>{audit({type:'work-client',...event});clientEvents.emit('state',{kind:'work',state:event.state,surface:event.surface});},appearance:pageAppearance});
    const descriptor=await live.openClient();
    const checkedHandlers={...handlers,assertCurrent:async context=>{await currentWorkRecord(record);const active=workBackends.get(record.packageKey);if(active?.backend!==live)throw error('工作原生运行实例已变化','WORK_RUNTIME_CHANGED');if(typeof handlers?.assertCurrent!=='function')throw error('缺少工作生命周期验证器','WORK_CLIENT_AUTHORITY_REQUIRED');await handlers.assertCurrent(context);}};
    return workClientHost.open({record,descriptor,handlers:checkedHandlers,surface});
  }
  async function releaseIsolatedWorkBackend({record:input,backend:live,confirmStopped}={}){
    if(live&&releasedWorkBackends.has(live))return releasedWorkBackends.get(live);
    if(input?.packageKey&&workReleases.has(input.packageKey))return workReleases.get(input.packageKey);
    const record=await currentWorkRecord(input),owned=workBackends.get(record.packageKey);
    if(!owned||owned.backend!==live)throw error('只能释放当前已验工作实例','WORK_RUNTIME_REQUIRED');
    if(inflight>0||await busy()||bridge.busy(record.pluginId))throw error('工作任务仍在运行，页面关闭后会在后台继续','WORK_RUNTIME_BUSY');
    if(typeof confirmStopped!=='function')throw error('缺少工作实例OS停止核验','WORK_PROCESS_PROOF_MISSING');
    const releasing=retireIsolatedWorkBackend({record,backend:live,closeClient:()=>workClientHost?.closePackage(record.packageKey),confirmStopped,invalidate:value=>community.invalidatePackageRuntime(value),onRetire:()=>{owned.retiring=true;if(workBackends.get(record.packageKey)===owned)workBackends.delete(record.packageKey);},onFailure:()=>{owned.retiring=true;workBackends.set(record.packageKey,owned);}});
    workReleases.set(record.packageKey,releasing);try{const result=await releasing;releasedWorkBackends.set(live,result);return result;}finally{if(workReleases.get(record.packageKey)===releasing)workReleases.delete(record.packageKey);}
  }
  async function createTaskToolBackend({jobId,runId,records,assertCurrent,onProcessStart,onProcessStop,modelBinding=null,modelEnvironment,authorizeNativeModel,onNativeModelUsage}={}){
    if(closed)throw error('插件平台已关闭','PLUGIN_CLOSED');
    if(typeof jobId!=='string'||!jobId||typeof runId!=='string'||!runId||!Array.isArray(records)||!records.length||typeof assertCurrent!=='function'||typeof onProcessStart!=='function'||typeof onProcessStop!=='function')throw error('任务工具必须有精确批准记录和宿主进程守卫','WORK_TOOL_AUTHORITY_REQUIRED');
    const captured=records.map(record=>structuredClone(record));modelBinding=modelBinding?structuredClone(modelBinding):null;
    async function check(){
      if(closed)throw error('插件平台已关闭','PLUGIN_CLOSED');await assertCurrent();
      for(const expected of captured){const actual=await community.resolveDshInstalled(expected.packageKey);if(actual.enabled!==true||['sourceId','pluginId','packageName','packageKey','exactVersion','sourceDigest','generation'].some(key=>actual[key]!==expected[key])||actual.backendPlan?.artifactSha256!==expected.backendPlan?.artifactSha256)throw error('批准的任务工具来源、版本或启用状态已变化','WORK_TOOL_PACKAGE_CHANGED');}
    }
    await check();
    if(modelBinding!==null){
      if(typeof onNativeModelUsage!=='function')throw error('原生工具模型必须接入真实用量回执','DSH_NATIVE_MODEL_USAGE_REQUIRED');
      let endpoint;try{endpoint=new URL(modelEnvironment?.DEEPSEEK_BASE_URL);}catch{}
      if(modelBinding.engine!=='dsh'||modelBinding.provider!=='deepseek-official'||!modelBinding.connectionRef||!modelBinding.model||!endpoint||endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!modelEnvironment?.DEEPSEEK_API_KEY||typeof authorizeNativeModel!=='function')throw error('原生工具需要明确的DSH工作模型和私有代理','DSH_NATIVE_MODEL_CONFIGURATION_REQUIRED');
    }
    const lockPath=await selectedRuntimeLock(),identity=createHash('sha256').update(jobId+'\0'+runId+'\0'+randomUUID()).digest('hex').slice(0,20),home=join(dataRoot,'tt',identity),stateDir=join(dataRoot,'ts',identity),profileId='buddy-tools-'+identity;
    const descriptor=await runtimeDescriptor(),nodeSha256=createHash('sha256').update(await readFile(descriptor.nodePath)).digest('hex');
    let processProof=null,processIdentity=null,closing=null,stopped=false;const controller=new AbortController(),calls=new Set();
    const live=createDshBackend({runtimeLockPath:lockPath,dshHome:home,profileId,stateDir,purpose:'job-tools',taskMode:{jobId,runId,modelBinding:modelBinding?structuredClone(modelBinding):null,...modelBinding?{modelEnvironment:{DEEPSEEK_BASE_URL:modelEnvironment.DEEPSEEK_BASE_URL,DEEPSEEK_API_KEY:modelEnvironment.DEEPSEEK_API_KEY}}:{}},taskBootstrapPath:join(build,'dsh-platform','inert-bootstrap.mjs'),hostBridgeSourcePath:join(build,'dsh-platform','native-bridge-host.mjs'),buddyServices:bridge,resolveToolScope:()=>taskToolModelScope(modelBinding),authorizeNativeModel:async value=>{await check();if(!modelBinding||!captured.some(record=>record.pluginId===value.pluginId))throw error('未批准原生工具的DSH模型调用','DSH_NATIVE_MODEL_CONFIGURATION_REQUIRED');return authorizeNativeModel(value);},onNativeModelUsage:async value=>{if(!modelBinding||typeof onNativeModelUsage!=='function'||value.jobId!==jobId||value.runId!==runId||value.profileId!==profileId||!captured.some(record=>record.pluginId===value.pluginId))throw error('原生工具用量不属于当前任务和批准模型','WORK_TOOL_USAGE_DENIED');return onNativeModelUsage(value);},
      onProcessStart:async value=>{await check();processIdentity={...value,jobId,runId,expectedNodePath:descriptor.nodePath,expectedNodeHash:nodeSha256};processProof=await onProcessStart(processIdentity);if(processProof?.registered!==true||processProof.guardReady!==true)throw error('任务工具加载前未取得真实OS进程守卫','WORK_PROCESS_GUARD_REQUIRED');await check();return processProof;},
      onProcessStop:async value=>{const proof=await onProcessStop({...processIdentity,...value,jobId,runId});if(proof?.stopped!==true||proof.osActiveProcesses!==0)throw error('任务工具原生后代尚未证实停止','WORK_PROCESS_STOP_UNCONFIRMED');return proof;},
      onEvent:event=>{if(event.kind!=='runtime-log')audit({type:'task-tool-native-event',jobId,runId,...event});}});
    async function close(){
      if(closing)return closing;stopped=true;controller.abort();
      closing=(async()=>{const result=await live.close(),proof=result?.osStopProof??result;if(processIdentity&&(proof?.stopped!==true||proof.osActiveProcesses!==0))throw error('任务工具原生后代尚未证实停止','WORK_PROCESS_STOP_UNCONFIRMED');await Promise.allSettled([...calls]);taskToolBackends.delete(wrapper);return {...result,stopped:true,osActiveProcesses:0,processRegistered:!!processIdentity};})();closing.catch(()=>{closing=null;});return closing;
    }
    function invoke(name,args){
      if(stopped)return Promise.reject(error('任务工具租约已撤销','WORK_TOOL_LEASE_CLOSED'));
      inflight++;const operation=(async()=>{await check();const context=args[args.length-1];if(!captured.some(record=>record.pluginId===context?.pluginId))throw error('任务工具上下文不属于批准插件','MCP_CONTEXT_DENIED');if(name==='callTool')args[0]={...args[0],signal:args[0]?.signal?AbortSignal.any([args[0].signal,controller.signal]):controller.signal};const value=await live[name](...args);await check();if(stopped)throw error('任务工具租约已撤销','WORK_TOOL_LEASE_CLOSED');return value;})();calls.add(operation);operation.finally(()=>{calls.delete(operation);inflight--;}).catch(()=>{});return operation;
    }
    const wrapper=Object.freeze({usesPlugin:id=>captured.some(record=>record.pluginId===id),listTools:context=>invoke('listTools',[context]),callTool:(request,context)=>invoke('callTool',[request,context]),snapshot:async()=>{const value=await live.snapshot();return {runtimeId:value.runtimeId,profileId:value.profileId,pid:value.pid,phase:value.phase,purpose:'job-tools',jobId,runId,packages:captured.map(record=>({packageKey:record.packageKey,pluginId:record.pluginId,exactVersion:record.exactVersion,sourceDigest:record.sourceDigest})),processRegistered:processProof?.guardReady===true};},close});
    taskToolBackends.add(wrapper);inflight++;
    try{const nativePolicy=await nativeModulePolicyFromLock(lockPath,{hostBridgeSourcePath:join(build,'dsh-platform','native-bridge-host.mjs'),stateDir});await prepareTaskToolBackend({records:captured,backend:live,stateDir,assertCurrent:check,nativePolicy});return wrapper;}
    catch(cause){try{await close();}catch(stopError){throw Object.assign(stopError,{cause});}throw cause;}
    finally{inflight--;}
  }
  async function action(request){
    const operation=request?.action;
    if(operation==='dsh-open-client'&&community.snapshot().dsh.installed.find(record=>record.packageKey===request.packageKey)?.packageName==='@ai-buddy/work-collaboration'){
      if(request.external!==undefined&&typeof request.external!=='boolean')throw error('打开方式必须是明确选择','WORK_CLIENT_DENIED');
      if(request.external===true)throw error('工作与协作需要在AI Buddy的受控工作窗口中打开','WORK_CLIENT_CONTROLLED_ONLY');
      if(typeof workClientOpener!=='function')throw error('工作插件入口尚未准备完成','WORK_CLIENT_UNAVAILABLE');return workClientOpener();
    }
    if(operation==='dsh-open-client'&&request.external!==true&&!embedScope.getStore()){const record=community.snapshot().dsh.installed.find(value=>value.packageKey===request.packageKey);if(record&&record.packageName!=='@ai-buddy/work-collaboration'&&PANEL_PLUGIN.test(record.packageName??''))return embedScope.run({surface:null,panel:record.packageName},()=>community.action(request));}
    if(operation==='social-accounts-list')return {accounts:socialAccounts.list(),checks:structuredClone(accountChecks)};
    if(operation==='social-accounts-save')return {account:socialAccounts.save(request.account)};
    if(operation==='social-accounts-check')return checkSocialAccountDraft(request.account,{accounts:socialAccounts});
    if(operation==='social-login-status')return {...socialLogin.snapshot(),...pendingLogin(),component:qqLogin.componentInfo()};
    if(operation==='social-login-ack'){if(typeof request.requestId!=='string'||request.requestId.length>100)throw error('登录请求无效','SOCIAL_LOGIN_REQUEST_INVALID');if(loginRequest?.requestId===request.requestId)loginRequest=null;return {acknowledged:true};}
    if(operation==='social-login-start')return socialLogin.start(request.platform,{expectedAccountId:request.expectedAccountId??null});
    if(operation==='social-login-cancel')return socialLogin.cancel(request.platform);
    if(operation==='social-login-refresh')return socialLogin.refresh(request.platform);
    if(operation==='social-login-check'){try{const value=await socialLogin.check(request.ref);recordCheck(request.ref,true);return value;}catch(cause){if(socialAccounts.get(request.ref)&&cause?.code!=='SOCIAL_LOGIN_BUSY')recordCheck(request.ref,false,typeof cause?.code==='string'?cause.code:'SOCIAL_LOGIN_FAILED');throw cause;}}
    if(operation==='social-login-disconnect'){const account=socialAccounts.get(request.ref);if(!account)throw error('账号不存在','SOCIAL_ACCOUNT_UNKNOWN');await socialLogin.disconnect(account.platform);return {account:socialAccounts.save({...account,enabled:false})};}
    if(operation==='social-account-remove'){const account=socialAccounts.get(request.ref);if(!account)throw error('账号不存在','SOCIAL_ACCOUNT_UNKNOWN');if(account.enabled)await socialLogin.disconnect(account.platform);return socialAccounts.remove(account.ref);}
    if(operation==='host-dependency-open-link'){if(!['dsh','ffmpeg'].includes(request.component)||!['source','notice'].includes(request.kind))throw error('Invalid host component link','HOST_DEPENDENCY_INVALID');const descriptor=request.component==='ffmpeg'?FFMPEG_COMPONENT_DESCRIPTOR:assertPublicDshComponentDescriptor(JSON.parse(await readFile(join(build,'dsh-component.json'),'utf8'))),url=request.kind==='notice'?(request.component==='ffmpeg'?descriptor.licenseUrl:'https://github.com/deepseek-ai/DeepSeek-Harness'):(descriptor.url??descriptor.archive?.url);await openExternal(url);return {opened:true};}
    if(operation==='host-dependency-cancel')return dependencyCoordinator.cancel({operationId:request.operationId});
    if(operation==='bili-component-status')return ffmpegManager.status();
    if(operation==='bili-component-prepare'){if(dependencyCoordinator.active())throw error('Host dependency preparation is running','HOST_DEPENDENCY_BUSY');return ffmpegManager.prepare({repair:request.repair===true});}
    if(operation==='bili-component-cancel')return ffmpegManager.cancel({operationId:request.operationId});
    if(operation==='dsh-component-status')return componentManager.status();
    if(operation==='dsh-component-plan'){
      let descriptor;try{descriptor=JSON.parse(await readFile(join(build,'dsh-component.json'),'utf8'));}catch{throw error('本版本尚未附带已验证的DSH运行组件描述，请使用匹配的发行候选','DSH_COMPONENT_DESCRIPTOR_REQUIRED');}
      return planHostDshComponent({request,descriptor,manager:componentManager,chooseArchive:chooseComponentArchive});
    }
    if(operation==='dsh-component-cancel')return componentManager.cancel();
    // Fresh/cold preparation has no runtime or grant to revoke. Started backends
    // and verified/enabled grants still require the existing generation reset.
    if(operation==='dsh-component-install'){if(dependencyCoordinator.active())throw error('Host dependency preparation is running','HOST_DEPENDENCY_BUSY');return installDshComponent({planId:request.planId});}
    const result=await community.action(request),extra={hostDependencies:dependencyCoordinator.snapshot(),mediaComponents:{ffmpeg:ffmpegManager.snapshot()},dshComponent:dshComponentState};return result?.snapshot?{...result,snapshot:{...result.snapshot,...extra}}:operation==='community-status'?{...result,...extra}:result;
  }
  // Main-window embedding (plugin-embed.mjs): same community open path, only the page's surface differs.
  async function openClientEmbedded({packageKey,surface}){
    if(typeof surface!=='function')throw error('嵌入页面需要宿主提供的显示面','PLUGIN_EMBED_DENIED');
    const record=community.snapshot().dsh.installed.find(value=>value.packageKey===packageKey);
    if(!['@ai-buddy/bilibili-companion','@ai-buddy/qq-connect'].includes(record?.packageName))throw error('只有社交插件页面走这个入口','PLUGIN_EMBED_DENIED');
    return embedScope.run({surface},()=>community.action({action:'dsh-open-client',packageKey}));
  }
  platform={...community,action,bridge,openClientEmbedded,onClientState:listener=>{clientEvents.on('state',listener);return()=>clientEvents.off('state',listener);},socialAccounts,dshBackend,componentManager,ffmpegManager,dependencyCoordinator,clientHost,runtimeDescriptor,createIsolatedWorkBackend,releaseIsolatedWorkBackend,createTaskToolBackend,openWorkClient,setWorkClientOpener:opener=>{if(typeof opener!=='function')throw TypeError('Work client opener must be host supplied');workClientOpener=opener;},invalidateRuntime:async value=>{runtimeDescriptors.clear();invalidateDshComponentVerification();return community.invalidateRuntime(value);},
    // Host-only read ports. These are not renderer action names or plugin RPCs.
    resolveDshInstalled:packageKey=>community.resolveDshInstalled(packageKey),
    resolveTrustedSource:sourceId=>community.resolveTrustedSource(sourceId),
    snapshot:()=>({...community.snapshot(),hostDependencies:dependencyCoordinator.snapshot(),mediaComponents:{ffmpeg:ffmpegManager.snapshot()},dshComponent:dshComponentState,platform:{version:'buddy-bridge-v1',activeCalls:inflight,activeTaskToolRuntimes:taskToolBackends.size,registeredPages:[...pages.values()].map(v=>({pluginId:v.pluginId,id:v.descriptor.id,title:v.descriptor.title??v.descriptor.id})),nativeClients:clientHost.snapshot(),workClients:workClientHost?.snapshot()??[]}}),
    async issueSocialContext({pluginId,eventRef,permissionScope}){if(!getSocialHost())throw error('社交宿主尚未就绪','BUDDY_SERVICE_UNAVAILABLE');return bridge.issueContext({contextKind:'social',pluginId,eventRef,permissionScope});},
    async issueToolContext({pluginId,characterId,personaId,workspace,taskId,sessionId=randomUUID(),permissionScope=['tools.list','tools.invoke'],connectionRefs=[],planState='planning',readOnlyToolNames=[],approvedPlanRevision=null}){return bridge.issueContext({pluginId,characterId,personaId,workspace,taskId,sessionId,permissionScope,connectionRefs,planState,readOnlyToolNames,approvedPlanRevision});},
    async issueActiveToolContext({pluginId,characterId,personaId,workspace,taskId,sessionId=randomUUID(),permissionScope=['tools.list','tools.invoke'],connectionRefs=[],planState='execution',readOnlyToolNames=[],approvedPlanRevision=null},lease){return bridge.issueActiveContext({pluginId,characterId,personaId,workspace,taskId,sessionId,permissionScope,connectionRefs,planState,readOnlyToolNames,approvedPlanRevision},lease);},
    async exportTools(bindings){const exporter=await createDshMcpExport({bindings,onAudit:event=>audit({type:'mcp-tool',...event})});exports.set(exporter.sessionId,exporter);return exporter;},
    busy:()=>dependencyCoordinator.preparing()||componentChanging||inflight>0||taskToolBackends.size>0||bridge.busy(),
    // Theme or language changed: open plugin pages pick it up without reloading.
    async refreshAppearance(){await Promise.allSettled([clientHost.refreshAppearance(),workClientHost?.refreshAppearance()]);},
    async close(){if(closed)return;closed=true;await dependencyCoordinator.close();await ffmpegManager.close();await componentManager.close();clearInterval(socialTick);await Promise.all([...exports.values()].map(value=>value.close()).concat([...taskToolBackends].map(value=>value.close())));exports.clear();await Promise.allSettled([...workPreparations.values()]);await workClientHost?.close();for(const value of [...workBackends.values()])await value.backend.close();workBackends.clear();await community.close();await socialFacade.close();await socialBroker.close();await biliVision.close();await socialTransport.close();await socialLogin.close();socialAccounts.close();await clientHost.close();await bridge.close();},
  };
  return platform;
}
