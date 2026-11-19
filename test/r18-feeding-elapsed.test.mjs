import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEconomyStore} from '../src/companion-economy-store.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';

const scope=characterId=>({characterId,personaId:'default',lifeId:'life',operationId:'op'});
function setSatiety(store,which,satiety){
 store.ensureScope(which);
 store.prepareLife({transactionId:'seed-'+which.characterId,scope:which,target:{scope:which,satiety}});
 store.applyLife({transactionId:'seed-'+which.characterId});
 store.finalizeLife({transactionId:'seed-'+which.characterId});
}

test('two hours of feeding show the previous per-second satiety with bounded hunger writes',async t=>{
 const root=mkdtempSync(join(tmpdir(),'r18-feeding-elapsed-'));
 const first=scope('deepseek'),second=scope('gpt');let time=0;
 const now=()=>Date.UTC(2026,9,25)+time;
 const old=createEconomyStore(join(root,'old'),{now});
 const store=createEconomyStore(join(root,'new'),{now});
 let writes=0;
 const economy=new Proxy(store,{get(target,property){
  const method=target[property];
  if(['settleHunger','mergeHunger','consume','purchaseAndConsumeRice'].includes(property)&&typeof method==='function')return (...args)=>{writes++;return method(...args);};
  return method;
 }});
 const feeding=createFeedingService({store:economy,now,monotonicNow:()=>time});
 t.after(async()=>{try{await feeding.close();}finally{await old.close();rmSync(root,{recursive:true,force:true});}});
 for(const s of [old,store]){
  setSatiety(s,first,25);
  setSatiety(s,second,40);
  s.initializeRewards({facts:[]});
  s.ingestUsageFact({canonicalRequestId:'seed',totalTokens:100000,revision:1},{trusted:true});
  s.purchase({scope:first,foodId:'biscuit',requestId:'stock'});
 }
 await feeding.activeScope(first);
 let current=first,sleeping=false,paused=false,maximumError=0;
 for(let i=1;i<=7200;i++){
  time=i*1000;
  if(!paused)old.settleHunger(current,{elapsedMs:1000,sleeping});
  if(i===600||i===1200)sleeping=!sleeping;
  await feeding.tick({sleeping,auto:false});
  if(i===3000){
   const patch={autoEat:true,autoBuyRice:true,allowedFoods:['rice']};
   old.settings(patch);await feeding.action('settings',patch);
   assert.ok(old.getHunger(first).satiety<=20);
   const auto=await feeding.action('auto');
   assert.equal(auto.state,'completed');
   assert.equal(auto.step,2);
   for(let j=0;j<2;j++)old.purchaseAndConsumeRice({scope:first,requestId:'old-auto-'+j});
   old.settings({autoEat:false});await feeding.action('settings',{autoEat:false});
  }
  if(i===3300){
   const previous=old.consume({scope:first,foodId:'biscuit',requestId:'manual'});
   const meal=await feeding.action('feed',{foodId:'biscuit',requestId:'manual'});
   assert.ok(Math.abs(meal.meal.before-previous.meal.before)<=1e-9);
   assert.ok(Math.abs(meal.meal.after-previous.meal.after)<=1e-9);
  }
  if(i===3400||i===4300){
   current=i===3400?second:first;
   await feeding.activeScope(current,{sleeping});
  }
  if(i===5000){paused=true;await feeding.pause('suspend');}
  if(i===5500){paused=false;await feeding.resume({sleeping});}
  if(i===5999){
   const snapshot=await feeding.lifeBridge.snapshot(current);
   assert.ok(Math.abs(snapshot.satiety-old.getHunger(current).satiety)<=1e-9);
  }
  maximumError=Math.max(maximumError,Math.abs(feeding.view().hunger.satiety-old.getHunger(current).satiety));
 }
 await feeding.close();
 assert.ok(maximumError<=1e-9,`maximum satiety difference: ${maximumError}`);
 const maximumWrites=24+3+2+1+1+1;
 assert.ok(writes<=maximumWrites,`saw ${writes} hunger writes; allowed at most ${maximumWrites}`);
 t.diagnostic(`maximum satiety difference ${maximumError}; hunger writes ${writes} of ${maximumWrites} allowed`);
});

test('hunger accrued after an admitted commit remains visible and is flushed once on pause',async t=>{
 const root=mkdtempSync(join(tmpdir(),'r18-feeding-ack-')),which=scope('deepseek');
 let time=0;
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const now=()=>Date.UTC(2026,9,25)+time;
 const store=createEconomyStore(root,{now});
 let commits=0;
 const economy=new Proxy(store,{get(target,property){
  if(property!=='mergeHunger')return target[property];
  return async(...args)=>{
   const receipt=target.mergeHunger(...args);
   if(++commits===1){entered.resolve();await release.promise;}
   return receipt;
  };
 }});
 const feeding=createFeedingService({store:economy,now,monotonicNow:()=>time});
 t.after(async()=>{release.resolve();try{await feeding.close();}finally{rmSync(root,{recursive:true,force:true});}});
 await feeding.activeScope(which);
 time=300000;
 const first=feeding.tick({auto:false});
 await entered.promise;
 time+=1000;
 const second=feeding.tick({auto:false});
 const expected=100-(301000/3600000)*8;
 assert.ok(Math.abs(feeding.view().hunger.satiety-expected)<=1e-9);
 const pause=feeding.pause();
 assert.equal(feeding.view().paused,true);
 time+=10000;
 release.resolve();
 await Promise.all([first,second,pause]);
 assert.ok(Math.abs(store.getHunger(which,{create:false}).satiety-expected)<=1e-9);
 assert.equal(commits,2);
});
