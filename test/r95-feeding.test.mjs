import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FOODS,foodById} from '../src/food-catalog.mjs';
import {normalizeRewardFact} from '../src/reward-facts.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {createEconomyStore} from '../src/companion-economy-store.mjs';
import {FeedingPage} from '../src/feeding-ui.mjs';

const scope=(characterId='deepseek',lifeId='life-a',personaId='default')=>({characterId,lifeId,personaId,operationId:'operation-a'});
function fixture(t,options={}){
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r95-feeding-'));let time=0;const extraClosers=[];
 const service=createFeedingService({dataRoot,now:()=>Date.UTC(2026,9,25)+time,monotonicNow:()=>time,...options});
 t.after(async()=>{for(const close of extraClosers)await close();await service.close();rmSync(dataRoot,{recursive:true,force:true});});
 service.initializeRewards({facts:[],cursor:'initial'});service.activeScope(scope());
 return {service,dataRoot,advance:ms=>{time+=ms;return service.tick();},time:()=>time,closeAlso:fn=>extraClosers.push(fn)};
}
const fact=(id,total,revision=1,extra={})=>({canonicalRequestId:id,revision,basis:'actual',origin:'native-ledger',usage:{total},...extra});
const earn=(s,points,id='earn')=>s.ingestUsageFact(fact(id,points*10000),{trusted:true});

