import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionService} from '../src/companion-service.mjs';
import {companionFixture,syntheticEngine} from './support/audit-harness.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(read,label){for(let i=0;i<500;i++){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(label);}
test('Astra GROUP-01: manual retry remains stoppable across deferred failed-attempt disk cleanup',async t=>{
 let state=await companionFixture(),tail=Promise.resolve(),armed=false,groupId,attempts=0,retrySignal;
 const entered=deferred(),cleanup=deferred(),providerStarted=deferred(),providerRelease=deferred();
 // Match openCompanionStore: clone -> callback -> await disk -> publish state.
 const store={get state(){return state;},snapshot:()=>structuredClone(state),mutate(fn){const job=tail.then(async()=>{const next=structuredClone(state),result=await fn(next);if(armed&&state.groups[groupId]?.pending&&!next.groups[groupId]?.pending){armed=false;entered.resolve();await cleanup.promise;}state=next;return result;});tail=job.catch(()=>{});return job;},flush:()=>tail};
 const dataRoot=mkdtempSync(join(tmpdir(),'ggc1-group-cleanup-race-'));
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),resolveContextCapacity:()=>({tokens:272000}),runTurn:async fn=>fn(),async *stream(request){if(request.purpose!=='group-chat'){yield {type:'text-delta',text:'{"changed":false}'};return;}attempts++;if(attempts===1)throw Error('synthetic first manual failure');retrySignal=request.signal;providerStarted.resolve();await Promise.race([providerRelease.promise,new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}))]);if(request.signal.aborted)throw Error('synthetic retry aborted');yield {type:'text-delta',text:'{"text":"synthetic retry","affection":0}'};}};
 const {engine}=syntheticEngine({getStore:()=>store}),service=await createCompanionService({store,engine,provider,dataRoot});
 t.after(async()=>{cleanup.resolve();providerRelease.resolve();await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 const group=(await service.action('companion-group-save',{name:'Synthetic manual cleanup',memberIds:['claude','gpt'],mode:'manual'})).group;groupId=group.id;await service.action('companion-group-select',{id:groupId});armed=true;
 await service.action('companion-group-send',{id:groupId,text:'synthetic manual input',forceCharacterId:'claude'});await entered.promise;
 const publishedBeforeCleanup=service.viewState().groupRuntime.status==='failed';
 if(publishedBeforeCleanup){const retry=service.action('companion-group-retry',{id:groupId});await until(()=>service.viewState().groupRuntime.status==='waiting-model','retry did not install its controller before old cleanup');cleanup.resolve();await retry;}
 else{const ignoredRetry=service.action('companion-group-retry',{id:groupId});cleanup.resolve();await ignoredRetry;await until(()=>service.viewState().groupRuntime.status==='failed','failure was not published after cleanup');await service.action('companion-group-retry',{id:groupId});}
 await providerStarted.promise;await service.action('companion-group-stop',{id:groupId});
 assert.equal(retrySignal.aborted,true,'old failure finally must not clear the live retry AbortController');assert.equal(attempts,2);assert.equal(publishedBeforeCleanup,false,'retryable failure must only be published after old persistence cleanup');
});
