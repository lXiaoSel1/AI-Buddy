import {migrateGeneric} from './usage-generic-migrate.mjs';
import {UsageRepository} from './usage-repository.mjs';
import {SqlUsageQuery} from './usage-query-sqlite.mjs';
import {ServiceAttribution} from './service-attribution.mjs';
import {resolveIdentity,platformCatalog} from './service-identity.mjs';
import {readdir,stat,open,appendFile,mkdir} from 'node:fs/promises';
import {createReadStream,watch} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {LocalMonitor} from './monitor.mjs';
import {dayOf,emptyUsage} from './ledger.mjs';
import {UsageLedger} from './ledger.mjs';
import {UsageQuery,resolveZone} from './usage-query.mjs';
import {PriceService} from './pricing.mjs';
import {TokenSources,TOOL_NAMES,providerFor} from './token-sources.mjs';
import {fileRecords,acceptsFile,parseTokenRecord} from './token-adapters.mjs';
import {inspectDshLog,selectDshLogs} from './dsh-log.mjs';
import {createSnapshotStorage,readJson} from './storage.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sum=(a,b)=>{for(const k of Object.keys(emptyUsage())){a[k]+=(typeof b[k]==='number'?b[k]:0);if(k==='requests')continue;const missing=b.fieldMissing?.[k]||(b[k]===null&&b.requests>0?b.requests:0);if(missing){a.fieldMissing??={};a.fieldMissing[k]=(a.fieldMissing[k]||0)+missing;}}return a;};
const total=row=>Object.values(row).filter(v=>v&&typeof v==='object'&&typeof v.total==='number').reduce((n,u)=>n+u.total,0);
export class GenericTokenLedger {
 constructor(repository=null){this.repository=repository;this.records=repository?repository.map("generic"):new Map();this.pending=[];this.revision=0;this.startedAt=Date.now();this.groups=repository?{keys:()=>repository.groups(['generic']),get(key){return {values:function*(){for(const[,v]of repository.entries('generic',{group:key,ordered:true}))yield v;}};}}:new Map();this.dirtyGroups=new Set();this.snapshotBuilds=0;}
 ingest(event,persist=true){
  if(!event.timestamp)return false;
  const key=event.tool+':'+event.sessionId+':'+event.requestId,old=this.records.get(key),value={...event,key,workBase:old?.workBase??(event.workEligible===false?(event.usage.total||0):0)};
  if(old){if(JSON.stringify(old.usage)===JSON.stringify(value.usage)&&old.status===value.status&&old.model===value.model&&old.reportedProvider===value.reportedProvider&&JSON.stringify(old.connectionIdentity)===JSON.stringify(value.connectionIdentity))return false;
   // Streaming corrections update the same request; totals never regress silently.
   if(event.tool!=='dsh'||event.usageAuthority!=='replace')for(const k of Object.keys(emptyUsage()))if(old.usage[k]!==null&&(value.usage[k]===null||value.usage[k]<old.usage[k]))value.usage[k]=old.usage[k];
  }
  this.records.set(key,value);const group=event.tool+':'+event.sessionId;if(!this.repository){if(!this.groups.has(group))this.groups.set(group,new Map());this.groups.get(group).set(key,value);}this.dirtyGroups.add(group);this.revision++;if(persist&&!this.repository)this.pending.push(value);return true;
 }
 snapshot(sources,now=Date.now(),legacySessions=new Set()){
  const signature=JSON.stringify([this.revision,sources.map(s=>[s.id,s.overlapGroup,s.primary]),[...legacySessions]]);
  if(this.cached?.signature===signature){const v=this.cached.value;return {...v,sessions:v.sessions.map(s=>({...s,displayStatus:s.status==='running'&&now-Date.parse(s.lastActivity)>120000?'unknown':s.status}))};}this.snapshotBuilds++;
  const totals={},daily=new Map(),sessions=new Map(),projects=new Map(),cube=new Map(),groups=new Map(),settings=new Map(sources.map(s=>[s.id,s])),startedAt=this.startedAt;let missingRequests=0,workSinceStart=0;
  for(const row of this.records.values()){if(row.tool==='companion'&&row.reportedProvider==='codex'&&legacySessions.has(row.sessionId))continue;const source=settings.get(row.sourceId);if((source?.overlapGroup||row.overlapGroup)&&(source?.primary??row.primary)===false)continue;
   if(row.mode==='cumulative'){if(this.repository)continue;const k=row.tool+':'+row.sessionId;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(row);}else add(row,row.usage);
  }
  const cumulative=this.repository?(function*(repo){for(const key of repo.groups(['generic']))yield (function*(){for(const[,r]of repo.entries('generic',{group:key,ordered:true,tieRequest:true})){const source=settings.get(r.sourceId);if(r.mode!=='cumulative'||(source?.overlapGroup||r.overlapGroup)&&(source?.primary??r.primary)===false||r.tool==='companion'&&r.reportedProvider==='codex'&&legacySessions.has(r.sessionId))continue;yield r;}})();})(this.repository):groups.values();
  for(let rows of cumulative){if(!this.repository)rows.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)||String(a.requestId).localeCompare(String(b.requestId)));let previous=emptyUsage();for(const r of rows){if(r.usage.total===null){add(r,r.usage);continue;}if(r.usage.total<previous.total)continue;const u={...r.usage};for(const k of Object.keys(emptyUsage()))if(k!=='requests'&&u[k]!==null)u[k]=Math.max(0,u[k]-(previous[k]||0));u.requests=u.total>0?1:0;add(r,u);for(const k of Object.keys(emptyUsage()))previous[k]=Math.max(previous[k]||0,r.usage[k]||0);}}
  function add(r,u){r={...r,...resolveIdentity(r,settings.get(r.sourceId))};const key=r.tool+':'+r.sessionId;let s=sessions.get(key);if(!s){s={key,id:r.sessionId,provider:r.tool,tool:r.tool,sourceId:r.sourceId,workspace:r.workspace,model:r.model,serviceProvider:r.serviceProvider,reportedProvider:r.reportedProvider,companion:r.purpose!=='work',purpose:r.purpose,subagent:r.subagent,status:'unknown',displayStatus:'unknown',usage:emptyUsage(),missingRequests:0,lastActivity:null,createdAt:r.timestamp};sessions.set(key,s);}
   if(!s.lastActivity||Date.parse(r.timestamp)>=Date.parse(s.lastActivity)){Object.assign(s,{lastActivity:r.timestamp,model:r.model,serviceProvider:r.serviceProvider,status:r.status,displayStatus:r.status,feedbackEligible:r.tool!=='dsh'&&r.workEligible===true&&Date.parse(r.timestamp)>=startedAt&&(r.observedAt||0)>=startedAt});}
   if(!totals[r.tool])totals[r.tool]=emptyUsage();sum(totals[r.tool],u);sum(s.usage,u);
   const date=dayOf(r.timestamp);if(!daily.has(date))daily.set(date,{date});const d=daily.get(date);if(!d[r.tool])d[r.tool]=emptyUsage();sum(d[r.tool],u);
   const dimensions={date,tool:r.tool,sourceId:r.sourceId,model:r.model,serviceProvider:r.serviceProvider,workspace:r.workspace||'未记录项目',purpose:r.purpose};const dimensionKey=JSON.stringify(dimensions);if(!cube.has(dimensionKey))cube.set(dimensionKey,{...dimensions,usage:emptyUsage(),missingRequests:0});sum(cube.get(dimensionKey).usage,u);if(u.total===null)cube.get(dimensionKey).missingRequests++;
   const project=r.workspace||'未记录项目';if(!projects.has(project))projects.set(project,{workspace:project,sessions:0});const p=projects.get(project);if(!p[r.tool])p[r.tool]=emptyUsage();sum(p[r.tool],u);
   if(u.total===null){s.missingRequests++;missingRequests++;}
   if(r.purpose==='work'&&r.workEligible!==false&&Date.parse(r.timestamp)>=startedAt&&(r.observedAt===undefined||r.observedAt>=startedAt))workSinceStart+=Math.max(0,(u.total||0)-(r.mode==='cumulative'?0:r.workBase||0));
  }
  for(const s of sessions.values()){const p=projects.get(s.workspace||'未记录项目');if(p)p.sessions++;if(s.status==='running'&&now-Date.parse(s.lastActivity)>120000)s.displayStatus='unknown';}
  const value={totals,cube:[...cube.values()],daily:[...daily.values()],projects:[...projects.values()],sessions:[...sessions.values()],missingRequests,workSinceStart};this.cached={signature,value:structuredClone(value)};return value;
 }
}
export function mergeSnapshots(legacy,generic,sources,aliases={}){
 const result={...legacy,totals:{...legacy.totals},toolNames:{...TOOL_NAMES},missingRequests:generic.missingRequests,sourceCount:sources.length};
 const daily=new Map(legacy.daily.map(r=>[r.date,{...r}])),projects=new Map(legacy.projects.map(r=>[r.workspace,{...r}]));
 for(const [k,u] of Object.entries(generic.totals))result.totals[k]=sum({...result.totals[k]||emptyUsage()},u);
 for(const row of generic.daily){const r=daily.get(row.date)||{date:row.date};for(const [k,u] of Object.entries(row))if(k!=='date')r[k]=sum({...r[k]||emptyUsage()},u);daily.set(row.date,r);}
 for(const row of generic.projects){const r=projects.get(row.workspace)||{workspace:row.workspace,sessions:0};r.sessions+=row.sessions;for(const [k,u] of Object.entries(row))if(!['workspace','sessions'].includes(k))r[k]=sum({...r[k]||emptyUsage()},u);projects.set(row.workspace,r);}
 result.sessions=[...legacy.sessions.map(s=>({...s,tool:s.provider,...resolveIdentity({...s,tool:s.provider}),purpose:s.companion?(/_cg/.test(s.origin||'')?'cg':'galgame'):'work',sourceId:'legacy-'+s.provider})),...generic.sessions].sort((a,b)=>Date.parse(b.lastActivity||0)-Date.parse(a.lastActivity||0));
 result.daily=[...daily.values()].sort((a,b)=>b.date.localeCompare(a.date));result.projects=[...projects.values()].sort((a,b)=>total(b)-total(a));result.todayUsage=daily.get(legacy.today)||{date:legacy.today};
 result.workSinceStart=(legacy.workSinceStart||0)+generic.workSinceStart;result.workTotal=legacy.workTotal+generic.sessions.filter(s=>!s.companion).reduce((n,s)=>n+s.usage.total,0);
 result.active=result.sessions.filter(s=>['running','waiting','failed'].includes(s.displayStatus)&&Date.now()-Date.parse(s.lastActivity)<86400000).map(s=>s.key);
 result.cube=[...(legacy.cube||[]).map(r=>({...r,...resolveIdentity(r)})),...(generic.cube||[])];result.aliases=aliases;return result;
}
export class TokenMonitor {
 constructor(options){this.options=options;this.sources=new TokenSources(options);this.repository=options.persistentHistory===false?null:new UsageRepository(join(options.dataRoot,"usage-ledger-v2","generic.sqlite"));this.ledger=new GenericTokenLedger(this.repository);this.files=new Map();this.closed=false;this.busy=false;this.watchers=[];this.errors=new Map();this.listeners=options.onUpdate||(()=>{});this.onSources=options.onSources||(()=>{});this.onTaskFeedback=options.onTaskFeedback||(()=>{});this.taskStates=new Map();this.terminalWatermarks=new Map();this.pendingFeedback=[];this.cacheRevision=0;this.cache=createSnapshotStorage(join(options.dataRoot,'token-index-v1.json'),{retainText:false,compactReceipt:true});this.dataFile=join(options.dataRoot,'token-events-v1.jsonl');this.refreshIntervalMs=options.refreshIntervalMs||1000;this.lastDiscovery=0;this.revision=0;this.knownSources=new Set();this.warm=false;this.attribution=new ServiceAttribution(options.dataRoot);this.analytics=this.repository?new SqlUsageQuery(this.repository,r=>this.attribution.resolve(r,this.analyticsSourceMap?.get(r.sourceId))):new UsageQuery(r=>this.attribution.resolve(r,this.analyticsSourceMap?.get(r.sourceId)));this.analyticsSources=this.repository?.meta("analyticsSources");this.prices=new PriceService({dataRoot:options.dataRoot});this.timeZone=resolveZone(options.statisticsTimeZone||"America/New_York");}
 start(){return this.starting??=this.initialize();}
 async initialize(){await this.prices.ready;await this.attribution.ready;await this.sources.init();const cache=this.repository?.meta("state")??await readJson(this.cache,{files:[]});this.files=new Map(cache.files);this.taskStates=new Map(cache.taskStates||[]);this.terminalWatermarks=new Map(cache.terminalWatermarks||[]);
  if(this.repository)await migrateGeneric(this.repository,this.dataFile,this.ledger,cache);else try{const reader=createInterface({input:createReadStream(this.dataFile),crlfDelay:Infinity});for await(const line of reader){let row;try{row=JSON.parse(line);}catch{continue;}this.ledger.ingest(row,false);}}catch(e){if(e.code!=='ENOENT')throw e;}
  if(this.repository)this.repository.publish({ready:true,state:cache});
  await this.restartLegacy();await this.scan(true);if(this.closed)return this;this.warm=true;this.timer=setInterval(()=>void this.scan(false).catch(e=>this.errors.set('scan',e.message)),this.refreshIntervalMs);return this;
 }
 // Restarts run one after another, so two quick source changes cannot leave an
 // earlier monitor running unseen (D2-5). A failed start is shown in errors.
 restartLegacy(){
  const run=async()=>{if(this.legacy)await this.legacy.close();const roots=this.sources.list().filter(s=>s.enabled&&['codex','claude'].includes(s.tool)).map(s=>({provider:s.tool,path:s.path}));this.legacy=new LocalMonitor({...this.options,persistentHistory:!!this.repository,roots,refreshIntervalMs:this.refreshIntervalMs,onUpdate:v=>{this.legacySnapshot=v;this.emit();}});
   try{await this.legacy.start();this.errors.delete('legacy-monitor');}catch(error){this.errors.set('legacy-monitor','用量监控启动失败：'+error.message);this.emit();throw error;}};
  return this.legacyRestart=(this.legacyRestart??Promise.resolve()).catch(()=>{}).then(run);
 }
 setRefreshInterval(ms){this.refreshIntervalMs=ms;this.legacy?.setRefreshInterval(ms);if(this.timer){clearInterval(this.timer);this.timer=setInterval(()=>void this.scan(false).catch(e=>this.errors.set('scan',e.message)),ms);}}
 genericSnapshot(){
  const value=this.ledger.snapshot(this.sources.list(),Date.now(),new Set(this.legacySnapshot?.sessions.filter(s=>s.provider==='codex'&&s.usage.total>0).map(s=>s.id)||[]));
  for(const task of this.taskStates.values()){
   let session=value.sessions.find(s=>s.key===task.key);
   if(!session){session={key:task.key,id:task.sessionId,tool:'dsh',provider:'dsh',sourceId:task.sourceId,workspace:task.workspace,model:task.model,serviceProvider:providerFor(task.model,task.provider),reportedProvider:task.provider,companion:false,purpose:'work',subagent:task.subagent,usage:{...emptyUsage(),input:null,output:null,cacheRead:null,cacheWrite:null,reasoning:null,total:null},missingRequests:0,createdAt:task.timestamp};value.sessions.push(session);}
   Object.assign(session,{status:task.status,displayStatus:task.status,lastActivity:task.timestamp,turnId:task.turn,feedbackEligible:false});
   if(!session.model&&task.model)session.model=task.model;
  }return value;
 }
 emit(){if(!this.legacySnapshot)return;this.listeners({activityEpoch:this.legacy.startedAt,usageRevision:this.legacy.ledger.aggregationRevision+':'+this.ledger.revision,...mergeSnapshots(this.legacySnapshot,this.genericSnapshot(),this.sources.list(),this.sources.state?.aliases),modelAliases:this.sources.state?.modelAliases||{},errors:[...this.legacySnapshot.errors,...this.errors].map(e=>Array.isArray(e)?{path:e[0],message:e[1]}:e)});}
 recordTask(event,source){
  if(!event.timestamp)return;
  const key='dsh:'+event.sessionId,old=this.taskStates.get(key);
  if(!old||event.seq>=old.seq&&event.turn>=old.turn){this.taskStates.set(key,{...event,key});this.cacheRevision++;}
  if(!event.terminal)return;
  const watermark=this.terminalWatermarks.get(key),seen=typeof watermark==='object'?watermark.seq:watermark??-1,seenTurn=typeof watermark==='object'?watermark.turn:-1;
  if(event.seq<=seen)return;
  this.terminalWatermarks.set(key,{seq:event.seq,turn:Math.max(seenTurn,event.turn)});this.cacheRevision++;
  if(event.turn<=seenTurn)return;
  if(!this.warm||!this.knownSources.has(source.id)||Date.parse(event.timestamp)<this.ledger.startedAt||!['completed','error'].includes(event.outcome)||source.primary===false)return;
  this.pendingFeedback.push({eventId:key+':'+event.turn+':'+event.seq,provider:'dsh',sessionKey:key,turnKey:event.turn,source:event.outcome==='completed'?'completed':'failed',outcome:event.outcome==='completed'?'completed':'failed',id:event.outcome==='completed'?'jump':'fail',cycles:event.outcome==='completed'?2:1,text:event.outcome==='completed'?'DeepSeek Harness完成任务啦，辛苦了～':'DeepSeek Harness日志记录了错误，点我查看。'});
 }
 async discover(source,path=source.path,found=[]){try{const info=await stat(path);if(info.isFile()){if(acceptsFile(source,path))found.push(path);return found;}for(const item of await readdir(path,{withFileTypes:true})){if(item.isSymbolicLink()||['node_modules','.git'].includes(item.name))continue;if(item.isDirectory())await this.discover(source,join(path,item.name),found);else if(item.isFile()&&acceptsFile(source,join(path,item.name)))found.push(join(path,item.name));}}catch(e){if(e.code!=='ENOENT')throw e;}return found;}
 async scan(full=false){if(this.busy&&!full)return;while(this.busy&&!this.closed)await new Promise(r=>setTimeout(r,10));if(this.closed)return;this.busy=true;try{
  const sources=this.sources.list().filter(s=>s.enabled&&!['codex','claude'].includes(s.tool));
  if(full||Date.now()-this.lastDiscovery>30000){this.paths=[];for(const source of sources){try{const found=await this.discover(source),paths=source.tool==='dsh'?selectDshLogs(found):found;this.paths.push(...paths.map(path=>({path,source})));if(!this.watchers.some(w=>w.path===source.path)){try{const watcher=watch(source.path,{recursive:true},()=>{this.lastDiscovery=0;void this.scan(false);});watcher.on('error',()=>{});this.watchers.push({path:source.path,watcher});}catch{}}}catch(e){this.sources.statuses.set(source.id,{message:e.code==='EACCES'?'无读取权限':e.message});}}this.lastDiscovery=Date.now();}
  void this.prices.tick().catch(()=>{});
  const enabled=new Set(sources.map(s=>s.id)),counts=new Map(),failedSources=new Set();
  for(const {path,source:stale} of this.paths||[]){if(!enabled.has(stale.id))continue;const source=sources.find(s=>s.id===stale.id);try{const result=await this.read(path,source);const count=counts.get(source.id)||{records:0,missing:0};count.records+=result.records;count.missing+=result.missing;counts.set(source.id,count);this.errors.delete(path);}catch(e){failedSources.add(source.id);this.errors.set(path,e.message);this.sources.statuses.set(source.id,{message:e.code==='EACCES'?'无读取权限':e.message});}}
  for(const [id,c] of counts)if(!failedSources.has(id))this.sources.statuses.set(id,{...c,message:c.records?(c.missing?'部分记录缺少用量':'正常读取'):'等待首次请求',updatedAt:new Date().toISOString()});
  for(const source of this.sources.list().filter(s=>s.enabled&&['codex','claude'].includes(s.tool))){const prefix=resolve(source.path).toLowerCase(),sessions=this.legacySnapshot?.sessions.filter(s=>s.provider===source.tool&&s.path&&(resolve(s.path).toLowerCase()===prefix||resolve(s.path).toLowerCase().startsWith(prefix+'\\')))||[];if(sessions.length)this.sources.statuses.set(source.id,{records:sessions.length,message:sessions.some(s=>s.usage.total>0)?'正常读取':'已读取记录，但未提供 token 用量',updatedAt:new Date().toISOString()});}
  for(const source of sources)this.knownSources.add(source.id);await this.persist();this.emit();for(const event of this.pendingFeedback.splice(0))this.onTaskFeedback(event);this.onSources(await this.sources.view());
 }finally{this.busy=false;}}
 async read(path,source){const info=await stat(path),wal=await stat(path+'-wal').catch(()=>null),stamp=info.mtimeMs+':'+(wal?.mtimeMs||0)+':'+(wal?.size||0),key=source.id+':'+path,old=this.files.get(key);
  const signature=hash(JSON.stringify(source));if(old&&old.size===info.size&&old.stamp===stamp&&old.signature===signature)return old.counts;
  const handle=await open(path,'r'),fingerprint=async(position,length)=>{const bytes=Buffer.alloc(length);const r=await handle.read(bytes,0,length,position);return hash(bytes.subarray(0,r.bytesRead));};
  let offset=(path.endsWith('.jsonl')||path.endsWith('.jsonl.zstd'))&&old?.signature===signature?old.offset||0:0;
  if(offset&&(info.size<offset||await fingerprint(0,old.headLength)!==old.head||await fingerprint(Math.max(0,offset-4096),Math.min(offset,4096))!==old.anchor))offset=0;
  let sqliteCursor=old?.signature===signature?old.sqliteCursor:null,committed=offset,records=offset?old.counts.records:0,missing=offset?old.counts.missing:0,meta=offset?{...old.meta}:{};
  let checkpointMeta=structuredClone(meta),checkpointCounts={records,missing},failure;
  if(sqliteCursor&&(info.size<old.size||await fingerprint(0,old.headLength)!==old.head))sqliteCursor=null;
  if(source.tool==='kimi'){const parts=path.split(/[\\/]/),at=parts.lastIndexOf('sessions');meta.sessionId=parts[at+2]||basename(path);meta.kind=parts.includes('agents')&&parts.at(-2)!=='main'?'subagent':'main';if(meta.kind==='subagent')meta.sessionId+=':'+parts.at(-2);}
  try{
   if(source.tool==='dsh'&&!offset){const header=await inspectDshLog(path);if(header)Object.assign(meta,header);checkpointMeta=structuredClone(meta);}
   try{for await(const item of fileRecords(path,{...source,readCursor:sqliteCursor},offset)){
    if(item.metadata)Object.assign(meta,item.metadata);
    if(item.checkpoint){committed=item.offset;checkpointMeta=structuredClone(meta);checkpointCounts={records,missing};}
    else if(item.offset!==undefined)committed=item.offset;
    if(item.sqliteCursor!==undefined)sqliteCursor=item.sqliteCursor;if(!item.row)continue;
    for(const event of parseTokenRecord(source,item.row,meta,path,item.index)){
     if(event.kind==='task'){this.recordTask(event,source);continue;}
     if(!event.timestamp){missing++;continue;}event.overlapGroup=source.overlapGroup;event.primary=source.primary;event.observedAt=Date.now();event.workEligible=this.warm&&this.knownSources.has(source.id);this.ledger.ingest(event);records++;if(event.usage.total===null)missing++;
    }if(records%200===0)await new Promise(r=>setImmediate(r));
   }}catch(error){failure=error;}
   const headLength=Math.min(committed||info.size,4096),head=await fingerprint(0,headLength),anchor=await fingerprint(Math.max(0,committed-4096),Math.min(committed,4096));
   const counts=source.tool==='dsh'?checkpointCounts:{records,missing},safeMeta=Object.fromEntries(Object.entries(source.tool==='dsh'?checkpointMeta:meta).filter(([key])=>['sessionId','session_id','projectHash','startTime','directories','kind','model','provider','workspace','stepId','completed','dshVersion','dshInheritedCut','dshSeeded','dshAttempt','dshRetry'].includes(key)));
   this.files.set(key,{size:info.size,stamp:failure?null:stamp,signature,offset:committed,headLength,head,anchor,meta:safeMeta,counts,sqliteCursor});this.cacheRevision++;
   if(failure)throw failure;return counts;
  }finally{await handle.close();}
 }
 async persist(){if(this.repository){if(this.savedRevision===this.ledger.revision&&this.savedCacheRevision===this.cacheRevision)return;this.repository.publish({ready:true,state:{version:2,files:[...this.files],taskStates:[...this.taskStates],terminalWatermarks:[...this.terminalWatermarks]}});this.savedRevision=this.ledger.revision;this.savedCacheRevision=this.cacheRevision;return;}if(!this.ledger.pending.length&&this.savedRevision===this.ledger.revision&&this.savedCacheRevision===this.cacheRevision)return;await mkdir(this.options.dataRoot,{recursive:true});const pending=this.ledger.pending.splice(0);try{if(pending.length)await appendFile(this.dataFile,pending.map(r=>JSON.stringify(r)).join('\n')+'\n');await this.cache.writeText(JSON.stringify({version:1,files:[...this.files],taskStates:[...this.taskStates],terminalWatermarks:[...this.terminalWatermarks]}));this.savedRevision=this.ledger.revision;this.savedCacheRevision=this.cacheRevision;}catch(e){this.ledger.pending.unshift(...pending);throw e;}}
 syncAnalytics(){
  if(!this.repository)return this.syncAnalyticsRows();
  const legacy=this.legacy.repository;
  for(const key of legacy.changedGroups())this.legacy.ledger.dirtyRequestSessions.add(key);
  for(const key of this.repository.changedGroups())this.ledger.dirtyGroups.add(key);
  const dirtyLegacy=[...this.legacy.ledger.dirtyRequestSessions],dirtyGeneric=[...this.ledger.dirtyGroups],signature=this.analyticsSources;
  try{this.repository.transaction(()=>{this.syncAnalyticsRows();this.repository.acknowledgeChanges();});
   // The separate legacy connection is acknowledged after contribution commit.
   // A crash between the two safely repeats an idempotent group replacement.
   legacy.acknowledgeChanges();
  }catch(e){this.analyticsSources=signature;for(const k of dirtyLegacy)this.legacy.ledger.dirtyRequestSessions.add(k);for(const k of dirtyGeneric)this.ledger.dirtyGroups.add(k);this.analytics.restoreIndex();throw e;}
 }
 syncAnalyticsRows(){
  const sources=this.sources.list();this.analyticsSourceMap=new Map(sources.map(s=>[s.id,s]));const signature=JSON.stringify(sources.map(s=>[s.id,s.path,s.overlapGroup,s.primary,s.aliasProvider]).concat(this.attribution.revision));
  const l=this.legacy.ledger;if(this.analyticsSources!==signature){for(const k of l.requestGroups.keys())l.dirtyRequestSessions.add(k);for(const k of this.ledger.groups.keys())this.ledger.dirtyGroups.add(k);this.analyticsSources=signature;}
  for(const key of l.dirtyRequestSessions){const rows=(function*(){for(const r of l.iterateRequestRows(key)){const matches=sources.filter(s=>s.tool===r.tool&&r.location?.file&&(resolve(r.location.file).toLowerCase()===resolve(s.path).toLowerCase()||resolve(r.location.file).toLowerCase().startsWith(resolve(s.path).toLowerCase()+'\\'))).sort((a,b)=>b.path.length-a.path.length);r.sourceId=matches[0]?.id||r.sourceId;yield r;}})();this.analytics.replaceGroup(key,this.repository?rows:[...rows]);}
  l.dirtyRequestSessions.clear();
  for(const key of this.ledger.dirtyGroups){const input=this.ledger.groups.get(key).values(),rows=this.repository?input:[...input].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
   const normalized=(function*(){let previous=emptyUsage();for(const r of rows){const source=sources.find(s=>s.id===r.sourceId);if((source?.overlapGroup||r.overlapGroup)&&(source?.primary??r.primary)===false)continue;if(r.tool==='companion'&&r.reportedProvider==='codex'&&l.sessions.has('codex:'+r.sessionId))continue;
    let usage=r.usage;if(r.mode==='cumulative'){if(usage.total===null){yield r;continue;}if(usage.total<previous.total)continue;usage={...usage,...Object.fromEntries(Object.keys(emptyUsage()).filter(k=>k!=='requests').map(k=>[k,usage[k]===null?null:Math.max(0,usage[k]-(previous[k]||0))])),requests:1};previous=r.usage;if(!usage.total)continue;}
    yield {...r,usage,actualProvider:r.reportedProvider||'unknown'};
   }})();this.analytics.replaceGroup(key,this.repository?normalized:[...normalized]);
  }this.ledger.dirtyGroups.clear();this.analytics.saveIndex?.();this.repository?.meta('analyticsSources',signature);
 }
 async configure({statisticsTimeZone,autoPriceUpdates}={}){if(statisticsTimeZone){this.timeZone=resolveZone(statisticsTimeZone);this.legacy.ledger.timeZone=this.timeZone;this.legacy.emit();}if(typeof autoPriceUpdates==='boolean'&&this.prices.state.autoUpdate!==autoPriceUpdates)await this.prices.save({autoUpdate:autoPriceUpdates});}
 async action(action,args={}){
  if(action==='statistics'||action==='statistics-export'){this.syncAnalytics();const options={...args,timeZone:args.timeZone||this.timeZone};if(action==='statistics-export')return this.analytics.export(options,args.format,this.prices);const result=this.analytics.query(options,this.prices);return {...result,platformCatalog:platformCatalog(result.facets.provider,this.sources.state?.aliases||{})};}
  if(action.startsWith('attribution-')){await this.attribution.ready;this.syncAnalytics();if(action==='attribution-get')return this.attribution.view();if(action==='attribution-preview')return this.attribution.preview(args,this.analytics.rows.values(),this.timeZone);let result;if(action==='attribution-save')result=await this.attribution.save(args,this.analytics.rows.values(),this.timeZone);else if(action==='attribution-remove')result=await this.attribution.remove(args.id);else throw Error('Unknown attribution action');this.syncAnalytics();return result;}
  if(action==='prices-catalog'){this.syncAnalytics();return this.prices.catalog(args,this.analytics.priceIdentities.values());}
  if(action==='prices-get')return this.prices.view();
  if(action==='prices-save')return this.prices.save(args);
  if(action==='prices-refresh')return this.prices.refresh();

  if(action==='preview'&&['codex','claude'].includes(args?.tool)){
   const ledger=new UsageLedger(),found=await this.discover({...args,format:'jsonl'});let invalid=0,count=0;
   for(const path of found.slice(0,10)){let id=basename(path,'.jsonl').match(/[a-f0-9]{8}-[a-f0-9-]{27}$/i)?.[0]||basename(path,'.jsonl');for await(const item of fileRecords(path,{...args,format:'jsonl'})){if(item.invalid)invalid++;if(item.row){id=args.tool==='codex'?ledger.ingestCodex(item.row,id,path):ledger.ingestClaude(item.row,id,path);if(++count>=2000)break;}}if(count>=2000)break;}
   const rows=[...ledger.requestGroups.keys()].flatMap(k=>ledger.requestRows(k)).slice(0,20);return {rows:rows.map(r=>({...r,...resolveIdentity(r,args)})),schemas:[],invalid,files:found.length,complete:rows.length>0,note:'只读预览，尚未保存；最多预览 10 个文件、2000 条记录'};
  }
  if(action==='preview'){const {validateSource}=await import('./token-sources.mjs');const source=validateSource(args),found=await this.discover(source),paths=source.tool==='dsh'?selectDshLogs(found):found,rows=[],schemas=[];let invalid=0;for(const path of paths.slice(0,10)){const meta=source.tool==='dsh'?await inspectDshLog(path)||{}:{};for await(const item of fileRecords(path,source)){if(item.metadata)Object.assign(meta,item.metadata);if(item.schema)schemas.push(...item.schema);if(item.invalid)invalid++;if(item.row)rows.push(...parseTokenRecord(source,item.row,meta,path,item.index).filter(row=>row.kind!=='task'));if(rows.length>=20)break;}if(rows.length>=20)break;}return {rows:rows.slice(0,20).map(r=>({...r,...resolveIdentity(r,source)})),schemas,invalid,files:paths.length,complete:rows.length>0&&rows.every(r=>r.timestamp&&r.usage.total!==null)};}
  if(action==='refresh'){this.lastDiscovery=0;await this.legacy.scan(true);await this.scan(true);return this.sources.view();}
  const old=JSON.stringify(this.sources.list().filter(s=>s.enabled&&['codex','claude'].includes(s.tool)));const result=await this.sources.action(action,args);if(action!=='get'&&action!=='export'){if(old!==JSON.stringify(this.sources.list().filter(s=>s.enabled&&['codex','claude'].includes(s.tool))))await this.restartLegacy();this.lastDiscovery=0;await this.scan(true);}return result;
 }
 ingestCompanion(row){this.legacy.ingestCompanion(row);this.legacy.emit();}
 async close(){this.closed=true;clearInterval(this.timer);await this.starting?.catch(()=>{});await this.legacyRestart?.catch(()=>{});for(const {watcher} of this.watchers)watcher.close();while(this.busy)await new Promise(r=>setTimeout(r,20));await this.persist();await this.legacy?.close();this.repository?.close();}
}
