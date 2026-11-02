import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CgService} from '../src/cg-service.mjs';
import {CgTransport} from '../src/cg-transport.mjs';
import {CodexImageProvider} from '../src/codex-image-provider.mjs';
const scope={characterId:'deepseek',personaId:'p1',lifeId:'l1',operationId:'o1'};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
const codec=bytes=>({png:bytes,thumbnail:bytes,width:1,height:1,extension:'png'});
const wait=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('CG test wait timed out');};
async function fixture(t,extra={}){const dataRoot=mkdtempSync(join(tmpdir(),'r95-cg-integrated-')),services=[],facts=[],usages=[],s=new CgService({dataRoot,crypto,codex:{close(){},setEnabled(){}},imageCodec:codec,fetchImpl:async()=>json({data:[{b64_json:png.toString('base64')}]}),captureRewardScope:()=>scope,onRewardFact:v=>{facts.push(v);return {accepted:true};},onUsage:v=>usages.push(v),...extra});services.push(s);t.after(async()=>{for(const service of services.reverse())await service.close();rmSync(dataRoot,{recursive:true,force:true});});await s.ready;const profile=await s.save({kind:'custom',name:'mock',baseUrl:'http://127.0.0.1:3041/v1',model:'mock-images',protocol:'openai-images',options:{references:false}});await s.activate(profile.id);return {s,facts,usages,dataRoot};}