test('R95 exact catalog has 21 package prices, portions and per-portion restoration',()=>{
 assert.equal(FOODS.length,21);assert.deepEqual([foodById('rice').price,foodById('rice').portions,foodById('rice').restore],[2,1,35]);
 assert.deepEqual([foodById('biscuit').price,foodById('biscuit').portions,foodById('biscuit').restore],[1,3,10]);
 assert.equal(FOODS.find(x=>x.name==='豪华便当（含寿司）').price,10);assert.ok(!FOODS.some(x=>x.name==='豪华面包'));
});
test('R95 raw plugin numbers and diagnostic child totals cannot mint points',()=>{
 assert.throws(()=>normalizeRewardFact(fact('x',1000000)),/可信/);
 assert.equal(normalizeRewardFact(fact('x',1000000,1,{accounting:'child-detail'}),{trusted:true}).accepted,false);
 assert.equal(normalizeRewardFact(fact('x',null),{trusted:true}).accepted,false);
});
test('R95 9999 plus 1 rewards once; repeat, source baseline and restart preserve remainder',async t=>{
 const {service:s,dataRoot}=fixture(t);s.ingestUsageFact(fact('first',9999),{trusted:true});assert.equal(s.view().wallet.balance,0);assert.equal(s.view().wallet.remainder,9999);
 s.ingestUsageFact(fact('second',1),{trusted:true});assert.equal(s.view().wallet.balance,1);s.ingestUsageFact(fact('second',1),{trusted:true});assert.equal(s.view().wallet.balance,1);
 s.ingestUsageFact(fact('old-import',500000),{trusted:true,baseline:true});assert.equal(s.view().wallet.balance,1);
 await s.close();const reopened=createFeedingService({dataRoot});assert.equal(reopened.view().wallet.balance,1);assert.equal(reopened.view().wallet.remainder,0);await reopened.close();
});
test('R95 CG fallback is separate reward equivalence and late actual receipt replaces it',t=>{
 const {service:s}=fixture(t);s.ingestUsageFact({canonicalRequestId:'cg:job',revision:1,basis:'cg-fallback',origin:'cg-completion',status:'ready',completedImageIds:Array.from({length:8},(_,i)=>'image-'+i)},{trusted:true});
 assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder],[1,400]);
 s.ingestUsageFact(fact('cg:job',20000,2),{trusted:true});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder],[2,0]);
 assert.equal(s.view().rewardFacts[0].basis,'actual');
});
test('R95 downward revision after spending creates auditable future-reward debt',async t=>{
 const {service:s}=fixture(t);earn(s,2);await s.action('buy',{foodId:'rice',requestId:'buy'});assert.equal(s.view().wallet.balance,0);
 s.ingestUsageFact(fact('earn',5000,2),{trusted:true});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder,s.view().wallet.debtUnits],[0,0,15000]);
 s.ingestUsageFact(fact('new',25000),{trusted:true});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder,s.view().wallet.debtUnits],[1,0,0]);
 assert.throws(()=>s.ingestUsageFact(fact('earn',6000,2),{trusted:true}),/冲突/);
});
test('R95 purchasing a biscuit package gives 3 portions and duplicate purchase charges once',async t=>{
 const {service:s}=fixture(t);earn(s,2);await s.action('buy',{foodId:'biscuit',requestId:'pack'});await s.action('buy',{foodId:'biscuit',requestId:'pack'});
 assert.equal(s.view().wallet.balance,1);assert.equal(s.view().inventory.biscuit,3);
});
test('R95 full satiety consumes nothing; real meal survives failed AI and settles half only once',async t=>{
 let evaluations=0,fail=true;const amounts=[];
 const {service:s}=fixture(t,{evaluateMeal:async()=>{evaluations++;if(fail)throw Error('mock model unavailable');return {manualEquivalentAffection:1};},settleAffection:async value=>amounts.push(value.amount)});
 earn(s,4);await s.action('buy',{foodId:'rice',requestId:'r'});const full=await s.action('feed',{foodId:'rice',requestId:'full'});assert.equal(full.consumed,false);assert.equal(s.view().inventory.rice,1);
 s.lifeBridge.prepare({transactionId:'set-low',scope:scope(),target:{scope:scope(),satiety:20}});s.lifeBridge.apply({transactionId:'set-low'});s.lifeBridge.finalize({transactionId:'set-low'});s.activeScope(scope());
 await s.action('settings',{autoEat:true,autoBuyRice:false,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().inventory.rice,0);assert.equal(s.view().meals.length,1);assert.equal(s.view().meals[0].affectionState,'pending');
 fail=false;await s.action('retry-meal',{mealId:s.view().meals[0].id});await s.action('retry-meal',{mealId:s.view().meals[0].id});assert.deepEqual(amounts,[.5]);assert.equal(s.view().hunger.satiety,55);assert.equal(evaluations,2);
});
test('R95 only current character accrues runtime hunger; pause/resume never backcharges suspension',async t=>{
 const {service:s,advance}=fixture(t);await advance(3600000);assert.equal(s.view().hunger.satiety,92);
 s.activeScope(scope('gpt'));await advance(3600000);assert.equal(s.view().hunger.satiety,92);s.activeScope(scope());assert.equal(s.view().hunger.satiety,92);
 s.pause('suspend');await advance(3600000);s.resume();assert.equal(s.view().hunger.satiety,92);await s.tick({sleeping:true});await advance(3600000);assert.equal(s.view().hunger.satiety,90);
});
test('R95 auto buys single rice bowls to 20 -> 55 -> 90; repeat is no-op',async t=>{
 const {service:s}=fixture(t);earn(s,10);s.lifeBridge.prepare({transactionId:'low',scope:scope(),target:{scope:scope(),satiety:20}});s.lifeBridge.apply({transactionId:'low'});s.lifeBridge.finalize({transactionId:'low'});s.activeScope(scope());
 await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().hunger.satiety,90);assert.equal(s.view().wallet.balance,6);assert.equal(s.view().meals.length,2);
 await s.action('auto');assert.equal(s.view().wallet.balance,6);assert.equal(s.view().purchases.filter(p=>p.automatic).length,2);
});
test('R95 life journal restores only satiety, not shared wallet/inventory, and repeats safely',async t=>{
 const {service:s}=fixture(t);earn(s,5);await s.action('buy',{foodId:'rice',requestId:'r'});const before=s.lifeBridge.snapshot(scope());
 s.lifeBridge.prepare({transactionId:'life-switch',scope:scope(),target:{scope:scope('deepseek','life-b'),satiety:42}});s.lifeBridge.apply({transactionId:'life-switch'});s.lifeBridge.apply({transactionId:'life-switch'});s.lifeBridge.finalize({transactionId:'life-switch'});
 s.activeScope(scope('deepseek','life-b'));assert.equal(s.view().hunger.satiety,42);assert.equal(s.view().wallet.balance,3);assert.equal(s.view().inventory.rice,1);assert.equal('wallet' in before,false);
});
function low(s,value=20,which=scope(),tx='low-more'){
 s.lifeBridge.prepare({transactionId:tx,scope:which,target:{scope:which,satiety:value}});s.lifeBridge.apply({transactionId:tx});s.lifeBridge.finalize({transactionId:tx});s.activeScope(which);
}
test('R95 attention outbox failures have bounded retries without consuming a second portion',async t=>{
 let calls=0;const {service:s,advance}=fixture(t,{onAttention:async()=>{calls++;throw Error('attention temporarily unavailable');}});earn(s,2);await s.action('buy',{foodId:'rice',requestId:'attention-rice'});low(s);
 await s.action('feed',{foodId:'rice',requestId:'attention-meal'});assert.equal(s.view().meals[0].attempts,1);
 await advance(1001);await advance(10001);await advance(60001);assert.equal(calls,3);assert.equal(s.view().meals.length,1);assert.equal(s.view().inventory.rice,0);
});
test('R95 auto rice purchase and consumption share a transaction; stale consume rolls purchase back',t=>{
 const {service:s,dataRoot,closeAlso}=fixture(t);earn(s,4);low(s);const store=createEconomyStore(dataRoot);closeAlso(()=>store.close());store.settings({autoEat:true,autoBuyRice:true,allowedFoods:['rice']});
 assert.throws(()=>store.purchaseAndConsumeRice({scope:{...scope(),operationId:'wrong-operation'},requestId:'atomic-fail',sessionId:'session'}),/旧人生/);
 assert.equal(store.view(scope()).wallet.balance,4);assert.equal(store.view(scope()).inventory.rice,undefined);assert.equal(store.view(scope()).purchases.length,0);
});
test('R95 automatic purchase permission is rechecked after the first real meal',async t=>{
 let s;const result=fixture(t,{evaluateMeal:async()=>{await s.action('settings',{autoBuyRice:false});return {manualEquivalentAffection:2};},settleAffection:async()=>({})});s=result.service;earn(s,8);low(s);
 await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().wallet.balance,6);assert.equal(s.view().purchases.length,1);
});
test('R95 allowed inventory choice failure stays hungry and does not poll the model on each tick',async t=>{
 let calls=0;const {service:s,advance}=fixture(t,{chooseFood:async()=>{calls++;throw Error('no model choice');}});earn(s,2);await s.action('buy',{foodId:'biscuit',requestId:'choice-pack'});low(s);
 await s.action('settings',{autoEat:true,allowedFoods:['biscuit']});await s.action('auto');await advance(1000);await advance(1000);assert.equal(calls,1);assert.equal(s.view().inventory.biscuit,3);assert.equal(s.view().meals.length,0);
});
test('R95 daily automatic purchase limit is shared across characters and resets by local date',async t=>{
 const {service:s,advance}=fixture(t);earn(s,10);low(s);await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice'],dailyAutoPurchaseLimit:2});await s.action('auto');assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().wallet.balance,8);
 const other=scope('gpt');s.activeScope(other);low(s,20,other,'other-low');await s.action('auto');assert.equal(s.view().hunger.satiety,20);assert.equal(s.view().wallet.balance,8);
 s.pause('suspend');await advance(86400000);s.resume();await s.tick();assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().wallet.balance,6);
});
test('R95 interrupted life journal is recovered without restoring global currency or stock',async t=>{
 const {service:s,dataRoot,closeAlso}=fixture(t);earn(s,5);await s.action('buy',{foodId:'rice',requestId:'journal-rice'});
 s.lifeBridge.prepare({transactionId:'crashed-life',scope:scope(),target:{scope:scope('deepseek','life-b'),satiety:42}});s.lifeBridge.apply({transactionId:'crashed-life'});await s.close();
 const reopened=createFeedingService({dataRoot});closeAlso(()=>reopened.close());assert.throws(()=>reopened.activeScope(scope()),/人生事务/);reopened.lifeBridge.recover({transactionId:'crashed-life',decision:'rollback'});reopened.activeScope(scope());assert.equal(reopened.view().hunger.satiety,100);assert.equal(reopened.view().wallet.balance,3);assert.equal(reopened.view().inventory.rice,1);
});
test('R95 dietary restriction prevents consumption and a full meal never becomes attention',async t=>{
 let attention=0;const {service:s}=fixture(t,{canEatFood:()=>false,onAttention:async()=>attention++});earn(s,2);await s.action('buy',{foodId:'rice',requestId:'diet-pack'});low(s);
 await assert.rejects(s.action('feed',{foodId:'rice',requestId:'diet-meal'}),/饮食限制/);assert.equal(s.view().inventory.rice,1);assert.equal(s.view().hunger.satiety,20);assert.equal(attention,0);
});
test('R95 root normalized totalTokens/baseline payload earns only later positive differences',t=>{
 const {service:s}=fixture(t);const rootFact={canonicalRequestId:'normalized:request',revision:1,totalTokens:10000,sourceId:'native-source',baseline:true,live:false};s.ingestUsageFact(rootFact,{trusted:true});assert.equal(s.view().wallet.balance,0);
 s.ingestUsageFact({...rootFact,revision:2,totalTokens:15000,baseline:false,live:true},{trusted:true});assert.equal(s.view().wallet.remainder,5000);s.ingestUsageFact({...rootFact,revision:3,totalTokens:20000,baseline:false,live:true},{trusted:true});assert.equal(s.view().wallet.balance,1);
});
test('R95 disabling auto eating cancels further purchases while actual meal remains consumed',async t=>{
 let s;const value=fixture(t,{evaluateMeal:async()=>{await s.action('settings',{autoEat:false});return {manualEquivalentAffection:2};},settleAffection:async()=>({})});s=value.service;earn(s,6);low(s);await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().wallet.balance,4);assert.equal(s.view().inventory.rice,0);assert.equal(s.view().hunger.satiety,55);
});
test('R95 an uncooperative model is bounded and closing cancels a pending evaluation',async t=>{
 const {service:s}=fixture(t,{requestTimeoutMs:20,evaluateMeal:async()=>new Promise(()=>{}),settleAffection:async()=>({})});earn(s,2);await s.action('buy',{foodId:'rice',requestId:'timeout-pack'});low(s);await s.action('feed',{foodId:'rice',requestId:'timeout-meal'});assert.equal(s.view().meals[0].affectionState,'pending');assert.match(s.view().meals[0].error,/超时/);assert.equal(s.view().inventory.rice,0);await s.close();
});
test('R95 persona changes do not refill hunger or expose another persona pending meal',async t=>{
 const {service:s}=fixture(t,{evaluateMeal:async()=>{throw Error('offline');},settleAffection:async()=>({})});earn(s,2);await s.action('buy',{foodId:'rice',requestId:'persona-pack'});low(s);await s.action('feed',{foodId:'rice',requestId:'persona-meal'});s.activeScope(scope('deepseek','life-a','other'));assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().meals.length,0);await assert.rejects(s.action('retry-meal',{mealId:'persona-meal'}),/切换/);
});
test('R95 full feeding snapshot retains immutable meal evidence; restoring it cannot eat or reward again',async t=>{
 const {service:s}=fixture(t,{evaluateMeal:async()=>({manualEquivalentAffection:1}),settleAffection:async()=>({})});earn(s,2);await s.action('buy',{foodId:'rice',requestId:'evidence-pack'});low(s);await s.action('feed',{foodId:'rice',requestId:'evidence-meal'});const archived=s.lifeBridge.snapshot(scope());assert.equal(archived.mealEvidence.length,1);assert.equal(archived.mealEvidence[0].affectionState,'settled');
 const next={...scope(),operationId:'operation-restored'};s.lifeBridge.prepare({transactionId:'restore-meal',scope:scope(),target:{...archived,scope:next}});s.lifeBridge.apply({transactionId:'restore-meal'});s.lifeBridge.finalize({transactionId:'restore-meal'});s.activeScope(next);assert.equal(s.view().inventory.rice,0);assert.equal(s.view().wallet.balance,0);assert.equal(s.view().meals.length,0);assert.equal(s.lifeBridge.snapshot(next).mealEvidence.length,1);await assert.rejects(s.action('retry-meal',{mealId:'evidence-meal'}),/切换/);
});
test('R95 committed WAL/journal survives an owned process abrupt exit, then commit recovery is idempotent',async t=>{
 const {service:s,dataRoot}=fixture(t);await s.close();const moduleUrl=new URL('../src/companion-economy-store.mjs',import.meta.url).href;
 const script=`import {createEconomyStore} from ${JSON.stringify(moduleUrl)}; const s=createEconomyStore(process.argv[1]); const scope={characterId:'deepseek',personaId:'default',lifeId:'life-a',operationId:'operation-a'};s.ensureScope(scope);s.initializeRewards({facts:[],cursor:'crash'});s.ingestUsageFact({canonicalRequestId:'crash-earn',revision:1,totalTokens:50000},{trusted:true});s.purchase({scope,foodId:'rice',requestId:'crash-buy'});s.prepareLife({transactionId:'crash-life',scope,target:{scope:{...scope,lifeId:'life-b'},satiety:42}});s.applyLife({transactionId:'crash-life'});process.exit(23);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,dataRoot],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,23,result.stderr);
 const reopened=createFeedingService({dataRoot});try{assert.equal(reopened.view().pendingLifeTransactions.length,1);reopened.lifeBridge.recover({transactionId:'crash-life',decision:'commit'});reopened.lifeBridge.recover({transactionId:'crash-life',decision:'commit'});reopened.activeScope(scope('deepseek','life-b'));assert.equal(reopened.view().wallet.balance,3);assert.equal(reopened.view().inventory.rice,1);assert.equal(reopened.view().hunger.satiety,42);}finally{await reopened.close();}
});
test('R95 shop, inventory, permission controls and ledger are real renderable functional entrances',t=>{
 const {service:s}=fixture(t);for(const tab of ['shop','inventory','settings','ledger']){const html=renderToStaticMarkup(React.createElement(FeedingPage,{view:s.view(),initialTab:tab,onAction:()=>{}}));assert.ok(html.includes('商店'));assert.ok(html.includes('背包'));if(tab==='shop'){assert.ok(html.includes('大白兔奶糖'));assert.ok(html.includes('单份恢复'));assert.ok(html.includes('assets/food/milk-candy.webp'));}if(tab==='settings'){assert.ok(html.includes('允许自动补买米饭'));assert.ok(html.includes('每日自动采购积分上限'));}}
});
test('R95 first baseline cannot award historical revisions of the same cumulative request',t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r95-baseline-')),s=createFeedingService({dataRoot});t.after(async()=>{await s.close();rmSync(dataRoot,{recursive:true,force:true});});
 s.initializeRewards({facts:[fact('historical-request',9999,1),fact('historical-request',20000,2)],cursor:'historical-complete'});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder],[0,0]);
 s.ingestUsageFact(fact('historical-request',25000,3),{trusted:true});assert.equal(s.view().wallet.remainder,5000);
});
test('R95 life quiescence cancels evaluation, waits for own callbacks and seals actual meal evidence',async t=>{
 const {service:s}=fixture(t,{evaluateMeal:async()=>new Promise(()=>{}),settleAffection:async()=>({})});earn(s,2);await s.action('buy',{foodId:'rice',requestId:'quiesce-pack'});low(s);
 const feed=s.action('feed',{foodId:'rice',requestId:'quiesce-meal'});while(!s.view().meals.length)await new Promise(resolve=>setImmediate(resolve));const result=await s.lifeBridge.quiesce(scope());await feed;assert.equal(result.quiesced,true);assert.equal(s.view().paused,true);assert.equal(s.view().inventory.rice,0);assert.equal(s.lifeBridge.snapshot(scope()).mealEvidence.length,1);
});
for(const [key,value] of [['schemaVersion',99],['minimumWriter','future-economy-writer']])test('R95 economy readonly preflight rejects unknown '+key+' without modifying its bytes',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-economy-compat-'));t.after(()=>rmSync(dataRoot,{recursive:true,force:true}));const store=createEconomyStore(dataRoot),path=store.path;store.close();const db=new DatabaseSync(path);db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(value),key);db.close();const before=readFileSync(path);assert.throws(()=>createEconomyStore(dataRoot),/版本|writer/);assert.deepEqual(readFileSync(path),before);
});
