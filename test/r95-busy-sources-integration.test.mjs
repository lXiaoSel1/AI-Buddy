import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {companionFixture,memoryStore,gate} from './support/audit-harness.mjs';

async function fixture(t){
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-busy-sources-')),clock={at:1700000000000},store=memoryStore(await companionFixture({now:clock.at})),calls=[],speeches=[],audits=[];
 let context={characterId:'claude',personaId:'default',conversationId:'conversation'},reply=(options,input)=>options.purpose==='mood'?{changed:false,busyAnswer:'finished'}:{speak:true,text:'你忙完了吗？',mode:'awake',motive:'busy-check'};
 const profile={id:'fixture',model:'fixture-model',kind:'custom',contextTokens:272000,enabled:true},provider={enabled:true,currentSelection:()=>({provider:profile.id,model:profile.model}),captureConnection:()=>structuredClone(profile),runCaptured:(_profile,fn)=>fn(),resolveSearchCapability:()=>({supported:false}),
  async *stream(options){const input=JSON.parse(options.messages.at(-1).content[0].text);calls.push({options,input});const result=await reply(options,input);yield{type:'text-delta',text:JSON.stringify(result)};yield{type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionR95({store,dataRoot,provider,now:()=>clock.at,getContext:()=>context,memory:{context:async()=>({text:''})},getRuntimeState:()=>({sleepPhase:'awake',sleepIntentVersion:1,canPresent:true}),onSpeech:value=>speeches.push(value),delta:()=>{},audit:value=>audits.push(value)});
 t.after(async()=>{await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 return {store,service,calls,speeches,audits,advance:()=>++clock.at,scope:()=>service.activeScope(),setReply:fn=>reply=fn,
  async switchContext({personaId='default',conversationId='conversation'}={}){await store.mutate(state=>{if(!state.personas[personaId])state.personas[personaId]={...structuredClone(state.personas.default),id:personaId,name:personaId};});context={characterId:'claude',personaId,conversationId};return service.activeScope();}};
}

async function queuedBusyQuestion(f){
 const scope=f.scope();await f.service.action('social-settings',{proactive:true});await f.service.action('availability-set',{busyForMs:3600000});
 await f.service.userInteraction({scope,eventId:'real-busy-conversation',kind:'chat',text:'我现在还在忙。'});
 const candidate=f.service.proactive.view({scope}).candidates.find(row=>row.eventIds.includes('real-busy-conversation'));
 assert.ok(candidate);const result=await f.service.proactive.tick({candidateId:candidate.id});assert.equal(result.delivered,true);assert.equal(f.speeches.length,1);
 const line=f.service.view().lines.find(row=>row.candidateId===candidate.id);assert.equal(line.status,'awaiting-presentation');assert.equal(line.motive,'busy-check');return {scope,line};
}

test('busy-check is not a question until its real speech presentation ACK; duplicate ACK does not create another question',async t=>{
 const f=await fixture(t),{scope,line}=await queuedBusyQuestion(f);assert.equal(f.service.attention.view({scope}).busyQuestion,null);assert.equal(f.service.attention.view({scope}).busy,true);
 f.advance();await f.service.action('speech-presented',{messageId:line.messageId});const question=f.service.attention.view({scope}).busyQuestion;
 assert.equal(question.status,'awaiting-answer');assert.equal(question.eventId,line.candidateId);assert.equal(question.text,line.text);assert.equal(question.personaId,scope.personaId);assert.equal(question.conversationId,scope.conversationId);
 f.advance();await f.service.action('speech-presented',{messageId:line.messageId});assert.deepEqual(f.service.attention.view({scope}).busyQuestion,question);assert.equal(f.service.view().lines.find(row=>row.messageId===line.messageId).status,'presented');
});

test('same-scope real chat can answer the acknowledged busy question through mood, clearing busy while preserving DND',async t=>{
 const f=await fixture(t),{scope,line}=await queuedBusyQuestion(f);await f.service.action('speech-presented',{messageId:line.messageId});await f.service.action('speech-read',{messageId:line.messageId});await f.service.action('availability-set',{doNotDisturb:true});
 f.advance();await f.service.userInteraction({scope,eventId:'finished-by-real-chat',kind:'chat',text:'我忙完了，现在有时间。'});await f.service.mood.evaluate({scope,eventIds:['finished-by-real-chat']});
 const current=f.service.attention.view({scope});assert.equal(current.busy,false);assert.equal(current.doNotDisturb,true);assert.equal(current.busyQuestion.status,'answered');assert.equal(current.busyQuestion.answer,'finished');
 const request=f.calls.findLast(row=>row.options.purpose==='mood');assert.equal(request.input.events[0].kind,'chat');assert.equal(request.input.events[0].text,'我忙完了，现在有时间。');assert.equal(request.input.availability.busyQuestion.status,'awaiting-answer');assert.deepEqual(request.options.scope,scope);assert.ok(request.options.activityOriginId);
});

test('touch and newly observed tokens cannot infer that the owner has finished, even if mood suggests finished',async t=>{
 const f=await fixture(t),{scope,line}=await queuedBusyQuestion(f);await f.service.action('speech-presented',{messageId:line.messageId});const before=f.service.attention.view({scope});
 f.service.origins.recordUsage({requestKey:'actual-work-request',totalTokens:2400,live:true});assert.equal(f.service.attention.view({scope}).lastAttentionAt,before.lastAttentionAt);assert.equal(f.service.attention.view({scope}).busy,true);
 f.advance();await f.service.userInteraction({scope,eventId:'actual-touch',kind:'touch',text:'我忙完了'});await f.service.mood.evaluate({scope,eventIds:['actual-touch']});
 const after=f.service.attention.view({scope});assert.equal(after.busy,true);assert.equal(after.busyQuestion.status,'awaiting-answer');assert.equal(after.busyQuestion.eventId,line.candidateId);assert.equal(after.busyQuestion.answer,undefined);
});

for(const target of [{conversationId:'other-private-conversation'},{personaId:'other-persona',conversationId:'other-persona-conversation'}])test(`another ${target.personaId?'Persona':'conversation'} cannot answer or view the original busy question`,async t=>{
 const f=await fixture(t),{scope:original,line}=await queuedBusyQuestion(f);await f.service.action('speech-presented',{messageId:line.messageId});const scope=await f.switchContext(target);
 assert.equal(f.service.attention.view({scope}).busyQuestion,null);assert.equal(f.service.view().lines.length,0);await assert.rejects(f.service.action('speech-presented',{messageId:line.messageId}),/范围/);await assert.rejects(f.service.action('busy-answer',{eventId:line.candidateId,answer:'finished'}),/身份/);
 f.advance();await f.service.userInteraction({scope,eventId:'another-context-chat',kind:'chat',text:'我忙完了。'});await f.service.mood.evaluate({scope,eventIds:['another-context-chat']});
 assert.equal(f.service.attention.view({scope}).busy,true);assert.equal(f.service.attention.view({scope:original}).busyQuestion.status,'awaiting-answer');
});

test('mood sources enumerate only actual current-scope references, never arbitrary stored event IDs',async t=>{
 const f=await fixture(t),scope=f.scope();f.setReply((options,input)=>options.purpose==='mood'?{overall:{label:'安心',summary:'依据真实对话',intensity:.3,recoveryHalfLifeMs:60000,eventIds:[input.events[0].eventId]},feelings:[]}:{speak:false});
 await f.service.userInteraction({scope,eventId:'referenced-original',kind:'chat',text:'这是已经实际收到的原文。'});await f.service.userInteraction({scope,eventId:'not-referenced-original',kind:'chat',text:'同范围但未被当前心情引用的原文。'});await f.service.mood.evaluate({scope,eventIds:['referenced-original']});
 const calls=f.calls.length,all=await f.service.action('mood-sources');assert.deepEqual(all.sources.map(row=>row.eventId),['referenced-original']);assert.equal(all.sources[0].text,'这是已经实际收到的原文。');assert.equal(all.sources[0].sourceKind,'user-interaction');assert.deepEqual(all.sources[0].scope,scope);assert.equal(f.calls.length,calls,'source viewing must not invoke a model');
 for(const eventIds of [['not-referenced-original'],['missing'],['__proto__'],['referenced-original','not-referenced-original'],[{}]])await assert.rejects(f.service.action('mood-sources',{eventIds}),/当前可查看范围/);
 assert.deepEqual((await f.service.action('mood-sources',{eventIds:[]})).sources,[]);
});

for(const target of [{conversationId:'other-source-conversation'},{personaId:'source-other-persona',conversationId:'source-other-persona-conversation'}])test(`mood source originals remain hidden from a different ${target.personaId?'Persona':'conversation'}`,async t=>{
 const f=await fixture(t),scope=f.scope();f.setReply((_options,input)=>({overall:{label:'平静',summary:'属于原身份的原因',intensity:.2,recoveryHalfLifeMs:60000,eventIds:input.events.map(row=>row.eventId)},feelings:[]}));
 await f.service.userInteraction({scope,eventId:'scoped-original',kind:'chat',text:'不能串到另一个会话的原文。'});await f.service.mood.evaluate({scope,eventIds:['scoped-original']});assert.equal((await f.service.action('mood-sources')).sources.length,1);
 await f.switchContext(target);assert.deepEqual((await f.service.action('mood-sources')).sources,[]);await assert.rejects(f.service.action('mood-sources',{eventIds:['scoped-original']}),/当前可查看范围/);assert.equal(f.service.view().mood.overall.summary,'');assert.deepEqual(f.service.view().mood.overall.eventIds,[]);
});

for(const key of ['id','operationId'])test(`withOrigin rejects a late successful result after life ${key} changes`,async t=>{
 const f=await fixture(t),scope=f.scope(),wait=gate(),entered=gate();let origin;
 const pending=f.service.withOrigin(scope,'chat',async id=>{origin=id;entered.resolve();await wait.promise;return {text:'Late result must not commit'};});await entered.promise;assert.ok(f.service.origins.resolve(origin));
 await f.store.mutate(state=>{state.lives[scope.characterId][key]='new-'+key;});wait.resolve();await assert.rejects(pending,/旧人生/);assert.equal(f.service.origins.resolve(origin),null);assert.equal(f.store.state.lives[scope.characterId].r95?.mood,undefined);
});

test('withOrigin rejects a completed callback after cancellation and finishes the attribution receipt',async t=>{
 const f=await fixture(t),scope=f.scope(),wait=gate(),entered=gate(),controller=new AbortController();let origin;
 const pending=f.service.withOrigin(scope,'chat',async id=>{origin=id;entered.resolve();await wait.promise;return {text:'Cancelled result'};},{signal:controller.signal});await entered.promise;controller.abort();wait.resolve();await assert.rejects(pending,/取消/);assert.ok(Number.isFinite(f.service.origins.resolve(origin).finishedAt),'completed attribution metadata is retained for late actual usage');assert.equal(f.store.state.lives[scope.characterId].r95?.mood,undefined);
});
