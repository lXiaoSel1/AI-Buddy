import test from 'node:test';
import assert from 'node:assert/strict';
import {PetFeedbackQueue} from '../src/pet-feedback.mjs';
import {PetActionController,getPetAction} from '../src/pet-actions.mjs';

test('New chat replies replace old active and pending reactions, and late older replies are ignored',()=>{
 let t=0;const queue=new PetFeedbackQueue({now:()=>t,cycle:()=>1000});
 queue.enqueue({eventId:'reply-1',id:'emotion-shy',source:'dialog',sequence:1,text:'第一句'});assert.equal(queue.tick().text,'第一句');t=20;queue.tick();
 queue.enqueue({eventId:'reply-2',id:'emotion-angry',source:'dialog',sequence:2,text:'第二句'});assert.equal(queue.tick().id,'emotion-angry');assert.equal(queue.enqueue({eventId:'late-1',id:'emotion-shy',source:'dialog',sequence:1,text:'过时'}),false);
 queue.enqueue({eventId:'reply-3',id:'emotion-shy',source:'dialog',sequence:3,text:'第三句'});queue.tick({paused:true});
 queue.enqueue({eventId:'reply-4',id:'emotion-serious',source:'dialog',sequence:4,text:'第四句'});assert.equal(queue.queue.length,1);assert.equal(queue.tick().text,'第四句');
});
test('An error interrupts a task completion without losing its progress, provider or remaining jump cycles',()=>{
 let t=0;const queue=new PetFeedbackQueue({now:()=>t,cycle:()=>1000});queue.enqueue({eventId:'done',id:'jump',source:'completed',provider:'codex',text:'完成',cycles:2});queue.tick();t=350;queue.tick();
 queue.enqueue({eventId:'error',id:'fail',source:'failed',provider:'claude',text:'错误'});assert.equal(queue.tick().text,'错误');t=1350;const restored=queue.tick();assert.equal(restored.id,'jump');assert.equal(restored.elapsed,350);assert.equal(restored.provider,'codex');assert.equal(restored.text,'完成');t=2999;assert.equal(queue.tick().id,'jump');t=3000;assert.equal(queue.tick(),null);
});
test('Completion waits for a manual demonstration, then plays two full cycles',()=>{
 let t=0;const c=new PetActionController({now:()=>t});c.setSpeed(.75);c.play({id:'wave',durationMs:8000});c.enqueueFeedback({eventId:'done-1',id:'jump',source:'completed',provider:'codex',text:'完成'});
 t=7000;assert.equal(c.select().source,'manual');assert.equal(c.feedback.queue.length,1);t=8000;assert.equal(c.select().id,'jump');assert.equal(c.select().elapsed,0);
 t+=getPetAction('jump').cycleMs*2/.75-1;assert.equal(c.select().id,'jump');t+=2;assert.equal(c.select().id,'idle');
});
test('Failure text remains paired to failure motion when a different task completes',()=>{
 let t=0;const c=new PetActionController({now:()=>t});c.enqueueFeedback({eventId:'bad',id:'fail',source:'failed',text:'错误'});c.select();c.enqueueFeedback({eventId:'good',id:'jump',source:'completed',text:'完成'});
 assert.equal(c.select().id,'fail');assert.equal(c.select().feedback.text,'错误');t=getPetAction('fail').cycleMs+1;assert.equal(c.select().id,'jump');assert.equal(c.select().feedback.text,'完成');
});
test('Drag pauses feedback, auto cancels only manual playback, loading consumes no feedback time',()=>{
 let t=0,ready=false;const c=new PetActionController({now:()=>t,ready:()=>ready});c.enqueueFeedback({eventId:'done',id:'jump',source:'completed'});t=5000;assert.equal(c.select().id,'idle');ready=true;assert.equal(c.select().elapsed,0);
 t+=200;c.drag(true);const elapsed=c.feedback.active.elapsed;t+=10000;c.drag(false);assert.equal(c.select().elapsed,elapsed);c.play({id:'wave',durationMs:5000});c.automatic();assert.equal(c.select().id,'jump');assert.equal(c.select().elapsed,elapsed);
});
test('Duplicate events are ignored and pending groups merge without mixing result types',()=>{
 let t=0;const c=new PetActionController({now:()=>t});c.play({id:'wave',durationMs:5000});assert.equal(c.enqueueFeedback({eventId:'a',id:'jump',source:'completed',provider:'codex'}),true);assert.equal(c.enqueueFeedback({eventId:'a',id:'jump',source:'completed',provider:'codex'}),false);
 c.enqueueFeedback({eventId:'b',id:'jump',source:'completed',provider:'codex'});c.enqueueFeedback({eventId:'c',id:'fail',source:'failed',provider:'claude'});t=5001;assert.equal(c.select().id,'fail');t+=getPetAction('fail').cycleMs+1;assert.equal(c.select().feedback.count,2);assert.match(c.select().feedback.text,/2个任务完成/);
});
