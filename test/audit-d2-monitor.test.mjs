import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,statSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {LocalMonitor} from '../src/monitor.mjs';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {tmpDir} from './support/audit-harness.mjs';

// More than one 256 KiB read chunk, one JSON record per line.
function logFile(root,count=4000){
 const path=join(root,'session.jsonl');writeFileSync(path,Array.from({length:count},(_,i)=>JSON.stringify({type:'assistant',i,pad:'x'.repeat(100)})).join('\n')+'\n');return path;
}
function monitor(t,root,seen,onAudit=()=>{}){
 const m=new LocalMonitor({roots:[],dataRoot:join(root,'data'),onAudit});t.after(()=>m.close().catch(()=>{}));
 m.ledger.ingestClaude=(record,id)=>{seen.push(record.i);m.onRecord?.(seen.length);return id;};return m;
}

test('D2-4: a read interrupted by close resumes from where it stopped, without counting twice',async t=>{
 const root=tmpDir('d24',{t}),path=logFile(root),seen=[];
 const first=monitor(t,root,seen);first.onRecord=n=>{if(n===10)first.closed=true;};
 await first.readFile({path,provider:'claude'});
 const record=first.files.get(path);assert.ok(record.offset<statSync(path).size);assert.equal(record.size,record.offset);
 const second=monitor(t,root,seen);second.files=new Map(first.files);
 await second.readFile({path,provider:'claude'});
 assert.equal(seen.length,4000);assert.deepEqual([...new Set(seen)].length,4000);
 assert.equal(second.files.get(path).size,statSync(path).size);
});

test('D2-4: a record left by an older version (full size, smaller offset) is read on once and audited',async t=>{
 const root=tmpDir('d24-legacy',{t}),path=logFile(root),seen=[],audits=[];
 const earlier=[],probe=monitor(t,root,earlier);probe.onRecord=n=>{if(n===10)probe.closed=true;};await probe.readFile({path,provider:'claude'});
 const {scan,...old}=probe.files.get(path),info=statSync(path);old.size=info.size;
 const m=monitor(t,root,seen,row=>audits.push(row));m.files.set(path,old);
 await m.readFile({path,provider:'claude'});
 assert.ok(seen.length>0);assert.equal(earlier.length+seen.length,4000,'the rest is read, nothing twice');
 assert.equal(audits.length,1);assert.equal(audits[0].type,'monitor-resume');assert.equal(audits[0].from,old.offset);
 const before=seen.length;await m.readFile({path,provider:'claude'});assert.equal(seen.length,before,'only once');assert.equal(audits.length,1);
});

test('D2-6: close() still finishes after a failed start',async t=>{
 const root=tmpDir('d26',{t}),m=new LocalMonitor({roots:[],dataRoot:join(root,'data')});
 let persisted=false;m.persist=async()=>{persisted=true;};
 m.starting=Promise.reject(Error('index locked'));m.starting.catch(()=>{});
 await m.close();assert.equal(persisted,true);
});

test('D2-5: two quick restarts leave exactly one monitor running',async t=>{
 const root=tmpDir('d25',{t}),created=[],start=LocalMonitor.prototype.start;
 LocalMonitor.prototype.start=function(){created.push(this);return start.call(this);};t.after(()=>{LocalMonitor.prototype.start=start;});
 mkdirSync(join(root,'data'),{recursive:true});
 const host={options:{roots:[],dataRoot:join(root,'data')},sources:{list:()=>[]},repository:null,refreshIntervalMs:1000,errors:new Map(),emit(){},legacy:null};
 const restart=TokenMonitor.prototype.restartLegacy.bind(host);
 await Promise.all([restart(),restart(),restart()]);
 t.after(()=>host.legacy.close());
 assert.equal(created.length,3);assert.deepEqual(created.map(m=>m.closed),[true,true,false]);assert.equal(host.legacy,created[2]);
});

test('D2-6: a failed monitor start is reported and the next restart works',async t=>{
 const root=tmpDir('d26b',{t}),start=LocalMonitor.prototype.start;let fail=true;
 LocalMonitor.prototype.start=function(){if(fail)return this.starting=Promise.reject(Error('index locked'));return start.call(this);};t.after(()=>{LocalMonitor.prototype.start=start;});
 const host={options:{roots:[],dataRoot:join(root,'data')},sources:{list:()=>[]},repository:null,refreshIntervalMs:1000,errors:new Map(),emit(){},legacy:null};
 const restart=TokenMonitor.prototype.restartLegacy.bind(host);
 await assert.rejects(restart(),/index locked/);assert.match(host.errors.get('legacy-monitor'),/index locked/);
 fail=false;await restart();t.after(()=>host.legacy.close());
 assert.equal(host.errors.has('legacy-monitor'),false);
});
