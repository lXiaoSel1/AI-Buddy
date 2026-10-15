import {UsageQuery,normalizedRequest,dateInZone} from './usage-query.mjs';
const fields=['input','output','cacheRead','cacheWrite','reasoning','total'];
const dims=['tool','provider','modelVendor','model','workspace','sourceId','purpose','sessionId'];
export class SqlUsageQuery extends UsageQuery {
 constructor(repository,identityResolver){
  super(identityResolver);this.repository=repository;this.db=repository.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS usage_contributions(seq INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE NOT NULL,grp TEXT NOT NULL,value TEXT NOT NULL,tool TEXT,provider TEXT,modelVendor TEXT,model TEXT,workspace TEXT,sourceId TEXT,purpose TEXT,sessionId TEXT,timestamp TEXT,search TEXT,input REAL,output REAL,cacheRead REAL,cacheWrite REAL,reasoning REAL,total REAL,requests REAL);
   CREATE INDEX IF NOT EXISTS contributions_group ON usage_contributions(grp);
   CREATE INDEX IF NOT EXISTS contributions_time ON usage_contributions(timestamp,tool,sessionId);
   CREATE INDEX IF NOT EXISTS contributions_session ON usage_contributions(tool,sessionId,timestamp);`);
  this.db.function('buddy_day',{deterministic:true},(time,zone)=>dateInZone(time,zone));
  const self=this;this.rows={*values(){for(const r of self.db.prepare('SELECT value FROM usage_contributions ORDER BY seq').iterate())yield JSON.parse(r.value);},get size(){return self.db.prepare('SELECT COUNT(*) AS n FROM usage_contributions').get().n;}};
  this.groups=null;
  // Only dimension counts are retained, never one key or payload per request.
  const index=repository.meta('queryDimensions');
  if(index){for(const[k,entries]of Object.entries(index.facets))this.facets[k]=new Map(entries);this.priceIdentities=new Map(index.prices);}
  else{
   for(const dim of dims.filter(d=>d!=='sessionId'))for(const r of this.db.prepare(`SELECT ${dim} AS value,COUNT(*) AS n FROM usage_contributions WHERE ${dim} IS NOT NULL AND ${dim}<>'' GROUP BY ${dim}`).iterate())this.facets[dim].set(r.value,r.n);
   for(const r of this.db.prepare(`SELECT value,COUNT(*) AS count FROM usage_contributions GROUP BY json_extract(value,'$.serviceProvider'),model,modelVendor,json_extract(value,'$.billingRoute')`).iterate()){const row=JSON.parse(r.value),identity=Object.fromEntries(['serviceProvider','model','modelVendor','billingRoute'].map(k=>[k,row[k]]));this.priceIdentities.set(JSON.stringify(identity),{...identity,count:r.count});}
  }
  this.insert=this.db.prepare(`INSERT INTO usage_contributions(key,grp,value,${dims.join(',')},timestamp,search,${fields.join(',')},requests) VALUES(${Array(20).fill('?').join(',')})`);
 }
 saveIndex(){if(!this.dimensionsDirty&&this.repository.meta('queryDimensions'))return;this.repository.meta('queryDimensions',{facets:Object.fromEntries(Object.entries(this.facets).filter(([k])=>k!=='sessionId').map(([k,m])=>[k,[...m]])),prices:[...this.priceIdentities]});this.dimensionsDirty=false;}
 restoreIndex(){this.cache.clear();for(const map of Object.values(this.facets))map.clear();this.priceIdentities.clear();for(const r of this.rows.values())this.facet(r,1);this.dimensionsDirty=true;}
 facet(r,sign){const old=this.facets.sessionId;this.facets.sessionId={get(){return 0;},set(){},delete(){}};try{super.facet(r,sign);}finally{this.facets.sessionId=old;}}
 replaceGroup(id,rows){
  let count=0;
  try{this.repository.transaction(()=>{
   for(const item of this.db.prepare('SELECT value FROM usage_contributions WHERE grp=? ORDER BY seq').iterate(id)){const r=JSON.parse(item.value);this.facet(r,-1);for(const c of this.cache.values())this.fold(c,r,-1);count++;}
   this.db.prepare('DELETE FROM usage_contributions WHERE grp=?').run(id);
   let i=0;for(const source of rows){const r={...normalizedRequest(source,this.identityResolver(source)),key:id+':'+(source.requestId||i++)};const d={...r,provider:r.serviceProvider,workspace:r.workspace||'未记录项目'};
    this.insert.run(r.key,id,JSON.stringify(r),...dims.map(k=>d[k]??null),r.timestamp,[r.model,r.workspace,r.sessionId].join(' ').toLowerCase(),...fields.map(k=>r.usage[k]??null),r.usage.requests??1);this.facet(r,1);for(const c of this.cache.values())this.fold(c,r,1);count++;
   }
  });}catch(e){this.restoreIndex();throw e;}
  this.revision++;this.incrementalUpdates+=count;for(const c of this.cache.values())c.result=null;
  // A stale dimension snapshot is never reused after a standalone update.
  this.db.prepare("DELETE FROM meta WHERE key='queryDimensions'").run();
  this.dimensionsDirty=true;
 }
 filter(c){
  const conditions=[],params=[];
  const shift=(date,days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString();};
  // Coarse UTC bounds use the time index; exact local-day filtering handles DST.
  if(c.range.from){conditions.push('timestamp>=?');params.push(shift(c.range.from,-1));}
  if(c.range.to){conditions.push('timestamp<?');params.push(shift(c.range.to,2));}
  if(c.range.from){conditions.push('buddy_day(timestamp,?)>=?');params.push(c.zone,c.range.from);}
  if(c.range.to){conditions.push('buddy_day(timestamp,?)<=?');params.push(c.zone,c.range.to);}
  for(const k of dims)if(c.options[k]&&c.options[k]!=='all'){conditions.push(k+'=?');params.push(c.options[k]);}
  if(c.options.search){conditions.push('instr(search,?)>0');params.push(c.options.search.toLowerCase());}
  const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
  return {where,params};
 }
 *rowsForContext(c){const{where,params}=this.filter(c);for(const r of this.db.prepare(`SELECT value FROM usage_contributions ${where} ORDER BY seq`).iterate(...params))yield JSON.parse(r.value);}
 sessionPage(c,page,pageSize){
  const signature=this.revision+':'+page+':'+pageSize;
  if(c.pageResult?.signature===signature)return c.pageResult.value;
  this.sessionQueries=(this.sessionQueries||0)+1;
  const{where,params}=this.filter(c);
  const totalSessions=this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT tool,sessionId FROM usage_contributions ${where} GROUP BY tool,sessionId)`).get(...params).n;
  const sums=fields.map(k=>`COALESCE(SUM(${k}),0) AS ${k},SUM(CASE WHEN ${k} IS NULL THEN requests ELSE 0 END) AS missing_${k}`).join(',');
  const sql=`SELECT tool,sessionId,MAX(timestamp) AS lastActivity,MIN(seq) AS position,SUM(requests) AS requests,${sums} FROM usage_contributions ${where} GROUP BY tool,sessionId ORDER BY lastActivity DESC,position LIMIT ? OFFSET ?`;
  const sessions=[];
  // Page only small aggregates. Fetch metadata for those sessions after LIMIT;
  // window-sorting the full JSON payload table would spill hundreds of MiB.
  const match=where?where+' AND tool=? AND sessionId=?':'WHERE tool=? AND sessionId=?';
  const first=this.db.prepare(`SELECT json_extract(value,'$.workspace') AS workspace FROM usage_contributions ${match} ORDER BY seq LIMIT 1`),last=this.db.prepare(`SELECT model,provider FROM usage_contributions ${match} ORDER BY timestamp DESC,seq DESC LIMIT 1`);
  for(const r of this.db.prepare(sql).iterate(...params,pageSize,(page-1)*pageSize)){const usage={requests:r.requests,fieldMissing:{}};for(const k of fields){usage[k]=r[k];if(r['missing_'+k])usage.fieldMissing[k]=r['missing_'+k];}const f=first.get(...params,r.tool,r.sessionId),l=last.get(...params,r.tool,r.sessionId);sessions.push({key:r.tool+':'+r.sessionId,tool:r.tool,sessionId:r.sessionId,workspace:f.workspace??undefined,model:l.model,serviceProvider:l.provider,usage,lastActivity:r.lastActivity});}
  const value={totalSessions,sessions};c.pageResult={signature,value};return value;
 }
}
