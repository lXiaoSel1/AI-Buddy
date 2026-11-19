import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';

const original={characterId:'deepseek',personaId:'default',lifeId:'life-a',operationId:'operation-a'};
const other={...original,characterId:'claude'};
const replacement={...original,lifeId:'life-b',operationId:'operation-b'};

async function fixture(t,{holdMeal=false,mergeHunger}={}){
 const root=await mkdtemp(join(tmpdir(),'buddy-r19-feeding-'));
 let elapsed=0,authoritative=original;
 const now=()=>Date.UTC(2026,10,15)+elapsed;
 const economy=await createEconomyStore(root,{now});
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),seen=[],audits=[];
 const store={...economy,...mergeHunger&&{mergeHunger:(scope,part)=>mergeHunger(economy,scope,part)},
  async consume(...args){
   const result=await economy.consume(...args);
   if(holdMeal&&result.newlyConsumed){entered.resolve();await release.promise;}
   return result;
  }
 };
 const settlement=kind=>async value=>{seen.push({kind,eventId:value.eventId,scope:value.scope});return {eventId:value.eventId};};
 const feeding=createFeedingService({
  store,now,monotonicNow:()=>elapsed,audit:value=>audits.push(value),
  assertScope:scope=>scope.characterId!==original.characterId||scope.lifeId===authoritative.lifeId&&scope.operationId===authoritative.operationId,
  onAttention:settlement('attention'),onExperience:settlement('experience'),
  evaluateMeal:async()=>({manualEquivalentAffection:1}),settleAffection:settlement('relationship')
 });
 t.after(async()=>{
  release.resolve();
  try{await feeding.close();}finally{await rm(root,{recursive:true,force:true});}
 });
 await feeding.initializeRewards({facts:[],cursor:'initial'});
 await feeding.activeScope(original);
 if(holdMeal){
  elapsed=3600000;
  await feeding.ingestUsageFact({canonicalRequestId:'fund',revision:1,basis:'actual',origin:'native-ledger',usage:{total:50000}},{trusted:true});
  await feeding.action('buy',{foodId:'rice',requestId:'provisions'});
  await feeding.action('settings',{autoEat:true});
 }
 return {feeding,economy,entered,release,seen,audits,advance:ms=>{elapsed+=ms;},publish:scope=>{authoritative=scope;}};
}

for(const scenario of ['disable Auto','pause','resume','switch character']){
 test('a committed meal survives '+scenario+' before the worker acknowledgement is delivered',{timeout:10000},async t=>{
  const {feeding,economy,entered,release,seen}=await fixture(t,{holdMeal:true});
  const feedingResult=feeding.action('feed',{foodId:'rice',requestId:'meal'});
  await Promise.race([entered.promise,feedingResult]);
  assert.equal(economy.getMeal('meal')?.attempts,0,'the real worker committed the meal');
  let transition;
  if(scenario==='disable Auto')await feeding.action('settings',{autoEat:false});
  if(scenario==='pause')transition=feeding.pause();
  if(scenario==='resume')transition=feeding.resume();
  if(scenario==='switch character')transition=feeding.activeScope(other);
  release.resolve();
  await Promise.all([feedingResult,transition]);
  if(scenario==='pause'||scenario==='switch character'){
   await feeding.tick({auto:false});
   assert.deepEqual(seen,[]);
   if(scenario==='pause')await feeding.resume();
   else await feeding.activeScope(original);
  }
  await feeding.tick({auto:false});
  assert.equal(economy.getMeal('meal')?.affectionState,'settled');
  const duplicate=await feeding.action('feed',{foodId:'rice',requestId:'meal'});
  await feeding.tick({auto:false});
  assert.equal(duplicate.newlyConsumed,false);
  assert.equal(economy.getMeal('meal')?.attempts,1);
  assert.deepEqual(seen,['attention','experience','relationship'].map(kind=>({kind,eventId:'feeding:meal:'+kind,scope:original})));
 });
}

test('a committed meal stays untouched during prepare and is cancelled when the life is replaced',{timeout:10000},async t=>{
 const {feeding,economy,entered,release,seen,publish}=await fixture(t,{holdMeal:true});
 const feedingResult=feeding.action('feed',{foodId:'rice',requestId:'meal'});
 await Promise.race([entered.promise,feedingResult]);
 assert.equal(economy.getMeal('meal')?.attempts,0);
 const transactionId='new-life';
 const preparing=feeding.lifeBridge.prepare({transactionId,scope:original,target:{scope:replacement,satiety:42}});
 release.resolve();
 await Promise.all([feedingResult,preparing]);
 await assert.rejects(feeding.action('retry-meal',{mealId:'meal'}),{code:'FEEDING_NOT_CURRENT'});
 await feeding.tick({auto:false});
 assert.deepEqual(seen,[]);
 await feeding.lifeBridge.apply({transactionId});
 publish(replacement);
 await feeding.lifeBridge.finalize({transactionId});
 await feeding.activeScope(replacement);
 await feeding.tick({auto:false});
 assert.equal(economy.getMeal('meal')?.affectionState,'cancelled');
 assert.equal(economy.getMeal('meal')?.attempts,0);
 assert.deepEqual(seen,[]);
});


