import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {UsageRepository} from '../src/usage-repository.mjs';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {UsageLedger} from '../src/ledger.mjs';
import {UsageQuery} from '../src/usage-query.mjs';
import {normalizeTokens} from '../src/token-adapters.mjs';
function repository(t){const root=mkdtempSync(join(tmpdir(),'voice-r8-usage-')),repo=new UsageRepository(join(root,'usage.sqlite'));t.after(()=>{repo.close();assert.equal(dirname(root),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});return repo;}
const event=(i,n=i+1)=>({tool:'custom',sessionId:'group',requestId:'r'+i,sourceId:'synthetic',model:'synthetic',workspace:'/project',timestamp:new Date(Date.UTC(2026,10,8)+i*1000).toISOString(),mode:'cumulative',purpose:'work',status:'completed',usage:normalizeTokens({input:n,output:0})});

test('committed ordered facts keep exact order without a temporary SQLite sort',t=>{
 const repo=repository(t);for(const i of [2,0,1])repo.put('generic','r'+i,event(i));repo.publish();
 const sql=[],prepare=repo.db.prepare.bind(repo.db);repo.db.prepare=query=>{sql.push(query);return prepare(query);};
 assert.deepEqual([...repo.entries('generic',{group:'custom:group',ordered:true})].map(([id])=>id),['r0','r1','r2']);
 const select=sql.findLast(query=>query.includes('SELECT')&&query.includes('facts')&&!query.includes('sqlite_master'));
 const plan=prepare('EXPLAIN QUERY PLAN '+select).all('generic','custom:group',...select.includes('UNION')?['generic','custom:group']:[]);
 assert.equal(plan.some(row=>row.detail.includes('TEMP B-TREE')),false,'committed ordered group must use facts_group directly');
});

async function monitor(t,root){root??=mkdtempSync(join(tmpdir(),'voice-r8-monitor-'));const m=new TokenMonitor({dataRoot:root,home:root,env:{},roots:[]});await m.start();t.after(async()=>{await m.close();});return {m,root};}
test('one cumulative append preserves statistics, snapshots and canonical outbox without replaying the committed prefix',async t=>{
 const {m}=await monitor(t);for(let i=0;i<100;i++)m.ledger.ingest(event(i));await m.persist();assert.equal((await m.action('statistics')).totals.total,100);assert.equal(m.genericSnapshot().totals.custom.total,100);
 const before=m.analytics.rewardOutbox.pending(),reads=[],entries=m.repository.entries.bind(m.repository);let seenWrites=0;const prepare=m.repository.db.prepare.bind(m.repository.db);m.repository.db.prepare=sql=>{const statement=prepare(sql);if(sql==='INSERT INTO contribution_seen VALUES(?)'){const run=statement.run.bind(statement);statement.run=(...args)=>{seenWrites++;return run(...args);};}return statement;};m.repository.entries=function*(...args){for(const row of entries(...args)){reads.push(row);yield row;}};
 m.ledger.ingest(event(100));await m.persist();assert.equal((await m.action('statistics')).totals.total,101);assert.equal(m.genericSnapshot().totals.custom.total,101);
 const after=m.analytics.rewardOutbox.pending();assert.equal(after.length,before.length+1);assert.equal(after.at(-1).totalTokens,1);assert.equal(after.at(-1).revision,1);
 await m.action('statistics');assert.deepEqual(m.analytics.rewardOutbox.pending(),after);
 assert.ok(reads.length<=2,'one appended row must not reread the 100-row committed prefix; visited '+reads.length);assert.equal(seenWrites,0);t.diagnostic(JSON.stringify({prefixRows:100,appendedRows:1,groupRowsVisited:reads.length,seenWrites}));
});

function oldEntries(repo,kind,{group,ordered=false,tieRequest=false}={}){
 repo.flush();const where=group===undefined?'kind=?':'kind=? AND grp=?',args=group===undefined?[kind]:[kind,group];
 const rows=`SELECT f.key,f.value,f.grp,f.time,f.seq FROM facts f WHERE ${where} AND NOT EXISTS(SELECT 1 FROM pending p WHERE p.kind=f.kind AND p.key=f.key) UNION ALL SELECT key,value,grp,time,COALESCE((SELECT seq FROM facts f2 WHERE f2.kind=pending.kind AND f2.key=pending.key),4611686018427387904+pending.rowid) FROM pending WHERE ${where}`;
 const sql=ordered&&tieRequest?`WITH rows AS MATERIALIZED (${rows}), ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY grp,time) AS ties FROM rows) SELECT r.key,r.value FROM ranked r ORDER BY r.grp,r.time,CASE WHEN ties>1 THEN (SELECT COUNT(*) FROM rows t WHERE t.grp=r.grp AND t.time=r.time AND buddy_locale_compare(json_extract(t.value,'$.requestId'),json_extract(r.value,'$.requestId'))<0) ELSE 0 END,r.seq`:`SELECT key,value FROM (${rows}) ${ordered?'ORDER BY grp,time,seq':'ORDER BY seq,key'}`;
 return repo.db.prepare(sql).all(...args,...args).map(r=>[r.key,JSON.parse(r.value)]);
}
test('indexed iteration matches old ordering across locale ties, missing IDs, overlays and moves out of a group',t=>{
 const repo=repository(t);for(const[i,id]of ['Z','a','A','é','e',undefined,null,2,'中','10','é'].entries())repo.put('generic','k'+i,{...event(i),requestId:id,sessionId:i%2?'other':'group',timestamp:event(0).timestamp});repo.publish();
 for(const phase of ['committed','pending','republished']){
  if(phase==='pending'){repo.put('generic','k0',{...event(0),sessionId:'moved'});repo.put('generic','new',{...event(0),requestId:'a'});}
  if(phase==='republished')repo.publish();
  for(const group of [undefined,'custom:group','custom:other','custom:moved'])for(const ordered of [false,true])for(const tieRequest of [false,true]){const options={group,ordered,tieRequest};assert.deepEqual([...repo.entries('generic',options)],oldEntries(repo,'generic',options),phase+JSON.stringify(options));}
 }
});

test('earlier and tail cumulative corrections deliberately rebuild subsequent contributions and retain historical reward facts',async t=>{
 const {m}=await monitor(t);for(let i=0;i<100;i++)m.ledger.ingest(event(i));await m.persist();await m.action('statistics');m.genericSnapshot();
 m.ledger.ingest(event(50,90));await m.persist();let value=await m.action('statistics');assert.equal(value.totals.total,100);assert.equal(value.totals.requests,61);assert.equal(m.genericSnapshot().totals.custom.total,100);
 const revision=m.analytics.rewardOutbox.pending().findLast(r=>r.canonicalRequestId==='custom:group:r50');assert.equal(revision.totalTokens,40);assert.equal(revision.revision,2);
 m.ledger.ingest(event(100,105));await m.persist();value=await m.action('statistics');assert.equal(value.totals.total,105);assert.equal(value.totals.requests,62);assert.equal(m.genericSnapshot().totals.custom.total,105);
 const facts=m.analytics.rewardOutbox.pending();assert.ok(facts.some(r=>r.canonicalRequestId==='custom:group:r51'),'removed analytic contribution does not retract historical reward facts');assert.equal(m.ledger.ingest(event(100,105)),false);await m.action('statistics');assert.deepEqual(m.analytics.rewardOutbox.pending(),facts);
});

test('failed contribution commit retains changes, outbox and checkpoints for exact retry and restart',async t=>{
 const {m,root}=await monitor(t);for(let i=0;i<10;i++)m.ledger.ingest(event(i));await m.persist();await m.action('statistics');const before=m.analytics.rewardOutbox.pending(),checkpoints=m.analyticsCheckpoints;
 m.ledger.ingest(event(10));await m.persist();m.repository.db.exec("CREATE TEMP TRIGGER r8_fail BEFORE INSERT ON usage_contributions WHEN NEW.key='custom:group:r10' BEGIN SELECT RAISE(ABORT,'r8 contribution fault');END;");
 await assert.rejects(m.action('statistics'),/r8 contribution fault/);assert.equal(m.analytics.query().totals.total,10);assert.deepEqual(m.analytics.rewardOutbox.pending(),before);assert.equal(m.analyticsCheckpoints,checkpoints);assert.ok([...m.repository.changedGroups()].includes('custom:group'));
 m.repository.db.exec('DROP TRIGGER r8_fail');assert.equal((await m.action('statistics')).totals.total,11);const after=m.analytics.rewardOutbox.pending();assert.equal(after.length,before.length+1);
 await m.close();const next=await monitor(t,root);assert.equal((await next.m.action('statistics')).totals.total,11);assert.deepEqual(next.m.analytics.rewardOutbox.pending(),after);next.m.ledger.ingest(event(11));await next.m.persist();assert.equal((await next.m.action('statistics')).totals.total,12);
});

test('unpublished companion usage is immediately visible through emit, statistics and reward drain without duplicate replay',async t=>{
 const {m}=await monitor(t),base={sessionId:'native',requestId:'first',timestamp:event(0).timestamp,purpose:'galgame',model:'native',usage:{input_tokens:10,output_tokens:2}};
 m.legacy.ingestCompanion(base);m.legacy.emit();assert.equal(m.legacySnapshot.totals.codex.total,12);assert.equal((await m.action('statistics')).totals.total,12);const first=m.analytics.rewardOutbox.pending();assert.equal(first.length,1);assert.equal(first[0].totalTokens,12);
 m.legacy.ingestCompanion({...base,requestId:'second',timestamp:event(1).timestamp,usage:{input_tokens:20,output_tokens:3}});m.legacy.emit();assert.equal(m.legacySnapshot.totals.codex.total,23);assert.equal((await m.action('statistics')).totals.total,23);const second=m.analytics.rewardOutbox.pending();assert.equal(second.length,2);assert.equal(second[1].totalTokens,11);
 await m.legacy.persist();await m.action('statistics');assert.deepEqual(m.analytics.rewardOutbox.pending(),second);
});

test('legacy Codex and Claude committed appends match full reducers and snapshots without reading their prefixes',async t=>{
 const {m}=await monitor(t),oracle=new UsageLedger(),live=m.legacy.ledger;
 const ingest=(ledger,i)=>{ledger.ingestCodex({type:'event_msg',timestamp:event(i).timestamp,payload:{type:'token_count',info:{total_token_usage:{input_tokens:i+1,output_tokens:0}}}},'codex');ledger.ingestClaude({type:'assistant',sessionId:'claude',timestamp:event(i).timestamp,message:{id:'c'+i,usage:{input_tokens:1,output_tokens:0}}},'claude');};
 for(let i=0;i<30;i++){ingest(live,i);ingest(oracle,i);}await m.legacy.persist();assert.equal((await m.action('statistics')).totals.total,60);live.snapshot();const reads=[],entries=m.legacy.repository.entries.bind(m.legacy.repository);m.legacy.repository.entries=function*(...args){for(const row of entries(...args)){reads.push(row);yield row;}};
 ingest(live,30);ingest(oracle,30);await m.legacy.persist();assert.equal((await m.action('statistics')).totals.total,62);assert.deepEqual(live.snapshot().totals,oracle.snapshot().totals);assert.ok(reads.length<=2,'appends must not reread native prefixes: '+reads.length);
 const query=new UsageQuery();for(const key of oracle.requestGroups.keys())query.replaceGroup(key,oracle.requestRows(key));assert.deepEqual(m.analytics.query().totals,query.query().totals);
});

test('equal timestamp appended batches preserve the distinct analytics seq and snapshot locale reducers',async t=>{
 const {m}=await monitor(t);for(let i=0;i<3;i++)m.ledger.ingest(event(i));await m.persist();await m.action('statistics');m.genericSnapshot();
 for(const[requestId,total]of [['Z',10],['A',12]])m.ledger.ingest({...event(4,total),requestId});await m.persist();
 const stats=await m.action('statistics'),snapshot=m.genericSnapshot();assert.equal(stats.totals.total,12);assert.equal(stats.totals.requests,5);assert.equal(snapshot.totals.custom.total,12);assert.equal(snapshot.totals.custom.requests,4);
});

test('legacy ACK failure after contribution commit replays idempotently and never loses outbox facts',async t=>{
 const {m}=await monitor(t);m.legacy.ingestCompanion({sessionId:'ack',requestId:'one',timestamp:event(0).timestamp,purpose:'galgame',model:'native',usage:{input_tokens:5,output_tokens:1}});await m.legacy.persist();
 const ack=m.legacy.repository.acknowledgeChanges.bind(m.legacy.repository);m.legacy.repository.acknowledgeChanges=()=>{throw Error('r8 legacy ACK fault');};
 await assert.rejects(m.action('statistics'),/r8 legacy ACK fault/);const pending=m.analytics.rewardOutbox.pending();assert.equal(pending.length,1);assert.ok([...m.legacy.repository.changedGroups()].includes('codex:ack'));
 m.legacy.repository.acknowledgeChanges=ack;assert.equal((await m.action('statistics')).totals.total,6);assert.deepEqual(m.analytics.rewardOutbox.pending(),pending);assert.deepEqual([...m.legacy.repository.changedGroups()],[]);
});

test('a newly available legacy mirror invalidates a companion append checkpoint',async t=>{
 const {m}=await monitor(t);m.ledger.ingest({...event(0),tool:'companion',reportedProvider:'codex'});await m.persist();assert.equal((await m.action('statistics')).totals.total,1);
 m.legacy.ingestCompanion({sessionId:'group',requestId:'native',timestamp:event(0).timestamp,purpose:'galgame',model:'native',usage:{input_tokens:10,output_tokens:0}});
 m.ledger.ingest({...event(1),tool:'companion',reportedProvider:'codex'});await m.persist();assert.equal((await m.action('statistics')).totals.total,10);
});

test('outer rollback restores group membership instead of caching the unpublished move',t=>{
 const repo=repository(t);repo.put('generic','row',{...event(0),sessionId:'old'});repo.publish();assert.deepEqual([...repo.groups(['generic'])],['custom:old']);
 assert.throws(()=>repo.transaction(()=>{repo.put('generic','row',{...event(0),sessionId:'new'});repo.publish();assert.deepEqual([...repo.groups(['generic'])],['custom:new']);throw Error('r8 outer rollback');}),/r8 outer rollback/);
 assert.equal([...repo.entries('generic',{group:'custom:old'})].length,1);assert.equal([...repo.entries('generic',{group:'custom:new'})].length,0);assert.deepEqual([...repo.groups(['generic'])],['custom:old']);
});

test('a generation observed inside a rolled back outer publish cannot authorize a later append checkpoint',t=>{
 const repo=repository(t);repo.put('generic','row',event(0));repo.publish();let uncommittedGeneration;
 assert.throws(()=>repo.transaction(()=>{repo.put('generic','second',event(1));repo.publish();uncommittedGeneration=repo.commitGeneration;throw Error('r8 hint rollback');}),/r8 hint rollback/);
 assert.equal(repo.get('generic','second'),undefined);assert.equal(repo.mutationSummary('generic','custom:group',uncommittedGeneration),null,'an unpublished epoch must force the full reducer');
 repo.put('generic','third',event(2));repo.publish();assert.equal(repo.mutationSummary('generic','custom:group',uncommittedGeneration),null,'a later commit must not legitimize the rolled back epoch');
 assert.deepEqual([...repo.entries('generic',{ordered:true})].map(([key])=>key),['row','third']);
});
