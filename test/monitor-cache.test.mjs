import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalMonitor} from '../src/monitor.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {replayMonitorDelta,monitorDeltaRows} from '../src/monitor-cache.mjs';

const count=n=>JSON.stringify({type:'event_msg',timestamp:'2026-10-01T12:'+String(n).padStart(2,'0')+':00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n*100,output_tokens:n*10}}}})+'\n';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'aichan-index-')),logs=join(root,'logs');await mkdir(logs);const file=join(logs,'session.jsonl');await writeFile(file,JSON.stringify({type:'session_meta',timestamp:'2026-10-01T12:00:00Z',payload:{id:'session',cwd:'E:/work'}})+'\n'+count(1));return {root,logs,file,roots:[{provider:'codex',path:logs}]};}
async function seed(f){const m=new LocalMonitor({roots:f.roots,dataRoot:join(f.root,'seed')});await m.start();await m.close();return m;}

test('v004 migration commits v005 even with unchanged usage; second boot reads zero historical bytes',async()=>{
 const f=await fixture(),old=await seed(f),dataRoot=join(f.root,'migration');
 await createSnapshotStorage(join(dataRoot,'monitor-index-v004.json')).writeText(JSON.stringify({version:1,ledger:old.ledger.serialize(),files:[...old.files]}));
 const m=new LocalMonitor({roots:f.roots,dataRoot});await m.start();assert.equal(m.startup.mode,'migration');assert.ok(m.startup.logBytesRead>0);await m.close();
 assert.ok(await readJson(createSnapshotStorage(join(dataRoot,'monitor-index-v005.json')),null));
 const next=new LocalMonitor({roots:f.roots,dataRoot});await next.start();assert.equal(next.startup.mode,'cached');assert.equal(next.startup.logBytesRead,0);assert.equal(next.startup.unchangedFiles,1);assert.deepEqual(next.snapshot().totals,m.snapshot().totals);assert.equal(next.snapshot().workSinceStart,0);await next.close();
});

test('orphan v005 deltas restore committed offsets chronologically, skip broken tails, then append only',async()=>{
 const f=await fixture(),old=await seed(f),dataRoot=join(f.root,'recover');await mkdir(dataRoot);
 const delta={version:1,ledger:old.ledger.serialize(),files:[...old.files]};
 await writeFile(join(dataRoot,'monitor-deltas-v005-10.jsonl'),JSON.stringify(delta)+'\n');
 await writeFile(join(dataRoot,'monitor-deltas-v005-11.jsonl'),'{"version":');
 const m=new LocalMonitor({roots:f.roots,dataRoot});await m.start();assert.equal(m.startup.mode,'recovered');assert.equal(m.startup.logBytesRead,0);assert.equal(m.snapshot().totals.codex.total,110);assert.equal(m.snapshot().errors.length,1);await m.close();
 const appended=count(2);await appendFile(f.file,appended);const next=new LocalMonitor({roots:f.roots,dataRoot});await next.start();assert.equal(next.startup.recoveredDeltaFiles,0);assert.equal(next.startup.logBytesRead,Buffer.byteLength(appended));assert.equal(next.snapshot().totals.codex.total,220);assert.equal(next.snapshot().workSinceStart,0);await next.close();
});

test('incomplete delta cannot advance offsets; delta filenames cannot escape profile',async()=>{
 const f=await fixture(),m=await seed(f),file='monitor-deltas-v005-1.jsonl';await writeFile(join(f.root,file),JSON.stringify({version:1,ledger:{sessions:[],codex:[]},files:[['x',{offset:90,size:90}]]})+'\n');
 const files=new Map(),r=await replayMonitorDelta(f.root,file,m.ledger,files);assert.equal(r.invalid,1);assert.equal(files.size,0);await assert.rejects(replayMonitorDelta(f.root,'../outside.jsonl',m.ledger,files),/filename/);
});

test('checkpoint publication failure retries dirty changes, rotation preserves old files and exact totals',async()=>{
 const f=await fixture(),m=await seed(f);m.closed=false;const before=m.snapshot().totals,oldName=m.deltaFile;
 m.hasCache=false;const store=m.cache;m.cache={writeText:async()=>{throw Error('disk unavailable')}};
 await assert.rejects(m.persist(),/disk unavailable/);assert.equal(m.hasCache,false);m.cache=store;await m.persist();assert.equal(m.hasCache,true);
 m.deltaBytes=65*1024*1024;m.saveRevision=-1;await m.persist();assert.notEqual(m.deltaFile,oldName);
 const next=new LocalMonitor({roots:f.roots,dataRoot:m.dataRoot});await next.start();assert.deepEqual(next.snapshot().totals,before);assert.equal(next.startup.logBytesRead,0);await next.close();await m.close();
});

test('progress checkpoint survives interrupted first scan without rereading completed files',async()=>{
 const f=await fixture(),dataRoot=join(f.root,'interrupt'),m=new LocalMonitor({roots:f.roots,dataRoot});
 const read=m.readFile.bind(m);m.readFile=async item=>{await read(item);await m.persist();m.closed=true;};await m.start();await m.close();
 const next=new LocalMonitor({roots:f.roots,dataRoot});await next.start();assert.equal(next.startup.logBytesRead,0);assert.equal(next.snapshot().totals.codex.total,110);await next.close();
});

test('cached paths outside the enabled roots remain history and are not polled again',async()=>{
 const f=await fixture(),seeded=await seed(f),m=new LocalMonitor({roots:[],dataRoot:seeded.dataRoot});await m.start();
 await appendFile(f.file,count(2));await m.scan(false);assert.equal(m.snapshot().totals.codex.total,110);assert.equal(m.progress.total,0);await m.close();
 const enabled=new LocalMonitor({roots:f.roots,dataRoot:seeded.dataRoot});await enabled.start();assert.equal(enabled.snapshot().totals.codex.total,220);await enabled.close();
});

test('streamed cache arrays survive chunk boundaries, escaped Unicode, empty arrays and broken transactions',async()=>{
 const f=await fixture(),file=join(f.root,'chunks.jsonl'),text='鲸鱼[{}]"\\'.repeat(16000);
 const row={version:1,ledger:{version:1,sessions:[['x',{name:text}]],codex:[['r',{session:'x',usage:{total:7}}]],claude:[]},files:[['path',{offset:7,size:7}]]};
 await writeFile(file,JSON.stringify(row)+'\n'+JSON.stringify(row).slice(0,-5)+'\n'+JSON.stringify(row));
 const parsed=[];for await(const item of monitorDeltaRows(file))parsed.push(item);assert.equal(parsed.length,3);assert.deepEqual(parsed[0].row.ledger.sessions,row.ledger.sessions);assert.equal(parsed[1].invalid,true);assert.deepEqual(parsed[2].row.files,row.files);
});
