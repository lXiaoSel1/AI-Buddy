import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {closeMonitorWorker} from '../src/monitor-worker-shutdown.mjs';

class FakeWorker extends EventEmitter{
 constructor(onPost){super();this.sent=[];this.onPost=onPost;this.threadId=1;this.terminated=0;}
 postMessage(value){this.sent.push(value);this.onPost?.(value);}
 terminate(){this.terminated++;throw Error('Must never terminate a persistence worker');}
}
function clock(){let now=0,serial=0;const timers=new Map();return {timers,get now(){return now;},setTimer(fn,ms){const id=serial++;timers.set(id,{fn,at:now+ms});return id;},clearTimer(id){timers.delete(id);},advance(ms){now+=ms;for(const[id,row]of [...timers])if(row.at<=now){timers.delete(id);row.fn();}}};}
function fixture(worker=new FakeWorker(),options={}){const time=clock();return {worker,time,close:extra=>closeMonitorWorker(worker,{setTimer:time.setTimer,clearTimer:time.clearTimer,...options,...extra})};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const clean=f=>{assert.equal(f.worker.listenerCount('message'),0);assert.equal(f.worker.listenerCount('error'),0);assert.equal(f.worker.listenerCount('exit'),0);assert.equal(f.time.timers.size,0);assert.equal(f.worker.terminated,0);};

test('only exact durable ACK completes; legacy/stale and unrelated messages do not',async()=>{
 const f=fixture(),other=new FakeWorker();let complete=false;const pending=f.close().then(value=>{complete=true;return value;});
 other.emit('message',{type:'closed',durable:true});f.worker.emit('message',{type:'closed'});f.worker.emit('message',{type:'closed',durable:false});f.worker.emit('message',{type:'closed',durable:'true'});f.worker.emit('message',{type:'snapshot',durable:true});await tick();assert.equal(complete,false);
 f.worker.emit('message',{type:'closed',durable:true});assert.deepEqual(await pending,{closed:true,durable:true});assert.deepEqual(f.worker.sent,[{type:'close'}]);clean(f);
});
test('held persistence remains awaited beyond old five-second cutoff (controlled six seconds)',async()=>{
 const f=fixture();let complete=false;const pending=f.close().then(value=>{complete=true;return value;});f.time.advance(5001);await tick();assert.equal(complete,false);assert.equal(f.time.timers.size,1);f.time.advance(999);f.worker.emit('message',{type:'closed',durable:true});await pending;assert.equal(f.time.now,6000);clean(f);
});
test('synchronous ACK emitted before postMessage returns is observed and cleans timer',async()=>{
 const worker=new FakeWorker(()=>worker.emit('message',{type:'closed',durable:true})),f=fixture(worker);await f.close();clean(f);
});
test('duplicate close callers and later successful calls share one promise and one message',async()=>{
 const f=fixture(),first=f.close(),second=f.close({timeoutMs:1});assert.strictEqual(first,second);assert.equal(f.worker.sent.length,1);f.worker.emit('message',{type:'closed',durable:true});await first;assert.strictEqual(f.close(),first);assert.equal(f.worker.sent.length,1);clean(f);
});
test('early exit even code zero rejects without pretending durable persistence',async()=>{
 for(const exitCode of [0,1]){const f=fixture(),pending=f.close();f.worker.emit('exit',exitCode);await assert.rejects(pending,{code:'MONITOR_WORKER_EARLY_EXIT',exitCode});clean(f);}
});
test('worker error and explicit close-error reject and keep existing listeners untouched',async()=>{
 for(const kind of ['error','close-error','flat-close-error']){const f=fixture(),existing=()=>{};f.worker.on('message',existing);const pending=f.close();if(kind==='error')f.worker.emit('error',Error('disk failed'));else if(kind==='close-error')f.worker.emit('message',{type:'close-error',error:{message:'not drained',code:'MONITOR_PENDING_NOT_DURABLE'}});else f.worker.emit('message',{type:'close-error',durable:false,message:'not drained',code:'MONITOR_PENDING_NOT_DURABLE'});await assert.rejects(pending,{code:kind==='error'?'MONITOR_WORKER_CLOSE_ERROR':'MONITOR_PENDING_NOT_DURABLE'});assert.equal(f.worker.listenerCount('message'),1);f.worker.removeListener('message',existing);clean(f);}
});
test('timeout rejects without termination; late legacy ACK cannot pass retry',async()=>{
 const f=fixture(),first=f.close({timeoutMs:6000});f.time.advance(6000);await assert.rejects(first,{code:'MONITOR_WORKER_CLOSE_TIMEOUT'});clean(f);
 f.worker.emit('message',{type:'closed'});const second=f.close();assert.notStrictEqual(second,first);assert.equal(f.worker.sent.length,2);let done=false;second.then(()=>{done=true;});f.worker.emit('message',{type:'closed'});await tick();assert.equal(done,false);f.worker.emit('message',{type:'closed',durable:true});await second;clean(f);
});
test('postMessage throw cleans resources and permits a fresh request',async()=>{
 let fail=true;const f=fixture(new FakeWorker(()=>{if(fail)throw Object.assign(Error('channel failed'),{code:'POST_FAILED'});}));await assert.rejects(f.close(),{code:'POST_FAILED'});clean(f);fail=false;const retry=f.close();f.worker.emit('message',{type:'closed',durable:true});await retry;assert.equal(f.worker.sent.length,2);clean(f);
});
test('ACK wins later timeout/exit callbacks; diagnostic errors cannot turn durable success into failure',async()=>{
 const f=fixture(undefined,{onDiagnostic:()=>{throw Error('diagnostic only');}}),pending=f.close();const timeout=[...f.time.timers.values()][0].fn;f.worker.emit('message',{type:'closed',durable:true});f.worker.emit('exit',0);timeout();await pending;clean(f);
});
test('synchronously firing controlled timer cannot leak handle or post after failure',async()=>{
 const worker=new FakeWorker(),cleared=[];const pending=closeMonitorWorker(worker,{setTimer(fn){fn();return 7;},clearTimer:id=>cleared.push(id)});await assert.rejects(pending,{code:'MONITOR_WORKER_CLOSE_TIMEOUT'});assert.deepEqual(cleared,[7]);assert.deepEqual(worker.sent,[]);assert.equal(worker.listenerCount('message'),0);
});
test('already exited worker or invalid options reject before any request',async()=>{
 const worker=new FakeWorker();worker.threadId=-1;await assert.rejects(closeMonitorWorker(worker),{code:'MONITOR_WORKER_EARLY_EXIT'});worker.threadId=1;
 for(const timeoutMs of [0,-1,NaN,Infinity,1.5,2147483648])await assert.rejects(closeMonitorWorker(worker,{timeoutMs}),{code:'MONITOR_CLOSE_OPTIONS_INVALID'});
 assert.deepEqual(worker.sent,[]);await assert.rejects(closeMonitorWorker(null),{code:'MONITOR_WORKER_INVALID'});
});
test('legacy ACK diagnostics are bounded to one notice per attempt',async()=>{
 const notices=[],f=fixture(undefined,{onDiagnostic:value=>notices.push(value)}),pending=f.close();for(let i=0;i<1000;i++)f.worker.emit('message',{type:'closed'});f.worker.emit('message',{type:'closed',durable:true});await pending;assert.deepEqual(notices.map(x=>x.type),['monitor-close-legacy-ack-ignored','monitor-closed']);clean(f);
});
