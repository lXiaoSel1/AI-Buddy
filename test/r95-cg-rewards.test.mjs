import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createCgRewardFacts,cgUsageTotal} from '../src/cg-reward-facts.mjs';
import {createEconomyStore} from '../src/companion-economy-store.mjs';
const scope={characterId:'deepseek',personaId:'persona-one',lifeId:'life-one',operationId:'operation-one'};
const ready=id=>({id,status:'ready',sha256:'a'.repeat(64),assetRef:'cg-assets/'+id+'/image.png',completedAt:10,rewardScope:scope});
function fixture(t,options={}){const dataRoot=mkdtempSync(join(tmpdir(),'r95-cg-rewards-')),services=[];t.after(async()=>{for(const s of services.reverse())await s.close();rmSync(dataRoot,{recursive:true,force:true});});return {dataRoot,closeAlso:service=>services.push(service),open(extra={}){const service=createCgRewardFacts({dataRoot,...options,...extra});services.push(service);return service;}};}
const usage=(jobId,total,extra={})=>({cgJobId:jobId,usageReceiptId:'request:'+jobId,usage:{total_tokens:total},provider:'mock',...extra});

test('completed fallback is durable, unique, and late actual replaces the same job key',async t=>{
 const f=fixture(t),facts=[],s=f.open({onRewardFact:fact=>{facts.push(fact);return {accepted:true};}});
 await s.initialize([]);s.registerJob({id:'one',rewardScope:scope});await s.observeJob(ready('one'));await s.observeJob(ready('one'));assert.equal(facts.length,1);assert.equal(facts[0].canonicalRequestId,'cg:one');assert.equal(facts[0].basis,'cg-fallback');assert.deepEqual(facts[0].completedImageIds,['one:'+ 'a'.repeat(64)]);
 await s.recordUsage(usage('one',4000));await s.recordUsage(usage('one',4000));assert.equal(facts.length,2);assert.equal(facts[1].basis,'actual');assert.equal(facts[1].totalTokens,4000);assert.equal(facts[1].canonicalRequestId,facts[0].canonicalRequestId);assert.equal(facts[1].revision,2);assert.deepEqual(facts[1].scope,scope);
 await s.close();const reopened=f.open({onRewardFact:()=>assert.fail('acked facts must not re-emit')});await reopened.initialize([ready('one')]);await reopened.drain();assert.equal(reopened.pending().length,0);
});
test('failed and cancelled drawings reward only reported real usage; never image fallback',async t=>{
 const f=fixture(t),facts=[],s=f.open({onRewardFact:v=>{facts.push(v);return {accepted:true};}});await s.initialize([]);
 for(const status of ['failed','cancelled']){s.registerJob({id:status,rewardScope:scope});await s.observeJob({id:status,status});assert.equal(facts.length,status==='failed'?0:1);await s.recordUsage(usage(status,2500));assert.equal(facts.at(-1).basis,'actual');assert.equal(facts.at(-1).totalTokens,2500);}
 assert.equal(facts.length,2);
});
test('first historical terminal jobs and their late usage are baselined without retroactive awards',async t=>{
 const f=fixture(t),facts=[],s=f.open({onRewardFact:v=>{facts.push(v);return {accepted:true};}});await s.initialize([ready('old'),{id:'old-failure',status:'failed'}]);await s.observeJob(ready('old'));await s.recordUsage(usage('old',25000));await s.recordUsage(usage('old-failure',30000));assert.equal(facts.length,0);assert.equal(s.inspect('old').historical,true);
 s.registerJob({id:'new',rewardScope:scope});await s.observeJob(ready('new'));assert.equal(facts.length,1);assert.equal(facts[0].baseline,false);
});
test('ready persisted before reward publication recovers while unknown imported terminal jobs stay historical',async t=>{
 const f=fixture(t),s=f.open();await s.initialize([]);s.registerJob({id:'in-flight',rewardScope:scope});await s.close();const facts=[],next=f.open({onRewardFact:v=>{facts.push(v);return {accepted:true};}});await next.initialize([ready('in-flight'),ready('foreign')]);assert.equal(facts.length,1);assert.equal(facts[0].canonicalRequestId,'cg:in-flight');
});
test('durable outbox survives callback failure and idempotent wallet handles ACK-loss, corrections and debt',async t=>{
 const f=fixture(t),economy=createEconomyStore(f.dataRoot);f.closeAlso(economy);economy.initializeRewards();let calls=0;const s=f.open({onRewardFact:fact=>{const result=economy.ingestUsageFact(fact,{trusted:true});if(++calls===1)throw Error('ACK lost');return result;}});await s.initialize([]);s.registerJob({id:'paid'});await s.recordUsage(usage('paid',15000));assert.equal(s.pending().length,1);assert.equal(economy.wallet().balance,1);await s.drain();assert.equal(s.pending().length,0);assert.equal(economy.wallet().balance,1);await s.recordUsage(usage('paid',12000));assert.equal(economy.wallet().remainder,2000);await s.recordUsage(usage('paid',0));assert.equal(economy.wallet().balance,0);assert.equal(economy.wallet().remainder,0);
});
test('request receipts distinguish sums from cumulative revisions and reject conflicting explicit revisions',async t=>{
 const f=fixture(t),facts=[],s=f.open({onRewardFact:v=>{facts.push(v);return {accepted:true};}});await s.initialize([]);s.registerJob({id:'sum'});await s.recordUsage(usage('sum',1000,{usageRevision:1}));await s.recordUsage(usage('sum',3000,{usageRevision:2}));await s.recordUsage(usage('sum',2000,{usageReceiptId:'request-two',usageRevision:1}));assert.equal(facts.at(-1).totalTokens,5000);await s.recordUsage(usage('sum',100,{usageRevision:1}));assert.equal(facts.at(-1).totalTokens,5000);await assert.rejects(()=>s.recordUsage(usage('sum',4000,{usageRevision:2})),/revision|修订/);assert.equal(facts.at(-1).totalTokens,5000);
});
test('unknown identity, invalid totals and scope changes cannot claim a job or fabricate usage',async t=>{
 const f=fixture(t),s=f.open();await s.initialize([]);assert.equal((await s.recordUsage(usage('unknown',30000))).reason,'unknown-cg-job');s.registerJob({id:'one',rewardScope:scope});assert.throws(()=>s.registerJob({id:'one',rewardScope:{...scope,lifeId:'another'}}),/scope|归属/);assert.equal((await s.recordUsage({cgJobId:'one',usage:{total_tokens:200}})).reason,'missing-request-identity');assert.equal((await s.recordUsage(usage('one',null))).reason,'usage-not-provided');assert.equal(s.pending().length,0);await assert.rejects(()=>s.recordUsage(usage('one',-1)),/用量|usage/);
 assert.equal(cgUsageTotal({usage:{input_tokens:5,output_tokens:8}}),13);assert.equal(cgUsageTotal({usage:{input_tokens:5}}),null);assert.equal(cgUsageTotal({usage:{totalTokens:0}}),0);assert.equal(cgUsageTotal({usage:{generated_images:1}}),null);
});
test('downward CG correction after spending creates debt, and zero actual replaces fallback without a second award',async t=>{
 const f=fixture(t),economy=createEconomyStore(f.dataRoot);f.closeAlso(economy);economy.initializeRewards();economy.ensureScope(scope);const s=f.open({onRewardFact:fact=>economy.ingestUsageFact(fact,{trusted:true})});await s.initialize([]);s.registerJob({id:'paid',rewardScope:scope});await s.recordUsage(usage('paid',20000));economy.purchase({scope,foodId:'rice',requestId:'spend'});await s.recordUsage(usage('paid',5000));assert.deepEqual(economy.wallet(),{balance:0,remainder:0,debtUnits:15000});
 s.registerJob({id:'zero',rewardScope:scope});await s.observeJob(ready('zero'));assert.equal(economy.wallet().debtUnits,13700);await s.recordUsage(usage('zero',0));assert.equal(economy.wallet().debtUnits,15000);assert.equal(s.inspect('zero').revision,2);
});
test('owned process abrupt exit preserves pending CG fact in WAL for one idempotent publication',async t=>{
 const f=fixture(t),moduleUrl=new URL('../src/cg-reward-facts.mjs',import.meta.url).href,script=`import {createCgRewardFacts} from ${JSON.stringify(moduleUrl)};const s=createCgRewardFacts({dataRoot:process.argv[1]});await s.initialize([]);s.registerJob({id:'crash-job'});await s.recordUsage({cgJobId:'crash-job',usageReceiptId:'request-crash',usage:{total_tokens:10000}});process.exit(23);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,f.dataRoot],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(result.status,23,result.stderr);const facts=[],s=f.open({onRewardFact:v=>{facts.push(v);return {accepted:true};}});await s.initialize([]);await s.drain();assert.equal(facts.length,1);assert.equal(facts[0].canonicalRequestId,'cg:crash-job');assert.equal(s.pending().length,0);
});
test('unresponsive reward sink times out with durable pending state and closes without retaining its timer',async t=>{
 const f=fixture(t),s=f.open({ackTimeoutMs:10,onRewardFact:()=>new Promise(()=>{})});await s.initialize([]);s.registerJob({id:'timeout'});await s.recordUsage(usage('timeout',10));assert.equal(s.pending().length,1);assert.match(s.status().lastError,/timeout/);await s.close();
});
for(const [key,value] of [['schemaVersion',99],['minimumWriter','future-cg-writer']])test('CG readonly preflight rejects unknown '+key+' without changing its bytes',async t=>{
 const f=fixture(t),s=f.open();await s.initialize([]);await s.close();const db=new DatabaseSync(s.path);db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(value),key);db.close();const before=readFileSync(s.path);assert.throws(()=>f.open(),/writer|版本|schema/);assert.deepEqual(readFileSync(s.path),before);
});
