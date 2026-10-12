// Only accounting and execution metadata escape this adapter. Streams and
// transcripts are read transiently and never added to checkpoints or receipts.
export function parseDshRecord(row,meta){
 if(row.type==='session')return [];
 if(!meta.sessionId||!Number.isSafeInteger(row.seq)||row.seq<0||!row.data||typeof row.data!=='object')throw Error('Harness 日志事件无效');
 const data=row.data,result=[];
 if(row.type==='request/header'){const config=data.header?.config;if(config){meta.provider=String(config.provider||'');meta.model=String(config.model||'');}return result;}
 if(row.type==='request/context'){if(data.provider)meta.provider=String(data.provider);if(data.model)meta.model=String(data.model);return result;}
 if(row.seq<=(meta.dshInheritedCut??-1))return result;
 if(row.type==='llm/retry-started'){
  if(meta.dshAttempt?.turn===data.turn&&meta.dshAttempt.step===data.step)delete meta.dshAttempt;
  // The boundary seq, unlike an ordinal, is stable across rewrites and rescans.
  meta.dshRetry={turn:data.turn,step:data.step,seq:row.seq};return result;
 }
 if(row.type==='turn/start'||row.type==='turn/end'){
  if(!Number.isSafeInteger(data.turn)||data.turn<0)throw Error('Harness 轮次标识缺失');
  const reason=data.reason?.kind,status=row.type==='turn/start'?'running':({completed:'completed',error:'failed',blocked:'waiting',aborted:'paused','max-tokens':'paused',interrupted:'paused',forked:'paused'}[reason]||'unknown');
  result.push({kind:'task',turn:data.turn,status,seq:row.seq,time:row.time,terminal:row.type==='turn/end',outcome:reason||'',model:meta.model||'',provider:meta.provider||''});return result;
 }
 if(!['assistant/message','assistant/attempt'].includes(row.type))return result;
 if(!Number.isSafeInteger(data.turn)||!Number.isSafeInteger(data.step))throw Error('Harness 请求标识缺失');
 let usage=row.type==='assistant/message'?data.usage:undefined;
 if(usage===undefined){for(let i=(data.stream?.length||0)-1;i>=0;i--){const chunk=data.stream[i]?.chunk;if(chunk?.type==='usage'){usage=chunk.usage;break;}}}
 const source=data.message?.source;
 if(source?.provider)meta.provider=String(source.provider);if(source?.model)meta.model=String(source.model);
 if(!meta.dshAttempt||meta.dshAttempt.turn!==data.turn||meta.dshAttempt.step!==data.step){
  const retry=meta.dshRetry;meta.dshAttempt={turn:data.turn,step:data.step,boundary:retry?.turn===data.turn&&retry.step===data.step?retry.seq:'first'};
 }
 const requestId=data.turn+':'+data.step+':'+meta.dshAttempt.boundary;
 // No sample is not a correction. A later surface settlement may omit usage
 // after an attempt has already supplied its authoritative accounting.
 if(usage===undefined&&meta.dshAttempt.reported===true)return result;
 if(usage!==undefined)meta.dshAttempt.reported=true;
 result.push({kind:'usage',requestId,usage:usage&&typeof usage==='object'?usage:{},model:meta.model||'',provider:meta.provider||'',time:row.time,turn:data.turn,step:data.step,seq:row.seq});
 return result;
}
