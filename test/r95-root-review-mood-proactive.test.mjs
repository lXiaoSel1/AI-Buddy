import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {createMoodService,rebaseMoodSnapshot} from '../src/companion-mood.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';

async function setup(t,{group=false}={}){
 const state=await companionFixture();
 state.personas.default.relationships.claude={relationship:'OWNER-PRIVATE-RELATION-SECRET'};
 if(group){state.groups.g={id:'g',personaId:'default',entryCharacterId:'claude',memberIds:['claude','gpt'],messages:[]};state.activeGroupId='g';}
 const store=memoryStore(state),dataRoot=mkdtempSync(join(tmpdir(),'r95-root-review-')),calls=[],contexts=[];
 const provider={enabled:true,captureConnection:()=>({id:'fixture',model:'fixture-model',kind:'custom',contextTokens:272000}),runCaptured:(_profile,fn)=>fn(),resolveSearchCapability:()=>({supported:true}),
  async *stream(options){calls.push(options);yield {type:'text-delta',text:options.purpose==='mood'?'{"changed":false}':'{"speak":true,"mode":"awake","text":"自然招呼"}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const core=await createCompanionR95({store,dataRoot,provider,now:()=>100000,getContext:()=>({characterId:store.state.activeCharacterId,personaId:store.state.activePersonaId,conversationId:store.state.activeConversationId,groupId:store.state.activeGroupId}),getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:1}),memory:{context:async value=>{contexts.push(value);return {text:''};}},delta:()=>{},audit:()=>{}});
 t.after(async()=>{await core.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 return {core,store,calls,contexts};
}

test('R95 root review: enabled APP proactive has a real event-driven first candidate',async t=>{
 const f=await setup(t);await f.core.action('social-settings',{proactive:true});
 await f.core.userInteraction({eventId:'real-user-1',kind:'chat',text:'我回来了'});
 assert.equal(f.calls.length,0,'recording real attention must not await a model');
 await f.core.tick();
 assert.ok(Object.values(f.store.state.lives.claude.r95?.proactive?.candidates??{}).length>0,'APP interactions must bootstrap an eligible candidate, not require an optional plugin to start the core feature');
});

test('R95 root review: group mood uses only the group-known memory projection',async t=>{
 const f=await setup(t,{group:true}),scope=f.core.activeScope();
 await f.core.userInteraction({scope,eventId:'group-user-1',kind:'group-chat',text:'你好大家'});
 await f.core.evaluateInteraction({scope,eventIds:['group-user-1']});
 assert.ok(f.contexts.some(value=>value.groupId==='g'||value.socialContext?.channel==='app-group'&&value.socialContext?.conversationId==='g'),'APP group must not call the default Persona-private memory context');
});

test('R95 root review: external group evaluation does not inject owner APP relationship',async t=>{
 const f=await setup(t),scope=f.core.scopeFor('claude','default','qq-group','qq-room');
 await f.core.userInteraction({scope,eventId:'qq-user-1',kind:'chat',text:'群里来了新消息'});
 await f.core.evaluateInteraction({scope,eventIds:['qq-user-1']});
 assert.ok(f.calls.length>0);assert.equal(f.calls.some(value=>value.system.includes('OWNER-PRIVATE-RELATION-SECRET')),false,'private relationship must only enter a verified owner-private context');
});

test('R95 root review: mood reason compares channel as well as Persona and conversation',async()=>{
 const store=memoryStore(await companionFixture()),life=store.state.lives.claude,qq={characterId:'claude',personaId:'default',lifeId:life.id,operationId:life.operationId,channel:'qq-private',conversationId:'colliding-id'},app={...qq,channel:'app-private'};
 const mood=createMoodService({store,now:()=>1000,getEvidence:async()=>[{eventId:'qq-event'}],generate:async()=>({overall:{label:'高兴',summary:'QQ-PRIVATE-SECRET',intensity:1,recoveryHalfLifeMs:1000},feelings:[]})});
 try{await mood.evaluate({scope:qq,eventIds:['qq-event']});assert.equal(mood.view({scope:app}).overall.summary,'','same ID in a different channel is not the same conversation');}finally{await mood.close();}
});

test('R95 root review: archived mood keeps remaining review time instead of firing immediately',()=>{
 const feeling={label:'等待',summary:'',anchorIntensity:1,intensity:1,recoveryHalfLifeMs:1000,eventIds:['actual']};
 const life={r95:{mood:{version:1,anchorAt:1000,lastEvaluatedAt:1000,nextReviewAt:5000,overall:feeling,feelings:[],eventIds:['actual']}}};
 rebaseMoodSnapshot(life,100000,2000);
 assert.equal(life.r95.mood.nextReviewAt,103000,'three seconds remained when this life snapshot was saved');
});
