import {resolveIdentity} from './service-identity.mjs';
import {createReadStream} from 'node:fs';
import {stat,open} from 'node:fs/promises';
import {basename,dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {providerFor} from './token-sources.mjs';
import {dshFileRecords,isDshLog} from './dsh-log.mjs';
import {parseDshRecord} from './dsh-adapter.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const field=(row,path)=>String(path||'').replace(/^\$\.?/,'').replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean).reduce((v,k)=>v?.[k],row);
const number=v=>['number','string'].includes(typeof v)&&v!==''&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
export function timestamp(value){const n=typeof value==='number'?value:null;const t=n!==null?(n<1e11?n*1000:n):Date.parse(value);return Number.isFinite(t)?new Date(t).toISOString():null;}
export function normalizeTokens(raw={},options={}){
 const input=number(raw.input??raw.input_tokens??raw.prompt_tokens??raw.promptTokenCount??raw.total_input_tokens??raw.input_other??raw.inputOther??raw.inputTokens??raw.tokensIn);
 const output=number(raw.output??raw.output_tokens??raw.completion_tokens??raw.candidatesTokenCount??raw.total_output_tokens??raw.outputTokens??raw.tokensOut);
 const cacheRead=number(raw.cacheRead??raw.cached??raw.cache_read_input_tokens??raw.cached_input_tokens??raw.cachedInputTokens??raw.input_cache_read??raw.inputCacheRead??raw.cacheReadTokens??raw.cacheReads??raw.input_tokens_details?.cached_tokens??raw.prompt_tokens_details?.cached_tokens??raw.cachedContentTokenCount??raw.total_cached_tokens??raw.cache?.read);
 const cacheWrite=number(raw.cacheWrite??raw.cache_creation_input_tokens??raw.cacheWriteInputTokens??raw.input_cache_creation??raw.inputCacheCreation??raw.cacheWriteTokens??raw.cacheWrites??raw.cache?.write);
 const reasoning=number(raw.reasoning??raw.thoughts??raw.reasoning_output_tokens??raw.reasoningOutputTokens??raw.thoughtsTokenCount??raw.total_thought_tokens??raw.output_tokens_details?.reasoning_tokens??raw.completion_tokens_details?.reasoning_tokens);
 const reported=number(raw.total??raw.total_tokens??raw.totalTokenCount??raw.totalTokens);
 const total=reported??(input!==null&&output!==null?input+output+(options.cacheIncluded===false?(cacheRead??0)+(cacheWrite??0):0)+(options.reasoningIncluded===false?(reasoning??0):0):null);
 return {input,output,cacheRead,cacheWrite,reasoning,total,requests:1,quality:reported!==null?'reported':total!==null?'calculated':'partial',cacheIncluded:options.cacheIncluded!==false,reasoningIncluded:options.reasoningIncluded!==false};
}
function event(source,row,meta,path,index,usage,extra={}){
 const time=timestamp(extra.timestamp??row.timestamp??row.ts??row.time?.completed??row.time?.created??(typeof row.time==='number'?row.time:null)??row.time_created??meta.startTime);
 const sessionId=String(extra.sessionId??row.sessionId??row.sessionID??row.session_id??meta.sessionId??basename(dirname(path)));
 const model=String(extra.model??(typeof row.model==='object'?row.model?.id:row.model)??row.modelID??row.modelInfo?.id??meta.model??'');
 const reported=String(extra.serviceProvider??row.providerID??row.model?.providerID??row.provider??row.modelInfo?.provider??meta.provider??'');
 const requestId=String(extra.requestId??row.requestId??row.message_id??row.id??row.ts??hash([sessionId,index,time,model,usage]));
 const value={sourceId:source.id,tool:source.tool,sessionId,requestId,explicitRequestId:!!(extra.requestId||row.requestId||row.message_id||row.id),timestamp:time,model,serviceProvider:source.aliasProvider||providerFor(model,reported),reportedProvider:reported,workspace:String(extra.workspace??row.workspace??row.cwd??row.path?.cwd??meta.workspace??meta.directories?.[0]??meta.projectHash??''),purpose:source.purpose??row.purpose??'work',usage,mode:source.mode||'request',cacheIncluded:usage.cacheIncluded,reasoningIncluded:usage.reasoningIncluded,subagent:extra.subagent===true||meta.kind==='subagent',status:['running','completed','failed','waiting','paused'].includes(extra.status)?extra.status:'unknown',location:{file:path,index},adapterVersion:1,...extra,timestamp:time,model,serviceProvider:source.aliasProvider||providerFor(model,reported),reportedProvider:reported,requestId,sessionId,connectionIdentity:row.connectionIdentity};return {...value,...resolveIdentity(value,source)};
}
export function parseTokenRecord(source,row,meta,path,index){
 if(!row||typeof row!=='object')return [];
 if(source.tool==='dsh')return parseDshRecord(row,meta).map(record=>record.kind==='task'?{...record,tool:'dsh',sourceId:source.id,sessionId:meta.sessionId,workspace:meta.workspace,subagent:meta.kind==='subagent',timestamp:timestamp(record.time)}:event({...source,aliasProvider:record.provider?'':source.aliasProvider},row,meta,path,index,normalizeTokens(record.usage,{cacheIncluded:false}),{requestId:record.requestId,model:record.model,serviceProvider:record.provider,turnId:record.turn,cacheIncluded:false,usageAuthority:'replace',feedbackEligible:false,status:'unknown'}));
 if(source.tool==='custom'){
  const mapped=Object.fromEntries(Object.entries(source.mapping||{}).map(([k,p])=>[k,field(row,p)]));
  const u=normalizeTokens(mapped,source);return [event(source,mapped,meta,path,index,u,{status:mapped.status,model:mapped.model,serviceProvider:mapped.provider})];
 }
 if(source.tool==='gemini'){
  if(row.sessionId||row.$set){Object.assign(meta,row.$set||row);delete meta.messages;return [];}
  if(row.type!=='gemini')return [];
  return [event(source,row,meta,path,index,normalizeTokens(row.tokens||{},{reasoningIncluded:false}))];
 }
 if(source.tool==='kimi'){
  const r=row.message||row, p=r.payload||r;
  if(row.type==='config.update'){meta.workspace=row.cwd;return [];}
  // The current TypeScript wire persists usage.record and step.end with the
  // same usage. Only usage.record is authoritative; never count both.
  if(row.type==='context.append_loop_event'&&row.event?.type==='step.end'){meta.stepId=row.event.uuid;meta.completed=row.event.finishReason==='end_turn';return [];}
  if(row.type==='usage.record'&&row.usage)return [event(source,row,meta,path,index,normalizeTokens(row.usage,{cacheIncluded:false}),{requestId:row.id||(row.usageScope!=='session'&&meta.stepId)||hash([meta.sessionId,row.agentId,row.time,row.model,row.usage,row.usageScope]),model:row.model,status:row.usageScope!=='session'&&meta.completed?'completed':'unknown'})];
  if(r.type==='StatusUpdate'&&p.token_usage){if(!p.message_id)return [event(source,row,meta,path,index,normalizeTokens(p.token_usage,{cacheIncluded:false}),{requestId:hash([meta.sessionId,p,row.timestamp]),qualityNote:'no-message-id'})];return [event(source,row,meta,path,index,normalizeTokens(p.token_usage,{cacheIncluded:false}),{requestId:p.message_id,explicitRequestId:true,model:meta.model})];}
  if(row.session_id||row.sessionId||row.model)Object.assign(meta,row);
  return [];
 }
 if(source.tool==='opencode'){
  const data=typeof row.data==='string'?JSON.parse(row.data):row.data||row;
  const r={...row,...data};if(r.role!=='assistant'&&r.type!=='assistant'&&!r.tokens)return [];
  if(!r.tokens)return [];
  const u=normalizeTokens(r.tokens,{cacheIncluded:false,reasoningIncluded:r.__legacy!==false});
  return [event(source,r,meta,path,index,u,{requestId:r.id||row.id,sessionId:r.sessionID||row.session_id||meta.sessionId,subagent:row.subagent===true,status:r.finish==='stop'?'completed':r.error?'failed':'unknown'})];
 }
 if(source.tool==='cline'||source.tool==='roo'){
  if(row.modelInfo?.provider)meta.provider=row.modelInfo.provider;if(row.modelInfo?.id)meta.model=row.modelInfo.id;
  if(row.say==='api_req_started'){
   let metrics;try{metrics=JSON.parse(row.text);}catch{return [];}
   const known=providerFor(meta.model,meta.provider);const cacheIncluded=!['anthropic'].includes(known);
   const u=normalizeTokens(metrics,{cacheIncluded});
   const e=event(source,row,meta,path,index,u,{requestId:String(row.ts),status:'unknown'});
   if(!meta.provider&&(metrics.cacheReads||metrics.cacheWrites)&&metrics.total===undefined){e.usage.total=null;e.usage.quality='partial';e.qualityNote='缓存口径未记录';}return [e];
  }
  if(row.metrics){const u=normalizeTokens(row.metrics,{cacheIncluded:true});return [event(source,row,meta,path,index,u,{status:'completed'})];}
  return [];
 }
 if(source.tool==='companion'){
  if(!row.usage)return [];
  return [event(source,row,meta,path,index,normalizeTokens(row.usage),{requestId:row.requestId||hash([row.sessionId,row.timestamp,row.usage]),sessionId:row.sessionId||row.requestId||basename(path),mode:row.provider==='codex'?'cumulative':'request',purpose:row.purpose||source.purpose||'galgame',status:'unknown'})];
 }
 return [];
}
export function acceptsFile(source,path){
 const name=basename(path);if(source.tool==='gemini')return /^session-.*\.jsonl?$/.test(name);
 if(source.tool==='dsh')return isDshLog(path);
 if(source.tool==='kimi')return name==='wire.jsonl';
 if(source.tool==='cline'||source.tool==='roo')return /^(ui_messages|cline_messages)\.json$/.test(name)||/\.messages\.json$/.test(name);
  if(source.tool==='opencode')return /\.db$/.test(name)||(/\.json$/.test(name)&&/[\\/]message[\\/]/.test(path));
 return source.format&&source.format!=='auto'?(source.format==='sqlite'?/\.(db|sqlite)$/.test(path.toLowerCase()):path.toLowerCase().endsWith('.'+source.format)):/\.(jsonl|json|csv|db|sqlite)$/.test(name);
}
// Bounded streaming decoder for arrays nested under a selected field. Individual
// records are buffered; a multi-GB history is never loaded as one JSON string.
function arrayPosition(text,wanted){
 const stack=[];for(let i=0;i<text.length;i++){const c=text[i],top=stack.at(-1);
  if(c==='"'){let j=i+1,escape=false;for(;j<text.length;j++){if(escape)escape=false;else if(text[j]==='\\')escape=true;else if(text[j]==='"')break;}if(j===text.length)return -1;if(top?.kind==='object'&&top.keyExpected){top.key=JSON.parse(text.slice(i,j+1));top.keyExpected=false;}i=j;continue;}
  if(c==='{'||c==='['){const path=top?(top.kind==='object'?[...top.path,top.key]:[...top.path,String(top.index)]):[];if(c==='['&&JSON.stringify(path)===JSON.stringify(wanted))return i;stack.push({kind:c==='{'?'object':'array',path,keyExpected:true,index:0,key:null});}
  else if(c==='}'||c===']')stack.pop();else if(c===','&&top){if(top.kind==='object')top.keyExpected=true;else top.index++;}
 }return -1;
}
export async function* jsonRecords(path,recordsPath=''){
 const stream=createReadStream(path,{encoding:'utf8',highWaterMark:65536});
 let buffer='',array=false,seek=recordsPath?recordsPath.split('.').at(-1):null,depth=0,string=false,escape=false,start=-1,index=0,scan=0;
 for await(const chunk of stream){buffer+=chunk;
  if(!array){const at=arrayPosition(buffer,recordsPath?recordsPath.replace(/^\$\.?/,'').replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean):buffer.trimStart()[0]==='['?[]:['messages']);
   if(at>=0){const prefix=buffer.slice(0,at);let meta={};try{let braces=0,quoted=false,escaped=false;for(const c of prefix){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')braces++;else if(c==='}')braces--;}meta=JSON.parse(prefix+'[]'+'}'.repeat(braces));}catch{}yield {metadata:meta};buffer=buffer.slice(at+1);array=true;scan=0;}
   else{if(buffer.length>8*1024*1024)throw Error('单条 JSON 记录超过 8 MB');continue;}
  }
  for(let i=scan;i<buffer.length;i++){const c=buffer[i];if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}if(c==='"'){string=true;continue;}if(c==='{'||c==='['){if(depth===0)start=i;depth++;}else if(c==='}'||c===']'){if(depth===0&&c===']')return;depth--;if(depth===0&&start>=0){const value=JSON.parse(buffer.slice(start,i+1));yield {row:value,index:index++};buffer=buffer.slice(i+1);i=-1;start=-1;}}
  }scan=buffer.length;if(buffer.length>8*1024*1024)throw Error('单条 JSON 记录超过 8 MB');
 }
 if(!array){const value=JSON.parse(buffer.replace(/^\uFEFF/,''));const rows=recordsPath?field(value,recordsPath):value.messages||value;yield {metadata:Array.isArray(value)?{}:value};for(const [i,row] of (Array.isArray(rows)?rows:[rows]).entries())yield {row,index:i};}
 else if(depth||string)throw Error('JSON 尚未写入完整');
}
export async function* csvRecords(path){
 const lines=createInterface({input:createReadStream(path,{encoding:'utf8'}),crlfDelay:Infinity});let row=[],cell='',quoted=false,head,index=0;
 for await(const line of lines){for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else cell+=c;}if(quoted){cell+='\n';continue;}row.push(cell);cell='';if(!head)head=row.map(x=>x.replace(/^\uFEFF/,''));else yield {row:Object.fromEntries(head.map((key,i)=>[key,row[i]])),index:index++};row=[];}if(quoted)throw Error('CSV 尚未写入完整');
}
export async function* sqliteRecords(path,source){
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path,{readOnly:true,timeout:150});
 try{db.exec('PRAGMA query_only=ON');const tables=db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r=>r.name);
  yield {schema:tables.map(name=>({name,columns:/^\w+$/.test(name)?db.prepare('PRAGMA table_info("'+name+'")').all().map(c=>c.name):[]}))};
  const table=source.table||(tables.includes('session_message')?'session_message':tables.includes('message')?'message':null);if(!table&&source.tool==='custom')return;if(!table||!tables.includes(table)||!/^\w+$/.test(table))throw Error('请选择已有表或视图');
  const columns=db.prepare('PRAGMA table_info("'+table+'")').all().map(c=>c.name),incremental=columns.includes('time_updated')&&(source.tool!=='custom'||!!source.mapping?.id);let cursor=source.readCursor||0,index=0;
  const sessionTable=tables.includes('session_v2')?'session_v2':tables.includes('session')?'session':null,sessionMeta=new Map();
  if(source.tool==='opencode'&&sessionTable){const available=db.prepare('PRAGMA table_info("'+sessionTable+'")').all().map(c=>c.name),selected=['id','directory','parent_id'].filter(c=>available.includes(c));if(selected.includes('id'))for(const s of db.prepare('SELECT '+selected.map(c=>'"'+c+'"').join(',')+' FROM "'+sessionTable+'"').iterate())sessionMeta.set(s.id,s);}
  const statement=db.prepare('SELECT * FROM "'+table+'"'+(incremental?' WHERE time_updated >= ? ORDER BY time_updated':''));
  for(const row of (incremental?statement.iterate(cursor):statement.iterate())){if(incremental&&typeof row.time_updated==='number')cursor=Math.max(cursor,row.time_updated);const s=sessionMeta.get(row.session_id);yield {row:{...row,workspace:s?.directory,subagent:!!s?.parent_id,__legacy:table!=='session_message'},index:index++};}
  yield {sqliteCursor:incremental?cursor:null};
 }finally{db.close();}
}
export async function* fileRecords(path,source,offset=0){
 if(source.tool==='dsh'||source.format==='jsonl.zstd'){yield* dshFileRecords(path,offset);return;}
 const format=source.format==='auto'||!source.format?(/\.(db|sqlite)$/.test(path)?'sqlite':path.endsWith('.jsonl')?'jsonl':path.endsWith('.csv')?'csv':'json'):source.format;
 if(format==='json'){yield* jsonRecords(path,source.recordsPath);return;}
 if(format==='csv'){yield* csvRecords(path);return;}
 if(format==='sqlite'){yield* sqliteRecords(path,source);return;}
 const handle=await open(path,'r');let position=offset,committed=offset,pending=Buffer.alloc(0),index=0;
 try{const size=(await handle.stat()).size,chunk=Buffer.alloc(65536);while(position<size){const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,size-position),position);position+=bytesRead;if(!bytesRead)break;pending=Buffer.concat([pending,chunk.subarray(0,bytesRead)]);let n;while((n=pending.indexOf(10))>=0){const line=pending.subarray(0,n).toString('utf8').replace(/^\uFEFF/,'');pending=pending.subarray(n+1);const at=committed;committed+=n+1;if(!line.trim())continue;try{yield {row:JSON.parse(line),index:at,offset:committed};}catch{yield {invalid:true,index:at,offset:committed};}index++;}if(pending.length>8*1024*1024)throw Error('单条日志超过 8 MB');}yield {offset:committed};}finally{await handle.close();}
}
