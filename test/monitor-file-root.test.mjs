import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {LocalMonitor} from '../src/monitor.mjs';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {DatabaseSync} from 'node:sqlite';

const base=join(import.meta.dirname,'../local/test-runs');
const meta=id=>({type:'session_meta',timestamp:'2026-10-25T05:00:00Z',payload:{id,cwd:'E:/controlled-monitor-file-root',model_provider:'openai'}});
const usage=(input,time='2026-10-25T05:01:00Z')=>({type:'event_msg',timestamp:time,payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:10}}}});
const text=(id,input)=>JSON.stringify(meta(id))+'\n'+JSON.stringify(usage(input))+'\n';
async function fixture(t,name,files){await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,name+'-')),logs=join(root,'logs');await mkdir(logs);for(const [name,bytes]of Object.entries(files))await writeFile(join(logs,name),bytes);const monitor=new LocalMonitor({roots:[],dataRoot:join(root,'data'),refreshIntervalMs:1000,persistentHistory:true});t.after(()=>monitor.close());return {root,logs,monitor};}
async function eventually(check,message){const started=Date.now();while(!check()&&Date.now()-started<4500)await new Promise(done=>setTimeout(done,20));assert.ok(check(),message);}

test('exact Codex and Claude log files ingest without admitting sibling logs, persist and restart',async t=>{
 const f=await fixture(t,'exact-native-files',{'parent.jsonl':text('parent',100),'sibling.jsonl':text('unregistered-sibling',9000),'claude.jsonl':JSON.stringify({type:'assistant',timestamp:'2026-10-25T05:02:00Z',sessionId:'claude-file',message:{id:'claude-message',model:'claude-controlled',usage:{input_tokens:30,output_tokens:7}}})+'\n'});
 const roots=[{provider:'codex',path:join(f.logs,'parent.jsonl')},{provider:'claude',path:join(f.logs,'claude.jsonl')}];f.monitor.roots=roots;await f.monitor.start();assert.equal(f.monitor.snapshot().totals.codex.total,110);assert.equal(f.monitor.snapshot().totals.claude.total,37);assert.equal(f.monitor.files.has(join(f.logs,'sibling.jsonl')),false);assert.deepEqual(f.monitor.snapshot().errors,[]);await f.monitor.close();
 const restarted=new LocalMonitor({roots,dataRoot:join(f.root,'data'),persistentHistory:true});t.after(()=>restarted.close());await restarted.start();assert.equal(restarted.snapshot().totals.codex.total,110);assert.equal(restarted.snapshot().totals.claude.total,37);assert.equal(restarted.files.has(join(f.logs,'sibling.jsonl')),false);
});

test('exact file watcher ingests append once and ignores sibling create/update',async t=>{
 const f=await fixture(t,'exact-native-append',{'owned.jsonl':text('owned',100)}),path=join(f.logs,'owned.jsonl');f.monitor.roots=[{provider:'codex',path}];await f.monitor.start();await appendFile(path,JSON.stringify(usage(150,'2026-10-25T05:02:00Z'))+'\n');await eventually(()=>f.monitor.snapshot().totals.codex.total===160,'actual exact-file append must arrive through watcher/timer');await writeFile(join(f.logs,'not-admitted.jsonl'),text('not-admitted',9000));await f.monitor.scan(true);assert.equal(f.monitor.snapshot().totals.codex.total,160);assert.equal(f.monitor.files.size,1);await f.monitor.scan(true);assert.equal(f.monitor.snapshot().totals.codex.total,160);
});

test('exact file replacement, deletion and recreation preserve history and clear stale errors',async t=>{
 const f=await fixture(t,'exact-native-rotate',{'owned.jsonl':text('owned',100)}),path=join(f.logs,'owned.jsonl');f.monitor.roots=[{provider:'codex',path}];await f.monitor.start();await rename(path,join(f.logs,'rotated.jsonl'));await eventually(()=>f.monitor.errors.has(path),'deleted exact root must be visible as missing, while retaining historical usage');assert.equal(f.monitor.snapshot().totals.codex.total,110);await writeFile(path,text('owned',200));await eventually(()=>f.monitor.snapshot().totals.codex.total===210&&!f.monitor.errors.has(path),'replacement under the same registered path must be read');assert.equal(f.monitor.files.has(join(f.logs,'rotated.jsonl')),false);await unlink(path);await eventually(()=>f.monitor.errors.has(path),'second deletion must not silently report a live file');await writeFile(path,text('owned',250));await eventually(()=>f.monitor.snapshot().totals.codex.total===260&&!f.monitor.errors.has(path),'watcher must survive repeated deletion/recreation');
});

test('a missing exact file can appear later without widening its registered scope',async t=>{
 const f=await fixture(t,'exact-native-missing',{'sibling.jsonl':text('sibling',9000)}),path=join(f.logs,'future.jsonl');f.monitor.roots=[{provider:'codex',path}];await f.monitor.start();assert.equal(f.monitor.snapshot().totals.codex.total,0);assert.ok(f.monitor.errors.has(path));await writeFile(path,text('future',35));await eventually(()=>f.monitor.snapshot().totals.codex.total===45&&!f.monitor.errors.has(path),'late exact log must enter through the filtered parent-directory watcher');assert.equal(f.monitor.files.has(join(f.logs,'sibling.jsonl')),false);
});

test('actual TokenMonitor save/restart chain scans registered exact files into the legacy SQLite ledger',async t=>{
 await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'registered-native-chain-')),logs=join(root,'logs'),dataRoot=join(root,'data');await mkdir(logs);const path=join(logs,'registered.jsonl');await writeFile(path,text('registered',100));await writeFile(join(logs,'unregistered.jsonl'),text('unregistered',9000));
 let monitor=new TokenMonitor({roots:[],home:root,dataRoot,persistentHistory:true});t.after(()=>monitor.close());await monitor.start();assert.equal(monitor.legacy.snapshot().totals.codex.total,0);await monitor.action('save',{id:'managed-exact-native',tool:'codex',path,format:'auto',enabled:true,mode:'request'});assert.equal(monitor.legacy.snapshot().totals.codex.total,110);assert.equal(monitor.legacy.files.has(join(logs,'unregistered.jsonl')),false);assert.deepEqual(monitor.legacy.roots,[{provider:'codex',path}]);
 const db=new DatabaseSync(join(dataRoot,'usage-ledger-v2','legacy.sqlite'),{readOnly:true});try{assert.ok(db.prepare("SELECT count(*) n FROM facts WHERE kind='codex'").get().n>0);}finally{db.close();}
 await monitor.close();monitor=new TokenMonitor({roots:[],home:root,dataRoot,persistentHistory:true});await monitor.start();assert.equal(monitor.legacy.snapshot().totals.codex.total,110);assert.equal(monitor.sources.list().find(v=>v.id==='managed-exact-native').path,path);assert.equal(monitor.legacy.files.has(join(logs,'unregistered.jsonl')),false);
});
