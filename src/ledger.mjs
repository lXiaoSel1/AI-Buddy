import { createHash } from 'node:crypto';
import {dateInZone} from './usage-query.mjs';

export const TIME_ZONE = 'America/New_York';
export const dayOf = (time,zone=TIME_ZONE)=>dateInZone(time,zone);
export const emptyUsage = ()=>({input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,total:0,requests:0});
const num = x=>Number.isFinite(Number(x)) ? Math.max(0,Number(x)) : 0;
const hash = x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function plus(a,b) { for(const key of Object.keys(emptyUsage())) a[key]+=num(b[key]); return a; }
export function claudeUsage(u={}) {
  const v={input:num(u.input_tokens),output:num(u.output_tokens),cacheRead:num(u.cache_read_input_tokens),cacheWrite:num(u.cache_creation_input_tokens),reasoning:num(u.output_tokens_details?.thinking_tokens),requests:1};
  return {...v,total:v.input+v.output+v.cacheRead+v.cacheWrite};
}
export function codexUsage(u={}) {
  const input=num(u.input_tokens), output=num(u.output_tokens);
  return {input,output,cacheRead:num(u.cached_input_tokens),cacheWrite:num(u.cache_write_input_tokens),reasoning:num(u.reasoning_output_tokens),total:input+output,requests:0};
}
const fields=['input','output','cacheRead','cacheWrite','reasoning','total'];
const maxUsage=(a,b)=>Object.fromEntries([...fields,'requests'].map(k=>[k,Math.max(num(a?.[k]),num(b?.[k]))]));

