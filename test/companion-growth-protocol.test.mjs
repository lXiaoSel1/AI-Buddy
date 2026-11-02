import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionMemory} from '../src/companion-memory.mjs';
import {enableGrowth,applyGrowthCandidates} from '../src/companion-growth.mjs';
import {readGrowthEnvelope} from '../src/companion-preferences.mjs';

test('growth output explicitly distinguishes absent, null, malformed and empty arrays',()=>{
 assert.equal(readGrowthEnvelope({}).status,'missing');assert.equal(readGrowthEnvelope({growthCandidates:null}).code,'null-growth-candidates');assert.equal(readGrowthEnvelope({growthCandidates:{}}).code,'growth-candidates-not-array');assert.equal(readGrowthEnvelope({growthCandidates:[]}).status,'empty');assert.equal(readGrowthEnvelope({growth_candidates:[{}]}).status,'missing');
});
for(const [name,value,expected]of[['missing',undefined,'missing'],['null',null,'invalid'],['empty',[],'empty'],['rejected',[{field:'identity',before:'',after:'新身份',sourceEventIds:['e0'],counterEvidenceIds:[]}],'rejected'],['bad-reference',[{field:'likes',before:'',after:'有时更愿意饮茶',sourceEventIds:['forged'],counterEvidenceIds:[]}],'rejected']])test('daily memory commits once while growth is '+name,async()=>{
 let state={cards:{a:{id:'a',name:'A',revision:1,fields:{},defaults:{}}},personas:{p:{id:'p'}},conversations:{c:{id:'c',characterId:'a',personaId:'p',lifeId:'la',messages:[{id:'m',role:'user',text:'虚构的当天经历',createdAt:Date.parse('2026-10-30T12:00:00Z')}]}},groups:{},lives:{a:{id:'la',operationId:'oa',mode:'normal',memory:{},growth:{},groupIntervals:{},personalEvents:[]}},memorySettings:{timeZone:'UTC'}};enableGrowth(state,'a','seed',1);
 const store={get state(){return state;},snapshot:()=>structuredClone(state),async mutate(fn){const next=structuredClone(state),result=await fn(next);state=next;return result;}};let calls=0;
 const memory=createCompanionMemory({store,now:()=>Date.parse('2026-10-31T12:00:00Z'),autoStart:false,getCapacity:()=>({tokens:32000,verified:true}),onGrowth:(s,id,candidates,batch)=>applyGrowthCandidates(s,id,candidates,batch),runModel:async(_id,request)=>{calls++;const input=JSON.parse(request.messages[0].text),output={coverageHash:input.coverageHash,summary:{text:'当天记忆整理完成。',eventIds:input.todayEventIds},guide:{text:'',eventIds:[]},core:[],branches:[]};if(value!==undefined)output.growthCandidates=value;return JSON.stringify(output);}});
 const result=await memory.consolidate({characterId:'a',personaId:'p',day:'2026-10-30'});assert.equal(result.status,'committed');assert.equal(result.growthResult.status,expected);assert.equal(result.growthResult.protocol.status,Array.isArray(value)&&value.length?'provided':expected);await memory.consolidate({characterId:'a',personaId:'p',day:'2026-10-30'});assert.equal(calls,1);assert.equal(Object.keys(state.lives.a.memory.summaries).length,1);
});
