import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {ModelRouter} from '../src/model-router.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {createEconomyStore} from '../src/companion-economy-store.mjs';
import {createEconomyStore as openWorkerEconomy} from '../src/companion-economy-worker-client.mjs';
import {economyWrites} from '../src/companion-economy-operations.mjs';
import {createCardGameService} from '../src/voice-games/game-service.mjs';
import {importVerifiedGameRules} from '../src/voice-games/rule-artifact.mjs';
import * as rules from '../src/voice-games/rules/index.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createSpeechRuntime} from '../src/voice/speech-runtime.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';

const approvedArchive=process.env.AI_BUDDY_R18_CARD_ARTIFACT;

for(const phase of ['after','before'])test('card action recovers a worker exit '+phase+' its commit with current authorization', {skip:!approvedArchive&&'Set AI_BUDDY_R18_CARD_ARTIFACT to the frozen official card package'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'r18-card-action-crash-'));
 const crash=new Int32Array(new SharedArrayBuffer(8));
 let crashes=0,revoked=false,modelCalls=0,store,service;
 t.after(async()=>{try{await service?.close();}finally{try{await store?.close();}finally{await rm(root,{recursive:true,force:true});}}});
 const workerFactory=(_url,options)=>{
  const worker=new Worker(new URL('./fixtures/economy-worker-fault.mjs',import.meta.url),{...options,workerData:{...options.workerData,crash:crash.buffer}});
  worker.once('exit',code=>{if(code===19){crashes++;if(phase==='before')revoked=true;}});
  return worker;
 };
 store=await openWorkerEconomy(root,{workerFactory});
 const artifact=await importVerifiedGameRules({archivePath:approvedArchive,archiveSha256:createHash('sha256').update(await readFile(approvedArchive)).digest('hex'),cacheRoot:join(root,'game-rules')});
 await store.initializeRewards();
 await store.ingestUsageFact({canonicalRequestId:'card-credit',revision:1,totalTokens:5_000_000},{trusted:true});
 const scope={characterId:'deepseek',personaId:'fixture',lifeId:'fixture-life',operationId:'fixture-operation'};
 const game={gameEconomy:store.games,context:()=>scope,hasCharacter:id=>id===scope.characterId,pluginScope:()=>scope,viewState:()=>({characters:[{id:scope.characterId,name:'Fixture'}]}),gameContext:async()=>({modelBinding:null,character:{name:'Fixture'}}),recordGameFact:async fact=>({recorded:true,eventId:fact.id})};
 const profile={id:'model',kind:'openai',protocol:'openai',baseUrl:'http://fixture.invalid',model:'stub',enabled:true,capabilities:{chat:true}};
 const provider={enabled:true,state:{profiles:[profile]},captureConnection:()=>profile,runCaptured:async(_profile,run)=>run(),async *stream(){
  modelCalls++;yield {type:'text-delta',text:'{"type":"fold","say":"","emotion":"neutral"}'};
 }};
 service=createCardGameService({getGame:()=>game,getProvider:()=>provider});
 await service.registerRuleArtifact(artifact);
 let table=await service.invoke('games.table.create',{commandId:'create',type:'texas',players:[{kind:'user'},{kind:'ai',characterId:scope.characterId}],buyIn:200});
 if(table.actorKind==='user')table=await service.invoke('games.table.action',{tableId:table.tableId,expectedVersion:table.version,commandId:'user-call',action:{type:'call'}});
 assert.equal(table.actorKind,'ai');
 const {tableId,version:expectedVersion}=table,requestId='model-move';
 const action={type:'fold',actorId:'ai-'+scope.characterId};
 const checkSync=()=>{if(revoked)throw Object.assign(Error('Fixture authorization revoked'),{code:'GAME_PERSONA_DENIED'});};
 Atomics.store(crash,1,phase==='after'?2:1);
 Atomics.store(crash,0,Object.keys(economyWrites).indexOf('games.action')+1);
 const [result]=await Promise.allSettled([service.invoke('games.model.request',{tableId,expectedVersion,requestId},{checkSync})]);
 const receipt=store.games.commandReceipt(requestId+':commit',{op:'action',tableId,expectedVersion,action});
 const [following]=await Promise.allSettled([store.settings({autoEat:true})]);
 t.diagnostic(JSON.stringify({phase,crashes,modelCalls,receiptVersion:receipt?.version??null,result:result.status,reason:result.reason?.code,cause:result.reason?.cause?.code,following:following.status,followingReason:following.reason?.code}));
 assert.equal(crashes,1);assert.equal(modelCalls,1);
 if(phase==='after'){
  assert.equal(receipt.version,expectedVersion+1);
  assert.equal(result.status,'fulfilled');
  assert.equal(result.value.version,receipt.version);
  assert.equal(result.value.status,'completed');
  assert.equal(result.value.model.requestId,requestId);
  assert.deepEqual(result.value.history,receipt.history);
 }else{
  assert.equal(receipt,null);
  assert.equal(store.games.table(tableId).version,expectedVersion);
  assert.equal(result.status,'rejected');
  assert.equal(result.reason.code,'GAME_PERSONA_DENIED');
 }
 assert.equal(following.status,'fulfilled');
 assert.equal(store.settings().autoEat,true);
});

