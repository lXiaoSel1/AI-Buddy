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
import {locale,setLocale} from '../src/i18n.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {companionFixture,gate,memoryStore} from './support/audit-harness.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';

const scope=(characterId='deepseek',lifeId='life-a',personaId='default')=>({characterId,lifeId,personaId,operationId:'operation-a'});
async function fixture(t,options={}){
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r95-feeding-'));let time=0;const extraClosers=[];
 const service=createFeedingService({dataRoot,now:()=>Date.UTC(2026,9,25)+time,monotonicNow:()=>time,...options});
 t.after(async()=>{for(const close of extraClosers)await close();await service.close();rmSync(dataRoot,{recursive:true,force:true});});
 await service.initializeRewards({facts:[],cursor:'initial'});await service.activeScope(scope());
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
 const {service:s,dataRoot}=await fixture(t);await s.ingestUsageFact(fact('first',9999),{trusted:true});assert.equal(s.view().wallet.balance,0);assert.equal(s.view().wallet.remainder,9999);
 await s.ingestUsageFact(fact('second',1),{trusted:true});assert.equal(s.view().wallet.balance,1);await s.ingestUsageFact(fact('second',1),{trusted:true});assert.equal(s.view().wallet.balance,1);
 await s.ingestUsageFact(fact('old-import',500000),{trusted:true,baseline:true});assert.equal(s.view().wallet.balance,1);
 await s.close();const reopened=createFeedingService({dataRoot});await reopened.ready;assert.equal(reopened.view().wallet.balance,1);assert.equal(reopened.view().wallet.remainder,0);await reopened.close();
});
test('R95 CG fallback is separate reward equivalence and late actual receipt replaces it',async t=>{
 const {service:s}=await fixture(t);await s.ingestUsageFact({canonicalRequestId:'cg:job',revision:1,basis:'cg-fallback',origin:'cg-completion',status:'ready',completedImageIds:Array.from({length:8},(_,i)=>'image-'+i)},{trusted:true});
 assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder],[1,400]);
 await s.ingestUsageFact(fact('cg:job',20000,2),{trusted:true});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder],[2,0]);
 assert.equal(s.view().rewardFacts[0].basis,'actual');
});
test('R95 downward revision after spending creates auditable future-reward debt',async t=>{
 const {service:s}=await fixture(t);await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'buy'});assert.equal(s.view().wallet.balance,0);
 await s.ingestUsageFact(fact('earn',5000,2),{trusted:true});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder,s.view().wallet.debtUnits],[0,0,15000]);
 await s.ingestUsageFact(fact('new',25000),{trusted:true});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder,s.view().wallet.debtUnits],[1,0,0]);
 await assert.rejects(s.ingestUsageFact(fact('earn',6000,2),{trusted:true}),/冲突/);
});
test('R95 purchasing a biscuit package gives 3 portions and duplicate purchase charges once',async t=>{
 const {service:s}=await fixture(t);await earn(s,2);await s.action('buy',{foodId:'biscuit',requestId:'pack'});await s.action('buy',{foodId:'biscuit',requestId:'pack'});
 assert.equal(s.view().wallet.balance,1);assert.equal(s.view().inventory.biscuit,3);
});
test('R95 full satiety consumes nothing; real meal survives failed AI and settles half only once',async t=>{
 let evaluations=0,fail=true;const amounts=[];
 const {service:s}=await fixture(t,{evaluateMeal:async()=>{evaluations++;if(fail)throw Error('mock model unavailable');return {manualEquivalentAffection:1};},settleAffection:async value=>amounts.push(value.amount)});
 await earn(s,4);await s.action('buy',{foodId:'rice',requestId:'r'});const full=await s.action('feed',{foodId:'rice',requestId:'full'});assert.equal(full.consumed,false);assert.equal(s.view().inventory.rice,1);
 await s.lifeBridge.prepare({transactionId:'set-low',scope:scope(),target:{scope:scope(),satiety:20}});await s.lifeBridge.apply({transactionId:'set-low'});await s.lifeBridge.finalize({transactionId:'set-low'});await s.activeScope(scope());
 await s.action('settings',{autoEat:true,autoBuyRice:false,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().inventory.rice,0);assert.equal(s.view().meals.length,1);assert.equal(s.view().meals[0].affectionState,'pending');
 fail=false;await s.action('retry-meal',{mealId:s.view().meals[0].id});await s.action('retry-meal',{mealId:s.view().meals[0].id});assert.deepEqual(amounts,[.5]);assert.equal(s.view().hunger.satiety,55);assert.equal(evaluations,2);
});
test('R95 only current character accrues runtime hunger; pause/resume never backcharges suspension',async t=>{
 const {service:s,advance}=await fixture(t);await advance(3600000);assert.equal(s.view().hunger.satiety,92);
 await s.activeScope(scope('gpt'));await advance(3600000);assert.equal(s.view().hunger.satiety,92);await s.activeScope(scope());assert.equal(s.view().hunger.satiety,92);
 await s.pause('suspend');await advance(3600000);await s.resume();assert.equal(s.view().hunger.satiety,92);await s.tick({sleeping:true});await advance(3600000);assert.equal(s.view().hunger.satiety,90);
});
test('R95 auto buys single rice bowls to 20 -> 55 -> 90; repeat is no-op',async t=>{
 const {service:s}=await fixture(t);await earn(s,10);await s.lifeBridge.prepare({transactionId:'low',scope:scope(),target:{scope:scope(),satiety:20}});await s.lifeBridge.apply({transactionId:'low'});await s.lifeBridge.finalize({transactionId:'low'});await s.activeScope(scope());
 await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().hunger.satiety,90);assert.equal(s.view().wallet.balance,6);assert.equal(s.view().meals.length,2);
 await s.action('auto');assert.equal(s.view().wallet.balance,6);assert.equal(s.view().purchases.filter(p=>p.automatic).length,2);
});
test('R95 life journal restores only satiety, not shared wallet/inventory, and repeats safely',async t=>{
 const {service:s}=await fixture(t);await earn(s,5);await s.action('buy',{foodId:'rice',requestId:'r'});const before=await s.lifeBridge.snapshot(scope());
 await s.lifeBridge.prepare({transactionId:'life-switch',scope:scope(),target:{scope:scope('deepseek','life-b'),satiety:42}});await s.lifeBridge.apply({transactionId:'life-switch'});await s.lifeBridge.apply({transactionId:'life-switch'});await s.lifeBridge.finalize({transactionId:'life-switch'});
 await s.activeScope(scope('deepseek','life-b'));assert.equal(s.view().hunger.satiety,42);assert.equal(s.view().wallet.balance,3);assert.equal(s.view().inventory.rice,1);assert.equal('wallet' in before,false);
});
async function low(s,value=20,which=scope(),tx='low-more'){
 await s.lifeBridge.prepare({transactionId:tx,scope:which,target:{scope:which,satiety:value}});await s.lifeBridge.apply({transactionId:tx});await s.lifeBridge.finalize({transactionId:tx});await s.activeScope(which);
}
test('R7 meals finish local work offline, make zero meal writes for three hours and replay one at a time',async t=>{
 let enabled=false,active=0,peak=0;const evaluations=[],settlements=[],attention=[],experiences=[],entered=gate(),release=gate();
 const {service:s,dataRoot,advance}=await fixture(t,{canEvaluateMeal:()=>enabled,
  onAttention:async({eventId})=>attention.push(eventId),onExperience:async({eventId})=>experiences.push(eventId),
  evaluateMeal:async({meal})=>{evaluations.push(meal.id);if(!enabled)throw Error('联网聊天关闭');peak=Math.max(peak,++active);try{if(meal.id==='meal-1'){entered.resolve();await release.promise;}return {manualEquivalentAffection:1};}finally{active--;}},
  settleAffection:async({mealId})=>settlements.push(mealId)});
 await earn(s,1);await s.action('buy',{foodId:'biscuit',requestId:'three-meals'});await low(s);
 const ids=['meal-1','meal-2','meal-3'];for(const requestId of ids)await s.action('feed',{foodId:'biscuit',requestId});
 const db=new DatabaseSync(join(dataRoot,'companion-economy-v1','economy.sqlite'));
 try{
  db.exec('CREATE TABLE test_meal_updates(count INTEGER); INSERT INTO test_meal_updates VALUES(0); CREATE TRIGGER test_count_meal_updates AFTER UPDATE ON meals BEGIN UPDATE test_meal_updates SET count=count+1; END;');
  for(let second=0;second<10800;second++)await advance(1000);
  const writes=db.prepare('SELECT count FROM test_meal_updates').get().count;
  const status=meal=>[meal.attempts,meal.retryAt,meal.affectionState];
  assert.deepEqual({writes,calls:evaluations.length,meals:s.view().meals.map(status)},{writes:0,calls:0,meals:ids.map(()=>[0,null,'pending'])});
  assert.deepEqual(attention,ids.map(id=>'feeding:'+id+':attention'));assert.deepEqual(experiences,ids.map(id=>'feeding:'+id+':experience'));
  assert.equal((await s.action('view')).modelAvailable,false);
  await assert.rejects(s.action('retry-meal',{mealId:ids[0]}),{code:'R95_MODEL_DISABLED'});
  assert.equal(db.prepare('SELECT count FROM test_meal_updates').get().count,0);
  enabled=true;assert.equal((await s.action('view')).modelAvailable,true);
  const first=advance(1000);
  try{
   await Promise.race([entered.promise,first.then(()=>assert.fail('oldest meal did not start'))]);
   await advance(1000);assert.deepEqual(evaluations,[ids[0]]);
  }finally{release.resolve();await first;}
  assert.deepEqual(settlements,[ids[0]]);
  await advance(1000);await advance(1000);await advance(1000);
  assert.deepEqual(evaluations,ids);assert.deepEqual(settlements,ids);assert.equal(peak,1);
  assert.deepEqual(s.view().meals.map(status),ids.map(()=>[1,null,'settled']));
 }finally{db.close();}
});

