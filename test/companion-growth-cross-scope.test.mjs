import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionMemory,socialExperienceHash,socialMemoryScope} from '../src/companion-memory.mjs';
import {enableGrowth,applyGrowthCandidates} from '../src/companion-growth.mjs';
import {effectiveCard} from '../src/companion-store.mjs';

test('verified Bili experiences accumulate on a stable public trait across videos without sharing raw sources',async()=>{
 let state={cards:{a:{id:'a',name:'A',revision:1,fields:{likes:{mode:'custom',value:'喜欢茶。'}},defaults:{}}},personas:{p:{id:'p'}},conversations:{},groups:{},lives:{a:{id:'la',operationId:'oa',mode:'normal',memory:{},growth:{},groupIntervals:{},personalEvents:[],socialExperiences:[]}},memorySettings:{timeZone:'UTC'}};enableGrowth(state,'a','seed',1);
 for(const [id,video,day]of[['one','video-one','2026-10-29'],['two','video-one','2026-10-30'],['three','video-two','2026-10-30']]){const row={id,eventRef:'receipt-'+id,sourceVersion:1,characterId:'a',personaId:'p',lifeId:'la',operationId:'oa',channel:'bilibili',conversationId:video,sourcePluginId:'bilibili',sourceKind:'bilibili-watch',createdAt:Date.parse(day+'T12:00:00Z'),text:'PRIVATE_SOURCE_'+id+'_MUST_STAY_IN_ITS_VIDEO',experienceId:'experience-'+id,stage:'understood',understandingState:'understood',presentationState:'not-presented',deliveryState:'not-sent',visibilityScope:'conversation',evidenceRefs:[{id:'material-'+id,sha256:'a'.repeat(64)}],participants:['a']};row.sourceHash=socialExperienceHash(row);state.lives.a.socialExperiences.push(row);}
 const store={get state(){return state;},snapshot:()=>structuredClone(state),async mutate(fn){const next=structuredClone(state),result=await fn(next);state=next;return result;}};const inputs=[];
 const memory=createCompanionMemory({store,now:()=>Date.parse('2026-11-01T12:00:00Z'),autoStart:false,getCapacity:()=>({tokens:32000,verified:true}),onGrowth:(s,id,candidates,batch)=>applyGrowthCandidates(s,id,candidates,batch),runModel:async(_id,request)=>{const input=JSON.parse(request.messages[0].text);inputs.push(input);const preference=input.preferences?.find(row=>row.subject==='茶');return JSON.stringify({coverageHash:input.coverageHash,summary:{text:'角色理解了一段素材。',eventIds:input.todayEventIds},guide:{text:'',eventIds:[]},core:[],branches:[],growthCandidates:[{schema:2,operation:'introduce',subject:'茶',attributes:{type:'乌龙茶'},...(preference?{traitId:preference.id}:{}),field:'likes',before:input.currentCard.likes,after:'喜欢清香的乌龙茶。',sourceEventIds:input.todayEventIds,counterEvidenceIds:[],scope:'general',privacy:'general-behavior',kind:'small-behavior',expectedCardVersion:input.expectedCardVersion,lifeId:input.lifeId,operationId:input.operationId}]});}});
 const first=socialMemoryScope(state.lives.a.socialExperiences[0]),second=socialMemoryScope(state.lives.a.socialExperiences[2]);
 assert.equal((await memory.consolidate({characterId:'a',scope:first,day:'2026-10-29'})).growthResult.status,'observing');
 assert.equal((await memory.consolidate({characterId:'a',scope:first,day:'2026-10-30'})).growthResult.status,'observing');
 assert.equal((await memory.consolidate({characterId:'a',scope:second,day:'2026-10-30'})).growthResult.status,'applied');
 assert.equal(effectiveCard(state.cards.a).likes,'喜欢清香的乌龙茶。');
 assert.equal(state.lives.a.growth.history[0].evidenceCount,3);
 assert(!JSON.stringify(inputs.at(-1)).includes('PRIVATE_SOURCE_one'));
 assert(!JSON.stringify(inputs.at(-1)).includes('PRIVATE_SOURCE_two'));
 const trait=Object.values(state.lives.a.growth.preferences.traits)[0];assert.equal(trait.evidence.length,3);assert(!JSON.stringify(trait.evidence).includes('PRIVATE_SOURCE'));
});
