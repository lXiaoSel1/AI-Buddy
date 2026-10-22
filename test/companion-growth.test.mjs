import test from 'node:test';
import assert from 'node:assert/strict';
import {makeCard,effectiveCard} from '../src/companion-store.mjs';
import {assertCardEditAllowed,enableGrowth,applyGrowthCandidates,growthView,GROWTH_LOCKED_FIELDS} from '../src/companion-growth.mjs';
import {companionCardDraft} from '../src/companion-ui.mjs';

function fixture(){
 const card=makeCard({id:'claude',name:'Claude',fields:{interests:{mode:'custom',value:'尚未形成稳定偏好'},personality:{mode:'custom',value:'有些慢热'},visual:{mode:'custom',value:'铜橙长发'}},examples:[{scene:'初次相遇',speaker:'Claude',text:'你好'}],modelBinding:{enabled:true,connectionId:'profile-cheap'}});
 return {cards:{claude:card},personas:{a:{id:'a',name:'Alex'},b:{id:'b',name:'Beatrice'}},relationships:{claude:{mode:'independent',byPersona:{a:{level:6,affection:22},b:{level:1,affection:3}}}},lives:{claude:{id:'life-a',operationId:'op-a',startedAt:1,mode:'normal',memory:{events:{}},growth:{}}}};
}
function events(state,{days=['2026-10-18','2026-10-19','2026-10-19'],prefix='e',scope='persona:a',role='assistant',sourceKind='character-statement',experience=true}={}){
 const life=state.lives.claude,ids=[];
 for(let i=0;i<days.length;i++){
  const id=prefix+i;life.memory.events[id]={id,sourceId:prefix+'-raw-'+i,characterId:'claude',lifeId:life.id,operationId:life.operationId,scope,personaId:scope==='persona:b'?'b':'a',conversationId:'conversation-a',day:days[i],createdAt:Date.parse(days[i]),role,text:'A distinct original discussion '+i+' about observing a distant object.',revision:0,sourceKind,presented:true,status:'presented',source:{type:'conversation',id:'conversation-a',messageId:id},...(experience?{experienceId:prefix+'-turn-'+i}:{})};ids.push(id);
 }
 return ids;
}
function proposal(state,ids,overrides={}){const card=state.cards.claude,life=state.lives.claude;return {field:'interests',before:effectiveCard(card).interests,after:'开始对天文题材表现出持续兴趣',sourceEventIds:ids,counterEvidenceIds:[],scope:'general',reason:'持续主动选择相近主题。',context:'读物选择',expectedCardVersion:card.revision,lifeId:life.id,operationId:life.operationId,kind:'small-behavior',privacy:'general-behavior',...overrides};}
function batch(state,ids,overrides={}){const life=state.lives.claude;return {id:'daily-a',day:'2026-10-20',lifeId:life.id,operationId:life.operationId,scope:'persona:a',eventIds:ids,...overrides};}
function ready(){const state=fixture();enableGrowth(state,'claude','seed',2);const ids=events(state);return {state,ids};}

