import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {LocalMonitor} from '../src/monitor.mjs';

const timestamp=i=>new Date(Date.UTC(2026,10,8)+i*1000).toISOString();
function historyReads(repository){
 const counts={queries:0,payloadRows:0,sql:[]},prepare=repository.db.prepare.bind(repository.db);
 repository.db.prepare=sql=>{
  const statement=prepare(sql);if(!/\bfacts\b/.test(sql)||!/^\s*(?:SELECT|WITH)/i.test(sql))return statement;
  const iterate=statement.iterate.bind(statement);statement.iterate=(...args)=>(function*(){counts.queries++;if(!counts.sql.includes(sql))counts.sql.push(sql);for(const row of iterate(...args)){if(row.key!==undefined&&row.value!==undefined)counts.payloadRows++;yield row;}})();return statement;
 };
 return counts;
}

test('native file appends before the periodic publish do not reread their historical prefix',async t=>{
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(parent,'voice-r12-native-')),logs=join(root,'logs'),file=join(logs,'rollout-12345678-1234-1234-1234-123456789abc.jsonl');await mkdir(logs);
 const row=i=>({type:'event_msg',timestamp:timestamp(i),payload:{type:'token_count',info:{total_token_usage:{input_tokens:i+1,output_tokens:0}}}});
 await writeFile(file,[{type:'session_meta',timestamp:timestamp(0),payload:{id:'12345678-1234-1234-1234-123456789abc',cwd:'/synthetic'}},...Array.from({length:50},(_,i)=>row(i))].map(JSON.stringify).join('\n')+'\n');
 const m=new TokenMonitor({dataRoot:join(root,'data'),home:root,env:{},roots:[{provider:'codex',path:logs}]});
 t.after(async()=>{await m.close();assert.equal(dirname(root),parent);await rm(root,{recursive:true,force:true});});
 await m.start();clearInterval(m.timer);clearInterval(m.legacy.timer);clearInterval(m.legacy.persistTimer);clearTimeout(m.legacy.debounce);for(const watcher of m.legacy.watchers)watcher.close();m.legacy.watchers=[];
 assert.equal((await m.action('statistics')).totals.total,50);
 const reads=historyReads(m.legacy.repository),writes={rows:0,jsonBytes:0,kinds:{},writeTransactions:0},put=m.legacy.repository.statements.put.run.bind(m.legacy.repository.statements.put),exec=m.legacy.repository.db.exec.bind(m.legacy.repository.db);
 m.legacy.repository.statements.put.run=(...args)=>{writes.rows++;writes.jsonBytes+=Buffer.byteLength(args[4]);writes.kinds[args[0]]=(writes.kinds[args[0]]??0)+1;return put(...args);};
 m.legacy.repository.db.exec=sql=>{if(sql==='SAVEPOINT buddy_write'&&!m.legacy.repository.db.isTransaction)writes.writeTransactions++;return exec(sql);};
 for(let i=50;i<60;i++){
  await appendFile(file,JSON.stringify(row(i))+'\n');
  // Exercise the real scan path before its 15-second periodic publish.
  await m.legacy.scan(false);m.syncAnalytics();
 }
 t.diagnostic(JSON.stringify({appendedRows:10,reads,writes}));
 assert.equal(m.legacySnapshot.totals.codex.total,60);assert.equal(m.analytics.query().totals.total,60);
 assert.ok(reads.payloadRows<=20,'snapshot plus analytics must not revisit 50 committed native rows on each append: '+reads.payloadRows);
});

test('scheduled native publish failure records the index error and retries without broadcasting uncommitted facts',async t=>{
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(parent,'voice-r12-native-fault-')),logs=join(root,'logs'),file=join(logs,'12345678-1234-1234-1234-123456789abc.jsonl');await mkdir(logs);
 const row=i=>({type:'event_msg',timestamp:timestamp(i),payload:{type:'token_count',info:{total_token_usage:{input_tokens:i+1,output_tokens:0}}}});
 await writeFile(file,JSON.stringify(row(0))+'\n');
 const snapshots=[],audit=[],m=new LocalMonitor({roots:[{provider:'codex',path:logs}],dataRoot:join(root,'data'),persistentHistory:true,onUpdate:value=>snapshots.push(value),onAudit:value=>audit.push(value)});
 t.after(async()=>{m.repository.db.exec('DROP TRIGGER IF EXISTS r12_native_fail');await m.close();assert.equal(dirname(root),parent);await rm(root,{recursive:true,force:true});});
 await m.start();clearInterval(m.timer);clearInterval(m.persistTimer);clearTimeout(m.debounce);for(const watcher of m.watchers)watcher.close();m.watchers=[];
 const before=snapshots.length;
 m.repository.db.exec("CREATE TEMP TRIGGER r12_native_fail BEFORE INSERT ON facts WHEN NEW.kind='codex' BEGIN SELECT RAISE(ABORT,'r12 native publish fault');END;");
 await appendFile(file,JSON.stringify(row(1))+'\n');m.schedule();
 for(let i=0;i<100&&!m.errors.has('index-cache');i++)await new Promise(r=>setTimeout(r,5));
 assert.match(m.errors.get('index-cache')??'',/r12 native publish fault/);assert.equal(snapshots.length,before);
 assert.equal(snapshots.at(-1).totals.codex.total,1);assert.equal(m.dirtyFiles.has(file),true);assert.ok(m.ledger.dirtySessions.size);
 assert.ok(audit.some(row=>row.type==='monitor-persist-error'&&row.path==='index-cache'));
 await assert.rejects(m.scan(true),/r12 native publish fault/);assert.equal(snapshots.length,before);
 m.repository.db.exec('DROP TRIGGER r12_native_fail');await m.scan(false);
 assert.equal(snapshots.at(-1).totals.codex.total,2);assert.equal(m.errors.has('index-cache'),false);assert.equal(m.errors.has('scan'),false);assert.equal(m.dirtyFiles.size,0);
});

test('initial native publish failure rejects startup before any uncommitted ready snapshot',async t=>{
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(parent,'voice-r12-native-start-')),logs=join(root,'logs'),file=join(logs,'12345678-1234-1234-1234-123456789abc.jsonl');await mkdir(logs);
 await writeFile(file,JSON.stringify({type:'event_msg',timestamp:timestamp(0),payload:{type:'token_count',info:{total_token_usage:{input_tokens:1,output_tokens:0}}}})+'\n');
 const snapshots=[],m=new LocalMonitor({roots:[{provider:'codex',path:logs}],dataRoot:join(root,'data'),persistentHistory:true,onUpdate:value=>snapshots.push(value)});
 t.after(async()=>{m.repository.db.exec('DROP TRIGGER IF EXISTS r12_start_fail');await m.close();assert.equal(dirname(root),parent);await rm(root,{recursive:true,force:true});});
 m.repository.db.exec("CREATE TEMP TRIGGER r12_start_fail BEFORE INSERT ON facts WHEN NEW.kind='codex' BEGIN SELECT RAISE(ABORT,'r12 initial publish fault');END;");
 await assert.rejects(m.start(),/r12 initial publish fault/);
 assert.equal(m.indexing,true);assert.ok(snapshots.every(value=>value.totals.codex.total===0));assert.match(m.errors.get('index-cache'),/r12 initial publish fault/);
});
