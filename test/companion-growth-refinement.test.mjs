import test from 'node:test';
import assert from 'node:assert/strict';
import {enableGrowth,applyGrowthCandidates} from '../src/companion-growth.mjs';
import {effectiveCard} from '../src/companion-store.mjs';

function fixture(before='喜欢茶。'){
 const state={cards:{a:{id:'a',name:'虚构角色',revision:1,fields:{likes:{mode:'custom',value:before}},defaults:{}}},personas:{p:{id:'p',name:'默认身份',nickname:'你'}},lives:{a:{id:'life-a',operationId:'op-a',mode:'normal',memory:{events:{}},growth:{}}}};
 enableGrowth(state,'a','seed',1);
 for(let i=1;i<=6;i++){const id='e'+i;state.lives.a.memory.events[id]={id,sourceId:'source-'+id,experienceId:'experience-'+id,characterId:'a',lifeId:'life-a',scope:'persona:p',day:i%2?'2026-10-29':'2026-10-30',role:'assistant',sourceKind:'character-statement',presented:true,status:'presented',text:'虚构的独立饮茶经历 '+i,source:{type:'conversation',id:'conversation'}};}
 return state;
}
function submit(state,{after,ids,operation='introduce',traitId,attributes={},batchId='batch'}={}){
 const card=state.cards.a;
 return applyGrowthCandidates(state,'a',[{schema:2,operation,traitId,subject:'茶',attributes,field:'likes',before:effectiveCard(card).likes,after,sourceEventIds:ids,counterEvidenceIds:[],scope:'general',privacy:'general-behavior',kind:'small-behavior',expectedCardVersion:card.revision,lifeId:'life-a',operationId:'op-a'}],{id:batchId,day:'2026-10-31',scope:'persona:p',lifeId:'life-a',operationId:'op-a',eventIds:Object.keys(state.lives.a.memory.events)},2);
}

test('GG-C1 a supported tea refinement does not require a new gradual keyword in the text diff',()=>{
 const state=fixture('逐渐喜欢茶。'),seed=structuredClone(state.lives.a.seedCard);
 const result=submit(state,{after:'逐渐喜欢清香乌龙茶。',ids:['e1','e2','e3'],attributes:{type:'乌龙茶',aroma:'清香'}});
 assert.equal(result.applied.length,1);
 assert.equal(effectiveCard(state.cards.a).likes,'逐渐喜欢清香乌龙茶。');
 assert.deepEqual(state.lives.a.seedCard,seed);
});

test('GG-C1 wording changes on one preference keep the same observation and accumulated evidence',()=>{
 const state=fixture(),first=submit(state,{after:'喜欢茶，有时更偏好清香乌龙茶。',ids:['e1','e2'],attributes:{type:'乌龙茶',aroma:'清香'},batchId:'wording-1'});
 assert.equal(first.observing.length,1);
 const traitId=first.observing[0].traitId??first.observing[0].id;
 const second=submit(state,{after:'喜欢茶，有时偏好清香乌龙茶。',ids:['e3','e4'],traitId,attributes:{type:'乌龙茶',aroma:'清香'},batchId:'wording-2'});
 assert.equal(second.applied.length,1);
 assert.equal(Object.keys(state.lives.a.growth.observations).length,0);
 assert.equal(effectiveCard(state.cards.a).likes,'喜欢茶，有时偏好清香乌龙茶。');
});

test('GG-C1 established preference evidence remains a basis while one new own detail supports refinement',()=>{
 const state=fixture(),first=submit(state,{after:'喜欢茶，近期更偏好乌龙茶。',ids:['e1','e2','e3'],attributes:{type:'乌龙茶'},batchId:'basis'});
 assert.equal(first.applied.length,1);
 const traitId=first.applied[0].traitId??first.applied[0].id;
 const refined=submit(state,{after:'喜欢茶，近期更偏好乌龙茶；有时会选清香型。',ids:['e1','e2','e3','e4'],operation:'refine',traitId,attributes:{type:'乌龙茶',aroma:'清香'},batchId:'detail'});
 assert.equal(refined.applied.length,1);
 assert.equal(effectiveCard(state.cards.a).likes,'喜欢茶，近期更偏好乌龙茶；有时会选清香型。');
});

