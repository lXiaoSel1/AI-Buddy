import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {writeAtomic} from './atomic-write.mjs';

// One-time repair tools behind the control pipe. "plan" is read-only and returns a
// planId. "apply" takes that planId, refuses while replies or life switches run,
// writes a full backup of the store, then recomputes the plan and changes the store
// in one mutation. Each task supplies plan(state), apply(state,planId), summary(plan),
// and optionally mutateOptions for the store and after(plan) once the change is kept.
export function createMaintenance({store,dataRoot,tasks,isBusy=()=>false,audit=()=>{},now=Date.now}){
 const tool=task=>{if(typeof task!=='string'||!Object.hasOwn(tasks,task))throw Error('未知维护任务：'+task);return tasks[task];};
 function backup(task,planId){
  const directory=join(dataRoot,'galgame','maintenance');mkdirSync(directory,{recursive:true});
  const target=join(directory,`${task}-${planId}-${now()}.json`);writeAtomic(target,JSON.stringify(store.snapshot()));return target;
 }
 return {
  plan(task){const {plan,summary}=tool(task);return summary(plan(store.state));},
  async apply(task,planId){
   const {plan,apply,summary,after,mutateOptions}=tool(task);
   if(typeof planId!=='string'||!/^[a-f0-9]{32}$/.test(planId))throw Error('planId 无效');
   if(!dataRoot)throw Error('维护需要数据目录');
   if(isBusy())throw Object.assign(Error('正在生成回复或切换人生，请稍后再执行维护'),{code:'MAINTENANCE_BUSY'});
   await store.flush();
   if(plan(store.state).planId!==planId)throw Object.assign(Error('清理计划已经变化，请重新预演后再确认'),{code:'MAINTENANCE_PLAN_CHANGED'});
   const file=backup(task,planId);let result;
   await store.mutate(state=>{result=apply(state,planId);},mutateOptions);await after?.(result);
   const value=summary(result);audit({type:'maintenance-apply',task,planId,backup:file,total:value.total});
   return {ok:true,...value,backup:file};
  }
 };
}
