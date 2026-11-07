import {join} from 'node:path';
import {createVoiceRuntime} from './runtime.mjs';
import {createVoiceAssets} from './runtime-assets.mjs';
import {createVoiceProfiles} from './voice-profiles.mjs';
import {createVoiceSettings} from './settings.mjs';
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
export function trustedVoiceSender(event,panel){
  return !!panel&&!panel.isDestroyed()&&event.sender===panel.webContents&&event.senderFrame===panel.webContents.mainFrame;
}

/** The only renderer-facing voice gateway. Role/life/Persona come from the
 * companion service; neither a voice package nor an IPC payload supplies them. */
export function createVoiceHost({dataRoot,build,crypto,getGame,getPlatform,send=()=>{},chooseAssets,chooseReference,audit=()=>{},components={}}){
  const settings=components.settings??createVoiceSettings({dataRoot});
  const profiles=components.profiles??createVoiceProfiles({dataRoot});
  const credentials=components.credentials??createVoiceCredentials({dataRoot,crypto});
  const supervisor=components.supervisor??createManagedProcessSupervisor({guardPath:join(build,'managed-process-guard.exe'),statePath:join(dataRoot,'voice','processes.json'),onState:value=>audit({type:'voice-process',...value})});
  const resolvePackage=(...args)=>getPlatform().resolveVoicePackage(...args);
  const assets=components.assets??createVoiceAssets({dataRoot,resolveVoicePackage:resolvePackage});
  const local=components.local??createVoiceRuntime({resolveAssets:async(kind,id)=>assets.resolve(kind,id??(await settings.get()).selectedPackageId),resolveProfile:params=>profiles.resolve(params),supervisor});
  const cloud=components.cloud??createVoiceCloud({dataRoot,supervisor,
    resolveRuntime:async({packageId})=>{await resolvePackage(packageId,{provider:'minimax'});const value=await assets.resolve('asr',packageId);return {...value,script:join(value.sharedDirectory,'cloud_speech.py')};},
    resolveProfile:params=>profiles.resolve(params),
    resolveConnection:async({packageId})=>{const config=await settings.get(),row=config.packages[packageId];if(!row?.credentialRef)throw fault('请填写 MiniMax API Key','VOICE_CREDENTIAL_MISSING');return {provider:'minimax',model:'speech-2.8-turbo',keyRef:row.credentialRef};},
    resolveSecret:ref=>credentials.resolve(ref),
  });
  const runtime=components.runtime??createSpeechRuntime({local,cloud});
  const chatRuntime=runtime.channel?.('chat')??runtime,cardRuntime=runtime.channel?.('card-table')??runtime;
  let microphone=false,closed=false,cardEpoch=0,cardAdmissions=0,cardTail=Promise.resolve(),voiceEpoch=0,stopping=null,stopFailure;
  const cloudOperations=new Set();
  const tableHands=new Map();
  const publish=value=>{if(value.type==='capture')microphone=['recording','listening'].includes(value.state);if(value.type==='invalidate'){microphone=false;getGame()?.voiceCancel?.();if(value.reason==='scope-changed')void cards.reconcile?.().catch(error=>audit({type:'card-voice',code:error.code}));}send(value);};
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
      if(options.ttsProvider==='minimax'&&(await cardRuntime.ready({...request,characterId:scope.characterId}))?.ready!==true)throw fault('当前角色的云声线尚未准备','VOICE_CLOUD_VOICE_PENDING');
      return {...request,async assertCurrent(){
        lease.assertCurrent?.();
        if((await cardSelection()).proof!==selected.proof)throw fault('语音配置已改变','VOICE_PACKAGE_CHANGED');
        const current=await profiles.current({characterId:scope.characterId,engine});
        if(current?.id!==profile.id||current?.version!==profile.version)throw fault('角色声线已改变','VOICE_PROFILE_CHANGED');
      }};
    },
  });
  async function stopCards(reason){cardEpoch++;await cards.invalidate(reason);await cardRuntime.stopEngine?.();}
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
    if(stopping)return stopping;
    const pending=[...cloudOperations];
    const task=(async()=>{
      // Cloud preparation/list/binding has no speech owner. Stop the shared root too.
      const results=await Promise.allSettled([controller.invalidate(reason),stopCards(reason),runtime.stopEngine?.()]);
      // The operation writes its failure receipt before maintenance may change registry state.
      await Promise.allSettled(pending);
      const failed=results.find(value=>value.status==='rejected');if(failed){stopFailure=failed.reason;throw stopFailure;}
    })();
    stopping=task;void task.finally(()=>{if(stopping===task)stopping=null;}).catch(()=>{});return task;
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
          await cards.invalidate('table-scope-changed');await cardRuntime.stopEngine?.();
        }
        return {accepted:false,reason:'scope-update'};
      }
      await cardSelection();
      if(closed||generation!==cardEpoch)return {accepted:false,reason:'revoked'};
      return cards.accept(request);
    });
    cardTail=job.catch(()=>{});void job.finally(()=>{cardAdmissions--;}).catch(()=>{});return job;
  }
  async function context(){
    const scope=getGame()?.voiceScope(),config=await settings.get(),packageId=config.selectedPackageId,engine=engineFor(packageId);
    if(!scope||!engine)throw fault('请先打开角色聊天','VOICE_SCOPE_CHANGED');
    await resolvePackage(packageId,{provider:'minimax'});
    const profile=await profiles.current({characterId:scope.characterId,engine});
    if(!profile)throw fault('请先导入当前角色声音参考','VOICE_PROFILE_SCOPE');
    return {...scope,packageId,engine,profileId:profile.id,profileVersion:profile.version};
  }
  function assertCurrent(scope){if(!sameVoiceScope(scope,getGame()?.voiceScope()))throw fault('角色或会话已切换，旧操作未应用','VOICE_SCOPE_CHANGED');}
  async function mirrorBinding(ctx,result,generation){
    if(!result?.voiceId)return result;
    try{
      // The first binding already committed; cancellation fences only the optional mirror.
      assertVoiceOpen(generation);assertCurrent(ctx);
      const first=await profiles.resolve(ctx),otherId=ids.find(id=>id!==ctx.packageId),engine=engineFor(otherId);
      assertVoiceOpen(generation);assertCurrent(ctx);
      const other=await profiles.current({characterId:ctx.characterId,engine});
      assertVoiceOpen(generation);assertCurrent(ctx);
      if(!other)return result;
      const request={...ctx,packageId:otherId,engine,profileId:other.id,profileVersion:other.version};
      const ref=await profiles.resolve(request);
      assertVoiceOpen(generation);assertCurrent(ctx);
      if(first.cloudReference.sha256!==ref.cloudReference.sha256)return result;
      await resolvePackage(otherId,{provider:'minimax'});assertVoiceOpen(generation);assertCurrent(ctx);
      await cloud.bindVoice({...request,voiceId:result.voiceId});return {...result,sharedWithOtherPlugin:true};
    }
    catch(error){return {...result,sharedWithOtherPlugin:false,otherPluginCode:error.code??'VOICE_CLOUD_BIND_PENDING'};}
  }
  async function action(op,payload={}){
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fault('语音参数无效','VOICE_ACTION_INVALID');
    if(['characterId','personaId','lifeId','operationId','conversationId','engine','packageId'].some(key=>Object.hasOwn(payload,key)))throw fault('语音身份只能由宿主指定','VOICE_SCOPE_FORGED');
    if(op==='stop'){
      if(payload.channel==='card-table')return stopCards('user-stop');
      if(payload.channel==='app-chat'){getGame()?.voiceCancel?.();return controller.invalidate('user-stop');}
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
      return {...value,profile,cloud:cloudState};
    }
    assertVoiceOpen();
    if(op==='save-key'){
      await stopAll('credential-changed');
      const saved=await credentials.save(payload.key);
      await settings.update({packages:Object.fromEntries(ids.map(id=>[id,{credentialRef:saved.ref}]))});
      return {configured:true};
    }
    if(op==='assets-prepare'){
      if(!['asr','breeze','gpt'].includes(payload.kind))throw fault('未知语音组件','VOICE_ASSET_INVALID');
      await stopAll('component-preparing');
      const config=await settings.get(),packageId=config.selectedPackageId;
      if(payload.kind!=='asr'&&payload.kind!==engineFor(packageId))throw fault('组件与所选插件不匹配','VOICE_ASSET_INVALID');
      const localRoot=await chooseAssets?.(payload.kind);
      if(!localRoot)return {cancelled:true};
      return assets.prepare(payload.kind,{engineId:packageId,localRoot,onProgress:value=>publish({type:'asset-progress',kind:payload.kind,...value})});
    }
    if(op==='profile-import'){
      const scope=getGame()?.voiceScope(),config=await settings.get(),engine=engineFor(config.selectedPackageId);
      if(!scope)throw fault('请先打开角色聊天','VOICE_SCOPE_CHANGED');
      const reference=await chooseReference?.(payload);
      if(!reference)return {cancelled:true};
      assertCurrent(scope);await stopAll('profile-import');
      return profiles.importProfile({characterId:scope.characterId,engine,label:payload.label||'我的声音',references:{calm:{...reference,text:payload.text,language:'zh'}}});
    }
    if(op==='cloud-status'||op==='cloud-voices'||op==='cloud-bind'||op==='cloud-prepare'||op==='cloud-prepare-preview'){
      let generation=voiceEpoch;
      const ctx=await context();assertVoiceOpen(generation);assertCurrent(ctx);
      if(op==='cloud-status')return cloud.status(ctx);
      if(op==='cloud-voices')return trackCloud(generation,ctx,async()=>{const result=await cloud.listVoices(ctx);assertVoiceOpen(generation);assertCurrent(ctx);return result;});
      if(op==='cloud-prepare-preview')return cloud.previewPlan(ctx);
      generation++;
      await stopAll('cloud-voice-changing');assertVoiceOpen(generation);assertCurrent(ctx);
      if(op==='cloud-prepare'&&payload.consentUpload!==true)throw fault('上传参考音前需要你主动确认','CLOUD_UPLOAD_CONSENT');
      return trackCloud(generation,ctx,async()=>{
        const result=op==='cloud-bind'?await cloud.bindVoice({...ctx,voiceId:payload.voiceId}):await cloud.prepareVoice({...ctx,consentUpload:true});
        assertCurrent(ctx);return mirrorBinding(ctx,result,generation);
      });
    }
    if(op==='configure'||op==='profile-select'){
      const generation=voiceEpoch+1;
      await stopAll(op==='configure'?'configuration-changed':'profile-changed');assertVoiceOpen(generation);
    }
    return controller.action(op,payload);
  }
  return {action,controller,assets,profiles,settings,runtime,cloud,cardEvent,
    busy:()=>!!stopping||!!stopFailure||cloudOperations.size>0||cardAdmissions>0||cards.busy()||controller.busy?.()===true,
    microphoneAllowed:()=>microphone,
    snapshot:()=>({microphoneAuthorized:microphone,cardSpeechBusy:cards.busy()}),
    quiesce:()=>stopAll('package-maintenance'),
    async close(){closed=true;voiceEpoch++;microphone=false;cardEpoch++;await runtime.stopEngine?.();await Promise.allSettled([...cloudOperations]);await cardTail;const results=await Promise.allSettled([cards.close(),controller.close()]);const failed=results.find(value=>value.status==='rejected');if(failed)throw failed.reason;await runtime.close?.();await supervisor.close();},
  };
}
