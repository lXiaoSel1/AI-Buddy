const fields=['characterId','personaId','lifeId','operationId'];
const text=value=>typeof value==='string'&&value.length>0&&value.length<=500&&!value.includes('\0');
const validScope=value=>fields.every(key=>text(value?.[key]));
const equalScope=(a,b)=>validScope(a)&&validScope(b)&&fields.every(key=>a[key]===b[key]);
const equalViewer=(a,b)=>equalScope(a,b)&&a.revision===b.revision;
const safeGlobalTypes=new Set(['work-lifecycle','work-invalidated']);
const globalStates=new Set(['available','disabled','uninstalled','restarting','update-required','stale']);

/** Host-only event routing, with the same task-owner visibility as tasks.read.
 * A selected viewer never grants access merely by belonging to a task team.
 * isCurrentViewer is a synchronous host check (selection revision/life cache),
 * and its publication guard must also be checked immediately before IPC send. */
export function createWorkEventSubscription({binding,getInstallation,getViewer,getTask,isCurrentViewer,listener,onDenied=()=>{}}={}){
  if(!binding||[getInstallation,getViewer,getTask,isCurrentViewer,listener].some(value=>typeof value!=='function'))throw TypeError('Work event routing requires trusted viewer, task, lifecycle and publication callbacks');
  let closed=false,tail=Promise.resolve();
  function currentInstallation(){const record=getInstallation();return record&&(record.pluginId??record.hostPluginId)===binding.pluginId&&record.packageKey===binding.packageKey&&record.generation===binding.generation&&(record.enabledIntent??record.enabled)===true?record:null;}
  const deny=code=>{try{onDenied({code});}catch{}return false;};
  async function route(input){
    if(closed)return false;const record=currentInstallation();if(!record)return deny('WORK_EVENT_LIFECYCLE_CHANGED');
    const event=structuredClone(input);if(!event||typeof event!=='object'||Array.isArray(event)||!text(event.type)||event.pluginId&&event.pluginId!==binding.pluginId||event.lifecycleGeneration!=null&&event.lifecycleGeneration!==record.generation||event.sourceDigest!=null&&event.sourceDigest!==record.sourceDigest)return deny('WORK_EVENT_IDENTITY_DENIED');
    let viewer;try{viewer=await getViewer();}catch{return deny('WORK_EVENT_VIEWER_UNAVAILABLE');}if(!validScope(viewer))return deny('WORK_EVENT_VIEWER_UNAVAILABLE');
    const taskId=event.taskId??event.payload?.taskId;
    if(!taskId){
      if(!safeGlobalTypes.has(event.type))return deny('WORK_EVENT_TASK_REQUIRED');
      // Only a tiny invalidation/status projection crosses the global route.
      // Plugin-supplied payloads, paths, model text and questions never cross it.
      const safe={type:event.type,pluginId:binding.pluginId,lifecycleGeneration:record.generation,refresh:true,...globalStates.has(event.state)?{state:event.state}:{}};
      const publication={isCurrent:()=>!closed&&!!currentInstallation()&&isCurrentViewer(viewer)===true};if(!publication.isCurrent())return deny('WORK_EVENT_VIEWER_CHANGED');await listener(safe,publication);return true;
    }
    if(!text(taskId)||event.taskId&&event.payload?.taskId&&event.taskId!==event.payload.taskId)return deny('WORK_EVENT_TASK_DENIED');
    let task;try{task=await getTask(taskId);}catch{return deny('WORK_EVENT_TASK_DENIED');}
    if(!task||task.id!==taskId||!equalScope(task.scope,viewer)||event.projectId!=null&&event.projectId!==task.projectId)return deny('WORK_EVENT_SCOPE_DENIED');
    const eventScope=event.scope??(fields.some(key=>Object.hasOwn(event,key))?event:null);
    if(eventScope&&!equalScope(eventScope,task.scope)&&!(task.team??[]).some(member=>equalScope(member.scope,eventScope)))return deny('WORK_EVENT_SCOPE_DENIED');
    const memberId=event.memberId??event.payload?.memberId;if(memberId&&eventScope){const member=(task.team??[]).find(value=>value.id===memberId);if(!member||!equalScope(member.scope,eventScope))return deny('WORK_EVENT_MEMBER_DENIED');}
    const latest=await getViewer();if(!equalViewer(viewer,latest))return deny('WORK_EVENT_VIEWER_CHANGED');
    const publication={isCurrent:()=>!closed&&!!currentInstallation()&&isCurrentViewer(viewer)===true};if(!publication.isCurrent())return deny('WORK_EVENT_VIEWER_CHANGED');
    await listener(event,publication);return true;
  }
  function deliver(event){if(closed)return Promise.resolve(false);let input;try{input=structuredClone(event);}catch{return Promise.resolve(deny('WORK_EVENT_SHAPE_DENIED'));}const result=tail.catch(()=>{}).then(()=>route(input)).catch(()=>deny('WORK_EVENT_DELIVERY_FAILED'));tail=result;return result;}
  return {deliver,close(){closed=true;},drain:()=>tail};
}
