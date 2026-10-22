import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,writeFileSync,appendFileSync,utimesSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSnapshotStorage,selectRetained,parseCommits,RETENTION} from '../src/storage.mjs';

const fresh=t=>{const dir=mkdtempSync(join(tmpdir(),'audit-b01-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const snapshots=dir=>readdirSync(join(dir,'state.json.snapshots')).filter(n=>n.endsWith('.json')&&!n.startsWith('retention-'));
const journalCommits=dir=>parseCommits(readFileSync(join(dir,'state.json.snapshots','commits.jsonl'),'utf8'));
async function publishMany(storage,count,label){for(let n=0;n<count;n++)await storage.writeText(JSON.stringify({label,n}));}

test('selectRetained keeps the newest 50 plus one commit per local day for 90 days',()=>{
 const now=Date.parse('2026-10-21T12:00:00Z'),day=86400000;
 const sameDay=Array.from({length:60},(_,n)=>({file:'f'+n,timestamp:new Date(now-60000*(60-n)).toISOString()}));
 const kept=selectRetained(sameDay,now);
 assert.equal(kept.size,RETENTION.recent);assert.ok(kept.has('f59')&&kept.has('f10')&&!kept.has('f9'));
 const daily=Array.from({length:100},(_,n)=>({file:'d'+n,timestamp:new Date(now-day*(99-n)).toISOString()}));
 const keptDaily=selectRetained(daily,now);
 assert.equal(keptDaily.size,90);assert.ok(keptDaily.has('d10')&&!keptDaily.has('d9'));
});

test('a store created with retention is pruned to the retained set and still loads its newest commit',async t=>{
 const dir=fresh(t),storage=createSnapshotStorage(join(dir,'state.json'));
 await publishMany(storage,120,'new');await storage.prune();
 assert.ok(snapshots(dir).length<=RETENTION.recent,`kept ${snapshots(dir).length}`);
 assert.equal(journalCommits(dir).commits.length,snapshots(dir).length);
 assert.equal(await storage.readText(),JSON.stringify({label:'new',n:119}));
 assert.equal(await createSnapshotStorage(join(dir,'state.json')).readText(),JSON.stringify({label:'new',n:119}));
 assert.ok(existsSync(join(dir,'state.json.snapshots','retention-archived.json')));
});

test('backlog written before retention stays until the store is marked archived',async t=>{
 const dir=fresh(t);
 await publishMany(createSnapshotStorage(join(dir,'state.json'),{retention:false}),100,'old');
 const backlog=new Set(snapshots(dir));
 const storage=createSnapshotStorage(join(dir,'state.json'));
 await publishMany(storage,60,'new');const result=await storage.prune();
 assert.equal(result.archived,false);
 for(const name of backlog)assert.ok(existsSync(join(dir,'state.json.snapshots',name)),'backlog file removed: '+name);
 assert.equal(snapshots(dir).length,100+RETENTION.recent);
 assert.equal(journalCommits(dir).commits.length,160,'journal is not rewritten before archiving');
 assert.equal(await createSnapshotStorage(join(dir,'state.json')).readText(),JSON.stringify({label:'new',n:59}));
 writeFileSync(join(dir,'state.json.snapshots','retention-archived.json'),'{}');
 const archived=await createSnapshotStorage(join(dir,'state.json')).prune();
 assert.equal(archived.archived,true);assert.ok(archived.rewritten);
 assert.equal(snapshots(dir).length,RETENTION.recent);
 assert.equal(await createSnapshotStorage(join(dir,'state.json')).readText(),JSON.stringify({label:'new',n:59}));
});

test('torn journal lines and old orphan files are removed; fresh orphans and backlog orphans are kept',async t=>{
 const dir=fresh(t),root=join(dir,'state.json.snapshots'),storage=createSnapshotStorage(join(dir,'state.json'));
 await publishMany(storage,5,'a');await storage.prune();
 appendFileSync(join(root,'commits.jsonl'),'{"file":"2026-');
 const old=new Date(Date.now()-2*3600000);
 const oldOrphan=old.toISOString().replaceAll(':','-')+'-orphan.json',freshOrphan=new Date().toISOString().replaceAll(':','-')+'-fresh.json';
 writeFileSync(join(root,oldOrphan),'');utimesSync(join(root,oldOrphan),old,old);writeFileSync(join(root,freshOrphan),'{"partial":');
 const result=await createSnapshotStorage(join(dir,'state.json')).prune();
 assert.equal(result.orphans,1);assert.ok(!existsSync(join(root,oldOrphan)));assert.ok(existsSync(join(root,freshOrphan)));
 assert.equal(journalCommits(dir).torn,0);assert.equal(journalCommits(dir).commits.length,5);
 const backlogDir=fresh(t),backlogRoot=join(backlogDir,'state.json.snapshots');
 await publishMany(createSnapshotStorage(join(backlogDir,'state.json'),{retention:false}),3,'old');
 const ancient=new Date(Date.now()-48*3600000),ancientOrphan=ancient.toISOString().replaceAll(':','-')+'-crash.json';
 writeFileSync(join(backlogRoot,ancientOrphan),'');utimesSync(join(backlogRoot,ancientOrphan),ancient,ancient);
 await createSnapshotStorage(join(backlogDir,'state.json')).prune();
 assert.ok(existsSync(join(backlogRoot,ancientOrphan)),'pre-retention orphan waits for the archive tool');
});

test('a crash between journal rewrite and file deletion is cleaned up by the next pass',async t=>{
 const dir=fresh(t),root=join(dir,'state.json.snapshots');
 await publishMany(createSnapshotStorage(join(dir,'state.json'),{retention:false}),60,'x');
 writeFileSync(join(root,'retention-archived.json'),'{}');
 const {commits}=journalCommits(dir),kept=commits.slice(-RETENTION.recent),gone=commits.slice(0,-RETENTION.recent);
 writeFileSync(join(root,'commits.jsonl'),kept.map(c=>'\n'+JSON.stringify(c)+'\n').join(''));
 const old=new Date(Date.now()-2*3600000);for(const c of gone)utimesSync(join(root,c.file),old,old);
 const result=await createSnapshotStorage(join(dir,'state.json')).prune();
 assert.equal(result.orphans,gone.length);assert.equal(snapshots(dir).length,RETENTION.recent);
 assert.equal(await createSnapshotStorage(join(dir,'state.json')).readText(),JSON.stringify({label:'x',n:59}));
});
