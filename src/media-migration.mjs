import {createHash} from 'node:crypto';
import {imageSlots,canonicalImage,isMediaUrl,mediaName} from './media-store.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const planId=value=>sha(JSON.stringify(value)).slice(0,32);
const changed=()=>Object.assign(Error('维护计划已经变化，请重新预演后再确认'),{code:'MAINTENANCE_PLAN_CHANGED'});

// T2 and its rollback for B4, as maintenance tasks (see maintenance.mjs).
//
// media-migrate moves pictures that are still data URLs in the companion store into
// media files. Only canonical data URLs move, so expanding the new URLs again gives
// the identical store; apply checks exactly that before the change is kept.
// media-revert puts every picture back as a data URL and the drafts back into their
// conversations, for a rollback to a build without media files. It refuses while a
// referenced file is missing.
export function mediaMaintenanceTasks({media,drafts=null}){
 function migratePlan(state){
  const rows=[];let skipped=0;
  for(const [holder,key,path]of imageSlots(state)){const value=holder[key];if(typeof value!=='string'||!value.startsWith('data:image/'))continue;if(!canonicalImage(value)){skipped++;continue;}rows.push({path,bytes:Math.floor(value.length*3/4),sha256:sha(value)});}
  return {task:'media-migrate',planId:planId({task:'media-migrate',rows}),total:rows.length,bytes:rows.reduce((sum,row)=>sum+row.bytes,0),skipped,rows};
 }
 function migrate(state,id){
  const plan=migratePlan(state);if(plan.planId!==id)throw changed();
  const before=JSON.stringify(state),moved=new Set(plan.rows.map(row=>row.path));
  for(const [holder,key,path]of imageSlots(state))if(moved.has(path)){const url=media.put(holder[key]);if(!url)throw Error('图片迁移失败：'+path);holder[key]=url;}
  // Expanding only what moved must give back the store byte for byte.
  const check=structuredClone(state);for(const [holder,key,path]of imageSlots(check))if(moved.has(path))holder[key]=media.resolve(holder[key],{missing:null});
  if(JSON.stringify(check)!==before)throw Error('图片迁移校验失败，存档没有改动');
  return plan;
 }
 function revertPlan(state){
  const rows=[],missing=[];
  for(const [holder,key,path]of imageSlots(state))if(isMediaUrl(holder[key])){rows.push({path,name:mediaName(holder[key])});if(!media.has(holder[key]))missing.push(path);}
  const draftRows=(drafts?.entries()??[]).filter(([id])=>state.conversations?.[id]).map(([id,text])=>({conversationId:id,sha256:sha(text)}));
  return {task:'media-revert',planId:planId({task:'media-revert',rows,draftRows}),total:rows.length,drafts:draftRows.length,missing,rows};
 }
 function revert(state,id){
  const plan=revertPlan(state);if(plan.planId!==id)throw changed();
  if(plan.missing.length)throw Error('有 '+plan.missing.length+' 张图片文件已丢失，不能还原：'+plan.missing.slice(0,5).join('，'));
  for(const [holder,key]of imageSlots(state))if(isMediaUrl(holder[key]))holder[key]=media.resolve(holder[key],{missing:null});
  for(const [conversationId,text]of drafts?.entries()??[])if(state.conversations?.[conversationId])state.conversations[conversationId].draft=text;
  return plan;
 }
 return {
  'media-migrate':{plan:migratePlan,apply:migrate,summary:({rows,...rest})=>({...rest,paths:rows.map(row=>row.path)})},
  // After the store keeps the drafts again, the drafts file must not shadow them.
  // The store must not turn the restored data URLs back into media files.
  'media-revert':{plan:revertPlan,apply:revert,mutateOptions:{storeImages:false},after:()=>drafts?.clear(),summary:({rows,...rest})=>rest},
 };
}
