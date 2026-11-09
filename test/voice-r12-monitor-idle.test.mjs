import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {UsageRepository} from '../src/usage-repository.mjs';
import {normalizeTokens} from '../src/token-adapters.mjs';

const timestamp=i=>new Date(Date.UTC(2026,10,8)+i*1000).toISOString();
function countHistoryReads(repository){
 const counts={queries:0,rows:0,payloadRows:0,groupQueries:0,sql:[]},prepare=repository.db.prepare.bind(repository.db);
 repository.db.prepare=sql=>{
  const statement=prepare(sql);
  if(!/\b(?:facts|usage_contributions)\b/.test(sql)||!/^\s*(?:SELECT|WITH)/i.test(sql))return statement;
  for(const method of ['get','all','iterate']){
   const run=statement[method].bind(statement);
   statement[method]=(...args)=>{
    counts.queries++;if(/GROUP BY grp/.test(sql))counts.groupQueries++;if(!counts.sql.includes(sql))counts.sql.push(sql);
    const count=row=>{counts.rows++;if(/^SELECT key,value,grp,time,seq/.test(sql))counts.payloadRows++;return row;};
    if(method==='iterate')return (function*(){for(const row of run(...args))yield count(row);})();
    const result=run(...args);if(method==='all')result.forEach(count);else if(result)count(result);return result;
   };
  }
  return statement;
 };
 return counts;
}

test('unchanged worker scans and reward drains do not read historical usage rows',async t=>{
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,'voice-r12-idle-')),m=new TokenMonitor({dataRoot:root,home:root,env:{},roots:[]});
 t.after(async()=>{await m.close();assert.equal(dirname(root),parent);rmSync(root,{recursive:true,force:true});});
 await m.start();clearInterval(m.timer);clearInterval(m.legacy.timer);
 for(let i=0;i<50;i++){
  m.ledger.ingest({tool:'custom',sessionId:'group',requestId:'r'+i,sourceId:'synthetic',model:'synthetic',timestamp:timestamp(i),mode:'request',purpose:'work',status:'completed',usage:normalizeTokens({input:1,output:0})});
  m.legacy.ledger.ingestClaude({type:'assistant',sessionId:'native',timestamp:timestamp(i),message:{id:'c'+i,usage:{input_tokens:1,output_tokens:0}}},'native');
 }
 await m.persist();await m.legacy.persist();m.legacy.emit();
 assert.equal((await m.action('statistics')).totals.total,100);
 const before=m.analytics.rewardOutbox.pending(),generic=countHistoryReads(m.repository),legacy=countHistoryReads(m.legacy.repository);
 for(let i=0;i<10;i++){
  await m.legacy.scan(false);await m.scan(false);
  m.syncAnalytics();assert.deepEqual(m.analytics.rewardOutbox.pending(),before);
 }
 t.diagnostic(JSON.stringify({iterations:10,generic,legacy}));
 assert.equal(generic.rows+legacy.rows,0,'idle scans/drains must not revisit historical facts or contributions');
});

test('live appends in an existing session do not enumerate all historical groups again',async t=>{
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,'voice-r12-append-')),file=join(root,'api-usage.jsonl');
 const row=i=>({sessionId:'active',requestId:'r'+i,timestamp:timestamp(i),model:'synthetic',purpose:'galgame',usage:{input_tokens:1,output_tokens:0}});
 writeFileSync(file,Array.from({length:50},(_,i)=>JSON.stringify(row(i))).join('\n')+'\n');
 const m=new TokenMonitor({dataRoot:root,home:root,env:{}});
 t.after(async()=>{await m.close();assert.equal(dirname(root),parent);rmSync(root,{recursive:true,force:true});});
 await m.start();clearInterval(m.timer);clearInterval(m.legacy.timer);
 assert.equal((await m.action('statistics')).totals.total,50);m.genericSnapshot();
 const reads=countHistoryReads(m.repository);
 for(let i=50;i<60;i++){
  appendFileSync(file,JSON.stringify(row(i))+'\n');
  await m.scan(true);m.syncAnalytics();
 }
 const groups=reads.sql.filter(sql=>/GROUP BY grp/.test(sql));
 t.diagnostic(JSON.stringify({appendedRows:10,history:reads,groupQueries:groups}));
 assert.ok(reads.payloadRows<=10,'ten live appends must not reread their committed prefixes: '+reads.payloadRows);
 assert.equal(groups.length,0,'an append to the same kind/group must not invalidate the historical group listing');
 assert.equal((await m.action('statistics')).totals.total,60);
 assert.equal(m.genericSnapshot().totals.companion.total,60);
 assert.equal(m.analytics.rewardOutbox.pending().length,60);
});

test('group listings retain rank, pending publish order and moves while ignoring metadata writes',t=>{
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,'voice-r12-groups-')),repo=new UsageRepository(join(root,'usage.sqlite'));
 t.after(()=>{repo.close();assert.equal(dirname(root),parent);rmSync(root,{recursive:true,force:true});});
 const value=session=>({session,timestamp:timestamp(0)});
 repo.put('claude','a',value('shared'));repo.put('codex','b',value('later'));repo.publish();
 assert.deepEqual([...repo.groups(['codex','claude'])],['later','shared']);
 repo.put('codex','c',value('shared'));
 assert.deepEqual([...repo.groups(['codex','claude'])],['shared','later']);repo.publish();
 assert.deepEqual([...repo.groups(['codex','claude'])],['shared','later']);
 repo.put('codex','b',value('moved'));repo.publish();
 assert.deepEqual([...repo.groups(['codex','claude'])],['shared','moved']);
 repo.put('generic','z',value('z'));repo.put('generic','a',value('a'));
 assert.deepEqual([...repo.groups(['generic'])],['a','z']);repo.publish();
 assert.deepEqual([...repo.groups(['generic'])],['z','a']);
 const reads=countHistoryReads(repo);
 repo.put('files','file',{path:'synthetic',timestamp:timestamp(1)});repo.publish();
 assert.deepEqual([...repo.groups(['generic'])],['z','a']);assert.equal(reads.groupQueries,0);
});
