import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {createCardGameService} from '../src/voice-games/game-service.mjs';
import {importVerifiedGameRules} from '../src/voice-games/rule-artifact.mjs';
import {publishCompanionGameHost} from '../src/voice-games/startup.mjs';
import * as rules from '../src/voice-games/rules/index.mjs';

const ruleSha='d03d283bdf6c748fcfbdcbcf4eca7f959ca29cbe4ebfbf87f3b53a51d94f16e4';
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'})};
const host=economy=>({gameEconomy:economy,context:()=>({personaId:'persona',characterId:null}),viewState:()=>({characters:[]})});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const archivePath=process.env.AI_BUDDY_R18_CARD_ARTIFACT;
const scope={characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
async function waitFor(check){const until=Date.now()+3000;while(!check()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(check(),true,'worker rules gate was not entered');}

test('r21 superseded background host initialization does not audit a failure',async t=>{
 let active,release,started=false;const audits=[];
 const economy={workerBacked:false,registerRules:()=>{started=true;return new Promise(resolve=>{release=resolve;});},recover:async()=>{},outbox:()=>[],list:()=>[],account:()=>({id:'user',balance:0})};
 const games=createCardGameService({getGame:()=>active,getProvider:()=>provider});
 t.after(async()=>{release?.();await games.close();});
 await games.registerRuleArtifact({module:rules,sha256:ruleSha});
 active=host(economy);
 await publishCompanionGameHost({markStorageReady:()=>{},drainRewardFacts:async()=>{},cardGames:games,audit:event=>audits.push(event)});
 await turn();assert.equal(started,true);
 active=host(economy);release();await turn();await turn();
 assert.deepEqual(audits,[]);
 assert.equal(games.describe().gamesReady,false);
});

test('r21 close does not wait for abandoned background rule registration',async t=>{
 let active,release,started=false;
 const economy={workerBacked:false,registerRules:()=>{started=true;return new Promise(resolve=>{release=resolve;});},recover:async()=>{},outbox:()=>[],list:()=>[]};
 const games=createCardGameService({getGame:()=>active,getProvider:()=>provider});
 t.after(async()=>{release?.();await games.close();});
 await games.registerRuleArtifact({module:rules,sha256:ruleSha});active=host(economy);
 await publishCompanionGameHost({markStorageReady:()=>{},drainRewardFacts:async()=>{},cardGames:games,audit:()=>{}});
 await turn();assert.equal(started,true);
 const timer=setTimeout(()=>release(),450),at=Date.now();
 try{await games.close();}finally{clearTimeout(timer);release();}
 assert.ok(Date.now()-at<250,'close waited for background rules registration');
 assert.equal(games.describe().gamesReady,false);
});

test('r21 real worker close cancels rules registration and drains the committed write',
 {skip:!archivePath},async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r21-close-'));
 const gate=new Int32Array(new SharedArrayBuffer(12));let store,games,active;
 t.after(async()=>{Atomics.store(gate,2,1);Atomics.notify(gate,2);try{await games?.close();}finally{try{await store?.close();}finally{await rm(root,{recursive:true,force:true});}}});
 const artifact=await importVerifiedGameRules({archivePath,archiveSha256:createHash('sha256').update(await readFile(archivePath)).digest('hex'),cacheRoot:join(root,'rules')});
 store=await createEconomyStore(root,{workerFactory:(url,options)=>new Worker(new URL('./fixtures/economy-worker-r21-register-gate.mjs',import.meta.url),{
  ...options,workerData:{...options.workerData,registerGate:gate.buffer,registerGatePath:artifact.path}
 })});
 await store.initializeRewards();
 games=createCardGameService({getGame:()=>active,getProvider:()=>provider});
 await games.registerRuleArtifact(artifact);active=host(store.games);await games.hostReady();
 active=host(store.games);
 const audits=[];
 await publishCompanionGameHost({markStorageReady:()=>{},drainRewardFacts:async()=>{},cardGames:games,audit:event=>audits.push(event)});
 await waitFor(()=>Atomics.load(gate,0)===1);
 const write=store.ingestUsageFact({canonicalRequestId:'r21-committed-write',totalTokens:10_000,scope},{trusted:true});
 const releaseTimer=setTimeout(()=>{Atomics.store(gate,2,1);Atomics.notify(gate,2);},450);
 const at=Date.now();await games.close();clearTimeout(releaseTimer);
 assert.ok(Date.now()-at<250,'real close waited for held rule registration');
 await write;await store.close();
 assert.deepEqual(audits,[]);
 assert.equal(games.describe().gamesReady,false);
 Atomics.store(gate,2,1);Atomics.notify(gate,2);
 store=await createEconomyStore(root);
 assert.equal(store.wallet().balance,1,'the already queued reward write survived close');
});
