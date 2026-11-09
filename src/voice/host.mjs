import {join} from 'node:path';
import {createVoiceRuntime} from './runtime.mjs';
import {createVoiceAssets} from './runtime-assets.mjs';
import {voiceComponentSummary} from './component-state.mjs';
import {createVoiceProfiles,voicePresetReceiptKey} from './voice-profiles.mjs';
import {createVoiceSettings,mergeVoiceSettings} from './settings.mjs';
import {createCloudVoiceGateway} from './cloud-host.mjs';
import {createVoiceCredentials} from './credentials.mjs';
import {createVoiceController} from './controller.mjs';
import {createVoiceCloud} from './cloud.mjs';
import {createSpeechRuntime} from './speech-runtime.mjs';
import {createCardSpeech} from './card-speech.mjs';
import {createManagedProcessSupervisor} from '../managed-process-supervisor.mjs';
import {sameVoiceScope} from './conversation.mjs';

const ids=['ai-buddy.voice-breeze','ai-buddy.voice-gpt-sovits'];
const fault=(message,code)=>Object.assign(Error(message),{code});
const engineFor=id=>id===ids[0]?'breeze':id===ids[1]?'gpt':null;
const selectionScopeFields=['characterId','lifeId','operationId','personaId','conversationId','channel'];
const plainSelection=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const selectionText=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\r\n\0]/.test(value);
const scopeChanged=()=>fault('角色、会话或声音档案已切换，请刷新音色列表后重试','VOICE_SCOPE_CHANGED');
const cloudSelectionChanged=()=>fault('云配音配置已改变，请刷新音色列表后重试','CLOUD_CONFIGURATION_CHANGED');
function expectedCloudSelection(value){
  if(!plainSelection(value)||Object.keys(value).some(key=>!['scope','profileId','profileVersion','cloudConnectionId'].includes(key))||
      !plainSelection(value.scope)||selectionScopeFields.some(key=>!Object.hasOwn(value.scope,key)||!selectionText(value.scope[key]))||
      Object.keys(value.scope).some(key=>!selectionScopeFields.includes(key))||!['app-private','app-group'].includes(value.scope.channel)||
      !selectionText(value.profileId)||!Number.isSafeInteger(value.profileVersion)||value.profileVersion<1)throw scopeChanged();
  if(!selectionText(value.cloudConnectionId))throw cloudSelectionChanged();
  return {scope:{...value.scope},profileId:value.profileId,profileVersion:value.profileVersion,cloudConnectionId:value.cloudConnectionId};
}
const cloudSelectionSignature=config=>JSON.stringify([config.enabled,config.selectedPackageId,config.packages?.[config.selectedPackageId],config.cloudConnections?.selectedId,
  config.cloudConnections?.items?.find(row=>row.id===config.cloudConnections.selectedId)]);
const publicConfig=value=>({...value,packages:Object.fromEntries(Object.entries(value.packages??{}).map(([id,{credentialRef,...row}])=>[id,{...row,credentialConfigured:!!credentialRef}])),...(value.cloudConnections?{cloudConnections:{selectedId:value.cloudConnections.selectedId,items:value.cloudConnections.items.map(({credentialRef,...row})=>({...row,configured:row.configured??!!credentialRef}))}}:{})});
const publicResult=value=>value&&typeof value==='object'?{...value,...(value.settings?{settings:publicConfig(value.settings)}:{}),...(value.schemaVersion&&value.packages?publicConfig(value):{})}:value;
export function trustedVoiceSender(event,panel){
  return !!panel&&!panel.isDestroyed()&&event.sender===panel.webContents&&event.senderFrame===panel.webContents.mainFrame;
}

/** The only renderer-facing voice gateway. Role/life/Persona come from the
 * companion service; neither a voice package nor an IPC payload supplies them. */
