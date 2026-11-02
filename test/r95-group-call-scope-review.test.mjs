import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGalgame} from '../src/galgame-host.mjs';

const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const state=async game=>(await game.action('companion-state')).companion;
async function until(fn){for(let i=0;i<500;i++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('scope review fixture timed out');}
const secrets=['A私聊暗号','私聊中真正呈现的秘密','B群私密暗号','B用户私密问题','Claude缺席期间的秘密','缺席期讨论','没有呈现的草稿秘密'];

test('R95 captured group-chat excludes all original secrets while delayed B mood keeps only its original full scope',async t=>{
 const root=mkdtempSync(join(tmpdir(),'r95-group-scope-review-')),calls=[],metadata=new AsyncLocalStorage(),routes=new AsyncLocalStorage(),held=gate(),release=gate();let game,heldPersona,reply='玩家，谢谢你来参加讨论。';
 const provider={enabled:true,withRequestContext:(value,fn)=>metadata.run(value,fn),currentSelection:()=>({provider:routes.getStore()??'global',model:(routes.getStore()??'global')+'-model'}),listProviders:()=>[{id:'global'}],listModels:()=>[{id:'global-model'}],resolveConnection:binding=>({id:binding?.enabled?binding.connectionId:'global'}),runTurn:async(fn,_signal,options)=>{const context=metadata.getStore();if(options?.background&&heldPersona&&context?.scope.personaId===heldPersona){held.resolve();await release.promise;}return routes.run('global',fn);},runProfile:(id,fn)=>routes.run(id,fn),async *stream(options){
  const {signal,...raw}=options,request=JSON.parse(JSON.stringify(raw)),scope=request.scope??metadata.getStore()?.scope??null;calls.push({index:calls.length,purpose:options.purpose??null,scope:structuredClone(scope),activeScope:game?.r95.activeScope(),request});
  const output=options.purpose==='mood'?{changed:false}:options.purpose==='group-chat'?{text:reply,affection:0}:options.purpose==='choices'?{positive:'好',neutral:'嗯',negative:'等等'}:'私聊中真正呈现的秘密。';yield {type:'text-delta',text:typeof output==='string'?output:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}};
 }};
 game=await createGalgame({dataRoot:root,provider,model:'fixture'});
 t.after(async()=>{release.resolve();await game.close();writeFileSync(process.env.R95_SCOPE_TRACE_PATH??join(root,'scope-trace.json'),JSON.stringify({level:'real-Galgame-service-Mock-model',calls},null,2)+'\n');rmSync(root,{recursive:true,force:true});});
 const a=(await game.action('companion-group-save',{name:'原默认群',memberIds:['deepseek','claude','chatgpt'],mode:'list'})).group;
 async function pending(){return until(async()=>{const value=await state(game);assert.notEqual(value.groupRuntime.status,'failed',value.groupRuntime.error);return value.groupRuntime.pendingMessage;});}
 async function present(){const value=await pending();await game.action('companion-group-present',{requestId:value.id});return value;}
 await game.action('companion-character-select',{id:'claude'});await game.action('chat',{text:'A私聊暗号，不能转到群里'});const privateState=await state(game);await game.action('companion-private-present',{conversationId:privateState.activeConversationId,id:privateState.messages.at(-1).id});
 const persona=(await game.action('companion-persona-save',{name:'另一个身份'})).persona;heldPersona=persona.id;await game.action('companion-persona-select',{id:persona.id});const b=(await game.action('companion-group-save',{name:'身份B秘密',personaId:persona.id,memberIds:['deepseek','claude'],mode:'list'})).group;await game.action('companion-group-select',{id:b.id});reply='B群私密暗号';await game.action('companion-group-send',{text:'B用户私密问题',forceCharacterId:'deepseek'});await present();
 const bScope=game.r95.scopeFor('deepseek',persona.id,'app-group',b.id),oldMood=game.r95.evaluatePending(bScope);await held.promise;
 await game.action('companion-group-close');await game.action('companion-persona-select',{id:'default'});await game.action('companion-group-select',{id:a.id});await game.action('companion-group-member',{characterId:'claude',op:'leave'});reply='Claude缺席期间的秘密';await game.action('companion-group-send',{text:'缺席期讨论',forceCharacterId:'deepseek'});await present();await game.action('companion-group-member',{characterId:'claude',op:'join'});
 reply='没有呈现的草稿秘密';await game.action('companion-group-send',{text:'可知的用户信息',forceCharacterId:'deepseek'});await pending();await game.action('companion-group-stop');reply='现在请继续';await game.action('companion-group-send',{text:'重新加入后的公开信息',forceCharacterId:'claude'});const current=await pending();
 const groupCall=calls.filter(row=>row.purpose==='group-chat').at(-1),payload=JSON.stringify(groupCall.request);assert.equal(current.characterId,'claude');assert.equal(groupCall.scope.characterId,'claude');assert.equal(groupCall.scope.personaId,'default');assert.equal(groupCall.scope.channel,'app-group');assert.equal(groupCall.scope.conversationId,a.id);
 for(const secret of secrets)assert.equal(payload.includes(secret),false,secret);assert.match(payload,/重新加入后的公开信息/);assert.match(payload,/可知的用户信息/);
 release.resolve();await oldMood;await until(()=>calls.find(row=>row.index>groupCall.index&&row.purpose==='mood'&&row.scope?.conversationId===b.id));
 const moodCalls=calls.filter(row=>row.purpose==='mood');assert.ok(moodCalls.length>0);
 for(const row of moodCalls){const input=JSON.parse(row.request.messages.at(-1).content[0].text);assert.deepEqual(input.scope,row.scope);for(const event of input.events??[])assert.deepEqual(event.scope,row.scope);const body=JSON.stringify(row.request);if(body.includes('B群私密暗号')||body.includes('B用户私密问题')){assert.equal(row.scope.personaId,persona.id);assert.equal(row.scope.channel,'app-group');assert.equal(row.scope.conversationId,b.id);}if(row.scope.channel==='app-group')for(const secret of secrets.slice(0,2))assert.equal(body.includes(secret),false,secret);if(row.scope.characterId==='claude'&&row.scope.conversationId===a.id)for(const secret of ['Claude缺席期间的秘密','缺席期讨论','没有呈现的草稿秘密'])assert.equal(body.includes(secret),false,secret);}
});
