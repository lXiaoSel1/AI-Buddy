import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createEconomyStore} from '../src/companion-economy-store.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {createPluginPlatform} from '../src/plugin-platform.mjs';
import {importVerifiedGameRules} from '../src/voice-games/rule-artifact.mjs';
import * as rules from '../src/voice-games/rules/index.mjs';

const archivePath=process.env.AI_BUDDY_R18_CARD_ARTIFACT;
const rulesSha='d03d283bdf6c748fcfbdcbcf4eca7f959ca29cbe4ebfbf87f3b53a51d94f16e4';
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[],listModels:()=>[]};

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'buddy-r19-card-startup-')),dataRoot=join(root,'local','data-v003');
 let game,store,plugins;
 t.after(async()=>{try{await plugins?.close();}finally{try{await game?.close();}finally{await rm(root,{recursive:true,force:true});}}});
 plugins=await createPluginPlatform({root,build:join(root,'build'),dataRoot,getGame:()=>game,getProvider:()=>provider,
  legacyManager:{snapshot:()=>({appVersion:'2.0.17',service:{state:'ready',usable:true},installed:{},packages:[]}),action:async()=>({}),close:async()=>{}},
  BrowserWindow:class {constructor(){throw Error('A native window is outside the startup fixture');}},
  session:{fromPartition(){throw Error('A browser session is outside the startup fixture');}}
 });
 const artifact=archivePath?await importVerifiedGameRules({
  archivePath,archiveSha256:createHash('sha256').update(await readFile(archivePath)).digest('hex'),cacheRoot:join(root,'rules')
 }):{module:rules,sha256:rulesSha};
 return {facade:plugins.voiceGamesFacade,games:plugins.cardGames,artifact,async open(){
  if(archivePath)game=await createGalgame({dataRoot,provider,model:'fixture',automaticWorkAllowed:()=>false});
  else{
   store=createEconomyStore(dataRoot);
   game={gameEconomy:store.games,close:()=>store.close()};
  }
  return game.gameEconomy;
 }};
}

test('S6 rules registered before the game host report ready after the main startup notification',async t=>{
 const {games,facade,artifact,open}=await fixture(t);
 await facade.registerRuleArtifact(artifact);
 assert.equal(facade.describe().gamesReady,false);
 const economy=await open();
 await economy.request({id:'pending-model',fingerprint:'fixture',state:'queued'});
 assert.equal(facade.describe().gamesReady,false);
 assert.equal(economy.request('pending-model').state,'queued','describe must not initialize the host');
 await Promise.all([games.hostReady?.(),games.hostReady?.()]);
 assert.equal(facade.describe().gamesReady,true,'the card status becomes ready when startup finishes');
 assert.equal(economy.request('pending-model').state,'interrupted');
 assert.equal(economy.request('pending-model').autoRetry,false);
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
 const platformAt=main.indexOf('plugins=await createPluginPlatform('),hostAt=main.indexOf('game=await createGalgame(');
 const publishAt=main.indexOf('await publishCompanionGameHost(');
 assert.ok(platformAt>=0&&hostAt>platformAt&&publishAt>hostAt,'main publishes the plugin host after assignment of the ready host');
});

test('S6 an available host without registered rules waits for normal rule registration',async t=>{
 const {games,facade,artifact,open}=await fixture(t);
 await open();
 await games.hostReady?.();
 assert.equal(facade.describe().gamesReady,false);
 await facade.registerRuleArtifact(artifact);
 assert.equal(facade.describe().gamesReady,true);
});