export function createVoiceHost({dataRoot,build,crypto,getGame,getPlatform,send=()=>{},chooseAssets,chooseReference,audit=()=>{},components={}}){
  const settings=components.settings??createVoiceSettings({dataRoot});
  const storedProfiles=components.profiles??createVoiceProfiles({dataRoot});
  const presetTasks=new Map(),presetPending=new Set(),presetResults=new Map();let presetsStarted=false,presetsClosed=false;
  function refreshPresetPackages(){
    presetsStarted=true;
    const platform=getPlatform();
    if(presetsClosed||!storedProfiles.ensureBundledPresets||!platform?.resolveVoicePresetPackage)return Promise.resolve([]);
    // Cache failures for one maintenance generation; persistent receipts keep their package identity.
    const tasks=[],rows=platform.voicePackageStatus()??[],taskKey=row=>JSON.stringify([...JSON.parse(voicePresetReceiptKey(row)),row.generation??0]);
    const current=new Set(rows.map(taskKey));
    for(const key of presetTasks.keys())if(!current.has(key)){presetTasks.delete(key);presetResults.delete(JSON.parse(key)[1]);}
    for(const row of rows){
      if(!row.installed||!['ready','disabled'].includes(row.state))continue;
      const key=taskKey(row),receiptKey=voicePresetReceiptKey(row);
      if(!presetTasks.has(key)){
        const publish=result=>{if(presetTasks.get(key)===task)presetResults.set(row.id,result);};
        const task=Promise.resolve().then(async()=>{
          if(presetsClosed)return;
          if(await storedProfiles.hasBundledPresets(receiptKey)){publish({state:'ready'});return;}
          const lease=await platform.resolveVoicePresetPackage(row.id),assertCurrent=lease.assertCurrent;
          lease.assertCurrent=()=>{if(presetsClosed)throw fault('语音预制声线导入已取消','VOICE_PACKAGE_CHANGED');assertCurrent();};
          const result=await storedProfiles.ensureBundledPresets({lease,receiptKey});
          publish({state:result.missing?'not-provided':'ready'});
        }).catch(error=>{publish({state:'failed',code:error.code??'VOICE_PRESET_INVALID'});audit({type:'voice-presets',packageId:row.id,code:error.code??'VOICE_PRESET_INVALID'});});
        presetTasks.set(key,task);presetPending.add(task);void task.then(()=>presetPending.delete(task),()=>presetPending.delete(task));
      }
      tasks.push(presetTasks.get(key));
    }
    return Promise.all(tasks);
  }
  async function waitForPresets(engine,{start=true}={}){
    if(start&&!presetsStarted)refreshPresetPackages();
    const id=ids.find(id=>engineFor(id)===engine);
    // Await only already scheduled work. State polling and synthesis never scan packages.
    await Promise.all([...presetTasks].filter(([key])=>!id||JSON.parse(key)[1]===id).map(([,task])=>task));
  }
  const profiles={...storedProfiles,...Object.fromEntries(['list','selectedProfiles','current','resolve'].filter(op=>typeof storedProfiles[op]==='function').map(op=>[op,async params=>{await waitForPresets(params?.engine,{start:op!=='selectedProfiles'});return storedProfiles[op](params);}]))};
  const credentials=components.credentials??createVoiceCredentials({dataRoot,crypto});
  const supervisor=components.supervisor??createManagedProcessSupervisor({guardPath:join(build,'managed-process-guard.exe'),statePath:join(dataRoot,'voice','processes.json'),onState:value=>audit({type:'voice-process',...value})});
  const resolvePackage=(...args)=>getPlatform().resolveVoicePackage(...args);
  const assets=components.assets??createVoiceAssets({dataRoot,resolveVoicePackage:resolvePackage,verificationWorker:join(build,'voice-assets-worker.cjs')});
  const local=components.local??createVoiceRuntime({resolveAssets:async(kind,id,options)=>assets.resolve(kind,id??(await settings.get()).selectedPackageId,options),resolveProfile:params=>profiles.resolve(params),supervisor});
  const cloud=components.cloud??createVoiceCloud({dataRoot,supervisor,
    resolveRuntime:async({packageId})=>{await resolvePackage(packageId,{provider:'minimax'});const value=await assets.resolve('asr',packageId);return {...value,script:join(value.sharedDirectory,'cloud_speech.py')};},
    resolveProfile:params=>profiles.resolve(params),
    resolveConnection:async({packageId})=>{if(settings.resolveConnection)return settings.resolveConnection({packageId});const config=await settings.get(),row=config.packages[packageId];if(!row?.credentialRef)throw fault('请填写 MiniMax API Key','VOICE_CREDENTIAL_MISSING');return {provider:'minimax',model:'speech-2.8-turbo',keyRef:row.credentialRef};},
    resolveSecret:ref=>credentials.resolve(ref),
  });
  const runtime=components.runtime??createSpeechRuntime({local,cloud});
  const chatRuntime=runtime.channel?.('chat')??runtime,cardRuntime=runtime.channel?.('card-table')??runtime;
  let microphone=false,closed=false,cardEpoch=0,cardAdmissions=0,cardTail=Promise.resolve(),voiceEpoch=0,stopping=null,stopFailure,cloudGateway;
  let assetOperation,assetEpoch=0,assetProgress=null;
  const cloudOperations=new Set();
  const tableHands=new Map();
  const publish=raw=>{
    const value=raw?.state&&typeof raw.state==='object'?{...raw,state:{...publicResult(raw.state),assetProgress}}:raw;
    if(value.type==='phase'){
      // Persist only request correlation and bounded phase metadata. Never log
      // the speech, reference transcript/path, credentials or complete envelope.
      audit({type:'voice-phase',requestId:value.requestId,segmentId:value.segmentId,index:value.index,
        engine:value.engine,stage:value.stage,elapsedMs:value.elapsedMs,...(value.code?{code:value.code}:{})});
    }
    if(value.type==='capture')microphone=['recording','listening'].includes(value.state);
    if(value.type==='invalidate'){microphone=false;getGame()?.voiceCancel?.();if(value.reason==='scope-changed'){cloudGateway?.invalidateState();}if(value.reason==='scope-changed')void cards.reconcile?.().catch(error=>audit({type:'card-voice',code:error.code}));}
    send(value);
  };
  const controller=components.controller??createVoiceController({getScope:()=>getGame()?.voiceScope(),submit:args=>getGame().voiceSubmit(args),send:publish,
    listPackages:()=>getPlatform()?.voicePackageStatus()??[],runtime:chatRuntime,assets,profiles,settings});
  async function cardSelection(){
    if(closed)throw fault('语音服务已关闭','VOICE_HOST_CLOSED');
    const config=await settings.get(),packageId=config.selectedPackageId,engine=engineFor(packageId);
    const row=(getPlatform()?.voicePackageStatus()??[]).find(value=>value.id===packageId);
    if(!config.enabled||!engine||!row?.installed||!row.enabled||!row.usable||row.trusted===false)throw fault('语音插件尚未启用','VOICE_PACKAGE_UNAVAILABLE');
    const options=config.packages[packageId];
    return {config,packageId,engine,options,proof:JSON.stringify([packageId,row.sourceId,row.version,row.archiveSha256,options])};
  }
  const cards=components.cards??createCardSpeech({dataRoot,emit:send,
    isScopeValid:async scope=>{try{await cardSelection();return getPlatform()?.cardGames?.voiceScopeValid(scope)===true;}catch{return false;}},
    resolveVoice:async scope=>{
      const selected=await cardSelection(),{packageId,engine,options}=selected;
      const lease=await resolvePackage(packageId,{provider:options.ttsProvider});
      const profile=await profiles.current({characterId:scope.characterId,engine});
      if(!profile||profile.characterId!==scope.characterId||profile.engine!==engine)throw fault('当前发言角色尚未配置声线','VOICE_PROFILE_SCOPE');
      const request={runtime:cardRuntime,packageId,engine,profileId:profile.id,profileVersion:profile.version,speechProvider:options.ttsProvider,credentialRef:options.credentialRef};
      if(options.ttsProvider==='minimax'){const readiness=await cardRuntime.ready({...request,characterId:scope.characterId});if(readiness?.ready!==true)throw fault(readiness?.message??'当前角色的云声线尚未准备',readiness?.code??'VOICE_CLOUD_VOICE_PENDING');}
      return {...request,async assertCurrent(){
        lease.assertCurrent?.();
        if((await cardSelection()).proof!==selected.proof)throw fault('语音配置已改变','VOICE_PACKAGE_CHANGED');
        const current=await profiles.current({characterId:scope.characterId,engine});
        if(current?.id!==profile.id||current?.version!==profile.version)throw fault('角色声线已改变','VOICE_PROFILE_CHANGED');
      }};
    },
  });
  async function stopCards(reason){cardEpoch++;if(reason==='user-stop')await cards.recoverStop?.();await cards.invalidate(reason);await cardRuntime.stopEngine?.();}
  function assertVoiceOpen(generation=voiceEpoch){
    if(closed)throw fault('语音服务已关闭','VOICE_HOST_CLOSED');
    if(stopFailure)throw stopFailure;
    if(stopping)throw fault('语音正在停止','VOICE_STOPPING');
    if(generation!==voiceEpoch)throw fault('旧语音操作已撤销','VOICE_ACTION_REVOKED');
  }
  function trackCloud(generation,ctx,run){
    const task=Promise.resolve().then(()=>{assertVoiceOpen(generation);assertCurrent(ctx);return run();});
    cloudOperations.add(task);void task.finally(()=>cloudOperations.delete(task)).catch(()=>{});return task;
  }
  function stopAll(reason){
    voiceEpoch++;microphone=false;cardEpoch++;getGame()?.voiceCancel?.();
    const pendingAssets=cancelAssets(reason);
    if(stopping)return stopping;
    const pending=[...cloudOperations];
    const task=(async()=>{
      await Promise.all([cards.recoverStop?.(),controller.recoverStop?.()]);
      // Cloud preparation/list/binding has no speech owner. Stop the shared root too.
      const results=await Promise.allSettled([controller.invalidate(reason),stopCards(reason),runtime.stopEngine?.()]);
      // The operation writes its failure receipt before maintenance may change registry state.
      await Promise.allSettled([...pending,pendingAssets]);
      const failed=results.find(value=>value.status==='rejected');if(failed){stopFailure=failed.reason;throw stopFailure;}
      stopFailure=undefined;
    })();
    stopping=task;void task.finally(()=>{if(stopping===task)stopping=null;}).catch(()=>{});return task;
  }
  function publishAssets(value,row){
    if(row&&(assetOperation!==row||row.controller.signal.aborted||row.generation!==assetEpoch))return;
    assetProgress=value;publish({type:'asset-progress',...(value??{state:'idle'})});
  }
  function cancelAssets(reason='user-cancel'){
    assetEpoch++;const row=assetOperation;
    if(row){row.controller.abort(fault('组件准备已取消','VOICE_ASSET_CANCELLED'));publishAssets({...assetProgress,state:'cancelled',reason});}
    return row?.task;
  }
  const assetIdentity=(config,packageId=config.selectedPackageId)=>{
    const row=(getPlatform()?.voicePackageStatus()??[]).find(value=>value.id===packageId);
    return JSON.stringify([config.enabled,config.selectedPackageId,packageId,config.packages[packageId]?.ttsProvider,row?.sourceId,row?.version,row?.archiveSha256,row?.installed,row?.enabled,row?.usable,row?.trusted]);
  };
  async function checkAssetSelection(row){
    if(closed||row.generation!==assetEpoch||row.controller.signal.aborted)throw fault('组件准备已取消','VOICE_ASSET_CANCELLED');
    const config=await settings.get();
    if(closed||row.generation!==assetEpoch||row.controller.signal.aborted||assetIdentity(config,row.engineId)!==row.identity)throw fault('组件准备已取消','VOICE_ASSET_CANCELLED');
    return config;
  }
  async function prepareAssets({kind,packageId,importLocal=false,verifyOnly=false,forceDownload=false}={}){
    if(assetOperation)throw fault('语音组件正在准备','VOICE_ASSET_BUSY');
    const generation=assetEpoch,config=await settings.get();
    if(closed||generation!==assetEpoch) return {cancelled:true};
    if(assetOperation)throw fault('语音组件正在准备','VOICE_ASSET_BUSY');
    const engineId=packageId??config.selectedPackageId,engine=engineFor(engineId),provider=config.packages[engineId]?.ttsProvider??'local';
    const selected=(getPlatform()?.voicePackageStatus()??[]).find(row=>row.id===engineId);
    if(!engine||!selected?.installed||!selected.enabled||!selected.usable||selected.trusted===false)throw fault('选中的语音插件未安装、已停用或未通过校验','VOICE_PACKAGE_UNAVAILABLE');
    if(kind&&(!['asr',engine].includes(kind)||provider==='minimax'&&kind!=='asr'))throw fault('组件与所选插件不匹配','VOICE_ASSET_INVALID');
    const row=assetOperation={generation,identity:assetIdentity(config,engineId),engineId,provider,controller:new AbortController()};
    const operation=verifyOnly?'verify':importLocal?'import':'download';
    publishAssets({state:'preparing',phase:'checking',operation,engineId,provider,...(kind?{kind}:{})},row);
    row.task=(async()=>{
      try{
        let localRoot;
        if(importLocal){localRoot=await chooseAssets?.(kind);await checkAssetSelection(row);if(!localRoot){publishAssets({state:'cancelled',engineId,provider},row);return {cancelled:true};}}
        await checkAssetSelection(row);
        const onProgress=value=>publishAssets({engineId,provider,operation,...value},row);
        const result=kind?await assets.prepare(kind,{engineId,...(localRoot?{localRoot}:{}),verifyOnly,forceDownload,signal:row.controller.signal,onProgress}):await assets.prepareSelected({engineId,provider,signal:row.controller.signal,onProgress});
        await checkAssetSelection(row);publishAssets({state:'ready',engineId,provider,operation,...(kind?{kind}:{})},row);return result;
      }catch(error){
        if(row.controller.signal.aborted||row.generation!==assetEpoch||closed||['VOICE_ASSET_CANCELLED','ABORT_ERR'].includes(error.code)||error.name==='AbortError'){
          if(assetOperation===row)publishAssets({state:'cancelled',engineId,provider});return {cancelled:true};
        }
        publishAssets({state:'failed',engineId,provider,operation,...(kind?{kind}:{}),code:error.code??'VOICE_ASSET_FAILED',message:verifyOnly?'校验没通过，请重新下载':String(error.message)},row);throw verifyOnly?fault('校验没通过，请重新下载','VOICE_ASSET_VERIFY_FAILED'):error;
      }finally{if(assetOperation===row)assetOperation=undefined;}
    })();return row.task;
  }
  async function prepareSelectedVoice(target='speech'){
    const generation=voiceEpoch,assetGeneration=assetEpoch,config=await settings.get(),identity=assetIdentity(config);
    assertVoiceOpen(generation);
    if(assetGeneration!==assetEpoch)return {cancelled:true};
    if(!config.enabled)throw fault('语音尚未启用','VOICE_DISABLED');
    const result=await prepareAssets();
    if(result?.cancelled||closed||generation!==voiceEpoch||assetGeneration!==assetEpoch)return {cancelled:true};
    const checked=await settings.get();
    if(closed||generation!==voiceEpoch||assetGeneration!==assetEpoch||assetIdentity(checked)!==identity)return {cancelled:true};
    assertVoiceOpen(generation);return publicResult(await controller.action('prepare',{target}));
  }
  function cardEvent(request){
    if(request?.type!=='scope-update')try{assertVoiceOpen();}catch(error){return Promise.reject(error);}
    const generation=cardEpoch;cardAdmissions++;
    const job=cardTail.then(async()=>{
      if(closed||generation!==cardEpoch)return {accepted:false,reason:'revoked'};
      if(request?.type==='scope-update'){
        const old=tableHands.get(request.tableId);tableHands.set(request.tableId,request.handId);
        if(tableHands.size>64)tableHands.delete(tableHands.keys().next().value);
        if(old&&old!==request.handId||!['active','completed'].includes(request.status)){
          // This lifecycle fact and the immediately following new-hand facts
          // share the same admission generation; only revoke prior audio here.
          await cards.invalidate('table-scope-changed');
        }
        return {accepted:false,reason:'scope-update'};
      }
      await cardSelection();
      if(closed||generation!==cardEpoch)return {accepted:false,reason:'revoked'};
      if(Number.isFinite(request?.deadlineAt)&&Date.now()>=request.deadlineAt)return {accepted:false,reason:'display-timeout'};
      const result=await cards.accept(request);
      if(result?.accepted===false&&!result.duplicate&&['queue-full','stop-failed'].includes(result.reason))publish({type:'status',channel:'card-table',state:'failed',requestId:'card:'+request.eventId,code:result.reason==='queue-full'?'VOICE_CARD_QUEUE_FULL':'VOICE_CARD_STOP_FAILED',message:result.reason==='queue-full'?'牌桌配音队列已满，本句未播放':'配音释放尚未完成，请点停止并释放后重试'});
      return result;
    });
    cardTail=job.catch(()=>{});void job.finally(()=>{cardAdmissions--;}).catch(()=>{});return job;
  }
  async function context(expected){
    const scope=getGame()?.voiceScope(),config=await settings.get(),packageId=config.selectedPackageId,engine=engineFor(packageId);
    if(expected&&!sameVoiceScope(scope,expected.scope))throw scopeChanged();
    if(expected&&(!engine||config.cloudConnections?.selectedId!==expected.cloudConnectionId))throw cloudSelectionChanged();
    if(!scope||!engine)throw fault('请先打开角色聊天','VOICE_SCOPE_CHANGED');
    await resolvePackage(packageId,{provider:'minimax'});
    const profile=await profiles.current({characterId:scope.characterId,engine});
    if(!profile)throw expected?scopeChanged():fault('请先导入当前角色声音参考','VOICE_PROFILE_SCOPE');
    return {ctx:{...scope,packageId,engine,profileId:profile.id,profileVersion:profile.version},config};
  }
  function assertCurrent(scope){if(!sameVoiceScope(scope,getGame()?.voiceScope()))throw fault('角色或会话已切换，旧操作未应用','VOICE_SCOPE_CHANGED');}
  async function assertExpectedSelection(ctx,expected,generation,capturedConfig){
    assertVoiceOpen(generation);assertCurrent(ctx);
    if(!sameVoiceScope(expected.scope,ctx)||expected.profileId!==ctx.profileId||expected.profileVersion!==ctx.profileVersion)throw scopeChanged();
    const signature=cloudSelectionSignature(capturedConfig);
    const checkConfig=config=>{if(config.selectedPackageId!==ctx.packageId||config.cloudConnections?.selectedId!==expected.cloudConnectionId||cloudSelectionSignature(config)!==signature)throw cloudSelectionChanged();};
    checkConfig(await settings.get());assertVoiceOpen(generation);assertCurrent(ctx);
    const profile=await profiles.current({characterId:ctx.characterId,engine:ctx.engine});
    assertVoiceOpen(generation);assertCurrent(ctx);
    if(profile?.id!==expected.profileId||profile?.version!==expected.profileVersion||profile?.characterId!==ctx.characterId||profile?.engine!==ctx.engine)throw scopeChanged();
    checkConfig(await settings.get());assertVoiceOpen(generation);assertCurrent(ctx);
  }
  async function mirrorBinding(ctx,result,generation,checkCurrent){
    if(!result?.voiceId)return result;
    try{
      // The first binding already committed; cancellation fences only the optional mirror.
      assertVoiceOpen(generation);assertCurrent(ctx);await checkCurrent?.();
      const first=await profiles.resolve(ctx),otherId=ids.find(id=>id!==ctx.packageId),engine=engineFor(otherId);
      assertVoiceOpen(generation);assertCurrent(ctx);await checkCurrent?.();
      const other=await profiles.current({characterId:ctx.characterId,engine});
      assertVoiceOpen(generation);assertCurrent(ctx);await checkCurrent?.();
      if(!other)return result;
      const request={...ctx,packageId:otherId,engine,profileId:other.id,profileVersion:other.version};
      const ref=await profiles.resolve(request);
      assertVoiceOpen(generation);assertCurrent(ctx);await checkCurrent?.();
      if(first.cloudReference.sha256!==ref.cloudReference.sha256)return result;
      await resolvePackage(otherId,{provider:'minimax'});assertVoiceOpen(generation);assertCurrent(ctx);await checkCurrent?.();
      const checkMirror=checkCurrent?async()=>{await checkCurrent();const current=await profiles.current({characterId:ctx.characterId,engine});if(current?.id!==other.id||current?.version!==other.version)throw scopeChanged();await checkCurrent();}:undefined;
      await cloud.bindVoice({...request,voiceId:result.voiceId},{checkCurrent:checkMirror});return {...result,sharedWithOtherPlugin:true};
    }
    catch(error){return {...result,sharedWithOtherPlugin:false,otherPluginCode:error.code??'VOICE_CLOUD_BIND_PENDING'};}
  }
  cloudGateway=createCloudVoiceGateway({settings,profiles,credentials,cloud,getGame,resolvePackage,publish,assertOpen:()=>{assertVoiceOpen();return voiceEpoch;},stopAll,track:task=>{cloudOperations.add(task);void task.finally(()=>cloudOperations.delete(task)).catch(()=>{});return task;}});
  async function componentStatus(packageId){
    const engine=engineFor(packageId),installed=(getPlatform()?.voicePackageStatus()??[]).find(row=>row.id===packageId);
    if(!engine||!installed?.installed)throw fault('选中的语音插件未安装、已停用或未通过校验','VOICE_PACKAGE_UNAVAILABLE');
    const config=await settings.get(),provider=config.packages[packageId]?.ttsProvider??'local';
    const [asr,tts]=await Promise.all([assets.status('asr',packageId),provider==='minimax'?{state:'not-required'}:assets.status(engine,packageId)]);
    return voiceComponentSummary({asr,tts});
  }
  async function action(op,payload={}){
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fault('语音参数无效','VOICE_ACTION_INVALID');
    if(op==='component-status'){
      if(Object.keys(payload).some(key=>key!=='packageId'))throw fault('语音参数无效','VOICE_ACTION_INVALID');
      return componentStatus(payload.packageId);
    }
    if(['characterId','personaId','lifeId','operationId','conversationId','engine',...(!['profiles','profile-select','profile-selections','assets-prepare','assets-import','assets-verify'].includes(op)?['packageId']:[])].some(key=>Object.hasOwn(payload,key)))throw fault('语音身份只能由宿主指定','VOICE_SCOPE_FORGED');
    if(op==='stop'){
      if(payload.channel==='card-table')return stopCards('user-stop');
      if(payload.channel==='app-chat'){const pendingAssets=cancelAssets('user-stop');getGame()?.voiceCancel?.();await controller.recoverStop?.();await Promise.all([controller.invalidate('user-stop'),pendingAssets]);return;}
      if(payload.channel!=null)throw fault('未知语音频道','VOICE_ACTION_INVALID');
      return stopAll('user-stop');
    }
    if(op==='receipt'){
      if(payload.envelope?.channel==='card-table')return cards.receipt(payload);
      const accepted=await getGame().voiceReceipt(payload);
      if(accepted?.accepted)await controller.action('receipt',payload);
      return accepted;
    }
    if(op==='state'){
      const value=await controller.state(),scope=getGame()?.voiceScope(),engine=value.engine;
      const profile=scope&&engine?await profiles.current({characterId:scope.characterId,engine}):null;
      let cloudState={state:'not-selected'};
      if(value.speechProvider==='minimax'&&scope&&profile)cloudState=await cloud.status({...scope,engine,packageId:value.selectedPackageId,profileId:profile.id,profileVersion:profile.version});
      return {...publicResult(value),profile,cloud:cloudState,...await cloudGateway.state(),assetProgress,presetPackages:Object.fromEntries(presetResults)};
    }
    if(op==='assets-cancel'){await Promise.allSettled([cancelAssets()]);return {cancelled:true};}
    if(cloudGateway.handles(op))return cloudGateway.action(op,payload);
    assertVoiceOpen();
    if(op==='save-key'){
      await stopAll('credential-changed');
      const saved=await credentials.save(payload.key);
      await settings.update({packages:Object.fromEntries(ids.map(id=>[id,{credentialRef:saved.ref}]))});
      cloudGateway.invalidateState();return {configured:true};
    }
    if(op==='assets-prepare'||op==='assets-import'||op==='assets-verify'){
      if(!['asr','breeze','gpt'].includes(payload.kind))throw fault('未知语音组件','VOICE_ASSET_INVALID');
      const config=await settings.get(),packageId=payload.packageId??config.selectedPackageId;
      if(!engineFor(packageId)||(getPlatform()?.voicePackageStatus()??[]).find(row=>row.id===packageId)?.installed!==true)throw fault('选中的语音插件未安装、已停用或未通过校验','VOICE_PACKAGE_UNAVAILABLE');
      if(packageId===config.selectedPackageId||payload.kind==='asr')await stopAll('component-preparing');
      assertVoiceOpen();return prepareAssets({kind:payload.kind,packageId,importLocal:op==='assets-import',verifyOnly:op==='assets-verify',forceDownload:op!=='assets-verify'});
    }
    if(op==='prepare')return prepareSelectedVoice(payload.target);
    if(op==='profile-import'){
      const scope=getGame()?.voiceScope(),config=await settings.get(),engine=engineFor(config.selectedPackageId);
      if(!scope)throw fault('请先打开角色聊天','VOICE_SCOPE_CHANGED');
      const reference=await chooseReference?.(payload);
      if(!reference)return {cancelled:true};
      assertCurrent(scope);await stopAll('profile-import');
      const imported=await profiles.importProfile({characterId:scope.characterId,engine,label:payload.label||'我的声音',references:{calm:{...reference,text:payload.text,language:'zh'}}});cloudGateway.invalidateState();return imported;
    }
    if(op==='cloud-status'||op==='cloud-voices'||op==='cloud-bind'||op==='cloud-prepare'||op==='cloud-prepare-preview'){
      let generation=voiceEpoch;
      const expected=['cloud-voices','cloud-bind'].includes(op)&&Object.hasOwn(payload,'expectedSelection')?expectedCloudSelection(payload.expectedSelection):undefined;
      const {ctx,config}=await context(expected);assertVoiceOpen(generation);assertCurrent(ctx);
      const checkCurrent=expected?()=>assertExpectedSelection(ctx,expected,generation,config):undefined;
      await checkCurrent?.();
      if(op==='cloud-status')return cloud.status(ctx);
      if(op==='cloud-voices')return trackCloud(generation,ctx,async()=>{await checkCurrent?.();const result=await cloud.listVoices(ctx,{checkCurrent});assertVoiceOpen(generation);assertCurrent(ctx);await checkCurrent?.();return result;});
      if(op==='cloud-prepare-preview')return cloud.previewPlan(ctx);
      generation++;
      await stopAll('cloud-voice-changing');assertVoiceOpen(generation);assertCurrent(ctx);await checkCurrent?.();
      if(op==='cloud-prepare'&&payload.consentUpload!==true)throw fault('上传参考音前需要你主动确认','CLOUD_UPLOAD_CONSENT');
      return trackCloud(generation,ctx,async()=>{
        await checkCurrent?.();
        const result=op==='cloud-bind'?await cloud.bindVoice({...ctx,voiceId:payload.voiceId},{checkCurrent}):await cloud.prepareVoice({...ctx,consentUpload:true});
        assertCurrent(ctx);await checkCurrent?.();return mirrorBinding(ctx,result,generation,checkCurrent);
      });
    }
    const activeProfileSelection=op==='profile-select'&&(payload.packageId==null||payload.packageId===(await settings.get()).selectedPackageId);
    if(op==='configure'){
      if(Object.hasOwn(payload,'cloudConnections')||Object.values(payload.packages??{}).some(row=>row&&Object.hasOwn(row,'credentialRef')))throw fault('云配音配置和密钥引用只能通过配置管理器修改','VOICE_SCOPE_FORGED');
      const current=await settings.get(),next=mergeVoiceSettings(current,payload),signature=value=>JSON.stringify([value.enabled,value.selectedPackageId,value.packages[value.selectedPackageId]?.ttsProvider,value.packages[value.selectedPackageId]?.credentialRef]);
      if(signature(current)!==signature(next)){const generation=voiceEpoch+1;await stopAll('configuration-changed');assertVoiceOpen(generation);}
    }else if(activeProfileSelection){if(cloudOperations.size)await stopAll('profile-changed');else{cardEpoch++;await cards.invalidate('profile-changed');}}
    const generation=voiceEpoch,result=await controller.action(op,payload);if(op==='configure'||activeProfileSelection)cloudGateway.invalidateState();
    if(op==='configure'&&result.enabled){if(closed||generation!==voiceEpoch)return {cancelled:true};await prepareSelectedVoice('speech');}
    return op==='profiles'?result:publicResult(result);
  }
  async function cardPresentation(request){
    let available=true;try{assertVoiceOpen();await cardSelection();}catch{available=false;}
    return {available,...cards.presentation?.(request)};
  }
  return {action,controller,assets,profiles,settings,runtime,cloud,cardEvent,cardPresentation,refreshPresetPackages,componentStatus,
    busy:()=>!!stopping||!!stopFailure||!!assetOperation||cloudOperations.size>0||cardAdmissions>0||cards.busy()||controller.busy?.()===true,
    microphoneAllowed:()=>microphone,
    snapshot:()=>({microphoneAuthorized:microphone,cardSpeechBusy:cards.busy()}),
    quiesce:()=>stopAll('package-maintenance'),
    async close(){try{presetsClosed=true;closed=true;voiceEpoch++;microphone=false;cardEpoch++;const pendingAssets=cancelAssets('closed');await Promise.allSettled(presetPending);await runtime.stopEngine?.();await Promise.allSettled([...cloudOperations,pendingAssets]);await cardTail;const results=await Promise.allSettled([cards.close(),controller.close()]);const failed=results.find(value=>value.status==='rejected');if(failed)throw failed.reason;await runtime.close?.();await supervisor.close();}finally{await assets.close?.();}},
  };
}
