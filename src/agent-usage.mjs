const FIELDS=Object.freeze({inputTokens:'input_tokens',outputTokens:'output_tokens',totalTokens:'total_tokens',cachedInputTokens:'cached_input_tokens',cacheWriteInputTokens:'cache_write_input_tokens',reasoningOutputTokens:'reasoning_output_tokens'});
function nativeCounters(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const result={};for(const key of Object.keys(FIELDS))if(Object.hasOwn(value,key)){if(typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<0)return null;result[key]=value[key];}
  if(result.inputTokens==null||result.outputTokens==null)return null;return result;
}
const ledgerCounters=value=>Object.fromEntries(Object.entries(value).map(([key,count])=>[FIELDS[key],count]));

/** Only the same native session's recorded cumulative evidence can be a base. */
export function lastAgentUsageBaseline(task,sessionId=task?.sessionId){
  if(typeof sessionId!=='string'||!sessionId)return undefined;
  for(let index=(task?.events?.length??0)-1;index>=0;index--){const event=task.events[index];if(event.type!=='usage'||event.replay||event.sessionId!==sessionId)continue;const value=nativeCounters(event.payload?.cumulative);if(value)return {...value};}
  return undefined;
}

/** Diagnostic usage is a delta; the existing Codex ledger consumes totals. */
export function buildAgentUsageRecords(value,{timestamp=new Date().toISOString()}={}){
  const sessionId=typeof value.nativeSessionId==='string'&&value.nativeSessionId?value.nativeSessionId:null,delta=nativeCounters(value.usage),cumulative=nativeCounters(value.cumulative);
  const common={purpose:'work',taskId:value.taskId,workspaceId:value.workspaceId,workspace:value.workspace,nativeSessionId:sessionId,sessionId,turnId:value.turnId??null,requestId:value.requestId,eventId:value.eventId,model:value.connection?.model??value.model,timestamp,connectionIdentity:value.connectionIdentity??null};
  const diagnostic={...common,usage:delta?ledgerCounters(delta):null,cumulative:cumulative?ledgerCounters(cumulative):null,billable:value.billable!==false,usageMode:'delta'};
  // Never synthesize an accumulator from a delta or use a task ID as native ID.
  const ledger=sessionId&&cumulative&&delta&&value.billable!==false?{...common,usage:ledgerCounters(cumulative),usageMode:'cumulative'}:null;
  return {diagnostic,ledger};
}
