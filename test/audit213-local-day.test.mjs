import test from 'node:test';
import assert from 'node:assert/strict';
import {createDailyCgScheduler,dailyCgTime} from '../src/daily-cg-scheduler.mjs';
import {readFileSync} from 'node:fs';

test('daily CG host binding uses system time independently of statistics preference',()=>{
 const main=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8');
 const binding=main.slice(main.indexOf('dailyCgScheduler=createDailyCgScheduler('),main.indexOf('dailyCgScheduler.start()'));
 assert.doesNotMatch(binding,/statisticsTimeZone/);
});
test('local daily CG fires at Shanghai 10 and 22 without a statistics preference',async()=>{
 const old=process.env.TZ;process.env.TZ='Asia/Shanghai';
 try{
  let time=Date.parse('2026-11-09T02:00:00Z'),content=JSON.stringify({version:1,claims:{}});const calls=[];
  const scheduler=createDailyCgScheduler({storage:{readText:async()=>content,writeText:async value=>{content=value;}},now:()=>time,capture:async()=>({}),enqueue:async(_,context)=>{calls.push(context);return {id:'cg-'+calls.length};}});
  await scheduler.tick();time=Date.parse('2026-11-09T14:00:00Z');await scheduler.tick();await scheduler.stopAndDrain();
  assert.deepEqual(calls.map(row=>[row.logicalDay,row.slot]),[['2026-11-09','10:00'],['2026-11-09','22:00']]);
  assert.equal(dailyCgTime(time).timeZone,'Asia/Shanghai');
 }finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});
