import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {CgThemePlanner} from '../src/cg-theme.mjs';
import {presentedState} from './support/presented-state.mjs';

async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'buddy-photo-planner-')),photos=[],calls=[];
 const provider={enabled:true,state:{activeId:'global',profiles:[
  {id:'global',name:'全局连接',kind:'custom',model:'global-model',reasoningEffort:'low'},
  {id:'cheap',name:'便宜策划',kind:'codex',model:'cheap-model',reasoningEffort:'medium'},
  {id:'entry',name:'角色连接',kind:'custom',model:'entry-model'}
 ]},selected(){return this.state.profiles.find(p=>p.id===this.state.activeId);},currentSelection(){return {provider:this.selected().id,model:this.selected().model};},
 listProviders(){return this.state.profiles;},listModels(){return [{id:'global-model'}];},runTurn:async fn=>fn(),runProfile:async(id,fn)=>fn(),
 resolveConnection(binding){const p=binding?.enabled?this.state.profiles.find(p=>p.id===binding.connectionId):this.selected();return {connectionId:p?.id??binding?.connectionId,name:p?.name,model:p?.model,error:!p?'连接已删除':p.enabled===false?'连接已停用':p.capabilities?.chat===false?'不支持聊天':!p.model?'未设置模型':null};},
 async *stream(o){calls.push(o);yield {type:'text-delta',text:'{"text":"一起讨论晚餐。","emotion":"cheerful","affection":0}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const cg={available:()=>true,enabled:false,subscribe:()=>()=>{},validateReferences:async()=>[],enqueue:async job=>{photos.push(structuredClone(job));return job;},themePlanner:new CgThemePlanner(provider)};
 let game=await createGalgame({dataRoot:root,provider,model:'global-model',cg});
 const group=(await game.action('companion-group-save',{name:'策划测试群',memberIds:['deepseek'],mode:'list'})).group;
 await game.action('companion-group-select',{id:group.id});
 return {root,provider,group,calls,photos,cg,get game(){return game;},async restart(){game.close();game=await createGalgame({dataRoot:root,provider,model:'global-model',cg});},async presented(){await game.action('companion-group-send',{text:'讨论晚餐'});for(let i=0;i<300;i++){if((await presentedState(game)).groupRuntime.status==='idle')return;await new Promise(r=>setTimeout(r,5));}throw Error('Presentation timed out');}};
}

test('A group saves its planner without model calls, survives restart/export/import, and leaves global/card bindings unchanged',async()=>{
 const f=await fixture();try{
  const before=(await f.game.action('companion-state')).companion,other=(await f.game.action('companion-group-save',{name:'另一个群',memberIds:['claude']})).group;
  const result=await f.game.action('companion-group-photo-planner',{id:f.group.id,binding:{enabled:true,connectionId:'cheap'}});
  assert.equal(result.photoPlanner.effective.model,'cheap-model');assert.equal(result.photoPlanner.effective.reasoningEffort,'medium');assert.equal(f.calls.length,0);assert.equal(f.photos.length,0);
  assert.equal(f.provider.state.activeId,'global');assert.deepEqual(result.companion.characters.map(c=>c.modelBinding),before.characters.map(c=>c.modelBinding));
  assert.equal(result.companion.groups.find(g=>g.id===other.id).photoPlannerBinding,undefined);
  await f.restart();const saved=(await f.game.action('companion-state')).companion.groups.find(g=>g.id===f.group.id);assert.deepEqual(saved.photoPlannerBinding,{enabled:true,connectionId:'cheap'});
  const exported=(await f.game.action('companion-group-export',{id:f.group.id})).data;
  // A real single-group export restores the preference as a reference, without copying credentials.
  const restored=await createGalgame({dataRoot:mkdtempSync(join(tmpdir(),'buddy-photo-import-')),provider:f.provider,model:'global-model',cg:f.cg});
  try{await restored.action('companion-conversation-import',{data:exported});const groups=(await restored.action('companion-state')).companion.groups;assert.deepEqual(groups[0].photoPlannerBinding,saved.photoPlannerBinding);}finally{restored.close();}
 }finally{f.game.close();}
});

test('New photo captures the explicit model/effort, next selection cannot rewrite an old job, automatic photo uses saved selection',async()=>{
 const f=await fixture();try{
  await f.presented();const preview=(await f.game.action('companion-group-photo-preview',{id:f.group.id})).photo;assert.equal(preview.planner.effective.model,'global-model');
  const first=await f.game.action('companion-group-photo',{id:f.group.id,plannerBinding:{enabled:true,connectionId:'cheap'}});
  assert.equal(f.photos[0].themeConnection.profile.id,'cheap');assert.equal(f.photos[0].themeConnection.profile.reasoningEffort,'medium');
  await f.game.action('companion-group-photo-planner',{id:f.group.id,binding:{enabled:true,connectionId:'global'}});
  assert.equal(f.photos[0].themeConnection.profile.id,'cheap');assert.equal(f.provider.state.activeId,'global');
  const reused=await f.game.action('companion-group-photo',{id:f.group.id});assert.equal(reused.photo.cgId,first.photo.cgId);assert.equal(f.photos.length,1);
  await f.game.action('companion-group-photo',{id:f.group.id,regenerate:true,clientRequestId:'new-model'});assert.equal(f.photos[1].themeConnection.profile.id,'global');
  await f.game.action('companion-group-end',{id:f.group.id});await f.game.action('companion-group-save',{id:f.group.id,autoPhoto:true});await f.presented();await f.game.action('companion-group-end',{id:f.group.id});assert.equal(f.photos.length,3);assert.equal(f.photos[2].themeConnection.profile.id,'global');
 }finally{f.game.close();}
});

test('Offline and deleted explicit planners reject before CG queueing; automatic keeps the existing local fallback route',async()=>{
 const f=await fixture();try{
  await f.presented();await f.game.action('companion-group-photo-planner',{id:f.group.id,binding:{enabled:true,connectionId:'cheap'}});
  f.provider.enabled=false;await assert.rejects(()=>f.game.action('companion-group-photo',{id:f.group.id}),/提示词策划|联网/);assert.equal(f.photos.length,0);
  f.provider.state.profiles=f.provider.state.profiles.filter(p=>p.id!=='cheap');
  const p=(await f.game.action('companion-group-photo-preview',{id:f.group.id})).photo.planner;assert.match(p.effective.error,/提示词策划/);
  await assert.rejects(()=>f.game.action('companion-group-photo',{id:f.group.id}),/提示词策划/);assert.equal(f.photos.length,0);
  await f.game.action('companion-group-photo-planner',{id:f.group.id,binding:{enabled:false,connectionId:null}});
  await f.game.action('companion-group-photo',{id:f.group.id});assert.equal(f.photos.length,1);assert.equal(f.photos[0].themeConnection.enabled,false);
 }finally{f.game.close();}
});

test('Planning profile is frozen before asynchronous reference validation and cannot change model or effort in flight',async()=>{
 const f=await fixture();try{
  await f.presented();
  f.cg.validateReferences=async()=>{await Promise.resolve();const p=f.provider.state.profiles.find(p=>p.id==='cheap');p.model='changed-later';p.reasoningEffort='high';f.provider.state.profiles=f.provider.state.profiles.filter(p=>p.id!=='cheap');};
  await f.game.action('companion-group-photo',{id:f.group.id,plannerBinding:{enabled:true,connectionId:'cheap'}});
  assert.equal(f.photos.length,1);assert.equal(f.photos[0].themeConnection.enabled,true);assert.equal(f.photos[0].themeConnection.profile.model,'cheap-model');assert.equal(f.photos[0].themeConnection.profile.reasoningEffort,'medium');
 }finally{f.game.close();}
});
