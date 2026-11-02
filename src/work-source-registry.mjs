import {isDeepStrictEqual} from 'node:util';
import {resolve} from 'node:path';
import {TokenSources,validateSource} from './token-sources.mjs';
import {normalizeManagedWorkSource,WorkUsageAttribution} from './work-usage-attribution.mjs';

export const sourceMutation=action=>['save','toggle','remove','auto','alias','import'].includes(action);

export async function persistWorkSource(sources,workUsage,value,phase=()=>{}){
 let changedIndex=false,restart=false;
   await workUsage.ready;
   normalizeManagedWorkSource(value);
   const old=sources.list().find(source=>source.id===value.id);
   const before=workUsage.key;
   if(value.nativeHistoryRange){
    if(!old||old.tool!=='dsh'||resolve(old.path).toLowerCase()!==resolve(value.path).toLowerCase())throw Object.assign(Error('Native resume attribution requires its existing exact DSH source'),{code:'WORK_USAGE_ATTRIBUTION_CONFLICT'});
    await workUsage.register({...old,nativeHistoryRange:value.nativeHistoryRange});
    if(before!==workUsage.key)changedIndex=true;
   }else{
    const {workAttribution,...draft}=value,source=validateSource(draft);
    workUsage.assertEditable('save',source);
    const known=workUsage.records.has(source.id);
    if(known)await workUsage.register({...source,workAttribution}); // Verify the captured identity before updating settings.
    if(old?.automatic)source.automatic=true;
    const changed=!isDeepStrictEqual(old,source);
    if(changed){phase('source-settings');await sources.action('save',source,{settingsView:false});}
    if(!known){phase('attribution');await workUsage.register({...source,workAttribution});}
    if(changed||before!==workUsage.key){changedIndex=true;restart=changed&&['codex','claude'].includes(source.tool);}
   }
 return {changed:changedIndex,restart};
}

// A single owner serializes writes to both settings files. Analytics receives a
// committed projection and can rebuild independently of native run admission.
export function createWorkSourceRegistry(options,publish,audit=()=>{}){
 const sources=new TokenSources(options),workUsage=new WorkUsageAttribution(options.dataRoot);
 const ready=Promise.all([sources.init(),workUsage.ready]);
 let tail=Promise.resolve();
 function enqueue(operation){const result=tail.then(()=>ready).then(operation);tail=result.catch(()=>{});return result;}
 function notify(){publish({state:structuredClone(sources.state),records:[...workUsage.records.values()],activeClaims:[...workUsage.activeHistoryClaims]});}
 return {
  register(value){const start=performance.now();let stage='queued';const phase=next=>{stage=next;audit({type:'work-registration',sourceId:value.id,stage,elapsedMs:Math.round(performance.now()-start)});};
   return enqueue(async()=>{phase('checking');try{const {changed}=await persistWorkSource(sources,workUsage,value,phase);if(changed)notify();phase('committed');return {registered:true,sourceId:value.id,indexing:'pending',...(value.nativeHistoryRange?{nativeHistoryRange:true}:{})};}catch(error){audit({type:'work-registration-failed',sourceId:value.id,stage,code:error.code});throw error;}});},
  edit(action,args){return enqueue(async()=>{if(!sourceMutation(action))throw Error('Unsupported source mutation');workUsage.assertEditable(action,args);await sources.action(action,args,{settingsView:false});notify();}).then(()=>sources.view());},
  flush:()=>tail,
 };
}
