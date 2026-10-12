import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,appendFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {LocalMonitor} from '../src/monitor.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
const root=join(import.meta.dirname,'../local/test-runs',String(Date.now()));
test('Partial UTF8 lines, append, rewrite, preserved history and cache restart',async()=>{
 const logs=join(root,'logs'),data=join(root,'cache');await mkdir(logs,{recursive:true});
 const path=join(logs,'session.jsonl');
 const meta={type:'session_meta',timestamp:'2026-10-07T12:00:00Z',payload:{id:'monitor-session',cwd:'E:\\鲸鱼工程'}};
 const usage={type:'event_msg',timestamp:'2026-10-07T16:00:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:20}}}};
 const text=JSON.stringify(meta)+'\n'+JSON.stringify(usage);
 await writeFile(path,text.slice(0,-10));
 let monitor=new LocalMonitor({roots:[{provider:'codex',path:logs}],dataRoot:data});await monitor.start();
 assert.equal(monitor.snapshot().totals.codex.total,0);
 await appendFile(path,text.slice(-10)+'\n');await monitor.scan();assert.equal(monitor.snapshot().totals.codex.total,120);
 await writeFile(path,text+'\n');await monitor.scan();assert.equal(monitor.snapshot().totals.codex.total,120);
 await monitor.close();monitor=new LocalMonitor({roots:[{provider:'codex',path:logs}],dataRoot:data});await monitor.start();assert.equal(monitor.snapshot().totals.codex.total,120);
 const next={...usage,timestamp:'2026-10-07T16:01:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:200,output_tokens:40}}}};
 await appendFile(path,JSON.stringify(next)+'\n');await monitor.scan();assert.equal(monitor.snapshot().totals.codex.total,240);await monitor.close();
 assert.equal(await readFile(path,'utf8'),text+'\n'+JSON.stringify(next)+'\n');
});
test('Version snapshots retain old files and reject stale writes',async()=>{
 const s=createSnapshotStorage(join(root,'safe','state.json'));await s.writeText('{"a":1}');const before=await s.stat();await s.writeText('{"a":2}',{kind:'replaceIfVersion',version:before.version});
 assert.equal(await s.readText(),'{"a":2}');await assert.rejects(()=>s.writeText('{"a":3}',{kind:'replaceIfVersion',version:before.version}),/version changed/);
 const files=await readdir(join(root,'safe','state.json.snapshots'));assert.equal(files.filter(f=>f.endsWith('.json')).length,2);
});

test('Watch latency, longer rewrite, large irrelevant records and absent logs',async()=>{
 const logs=join(root,'watch-logs'),data=join(root,'watch-cache');await mkdir(logs,{recursive:true});
 const path=join(logs,'rollout-2026-10-07T12-00-00-11111111-1111-1111-1111-111111111111.jsonl');
 const meta={type:'session_meta',timestamp:'2026-10-07T12:00:00Z',payload:{id:'11111111-1111-1111-1111-111111111111',cwd:'E:\\work'}};
 const count=(input,time)=>({type:'event_msg',timestamp:time,payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:0}}}});
 const initial=JSON.stringify(meta)+'\n'+JSON.stringify({type:'response_item',payload:{content:'z'.repeat(600000)}})+'\n'+JSON.stringify(count(100,'2026-10-07T16:00:00Z'))+'\n';
 await writeFile(path,initial);
 const monitor=new LocalMonitor({roots:[{provider:'codex',path:logs},{provider:'claude',path:join(root,'not-installed')}],dataRoot:data});await monitor.start();assert.equal(monitor.snapshot().totals.codex.total,100);assert.deepEqual(monitor.snapshot().errors,[]);
 const started=Date.now();await appendFile(path,JSON.stringify(count(150,'2026-10-07T16:01:00Z'))+'\n');
 while(monitor.snapshot().totals.codex.total!==150 && Date.now()-started<2100)await new Promise(r=>setTimeout(r,20));
 assert.equal(monitor.snapshot().totals.codex.total,150);assert.ok(Date.now()-started<2000);
 // A rewrite introduces one earlier counter and appends a larger final value.
 const rewritten=JSON.stringify(meta)+'\n'+JSON.stringify(count(50,'2026-10-07T15:59:00Z'))+'\n'+initial.slice(JSON.stringify(meta).length+1)+JSON.stringify(count(200,'2026-10-07T16:02:00Z'))+'\n';
 await writeFile(path,rewritten);await monitor.scan();assert.equal(monitor.snapshot().totals.codex.total,200);await monitor.close();
});

test('Companion numeric telemetry survives an empty new index and never awards work tokens',async()=>{
 const data=join(root,'own-telemetry');await mkdir(data,{recursive:true});
 const row={sessionId:'own-chat',model:'gpt-6.1-sol',timestamp:new Date().toISOString(),usage:{input_tokens:300,output_tokens:10}};
 await writeFile(join(data,'companion-usage.jsonl'),JSON.stringify(row)+'\n'+JSON.stringify(row)+'\n'+JSON.stringify(row).slice(0,-5));
 const monitor=new LocalMonitor({roots:[],dataRoot:data});await monitor.start();assert.equal(monitor.snapshot().totals.codex.total,310);assert.equal(monitor.snapshot().workTotal,0);assert.equal(monitor.snapshot().workSinceStart,0);await monitor.close();
 const restart=new LocalMonitor({roots:[],dataRoot:data});await restart.start();assert.equal(restart.snapshot().totals.codex.total,310);await restart.close();
});
test('Live monitor interval changes preserve the ledger and reject unsupported intervals',async()=>{
 const monitor=new LocalMonitor({roots:[],dataRoot:join(root,'refresh-settings'),refreshIntervalMs:2000});
 await monitor.start();try{
  const before=monitor.snapshot().totals,oldTimer=monitor.timer;
  monitor.setRefreshInterval(5000);assert.equal(monitor.refreshIntervalMs,5000);assert.notEqual(monitor.timer,oldTimer);
  assert.throws(()=>monitor.setRefreshInterval(0),/interval/);assert.equal(monitor.refreshIntervalMs,5000);
  await monitor.scan(true);assert.deepEqual(monitor.snapshot().totals,before);
 }finally{await monitor.close();}
});