test('actual Texas chat commit reaches host, shared speech runtime and exact playback receipt without a second model call',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r5-card-chain-')),events=[],spoken=[];let calls=0,voiceHost;
 const provider=new ModelRouter({dataRoot:root,codex:{defaultModel:'fixture',enabled:false,setEnabled(v){this.enabled=v;},listModels:()=>[],close(){}},crypto:{isEncryptionAvailable:()=>false},fetchImpl:async()=>{
  calls++;const body='data: '+JSON.stringify({choices:[{delta:{content:'这手我想等一个好机会。'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';return new Response(body,{headers:{'content-type':'text/event-stream'}});
 }});
 await provider.ready;const connection=await provider.save({kind:'custom',name:'Local fake HTTP only',baseUrl:'http://127.0.0.1:1',model:'fixture'});await provider.activate(connection.id);provider.setEnabled(true);
 const archivePath=approvedArchive,feedingStore=archivePath?undefined:createEconomyStore(root);
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false,feedingStore}});
 await game.r95.feeding.ingestUsageFact({canonicalRequestId:'synthetic-seed',units:10000000,revision:1},{trusted:true});
 const service=createCardGameService({getGame:()=>game,getProvider:()=>provider,onCommittedSpeech:fact=>voiceHost.cardEvent(fact)});
 const bytes=await Promise.all(['common','doudizhu','texas','index'].map(name=>readFile(new URL('../src/voice-games/rules/'+name+'.mjs',import.meta.url))));
 const artifact=archivePath
  ?await importVerifiedGameRules({archivePath,archiveSha256:createHash('sha256').update(await readFile(archivePath)).digest('hex'),cacheRoot:join(root,'game-rules')})
  :{module:rules,sha256:createHash('sha256').update(bytes.join('')).digest('hex')};
 await service.registerRuleArtifact(artifact);
 const settings=createVoiceSettings();await settings.update({enabled:true});
 const local={async *speak(request){spoken.push(request);yield {type:'pcm',pcm:new Uint8Array([0,0,1,0]),sampleRate:24000};},stopEngine:async()=>{},cancelCurrent:async()=>{},cancelCapture:async()=>{},close:async()=>{}};
 const runtime=createSpeechRuntime({local,cloud:{stopEngine:async()=>{},close:async()=>{}}});
 voiceHost=createVoiceHost({dataRoot:root,build:'unused',getGame:()=>game,getPlatform:()=>({cardGames:service,voicePackageStatus:()=>[{id:'ai-buddy.voice-breeze',installed:true,enabled:true,usable:true,trusted:true}],resolveVoicePackage:async()=>({assertCurrent(){}})}),send:event=>events.push(event),components:{runtime,local,cloud:{},settings,profiles:{current:async({characterId,engine})=>({id:'voice-'+characterId,version:1,characterId,engine})},credentials:{},assets:{close:async()=>{}},supervisor:{close:async()=>{}}}});
 t.after(async()=>{await voiceHost.close();await service.close();await game.close();provider.close();await rm(root,{recursive:true,force:true});});
 const lobby=await service.invoke('games.table.read'),table=await service.invoke('games.table.create',{commandId:'chat-table',type:'texas',players:[{kind:'user'},{characterId:lobby.charactersAvailable[0].id}],buyIn:200});
 const result=await service.invoke('games.chat.send',{tableId:table.tableId,submissionId:'chat-once',text:'你怎么看这手？'});assert.equal(result.assistant.status,'completed');
 for(let i=0;i<150&&!events.some(row=>row.type==='audio'&&row.phase==='end');i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(spoken.length,1);assert.equal(spoken[0].text,result.assistant.text);assert.equal(spoken[0].characterId,result.assistant.characterId);assert.equal(calls,1);
 const envelope=events.find(row=>row.type==='segment'&&row.state==='queued').envelope;assert.equal(envelope.channel,'card-table');assert.equal(envelope.tableId,table.tableId);
 for(const status of ['textDisplayed','audioStarted','audioCompleted'])assert.equal((await voiceHost.action('receipt',{envelope,status})).accepted,true);
 assert.equal(voiceHost.snapshot().cardSpeechBusy,false);
 await service.invoke('games.chat.send',{tableId:table.tableId,submissionId:'chat-once',text:'你怎么看这手？'});await new Promise(r=>setTimeout(r,20));
 assert.equal(spoken.length,1);assert.equal(calls,1);
});
