import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createMonitorProfileDiagnostic,MONITOR_PROFILE_MAX_BYTES} from '../src/monitor-profile-diagnostic.mjs';

const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(){
 let time=0,id=0,current;const timers=new Map(),calls=[];
 const profile={nodes:[{id:1,callFrame:{functionName:'hotLoop',scriptId:'1',url:'file:///private/monitor-worker.cjs?credential=secret',lineNumber:2,columnNumber:3},hitCount:1,children:[],chat:'private chat'}],samples:[1],timeDeltas:[1000],startTime:1,endTime:5000001,credentials:'secret'};
 const worker=new EventEmitter();worker.threadId=7;worker.cpuUsage=async()=>({user:100+calls.length*100,system:20});worker.startCpuProfile=async(...args)=>{calls.push(['start',args]);return {stop:async()=>{calls.push(['stop']);return JSON.stringify(profile);}};};current=worker;
 const diagnostic=createMonitorProfileDiagnostic({getWorker:()=>current,processId:123,build:'known-build',now:()=>time,setTimer:(fn,ms)=>{const key=++id;timers.set(key,{fn,ms});return key;},clearTimer:key=>timers.delete(key)});
 const request={command:'diagnostics-monitor-profile',expectedProcessId:123,expectedBuild:'known-build'};
 return {worker,diagnostic,request,calls,profile,setCurrent:value=>current=value,async tick(ms){time+=ms;for(const [key,row]of [...timers])if(row.ms===ms){timers.delete(key);row.fn();}await flush();},timers};
}

test('private diagnostic accepts only exact installation identity and fixed command fields',async()=>{
 const f=fixture();
 for(const patch of [{expectedProcessId:124},{expectedBuild:'other'},{durationMs:50000},{threadId:99},{file:'arbitrary'},{eval:'anything'},{command:'other'}])assert.equal((await f.diagnostic.handle({...f.request,...patch})).code,'MONITOR_PROFILE_REQUEST_INVALID');
 assert.deepEqual(f.calls,[]);
});

test('one five-second profile captures the current monitor only and returns bounded metadata',async()=>{
 const f=fixture(),pending=f.diagnostic.handle(f.request);await flush();
 assert.equal((await f.diagnostic.handle(f.request)).code,'MONITOR_PROFILE_BUSY');
 assert.deepEqual(f.calls,[['start',[]]]);assert.ok([...f.timers.values()].some(row=>row.ms===5000));
 await f.tick(5000);const result=await pending;
 assert.equal(result.ok,true);assert.equal(result.durationMs,5000);assert.equal(result.target.threadId,7);assert.equal(result.target.name,'buddy-monitor');assert.ok(result.cpuDelta.user>=0);
 assert.equal(result.profile.nodes[0].callFrame.url,'buddy-monitor/monitor-worker.cjs');assert.equal(result.profile.nodes[0].callFrame.functionName,'hotLoop');
 const body=JSON.stringify(result);assert.ok(Buffer.byteLength(body)<=MONITOR_PROFILE_MAX_BYTES);assert.doesNotMatch(body,/private chat|credential|secret/);assert.deepEqual(f.calls,[['start',[]],['stop']]);
});

test('unsupported, absent, exited and replaced monitor targets fail explicitly',async()=>{
 const f=fixture();f.setCurrent(null);assert.equal((await f.diagnostic.handle(f.request)).code,'MONITOR_PROFILE_UNAVAILABLE');
 f.setCurrent({threadId:2});assert.equal((await f.diagnostic.handle(f.request)).code,'MONITOR_PROFILE_UNSUPPORTED');
 f.setCurrent(f.worker);const pending=f.diagnostic.handle(f.request);await flush();f.worker.emit('exit',0);assert.equal((await pending).code,'MONITOR_PROFILE_EXITED');await flush();
 const second=f.diagnostic.handle(f.request);await flush();f.setCurrent({...f.worker,threadId:7});await f.tick(5000);assert.equal((await second).code,'MONITOR_PROFILE_REPLACED');
});

test('cancellation cannot release single-flight until the actual profile stop settles',async()=>{
 const f=fixture();let finish;f.worker.startCpuProfile=async()=>({stop:()=>new Promise(resolve=>finish=resolve)});
 const pending=f.diagnostic.handle(f.request);await flush();f.diagnostic.cancel();assert.equal((await pending).code,'MONITOR_PROFILE_CANCELLED');await flush();
 assert.equal((await f.diagnostic.handle(f.request)).code,'MONITOR_PROFILE_BUSY');finish(JSON.stringify(f.profile));await flush();
 f.setCurrent(null);assert.equal((await f.diagnostic.handle(f.request)).code,'MONITOR_PROFILE_UNAVAILABLE');
});

test('oversized results and bounded operation deadlines fail without exposing partial profiles',async()=>{
 const f=fixture();f.worker.startCpuProfile=async()=>({stop:async()=>JSON.stringify({padding:'x'.repeat(MONITOR_PROFILE_MAX_BYTES)})});
 const pending=f.diagnostic.handle(f.request);await flush();await f.tick(5000);const large=await pending;assert.equal(large.code,'MONITOR_PROFILE_TOO_LARGE');assert.equal(large.profile,undefined);
 f.worker.startCpuProfile=()=>new Promise(()=>{});const stalled=f.diagnostic.handle(f.request);await flush();await f.tick(10000);assert.equal((await stalled).code,'MONITOR_PROFILE_TIMEOUT');assert.equal((await f.diagnostic.handle(f.request)).code,'MONITOR_PROFILE_BUSY');
});

test('the actual main private-pipe dispatcher reaches only the fixed monitor diagnostic',async()=>{
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8'),start=main.indexOf('const control=createLocalControlServer({'),end=main.indexOf("\ncontrol.on('error'",start);assert.ok(start>=0&&end>start);
 let dispatch;const calls=[];
 vm.runInNewContext(main.slice(start,end),{createLocalControlServer:options=>{dispatch=options.onRequest;return {};},monitorProfile:{handle:async request=>{calls.push(request);return {ok:true};}},audit(){}});
 const request={command:'diagnostics-monitor-profile',expectedProcessId:123,expectedBuild:'known-build'};
 assert.equal((await dispatch(request)).ok,true);assert.deepEqual(calls,[request]);
 assert.equal((main.match(/name:'buddy-monitor'/g)??[]).length,1);
});
