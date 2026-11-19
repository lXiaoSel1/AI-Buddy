import {getModelSubmissionState} from './model-submission.mjs';

const namespace='daily-memory-checkpoint-v1';
const knownUnsent=new Set(['MEMORY_PROVIDER_DISABLED','MEMORY_CONTEXT_CAPACITY','MEMORY_STALE_LIFE','MEMORY_REQUEST_NOT_SENT']);
const unknown=()=>Object.assign(Error('记忆整理的上一次模型请求结果待核对，已保留原文和已完成段'),{code:'MEMORY_CHECKPOINT_UNKNOWN'});

export function dailyMemorySegmentPlan(archive,key){
 let plan=null,revision=0;
 if(archive)for(let next;(next=archive.get(namespace,key+':plan:'+revision));revision++)plan=next;
 return {plan,async save(next){
  if(archive&&JSON.stringify(plan)!==JSON.stringify(next))await archive.putMany([{namespace,id:key+':plan:'+revision,value:next}]);
 }};
}

export function dailyMemoryDispatches(archive,dayKey){
 const prefix=dayKey+':dispatch:';
 const latest=archive?.lastByPrefix(namespace,prefix);
 let sequence=latest?.sequence??0;
 return {
  assertSettled(){if(latest&&!archive.get(namespace,latest.id+':settled'))throw unknown();},
  begin(id){return {namespace,id:prefix+String(++sequence).padStart(12,'0'),value:{id,sequence}};},
 };
}

export async function runDailyMemoryCheckpoint(archive,dispatches,key,maxTokens,execute){
 if(!archive)return execute();
 const resultId=key+':result',truncationId=key+':truncated:'+maxTokens;
 const existing=archive.get(namespace,resultId);
 if(existing?.state==='accepted')return existing.value;
 if(existing?.state==='unknown')throw unknown();
 if(archive.get(namespace,truncationId))throw Object.assign(Error('记忆整理输出达到上限'),{code:'MODEL_OUTPUT_TRUNCATED'});

 const row=(id,value)=>({namespace,id,value});
 let attempt=1,id=key+':'+attempt;
 while(archive.get(namespace,id+':started')){
  if(!archive.get(namespace,id+':retryable'))throw unknown();
  id=key+':'+(++attempt);
 }
 await archive.putMany([dispatches.begin(id),row(id+':started',{state:'started'})]);
 const settled=row(id+':settled',{state:'settled'}),retryable=row(id+':retryable',{state:'retryable'});
 let value;
 try{value=await execute();}
 catch(error){
  const code=error?.code;
  if(code==='MODEL_OUTPUT_TRUNCATED')await archive.putMany([row(truncationId,{state:'truncated'}),retryable,settled]);
  else if(code==='MEMORY_VALIDATION'||knownUnsent.has(code)||getModelSubmissionState(error)?.phase==='not-sent')await archive.putMany([retryable,settled]);
  else{await archive.putMany([row(resultId,{state:'unknown'})]);throw unknown();}
  throw error;
 }
 await archive.putMany([row(resultId,{state:'accepted',value}),settled]);
 return value;
}
