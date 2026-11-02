import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import * as usage from '../src/usage-query.mjs';
import {SqlUsageQuery} from '../src/usage-query-sqlite.mjs';
import {normalizePreferences} from '../src/preferences.mjs';

const now=Date.parse('2026-10-25T16:00:00Z');
const stale={preset:'all',from:'2026-09-08',to:'2026-09-09',timeZone:'America/New_York',now};
const row=(id,date,total,extra={})=>({tool:'codex',sourceId:'source',requestId:id,sessionId:id,workspace:'E:/project',model:'gpt-6.1-sol',actualProvider:'openai',timestamp:date+'T12:00:00Z',cacheIncluded:false,usage:{input:total,output:0,cacheRead:0,cacheWrite:0,reasoning:0,total,requests:1},...extra});
function fixture(kind){
 let db,query;
 if(kind==='memory')query=new usage.UsageQuery();
 else{
  db=new DatabaseSync(':memory:');db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
  const repository={db,meta(){return undefined;},transaction(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
  query=new SqlUsageQuery(repository);
 }
 query.replaceGroup('original',[row('old1','2026-09-08',70),row('old2','2026-09-09',30),row('recent','2026-10-24',10)]);
 return {query,close:()=>db?.close()};
}
for(const kind of ['memory','sqlite']){
 test(kind+': overview all with saved dates equals project all and includes older requests',()=>{
  const {query,close}=fixture(kind);try{
   const preferences=normalizePreferences({statisticsViews:{overview:{preset:stale.preset,from:stale.from,to:stale.to},projects:{preset:'all'}}});
   const overview=query.query(preferences.statisticsViews.overview),projects=query.query(preferences.statisticsViews.projects);
   assert.equal(overview.totals.total,110);assert.equal(overview.totals.requests,3);
   assert.deepEqual(overview.totals,projects.totals);assert.deepEqual(overview.periods.map(p=>p.date),['2026-09-08','2026-09-09','2026-10-24']);
   assert.equal(overview.from,'');assert.equal(overview.to,'');assert.equal(overview.totalSessions,3);
   assert.equal(preferences.statisticsViews.overview.from,stale.from,'saved custom draft is retained');
  }finally{close();}
 });
 test(kind+': custom and implicit explicit date ranges still constrain totals',()=>{
  const {query,close}=fixture(kind);try{
   for(const options of [{...stale,preset:'custom'},{from:stale.from,to:stale.to}]){
    const result=query.query(options);assert.equal(result.totals.total,100);assert.equal(result.totals.requests,2);assert.equal(result.from,stale.from);
   }
   for(const [preset,total] of [['today',0],['7d',10],['30d',10]])assert.equal(query.query({...stale,preset}).totals.total,total,preset);
  }finally{close();}
 });
 test(kind+': all, seven-day, details and incremental cached queries remain isolated',()=>{
  const {query,close}=fixture(kind);try{
   assert.equal(query.query(stale).totals.total,110);
   assert.equal(query.query({...stale,preset:'7d'}).totals.total,10);
   assert.equal(query.query({...stale,sessionId:'old1'}).totals.total,70,'old session details use all history');
   query.replaceGroup('late-old',[row('late','2026-08-01',5)]);
   assert.equal(query.query(stale).totals.total,115);assert.equal(query.query(stale).totals.requests,4);
   assert.equal(query.query({...stale,preset:'7d'}).totals.total,10);
   assert.equal(query.query({...stale,workspace:'E:/missing'}).totals.requests,0,'non-date filters are preserved');
  }finally{close();}
 });
 test(kind+': JSON and CSV exports use the same all-history scope',()=>{
  const {query,close}=fixture(kind);try{
   const json=JSON.parse(query.export({...stale,view:'projects'}));
   assert.equal(json.totals.total,110);assert.equal(json.totals.requests,3);assert.equal(json.metadata.from,'');assert.equal(json.metadata.to,'');
   assert.equal(json.metadata.filters.from,undefined);assert.equal(json.metadata.filters.to,undefined);
   assert.equal(json.projects[0].usage.total,110);
   assert.ok(query.export(stale,'csv').includes('2026-10-24'));
   assert.equal(JSON.parse(query.export({...stale,preset:'custom'})).totals.total,100);
  }finally{close();}
 });
 test(kind+': all ignores stale invalid boundaries while explicit custom still rejects inversion',()=>{
  const {query,close}=fixture(kind);try{
   assert.equal(query.query({...stale,from:'2026-10-25',to:'2026-09-01'}).totals.total,110);
   assert.throws(()=>query.query({...stale,preset:'custom',from:'2026-10-25',to:'2026-09-01'}),/开始日期/);
  }finally{close();}
 });
}
test('effective UI queries remove inactive dates without changing saved preferences',()=>{
 assert.equal(typeof usage.effectiveUsageOptions,'function');
 for(const preset of ['today','7d','30d','all']){
  const filters=Object.freeze({...stale,preset,visibleTools:Object.freeze(['codex']),tool:'codex'}),query=usage.effectiveUsageOptions(filters);
  assert.equal(query.from,undefined);assert.equal(query.to,undefined);assert.equal(query.visibleTools,undefined);
  assert.equal(query.tool,'codex');assert.equal(query.preset,preset);assert.equal(filters.from,stale.from);assert.notEqual(query,filters);
 }
 for(const preset of ['custom',undefined])assert.equal(usage.effectiveUsageOptions({...stale,preset}).from,stale.from);
});
test('overview main, details and export share the effective query before IPC',()=>{
 const source=readFileSync(new URL('../src/analytics-ui.mjs',import.meta.url),'utf8');
 assert.match(source,/import\s*\{effectiveUsageOptions\}\s*from\s*['"]\.\/usage-query\.mjs['"]/);
 assert.match(source,/query=effectiveUsageOptions\(filters\)/);
 assert.ok(source.includes("'statistics',{...query,timeZone:zone"));
 assert.ok(source.includes("'statistics',{...query,...extra,timeZone:zone"));
 assert.ok(source.includes('statisticsExport({...query,timeZone:zone'));
});
