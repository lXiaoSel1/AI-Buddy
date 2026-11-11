import {createPluginHost} from '../plugin-host.mjs';
import {isVoiceSourceAuthorized, LEGACY_SOURCE_ID} from '../plugin-sources.mjs';
import {satisfiesVersionRange,satisfiesHostVersionRange} from '../plugin-manifest.mjs';
import {VOICE_CLOUD_WORKER, VOICE_ENGINES, VOICE_PROVIDERS, VOICE_SHARED_PACKAGE, isVoiceEnginePackage, isVoicePackage, supportsVoiceManifest} from './package-contract.mjs';

const fault=(message,code)=>Object.assign(Error(message),{code});
const packageIds=Object.keys(VOICE_ENGINES);

/** Runtime leases are scoped to the signed Buddy package and its exact shared
 * dependency. Maintenance revokes leases before touching the registry. */
export function createVoicePackageAuthority({manager,runnerPath,processFactory,voiceTestFingerprint,quiesce=async()=>{},onChanged=()=>{}}) {
  let closed=false;
  const generations=new Map(),changing=new Set(),plans=new Map(),commands=new Map();
  const host=runnerPath ? createPluginHost({runnerPath,processFactory,services:{commands:{register({id},callback){
    if(!packageIds.some(pluginId=>id===`${pluginId}.prepare`) || commands.has(id))throw fault('语音包注册身份无效','VOICE_PACKAGE_INVALID');
    commands.set(id,callback);
    return ()=>commands.delete(id);
  }}}}) : null;

  function status() {
    const snapshot=manager.snapshot();
    return packageIds.map(id=>{
      const row=snapshot.installed?.[id],version=row?.current??null;
      const sourceId=row?.sourceId??(row?LEGACY_SOURCE_ID:null);
      const source=snapshot.sources?.find(value=>value.sourceId===sourceId);
      const shared=snapshot.installed?.[VOICE_SHARED_PACKAGE];
      const current=row?.versions?.[version];
      let state='ready';
      if(closed || !snapshot.service?.usable)state='unavailable';
      else if(changing.has(id))state='changing';
      else if(!row)state='not-installed';
      else if(source?.removed || source?.enabled===false)state='source-disabled';
      else if(!isVoiceSourceAuthorized(sourceId,source?.keyFingerprint,voiceTestFingerprint))state='source-untrusted';
      else if(!row.enabled)state='disabled';
      else if(!satisfiesHostVersionRange(snapshot.appVersion,current.manifest.appRange) ||
              !satisfiesVersionRange(snapshot.apiVersion,current.manifest.apiRange))state='incompatible';
      else if(!shared || shared.current!==current.manifest.dependencies[VOICE_SHARED_PACKAGE] || (shared.sourceId??LEGACY_SOURCE_ID)!==sourceId)state='missing-dependency';
      else if(row.activation && !row.activation.usable)state=row.activation.state==='disabled'?'verification-failed':row.activation.state;
      return {id,engine:VOICE_ENGINES[id].engine,installed:!!row,enabled:row?.enabled===true,usable:state==='ready',state,sourceId,version,archiveSha256:current?.archive?.sha256??null,generation:generations.get(id)??0};
    });
  }

  async function resolvePackage(id,{provider='local',preset=false}={}) {
    if(!isVoiceEnginePackage(id))throw fault('未知的语音包身份','VOICE_PACKAGE_INVALID');
    if(!VOICE_PROVIDERS.includes(provider))throw fault('不支持的配音方式','VOICE_PROVIDER_INVALID');
    const generation=generations.get(id)??0;
    const checkGeneration=()=>{
      if(closed || changing.has(id) || generation!==(generations.get(id)??0))throw fault('语音包状态已改变','VOICE_PACKAGE_CHANGED');
    };
    checkGeneration();
    const current=status().find(row=>row.id===id);
    if(current.state==='source-untrusted')throw fault('此来源未获准运行语音引擎','VOICE_SOURCE_UNAUTHORIZED');
    if(current.state==='source-disabled')throw fault('扩展来源已停用或移除','PLUGIN_SOURCE_DISABLED');
    const packageRecord=await manager.resolveInstalled(id,{requireEnabled:!preset});
    checkGeneration();
    if(!supportsVoiceManifest(packageRecord.manifest))throw fault('语音包接口与宿主不匹配','VOICE_PACKAGE_INVALID');
    if(packageRecord.sourceId!==LEGACY_SOURCE_ID){
      const source=await manager.resolveTrustedSource(packageRecord.sourceId);
      if(!source.enabled || source.removed)throw fault('扩展来源已停用或移除','PLUGIN_SOURCE_DISABLED');
      if(!isVoiceSourceAuthorized(source.sourceId,source.keyFingerprint,voiceTestFingerprint) || packageRecord.sourceProof?.keyFingerprint!==source.keyFingerprint)
        throw fault('语音包来源证明无效','VOICE_SOURCE_UNAUTHORIZED');
    }else if(packageRecord.sourceProof?.legacyVerified!==true)throw fault('语音包缺少签名证明','VOICE_SOURCE_UNAUTHORIZED');
    const shared=await manager.resolveInstalled(VOICE_SHARED_PACKAGE,{sourceId:packageRecord.sourceId,requireEnabled:false});
    if(shared.manifest.kind!=='runtime' || shared.version!==packageRecord.manifest.dependencies[VOICE_SHARED_PACKAGE] ||
       shared.sourceId!==packageRecord.sourceId || shared.manifest.entry!=='asr_worker.py' ||
       !['asr_worker.py','assets.json'].every(path=>shared.manifest.files.some(file=>file.path===path)))
      throw fault('共享语音运行包不匹配','VOICE_PACKAGE_INVALID');
    if(provider==='minimax' && !shared.manifest.files.some(file=>file.path===VOICE_CLOUD_WORKER))
      throw fault('共享运行包不包含签名的云配音模块，请更新语音插件','VOICE_CLOUD_UNAVAILABLE');
    if(preset){
      const snapshot=manager.snapshot();
      if(![packageRecord,shared].every(row=>satisfiesHostVersionRange(snapshot.appVersion,row.manifest.appRange)&&satisfiesVersionRange(snapshot.apiVersion,row.manifest.apiRange)))
        throw fault('预制声线包与宿主版本不匹配','VOICE_PACKAGE_INVALID');
    }
    const assertCurrent=()=>{
      checkGeneration();
      const visible=status().find(row=>row.id===id);
      if(!(preset?['ready','disabled'].includes(visible.state):visible.usable) || visible.sourceId!==packageRecord.sourceId || visible.version!==packageRecord.version || visible.archiveSha256!==packageRecord.archiveSha256)
        throw fault('语音包状态已改变','VOICE_PACKAGE_CHANGED');
    };
    assertCurrent();
    if(host&&!preset){
      const spec=VOICE_ENGINES[id];
      try {
        await host.activate({manifest:packageRecord.manifest,directory:packageRecord.directory,dataDirectory:packageRecord.dataDirectory,event:`onCommand:voice.${spec.engine}`});
        assertCurrent();
        const descriptor=await commands.get(`${id}.prepare`)?.();
        if(descriptor?.engine!==spec.engine || descriptor?.worker!==spec.worker || descriptor?.protocolVersion!==1)
          throw fault('语音包未注册受支持的引擎','VOICE_PACKAGE_INVALID');
        if(provider==='minimax' && (!Array.isArray(descriptor.providers) || !descriptor.providers.includes(provider) || descriptor.cloudWorker!==VOICE_CLOUD_WORKER))
          throw fault('此语音包尚不支持云配音，请更新语音插件','VOICE_CLOUD_UNAVAILABLE');
        assertCurrent();
      } catch (error) {
        if(!changing.has(id))await host.stop(id);
        throw error;
      }
    }
    return {...packageRecord,shared,provider,assertCurrent};
  }

  const resolveVoicePackage=(id,{provider='local'}={})=>resolvePackage(id,{provider});
  const resolveVoicePresetPackage=(id,{provider='local'}={})=>resolvePackage(id,{provider,preset:true});

  function affected(request) {
    const {action,id,sourceId,planId}=request;
    const rows=status().filter(row=>row.installed);
    if(action==='sources-remove' || (action==='sources-disable' && request.disabled===true))return rows.filter(row=>row.sourceId===sourceId).map(row=>row.id);
    if(['disable','rollback','uninstall'].includes(action) && isVoicePackage(id))return id===VOICE_SHARED_PACKAGE ? rows.map(row=>row.id) : [id];
    if(!['install','install-offline','install-update'].includes(action))return [];
    const planned=plans.get(planId);
    if(!planned || planned.includes(VOICE_SHARED_PACKAGE))return rows.map(row=>row.id);
    return rows.filter(row=>planned.includes(row.id)).map(row=>row.id);
  }

  function remember(plan,request={}) {
    // Update plans expose the changed dependencies, rather than the full install plan.
    const packages=Array.isArray(plan?.packages) ? plan.packages.filter(row=>!row.reuse).map(row=>row.manifest.id) :
      request.action==='plan-update' && typeof request.id==='string' && Array.isArray(plan?.dependencyChanges) ?
        [request.id,...plan.dependencyChanges.map(row=>row.id)] : null;
    if(plan?.planId && packages){
      plans.set(plan.planId,packages);
      if(plans.size>64)plans.delete(plans.keys().next().value);
    }
    return plan;
  }

  async function action(request={}) {
    const targets=affected(request);
    if(!targets.length){
      const result=await manager.action(request);
      return ['plan','plan-update'].includes(request.action) ? remember(result,request) : result;
    }
    if(closed || targets.some(id=>changing.has(id)))throw fault('语音包正在停用或维护','VOICE_PACKAGE_CHANGED');
    for(const id of targets){changing.add(id);generations.set(id,(generations.get(id)??0)+1);}
    try {
      for(const id of targets){await quiesce({id,sourceId:request.sourceId});await host?.stop(id);}
      return await manager.action(request);
    } finally {
      for(const id of targets)changing.delete(id);
      // Manager updates can arrive before the maintenance fence is released.
      // Publish once more now so the host can import the settled generation.
      try{onChanged();}catch{}
    }
  }

  async function prepareOffline(...args) {
    const value=await manager.prepareOffline(...args);
    remember(value?.plan);
    return value;
  }

  async function close() {
    if(closed)return;
    closed=true;
    try { await quiesce({}); }
    finally { await host?.stopAll(); }
  }

  return {action,prepareOffline,resolveVoicePackage,resolveVoicePresetPackage,status,close};
}
