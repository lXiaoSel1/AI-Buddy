import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonitorWorkerLifecycle} from '../src/monitor-worker-lifecycle.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
function fixture(options={}){const messages=[],events=[];let portCloses=0,closes=0;const lifecycle=createMonitorWorkerLifecycle({ready:Promise.resolve(),run:async message=>{events.push('run:'+message.type);},close:async()=>{closes++;events.push('close');},postMessage:value=>{messages.push(value);events.push('post:'+value.type);},closePort:()=>{portCloses++;events.push('port-close');},...options});return {lifecycle,messages,events,get closes(){return closes;},get portCloses(){return portCloses;}};}

test('10-second admitted append cannot be durably acknowledged at old 5-second timeout',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const events=[],messages=[];let closeCalls=0;
 const f=createMonitorWorkerLifecycle({ready:Promise.resolve(),run:async()=>{await new Promise(r=>setTimeout(r,10000));events.push('append-durable');},close:async()=>{closeCalls++;events.push('repository-flushed');},postMessage:value=>{messages.push(value);events.push(value.type);}});
 const writing=f.dispatch({type:'companion-usage'}),closing=f.dispatch({type:'close'});t.mock.timers.tick(5000);await flush();assert.equal(closeCalls,0);assert.equal(messages.length,0);assert.deepEqual(f.state(),{closing:true,closed:false,inFlight:1});
 t.mock.timers.tick(5000);await writing;await closing;assert.deepEqual(events,['append-durable','repository-flushed','closed']);assert.deepEqual(messages,[{type:'closed',durable:true}]);
});
test('all previously admitted operations finish even if close arrives during configure',async()=>{
 const configure=deferred(),write=deferred(),events=[],f=fixture({run:async message=>{await(message.type==='configure'?configure.promise:write.promise);events.push(message.type);},close:async()=>events.push('flush')});
 const a=f.lifecycle.dispatch({type:'configure'}),b=f.lifecycle.dispatch({type:'companion-usage'}),end=f.lifecycle.dispatch({type:'close'});configure.resolve();await a;await flush();assert.equal(f.messages.length,0);write.resolve();await b;await end;assert.deepEqual(events,['configure','companion-usage','flush']);assert.equal(f.messages[0].durable,true);
});
test('ready and initial configure are included in the close barrier',async()=>{
 const start=deferred(),f=fixture({ready:start.promise});const end=f.lifecycle.dispatch({type:'close'});await flush();assert.equal(f.closes,0);start.resolve();await end;assert.equal(f.closes,1);assert.equal(f.messages[0].durable,true);
});
test('startup rejection still awaits cleanup before durable closed',async()=>{
 const cleanup=deferred();let called=0;const f=fixture({ready:Promise.reject(Error('start failed')),close:async()=>{called++;await cleanup.promise;}}),end=f.lifecycle.dispatch({type:'close'});await flush();assert.equal(called,1);assert.equal(f.messages.length,0);cleanup.resolve();await end;assert.deepEqual(f.messages,[{type:'closed',durable:true}]);
});
test('new companion usage, refresh and ACK are refused synchronously after close admission',async()=>{
 const cleanup=deferred(),writes=[],f=fixture({run:async message=>writes.push(message.type),close:()=>cleanup.promise});const end=f.lifecycle.dispatch({type:'close'});for(const type of ['companion-usage','refresh','reward-ack']){const result=await f.lifecycle.dispatch({type});assert.equal(result.accepted,false);assert.equal(result.error.code,'MONITOR_CLOSING');}assert.deepEqual(writes,[]);assert.equal(f.messages.filter(m=>m.type==='closed').length,0);cleanup.resolve();await end;
});
test('refused source requests retain correlation identity and explicit closing reason',async()=>{
 const hold=deferred(),f=fixture({close:()=>hold.promise});const end=f.lifecycle.dispatch({type:'close'});await f.lifecycle.dispatch({type:'source-action',id:'request-7'});await f.lifecycle.dispatch({type:'managed-work-source',id:'request-8'});assert.deepEqual(f.messages.map(m=>[m.type,m.id,m.code]),[['source-result','request-7','MONITOR_CLOSING'],['source-result','request-8','MONITOR_CLOSING']]);hold.resolve();await end;
});
test('duplicate close requests share one flush and one durable acknowledgement',async()=>{
 const hold=deferred();let calls=0;const f=fixture({close:async()=>{calls++;await hold.promise;}}),a=f.lifecycle.dispatch({type:'close'}),b=f.lifecycle.dispatch({type:'close'});assert.equal(a,b);await flush();assert.equal(calls,1);hold.resolve();await a;await b;assert.equal(f.messages.filter(m=>m.type==='closed').length,1);assert.equal(f.portCloses,1);assert.equal(await f.lifecycle.dispatch({type:'close'}),await a);
});
test('flush failure emits close-error with no durable success and retry cannot admit new writers',async()=>{
 let calls=0,writes=0;const f=fixture({run:async()=>writes++,close:async()=>{if(++calls===1)throw Object.assign(Error('disk busy'),{code:'EBUSY'});}});const first=await f.lifecycle.dispatch({type:'close'});assert.equal(first.durable,false);assert.equal(f.messages[0].type,'close-error');assert.equal(f.messages[0].code,'EBUSY');assert.equal(f.portCloses,0);assert.deepEqual(f.lifecycle.state(),{closing:true,closed:false,inFlight:0});assert.equal((await f.lifecycle.dispatch({type:'companion-usage'})).accepted,false);const second=await f.lifecycle.dispatch({type:'close'});assert.equal(second.durable,true);assert.equal(calls,2);assert.equal(writes,0);assert.equal(f.messages.filter(m=>m.type==='closed').length,1);assert.equal(f.portCloses,1);
});
test('an admitted source failure is reported with its id then cleanup still runs',async()=>{
 const f=fixture({run:async()=>{throw Error('source refused');}});await f.lifecycle.dispatch({type:'source-action',id:'source1'});await f.lifecycle.dispatch({type:'close'});assert.deepEqual(f.messages.map(m=>m.type),['source-result','closed']);assert.equal(f.messages[0].id,'source1');assert.equal(f.messages[0].error,'source refused');assert.equal(f.closes,1);
});
test('an admitted log append may remain durable despite failed ready, and cannot be skipped by close',async()=>{
 const ready=deferred(),append=deferred(),events=[],f=fixture({ready:ready.promise,run:async()=>{await append.promise;events.push('actual-log');throw Error('monitor did not initialize');},close:async()=>events.push('cleanup')});const writing=f.lifecycle.dispatch({type:'companion-usage'}),end=f.lifecycle.dispatch({type:'close'});ready.reject(Error('failed ready'));await flush();assert.deepEqual(events,[]);append.resolve();await writing;await end;assert.deepEqual(events,['actual-log','cleanup']);assert.deepEqual(f.messages.map(m=>m.type),['error','closed']);
});
test('port closes only after durable acknowledgement, and late messages cannot write or post',async()=>{
 let writes=0;const f=fixture({run:async()=>writes++});await f.lifecycle.dispatch({type:'close'});assert.deepEqual(f.events,['close','post:closed','port-close']);const count=f.messages.length;assert.equal((await f.lifecycle.dispatch({type:'companion-usage'})).accepted,false);assert.equal(writes,0);assert.equal(f.messages.length,count);
});
test('invalid callbacks are rejected before accepting messages',()=>{assert.throws(()=>createMonitorWorkerLifecycle({run:null,close:()=>{},postMessage:()=>{}}),/Invalid/);});
