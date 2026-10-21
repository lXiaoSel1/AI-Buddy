import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {makeCard,effectiveCard} from '../src/companion-store.mjs';
import {ensureLives,lifeToken,assertLife} from '../src/companion-life.mjs';
import {enableGrowth} from '../src/companion-growth.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {presentedState} from './support/presented-state.mjs';

const copy=value=>structuredClone(value);
function fixture(){
 const cards=Object.fromEntries(['claude','gpt'].map(id=>[id,makeCard({id,name:id==='claude'?'Claude':'GPT',fields:{personality:{mode:'custom',value:'在熟悉话题上偶尔主动表达'},interests:{mode:'custom',value:'对天文有持续兴趣'},visual:{mode:'custom',value:id+' appearance'}},modelBinding:{enabled:true,connectionId:id+'-profile'}})]));
 const state={schema:1,cards,personas:{a:{id:'a',name:'Alice',relationships:{claude:{address:'老师',relationship:'旧关系'},gpt:{address:'朋友'}}},b:{id:'b',name:'Bob',relationships:{claude:{address:'旅人',relationship:'另一份旧关系'}}}},relationships:{claude:{mode:'independent',byPersona:{a:{level:9,affection:21},b:{level:2,affection:7}}},gpt:{mode:'independent',byPersona:{a:{level:4,affection:11}}}},conversations:{ca:{id:'ca',characterId:'claude',personaId:'a',draft:'旧草稿',choices:[{id:'one',text:'旧选项'}],createdAt:1,updatedAt:4,messages:[{id:'u1',role:'user',text:'a-private-original',createdAt:1},{id:'a1',role:'assistant',text:'a-actually-presented',createdAt:2}]},cb:{id:'cb',characterId:'claude',personaId:'b',draft:'b-draft',createdAt:1,updatedAt:3,messages:[{id:'u2',role:'user',text:'b-private-secret',createdAt:1}]},cg:{id:'cg',characterId:'gpt',personaId:'a',createdAt:1,updatedAt:3,messages:[{id:'g1',role:'assistant',text:'other-character-memory',createdAt:2}]}},groups:{group:{id:'group',name:'Shared room',personaId:'a',memberIds:['claude','gpt'],seq:2,scene:'图书室',background:'',messages:[{id:'gmsg1',seq:1,role:'user',text:'known-at-first-life'},{id:'gmsg2',seq:2,role:'assistant',characterId:'gpt',text:'gpt-shared-memory'}],intervals:{claude:[{start:1,end:null}],gpt:[{start:1,end:null}]}}},touchQuotas:{claude:{day:'2026-10-21',count:12,lastAt:88}},events:{reward1:{characterId:'claude',delta:1}},draftCards:{},activeCharacterId:'claude',activePersonaId:'a',activeConversationId:'ca',lifeArchives:{},accountLedger:{tokens:1234,externalSends:['already-sent']}};
 ensureLives(state,100);return state;
}
function memoryStore(initial){let state=copy(initial),tail=Promise.resolve();return {get state(){return state;},snapshot:()=>copy(state),async mutate(fn){const task=tail.then(async()=>{const next=copy(state);const result=await fn(next);state=next;return result;});tail=task.catch(()=>{});return task;},flush:()=>tail};}
async function setup(t,{state=fixture(),hooks={}}={}){
 const root=mkdtempSync(join(tmpdir(),'ai-buddy-life-service-'));t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'ai-buddy-life-service-'));rmSync(root,{recursive:true,force:true});});
 const store=memoryStore(state),contents={claude:{player:{level:9,affection:21},cgs:[{id:'claude-cg',level:5,status:'ready',title:'old-cg'}],unlocks:['scene-1']},gpt:{player:{level:4,affection:11},cgs:[{id:'gpt-cg',level:4,status:'ready'}]}},calls=[];
 const call=async(action,args)=>{calls.push({action,args:copy(args)});const hooked=await hooks.call?.(action,args,{store,contents,calls});if(hooked!==undefined)return hooked;if(action==='companion-life-content')return {ok:true,content:copy(contents[args.characterId])};if(action==='companion-life-validate')return {ok:true};if(action==='companion-life-project'){contents[args.characterId]=args.content.reset?{player:{level:1,affection:0},cgs:[],unlocks:[]}:copy(args.content);return {ok:true};}throw Error('unexpected engine call '+action);};
 const options={store,dataRoot:root,imageCodec:()=>{throw Error('fixture has no valid images');},call,syncCard:async card=>{calls.push({action:'sync-card',id:card.id});await hooks.syncCard?.(card);},projectPersona:async id=>{calls.push({action:'project-persona',id});},quiesce:async(id,options)=>{calls.push({action:'quiesce',id,options});await hooks.quiesce?.(id,options);},enableGrowth,now:()=>1000,onChanged:id=>calls.push({action:'changed',id})};
 const service=await createCompanionLives(options);
 return {root,store,service,contents,calls,restart:()=>createCompanionLives(options)};
}