test('R7 a meal evaluation interrupted by the online chat switch can resume without spending an attempt',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r7-feeding-toggle-')),store=memoryStore(await companionFixture()),started=gate();
 let service,requests=0;const settlements=[];
 const provider=new ModelRouter({dataRoot,crypto:fakeCrypto,codex:stubCodex(),fetchImpl:async(_,{signal})=>{
  if(++requests===1){started.resolve();await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
  const reply={choices:[{delta:{content:JSON.stringify({manualEquivalentAffection:1})},finish_reason:'stop'}]};
  return new Response('data: '+JSON.stringify(reply)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 t.after(async()=>{provider.setEnabled(false);await service?.close();await provider.close();rmSync(dataRoot,{recursive:true,force:true});});
 const profile=await provider.save({kind:'custom',name:'Fixture',protocol:'chat-completions',baseUrl:'https://fixture.invalid/v1',model:'fixture-model',key:'fake-key',contextTokens:128000});
 await provider.activate(profile.id);provider.setEnabled(true);
 service=await createCompanionR95({store,dataRoot,provider,getContext:()=>({characterId:'claude',personaId:'default',conversationId:'conversation'}),delta:async(_character,_persona,amount,eventId)=>settlements.push([amount,eventId])});
 const s=service.feeding;await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'switch-rice'});await low(s,20,service.activeScope());
 const feed=s.action('feed',{foodId:'rice',requestId:'switch-meal'});
 await Promise.race([started.promise,feed.then(()=>assert.fail('transport never received the meal'))]);
 provider.setEnabled(false);provider.setEnabled(true);
 const {meal}=await feed;
 assert.deepEqual([meal.attempts,meal.retryAt,meal.affectionState,meal.attentionDone,meal.experienceDone],[0,null,'pending',true,true]);
 await s.tick();await s.tick();assert.equal(requests,2);assert.equal(s.view().meals[0].affectionState,'settled');assert.deepEqual(settlements,[[1,'feeding:switch-meal:relationship']]);
});

test('R7 only exhausted pending meals with the exact old offline error are migrated once',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r7-meal-migration-'));let writer,service,time=10000;
 t.after(async()=>{await service?.close();await writer?.close();rmSync(dataRoot,{recursive:true,force:true});});
 const now=()=>time,legacy='联网聊天关闭',failure='Synthetic provider error',current=scope(),obsolete={...scope(),operationId:'obsolete'};
 writer=createEconomyStore(dataRoot,{now});writer.initializeRewards({facts:[],cursor:'test'});writer.ingestUsageFact(fact('migration-earn',30000),{trusted:true});writer.purchase({scope:obsolete,foodId:'biscuit',packages:3,requestId:'legacy-portions'});writer.ensureScope(obsolete);
 const seed=(id,which,attempts,error,affectionState='pending')=>{time++;assert.equal(writer.consume({scope:which,foodId:'biscuit',requestId:id}).consumed,true);writer.updateMeal(id,{attempts,retryAt:12000,error,affectionState,attentionDone:true,experienceDone:true});};
 const tx='legacy-low';writer.prepareLife({transactionId:tx,scope:obsolete,target:{scope:obsolete,satiety:5},before:writer.snapshot(obsolete)});writer.applyLife({transactionId:tx});writer.finalizeLife({transactionId:tx});
 seed('obsolete',obsolete,3,legacy);writer.ensureScope(current);
 // Recreate an old pending record after binding the current operation so startup still exercises stale-scope cancellation.
 writer.updateMeal('obsolete',{affectionState:'pending',retryAt:12000,error:legacy});
 seed('legacy-3',current,3,legacy);seed('legacy-4',current,4,legacy);seed('real-error',current,3,failure);seed('different-text',current,3,legacy+'。');seed('not-exhausted',current,2,legacy);seed('cancelled',current,3,legacy,'cancelled');seed('settled',current,3,legacy,'settled');
 const path=writer.path;await writer.close();writer=null;
 const previousSchema=new DatabaseSync(path);try{previousSchema.prepare('DELETE FROM meta WHERE key=?').run('mealDisabledRetryMigrationV1');}finally{previousSchema.close();}
 const audit=[],requests=[],settlements=[];let enabled=false;
 const open=()=>createFeedingService({dataRoot,now,monotonicNow:()=>0,audit:event=>audit.push(event),canEvaluateMeal:()=>enabled,evaluateMeal:async({meal})=>{requests.push(meal.id);return {manualEquivalentAffection:1};},settleAffection:async({mealId})=>settlements.push(mealId)});
 service=open();await service.ready;
 const snapshot=()=>{const db=createEconomyStore(dataRoot,{readOnly:true,now});try{return Object.fromEntries(db.view().meals.map(meal=>[meal.id,[meal.attempts,meal.retryAt,meal.affectionState,meal.error]]));}finally{db.close();}};
 const migrated=[0,null,'pending',legacy];
 const expected={obsolete:migrated,'legacy-3':migrated,'legacy-4':migrated,'real-error':[3,12000,'pending',failure],'different-text':[3,12000,'pending',legacy+'。'],'not-exhausted':[2,12000,'pending',legacy],cancelled:[3,12000,'cancelled',legacy],settled:[3,12000,'settled',legacy]};
 assert.deepEqual(snapshot(),expected);await service.close();service=open();await service.ready;assert.deepEqual(snapshot(),expected);
 assert.deepEqual(audit.filter(event=>event.type==='feeding-disabled-retry-migration').map(({thread,threadId,...event})=>event),[{type:'feeding-disabled-retry-migration',count:3}]);
 await service.activeScope(current);assert.equal(snapshot().obsolete[2],'cancelled');
 enabled=true;await service.tick();await service.tick();await service.tick();
 assert.deepEqual(requests,['legacy-3','legacy-4']);assert.deepEqual(settlements,requests);assert.equal(snapshot()['real-error'][0],3);
});

test('R7 genuine online failures still stop after three attempts with the existing cooldowns',async t=>{
 let calls=0,fail=true;const {service:s,advance,time}=await fixture(t,{canEvaluateMeal:()=>true,evaluateMeal:async()=>{calls++;if(fail)throw Error('Synthetic provider error');return {manualEquivalentAffection:1};},settleAffection:async()=>({})});
 await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'failure-rice'});await low(s);await s.action('feed',{foodId:'rice',requestId:'failure-meal'});
 const meal=()=>s.view().meals[0],next=()=>meal().retryAt-Date.UTC(2026,9,25)-time();
 assert.deepEqual([calls,meal().attempts,next()],[1,1,1000]);await advance(999);assert.equal(calls,1);await advance(1);
 assert.deepEqual([calls,meal().attempts,next()],[2,2,10000]);await advance(9999);assert.equal(calls,2);await advance(1);
 assert.deepEqual([calls,meal().attempts,next()],[3,3,60000]);fail=false;await advance(10800000);assert.equal(calls,3);assert.equal(meal().affectionState,'pending');
 assert.equal(meal().error,'Synthetic provider error');await s.action('retry-meal',{mealId:meal().id});assert.equal(calls,4);assert.equal(meal().affectionState,'settled');
});

