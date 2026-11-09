import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createLocalControlServer} from '../src/local-control.mjs';
import {normalizedPipe} from '../src/installation-record.mjs';
import {archiveSnapshotBacklog} from '../tools/archive-snapshot-backlog.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const rel='galgame/companion.json.snapshots';
function fixture(t){
 const base=mkdtempSync(join(tmpdir(),'snapshot-backlog-r14-')),dataRoot=join(base,'app/local/data-v003'),archiveRoot=join(base,'delete/disk-r14-20261108'),installationRoot=join(base,'app');
 const root=join(dataRoot,rel);mkdirSync(root,{recursive:true});
 const pipe='r14-fixture-'+randomUUID();
 writeFileSync(join(installationRoot,'local/installation.json'),JSON.stringify({schemaVersion:1,dataPath:null,pipe,build:'builds/fixture'}));
 mkdirSync(join(installationRoot,'builds/fixture'),{recursive:true});
 writeFileSync(join(installationRoot,'builds/fixture/package.json'),JSON.stringify({name:'r14-fixture',offlineSnapshotArchiveProtocol:1}));
 writeFileSync(join(installationRoot,'local/current-build.json'),JSON.stringify({path:'builds/fixture'}));
 const records=[];
 const add=(file,time,body=file)=>{writeFileSync(join(root,file),body);const c={file,timestamp:time,sha256:sha(body)};records.push(c);return c;};
 const commit=()=>writeFileSync(join(root,'commits.jsonl'),records.map(c=>JSON.stringify(c)+'\n').join(''));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 return {base,dataRoot,archiveRoot,installationRoot,root,records,add,commit,pipe:normalizedPipe(pipe),options:{dataRoot,archiveRoot,installationRoot,includeUsage:false}};
}
function seed(f){
 f.add('2026-01-01T01-00-00.000Z-a.json','2026-01-01T01:00:00Z','old');
 f.add('2026-01-01T02-00-00.000Z-b.json','2026-01-01T02:00:00Z','daily');
 f.commit();writeFileSync(join(f.root,'retention-baseline.json'),JSON.stringify({backlogUntil:Date.parse('2026-01-01T03:00:00Z'),journalBytes:Buffer.byteLength(readFileSync(join(f.root,'commits.jsonl')))}));
 f.add('2026-01-02T01-00-00.000Z-c.json','2026-01-02T01:00:00Z','latest');f.commit();
}
test('default dry-run reports daily thinning without changing any source files',async t=>{
 const f=fixture(t);seed(f);const before=readdirSync(f.root).map(n=>[n,sha(readFileSync(join(f.root,n)))]);
 const report=await archiveSnapshotBacklog(f.options);
 assert.equal(report.mode,'dry-run');assert.equal(report.stores[0].move.files,1);assert.equal(report.stores[0].keep.files,2);
 assert.equal(report.stores[0].latest.sha256Before,sha('latest'));
 assert.deepEqual(readdirSync(f.root).map(n=>[n,sha(readFileSync(join(f.root,n)))]),before);assert.equal(existsSync(f.archiveRoot),false);
});
test('a crash after journal publication or a rename keeps latest readable and can resume',async t=>{
 for(const stop of ['journal-published','file-moved']){
  const f=fixture(t);seed(f);let crashed=false;const orphan='2026-01-01T00-00-00.000Z-orphan.json';writeFileSync(join(f.root,orphan),'interrupted');
  const aged=new Date(Date.now()-2*3600000);for(const name of readdirSync(f.root))if(name.endsWith('.json'))utimesSync(join(f.root,name),aged,aged);
  await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true,checkpoint:stage=>{if(stage===stop&&!crashed){crashed=true;throw Error('simulated interruption');}}}),/simulated interruption/);
  assert.equal(await createSnapshotStorage(join(f.dataRoot,'galgame/companion.json')).readText(),'latest');
  await createSnapshotStorage(join(f.dataRoot,'galgame/companion.json')).prune(Date.now());
  assert.equal(await createSnapshotStorage(join(f.dataRoot,'galgame/companion.json')).readText(),'latest');
  const report=await archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true});
  assert.equal(report.stores[0].status,'archived');assert.equal(report.stores[0].latest.sha256After,sha('latest'));
  assert.ok(existsSync(join(f.archiveRoot,rel,'2026-01-01T01-00-00.000Z-a.json')));
  assert.ok(existsSync(join(f.archiveRoot,rel,orphan)));
 }
});
test('a malformed commit manifest keeps its referenced file instead of classifying it as disposable',async t=>{
 const f=fixture(t);seed(f);const file='2026-01-01T00-00-00.000Z-uncertain.json';writeFileSync(join(f.root,file),'uncertain');
 writeFileSync(join(f.root,'commits.jsonl'),readFileSync(join(f.root,'commits.jsonl'),'utf8')+JSON.stringify({file,sha256:'invalid'})+'\n');
 const r=await archiveSnapshotBacklog(f.options);assert.ok(r.stores[0].protectedFiles.includes(file));assert.ok(!r.stores[0].move.entries.some(x=>x.file===file));
});
test('a running application can be inventoried but apply is rejected without changing data',async t=>{
 const f=fixture(t);seed(f);const server=createLocalControlServer({onRequest:()=>({dataRoot:f.dataRoot,processId:process.pid})});
 await new Promise((yes,no)=>{server.once('error',no);server.listen(f.pipe,yes);});t.after(()=>new Promise(r=>server.close(r)));
 const before=readFileSync(join(f.root,'commits.jsonl'),'utf8');const report=await archiveSnapshotBacklog(f.options);
 assert.equal(report.runtime.state,'running');assert.equal(report.applyAllowed,false);assert.equal(report.stores[0].move.files,1);
 await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true}),/Apply blocked/);
 assert.equal(readFileSync(join(f.root,'commits.jsonl'),'utf8'),before);assert.equal(existsSync(f.archiveRoot),false);
});
test('a corrupt latest candidate and an orphan of uncertain date are retained conservatively',async t=>{
 const f=fixture(t);seed(f);const corrupt=f.add('2026-01-03T00-00-00.000Z-d.json','2026-01-03T00:00:00Z','intended');f.commit();writeFileSync(join(f.root,corrupt.file),'corrupt');
 writeFileSync(join(f.root,'unknown.json'),'unknown');const r=await archiveSnapshotBacklog(f.options);
 assert.equal(r.stores[0].latest.file,'2026-01-02T01-00-00.000Z-c.json');
 assert.ok(r.stores[0].keep.entries.find(x=>x.file==='unknown.json').reasons.includes('orphan-time-uncertain'));
 assert.ok(r.stores[0].protectedFiles.includes(corrupt.file));
});
test('usage dry-run retains fallback indexes and every referenced delta without reading delta bodies',async t=>{
 const f=fixture(t);seed(f);const usage=join(f.dataRoot,'monitor-index-v005.json.snapshots');mkdirSync(usage);
 const content=JSON.stringify({version:1,ledger:{},files:[],deltaFile:'monitor-deltas-v005-100.jsonl'}),file='latest.json';writeFileSync(join(usage,file),content);
 writeFileSync(join(usage,'commits.jsonl'),JSON.stringify({file,sha256:sha(content),timestamp:'2026-11-08T00:00:00Z'})+'\n');
 for(const n of ['monitor-index-v003.json.snapshots','monitor-index-v004.json.snapshots']){mkdirSync(join(f.dataRoot,n));writeFileSync(join(f.dataRoot,n,'old.json'),'{}');}
 const disposable='monitor-deltas-v005-99-00000000-0000-4000-8000-000000000000.jsonl';
 writeFileSync(join(f.dataRoot,'monitor-deltas-v005-100.jsonl'),'referenced');writeFileSync(join(f.dataRoot,'monitor-deltas-v005-99.jsonl'),'fallback recovery');writeFileSync(join(f.dataRoot,disposable),'unreferenced');
 const r=await archiveSnapshotBacklog({...f.options,includeUsage:true});
 assert.equal(r.usage.status,'planned');assert.ok(r.usage.retained.some(x=>x.relativePath==='monitor-index-v004.json.snapshots'));
 assert.ok(r.usage.retained.some(x=>x.relativePath==='monitor-deltas-v005-100.jsonl'));
 assert.ok(r.usage.retained.some(x=>x.relativePath==='monitor-deltas-v005-99.jsonl'&&x.reason==='fallback-orphan-recovery'));
 assert.ok(r.usage.candidates.some(x=>x.relativePath===disposable));
 assert.ok(!r.usage.candidates.some(x=>x.relativePath==='monitor-index-v003.json.snapshots'));
});
test('offline apply preserves latest content and daily snapshots even after runtime prune',async t=>{
 const f=fixture(t);seed(f);
 const orphan='2026-01-01T00-30-00.000Z-orphan.json';writeFileSync(join(f.root,orphan),'interrupted');
 writeFileSync(join(f.root,'unknown.json'),'uncertain');
 const report=await archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true});
 assert.equal(report.mode,'apply');assert.equal(report.stores[0].move.files,2);
 assert.equal(report.stores[0].latest.sha256After,sha('latest'));
 assert.ok(existsSync(join(f.archiveRoot,rel,orphan)));assert.equal(await createSnapshotStorage(join(f.dataRoot,'galgame/companion.json')).readText(),'latest');
 const store=createSnapshotStorage(join(f.dataRoot,'galgame/companion.json'));await store.prune(Date.parse('2026-11-08T00:00:00Z'));
 assert.ok(existsSync(join(f.root,'2026-01-01T02-00-00.000Z-b.json')));assert.ok(existsSync(join(f.root,'unknown.json')));
});
test('runtime locks, missing confirmation, identity mismatch, and unsafe destination fail closed',async t=>{
 const f=fixture(t);seed(f);const before=readFileSync(join(f.root,'commits.jsonl'),'utf8');
 await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true}),/confirm-stopped/);
 await assert.rejects(archiveSnapshotBacklog({...f.options,archiveRoot:join(f.base,'elsewhere'),apply:true,confirmStopped:true}),/Archive root/);
 writeFileSync(join(f.dataRoot,'runtime-instance.lock'),'');
 assert.equal((await archiveSnapshotBacklog(f.options)).runtime.state,'blocked');
 await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true}),/Apply blocked/);
 rmSync(join(f.dataRoot,'runtime-instance.lock'));
 writeFileSync(join(f.installationRoot,'local/installation.json'),JSON.stringify({schemaVersion:1,dataPath:join(f.base,'different'),pipe:'wrong'}));
 await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true}),/Apply blocked/);
 assert.equal(readFileSync(join(f.root,'commits.jsonl'),'utf8'),before);assert.equal(existsSync(f.archiveRoot),false);
});
test('each discovered top-level baseline is archived by day while authentication stores are excluded',async t=>{
 const f=fixture(t);seed(f);
 for(const logical of ['settings.json','quota-connections-v1.json']){
  const root=join(f.dataRoot,logical+'.snapshots');mkdirSync(root);
  const records=[];for(const [hour,body] of [['01','old'],['02','daily']]){
   const file=`2026-01-01T${hour}-00-00.000Z-${logical}`;writeFileSync(join(root,file),body);records.push({file,sha256:sha(body),timestamp:`2026-01-01T${hour}:00:00Z`});
  }
  const prefix=records.map(c=>JSON.stringify(c)+'\n').join('');writeFileSync(join(root,'retention-baseline.json'),JSON.stringify({backlogUntil:Date.parse('2026-01-01T03:00:00Z'),journalBytes:Buffer.byteLength(prefix)}));
  const file='2026-01-02T00-00-00.000Z-'+logical;writeFileSync(join(root,file),'latest');records.push({file,sha256:sha('latest'),timestamp:'2026-01-02T00:00:00Z'});
  writeFileSync(join(root,'commits.jsonl'),records.map(c=>JSON.stringify(c)+'\n').join(''));
 }
 const authentication=join(f.dataRoot,'auth.json.snapshots');mkdirSync(authentication);writeFileSync(join(authentication,'retention-baseline.json'),'must not be inspected');
 const r=await archiveSnapshotBacklog(f.options);
 for(const logical of ['settings.json','quota-connections-v1.json']){const store=r.stores.find(s=>s.relativePath===logical+'.snapshots');assert.equal(store.status,'planned');assert.equal(store.keep.files,2);assert.equal(store.move.files,1);}
 assert.ok(!r.stores.some(s=>s.relativePath==='auth.json.snapshots'));
 await archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true});
 for(const logical of ['settings.json','quota-connections-v1.json']){
  const store=createSnapshotStorage(join(f.dataRoot,logical));await store.prune(Date.now());assert.equal(await createSnapshotStorage(join(f.dataRoot,logical)).readText(),'latest');
  assert.ok(existsSync(join(f.dataRoot,logical+'.snapshots',`2026-01-01T02-00-00.000Z-${logical}`)));
 }
});
test('commits appended after baseline stay protected even if their timestamp is older',async t=>{
 const f=fixture(t);seed(f);const c=f.add('2025-12-31T00-00-00.000Z-after.json','2025-12-31T00:00:00Z','imported later');f.commit();
 const r=await archiveSnapshotBacklog(f.options);assert.ok(r.stores[0].protectedFiles.includes(c.file));assert.ok(!r.stores[0].move.entries.some(x=>x.file===c.file));
});
test('a damaged recovery plan is rejected while the current save remains readable',async t=>{
 const f=fixture(t);seed(f);
 await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true,checkpoint:stage=>{if(stage==='journal-published')throw Error('interrupted');}}),/interrupted/);
 const path=join(f.archiveRoot,rel,'.r14-transaction.json'),tx=JSON.parse(readFileSync(path,'utf8'));tx.store.move.entries[0].bytes++;
 writeFileSync(path,JSON.stringify(tx));await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true}),/Invalid archive recovery transaction/);
 assert.equal(await createSnapshotStorage(join(f.dataRoot,'galgame/companion.json')).readText(),'latest');
});
test('CLI reports cannot overwrite installation data, protected paths, or their ancestors',t=>{
 const targets=[
  ['--report-json',f=>join(f.installationRoot,'local/installation.json')],
  ['--report-md',f=>join(f.installationRoot,'builds/fixture/package.json')],
  ['--report-json',f=>join(f.dataRoot,'report.json')],
  ['--report-md',f=>join(f.archiveRoot,'report.md')],
  ['--report-json',f=>f.base],
  ['--report-md',f=>join(f.base,'delete')],
  ['--report-json',f=>join(f.base,'.codex/auth.json')],
  ['--report-md',f=>join(f.base,'.ssh/id_ed25519')],
  ['--report-json',f=>join(f.base,'reports/auth.json')],
 ];
 for(const [flag,target] of targets){
  const f=fixture(t);seed(f);const path=target(f),wasPresent=existsSync(path),identity=readFileSync(join(f.installationRoot,'local/installation.json'),'utf8');
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/archive-snapshot-backlog.mjs',import.meta.url)),'--data-root',f.dataRoot,'--archive-root',f.archiveRoot,'--installation-root',f.installationRoot,'--no-usage',flag,path],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.notEqual(child.status,0,'a protected report output must be rejected: '+path);assert.match(child.stderr,/Report output/);
  assert.equal(existsSync(path),wasPresent);assert.equal(readFileSync(join(f.installationRoot,'local/installation.json'),'utf8'),identity);
 }
});
test('offline apply rejects installed builds without the shared early-pipe protocol capability',async t=>{
 const f=fixture(t);seed(f);const before=readFileSync(join(f.root,'commits.jsonl'),'utf8');
 writeFileSync(join(f.installationRoot,'builds/fixture/package.json'),JSON.stringify({name:'old-host'}));
 const report=await archiveSnapshotBacklog(f.options);assert.equal(report.applyAllowed,false);assert.equal(report.runtime.offlineSnapshotArchiveProtocol,null);
 await assert.rejects(archiveSnapshotBacklog({...f.options,apply:true,confirmStopped:true}),/offlineSnapshotArchiveProtocol/);
 assert.equal(readFileSync(join(f.root,'commits.jsonl'),'utf8'),before);assert.equal(existsSync(f.archiveRoot),false);
});