export class UsageLedger {
  constructor(serialized={},repository=null) {
    this.repository=repository;
    this.sessions=new Map(serialized.sessions || []);
    this.codex=repository?repository.map("codex"):new Map(serialized.codex || []);
    this.claude=repository?repository.map("claude"):new Map(serialized.claude || []);
    this.revision=0; this.aggregationRevision=0; this.aggregateBuilds=0; this.cached=null; this.dirtySessions=new Set();this.dirtyCodex=new Set();this.dirtyClaude=new Set();
    this.requestGroups=new Map();this.dirtyRequestSessions=new Set();this.timeZone=TIME_ZONE;
    this.rebuildRequestIndex();
  }
  rebuildRequestIndex(){if(this.repository){const repo=this.repository;this.requestGroups={keys:()=>repo.groups(["codex","claude"]),clear(){},get(key){const kind=key.startsWith("codex:")?"codex":"claude";return {entries:function*(){for(const[k,v]of repo.entries(kind,{group:key,ordered:true}))yield [kind+":"+k,v];},delete(){}};}};return;}this.requestGroups.clear();this.codex=new Map([...this.codex].map(([k,v])=>[v.session+':'+hash([v.timestamp,v.usage.input,v.usage.output,v.usage.cacheRead,v.usage.reasoning]),v]));for(const [k,v]of this.codex)this.indexRequest('codex',k,v);for(const[k,v]of this.claude)this.indexRequest('claude',k,v);}
  indexRequest(kind,key,value){if(this.repository){this.dirtyRequestSessions.add(value.session);return;}if(!this.requestGroups.has(value.session))this.requestGroups.set(value.session,new Map());this.requestGroups.get(value.session).set(kind+':'+key,value);this.dirtyRequestSessions.add(value.session);}
  requestRows(key){return [...this.iterateRequestRows(key)];}
  *iterateRequestRows(key){const session=this.sessions.get(key);if(!session)return;const input=this.requestGroups.get(key)?.entries()||[];const samples=this.repository?input:[...input].sort((a,b)=>Date.parse(a[1].timestamp)-Date.parse(b[1].timestamp));let previous=emptyUsage();
    for(const[id,sample]of samples){let usage=sample.usage;if(session.provider==='codex'){if(usage.total<previous.total){if(sample.startsCounter)previous=emptyUsage();else continue;}const next={...usage,...Object.fromEntries(fields.map(k=>[k,Math.max(0,usage[k]-previous[k])])),requests:1};previous=maxUsage(previous,usage);usage=next;if(!usage.total)continue;}
      yield {requestId:id,sessionId:session.id,tool:session.provider,sourceId:'legacy-'+session.provider,workspace:session.workspace,model:sample.model||'',actualProvider:sample.actualProvider||'unknown',connectionIdentity:sample.connectionIdentity,timestamp:sample.timestamp,usage,knownFields:sample.knownFields||["input","output","total"],totalQuality:sample.totalQuality||'calculated',cacheIncluded:session.provider==='codex',cacheWriteIncluded:false,reasoningIncluded:true,cacheWrite1h:sample.cacheWrite1h,purpose:session.purpose|| (session.companion?(/_cg/.test(session.origin||'')?'cg':'galgame'):'work'),location:{file:session.path}};
    }
  }
  session(provider,id,meta={}) {
    const key=provider+':'+id;
    const existing=this.sessions.get(key),statsChanged=!existing||['workspace','companion','origin','purpose'].some(k=>meta[k]!==undefined&&meta[k]!==null&&meta[k]!==''&&meta[k]!==existing[k]);
    const s=existing || {key,id,provider,workspace:'',model:'',status:'unknown',lastActivity:null,lifecycleAt:0,createdAt:meta.createdAt || null};
    for(const [k,v] of Object.entries(meta)) if(v!==undefined && v!==null && v!=='') s[k]=v;
    this.sessions.set(key,s); this.dirtySessions.add(key);if(statsChanged){this.dirtyRequestSessions.add(key);this.aggregationRevision++;}this.revision++; return s;
  }
  lifecycle(s,status,time,extra={}) {
    const t=Date.parse(time); if(!Number.isFinite(t)) return;
    if(t>=s.lifecycleAt) Object.assign(s,{status,lifecycleAt:t,lastActivity:time,...extra});
    this.dirtySessions.add(s.key);this.revision++;
  }
  ingestCodex(record,fallbackId,path='') {
    const p=record.payload || {}, time=record.timestamp;
    if(record.type==='session_meta') {
      // A paginated user rollout is the continuation of the family session.
      // Its first counter includes the preceding page. A spawned child also
      // embeds that family metadata, after its own metadata; keep the child.
      if(p.id && p.id!==fallbackId && p.history_mode==='paginated' && p.thread_source==='user' && !this.sessions.has('codex:'+fallbackId))fallbackId=p.session_id || p.id;
      // The first/file UUID is the thread identity. Paginated child rollouts
      // embed a second parent session_meta inside the inherited seed segment.
      if(p.id && p.id!==fallbackId){
        // Older desktop branches sometimes retain only the family metadata.
        // Keep the filename's thread identity, but retain the recorded cwd.
        if(!this.sessions.has('codex:'+fallbackId))this.session('codex',fallbackId,{workspace:p.cwd,createdAt:p.timestamp || time,sessionRootId:p.id,origin:p.originator,companion:/whale[_-]companion/i.test(p.originator || ''),path});
        return fallbackId;
      }
      const source=p.source?.subagent?.thread_spawn;
      const existing=this.sessions.get('codex:'+fallbackId),created=p.timestamp || time;
      this.session('codex',fallbackId,{workspace:p.cwd,createdAt:existing?.createdAt && Date.parse(existing.createdAt)<Date.parse(created)?existing.createdAt:created,origin:p.originator,actualProvider:p.model_provider,parentId:source?.parent_thread_id || p.parent_thread_id || p.forked_from_id || p.forkedFromId,sessionRootId:p.session_id,agent:source?.agent_path || p.agent_path,subagent:!!source || p.thread_source==='subagent',historyStartOrdinal:p.subagent_history_start_ordinal ?? p.seedLength ?? p.seed_length,companion:/whale[_-]companion/i.test(p.originator || ''),path});
      return fallbackId;
    }
    const s=this.session('codex',fallbackId,{path});
    if(Number.isFinite(s.historyStartOrdinal) && Number.isFinite(record.ordinal) && record.ordinal<s.historyStartOrdinal)return fallbackId;
    if(s.createdAt && Date.parse(time)<Date.parse(s.createdAt))return fallbackId;
    if(record.type==='turn_context') { if(p.model_provider)s.actualProvider=p.model_provider; if(Date.parse(time)>=(s.contextAt || 0)){if(p.model)s.model=p.model;if(p.cwd)s.workspace=p.cwd;s.contextAt=Date.parse(time);}this.lifecycle(s,'running',time);return fallbackId; }
    if(record.type!=='event_msg') return fallbackId;
    if(p.type==='task_started') this.lifecycle(s,'running',time,{turnId:p.turn_id});
    if(p.type==='task_complete' || p.type==='agent_turn_complete') this.lifecycle(s,p.error?'failed':'completed',time,{turnId:p.turn_id});
    if(/turn_aborted|task_aborted|interrupted/.test(p.type || '')) this.lifecycle(s,'paused',time);
    if(/^(error|task_error)$/.test(p.type || '')) this.lifecycle(s,'failed',time);
    if(/approval_requested|permission_requested|request_user_input/.test(p.type || '')) this.lifecycle(s,'waiting',time);
    if(p.type==='token_count' && p.info?.total_token_usage && Number.isFinite(Date.parse(time))) {
      const usage=codexUsage(p.info.total_token_usage);
      const last=p.info.last_token_usage?codexUsage(p.info.last_token_usage):null;
      const startsCounter=!!last && usage.total>0 && usage.input===last.input && usage.output===last.output;
      const key=s.key+':'+hash([time,usage.input,usage.output,usage.cacheRead,usage.reasoning]);
      const old=this.codex.get(key);
      // Never merge unrelated sessions on coincident timestamps and counters.
      const raw=p.info.total_token_usage,knownFields=[...(raw.input_tokens!==undefined?['input']:[]),...(raw.output_tokens!==undefined?['output']:[]),...(raw.total_tokens!==undefined||raw.input_tokens!==undefined&&raw.output_tokens!==undefined?['total']:[]),...(raw.cached_input_tokens!==undefined?['cacheRead']:[]),...(raw.cache_write_input_tokens!==undefined?['cacheWrite']:[]),...(raw.reasoning_output_tokens!==undefined?['reasoning']:[])];
      const value={session:s.key,timestamp:time,usage,startsCounter,connectionIdentity:s.connectionIdentity,model:s.model,actualProvider:s.actualProvider,knownFields,totalQuality:raw.total_tokens!==undefined?'reported':'calculated'};
      if(raw.total_tokens!==undefined)value.usage.total=num(raw.total_tokens);
      this.aggregationRevision++;this.codex.set(key,value);this.indexRequest('codex',key,value);this.dirtyCodex.add(key);
      s.lastActivity = !s.lastActivity || Date.parse(time)>Date.parse(s.lastActivity) ? time:s.lastActivity;
      if(p.info.model_context_window) s.contextWindow=num(p.info.model_context_window);
      this.revision++;
    }
    return fallbackId;
  }
  ingestClaude(record,fallbackId,path='') {
    const isAgent=/[\\/]subagents[\\/]/i.test(path),id=isAgent?fallbackId:(record.sessionId || fallbackId), time=record.timestamp;
    const s=this.session('claude',id,{workspace:record.cwd,path,subagent:isAgent || !!record.isSidechain,parentId:isAgent?record.sessionId:undefined,createdAt:undefined});
    if(!s.createdAt && Number.isFinite(Date.parse(time))) s.createdAt=time;
    const message=record.message || {};
    if(record.type==='user') {
      const content=message.content;
      const isTool=Array.isArray(content) && content.some(x=>x?.type==='tool_result');
      if(!isTool && !record.isMeta) this.lifecycle(s,'running',time);
    }
    if(record.type==='assistant') {
      if(message.model) s.model=message.model;
      if(message.usage && message.id && Number.isFinite(Date.parse(time))) {
        const key=message.id; // globally unique API message id; shared copied history counts once
        const usage=claudeUsage(message.usage), old=this.claude.get(key);
        const merged=maxUsage(old?.usage,usage);merged.total=merged.input+merged.output+merged.cacheRead+merged.cacheWrite;
        const owner=old && Date.parse(this.sessions.get(old.session)?.createdAt || old.timestamp)<=Date.parse(s.createdAt || time) ? old.session:s.key;
        const raw=message.usage,value={session:owner,timestamp:old?.timestamp || time,usage:merged,model:message.model||old?.model,actualProvider:record.provider||message.provider||old?.actualProvider,knownFields:['total',...Object.entries({input:'input_tokens',output:'output_tokens',cacheRead:'cache_read_input_tokens',cacheWrite:'cache_creation_input_tokens'}).filter(([,k])=>raw[k]!==undefined).map(([k])=>k)],cacheWrite1h:raw.cache_creation?.ephemeral_1h_input_tokens};
        if(old&&old.session!==owner){this.requestGroups.get(old.session)?.delete('claude:'+key);this.dirtyRequestSessions.add(old.session);}this.aggregationRevision++;this.claude.set(key,value);this.indexRequest('claude',key,value);this.dirtyClaude.add(key); this.revision++;
      }
      if(record.isApiErrorMessage || record.isApiError || record.error) this.lifecycle(s,'failed',time);
      else if(message.stop_reason==='end_turn') this.lifecycle(s,'completed',time);
      else if(message.stop_reason==='tool_use') this.lifecycle(s,'running',time);
    }
    if(record.type==='system' && record.subtype==='stop_hook_summary') this.lifecycle(s,'completed',time);
    if(record.type==='system' && /permission_request|approval_request/.test(record.subtype || '')) this.lifecycle(s,'waiting',time);
    return id;
  }
  serialize() { return {version:1,sessions:[...this.sessions],codex:[...this.codex],claude:[...this.claude]}; }
  delta(){return {sessions:[...this.dirtySessions].map(k=>[k,this.sessions.get(k)]),codex:[...this.dirtyCodex].map(k=>[k,this.codex.get(k)]),claude:[...this.dirtyClaude].map(k=>[k,this.claude.get(k)])};}
  clearDirty(){this.dirtySessions.clear();this.dirtyCodex.clear();this.dirtyClaude.clear();}
  snapshot(now=Date.now()) {
    const dayOf=time=>dateInZone(time,this.timeZone);
    if(this.cached?.revision===this.aggregationRevision&&this.cached.zone===this.timeZone) {
      const value=this.cached.value,today=dayOf(now),sessions=value.sessions.map(old=>{const s={...old,...this.sessions.get(old.key)};return {...s,displayStatus:s.status==='running' && now-(Date.parse(s.lastActivity)||0)>120000?'unknown':s.status};});
      return {...value,timestamp:new Date(now).toISOString(),today,todayUsage:value.daily.find(d=>d.date===today)||{date:today,codex:emptyUsage(),claude:emptyUsage()},sessions,active:sessions.filter(s=>['running','waiting','failed'].includes(s.displayStatus)&&now-(Date.parse(s.lastActivity)||0)<86400000).map(s=>s.key)};
    }
    this.aggregateBuilds++;
    const sessions=new Map([...this.sessions].map(([key,s])=>[key,{...s,usage:emptyUsage(),displayStatus:s.status==='running' && now-(Date.parse(s.lastActivity)||0)>120000 ? 'unknown':s.status}]));
    const daily=new Map(), projects=new Map(), cube=new Map(),totals={codex:emptyUsage(),claude:emptyUsage()};
    const startedAt=this.workStartedAt || Infinity;let workSinceStart=0;
    function add(sample,usage) {
      const s=sessions.get(sample.session); if(!s) return;
      plus(s.usage,usage); plus(totals[s.provider],usage);
      if(!s.companion && Date.parse(sample.timestamp)>=startedAt)workSinceStart+=usage.total;
      const day=dayOf(sample.timestamp);
      if(!daily.has(day)) daily.set(day,{date:day,codex:emptyUsage(),claude:emptyUsage()});
      plus(daily.get(day)[s.provider],usage);
      const projectKey=s.workspace || '未记录项目';
      const dimensions={date:day,tool:s.provider,sourceId:'legacy-'+s.provider,model:sample.model||'',workspace:projectKey,purpose:s.purpose||(s.companion?(/_cg/.test(s.origin||'')?'cg':'galgame'):'work')};
      const dimensionKey=JSON.stringify(dimensions);if(!cube.has(dimensionKey))cube.set(dimensionKey,{...dimensions,usage:emptyUsage()});plus(cube.get(dimensionKey).usage,usage);
      if(!projects.has(projectKey)) projects.set(projectKey,{workspace:projectKey,codex:emptyUsage(),claude:emptyUsage(),sessions:0});
      plus(projects.get(projectKey)[s.provider],usage);
    }
    const groups=this.repository?this.repository.groups(['codex']):new Set([...this.codex.values()].map(v=>v.session));
    for(const key of groups) {
      const samples=this.repository?(function*(repo){for(const[,v]of repo.entries('codex',{group:key,ordered:true}))yield v;})(this.repository):[...this.codex.values()].filter(v=>v.session===key).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
      let previous=emptyUsage();
      for(const sample of samples) {
        const session=sessions.get(sample.session);
        const regressed=sample.usage.total<previous.total;
        const reset=regressed && sample.startsCounter;
        if(reset){previous=emptyUsage();session.counterRestarts=(session.counterRestarts || 0)+1;}
        else if(regressed){session.counterRegressions=(session.counterRegressions || 0)+1;continue;}
        const delta=Object.fromEntries(fields.map(k=>[k,Math.max(0,sample.usage[k]-previous[k])])) ;
        delta.total=delta.input+delta.output; delta.requests=delta.total>0?1:0;
        if(delta.total>0) add(sample,delta); previous=maxUsage(previous,sample.usage);
      }
    }
    for(const sample of this.claude.values()) if(sample.usage.total>0) add(sample,sample.usage);
    for(const s of sessions.values()) if(projects.has(s.workspace || '未记录项目')) projects.get(s.workspace || '未记录项目').sessions++;
    const today=dayOf(now), todayRow=daily.get(today) || {date:today,codex:emptyUsage(),claude:emptyUsage()};
    const active=[...sessions.values()].filter(s=>['running','waiting','failed'].includes(s.displayStatus) && now-(Date.parse(s.lastActivity)||0)<86400000);
    const workTotal=[...sessions.values()].filter(s=>!s.companion).reduce((n,s)=>n+s.usage.total,0);
    const value={timestamp:new Date(now).toISOString(),timeZone:TIME_ZONE,today,todayUsage:todayRow,totals,cube:[...cube.values()],workTotal,workSinceStart,sessions:[...sessions.values()].sort((a,b)=>Date.parse(b.lastActivity||0)-Date.parse(a.lastActivity||0)),daily:[...daily.values()].sort((a,b)=>b.date.localeCompare(a.date)),projects:[...projects.values()].sort((a,b)=>(b.codex.total+b.claude.total)-(a.codex.total+a.claude.total)),active:active.map(s=>s.key)};
    value.timeZone=this.timeZone;this.cached={revision:this.aggregationRevision,zone:this.timeZone,bucket:Math.floor(now/1000),value}; return value;
  }
}