test('R7 review meal replay submits once per attempt when the production router receives a length finish',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r7-feeding-length-')),store=memoryStore(await companionFixture());
 let service,time=Date.UTC(2026,9,25),requests=0;const compressionOptions=[];
 const provider=new ModelRouter({dataRoot,crypto:fakeCrypto,codex:stubCodex(),fetchImpl:async()=>{
  requests++;
  const frame={choices:[{delta:{content:'{"manualEquivalentAffection":'},finish_reason:'length'}]};
  return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 t.after(async()=>{await service?.close();await provider.close();rmSync(dataRoot,{recursive:true,force:true});});
 const profile=await provider.save({kind:'custom',name:'Fixture',protocol:'chat-completions',baseUrl:'https://fixture.invalid/v1',model:'fixture-model',key:'fake-key',contextTokens:128000});
 await provider.activate(profile.id);
 service=await createCompanionR95({store,dataRoot,provider,now:()=>time,getContext:()=>({characterId:'claude',personaId:'default',conversationId:'conversation'}),
  memory:{context:async({allowQueryCompression})=>{compressionOptions.push(allowQueryCompression);return {text:''};}},
  delta:()=>assert.fail('truncated assessment must never settle')});
 const s=service.feeding;await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'length-rice'});await low(s,20,service.activeScope());
 await s.action('feed',{foodId:'rice',requestId:'length-meal'});assert.equal(requests,0);
 provider.setEnabled(true);
 const state=()=>{const [meal]=s.view().meals;return {requests,compressionOptions:[...compressionOptions],attempts:meal.attempts,cooldown:meal.retryAt-time};};
 await s.tick();assert.deepEqual(state(),{requests:1,compressionOptions:[false],attempts:1,cooldown:1000});
 time+=1000;await s.tick();assert.deepEqual(state(),{requests:2,compressionOptions:[false,false],attempts:2,cooldown:10000});
 time+=10000;await s.tick();assert.deepEqual(state(),{requests:3,compressionOptions:[false,false,false],attempts:3,cooldown:60000});
 time+=60000;await s.tick();assert.equal(requests,3);assert.equal(s.view().meals[0].affectionState,'pending');
});

