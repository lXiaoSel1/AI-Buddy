// Regression for actual native ACK failure: scope identity is independent of property order.
// Public host entry points and actual isolated economy storage; no external model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../',import.meta.url));
const {createCompanionR95}=await import(pathToFileURL(join(source,'src/companion-r95.mjs')));
const {companionFixture,memoryStore}=await import(pathToFileURL(join(source,'test/support/audit-harness.mjs')));
const reordered=s=>({personaId:s.personaId,characterId:s.characterId,conversationId:s.conversationId,lifeId:s.lifeId,operationId:s.operationId,channel:s.channel});

async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'af1-scope-')),store=memoryStore(await companionFixture()),calls=[];
 const provider={enabled:true,captureConnection:()=>({id:'mock',model:'mock',kind:'custom',contextTokens:128000}),runCaptured:(_profile,fn)=>fn(),resolveSearchCapability:()=>({supported:false}),
  async *stream(request){calls.push(request);yield {type:'text-delta',text:'{"speak":true,"mode":"awake","text":"Scope identity regression fixture"}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionR95({store,dataRoot:root,provider,now:()=>100000,
  getContext:()=>({characterId:store.state.activeCharacterId,personaId:store.state.activePersonaId,conversationId:store.state.activeConversationId}),
  getRuntimeState:()=>({sleepPhase:'awake',sleepIntentVersion:1,canPresent:true}),memory:{context:async()=>({text:''})},delta:()=>{},audit:()=>{}});
 t.after(async()=>{await service.close();await store.flush();rmSync(root,{recursive:true,force:true});});
 await service.action('social-settings',{proactive:true});return {store,service,calls};
}
async function pendingLine(f,scope){
 await f.service.userInteraction({scope,eventId:'mock-user',kind:'chat',text:'Explicit isolated Mock user interaction'});
 assert.equal((await f.service.proactive.tick()).delivered,true);
 const line=f.service.view().lines[0];assert(line);assert.equal(line.status,'awaiting-presentation');return line;
}

for(const [label,normalize] of [
 ['reordered six identity fields',reordered],
 ['APP optional transport fields explicitly null',s=>({...reordered(s),actorId:null,accountBindingId:null,bindingGeneration:null})],
 ['APP optional transport fields explicitly undefined',s=>({...reordered(s),actorId:undefined,accountBindingId:undefined,bindingGeneration:undefined})],
])test('AF1 scope ACK accepts '+label+' without changing identity',async t=>{
 const f=await setup(t),current=f.service.activeScope(),input=normalize(current),line=await pendingLine(f,input);
 for(const key of ['characterId','personaId','lifeId','operationId','channel','conversationId'])assert.equal(line.scope[key],current[key]);
 assert.deepEqual(await f.service.action('speech-presented',{messageId:line.messageId}),{ok:true});
 assert.equal(f.service.view().lines[0].status,'presented');assert.equal(f.store.state.lives[current.characterId].r95.proactive.candidates[line.candidateId].status,'presented');
 assert.equal(f.service.presentation.snapshot(current).presenting,true,'Presentation remains unread until explicit read');
 await f.service.action('speech-read',{messageId:line.messageId});assert.equal(f.service.presentation.snapshot(current).presenting,false);assert.equal(f.calls.length,1);
});

for(const [label,normalize] of [
 ['reordered identity',reordered],
 ['optional null APP metadata',s=>({...reordered(s),actorId:null,accountBindingId:null,bindingGeneration:null})],
])test('AF1 input guard accepts '+label,async t=>{
 const f=await setup(t),scope=f.service.activeScope();
 assert.deepEqual(await f.service.action('input',{scope:normalize(scope),active:true}),{ok:true});
 assert.equal(f.service.presentation.snapshot(scope).typing,true);
 await f.service.action('input',{scope:normalize(scope),active:false});assert.equal(f.service.presentation.snapshot(scope).typing,false);assert.equal(f.calls.length,0);
});

for(const key of ['characterId','personaId','lifeId','operationId','channel','conversationId'])test('AF1 scope ACK rejects actual '+key+' change without settling candidate',async t=>{
 const f=await setup(t),scope=f.service.activeScope(),line=await pendingLine(f,scope);
 await f.store.mutate(state=>{state.lives[scope.characterId].r95.lines[0].scope[key]='different-'+key;});
 await assert.rejects(f.service.action('speech-presented',{messageId:line.messageId}),/范围|身份|人生/);
 const persisted=f.store.state.lives[scope.characterId].r95;
 assert.equal(persisted.lines[0].status,'awaiting-presentation');assert.equal(persisted.proactive.candidates[line.candidateId].status,'presenting');
 assert.equal(f.service.presentation.snapshot(scope).presenting,true);assert.equal(f.calls.length,1);
});

for(const key of ['characterId','personaId','lifeId','operationId','channel','conversationId'])test('AF1 input guard rejects actual '+key+' change',async t=>{
 const f=await setup(t),scope=f.service.activeScope();
 await assert.rejects(f.service.action('input',{scope:{...scope,[key]:'different-'+key},active:true}),/范围|身份|人生/);
 assert.equal(f.service.presentation.snapshot(scope).typing,false);assert.equal(f.calls.length,0);
});

test('AF1 APP scope must not treat omitted channel as app-private',async t=>{
 const f=await setup(t),scope=f.service.activeScope(),line=await pendingLine(f,scope);
 await f.store.mutate(state=>{delete state.lives[scope.characterId].r95.lines[0].scope.channel;});
 await assert.rejects(f.service.action('speech-presented',{messageId:line.messageId}),/范围/);
 const noChannel={...scope};delete noChannel.channel;
 await assert.rejects(f.service.action('input',{scope:noChannel,active:true}),/范围/);
 assert.equal(f.service.presentation.snapshot(scope).typing,false);
});
