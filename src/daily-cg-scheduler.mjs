import {join} from 'node:path';
import {createSnapshotStorage,readJson} from './storage.mjs';

export const DAILY_CG_SLOTS=Object.freeze(['10:00','22:00']);
const clone=value=>structuredClone(value);
const allowed=value=>value===true||value?.allowed===true;
const cancelled=()=>Object.assign(Error('每日 CG 调度已停止'),{code:'DAILY_CG_STOPPED'});
export function dailyCgTime(at,timeZone='local'){
 const zone=timeZone==='local'?Intl.DateTimeFormat().resolvedOptions().timeZone:timeZone;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(row=>[row.type,row.value]));
 return {logicalDay:parts.year+'-'+parts.month+'-'+parts.day,slot:parts.hour+':'+parts.minute,timeZone:zone};
}

/** A slot belongs to the application, never to a character. A durable claim is
 * consumed even when capture/enqueue fails; startup never replays old claims. */
export function createDailyCgScheduler({dataRoot,storage,now=Date.now,getTimeZone=()=> 'local',admission=()=>true,capture,enqueue,onError=()=>{},setIntervalImpl=setInterval,clearIntervalImpl=clearInterval,intervalMs=1000}={}){
 if(typeof capture!=='function'||typeof enqueue!=='function')throw Error('每日 CG 需要宿主素材与入队接口');
 const journal=storage??createSnapshotStorage(join(dataRoot,'daily-cg-slots.json'));
 let state={version:1,claims:{}},tail=Promise.resolve(),stopped=false,timer=null,controller=null;
 const ready=readJson(journal,state).then(value=>{if(value?.version!==1||!value.claims||typeof value.claims!=='object'||Array.isArray(value.claims))throw Error('每日 CG 时点记录版本无效');state=value;});
 const persist=()=>journal.writeText(JSON.stringify(state));
 const report=error=>{try{onError(error);}catch{}};
 async function run(at){
  await ready;if(stopped)return {skipped:'closed'};
  const clock=dailyCgTime(at,getTimeZone());if(!DAILY_CG_SLOTS.includes(clock.slot))return {skipped:'not-due'};
  const sourceEventId='daily:'+clock.logicalDay+':'+clock.slot.replace(':','');
  if(state.claims[sourceEventId])return {skipped:'claimed',claim:clone(state.claims[sourceEventId])};
  const initial=await admission({...clock,at,sourceEventId});if(stopped)return {skipped:'closed'};if(!allowed(initial))return {skipped:'denied'};
  // Do not turn a delayed queued tick into a catch-up request.
  const current=dailyCgTime(now(),getTimeZone());if(current.logicalDay!==clock.logicalDay||current.slot!==clock.slot||current.timeZone!==clock.timeZone)return {skipped:'missed'};
  const previous=Object.values(state.claims).filter(row=>row.logicalDay===clock.logicalDay&&row.slot<clock.slot).map(({sourceEventId,slot,materialEventIds=[],materialSourceHashes=[]})=>({sourceEventId,slot,materialEventIds,materialSourceHashes}));
  const claim={...clock,sourceEventId,triggeredAt:at,status:'claimed',materialEventIds:[],materialSourceHashes:[]};state.claims[sourceEventId]=claim;
  try{await persist();}catch(error){/* Keep the in-memory claim too: uncertainty cannot authorize another charge. */report(error);throw error;}
  controller=new AbortController();const context={...clock,at,sourceEventId,previous:clone(previous),signal:controller.signal};
  try{
   if(stopped)throw cancelled();const snapshot=clone(await capture(context));
   if(stopped||controller.signal.aborted)throw cancelled();
   const daily=snapshot?.daily??snapshot?.themeBrief?.daily??{},materials=snapshot?.materials??snapshot?.themeBrief?.materials??[];
   claim.materialEventIds=[...new Set(daily.materialEventIds??materials.map(row=>row.id??row.eventId).filter(id=>typeof id==='string'))];
   claim.materialSourceHashes=[...new Set(daily.materialSourceHashes??materials.map(row=>row.sourceHash??row.source?.sha256).filter(hash=>typeof hash==='string'))];
   await persist();if(stopped||controller.signal.aborted)throw cancelled();
   if(!allowed(await admission({...context,snapshot})))throw Object.assign(Error('每日 CG 自动生成许可已失效'),{code:'DAILY_CG_ADMISSION_CHANGED'});
   if(stopped||controller.signal.aborted)throw cancelled();
   const result=await enqueue(snapshot,context);
   claim.status=result?.skipped?'cancelled':'enqueued';claim.cgId=result?.cgId??result?.id??null;claim.finishedAt=now();await persist();return {claim:clone(claim),result};
  }catch(error){claim.status=stopped||controller.signal.aborted||error.code==='DAILY_CG_ADMISSION_CHANGED'?'cancelled':'failed';claim.error=String(error?.message??error).slice(0,500);claim.finishedAt=now();await persist();report(error);return {claim:clone(claim),error:claim.error};}
  finally{controller=null;}
 }
 const api={ready,
  tick({at=now()}={}){if(stopped)return Promise.resolve({skipped:'closed'});const task=tail.then(()=>run(at));tail=task.catch(()=>{});return task;},
  start(){if(stopped||timer!==null)return;timer=setIntervalImpl(()=>{void api.tick().catch(report);},Math.max(100,intervalMs));timer?.unref?.();void api.tick().catch(report);},
  async stopAndDrain(){stopped=true;if(timer!==null){clearIntervalImpl(timer);timer=null;}controller?.abort();await ready;await tail;},
  view(){return clone(state);},
 };
 return api;
}
