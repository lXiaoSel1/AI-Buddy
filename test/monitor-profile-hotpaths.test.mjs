import test from 'node:test';
import assert from 'node:assert/strict';
import path,{dirname,join,resolve} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {normalizeTokens} from '../src/token-adapters.mjs';

async function fixture(t,{sources=[]}={}){
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'monitor-hotpaths-'));
 const m=new TokenMonitor({dataRoot:join(root,'data'),home:root,env:{},roots:[]});
 t.after(async()=>{await m.close();assert.equal(dirname(root),parent);await rm(root,{recursive:true,force:true});});
 await m.sources.init();for(const source of sources)await m.sources.action('save',{format:'jsonl',...source,path:join(root,source.id)});
 await m.start();clearInterval(m.timer);clearInterval(m.legacy.timer);clearInterval(m.legacy.persistTimer);clearTimeout(m.legacy.debounce);for(const row of m.watchers)row.watcher.close();for(const row of m.legacy.watchers)row.close();m.watchers=[];m.legacy.watchers=[];
 return {m,root};
}

test('twenty thousand native sessions normalize each path once across unchanged source scans',async t=>{
 const {m}=await fixture(t,{sources:[{id:'codex-a',tool:'codex'},{id:'codex-b',tool:'codex'},{id:'claude-c',tool:'claude'}]}),sources=m.sources.list(),size=20000;
 for(let i=0;i<size;i++){const source=sources[i%3];m.legacy.ledger.session(source.tool,'s'+i,{path:join(source.path,'nested','session-'+i+'.jsonl'),workspace:'synthetic'});}
 await m.legacy.persist();m.legacy.emit();
 let calls=0;const original=path.resolve;path.resolve=(...args)=>{calls++;return original(...args);};syncBuiltinESMExports();
 try{await m.scan(false);const first=calls;await m.scan(false);const unchanged=calls-first;t.diagnostic(JSON.stringify({sessions:size,firstResolveCalls:first,unchangedResolveCalls:unchanged}));assert.ok(first<=size+80,'native status must resolve each session path at most once: '+first);assert.ok(unchanged<=80,'unchanged native status must reuse counts: '+unchanged);}
 finally{path.resolve=original;syncBuiltinESMExports();}
 assert.equal(sources.reduce((n,source)=>n+m.sources.statuses.get(source.id).records,0),size);
 m.legacy.ledger.session('codex','s0',{path:join(sources[1].path,'moved.jsonl')});m.legacy.emit();await m.scan(false);
 assert.equal(m.sources.statuses.get('codex-a').records,6666);assert.equal(m.sources.statuses.get('codex-b').records,6668);
 await m.action('save',{...sources[1],path:join(sources[1].path,'different-root')});await m.scan(false);
 // Retargeting still keeps the existing zero-count status presentation policy;
 // subsequent real session metadata must invalidate counts under the new root.
 m.legacy.ledger.session('codex','s0',{path:join(sources[1].path,'different-root','moved.jsonl')});m.legacy.emit();await m.scan(false);
 assert.equal(m.sources.statuses.get('codex-b').records,1);
 m.legacy.ledger.session('codex','s0',{path:join(sources[0].path,'moved-back.jsonl')});await m.scan(false);
 assert.equal(m.sources.statuses.get('codex-a').records,6666,'an unpublished live revision must not relabel the prior snapshot');
 m.legacy.emit();await m.scan(false);assert.equal(m.sources.statuses.get('codex-a').records,6667);
});

test('warm unchanged analytics drains avoid write transactions but retain attribution invalidation',async t=>{
 const {m}=await fixture(t);m.ledger.ingest({tool:'custom',sessionId:'s',requestId:'r',sourceId:'synthetic',model:'unmapped',timestamp:'2026-11-08T12:00:00Z',purpose:'work',status:'completed',usage:normalizeTokens({input:3,output:0})});await m.persist();m.syncAnalytics();
 const before=m.analytics.rewardOutbox.pending(),writes={transactions:0,acks:0};
 for(const repo of [m.repository,m.legacy.repository]){const exec=repo.db.exec.bind(repo.db);repo.db.exec=sql=>{if(sql==='SAVEPOINT buddy_write')writes.transactions++;if(sql==='DELETE FROM changes')writes.acks++;return exec(sql);};}
 for(let i=0;i<10;i++)m.syncAnalytics();t.diagnostic(JSON.stringify({unchangedDrains:10,...writes}));
 assert.equal(writes.transactions,0,'unchanged drains must not open a write transaction');assert.equal(writes.acks,0);assert.deepEqual(m.analytics.rewardOutbox.pending(),before);
 await m.attribution.save({sourceId:'synthetic',platform:'openai',billingRoute:'api'},m.analytics.rows.values(),m.timeZone);
 const value=await m.action('statistics');assert.equal(value.totals.total,3);assert.ok(value.facets.provider.includes('openai'));assert.ok(writes.transactions>0,'a real attribution change must still commit');
});

test('unchanged duplicate snapshots share a refresh window while heartbeat and real state changes still publish',async t=>{
 const {m}=await fixture(t);let at=Date.now(),published=0,sourceEvents=0;const output=[];
 t.mock.method(Date,'now',()=>at);m.listeners=value=>{published++;output.push(value);};m.onSources=()=>sourceEvents++;
 for(let i=0;i<10;i++){m.legacy.emit();await m.scan(false);}
 t.diagnostic(JSON.stringify({duplicateScanPairs:10,published,sourceEvents}));assert.equal(published,0,'same-state native/generic callbacks must not repeatedly merge and broadcast');assert.equal(sourceEvents,10,'snapshot coalescing must not skip source events');
 at+=m.refreshIntervalMs;m.emit();assert.equal(published,1,'the configured heartbeat is retained');
 await m.sources.action('alias',{id:'custom',name:'Synthetic label'});m.emit();assert.equal(published,2);
 m.errors.set('scan','synthetic error');m.emit();assert.equal(published,3);m.errors.delete('scan');m.emit();assert.equal(published,4);
 m.recordTask({sessionId:'task',timestamp:new Date(at).toISOString(),seq:1,turn:1,status:'running'},{id:'synthetic'});m.emit();assert.equal(published,5,'task status changes publish even without usage changes');
 assert.ok(output.at(-1).sessions.some(row=>row.id==='task'));
});
