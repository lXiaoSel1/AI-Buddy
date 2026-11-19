import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {createCardGameService} from '../src/voice-games/game-service.mjs';
import {createCgRewardFacts} from '../src/cg-reward-facts.mjs';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {importVerifiedGameRules} from '../src/voice-games/rule-artifact.mjs';
import * as rules from '../src/voice-games/rules/index.mjs';

const scope={characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
const archivePath=process.env.AI_BUDDY_R18_CARD_ARTIFACT;
const ruleSha='d03d283bdf6c748fcfbdcbcf4eca7f959ca29cbe4ebfbf87f3b53a51d94f16e4';
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'})};
const host=economy=>({gameEconomy:economy,context:()=>({personaId:'persona',characterId:null}),viewState:()=>({characters:[]}),pluginScope:()=>scope});
async function waitFor(predicate,timeoutMs=4500){
 const end=Date.now()+timeoutMs;
 while(!predicate()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(predicate(),true,'expected background initialization before deadline');
}

test('T3 a replaced host with the same economy is not reported ready until reinitialized',async t=>{
 let active,registrations=0,recoveries=0;
 const economy={workerBacked:false,registerRules:async()=>{registrations++;},recover:async()=>{recoveries++;},outbox:()=>[],list:()=>[]};
 const games=createCardGameService({getGame:()=>active,getProvider:()=>provider});
 t.after(()=>games.close());
 await games.registerRuleArtifact({module:rules,sha256:ruleSha});
 const {publishCompanionGameHost}=await import('../src/voice-games/startup.mjs');
 const publish=()=>publishCompanionGameHost({markStorageReady:()=>{},drainRewardFacts:async()=>{},cardGames:games,audit:()=>{}});
 active=host(economy);await publish();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(games.describe().gamesReady,true);
 active=host(economy);
 assert.equal(games.describe().gamesReady,false,'old-host completion must not certify a replacement');
 await publish();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(games.describe().gamesReady,true);
 assert.equal(registrations,2);
 assert.equal(recoveries,2);
});

test('T3 startup drains a pending CG reward through the economy writer before the two-second rule gate',
 {skip:!archivePath},async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r20-game-startup-'));
 let store,journal,games,active,deliver=false;
 t.after(async()=>{try{await games?.close();}finally{try{await journal?.close();}finally{try{await store?.close();}finally{await rm(root,{recursive:true,force:true});}}}});
 store=await createEconomyStore(root,{workerFactory:(url,options)=>new Worker(new URL('./fixtures/economy-worker-fault.mjs',import.meta.url),{
  ...options,workerData:{...options.workerData,registerRulesDelayMs:2000}
 })});
 await store.initializeRewards();
 journal=createCgRewardFacts({dataRoot:root,onRewardFact:fact=>deliver?store.ingestUsageFact(fact,{trusted:true}):{accepted:false,retryable:true},isRewardFactRecorded:fact=>store.isRewardFactRecorded(fact)});
 await journal.initialize();
 journal.registerJob({id:'startup-cg',rewardScope:scope,status:'queued'});
 await journal.recordUsage({cgJobId:'startup-cg',usageReceiptId:'usage-1',usage:{total_tokens:10_000}});
 assert.equal(journal.status().pending,1);
 const artifact=await importVerifiedGameRules({archivePath,archiveSha256:createHash('sha256').update(await readFile(archivePath)).digest('hex'),cacheRoot:join(root,'rules')});
 games=createCardGameService({getGame:()=>active,getProvider:()=>provider});
 await games.registerRuleArtifact(artifact);
 active=host(store.games);deliver=true;
 let storageReady=false;const audits=[];
 const {publishCompanionGameHost}=await import('../src/voice-games/startup.mjs');
 const started=Date.now();
 await publishCompanionGameHost({markStorageReady:()=>{storageReady=true;},drainRewardFacts:()=>journal.drain(),cardGames:games,audit:event=>audits.push(event)});
 const elapsed=Date.now()-started;
 assert.equal(storageReady,true);
 assert.equal(journal.status().pending,0,'actual CG outbox was delivered');
 assert.equal(store.wallet().balance,1,'reward reached the shared economy worker');
 assert.ok(elapsed<1800,'startup publication waited '+elapsed+' ms for the 2-second game gate');
 assert.equal(games.describe().gamesReady,false);
 await waitFor(()=>games.describe().gamesReady);
 assert.deepEqual(audits,[]);
});

test('T3 failed background initialization is audited and next invoke retries',async t=>{
 let active,attempts=0;const audits=[];
 const economy={workerBacked:false,registerRules:async()=>{if(++attempts===1)throw Object.assign(Error('rule registration failed'),{code:'RULE_TEMPORARY'});},recover:async()=>{},outbox:()=>[],list:()=>[],account:()=>({id:'user',balance:0}),};
 const games=createCardGameService({getGame:()=>active,getProvider:()=>provider});
 t.after(()=>games.close());
 await games.registerRuleArtifact({module:rules,sha256:ruleSha});active=host(economy);
 const {publishCompanionGameHost}=await import('../src/voice-games/startup.mjs');
 await publishCompanionGameHost({markStorageReady:()=>{},drainRewardFacts:async()=>{},cardGames:games,audit:event=>audits.push(event)});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(games.describe().gamesReady,false);
 assert.equal(audits.length,1);
 assert.equal(audits[0].code,'RULE_TEMPORARY');
 assert.equal((await games.invoke('games.table.read')).tables.length,0);
 assert.equal(games.describe().gamesReady,true);
 assert.equal(attempts,2);
});
