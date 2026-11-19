import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {writeAtomic} from './atomic-write.mjs';
import {imageSlots} from './media-store.mjs';
import {rootRecord,saveRootRecord,lifeRecord,saveLifeRecord} from './companion-record-access.mjs';

const stale=()=>Object.assign(Error('清理计划已经变化，请重新预演后再确认'),{code:'MAINTENANCE_PLAN_CHANGED'});
const busy=()=>Object.assign(Error('正在生成回复或切换人生，请稍后再执行维护'),{code:'MAINTENANCE_BUSY'});
const publicPlan=({revision,duplicateEvents,changes,...plan})=>plan;
const mediaTask=task=>task==='media-migrate'||task==='media-revert';

function applyDedupe(store,state,tx,plan){
 for(const {conversationId,messages} of plan.removals)for(const {messageId} of messages){
  if(!tx.messages.delete('private',conversationId,messageId))throw stale();
 }
 const path=['memory','events'],namespace='memory.events';
 for(const {characterId,eventId,duplicateOf} of plan.duplicateEvents){
  const event=lifeRecord(store,state,characterId,namespace,path,eventId,tx);
  if(!event)throw stale();
  saveLifeRecord(state,characterId,namespace,path,eventId,{...event,duplicateOf},tx);
 }
}

function applyMedia(store,state,tx,{slots,archiveAvatars},drafts){
 const updates=new Map(slots.map(({path,value})=>[path,value]));
 for(const [holder,key,path] of imageSlots(state)){
  if(!updates.has(path))continue;
  holder[key]=updates.get(path);
  updates.delete(path);
 }
 if(updates.size)throw stale();
 for(const {id,value} of archiveAvatars){
  const archive=rootRecord(store,state,'lifeArchives',id,tx);
  if(!archive)throw stale();
  saveRootRecord(state,'lifeArchives',id,{...archive,avatar:value},tx);
 }
 for(const [id,text] of drafts)if(Object.hasOwn(state.conversations??{},id))state.conversations[id].draft=text;
}

// One-time repair tools behind the control pipe. "plan" is read-only and returns a
// planId. "apply" takes that planId, refuses while replies or life switches run,
// writes a full backup of the store, then recomputes the plan and changes the store
// in one mutation. Each task supplies plan(state), apply(state,planId), summary(plan),
// and optionally mutateOptions for the store and after(plan) once the change is kept.
export function createMaintenance({store,dataRoot,tasks,isBusy=()=>false,audit=()=>{},now=Date.now}){
 const tool=task=>{if(typeof task!=='string'||!Object.hasOwn(tasks,task))throw Error('未知维护任务：'+task);return tasks[task];};
 const useSqlite=task=>store.planMaintenance&&(task==='legacy-dedupe'||mediaTask(task));
 function backupPath(task,planId){
  return join(dataRoot,'galgame','maintenance',`${task}-${planId}-${now()}.json`);
 }
 async function backup(task,planId,revision){
  const target=backupPath(task,planId);
  mkdirSync(join(dataRoot,'galgame','maintenance'),{recursive:true});
  if(store.exportMaintenanceBackup)await store.exportMaintenanceBackup(target,{revision});
  else writeAtomic(target,JSON.stringify(store.snapshot()));
  return target;
 }
 return {
  plan(task){
   const {plan,summary,draftEntries}=tool(task);
   if(!useSqlite(task))return summary(plan(store.state));
   return store.planMaintenance(task,{draftEntries:draftEntries?.()}).then(value=>summary(publicPlan(value)));
  },
  async apply(task,planId){
   const {plan,apply,summary,after,afterSqlite,mutateOptions,draftEntries}=tool(task);
   if(typeof planId!=='string'||!/^[a-f0-9]{32}$/.test(planId))throw Error('planId 无效');
   if(!dataRoot)throw Error('维护需要数据目录');
   if(isBusy())throw busy();
   await store.flush();
   const onSqlite=useSqlite(task),drafts=draftEntries?.()??[];
   const planned=onSqlite?await store.planMaintenance(task,{draftEntries:drafts}):plan(store.state);
   if(planned.planId!==planId)throw stale();
   const revision=onSqlite?planned.revision:store.state.revision;
   const file=await backup(task,planId,revision);
   let result;
   if(onSqlite){
    const prepared=mediaTask(task)?await store.planMaintenance(task,{draftEntries:drafts,applyPlanId:planId,revision}):planned;
    await store.mutate((state,tx)=>{
     if(mediaTask(task))applyMedia(store,state,tx,prepared.changes,drafts);
     else applyDedupe(store,state,tx,prepared);
    },{...mutateOptions,guard:state=>{
     if(isBusy())throw busy();
     if(state.revision!==revision||(draftEntries&&!isDeepStrictEqual(draftEntries(),drafts)))throw stale();
     return true;
    }});
    await afterSqlite?.(drafts);
    result=publicPlan(prepared);
   }else{
    await store.mutate(state=>{result=apply(state,planId);},mutateOptions);
    await after?.(result);
   }
   const value=summary(result);audit({type:'maintenance-apply',task,planId,backup:file,total:value.total});
   return {ok:true,...value,backup:file};
  }
 };
}