test('saving archives current card, raw conversations, all independent relations and content without switching life',async t=>{
 const {store,service,contents}=await setup(t),before=store.snapshot(),archive=await service.save('claude',{name:'我的档案',note:'备注'}),preview=service.preview(archive.id);
 assert.equal(archive.name,'我的档案');assert.equal(archive.note,'备注');assert.deepEqual(store.state.cards,before.cards);assert.deepEqual(store.state.lives,before.lives);assert.deepEqual(store.state.relationships,before.relationships);assert.equal(service.list('claude').length,1);assert.equal(preview.life.id,before.lives.claude.id);assert.deepEqual(preview.relationships.byPersona,before.relationships.claude.byPersona);assert.deepEqual(preview.content,contents.claude);
 assert.equal(preview.conversations.some(row=>row.id==='ca'),true);assert.equal(preview.conversations.some(row=>row.characterId==='gpt'),false);
});
test('reset archives before changing the one character and keeps others, quotas, appearance and API unchanged',async t=>{
 const {store,service,contents,calls}=await setup(t),before=store.snapshot(),oldToken=lifeToken(before,'claude'),other=copy(contents.gpt);const archived=await service.reset('claude',{mode:'blank'});
 assert.notEqual(store.state.lives.claude.id,oldToken.lifeId);assert.notEqual(store.state.lives.claude.operationId,oldToken.operationId);assert.throws(()=>assertLife(store.state,'claude',oldToken),/旧人生/);assert.equal(store.state.lives.claude.mode,'blank');assert.equal(effectiveCard(store.state.cards.claude).personality,'');assert.equal(effectiveCard(store.state.cards.claude).visual,'claude appearance');assert.equal(store.state.cards.claude.modelBinding.connectionId,'claude-profile');
 assert.deepEqual(store.state.relationships.claude.byPersona,{a:{level:1,affection:0},b:{level:1,affection:0}});assert.deepEqual(store.state.cards.gpt,before.cards.gpt);assert.deepEqual(store.state.relationships.gpt,before.relationships.gpt);assert.deepEqual(store.state.conversations.cg,before.conversations.cg);assert.deepEqual(store.state.groups.group.messages,before.groups.group.messages);assert.deepEqual(store.state.groups.group.intervals.gpt,before.groups.group.intervals.gpt);assert.deepEqual(store.state.groups.group.memberIds,before.groups.group.memberIds);assert.deepEqual(store.state.touchQuotas,before.touchQuotas);assert.deepEqual(store.state.accountLedger,before.accountLedger);assert.deepEqual(contents.gpt,other);
 assert.equal(service.preview(archived.id).life.id,oldToken.lifeId);assert.equal(store.state.groups.group.intervals.claude[0].start,3);assert.equal(Object.values(store.state.conversations).some(row=>row.id==='ca'||row.id==='cb'),false);assert.equal(calls.findIndex(row=>row.action==='companion-life-content')<calls.findIndex(row=>row.action==='companion-life-project'),true);
});
test('restore archives current life first, restores Persona-specific progress exactly and retains current API choice',async t=>{
 const {store,service,contents}=await setup(t),original=store.snapshot(),originalContent=copy(contents.claude),saved=await service.save('claude');await service.reset('claude',{mode:'blank'});const blankId=store.state.lives.claude.id;
 await store.mutate(next=>{next.cards.claude.modelBinding={enabled:true,connectionId:'new-cheaper-profile'};next.relationships.claude.byPersona.a={level:3,affection:8};next.personas.a.relationships.claude={address:'新称呼',relationship:'新人生关系'};next.personas.a.relationships.gpt={address:'保持其他关系'};});
 const currentBeforeRestore=store.snapshot(),beforeCount=service.list('claude').length;const guarded=await service.restore(saved.id);
 assert.equal(service.list('claude').length,beforeCount+1);assert.equal(service.preview(guarded.id).life.id,blankId);assert.deepEqual(store.state.relationships.claude,original.relationships.claude);assert.equal(store.state.cards.claude.modelBinding.connectionId,'new-cheaper-profile');assert.equal(store.state.lives.claude.id,original.lives.claude.id);assert.notEqual(store.state.lives.claude.operationId,original.lives.claude.operationId);assert.deepEqual(contents.claude,originalContent);
 assert.deepEqual(store.state.personas.a.relationships.claude,original.personas.a.relationships.claude);assert.deepEqual(store.state.personas.b.relationships.claude,original.personas.b.relationships.claude);assert.deepEqual(store.state.personas.a.relationships.gpt,currentBeforeRestore.personas.a.relationships.gpt);assert.deepEqual(store.state.cards.gpt,currentBeforeRestore.cards.gpt);assert.deepEqual(store.state.touchQuotas,currentBeforeRestore.touchQuotas);
});
test('missing image/failed archive never clears live state or projects new content',async t=>{
 const state=fixture();state.cards.claude.avatar='data:image/png;base64,aW52YWxpZA==';const {store,service,calls}=await setup(t,{state}),before=store.snapshot();await assert.rejects(service.reset('claude',{mode:'blank'}),/no valid images/);assert.deepEqual(store.state,before);assert.equal(calls.some(row=>row.action==='companion-life-project'),false);
});
test('target validation failure preserves current life without projection',async t=>{
 const {store,service,calls}=await setup(t,{hooks:{call(action){if(action==='companion-life-validate')return {ok:false,error:'target content invalid'};}}}),before=store.snapshot();await assert.rejects(service.reset('claude',{mode:'blank'}),/target content invalid/);assert.deepEqual(store.state,before);assert.equal(calls.some(row=>row.action==='companion-life-project'),false);
});
test('engine returning ok:false on projection is a failure and cannot publish the new life',async t=>{
 let first=true;const {store,service,contents}=await setup(t,{hooks:{call(action){if(action==='companion-life-project'&&first){first=false;return {ok:false,error:'projection refused'};}}}}),before=store.snapshot(),old=copy(contents.claude);await assert.rejects(service.reset('claude',{mode:'blank'}),/projection refused/);assert.equal(store.state.lives.claude.id,before.lives.claude.id);assert.deepEqual(store.state.cards,before.cards);assert.deepEqual(store.state.relationships,before.relationships);assert.deepEqual(contents.claude,old);assert.equal(store.state.lifeTransaction,undefined);
});
test('thrown projection error rolls back character content, rotates token and preserves newer unrelated state',async t=>{
 let first=true;const {store,service,contents}=await setup(t,{hooks:{async call(action,_args,{store}){if(action==='companion-life-project'&&first){first=false;await store.mutate(next=>{next.touchQuotas.claude.count=13;next.accountLedger.tokens=1250;next.cards.gpt.name='GPT newer';});throw Error('disk/project failure');}}}}),before=store.snapshot(),old=copy(contents.claude);await assert.rejects(service.reset('claude',{mode:'blank'}),/disk\/project failure/);
 assert.equal(store.state.lives.claude.id,before.lives.claude.id);assert.notEqual(store.state.lives.claude.operationId,before.lives.claude.operationId);assert.deepEqual(store.state.cards.claude,before.cards.claude);assert.deepEqual(store.state.relationships,before.relationships);assert.deepEqual(contents.claude,old);assert.equal(store.state.touchQuotas.claude.count,13);assert.equal(store.state.accountLedger.tokens,1250);assert.equal(store.state.cards.gpt.name,'GPT newer');assert.equal(store.state.lastLifeTransaction.status,'rolled-back');assert.equal(store.state.lifeTransaction,undefined);
});
test('two character switches cannot overwrite a single durable transaction or leave engine/store split',async t=>{
 let unblock;const held=new Promise(resolve=>{unblock=resolve;});let entered;const entry=new Promise(resolve=>{entered=resolve;});
 const {store,service,contents}=await setup(t,{hooks:{async quiesce(id){if(id==='claude'){entered();await held;}}}}),before=store.snapshot();const one=service.reset('claude',{mode:'blank'});await entry;
 const two=service.reset('gpt',{mode:'blank'});await assert.rejects(two,/正在|稍候|事务/);unblock();await one;
 assert.deepEqual(store.state.cards.gpt,before.cards.gpt);assert.equal(store.state.lives.gpt.id,before.lives.gpt.id);assert.equal(contents.gpt.player.level,4);assert.equal(store.state.lifeTransaction,undefined);
});
test('same-character save/reset is serialized and no archive count/restore-count quota exists',async t=>{
 let unblock;const held=new Promise(resolve=>{unblock=resolve;});let entered;const entry=new Promise(resolve=>{entered=resolve;});let hold=true;
 const {service}=await setup(t,{hooks:{async quiesce(){if(hold){hold=false;entered();await held;}}}});const pending=service.save('claude');await entry;await assert.rejects(service.reset('claude',{mode:'blank'}),/正在/);unblock();const first=await pending;
 for(let i=0;i<5;i++)await service.save('claude',{name:'snapshot '+i});assert.equal(service.list('claude').length,6);await service.restore(first.id);await service.restore(first.id);assert.equal(service.list('claude').length,8);
});
test('portable import adds independent archives without activating life or rewriting any live state',async t=>{
 const {store,service}=await setup(t),saved=await service.save('claude'),exported=service.export(saved.id),before=store.snapshot();const one=await service.import(exported.base64),two=await service.import(exported.base64);
 assert.notEqual(one.id,two.id);assert.notEqual(one.id,saved.id);for(const key of ['cards','personas','relationships','conversations','groups','lives','touchQuotas','accountLedger'])assert.deepEqual(store.state[key],before[key],key);assert.equal(service.list('claude').length,3);assert.equal(service.export(one.id).sha256,exported.sha256);
});
test('corrupt archive, bad base64 and missing restore target cannot change current life',async t=>{
 const {root,store,service}=await setup(t),saved=await service.save('claude'),before=store.snapshot();await assert.rejects(service.import('not-a-zip'),/编码/);await assert.rejects(service.restore('missing'),/不存在/);
 const path=join(root,'galgame','life-archives',saved.fileName),bytes=readFileSync(path);bytes[40]^=1;writeFileSync(path,bytes);await assert.rejects(service.restore(saved.id),/哈希不匹配/);assert.deepEqual(store.state,before);
});
test('failed rollback retains the prepared transaction; reopening retries it without discarding the archived source',async t=>{
 let failures=2;const {store,service,restart,contents}=await setup(t,{hooks:{call(action){if(action==='companion-life-project'&&failures-->0)throw Error('fixture projection temporarily unavailable');}}});
 const old=store.snapshot();await assert.rejects(service.reset('claude',{mode:'blank'}),/恢复待完成/);assert.equal(store.state.lives.claude.id,old.lives.claude.id);assert.equal(store.state.cards.claude.name,old.cards.claude.name);assert.ok(store.state.lifeTransaction);assert.equal(service.list('claude').length,1);const pending=copy(store.state.lifeTransaction);
 const reopened=await restart();assert.equal(store.state.lifeTransaction,undefined);assert.equal(store.state.lives.claude.id,pending.target.life.id);assert.equal(store.state.lives.claude.operationId,pending.operationId);assert.equal(store.state.lives.claude.mode,'blank');assert.equal(contents.claude.player.level,1);assert.equal(reopened.preview(pending.archiveId).life.id,old.lives.claude.id);assert.deepEqual(store.state.cards.gpt,old.cards.gpt);assert.deepEqual(store.state.accountLedger,old.accountLedger);
});
test('public archive preview never returns another Persona private raw lines via engine content or life memory',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ai-buddy-life-service-'));t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'ai-buddy-life-service-'));rmSync(root,{recursive:true,force:true});});
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(options){yield{type:'text-delta',text:/情绪分类器/.test(options.system)?'normal':/选项生成器/.test(options.system)?'{"positive":"继续","neutral":"稍后","negative":"休息"}':'fixture visible response'};yield{type:'finish',reason:{kind:'stop'}};}};
 const game=await createGalgame({dataRoot:root,provider,model:'fixture'});try{
  const card=(await game.action('companion-character-save',{name:'Archive scope fixture'})).card;await game.action('companion-character-select',{id:card.id});await game.action('chat',{text:'persona-A-raw-visible'});await presentedState(game);
  const b=(await game.action('companion-persona-save',{name:'Fixture B'})).persona;await game.action('companion-persona-select',{id:b.id});await game.action('chat',{text:'persona-B-private-never-preview-to-A-79231'});await presentedState(game);
  const saved=(await game.action('companion-life-save',{characterId:card.id})).archive;await game.action('companion-persona-select',{id:'default'});const preview=(await game.action('companion-life-preview',{id:saved.id})).preview;
  assert.equal(preview.conversations.every(row=>row.personaId==='default'),true);assert.equal(JSON.stringify(preview).includes('persona-A-raw-visible'),true);assert.equal(JSON.stringify(preview).includes('persona-B-private-never-preview-to-A-79231'),false);assert.equal(preview.life.memory,undefined);
 }finally{game.close();}
});