test('GG-C1 ordinary preference quotes remain allowed while private names remain blocked',()=>{
 const allowed=fixture();assert.equal(submit(allowed,{after:'喜欢茶，近期偏好“清香型”乌龙茶。',ids:['e1','e2','e3'],attributes:{type:'乌龙茶',aroma:'清香型'}}).applied.length,1);
 const privateState=fixture();privateState.personas.p.name='Alex';assert.equal(submit(privateState,{after:'喜欢茶，近期偏好Alex的秘密茶方。',ids:['e1','e2','e3'],attributes:{type:'茶方'}}).rejected[0].code,'unsafe-abstraction');
});

test('GG-C1 a reverse or wider preference cannot use the refinement shortcut',()=>{
 const state=fixture(),first=submit(state,{after:'喜欢茶，近期偏好乌龙茶。',ids:['e1','e2','e3'],attributes:{type:'乌龙茶'},batchId:'stable'}),traitId=first.applied[0].traitId;
 const changed=submit(state,{after:'喜欢茶，近期偏好咖啡。',ids:['e4'],operation:'refine',traitId,attributes:{type:'咖啡'},batchId:'reverse'});
 assert.equal(changed.applied.length,0);assert.equal(changed.rejected[0].code,'refinement-requires-revision');assert.equal(effectiveCard(state.cards.a).likes,'喜欢茶，近期偏好乌龙茶。');
});

test('Astra review: unchanged attributes cannot hide a reversed preference in card text',()=>{
 const state=fixture(),first=submit(state,{after:'喜欢茶，近期偏好乌龙茶。',ids:['e1','e2','e3'],attributes:{type:'乌龙茶'},batchId:'stable-text'}),traitId=first.applied[0].traitId;
 for(const [i,after]of ['逐渐喜欢清香咖啡。','不再喜欢乌龙茶，逐渐偏好清香咖啡。'].entries()){const changed=submit(state,{after,ids:['e4'],operation:'refine',traitId,attributes:{type:'乌龙茶',aroma:'清香'},batchId:'mismatch-'+i});assert.equal(changed.applied.length,0);assert.equal(changed.rejected[0]?.code,'refinement-text-requires-revision');}
 assert.equal(effectiveCard(state.cards.a).likes,'喜欢茶，近期偏好乌龙茶。');
});
test('Astra GROW-01: refinement preserves the full current field including another trait and requires genuinely added detail text',()=>{
 const state=fixture(),first=submit(state,{after:'喜欢茶，近期偏好乌龙茶。',ids:['e1','e2','e3'],attributes:{type:'乌龙茶'},batchId:'current-field'}),traitId=first.applied[0].traitId;
 state.cards.a.fields.likes.value+='也喜欢读书。';state.cards.a.revision++;
 const removedOtherTrait=submit(state,{after:'喜欢茶，近期偏好乌龙茶；有时会选清香型。',ids:['e4'],operation:'refine',traitId,attributes:{type:'乌龙茶',aroma:'清香'},batchId:'removed-other'});assert.equal(removedOtherTrait.rejected[0]?.code,'refinement-text-requires-revision');
 const additive=submit(state,{after:'喜欢茶，近期偏好乌龙茶。也喜欢读书；有时会选清香型。',ids:['e4'],operation:'refine',traitId,attributes:{type:'乌龙茶',aroma:'清香'},batchId:'preserved-other'});assert.equal(additive.applied.length,1);
 const reusedOldDetail=submit(state,{after:effectiveCard(state.cards.a).likes+'也会细想风味。',ids:['e5'],operation:'refine',traitId,attributes:{type:'乌龙茶',aroma:'清香',newLabel:'清香'},batchId:'reused-old-detail'});assert.equal(reusedOldDetail.rejected[0]?.code,'refinement-text-requires-revision');
 const revise=submit(state,{after:'喜欢清香咖啡。',ids:['e6'],operation:'revise',traitId,attributes:{type:'咖啡',aroma:'清香'},batchId:'revision-gate'});assert.equal(revise.applied.length,0);assert.equal(revise.observing[0]?.code,'insufficient-independent-evidence');
});
