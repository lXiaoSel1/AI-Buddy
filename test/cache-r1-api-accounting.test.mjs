import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiTransport} from '../src/api-transport.mjs';
import {createApiUsageJournal} from '../src/api-usage-journal.mjs';
import {fileRecords,parseTokenRecord} from '../src/token-adapters.mjs';
import {UsageRepository} from '../src/usage-repository.mjs';
import {SqlUsageQuery} from '../src/usage-query-sqlite.mjs';
import {PriceService} from '../src/pricing.mjs';

const kimi={kind:'kimi',protocol:'chat-completions',baseUrl:'https://api.moonshot.ai/v1',model:'kimi-k3.1-pro',kimiCacheTtl:'1h'};
const claude={kind:'claude',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:'claude-sonnet-4-6'};
const proxy={kind:'custom',protocol:'chat-completions',baseUrl:'https://proxy.example.test/v1',model:'proxy-fixture'};
const cacheContext={version:1,kind:'private',sessionUuid:'b869f312-d170-4a64-a214-4ad239d44fda',scopeKey:'fixture'};
async function record(journal,profile,usage,headers={}){
  const payload=profile.protocol==='anthropic'?{content:[{type:'text',text:'ok'}],usage}:{choices:[{message:{content:'ok'},finish_reason:'stop'}],usage};
  const transport=new ApiTransport({fetchImpl:async()=>Response.json(payload,{headers}),onUsage:journal.recordUsage});
  for await(const _ of transport.stream({...profile,id:profile.kind,key:'fixture'},{messages:[{role:'user',content:'hi'}],cacheContext})){}
}

test('usage journal, adapter and SQLite query preserve cache partitions and cost coverage after reload',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'cache-r1-accounting-'));
  const database=join(dataRoot,'usage.sqlite');
  let repository=new UsageRepository(database);
  t.after(async()=>{repository?.close();await rm(dataRoot,{recursive:true,force:true});});
  const journal=createApiUsageJournal({dataRoot});
  const kUsage={prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:25,cache_write_tokens:50}};
  await record(journal,kimi,kUsage,{'Msh-Usage-Cache-Write-Tokens-5m':'30','Msh-Usage-Cache-Write-Tokens-1h':'20'});
  await record(journal,{...kimi,kimiCacheTtl:undefined},kUsage);
  await record(journal,claude,{input_tokens:15,output_tokens:3,cache_read_input_tokens:70,cache_creation_input_tokens:10});
  await record(journal,proxy,{prompt_tokens:30,completion_tokens:4});
  await record(journal,proxy,{prompt_tokens:30,completion_tokens:4,cached_tokens:35});
  await journal.drain();

  const source={id:'fixture',tool:'companion',format:'jsonl'};
  const path=join(dataRoot,'api-usage.jsonl'),fixtures=[];
  for await(const item of fileRecords(path,source)){
    if(!item.row)continue;
    const [event]=parseTokenRecord(source,item.row,{},path,item.index);
    fixtures.push(event);
    repository.put('generic',event.requestId,event);
  }
  repository.publish();
  const prices=await new PriceService({dataRoot}).ready;
  await prices.save({overrides:[
    {provider:'moonshot',model:kimi.model,currency:'USD',input:2,output:8,cacheRead:0.2,cacheWrite:2,cacheWrite1h:4},
    {provider:'anthropic',model:claude.model,currency:'USD',input:3,output:15,cacheRead:0.3,cacheWrite:3.75},
    {provider:'custom:'+proxy.kind+':proxy.example.test',model:proxy.model,currency:'USD',input:2,output:8,cacheRead:0.2}
  ]});
  new SqlUsageQuery(repository).replaceGroup('fixtures',fixtures.map(event=>repository.get('generic',event.requestId)));
  repository.close();
  repository=new UsageRepository(database);
  const query=new SqlUsageQuery(repository);
  const get=model=>query.query({model,timeZone:'UTC'},prices);

  const k=get(kimi.model);
  assert.deepEqual([k.totals.input,k.totals.totalInput,k.totals.cacheRead,k.totals.cacheWrite],[50,200,50,100]);
  assert.equal(k.cost.pricedRequests,2);
  assert.equal(k.cost.unpriced.length,0);
  assert.ok(Math.abs(k.cost.amounts.USD-0.00057)<1e-12);
  assert.equal(k.sessions[0].usage.totalInput,100);

  const c=get(claude.model);
  assert.deepEqual([c.totals.input,c.totals.totalInput,c.totals.cacheRead,c.totals.cacheWrite],[15,95,70,10]);
  assert.ok(Math.abs(c.cost.amounts.USD-0.0001485)<1e-12);

  const p=get(proxy.model);
  assert.equal(p.totals.totalInput,60);
  assert.equal(p.totals.fieldMissing.input,2);
  assert.equal(p.totals.fieldMissing.cacheRead,1);
  assert.equal(p.cost.pricedRequests,0);

  const sourceRow=repository.get('generic',fixtures[0].requestId);
  assert.deepEqual(sourceRow.rawUsage,kUsage);
  assert.deepEqual([sourceRow.cacheWriteIncluded,sourceRow.cacheWrite5m,sourceRow.cacheWrite1h,sourceRow.requestedCacheTtl],[true,0,50,'1h']);
  const defaultTier=repository.get('generic',fixtures[1].requestId);
  assert.deepEqual([defaultTier.cacheWrite5m,defaultTier.cacheWrite1h,defaultTier.requestedCacheTtl],[50,0,'5m']);
  assert.ok(sourceRow.knownFields.includes('cacheRead'));
  const exported=JSON.parse(query.export({model:proxy.model,timeZone:'UTC'},'json',prices));
  assert.equal(exported.totals.totalInput,60);
  assert.match(query.export({model:proxy.model,timeZone:'UTC'},'csv',prices),/"totalInput"/);
});