for(const entry of ['activeScope','pause','resume','snapshot','prepare']){
 test('a frozen stale hunger clock does not block '+entry,{timeout:10000},async t=>{
  let code='FEEDING_LIFE_TRANSACTION_PENDING',oldAttempts=0;
  const {feeding,economy,advance,audits}=await fixture(t,{mergeHunger:(writer,scope,part)=>{
   if(scope.characterId===original.characterId){
    oldAttempts++;
    throw Object.assign(Error('injected old hunger failure'),{code});
   }
   return writer.mergeHunger(scope,part);
  }});
  await economy.ensureScope(other);
  advance(3600000);
  await assert.rejects(feeding.activeScope(other),{code:'FEEDING_LIFE_TRANSACTION_PENDING'});
  assert.equal(oldAttempts,1);
  code='FEEDING_STALE_SCOPE';
  const transactionId='prepare-current-life';
  if(entry==='activeScope')await feeding.activeScope(other);
  if(entry==='pause')await feeding.pause();
  if(entry==='resume')await feeding.resume();
  if(entry==='snapshot')assert.equal((await feeding.lifeBridge.snapshot(other)).satiety,100);
  if(entry==='prepare'){
   const prepared=await feeding.lifeBridge.prepare({transactionId,scope:other,target:{scope:other,satiety:70}});
   assert.equal(prepared.state,'prepared');
   await feeding.lifeBridge.recover({transactionId,decision:'rollback'});
  }
  await feeding.resume();
  assert.equal(feeding.view().hunger.satiety,100);
  advance(3600000);
  await feeding.pause();
  assert.equal(economy.getHunger(other,{create:false}).satiety,92);
  assert.equal(economy.getHunger(original,{create:false}).satiety,100);
  assert.equal(oldAttempts,2);
  assert.deepEqual(audits.filter(row=>row.type==='feeding-hunger-discarded'),[
   {type:'feeding-hunger-discarded',scope:original,code:'FEEDING_STALE_SCOPE'}
  ]);
 });
}

test('a temporarily blocked frozen hunger fragment is retried with the original decay',{timeout:10000},async t=>{
 let failNext=true;
 const {feeding,economy,advance,audits}=await fixture(t,{mergeHunger:(writer,scope,part)=>{
  if(failNext){failNext=false;throw Object.assign(Error('life transaction pending'),{code:'FEEDING_LIFE_TRANSACTION_PENDING'});}
  return writer.mergeHunger(scope,part);
 }});
 advance(3600000);
 await assert.rejects(feeding.activeScope(other),{code:'FEEDING_LIFE_TRANSACTION_PENDING'});
 await feeding.resume();
 assert.equal(economy.getHunger(original,{create:false}).satiety,92);
 assert.equal(economy.getHunger(other,{create:false}).satiety,100);
 assert.equal(audits.some(row=>row.type==='feeding-hunger-discarded'),false);
});


const nodeFeeding=new URL('../src/companion-feeding.mjs',import.meta.url).href;
const childScript=`
 import {createFeedingService} from ${JSON.stringify(nodeFeeding)};
 const [dataRoot,target]=process.argv.slice(1);
 let elapsed=0,attempt=0;
 const service=createFeedingService({
  dataRoot,now:()=>Date.UTC(2026,10,15)+elapsed,monotonicNow:()=>elapsed,
  onAttention:async()=>{
   if(++attempt===Number(target)){
    console.log('terminated in attention after attempt '+attempt+' committed');
    process.exit(39);
   }
   throw Error('transient fixture error before recording attention');
  }
 });
 const scope=${JSON.stringify(original)};
 await service.initializeRewards({facts:[],cursor:'initial'});
 await service.activeScope(scope);
 await service.ingestUsageFact({canonicalRequestId:'fund',revision:1,basis:'actual',origin:'native-ledger',usage:{total:50000}},{trusted:true});
 await service.action('buy',{foodId:'rice',requestId:'provisions'});
 elapsed=3600000;
 await service.action('feed',{foodId:'rice',requestId:'meal'});
 while(attempt<Number(target)){
  elapsed+=60001;
  await service.tick({auto:false});
 }
`;

for(const attempts of [1,2,3]){
 test('a committed meal after host interruption at durable attempt '+attempts,{timeout:10000},async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'buddy-r19-meal-interrupted-'));
  let economy,feeding;
  try{
   const child=spawnSync(process.execPath,['--input-type=module','-e',childScript,dataRoot,String(attempts)],{
    timeout:5000,encoding:'utf8',windowsHide:true
   });
   assert.equal(child.status,39,child.error?.message??child.stderr);
   assert.match(child.stdout,new RegExp('after attempt '+attempts+' committed'));
   economy=await createEconomyStore(dataRoot,{now:()=>Date.UTC(2026,10,16)});
   const pending=economy.getMeal('meal');
   assert.equal(pending.affectionState,'pending');
   assert.equal(pending.attempts,attempts);
   assert.equal(pending.retryAt,null);
   const effects=[];
   const settle=kind=>async({eventId})=>{effects.push(kind+':'+eventId);return {eventId};};
   feeding=createFeedingService({
    store:economy,monotonicNow:()=>0,
    onAttention:settle('attention'),onExperience:settle('experience'),
    evaluateMeal:async()=>({manualEquivalentAffection:1}),settleAffection:settle('relationship')
   });
   await feeding.activeScope(original);
   await feeding.tick({auto:false});
   await feeding.tick({auto:false});
   const recovered=economy.getMeal('meal');
   if(attempts===3){
    assert.equal(recovered.affectionState,'pending');
    assert.equal(recovered.attempts,3);
    assert.deepEqual(effects,[]);
   }else{
    assert.equal(recovered.affectionState,'settled');
    assert.equal(recovered.attempts,attempts+1);
    assert.deepEqual(effects,['attention:feeding:meal:attention','experience:feeding:meal:experience','relationship:feeding:meal:relationship']);
   }
  }finally{
   try{if(feeding)await feeding.close();else await economy?.close();}
   finally{await rm(dataRoot,{recursive:true,force:true});}
  }
 });
}
