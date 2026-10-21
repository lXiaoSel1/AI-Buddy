import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {superviseWorker,pushBounded} from '../src/worker-supervisor.mjs';

test('an unexpectedly exited worker restarts with exponential backoff that resets after a healthy run',()=>{
 let clock=0,quitting=false;const timers=[],created=[],exits=[];
 const supervisor=superviseWorker(()=>{const worker=new EventEmitter();created.push(worker);return worker;},{
  now:()=>clock,setTimer:(fn,delay)=>{timers.push({fn,delay});return {unref(){}};},clearTimer:()=>{},shouldRestart:()=>!quitting,onExit:code=>exits.push(code)});
 const crash=()=>{supervisor.worker.emit('exit',1);const timer=timers.shift();clock+=timer.delay;timer.fn();return timer.delay;};
 assert.deepEqual([crash(),crash(),crash(),crash(),crash(),crash()],[2000,4000,8000,16000,32000,60000]);
 clock+=60000;assert.equal(crash(),2000,'a minute of healthy running resets the backoff');
 assert.equal(created.length,8);assert.deepEqual(exits,[1,1,1,1,1,1,1]);
 quitting=true;supervisor.worker.emit('exit',0);assert.equal(timers.length,0,'no restart while quitting');
});

test('renderer error lists keep only the newest 200 entries',()=>{
 const list=[];for(let n=0;n<450;n++)pushBounded(list,'error '+n);
 assert.equal(list.length,200);assert.equal(list[0],'error 250');assert.equal(list.at(-1),'error 449');
});
