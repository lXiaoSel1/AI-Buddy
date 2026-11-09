import {locale} from '../i18n.mjs';
const packages=[['breeze','ai-buddy.voice-breeze'],['gpt','ai-buddy.voice-gpt-sovits']];
const operations=new Set(['cloud-connection-save','cloud-connection-select','cloud-connection-remove','cloud-batch-preview','cloud-batch-prepare','cloud-batch-reconcile','cloud-batch-cancel']);
const fail=(code,message)=>Object.assign(Error(message),{code});
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const scopeIdentity=scope=>JSON.stringify([scope?.characterId,scope?.personaId,scope?.lifeId,scope?.operationId,scope?.contextRevision]);
const configIdentity=config=>JSON.stringify([config.enabled,config.selectedPackageId,config.packages,config.cloudConnections]);
const emptyBatch=()=>({state:'idle',running:false,total:0,completed:0,items:[],results:[],counts:{active:0,prepared:0,unknown:0,failed:0,pending:0}});

/** Host-only routing. No renderer argument can choose a role, life or Key reference. */
export function createCloudVoiceGateway({settings,profiles,credentials,cloud,getGame,resolvePackage,publish=()=>{},assertOpen=()=>{},stopAll=async()=>{},track=task=>task,getLocale=locale}){
  let epoch=0,batchRun,admissionRun,admissionIdentity,batchState=emptyBatch(),connectionTail=Promise.resolve();
  async function cleanupCredential(ref){
    if(!ref||typeof credentials.removeIfUnused!=='function')return;
    await credentials.removeIfUnused(ref,async candidate=>{const current=await settings.get();return current.cloudConnections.items.some(row=>row.credentialRef===candidate)||Object.values(current.packages).some(row=>row.credentialRef===candidate);});
  }
  function assertPayload(op,payload){
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fail('VOICE_ACTION_INVALID','云配音参数无效');
    const identities=['characterId','personaId','lifeId','operationId','conversationId','engine','packageId','profiles','credentialRef','keyRef','scope'];
    if(identities.some(key=>Object.hasOwn(payload,key)))throw fail('VOICE_SCOPE_FORGED','云配音身份和密钥引用只能由宿主指定');
    const allowed=op==='cloud-connection-save'?['id','name','provider','model','key']:op==='cloud-connection-select'||op==='cloud-connection-remove'?['id']:
      op==='cloud-batch-prepare'?['consentUpload','consentActivation','selectedCharacterIds','planHash']:op==='cloud-batch-preview'?['selectedCharacterIds']:[];
    if(Object.keys(payload).some(key=>!allowed.includes(key)))throw fail('VOICE_ACTION_INVALID','云配音参数包含不支持的字段');
  }
  function send(){try{publish({type:'cloud-batch',cloudBatch:structuredClone(batchState)});}catch{}}
  async function publicConnections(){
    const list=await settings.listConnections();return {selectedId:list.selectedId,items:list.items.map(({id,name,provider,model,credentialRef})=>({id,name,provider,model,configured:!!credentialRef}))};
  }
  async function gather(){
    const game=getGame(),view=game?.viewState?.(),personaId=view?.activePersonaId??game?.voiceScope?.()?.personaId;
    if(!view||!Array.isArray(view.characters)||!validId(personaId)||typeof game.pluginScope!=='function')throw fail('CLOUD_SCOPE','角色列表或当前身份尚未准备');
    const characters=view.characters.filter(row=>validId(row?.id));
    if(!characters.length||characters.length>100||new Set(characters.map(row=>row.id)).size!==characters.length)throw fail('CLOUD_SCOPE','受信角色列表无效');
    const config=await settings.get(),rows=[],scopes=[],selections=[];
    for(const character of characters){
      const scope=game.pluginScope(character.id,personaId);scopes.push({characterId:character.id,identity:scopeIdentity(scope)});
      if(scope.characterId!==character.id||scope.personaId!==personaId||!scope.lifeId||!scope.operationId)throw fail('CLOUD_SCOPE','角色人生活动身份无效');
      for(const [engine,packageId] of packages){
        const profile=await profiles.current({characterId:character.id,engine});
        selections.push({characterId:character.id,engine,id:profile?.id??null,version:profile?.version??null});
        if(profile)rows.push({...scope,engine,packageId,profileId:profile.id,profileVersion:profile.version});
      }
    }
    return {game,personaId,characters,config,rows,scopes,selections};
  }
  async function capturedCheck(captured,generation,hostGeneration,leases){
    if(generation!==epoch||assertOpen()!==hostGeneration)throw fail('CLOUD_CONFIGURATION_CHANGED','云配音操作已撤销');
    const game=getGame(),view=game?.viewState?.();
    if(game!==captured.game||view?.activePersonaId!==captured.personaId||JSON.stringify((view?.characters??[]).filter(row=>validId(row?.id)).map(row=>row.id))!==JSON.stringify(captured.characters.map(row=>row.id))||
      configIdentity(await settings.get())!==configIdentity(captured.config))throw fail('CLOUD_CONFIGURATION_CHANGED','云配音配置、身份或角色清单已改变，准备已暂停');
    for(const row of captured.scopes)if(scopeIdentity(game.pluginScope(row.characterId,captured.personaId))!==row.identity)throw fail('CLOUD_CONFIGURATION_CHANGED','角色人生或身份已改变，旧云音色准备已暂停');
    for(const row of captured.selections){
      const current=await profiles.current({characterId:row.characterId,engine:row.engine});
      if((current?.id??null)!==row.id||(current?.version??null)!==row.version)throw fail('CLOUD_CONFIGURATION_CHANGED','角色声音档案已改变，旧云音色准备已暂停');
    }
    for(const lease of leases)await lease?.assertCurrent?.();
    if(generation!==epoch||assertOpen()!==hostGeneration)throw fail('CLOUD_CONFIGURATION_CHANGED','云配音操作已撤销');
  }
  function includeCharacters(summary,captured){
    const items=captured.characters.map(character=>{
      const saved=summary.items?.find(row=>row.characterId===character.id)??{characterId:character.id,status:'not-prepared'};
      const missingEngines=captured.selections.filter(row=>row.characterId===character.id&&!row.id).map(row=>row.engine);
      return missingEngines.length?{...saved,status:missingEngines.length===packages.length?'profile-missing':'profile-incomplete',
        code:'CLOUD_PROFILE_REQUIRED',missingEngines,availableStatus:saved.status,message:missingEngines.length===packages.length?'角色缺少声音档案，未提交云端准备':'部分引擎缺少声音档案，角色准备尚未完整'}:saved;
    });
    const active=items.filter(row=>['activated','activation-confirmed-query-pending','reuse-existing'].includes(row.status)).length;
    return {...summary,items,total:items.length,completed:active,available:new Set(captured.rows.map(row=>row.characterId)).size,characterCount:items.length,profileCount:captured.rows.length,
      state:items.length&&active===items.length?'completed':'pending',counts:{active,prepared:items.filter(row=>row.status==='prepared-awaiting-activation').length,
        unknown:items.filter(row=>row.status==='unknown').length,failed:items.filter(row=>['failed','account-confirmation-required','expired','unavailable','profile-missing','profile-incomplete'].includes(row.status)).length,
        pending:items.filter(row=>['pending','preparing','not-prepared'].includes(row.status)).length,profileMissing:items.filter(row=>row.missingEngines?.length).length}};
  }
  function selection(payload,captured,{required=false}={}){
    const ids=payload.selectedCharacterIds??[];
    if(!Array.isArray(ids)||required&&!ids.length||ids.length>100||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length||captured&&ids.some(id=>!captured.characters.some(row=>row.id===id)))
      throw fail('CLOUD_SELECTION_REQUIRED','请选择至少一个当前列表中的角色，角色不能重复');
    return captured?captured.characters.filter(row=>ids.includes(row.id)).map(row=>row.id):ids;
  }
  async function planFor(captured,selectedCharacterIds){
    const rows=captured.rows.filter(row=>selectedCharacterIds.includes(row.characterId));
    const plan=await cloud.batchPreview({profiles:rows,selectedCharacterIds});
    for(const characterId of selectedCharacterIds)if(!rows.some(row=>row.characterId===characterId))plan.actions.push({characterId,action:'blocked-unknown',cloneRequired:false,activationRequired:false,code:'CLOUD_PROFILE_REQUIRED'});
    plan.blockedCount=plan.actions.filter(row=>row.action==='blocked-unknown').length;
    plan.planHash=createHash('sha256').update(JSON.stringify({plan,config:configIdentity(captured.config),selections:captured.selections.filter(row=>selectedCharacterIds.includes(row.characterId)),
      scopes:captured.scopes.filter(row=>selectedCharacterIds.includes(row.characterId))})).digest('hex');
    return plan;
  }
  async function preview(payload={}){
    const captured=await gather(),selectedCharacterIds=selection(payload,captured),summary=await cloud.batchStatus({profiles:captured.rows}),plan=await planFor(captured,selectedCharacterIds);
    return {...includeCharacters(summary,captured),
      plan,actions:plan.actions,requiresConsent:true,remoteUpload:true,formalActivation:true,chargeNotice:'仅处理勾选角色。新音色费用为官方参考估价，首次正式合成时计收，文字合成费另算；未知结果不会自动重发'};
  }
  function progress(row,captured,mode){
    const items=[...(batchState.items??[])],index=items.findIndex(item=>item.characterId===row.characterId);
    if(index<0)items.push(row);else items[index]=row;
    batchState={...includeCharacters({...batchState,items,results:items},captured),state:mode,running:true};send();
  }
  function prepare(payload,{reconcile=false}={}){
    if(!reconcile&&payload.consentUpload!==true)throw fail('CLOUD_UPLOAD_CONSENT','请先确认上传已有角色的完整参考音');
    if(!reconcile&&payload.consentActivation!==true)throw fail('CLOUD_ACTIVATION_CONSENT','请先确认首次正式合成激活及 MiniMax 相关计费');
    if(!reconcile)selection(payload,null,{required:true});
    if(!reconcile&&(typeof payload.planHash!=='string'||!/^[a-f0-9]{64}$/.test(payload.planHash)))throw fail('CLOUD_PLAN_CHANGED','请刷新所选角色的费用计划后再确认准备');
    const requestIdentity=JSON.stringify([reconcile,payload.selectedCharacterIds,payload.planHash]);
    if((admissionRun||batchRun)&&admissionIdentity!==requestIdentity)throw fail('CLOUD_BUSY','正在准备另一组角色，请等待当前任务完成');
    if(admissionRun)return admissionRun;
    if(batchRun)return batchRun;
    admissionIdentity=requestIdentity;
    const generation=++epoch;
    const admission=(async()=>{
    const captured=await gather(),selectedCharacterIds=reconcile?captured.characters.map(row=>row.id):selection(payload,captured,{required:true});
    const plan=reconcile?null:await planFor(captured,selectedCharacterIds);
    if(!reconcile&&plan.planHash!==payload.planHash)throw fail('CLOUD_PLAN_CHANGED','云配音配置、声音档案或当前绑定已改变，请刷新费用计划并重新确认');
    const selectedRows=captured.rows.filter(row=>selectedCharacterIds.includes(row.characterId));
    await stopAll(reconcile?'cloud-batch-reconciling':'cloud-batch-preparing');const hostGeneration=assertOpen();
    if(generation!==epoch)throw fail('CLOUD_CONFIGURATION_CHANGED','云配音操作已撤销');
    const leases=[];
    for(const [engine,packageId] of packages)if(selectedRows.some(row=>row.engine===engine))leases.push(await resolvePackage(packageId,{provider:'minimax'}));
    const checkCurrent=()=>capturedCheck(captured,generation,hostGeneration,leases);
    await checkCurrent();
    const initialStatus=await cloud.batchStatus({profiles:captured.rows});await checkCurrent();
    if(!selectedRows.length){batchState={...includeCharacters({...initialStatus,results:[]},captured),...(plan?{plan,actions:plan.actions}:{}),running:false};send();return structuredClone(batchState);}
    const mode=reconcile?'reconciling':'running';
    batchState={...includeCharacters({...initialStatus,results:[]},captured),...(plan?{plan,actions:plan.actions}:{}),state:mode,running:true};send();
    const task=(async()=>{
      try{
        if(reconcile){
          const queryErrors=[];
          for(const scope of selectedRows){
            await checkCurrent();
            try{const row=await cloud.reconcileVoice({...scope,checkCurrent});progress(row,captured,mode);}
            catch(error){
              if(error.name==='AbortError'||error.code==='CLOUD_CONFIGURATION_CHANGED')throw error;
              queryErrors.push({characterId:scope.characterId,code:/^CLOUD_[A-Z0-9_]+$/.test(error.code??'')?error.code:'CLOUD_QUERY_FAILED'});
            }
            await checkCurrent();
          }
          batchState={...includeCharacters(await cloud.batchStatus({profiles:captured.rows}),captured),running:false,queryErrors};
        }else{
          const result=await cloud.prepareBatch({profiles:selectedRows,consentUpload:true,consentActivation:true,checkCurrent,onProgress:row=>progress(row,captured,mode)});
          const currentStatus=await cloud.batchStatus({profiles:captured.rows});
          const items=currentStatus.items.map(row=>result.items?.find(item=>item.characterId===row.characterId)??row);
          batchState={...includeCharacters({...result,items},captured),plan,actions:plan.actions,running:false};
        }
        send();return structuredClone(batchState);}
      catch(error){
        const stopped=error.name==='AbortError'||error.code==='CLOUD_CONFIGURATION_CHANGED';
        const saved=await cloud.batchStatus({profiles:captured.rows}).catch(()=>batchState);
        batchState={...includeCharacters(saved,captured),state:stopped?'cancelled':'failed',running:false,code:error.code??(stopped?'CLOUD_CANCELLED':'CLOUD_PREPARE_FAILED'),
          message:stopped?'云音色准备已暂停，已完成及未知回执已保留':'云音色准备未完成，请检查配置及逐角色状态'};send();throw error;
      }
      finally{if(batchRun===task)batchRun=null;}
    })();
    batchRun=task;track(task);return task;
    })();
    admissionRun=admission;void admission.finally(()=>{if(admissionRun===admission)admissionRun=null;}).catch(()=>{});return admission;
  }
  return {
    handles:op=>operations.has(op),
    invalidateState(){if(!batchRun&&!admissionRun)batchState=emptyBatch();},
    async state(){
      const cloudConnections=await publicConnections();
      if(!batchRun&&batchState.state==='idle'){
        try{const value=await preview();batchState={...value,state:'idle',running:false};}
        catch(error){batchState={...emptyBatch(),state:'unavailable',code:error.code??'CLOUD_SCOPE',message:'请先准备角色和声音档案'};}
      }
      return {cloudConnections,cloudBatch:structuredClone(batchState)};
    },
    async action(op,payload={}){
      if(!operations.has(op))throw fail('VOICE_ACTION_INVALID','不支持的云配音操作');assertPayload(op,payload);assertOpen();
      if(op==='cloud-batch-preview')return preview(payload);
      if(op==='cloud-batch-prepare')return prepare(payload);
      if(op==='cloud-batch-reconcile')return prepare(payload,{reconcile:true});
      if(op==='cloud-batch-cancel'){
        epoch++;batchState={...batchState,state:'cancelling'};send();await cloud.stopEngine();await (admissionRun??batchRun)?.catch(()=>{});
        batchState={...batchState,state:'cancelled',running:false};send();return structuredClone(batchState);
      }
      epoch++;
      const changing=connectionTail.then(async()=>{
      await stopAll('cloud-connection-changing');assertOpen();let retiredRef,warningCode;
      if(op==='cloud-connection-save'){
        const list=await settings.listConnections(),previous=payload.id?list.items.find(row=>row.id===payload.id):null;
        if(payload.id&&!previous)throw fail('VOICE_SETTINGS_INVALID','云配音配置不存在');
        const name=payload.name??previous?.name??'MiniMax 云配音',provider=payload.provider??previous?.provider??(getLocale()==='en'?'minimax-global':'minimax'),model=payload.model??previous?.model??'speech-2.8-turbo';
        if(typeof name!=='string'||!name.trim()||name.length>100||/[\r\n\0]/.test(name)||!['minimax','minimax-global'].includes(provider)||!['speech-2.8-turbo','speech-2.8-hd'].includes(model))throw fail('VOICE_SETTINGS_INVALID','云配音配置名称、服务或模型无效');
        if(previous&&previous.provider!==provider&&payload.key===undefined)throw fail('CLOUD_REGION_KEY_REQUIRED','更改地区后，请填写该地区平台的 API Key');
        const saved=payload.key!==undefined?await credentials.save(payload.key):null;
        try{await settings.saveConnection({...(payload.id?{id:payload.id}:{}),name,provider,model,credentialRef:saved?.ref??previous?.credentialRef??null});}
        catch(error){if(saved)try{await cleanupCredential(saved.ref);}catch{error.credentialCleanupPending=true;}throw error;}
        if(saved&&previous?.credentialRef!==saved.ref)retiredRef=previous?.credentialRef;
      }else if(op==='cloud-connection-select')await settings.selectConnection(payload.id);
      else{retiredRef=(await settings.listConnections()).items.find(row=>row.id===payload.id)?.credentialRef;await settings.removeConnection(payload.id);}
      if(retiredRef)try{await cleanupCredential(retiredRef);}catch{warningCode='VOICE_CREDENTIAL_CLEANUP_PENDING';}
      batchState=emptyBatch();return {cloudConnections:await publicConnections(),...(warningCode?{warningCode,message:'配置已保存，但旧密钥清理尚未完成；原加密记录仍保留'}:{})};
      });connectionTail=changing.catch(()=>{});return changing;
    },
  };
}
import {createHash} from 'node:crypto';

