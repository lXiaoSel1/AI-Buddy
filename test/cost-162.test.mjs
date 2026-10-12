import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PriceService,catalogFromModels} from '../src/pricing.mjs';
import {UsageQuery,normalizedRequest} from '../src/usage-query.mjs';
const bundle=catalogFromModels({openai:{models:{'gpt-test':{cost:{input:2,output:10,cache_read:0.5,cache_write:3,tiers:[{tier:{type:'context',size:2000000},input:4,output:20,cache_read:1,cache_write:6}]}}}},anthropic:{models:{'claude-test':{cost:{input:3,output:15,cache_read:0.3,cache_write:3.75}}}}},'fixture');
const service=async()=>{const p=new PriceService({dataRoot:await mkdtemp(join(tmpdir(),'cost162-')),bundle});await p.ready;return p;};
const row=(extra={})=>({requestId:'r',sourceId:'source',tool:'codex',sessionId:'s',timestamp:'2026-10-11T12:00:00Z',model:'gpt-test',actualProvider:'unknown',cacheIncluded:false,usage:{input:1000000,output:100000,cacheRead:500000,cacheWrite:0,reasoning:50000,total:1600000,requests:1},...extra});
test('Known models get API-equivalent estimates without asserting a platform or billing route',async()=>{
 const p=await service();for(const actualProvider of ['unknown','openai','openrouter','custom'])for(const billingRoute of ['unknown','api','account','subscription','coding-plan','proxy']){
  const r=normalizedRequest(row({actualProvider,billingRoute})),before=structuredClone(r),price=p.estimate(r);
  assert.equal(price.amount,3.25);assert.equal(price.priceProvider,'openai');assert.equal(price.priceModel,'gpt-test');assert.deepEqual(r,before);
 }
 const claude=p.estimate(normalizedRequest(row({tool:'claude',model:'claude-test'})));assert.equal(claude.priceProvider,'anthropic');assert.equal(claude.amount,4.65);
 assert.equal(p.estimate(normalizedRequest(row({model:'gpt-unknown'}))).amount,null);
});
test('Reference pricing preserves cache, reasoning and context tiers and exact custom route prices',async()=>{
 const p=await service(),r=normalizedRequest(row());assert.equal(p.estimate(r).amount,3.25);
 assert.equal(p.estimate({...r,usage:{...r.usage,input:2000000}}).amount,10.5);
 assert.equal(p.estimate({...r,usage:{...r.usage,cacheRead:null}}).amount,null);
 await p.save({overrides:[{provider:'openrouter',model:'gpt-test',billingRoute:'proxy',input:1,output:1,cacheRead:0,cacheWrite:0,currency:'CNY'}]});
 const proxy=normalizedRequest(row({actualProvider:'openrouter',billingRoute:'proxy'}));assert.equal(p.estimate(proxy).amount,1.1);assert.equal(p.estimate(proxy).currency,'CNY');assert.equal(p.estimate(r).amount,3.25);
 await p.save({overrides:[{provider:'openai',model:'gpt-test',input:0,output:0,cacheRead:0,cacheWrite:0,currency:'USD'}]});assert.equal(p.estimate(r).amount,0);
});
test('Incremental correction and price refresh keep total usage and estimate provenance consistent',async()=>{
 const p=await service(),q=new UsageQuery();q.replaceGroup('s',[row(),row({requestId:'missing',model:'unknown-model'})]);
 const original=q.query({},p);assert.equal(original.cost.coverage,0.5);assert.equal(original.cost.estimates[0].requests,1);assert.ok(original.cost.basis.includes('非实际账单'));
 const scanned=q.scanned;q.replaceGroup('s',[row({usage:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0,requests:1}})]);
 const corrected=q.query({},p);assert.equal(q.scanned,scanned);assert.equal(corrected.cost.pricedRequests,1);assert.equal(corrected.cost.amounts.USD,0);assert.equal(corrected.cost.estimates[0].amount,0);
 await p.save({overrides:[{provider:'openai',model:'gpt-test',input:4,output:20,cacheRead:1,cacheWrite:0,currency:'USD'}]});
 assert.deepEqual(q.query({},p).totals,corrected.totals);assert.equal(JSON.parse(q.export({},'json',p)).cost.estimates[0].source,'用户自定义');
});