test('real CG queue emits one fallback only after local image is ready, and late actual reuses its key',async t=>{
 const {s,facts}=await fixture(t);s.start();await s.enqueue({id:'draw',sourceEventId:'draw',prompt:'mock'});await wait(()=>facts.length===1);assert.equal(s.job('draw').status,'ready');assert.equal(facts[0].basis,'cg-fallback');assert.deepEqual(facts[0].scope,scope);assert.equal(facts[0].canonicalRequestId,'cg:draw');await s.recordRewardUsage({cgJobId:'draw',usageReceiptId:'http:draw',usage:{total_tokens:8000},scope});assert.equal(facts.length,2);assert.equal(facts[1].canonicalRequestId,'cg:draw');assert.equal(facts[1].totalTokens,8000);assert.ok(s.readAsset(s.job('draw').assetRef));
});
test('real HTTP actual usage is forwarded unchanged plus association, and failed image download keeps paid usage',async t=>{
 for(const failImage of [false,true]){
  const {s,facts,usages}=await fixture(t,{fetchImpl:async url=>String(url).includes('/images/generations')?json({id:'provider-request',usage:{input_tokens:20,output_tokens:80,total_tokens:100},data:[{url:'https://example.test/generated.png'}]}):failImage?new Response('error',{status:500}):new Response(png)});
  s.start();await s.enqueue({id:'actual',sourceEventId:'actual',prompt:'mock'});await wait(()=>['ready','failed'].includes(s.job('actual').status));await s.drainRewardFacts();assert.equal(s.job('actual').status,failImage?'failed':'ready');assert.equal(facts.at(-1).basis,'actual');assert.equal(facts.at(-1).totalTokens,100);assert.ok(facts.every(v=>v.basis==='actual'));assert.equal(usages[0].usage.total_tokens,100);assert.equal(usages[0].rewardManagedBy,'cg-job');assert.equal(usages[0].cgJobId,'actual');assert.equal(usages[0].usageReceiptId,'cg-http:actual:generation');
 }
});
test('HTTP service errors with real usage are recorded before failure; unknown failed draw has zero reward',async t=>{
 for(const hasUsage of [true,false]){const {s,facts}=await fixture(t,{fetchImpl:async()=>json({error:{message:'rejected'},...(hasUsage?{usage:{total_tokens:12}}:{})},400)});s.start();await s.enqueue({id:'error',sourceEventId:'error',prompt:'mock'});await wait(()=>s.job('error').status==='failed');await s.drainRewardFacts();assert.equal(facts.length,hasUsage?1:0);if(hasUsage)assert.equal(facts[0].totalTokens,12);}
});
test('scope is captured before asynchronous reference resolution and is never reassigned on completion',async t=>{
 let current=scope;const {s,facts}=await fixture(t,{captureRewardScope:()=>current});await s.enqueue({id:'scope',sourceEventId:'scope',prompt:'mock'});current={...scope,lifeId:'another-life'};s.start();await wait(()=>facts.length===1);assert.deepEqual(facts[0].scope,scope);
});
test('retry of the same known remote task keeps one reward identity and never submits twice',async t=>{
 let posts=0,downloads=0;const {s,facts}=await fixture(t,{fetchImpl:async(url,options)=>{if(options.method==='POST'){posts++;return json({output:{task_id:'known-remote'}});}if(String(url).includes('/tasks/'))return json({output:{task_status:'SUCCEEDED',results:[{url:'https://example.test/result.png'}]},usage:{total_tokens:100}});return ++downloads===1?new Response('failed',{status:500}):new Response(png);}});const profile=await s.save({kind:'custom',name:'wan mock',baseUrl:'http://127.0.0.1:3041',model:'wan',protocol:'wan-t2i',options:{references:false}});await s.activate(profile.id);s.start();await s.enqueue({id:'remote-first',sourceEventId:'remote-first',prompt:'mock'});await wait(()=>s.job('remote-first').status==='failed');await s.enqueue({id:'remote-retry',sourceEventId:'remote-retry',retryOf:'remote-first',prompt:'mock'});await wait(()=>s.job('remote-retry').status==='ready');await s.drainRewardFacts();assert.equal(posts,1);assert.ok(facts.every(v=>v.canonicalRequestId==='cg:remote-first'));assert.equal(facts.at(-1).totalTokens,100);
});
test('Wan submit and cumulative polls share one stable usage receipt, not three summed requests',async()=>{
 let count=0;const records=[];const transport=new CgTransport({onUsage:v=>records.push(v),pollInterval:1,fetchImpl:async(url,options)=>{count++;return options.method==='POST'?json({output:{task_id:'task'},usage:{total_tokens:5}}):count===2?json({output:{task_status:'RUNNING'},usage:{total_tokens:7}}):json({output:{task_status:'SUCCEEDED',results:[{url:'data:image/png;base64,'+png.toString('base64')}]},usage:{total_tokens:10}});}});const reward=[];await transport.generate({kind:'wan',protocol:'wan-t2i',baseUrl:'http://127.0.0.1:3',model:'wan',options:{}},{prompt:'mock',jobId:'wan-job',scope,onRewardUsage:v=>reward.push(v)});assert.equal(records.at(-1).usage.total_tokens,10);assert.ok(records.every(v=>v.usageReceiptId==='cg-http:wan-job:generation'));assert.deepEqual(reward.map(v=>v.usage.total_tokens),[5,7,10]);
});
test('native Codex cumulative usage is associated with the exact job and drained before completion',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-cg-native-')),native=[],reward=[],p=new CodexImageProvider({binary:'not-started',dataRoot,onUsage:v=>native.push(v)});t.after(()=>{p.close();rmSync(dataRoot,{recursive:true,force:true});});p.check=async()=>({ok:true});const notify=(method,params)=>{for(const listener of p.notifications)listener({method,params});};p.request=async method=>{if(method==='thread/start')return {thread:{id:'native-thread'}};if(method==='turn/start'){setImmediate(()=>{notify('thread/tokenUsage/updated',{threadId:'foreign-thread',tokenUsage:{total:{totalTokens:9000}}});notify('thread/tokenUsage/updated',{threadId:'native-thread',tokenUsage:{total:{inputTokens:8,outputTokens:2,totalTokens:10}}});notify('thread/tokenUsage/updated',{threadId:'native-thread',tokenUsage:{total:{inputTokens:8,outputTokens:2,totalTokens:10}}});notify('item/completed',{threadId:'native-thread',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}});notify('turn/completed',{threadId:'native-thread',turn:{status:'completed'}});});return {turn:{id:'native-turn'}};}return {};};
 await p.generate({kind:'codex',model:'fixture'},{prompt:'mock',directory:dataRoot,jobId:'native-job',scope,onRewardUsage:async v=>{await new Promise(r=>setTimeout(r,5));reward.push(v);}});assert.equal(native.length,1);assert.equal(native[0].cgJobId,'native-job');assert.equal(native[0].rewardManagedBy,'cg-job');assert.equal(native[0].usageReceiptId,'codex:native-thread');assert.equal(reward.length,1);assert.equal(reward[0].usage.totalTokens,10);
});
test('closing immediately during CG startup waits for its own initialization and leaves no rejected ready promise',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-cg-early-close-')),s=new CgService({dataRoot,crypto,codex:{close(){},setEnabled(){}},imageCodec:codec});t.after(async()=>{await s.close();rmSync(dataRoot,{recursive:true,force:true});});const result=await Promise.allSettled([s.ready,s.close()]);assert.deepEqual(result.map(v=>v.status),['fulfilled','fulfilled']);
});
