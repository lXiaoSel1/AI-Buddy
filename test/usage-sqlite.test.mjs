import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UsageRepository} from '../src/usage-repository.mjs';
test('equal timestamp cumulative ordering preserves Intl request IDs across pending and restart',()=>{
 const path=join(temp(),'ties.sqlite');let repo=new UsageRepository(path);
 const ids=['Z','a','A','é','e','中','2','10'];for(const id of ids)repo.put('generic',id,{tool:'dsh',sessionId:'same',timestamp:'2026-10-14T00:00:00Z',requestId:id});
 const expected=[...ids].sort((a,b)=>a.localeCompare(b));
 const read=()=>[...repo.entries('generic',{group:'dsh:same',ordered:true,tieRequest:true})].map(([,r])=>r.requestId);
 assert.deepEqual(read(),expected);repo.publish();repo.close();repo=new UsageRepository(path);assert.deepEqual(read(),expected);repo.close();
});
import {UsageQuery} from '../src/usage-query.mjs';
import {SqlUsageQuery} from '../src/usage-query-sqlite.mjs';
import {UsageLedger} from '../src/ledger.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
import {migrateLegacy} from '../src/usage-migrate.mjs';
import {exportUsageForRollback} from '../src/usage-rollback.mjs';
import {LocalMonitor} from '../src/monitor.mjs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const temp=()=>mkdtempSync(join(tmpdir(),'buddy-sql-'));
test('abrupt writer exit recovers the last WAL commit without publishing staged facts',()=>{
 const path=join(temp(),'db.sqlite'),module=pathToFileURL(join(import.meta.dirname,'../src/usage-repository.mjs')).href;
 const script=`import {UsageRepository} from ${JSON.stringify(module)};const r=new UsageRepository(${JSON.stringify(path)});r.put('generic','a',{tool:'dsh',sessionId:'s',timestamp:'2026-10-14T00:00:00Z',usage:{total:7743}});r.publish({state:{offset:100}});r.put('generic','b',{tool:'dsh',sessionId:'s',timestamp:'2026-10-14T00:00:01Z',usage:{total:9}});r.flush();process.exit(17);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true});assert.equal(child.status,17);const r=new UsageRepository(path);assert.equal(r.get('generic','a').usage.total,7743);assert.equal(r.get('generic','b'),undefined);assert.equal(r.meta('state').offset,100);r.close();
});
const row=i=>({tool:'dsh',requestId:'r'+i,sessionId:'s'+(i%11),sourceId:'source',purpose:'work',actualProvider:'deepseek',model:'deepseek-chat',workspace:i%2?'E:/项目10':'E:/项目2',timestamp:`2026-10-${10+i%10}T02:15:00Z`,cacheIncluded:false,usage:{input:i,output:2,cacheRead:null,cacheWrite:null,reasoning:null,total:i+2,requests:1}});
test('SQL cursor aggregates and server-side session pagination match in-memory semantics',()=>{
 const repo=new UsageRepository(join(temp(),'db.sqlite')),sql=new SqlUsageQuery(repo),old=new UsageQuery();
 try{for(let i=0;i<101;i++){const rows=[row(i)];sql.replaceGroup('g'+i,rows);old.replaceGroup('g'+i,rows);}
 for(const options of [{},{page:2,pageSize:3},{timeZone:'Asia/Shanghai',group:'week'},{from:'2026-10-14',to:'2026-10-18',search:'项目2',sortDirection:'asc'},{tool:'missing'}]){
  const a=sql.query(options),b=old.query(options);assert.deepEqual(a.totals,b.totals);assert.deepEqual(a.periods,b.periods);assert.deepEqual(a.projects,b.projects);assert.deepEqual(a.sessions,b.sessions);assert.equal(a.totalSessions,b.totalSessions);
 }
 const scanned=sql.scanned;sql.query({});assert.equal(sql.scanned,scanned);
 sql.replaceGroup('g0',[{...row(0),usage:{...row(0).usage,total:1}}]);old.replaceGroup('g0',[{...row(0),usage:{...row(0).usage,total:1}}]);assert.deepEqual(sql.query().totals,old.query().totals);
 assert.equal(sql.rows instanceof Map,false);assert.equal(sql.cache.values().next().value.sessions,null);
 }finally{repo.close();}
});
test('rollback exports post-switch facts to the old reader without losing request identities',async()=>{
 const root=temp(),repo=new UsageRepository(join(root,'usage-ledger-v2/legacy.sqlite')),ledger=new UsageLedger({},repo);
 ledger.ingestCodex({type:'event_msg',timestamp:'2026-10-10T01:00:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:7565,output_tokens:178}}}},'after-upgrade');
 for(const[k,v]of ledger.sessions)repo.put('sessions',k,v);repo.publish({ready:true});const expected=ledger.snapshot().totals;repo.close();
 const report=await exportUsageForRollback(root);assert(report.legacy>0);const old=new LocalMonitor({roots:[],dataRoot:root});try{await old.start();assert.deepEqual(old.snapshot().totals,expected);assert.equal(old.snapshot().workSinceStart,0);}finally{await old.close();}
});
test('unpublished facts cannot advance a cursor across restart; published facts and metadata survive together',()=>{
 const path=join(temp(),'db.sqlite');let repo=new UsageRepository(path);repo.put('generic','one',row(1));repo.publish({state:{offset:20,size:20}});repo.put('generic','two',row(2));repo.flush();repo.close();repo=new UsageRepository(path);
 assert.equal(repo.map('generic').size,1);assert.equal(repo.meta('state').offset,20);repo.put('generic','one',{...row(1),usage:{total:1}});repo.publish({state:{offset:40}});repo.close();repo=new UsageRepository(path);assert.equal(repo.get('generic','one').usage.total,1);assert.equal(repo.meta('state').offset,40);repo.close();
});
test('streamed legacy migration preserves counter resets and reports a ready database only after complete input',async()=>{
 const dataRoot=temp(),ledger=new UsageLedger();for(let i=0;i<10;i++)ledger.ingestCodex({type:'event_msg',timestamp:`2026-10-10T00:00:0${i}Z`,payload:{type:'token_count',info:{total_token_usage:{input_tokens:i*10,output_tokens:i},last_token_usage:{input_tokens:10,output_tokens:1}}}},'s');
 await createSnapshotStorage(join(dataRoot,'monitor-index-v005.json')).writeText(JSON.stringify({version:1,ledger:ledger.serialize(),files:[],deltaFile:'absent.jsonl'}));
 const repo=new UsageRepository(join(dataRoot,'db.sqlite'));try{const result=await migrateLegacy(repo,dataRoot),dbLedger=new UsageLedger({},repo);dbLedger.sessions=result.sessions;assert.deepEqual(dbLedger.requestRows('codex:s'),ledger.requestRows('codex:s'));assert.deepEqual(dbLedger.snapshot().totals,ledger.snapshot().totals);assert.equal(repo.meta('ready'),true);}finally{repo.close();}
});
test('contribution updates are recoverable after facts commit and dimension counts survive a failed replacement',()=>{
 const path=join(temp(),'db.sqlite');let repo=new UsageRepository(path);repo.put('generic','one',row(1));repo.publish();repo.close();repo=new UsageRepository(path);
 assert.deepEqual([...repo.changedGroups()],['dsh:s1']);const sql=new SqlUsageQuery(repo);sql.replaceGroup('g',[row(1)]);sql.saveIndex();const expected=structuredClone(sql.query());
 assert.throws(()=>sql.replaceGroup('g',[row(2),row(2)]),/UNIQUE/);assert.deepEqual(sql.query().totals,expected.totals);assert.deepEqual(sql.query().facets,expected.facets);
 sql.saveIndex();repo.acknowledgeChanges();repo.close();repo=new UsageRepository(path);assert.deepEqual([...repo.changedGroups()],[]);assert.deepEqual(new SqlUsageQuery(repo).query().facets,expected.facets);repo.close();
});
test('v004 migration discards obsolete file offsets and recovers committed v005 orphan deltas only',async()=>{
 const root=temp(),ledger=new UsageLedger(),file='monitor-deltas-v005-123.jsonl';
 await createSnapshotStorage(join(root,'monitor-index-v004.json')).writeText(JSON.stringify({version:1,ledger:ledger.serialize(),files:[['old',{offset:99,size:99}]]}));
 const valid={version:1,ledger:{sessions:[],codex:[],claude:[]},files:[['new',{offset:10,size:10}]]};writeFileSync(join(root,file),JSON.stringify(valid)+'\n'+JSON.stringify({...valid,files:[['new',{offset:20,size:20}]]}).slice(0,-3));
 const repo=new UsageRepository(join(root,'db.sqlite'));try{const result=await migrateLegacy(repo,root);assert.equal(result.files.has('old'),false);assert.equal(result.files.get('new').offset,10);assert(result.invalid>0);assert.equal(repo.meta('ready'),true);}finally{repo.close();}
});