test('R7 review every active-scope pending meal remains retryable beyond 100 newer history rows',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r7-feeding-history-'));let service;
 t.after(async()=>{await service?.close();rmSync(dataRoot,{recursive:true,force:true});});
 const writer=createEconomyStore(dataRoot);const path=writer.path;await writer.close();
 const current=scope(),other=scope('deepseek','life-a','other'),now=Date.UTC(2026,9,25,12),failure='Synthetic older provider error';
 const db=new DatabaseSync(path);
 try{
  // Seed ordinary persisted meal rows with deterministic dates and scopes.
  const insert=db.prepare('INSERT INTO meals(id,character_id,life_id,operation_id,affection_state,attempts,retry_at,value,at) VALUES(?,?,?,?,?,?,NULL,?,?)');
  const meal=(id,which,at,affectionState,attempts=0,error=null)=>insert.run(id,which.characterId,which.lifeId,which.operationId,affectionState,attempts,
   JSON.stringify({id,scope:which,at,foodId:'rice',affectionState,attempts,error,attentionDone:true,experienceDone:true}),at);
  meal('old-exhausted',current,now-10000,'pending',3,failure);meal('old-due',current,now-9000,'pending');meal('old-settled',current,now-8000,'settled');
  for(let i=0;i<100;i++)meal('new-other-'+i,other,now-i-100,'pending',3);
  meal('new-active',current,now-1,'pending');
 }finally{db.close();}
 const history=createEconomyStore(dataRoot,{readOnly:true});try{assert.equal(history.view().meals.length,100);}finally{history.close();}
 service=createFeedingService({dataRoot,now:()=>now});await service.activeScope(current);
 const view=await service.action('view');
 assert.deepEqual(view.meals.map(meal=>meal.id),['new-active','old-due','old-exhausted']);
 const previous=locale();try{
  setLocale('zh-CN');const html=renderToStaticMarkup(React.createElement(FeedingPage,{view,initialTab:'inventory',now,onAction:()=>{}}));
  assert.equal((html.match(/现在重试/g)??[]).length,3);
  assert.match(html.replace(/<[^>]+>/g,' '),/自动重试已用完。\s*Synthetic older provider error/);
 }finally{setLocale(previous);}
});
test('R95 attention outbox failures have bounded retries without consuming a second portion',async t=>{
 let calls=0;const {service:s,advance}=await fixture(t,{onAttention:async()=>{calls++;throw Error('attention temporarily unavailable');}});await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'attention-rice'});await low(s);
 await s.action('feed',{foodId:'rice',requestId:'attention-meal'});assert.equal(s.view().meals[0].attempts,1);
 await advance(1001);await advance(10001);await advance(60001);assert.equal(calls,3);assert.equal(s.view().meals.length,1);assert.equal(s.view().inventory.rice,0);
});
test('R95 auto rice purchase and consumption share a transaction; stale consume rolls purchase back',async t=>{
 const {service:s,dataRoot,closeAlso}=await fixture(t);await earn(s,4);await low(s);await s.close();const store=createEconomyStore(dataRoot);closeAlso(()=>store.close());store.settings({autoEat:true,autoBuyRice:true,allowedFoods:['rice']});
 assert.throws(()=>store.purchaseAndConsumeRice({scope:{...scope(),operationId:'wrong-operation'},requestId:'atomic-fail',sessionId:'session'}),/旧人生/);
 assert.equal(store.view(scope()).wallet.balance,4);assert.equal(store.view(scope()).inventory.rice,undefined);assert.equal(store.view(scope()).purchases.length,0);
});
test('R95 automatic purchase permission is rechecked after the first real meal',async t=>{
 let s;const result=await fixture(t,{evaluateMeal:async()=>{await s.action('settings',{autoBuyRice:false});return {manualEquivalentAffection:2};},settleAffection:async()=>({})});s=result.service;await earn(s,8);await low(s);
 await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().wallet.balance,6);assert.equal(s.view().purchases.length,1);
});
test('R95 allowed inventory choice failure stays hungry and does not poll the model on each tick',async t=>{
 let calls=0;const {service:s,advance}=await fixture(t,{chooseFood:async()=>{calls++;throw Error('no model choice');}});await earn(s,2);await s.action('buy',{foodId:'biscuit',requestId:'choice-pack'});await low(s);
 await s.action('settings',{autoEat:true,allowedFoods:['biscuit']});await s.action('auto');await advance(1000);await advance(1000);assert.equal(calls,1);assert.equal(s.view().inventory.biscuit,3);assert.equal(s.view().meals.length,0);
});
test('R95 daily automatic purchase limit is shared across characters and resets by local date',async t=>{
 const {service:s,advance}=await fixture(t);await earn(s,10);await low(s);await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice'],dailyAutoPurchaseLimit:2});await s.action('auto');assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().wallet.balance,8);
 const other=scope('gpt');await s.activeScope(other);await low(s,20,other,'other-low');await s.action('auto');assert.equal(s.view().hunger.satiety,20);assert.equal(s.view().wallet.balance,8);
 await s.pause('suspend');await advance(86400000);await s.resume();await s.tick();assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().wallet.balance,6);
});
test('R95 interrupted life journal is recovered without restoring global currency or stock',async t=>{
 const {service:s,dataRoot,closeAlso}=await fixture(t);await earn(s,5);await s.action('buy',{foodId:'rice',requestId:'journal-rice'});
 await s.lifeBridge.prepare({transactionId:'crashed-life',scope:scope(),target:{scope:scope('deepseek','life-b'),satiety:42}});await s.lifeBridge.apply({transactionId:'crashed-life'});await s.close();
 const reopened=createFeedingService({dataRoot});closeAlso(()=>reopened.close());await assert.rejects(reopened.activeScope(scope()),/人生事务/);await reopened.lifeBridge.recover({transactionId:'crashed-life',decision:'rollback'});await reopened.activeScope(scope());assert.equal(reopened.view().hunger.satiety,100);assert.equal(reopened.view().wallet.balance,3);assert.equal(reopened.view().inventory.rice,1);
});
test('R95 dietary restriction prevents consumption and a full meal never becomes attention',async t=>{
 let attention=0;const {service:s}=await fixture(t,{canEatFood:()=>false,onAttention:async()=>attention++});await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'diet-pack'});await low(s);
 await assert.rejects(s.action('feed',{foodId:'rice',requestId:'diet-meal'}),/饮食限制/);assert.equal(s.view().inventory.rice,1);assert.equal(s.view().hunger.satiety,20);assert.equal(attention,0);
});
test('R95 root normalized totalTokens/baseline payload earns only later positive differences',async t=>{
 const {service:s}=await fixture(t);const rootFact={canonicalRequestId:'normalized:request',revision:1,totalTokens:10000,sourceId:'native-source',baseline:true,live:false};await s.ingestUsageFact(rootFact,{trusted:true});assert.equal(s.view().wallet.balance,0);
 await s.ingestUsageFact({...rootFact,revision:2,totalTokens:15000,baseline:false,live:true},{trusted:true});assert.equal(s.view().wallet.remainder,5000);await s.ingestUsageFact({...rootFact,revision:3,totalTokens:20000,baseline:false,live:true},{trusted:true});assert.equal(s.view().wallet.balance,1);
});
test('R95 disabling auto eating cancels further purchases while actual meal remains consumed',async t=>{
 let s;const value=await fixture(t,{evaluateMeal:async()=>{await s.action('settings',{autoEat:false});return {manualEquivalentAffection:2};},settleAffection:async()=>({})});s=value.service;await earn(s,6);await low(s);await s.action('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice']});await s.action('auto');assert.equal(s.view().wallet.balance,4);assert.equal(s.view().inventory.rice,0);assert.equal(s.view().hunger.satiety,55);
});
test('R95 an uncooperative model is bounded and closing cancels a pending evaluation',async t=>{
 const {service:s}=await fixture(t,{requestTimeoutMs:20,evaluateMeal:async()=>new Promise(()=>{}),settleAffection:async()=>({})});await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'timeout-pack'});await low(s);await s.action('feed',{foodId:'rice',requestId:'timeout-meal'});assert.equal(s.view().meals[0].affectionState,'pending');assert.match(s.view().meals[0].error,/超时/);assert.equal(s.view().inventory.rice,0);await s.close();
});
test('R95 persona changes do not refill hunger or expose another persona pending meal',async t=>{
 const {service:s}=await fixture(t,{evaluateMeal:async()=>{throw Error('offline');},settleAffection:async()=>({})});await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'persona-pack'});await low(s);await s.action('feed',{foodId:'rice',requestId:'persona-meal'});await s.activeScope(scope('deepseek','life-a','other'));assert.equal(s.view().hunger.satiety,55);assert.equal(s.view().meals.length,0);await assert.rejects(s.action('retry-meal',{mealId:'persona-meal'}),/切换/);
});
test('R95 full feeding snapshot retains immutable meal evidence; restoring it cannot eat or reward again',async t=>{
 const {service:s}=await fixture(t,{evaluateMeal:async()=>({manualEquivalentAffection:1}),settleAffection:async()=>({})});await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'evidence-pack'});await low(s);await s.action('feed',{foodId:'rice',requestId:'evidence-meal'});const archived=await s.lifeBridge.snapshot(scope());assert.equal(archived.mealEvidence.length,1);assert.equal(archived.mealEvidence[0].affectionState,'settled');
 const next={...scope(),operationId:'operation-restored'};await s.lifeBridge.prepare({transactionId:'restore-meal',scope:scope(),target:{...archived,scope:next}});await s.lifeBridge.apply({transactionId:'restore-meal'});await s.lifeBridge.finalize({transactionId:'restore-meal'});await s.activeScope(next);assert.equal(s.view().inventory.rice,0);assert.equal(s.view().wallet.balance,0);assert.equal(s.view().meals.length,0);assert.equal((await s.lifeBridge.snapshot(next)).mealEvidence.length,1);await assert.rejects(s.action('retry-meal',{mealId:'evidence-meal'}),/切换/);
});
test('R95 committed WAL/journal survives an owned process abrupt exit, then commit recovery is idempotent',async t=>{
 const {service:s,dataRoot}=await fixture(t);await s.close();const moduleUrl=new URL('../src/companion-economy-store.mjs',import.meta.url).href;
 const script=`import {createEconomyStore} from ${JSON.stringify(moduleUrl)}; const s=createEconomyStore(process.argv[1]); const scope={characterId:'deepseek',personaId:'default',lifeId:'life-a',operationId:'operation-a'};s.ensureScope(scope);s.initializeRewards({facts:[],cursor:'crash'});s.ingestUsageFact({canonicalRequestId:'crash-earn',revision:1,totalTokens:50000},{trusted:true});s.purchase({scope,foodId:'rice',requestId:'crash-buy'});s.prepareLife({transactionId:'crash-life',scope,target:{scope:{...scope,lifeId:'life-b'},satiety:42}});s.applyLife({transactionId:'crash-life'});process.exit(23);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,dataRoot],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,23,result.stderr);
 const reopened=createFeedingService({dataRoot});try{await reopened.ready;assert.equal(reopened.view().pendingLifeTransactions.length,1);await reopened.lifeBridge.recover({transactionId:'crash-life',decision:'commit'});await reopened.lifeBridge.recover({transactionId:'crash-life',decision:'commit'});await reopened.activeScope(scope('deepseek','life-b'));assert.equal(reopened.view().wallet.balance,3);assert.equal(reopened.view().inventory.rice,1);assert.equal(reopened.view().hunger.satiety,42);}finally{await reopened.close();}
});
test('R95 shop, inventory, permission controls and ledger are real renderable functional entrances',async t=>{
 const {service:s}=await fixture(t);for(const tab of ['shop','inventory','settings','ledger']){const html=renderToStaticMarkup(React.createElement(FeedingPage,{view:s.view(),initialTab:tab,onAction:()=>{}}));assert.ok(html.includes('商店'));assert.ok(html.includes('背包'));if(tab==='shop'){assert.ok(html.includes('大白兔奶糖'));assert.ok(html.includes('单份恢复'));assert.ok(html.includes('assets/food/milk-candy.webp'));}if(tab==='settings'){assert.ok(html.includes('允许自动补买米饭'));assert.ok(html.includes('每日自动采购积分上限'));}}
});
test('R18 feeding surfaces economy errors in the selected language',()=>{
 const before=locale(),activeScope=scope();
 const reopen='经济服务未能确认写入结果，请重新启动 AI 酱',revoked='经济操作已失效';
 const view={catalog:FOODS,activeScope,hunger:{satiety:40},inventory:{rice:1},settings:{autoEat:true},rewardsInitialized:true,
  meals:[{id:'meal',scope:activeScope,foodId:'rice',affectionState:'pending',error:revoked}],
  autoSession:{state:'blocked',error:"Error invoking remote method 'game:action': Error: "+reopen}
 };
 const render=initialTab=>renderToStaticMarkup(React.createElement(FeedingPage,{view,initialTab,onAction:()=>{}}));
 try{
  setLocale('en');
  assert.match(render('inventory'),/title="The economy operation is no longer valid\."/);
  assert.match(render('settings'),/title="The economy service could not confirm the write\. Restart AI Buddy\."/);
  setLocale('zh-CN');
  assert.ok(render('inventory').includes('title="'+revoked+'"'));
  assert.ok(render('settings').includes('title="'+reopen+'"'));
 }finally{setLocale(before);}
});
test('R95 first baseline cannot award historical revisions of the same cumulative request',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r95-baseline-')),s=createFeedingService({dataRoot});t.after(async()=>{await s.close();rmSync(dataRoot,{recursive:true,force:true});});
 await s.initializeRewards({facts:[fact('historical-request',9999,1),fact('historical-request',20000,2)],cursor:'historical-complete'});assert.deepEqual([s.view().wallet.balance,s.view().wallet.remainder],[0,0]);
 await s.ingestUsageFact(fact('historical-request',25000,3),{trusted:true});assert.equal(s.view().wallet.remainder,5000);
});
test('R95 life quiescence cancels evaluation, waits for own callbacks and seals actual meal evidence',async t=>{
 const {service:s}=await fixture(t,{evaluateMeal:async()=>new Promise(()=>{}),settleAffection:async()=>({})});await earn(s,2);await s.action('buy',{foodId:'rice',requestId:'quiesce-pack'});await low(s);
 const feed=s.action('feed',{foodId:'rice',requestId:'quiesce-meal'});while(!s.view().meals.length)await new Promise(resolve=>setImmediate(resolve));const result=await s.lifeBridge.quiesce(scope());await feed;assert.equal(result.quiesced,true);assert.equal(s.view().paused,true);assert.equal(s.view().inventory.rice,0);assert.equal((await s.lifeBridge.snapshot(scope())).mealEvidence.length,1);
});
for(const [key,value] of [['schemaVersion',99],['minimumWriter','future-economy-writer']])test('R95 economy readonly preflight rejects unknown '+key+' without modifying its bytes',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-economy-compat-'));t.after(()=>rmSync(dataRoot,{recursive:true,force:true}));const store=createEconomyStore(dataRoot),path=store.path;await store.close();const db=new DatabaseSync(path);db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(value),key);db.close();const before=readFileSync(path);assert.throws(()=>createEconomyStore(dataRoot),/版本|writer/);assert.deepEqual(readFileSync(path),before);
});