test('ordinary cards remain editable and growth is explicit opt-in, not migration',()=>{
 const state=fixture(),before=structuredClone(state);assert.equal(assertCardEditAllowed(state.cards.claude,{name:'编辑后的名字'},state.lives.claude),true);assert.deepEqual(state,before);
 enableGrowth(state,'claude','seed',2);assert.equal(state.lives.claude.mode,'seed');assert.equal(state.cards.claude.revision,2);assert.equal(effectiveCard(state.lives.claude.seedCard).personality,'有些慢热');
 const opted=structuredClone(state);enableGrowth(state,'claude','seed',3);assert.deepEqual(state,opted);assert.throws(()=>enableGrowth(state,'claude','normal'),/请选择/);assert.throws(()=>enableGrowth(state,'claude','blank'),/不能直接切换/);
});
test('blank has no invented biography, retains appearance/API and keeps distinct Persona relations',()=>{
 const state=fixture(),relationships=structuredClone(state.relationships);state.cards.claude.defaults={identity:'旧职业',background:'旧童年',interests:'旧兴趣'};
 enableGrowth(state,'claude','blank',2);for(const field of GROWTH_LOCKED_FIELDS)assert.equal(effectiveCard(state.cards.claude)[field],'');
 assert.deepEqual(state.cards.claude.examples,[]);assert.equal(effectiveCard(state.cards.claude).visual,'铜橙长发');assert.equal(state.cards.claude.modelBinding.connectionId,'profile-cheap');assert.deepEqual(state.relationships,relationships);assert.equal(effectiveCard(state.lives.claude.seedCard).background,'旧童年');
});
test('growth save lock covers identity, examples, mode and direct effective/import fields',()=>{
 const {state}=ready(),card=state.cards.claude,life=state.lives.claude;
 for(const field of GROWTH_LOCKED_FIELDS)assert.throws(()=>assertCardEditAllowed(card,{fields:{[field]:{mode:'custom',value:'绕过修改'}}},life),/只读/);
 for(const args of [{name:'新名字'},{examples:[]},{growthMode:'normal'},{mode:'normal'},{growth:{}},{life:{}},{defaults:{background:'导入过去'}},{personality:'覆盖性格'},{id:'someone-else'}])assert.throws(()=>assertCardEditAllowed(card,args,life),/只读/);
 assert.equal(assertCardEditAllowed(card,{name:card.name,examples:structuredClone(card.examples),fields:structuredClone(card.fields),mode:'seed',modelBinding:{enabled:false,connectionId:null},avatar:'new',talkativeness:.9},life),true);
 assert.equal(assertCardEditAllowed(card,{fields:{visual:{mode:'custom',value:'新形象'},sprite:{mode:'empty'},backgroundImage:{mode:'empty'},referenceImage:{mode:'empty'}}},life),true);
});
test('actual editor normalization of untouched inherit/empty fields permits image/API/talkativeness edits',()=>{
 const {state}=ready(),card=state.cards.claude;card.defaults={tone:'稳重'};const exposed={...card,effective:effectiveCard(card),life:{mode:'seed'}};const draft=companionCardDraft(exposed);draft.talkativeness=.7;draft.modelBinding={enabled:false,connectionId:''};draft.fields.visual={mode:'custom',value:'新外观'};
 assert.equal(assertCardEditAllowed(card,draft,state.lives.claude),true);draft.fields.tone={mode:'empty',value:''};assert.throws(()=>assertCardEditAllowed(card,draft,state.lives.claude),/只读/);
 const blank=fixture();enableGrowth(blank,'claude','blank');const blankCard=blank.cards.claude;assert.equal(assertCardEditAllowed(blankCard,companionCardDraft({...blankCard,effective:effectiveCard(blankCard)}),blank.lives.claude),true);
});
test('three independent own experiences across active days apply a small current-card change',()=>{
 const {state,ids}=ready(),relations=structuredClone(state.relationships),seed=structuredClone(state.lives.claude.seedCard),raw=structuredClone(state.lives.claude.memory.events);
 const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids),5);
 assert.equal(result.applied.length,1);assert.equal(state.cards.claude.revision,3);assert.equal(effectiveCard(state.cards.claude).interests,'开始对天文题材表现出持续兴趣');assert.deepEqual(state.relationships,relations);assert.deepEqual(state.lives.claude.seedCard,seed);assert.deepEqual(state.lives.claude.memory.events,raw);
 assert.equal(state.lives.claude.growth.history[0].evidenceCount,3);assert.equal(state.lives.claude.growth.history[0].activeDays,2);
});
test('growth uses current version; later small replacements need not preserve or pull toward seed',()=>{
 const {state,ids}=ready();applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids),5);
 const later=events(state,{prefix:'later',days:['2026-10-20','2026-10-21','2026-10-21']});
 const next=proposal(state,later,{after:'在选择读物时偶尔优先尝试天文主题'});const result=applyGrowthCandidates(state,'claude',[next],batch(state,later,{id:'daily-b',day:'2026-10-22'}),8);
 assert.equal(result.applied.length,1);assert.equal(effectiveCard(state.cards.claude).interests,next.after);assert.equal(effectiveCard(state.lives.claude.seedCard).interests,'尚未形成稳定偏好');
});
test('no evidence does not grow, repeated phrases/turns and summaries cannot manufacture experiences',()=>{
 const {state,ids}=ready();for(const id of ids)state.lives.claude.memory.events[id].experienceId='one-turn';
 let result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids));assert.equal(result.applied.length,0);assert.equal(result.observing[0].code,'insufficient-independent-evidence');assert.deepEqual(state.lives.claude.growth.evidenceUse.interests,[]);
 const saved=structuredClone(state.cards.claude);state.lives.claude.memory.events.e1.sourceKind='summary';result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids,{id:'daily-summary'}));assert.equal(result.rejected[0].code,'invalid-evidence');assert.deepEqual(state.cards.claude,saved);
});
test('legacy evidence without turn IDs is conservatively grouped by conversation/day',()=>{
 const {state}=ready();const ids=events(state,{experience:false});const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids));assert.equal(result.applied.length,0);assert.equal(result.observing[0].code,'insufficient-independent-evidence');
});
test('revisions or duplicate representations of one original source stay one experience',()=>{
 const {state,ids}=ready();for(const [i,id]of ids.entries())Object.assign(state.lives.claude.memory.events[id],{sourceId:'same-original-source',revision:i});
 const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids));assert.equal(result.applied.length,0);assert.equal(result.observing[0].code,'insufficient-independent-evidence');
});
test('calendar passage and dense one-day chat do not create sustained traits',()=>{
 const {state}=ready(),ids=events(state,{days:['2026-10-18','2026-10-18','2026-10-18']});
 const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids,{day:'2030-01-01'}));assert.equal(result.applied.length,0);assert.equal(result.observing[0].code,'insufficient-active-days');
});
test('user reports alone and another character speaking do not establish this character interests',()=>{
 const {state}=ready(),ids=events(state,{role:'user',sourceKind:'user-report'});
 let result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids));assert.equal(result.observing[0].code,'insufficient-character-behavior');
 for(const id of ids)Object.assign(state.lives.claude.memory.events[id],{role:'assistant',sourceKind:'shared-dialogue',speakerCharacterId:'gpt'});
 result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids,{id:'other-speaking'}));assert.equal(result.observing[0].code,'insufficient-character-behavior');
});
test('private, unpresented, foreign-life, derived or outside-cut events are rejected',()=>{
 for(const mutation of [event=>{event.scope='persona:b';},event=>{event.presented=false;},event=>{event.lifeId='old-life';},event=>{event.derived=true;},event=>{event.status='pending-presentation';}]){
  const {state,ids}=ready();mutation(state.lives.claude.memory.events[ids[0]]);const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids));assert.equal(result.applied.length,0);assert.equal(result.rejected[0].code,'invalid-evidence');
 }
 const {state,ids}=ready();const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids.slice(1)));assert.equal(result.rejected[0].code,'invalid-evidence');
});
test('daily growth cannot borrow future events beyond the frozen logical day',()=>{
 const {state,ids}=ready();state.lives.claude.memory.events.e2.day='2026-10-21';const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids));assert.equal(result.rejected[0].code,'invalid-evidence');
});
test('stale card/life and A→B→A operation generations cannot write',()=>{
 const {state,ids}=ready(),p=proposal(state,ids),b=batch(state,ids);const original=structuredClone(state);
 let result=applyGrowthCandidates(state,'claude',[{...p,expectedCardVersion:p.expectedCardVersion-1}],b);assert.equal(result.rejected[0].code,'stale-card');assert.deepEqual(state.cards,original.cards);
 state.lives.claude.operationId='op-restored-a';const before=structuredClone(state);result=applyGrowthCandidates(state,'claude',[p],b);assert.equal(result.rejected[0].code,'stale-life');assert.deepEqual(state,before);
 const current=proposal(state,ids);result=applyGrowthCandidates(state,'claude',[current],batch(state,ids,{id:'new-operation'}));assert.equal(result.applied.length,1,'original same-life events remain usable after a verified restore');
});
test('illegal patch cannot alter biography, API, progress or replace personality abruptly',()=>{
 for(const override of [{field:'identity',before:'',after:'开始在某处工作'},{field:'modelBinding',before:'',after:'开始换API'},{after:'从此完全极度外向'},{after:'天文专家'},{after:'开始'+('x'.repeat(180))}]){
  const {state,ids}=ready(),before=structuredClone(state.cards);const result=applyGrowthCandidates(state,'claude',[proposal(state,ids,override)],batch(state,ids));assert.equal(result.applied.length,0);assert.equal(result.rejected.length,1);assert.deepEqual(state.cards,before);
 }
});
test('private names, secrets, literal quotations and personal details do not enter shared card',()=>{
 for(const after of ['开始对Alex的秘密表现出持续兴趣','开始对Beatrice表现出持续兴趣','开始对2026-10-01的约定表现出持续兴趣','开始对“只对你说的事情”表现出持续兴趣']){
  const {state,ids}=ready(),result=applyGrowthCandidates(state,'claude',[proposal(state,ids,{after})],batch(state,ids));assert.equal(result.rejected[0].code,'unsafe-abstraction');
 }
 const {state,ids}=ready();const after='开始对微光下那架未公开的银色纸飞机表现出持续兴趣';state.lives.claude.memory.events.e0.text=after;
 const result=applyGrowthCandidates(state,'claude',[proposal(state,ids,{after})],batch(state,ids));assert.equal(result.rejected[0].code,'unsafe-abstraction');
});
test('counterevidence remains observing without consuming originals',()=>{
 const {state,ids}=ready(),counter=events(state,{prefix:'counter',days:['2026-10-20']});let result=applyGrowthCandidates(state,'claude',[proposal(state,ids,{counterEvidenceIds:counter})],batch(state,[...ids,...counter]));
 assert.equal(result.observing[0].code,'counterevidence-needs-review');assert.equal(result.applied.length,0);assert.equal(Object.values(state.lives.claude.growth.observations).length,1);assert.deepEqual(state.lives.claude.growth.evidenceUse.interests,[]);
 result=applyGrowthCandidates(state,'claude',[proposal(state,ids,{counterEvidenceIds:counter})],batch(state,[...ids,...counter],{id:'counter-retry'}));assert.equal(result.observing[0].code,'counterevidence-needs-review');assert.equal(Object.values(state.lives.claude.growth.observations).length,1);
});
test('deeper personality changes use several active days, not the small-interest gate',()=>{
 const {state,ids}=ready();let result=applyGrowthCandidates(state,'claude',[proposal(state,ids,{field:'personality',before:'有些慢热',after:'在熟悉话题上更愿意主动表达'})],batch(state,ids));assert.equal(result.observing[0].code,'insufficient-active-days');
 const more=events(state,{prefix:'deep',days:['2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-17','2026-10-18']});result=applyGrowthCandidates(state,'claude',[proposal(state,more,{field:'personality',before:'有些慢热',after:'在熟悉话题上更愿意主动表达'})],batch(state,more,{id:'deep-batch'}));assert.equal(result.applied.length,1);
});
test('daily quota is character-wide across Personas and deferred evidence is preserved',()=>{
 const {state,ids}=ready();const tone=proposal(state,ids,{field:'tone',before:'',after:'在熟悉话题上偶尔用更轻松的说法'});
 let result=applyGrowthCandidates(state,'claude',[proposal(state,ids),tone],batch(state,ids));assert.equal(result.applied.length,2);
 const bIds=events(state,{prefix:'b',scope:'persona:b'});const speech=proposal(state,bIds,{field:'speechHabits',before:'',after:'在介绍新内容时更愿意先讲一个具体例子'});
 result=applyGrowthCandidates(state,'claude',[speech],batch(state,bIds,{id:'persona-b',scope:'persona:b'}));assert.equal(result.applied.length,0);assert.equal(result.observing[0].status,'deferred');assert.deepEqual(state.lives.claude.growth.evidenceUse.speechHabits,[]);
 result=applyGrowthCandidates(state,'claude',[speech],batch(state,bIds,{id:'next-day',scope:'persona:b',day:'2026-10-21'}));assert.equal(result.applied.length,1);assert.equal(state.lives.claude.growth.daily['2026-10-20'],2);assert.deepEqual(state.relationships.claude.byPersona,{a:{level:6,affection:22},b:{level:1,affection:3}});
});
test('batch retries are idempotent and same raw evidence cannot repeatedly change a field',()=>{
 const {state,ids}=ready(),p=proposal(state,ids),b=batch(state,ids);applyGrowthCandidates(state,'claude',[p],b);const current=structuredClone(state);
 let result=applyGrowthCandidates(state,'claude',[p],b);assert.equal(result.duplicate,true);assert.deepEqual(state,current);
 result=applyGrowthCandidates(state,'claude',[proposal(state,ids,{after:'在选择读物时偶尔优先尝试天文主题'})],batch(state,ids,{id:'recall-same-originals',day:'2026-10-21'}));assert.equal(result.applied.length,0);assert.equal(result.observing[0].code,'insufficient-independent-evidence');
 const conflicted=applyGrowthCandidates(state,'claude',[{...p,reason:'different'}],b);assert.equal(conflicted.rejected[0].code,'batch-conflict');
});
test('public view is shared across Personas but omits private reasons/source IDs/scope/context',()=>{
 const {state,ids}=ready();applyGrowthCandidates(state,'claude',[proposal(state,ids,{reason:'Alex privately disclosed a protected fact.',context:'Private room'})],batch(state,ids));
 const a=growthView(state,'claude','a'),b=growthView(state,'claude','b');assert.deepEqual(a,b);assert.equal(a.history.length,1);assert.equal(a.mode,'seed');assert.equal(a.locked,true);
 const output=JSON.stringify(b);for(const secret of ['Alex','Private room','protected fact','sourceEventIds','persona:a','counterEvidenceIds'])assert.equal(output.includes(secret),false,secret);assert.equal(a.history[0].evidenceCount,3);
});
test('malformed/prototype batch IDs and invalid days cannot corrupt state',()=>{
 const {state,ids}=ready();const result=applyGrowthCandidates(state,'claude',[proposal(state,ids)],batch(state,ids,{id:'__proto__'}));assert.equal(result.applied.length,1);assert.equal(Object.getPrototypeOf(state.lives.claude.growth.batches),Object.prototype);
 assert.throws(()=>applyGrowthCandidates(state,'claude',[],batch(state,ids,{day:'2026-02-30'})),/批次格式/);
});
