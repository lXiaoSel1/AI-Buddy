import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionMemory,collectMemoryEvents,socialExperienceHash,socialMemoryScope,workExperienceHash} from '../src/companion-memory.mjs';

const now=Date.parse('2026-11-02T03:30:00Z'),at=Date.parse('2026-11-01T15:00:00Z'),zone='America/New_York';
function setup(){
 const line=(id,text,createdAt=at,extra={})=>({id,role:'assistant',text,createdAt,presentation:'presented',status:'presented',...extra});
 const state={cards:{a:{id:'a',name:'A',fields:{},revision:1}},personas:{p:{id:'p'},q:{id:'q'}},activePersonaId:'p',conversations:{c:{id:'c',characterId:'a',personaId:'p',lifeId:'la',messages:[line('today','当天已呈现材料'),line('yesterday','应用时区昨天',Date.parse('2026-11-01T03:00:00Z')),line('pending','尚未呈现',at,{presentation:'pending',status:'pending-presentation'}),line('undated','日期未知',0),line('edited','当前更正',at,{revisions:[{text:'已被更正的旧说法',at:at-1000}]})]},q:{id:'q',characterId:'a',personaId:'q',lifeId:'la',messages:[line('other','另一身份的私聊')]},old:{id:'old',characterId:'a',personaId:'p',lifeId:'old-life',messages:[line('old','旧人生材料')]}},groups:{},lives:{a:{id:'la',operationId:'oa',mode:'normal',memory:{},growth:{},personalEvents:[],groupIntervals:{},socialExperiences:[],workExperiences:[]}},memorySettings:{timeZone:'UTC'}};
 const social={id:'watched',eventRef:'host-watch',sourceVersion:1,characterId:'a',personaId:'p',lifeId:'la',operationId:'oa',channel:'bilibili',conversationId:'video-1',sourcePluginId:'bilibili',sourceKind:'bilibili-watch',createdAt:at,text:'角色真实理解的公开视频材料',experienceId:'watch-1',stage:'understood',understandingState:'understood',presentationState:'not-presented',deliveryState:'not-sent',visibilityScope:'conversation',evidenceRefs:[{id:'receipt',sha256:'a'.repeat(64)}],participants:['a']};social.sourceHash=socialExperienceHash(social);state.lives.a.socialExperiences.push(social);
 const work={id:'work',characterId:'a',personaId:'p',lifeId:'la',workspaceId:'workspace',taskId:'task',presented:true,createdAt:at,text:'工作报告私有原文'};work.sourceHash=workExperienceHash(work);state.lives.a.workExperiences.push(work);
 state.lives.a.startedAt=at;
 const store={get state(){return state;},snapshot:()=>structuredClone(state),mutate:async()=>{throw Error('dayMaterials may not mutate');}};
 const memory=createCompanionMemory({store,now:()=>now,autoStart:false,runModel:async()=>{throw Error('dayMaterials may not call a model');}});
 return {state,memory,social};
}
test('day materials use explicit application timezone, current life/latest/presented and do not mutate',()=>{
 const {state,memory}=setup(),before=structuredClone(state),view=memory.dayMaterials({characterId:'a',personaId:'p',conversationId:'c',timeZone:zone});
 assert.equal(view.logicalDay,'2026-11-01');assert.equal(view.timeZone,zone);
 assert.deepEqual(view.events.map(row=>row.text).sort(),['当天已呈现材料','当前更正'].sort());
 assert.equal(view.materialSourceHashes.length,2);assert.equal(view.coverageHash.length,64);assert.deepEqual(state,before);
 assert.throws(()=>memory.dayMaterials({characterId:'a',personaId:'p'}),/时区/);
 assert.throws(()=>memory.dayMaterials({characterId:'a',personaId:'p',timeZone:zone,day:'2026-10-31'}),/当天/);
});
test('only host-authorized understood Bili experiences join daily materials without becoming shared',()=>{
 const {memory,social}=setup();social.accountBindingId='verified-public-account';social.sourceHash=socialExperienceHash(social);const view=memory.dayMaterials({characterId:'a',personaId:'p',conversationId:'c',timeZone:zone,authorizedSocialScopes:[socialMemoryScope(social)]});
 const watched=view.events.find(row=>row.source.type==='social');assert.ok(watched);assert.equal(watched.presented,false);assert.equal(watched.presentationState,'not-presented');assert.equal(view.counts.bilibili,1);
 assert(!view.events.some(row=>row.source.type==='work'||row.socialChannel?.startsWith('qq')));
});
test('newly presented dialogue is projected directly even when persisted memory events are empty',()=>{
 const {state,memory}=setup();state.conversations.c.messages.push({id:'fresh',role:'assistant',text:'刚刚完整呈现的话语',createdAt:now-1,presentation:'presented',status:'presented'});
 const view=memory.dayMaterials({characterId:'a',personaId:'p',conversationId:'c',timeZone:zone});assert(view.events.some(row=>row.text==='刚刚完整呈现的话语'));assert.deepEqual(state.lives.a.memory.events,undefined);
});
test('Astra DAILY-01: an unsynced current-scope ban hides related events and public preference inspiration',()=>{
 const {state,memory}=setup();state.conversations.c.messages.push({id:'trip',role:'assistant',text:'今天聊了海边旅行。',createdAt:at+1,presentation:'presented',status:'presented'},{id:'ban',role:'user',text:'不要再提海边旅行。',createdAt:at+2,status:'sent'});
 state.lives.a.growth.preferences={schema:1,evidenceUseByTrait:{},traits:{'pref-trip':{id:'pref-trip',field:'likes',subject:'海边旅行',status:'established',attributes:{place:'海边'},text:'喜欢海边旅行。'}}};
 const before=structuredClone(state),view=memory.dayMaterials({characterId:'a',personaId:'p',conversationId:'c',timeZone:zone});
 assert.ok(!view.events.some(row=>row.text.includes('海边旅行')),'automatic art must not resurface a freshly suppressed topic');assert.deepEqual(view.preferences,[]);assert.deepEqual(state,before);
});
test('Astra DAILY-01: prior-day bans remain effective and later scoped allow directives release them',()=>{
 const {state,memory}=setup();state.conversations.c.messages.push({id:'trip-today',role:'assistant',text:'今天聊了海边旅行。',createdAt:at+2,presentation:'presented',status:'presented'},{id:'ban-before',role:'user',text:'不要再提海边旅行。',createdAt:Date.parse('2026-10-31T15:00:00Z'),status:'sent'});
 const args={characterId:'a',personaId:'p',conversationId:'c',timeZone:zone};assert.ok(!memory.dayMaterials(args).events.some(row=>row.text.includes('海边旅行')));
 state.conversations.c.messages.push({id:'allow-now',role:'user',text:'可以再提海边旅行。',createdAt:at+3,status:'sent'});assert.ok(memory.dayMaterials(args).events.some(row=>row.source.messageId==='trip-today'));
});
test('Astra DAILY-01: supported persisted notices survive projection, stale edited notices and another persona do not apply',()=>{
 const {state,memory}=setup();state.conversations.c.messages.push({id:'notice-source',role:'user',text:'这个话题先放着。',createdAt:at-86400000,status:'sent'},{id:'trip-now',role:'assistant',text:'海边旅行的风景。',createdAt:at+1,presentation:'presented',status:'presented'});
 const noticeSource=collectMemoryEvents(state,'a',zone).find(row=>row.source.messageId==='notice-source');state.lives.a.memory.notices={preserved:{id:'preserved',type:'do-not-mention',topic:'海边旅行',text:noticeSource.text,eventIds:[noticeSource.id],createdAt:noticeSource.createdAt}};
 const args={characterId:'a',personaId:'p',conversationId:'c',timeZone:zone},before=structuredClone(state),hidden=memory.dayMaterials(args);assert.ok(!hidden.events.some(row=>row.source.messageId==='trip-now'));assert.deepEqual(hidden.materialRestrictions,{topics:['海边旅行']});assert.deepEqual(state,before);
 state.conversations.c.messages.find(row=>row.id==='notice-source').text='现在换一个话题。';state.conversations.q.messages.push({id:'q-ban',role:'user',text:'不要再提海边旅行。',createdAt:at,status:'sent'});const visible=memory.dayMaterials(args);assert.ok(visible.events.some(row=>row.source.messageId==='trip-now'));assert.deepEqual(visible.materialRestrictions,{topics:[]});
});
test('Astra DAILY-01: CG and fictional source metadata survives raw projection and cannot inspire another daily CG',()=>{
 const {state,memory}=setup();state.lives.a.personalEvents.push({id:'cg-art',role:'activity',text:'CG生成的虚构海边场景。',createdAt:at,sourceKind:'daily-cg',cgId:'synthetic-cg'},{id:'fiction',role:'activity',text:'虚构画面不是现实经历。',createdAt:at,fictional:true},{id:'real-activity',role:'activity',text:'真实的当日普通活动。',createdAt:at});
 const view=memory.dayMaterials({characterId:'a',personaId:'p',conversationId:'c',timeZone:zone});assert.ok(view.events.some(row=>row.source.messageId==='real-activity'));assert.ok(!view.events.some(row=>['cg-art','fiction'].includes(row.source.messageId)));
});
