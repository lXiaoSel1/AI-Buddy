import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TokenMonitor,GenericTokenLedger} from '../src/token-monitor.mjs';
import {UsageLedger} from '../src/ledger.mjs';
import {UsageRepository} from '../src/usage-repository.mjs';
import {SqlUsageQuery} from '../src/usage-query-sqlite.mjs';
import {WorkUsageAttribution} from '../src/work-usage-attribution.mjs';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'work-stats-')),repo=new UsageRepository(join(root,'generic.sqlite')),legacyRepo=new UsageRepository(join(root,'legacy.sqlite'));
 const workUsage=new WorkUsageAttribution(root);await workUsage.ready;
 const sources=[{id:'logs',tool:'codex',path:join(root,'logs')}],ledger=new UsageLedger({},legacyRepo),generic=new GenericTokenLedger(repo),analytics=new SqlUsageQuery(repo);
 const m=Object.assign(Object.create(TokenMonitor.prototype),{repository:repo,legacy:{repository:legacyRepo,ledger},ledger:generic,workUsage,sources:{list:()=>sources},attribution:{revision:0},analytics,analyticsSources:repo.meta('analyticsSources'),analyticsProjection:repo.meta('analyticsProjection')});
 for(const id of ['a','b']){ledger.ingestCodex({type:'session_meta',timestamp:'2026-10-30T00:00:00Z',payload:{id,cwd:join(root,'private')}},id,join(root,'logs',id+'.jsonl'));ledger.ingestCodex({type:'event_msg',timestamp:'2026-10-30T00:01:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:10}}}},id,join(root,'logs',id+'.jsonl'));}
 legacyRepo.publish();m.syncAnalytics();
 const calls=[],replace=analytics.replaceGroup.bind(analytics);analytics.replaceGroup=(id,rows)=>{calls.push(id);return replace(id,rows);};
 t.after(()=>{repo.close();legacyRepo.close();rmSync(root,{recursive:true,force:true});});
 const source=id=>({id:'work-'+id,tool:'codex',path:join(root,'logs',id+'.jsonl'),workAttribution:{schemaVersion:1,origin:'work-host-v1',pluginId:'test.plugin',jobId:'job',taskId:'task',runId:'run-'+id,memberId:'member',nativeSessionId:id,nativeParentId:null,projectId:'shared',projectPath:join(root,'shared'),ownerScope:{characterId:'c',personaId:'p',lifeId:'l',operationId:'o'}}});
 return {m,repo,legacyRepo,ledger,generic,analytics,sources,workUsage,calls,root,source};
}
test('a new unrelated work source does not rewrite historical sessions',async t=>{
 const f=await fixture(t),v=f.source('new');f.sources.push(v);await f.workUsage.register(v);f.m.syncAnalytics();assert.deepEqual(f.calls,[]);assert.equal(f.analytics.query().totals.total,220);
});
test('new exact work attribution updates only its session and survives checkpoint reload',async t=>{
 const f=await fixture(t),v=f.source('a');f.sources.push(v);await f.workUsage.register(v);f.m.syncAnalytics();assert.deepEqual(f.calls,['codex:a']);
 const rows=[...f.analytics.rows.values()];assert.equal(rows.find(r=>r.sessionId==='a').workspace,join(f.root,'shared'));assert.equal(rows.find(r=>r.sessionId==='b').workspace,join(f.root,'private'));
 f.m.analyticsProjection=structuredClone(f.repo.meta('analyticsProjection'));f.m.analyticsSources=f.repo.meta('analyticsSources');f.calls.length=0;f.m.syncAnalytics();assert.deepEqual(f.calls,[]);
});
test('source path boundaries and removed overrides preserve neighbouring sessions',async t=>{
 const f=await fixture(t);f.sources.push({id:'neighbour',tool:'codex',path:join(f.root,'logs-other'),aliasProvider:'openai'});f.m.syncAnalytics();assert.deepEqual(f.calls,[]);
 f.sources.push({id:'exact',tool:'codex',path:join(f.root,'logs','a.jsonl'),aliasProvider:'openai'});f.m.syncAnalytics();assert.deepEqual(f.calls,['codex:a']);f.calls.length=0;
 f.sources.splice(f.sources.findIndex(x=>x.id==='exact'),1);f.m.syncAnalytics();assert.deepEqual(f.calls,['codex:a']);
});
test('global attribution changes still rebuild and failed changes replay their original scope',async t=>{
 const f=await fixture(t);f.m.attribution.revision++;f.m.syncAnalytics();assert.deepEqual(f.calls.sort(),['codex:a','codex:b']);f.calls.length=0;
 const prior=f.repo.meta('analyticsSources'),v=f.source('a');f.sources.push(v);await f.workUsage.register(v);
 const original=f.analytics.replaceGroup;f.analytics.replaceGroup=()=>{throw Error('controlled failure');};assert.throws(()=>f.m.syncAnalytics(),/controlled failure/);assert.equal(f.repo.meta('analyticsSources'),prior);
 f.analytics.replaceGroup=original;f.m.syncAnalytics();assert.deepEqual(f.calls,['codex:a']);
});
test('matching legacy checkpoint seeds new metadata without rewriting old rows',async t=>{
 const f=await fixture(t);delete f.m.analyticsProjection;f.repo.db.prepare("DELETE FROM meta WHERE key='analyticsProjection'").run();f.m.syncAnalytics();assert.deepEqual(f.calls,[]);assert.ok(f.repo.meta('analyticsProjection'));
});
const row=(id,total=10)=>({tool:'dsh',requestId:id,sessionId:'s',sourceId:'source',purpose:'work',model:'deepseek-chat',timestamp:'2099-01-01T00:00:00Z',usage:{input:total,output:0,total,requests:1}});
test('unchanged group and streaming correction write only changed contributions and rewards',async t=>{
 const f=await fixture(t),q=f.analytics;q.rewardLive=()=>true;q.replaceGroup('g',[row('a'),row('b')]);q.rewardOutbox.ack(q.rewardOutbox.pending().map(r=>r.seq));
 f.repo.db.exec("CREATE TEMP TABLE writes(kind TEXT); CREATE TEMP TRIGGER probe_insert AFTER INSERT ON main.usage_contributions BEGIN INSERT INTO writes VALUES('insert'); END; CREATE TEMP TRIGGER probe_delete AFTER DELETE ON main.usage_contributions BEGIN INSERT INTO writes VALUES('delete'); END; CREATE TEMP TRIGGER probe_update AFTER UPDATE ON main.usage_contributions BEGIN INSERT INTO writes VALUES('update'); END;");
 const seq=f.repo.db.prepare('SELECT seq FROM usage_contributions WHERE key=?').get('g:b').seq,revision=q.revision;
 q.replaceGroup('g',[row('a'),row('b')]);assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM writes').get().n,0);assert.equal(q.revision,revision);assert.equal(q.rewardOutbox.pending().length,0);
 q.query();q.replaceGroup('g',[row('a',15),row('b')]);assert.deepEqual(f.repo.db.prepare('SELECT kind FROM writes').all().map(r=>r.kind),['update']);assert.equal(f.repo.db.prepare('SELECT seq FROM usage_contributions WHERE key=?').get('g:b').seq,seq);assert.equal(q.rewardOutbox.pending().length,1);assert.equal(q.query().totals.total,245);
});
test('removals and iterator failure retain transactional query and reward state',async t=>{
 const f=await fixture(t),q=f.analytics;q.replaceGroup('g',[row('a'),row('b')]);const before=structuredClone(q.query().totals),pending=q.rewardOutbox.pending();
 function* broken(){yield row('a',50);throw Error('iterator failed');}assert.throws(()=>q.replaceGroup('g',broken()),/iterator failed/);assert.deepEqual(q.query().totals,before);assert.deepEqual(q.rewardOutbox.pending(),pending);
 q.replaceGroup('g',[row('b')]);assert.equal(q.query().totals.total,230);q.replaceGroup('g',[]);assert.equal(q.query().totals.total,220);
});
test('older reader checkpoint drift and unknown projection policy keep safe full rebuild',async t=>{
 const f=await fixture(t);f.m.analyticsSources='older-reader-signature';f.repo.meta('analyticsSources',f.m.analyticsSources);f.m.syncAnalytics();assert.deepEqual(f.calls.sort(),['codex:a','codex:b']);f.calls.length=0;
 f.workUsage.key='different-policy';f.m.syncAnalytics();assert.deepEqual(f.calls.sort(),['codex:a','codex:b']);
});
test('DSH history claim changes only its session and retains unknown attribution after restart',async t=>{
 const f=await fixture(t),v={...f.source('s'),tool:'dsh'};f.sources.push(v);await f.workUsage.register(v);
 f.generic.ingest({...row('x'),turnId:2,sourceId:v.id,location:{file:v.path}});f.generic.ingest({...row('other'),sessionId:'other',location:{file:join(f.root,'unrelated')}});f.repo.publish();f.m.syncAnalytics();f.calls.length=0;
 await f.workUsage.register({...v,nativeHistoryRange:{version:1,claimId:'native-claim:test',nativeSessionId:'s',sourcePath:v.path,prefixSha256:'a'.repeat(64),afterTurnExclusive:0,throughTurnInclusive:null,workAttribution:v.workAttribution}});f.m.syncAnalytics();assert.deepEqual(f.calls,['dsh:s']);assert.equal([...f.analytics.rows.values()].find(r=>r.requestId==='x').workAttribution.state,'verified');
 f.workUsage.adopt([...f.workUsage.records.values()],[]);f.calls.length=0;f.m.syncAnalytics();assert.deepEqual(f.calls,['dsh:s']);assert.equal([...f.analytics.rows.values()].find(r=>r.requestId==='x').workAttribution.reason,'native-history-claim-needs-reconfirmation');assert.equal(f.analytics.query().totals.total,240);
});
test('cumulative generic updates retain previous deltas and overlap changes only their source',async t=>{
 const f=await fixture(t);f.sources.push({id:'source',tool:'dsh',path:join(f.root,'native')});
 f.generic.ingest({...row('one',10),mode:'cumulative'});f.generic.ingest({...row('two',30),mode:'cumulative',timestamp:'2099-01-01T00:01:00Z'});f.repo.publish();f.m.syncAnalytics();assert.equal(f.analytics.query().totals.total,250);f.calls.length=0;
 f.generic.ingest({...row('two',40),mode:'cumulative',timestamp:'2099-01-01T00:01:00Z'});f.repo.publish();f.m.syncAnalytics();assert.deepEqual(f.calls,['dsh:s']);assert.equal(f.analytics.query().totals.total,260);
 f.calls.length=0;Object.assign(f.sources.at(-1),{overlapGroup:'same',primary:false});f.m.syncAnalytics();assert.deepEqual(f.calls,['dsh:s']);assert.equal(f.analytics.query().totals.total,220);
});
test('duplicate and ambiguous group keys fail without modifying committed contributions',async t=>{
 const f=await fixture(t),q=f.analytics;q.replaceGroup('g',[row('a:b')]);const before=[...q.rows.values()];
 assert.throws(()=>q.replaceGroup('g',[row('a:b'),row('a:b',20)]));assert.deepEqual([...q.rows.values()],before);
 assert.throws(()=>q.replaceGroup('g:a',[row('b')]),/another group/);assert.deepEqual([...q.rows.values()],before);
});
