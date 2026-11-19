import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createEconomyStore} from '../src/companion-economy-store.mjs';

const scope={characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
const now=()=>1_700_000_000_000;
async function withStore(run){
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-hunger-'));
 let store;
 try{store=createEconomyStore(root,{now});await run(store);}
 finally{await store?.close();await rm(root,{recursive:true,force:true});}
}

test('consume merges the accrued hunger before checking fullness and rolls it back on failure',()=>withStore(store=>{
 store.ensureScope(scope);
 const meal={scope,foodId:'rice',requestId:'meal',hunger:{requestId:'accrual',decay:20}};
 assert.throws(()=>store.consume(meal),{code:'FOOD_OUT_OF_STOCK'});
 assert.equal(store.getHunger(scope).satiety,100);
 store.initializeRewards();
 store.ingestUsageFact({canonicalRequestId:'fund',revision:1,basis:'actual',units:1_000_000,scope},{trusted:true});
 store.purchase({scope,foodId:'rice',requestId:'buy'});
 const first=store.consume(meal);
 const replay=store.consume(meal);
 assert.equal(first.meal.before,80);
 assert.equal(first.newlyConsumed,true);
 assert.equal(replay.newlyConsumed,false);
 assert.equal(store.view().inventory.rice,0);
 const lateRetry=store.consume({...meal,hunger:{requestId:'later-accrual',decay:21}});
 assert.equal(lateRetry.hungerRequestId,'accrual');
 assert.equal(store.getHunger(scope).satiety,first.satiety);
}));
