import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalgame} from '../src/galgame-host.mjs';
import {galgamePresentationSettings,galgameReplySentences} from '../src/galgame-expressions.mjs';
import {tmpDir} from './support/audit-harness.mjs';

test('one group presentation preference controls all speakers without changing private chats',async t=>{
 let game;
 const dataRoot=tmpDir('galgame-group-presentation',{t,beforeRemove:()=>game?.close()});
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'m'}),listProviders:()=>[],listModels:()=>[],runTurn:fn=>fn(),
  async *stream({purpose}){
   const text=purpose==='group-chat'?JSON.stringify({text:'[[emotion:gentle]]A。[[emotion:shy]]B。',emotion:'serious',affection:0}):'{"changed":false}';
   yield {type:'text-delta',text};
   yield {type:'finish',reason:{kind:'stop'}};
  },
 };
 game=await createGalgame({dataRoot,provider,model:'m',r95Options:{tickAllowed:()=>false}});
 const members=['deepseek','claude','chatgpt'];
 const defaults={dialogueStyle:'frameless',fontScale:1,expressionMode:'sentence',expressionMotion:true};
 const privateSettings={dialogueStyle:'classic',fontScale:.85,expressionMode:'sentence',expressionMotion:true};
 const groupSettings={dialogueStyle:'classic',fontScale:1.15,expressionMode:'reply',expressionMotion:false};
 await game.action('companion-settings',{characterId:members[0],...privateSettings});
 const {group}=await game.action('companion-group-save',{name:'配置检查',memberIds:members,mode:'list'});
 await game.action('companion-group-select',{id:group.id});
 const key='group:'+group.id;
 const readSettings=async()=>(await game.action('companion-state')).companion.settings;
 assert.deepEqual(galgamePresentationSettings(await readSettings(),key),defaults);
 await game.action('companion-settings',{groupId:group.id,...groupSettings});
 const saved=await readSettings();
 assert.deepEqual(galgamePresentationSettings(saved,key),groupSettings);
 assert.deepEqual(galgamePresentationSettings(saved,members[0]),privateSettings);
 assert.deepEqual(galgamePresentationSettings(saved,members[1]),defaults);
 await assert.rejects(game.action('companion-settings',{groupId:'missing',expressionMode:'sentence'}));
 await game.action('companion-group-send',{id:group.id,text:'检查三位发言人'});
 for(const characterId of members){
  let reply;
  for(let attempt=0;attempt<200&&!reply;attempt++){
   const {groupRuntime}=(await game.action('companion-state')).companion;
   assert.notEqual(groupRuntime.status,'failed',groupRuntime.error);
   reply=groupRuntime.pendingMessage;
   if(!reply)await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(reply?.characterId,characterId);
  const settings=galgamePresentationSettings(await readSettings(),key);
  assert.deepEqual(galgameReplySentences(reply,settings.expressionMode).map(row=>row.emotion),['serious','serious']);
  await game.action('companion-group-present',{id:group.id,requestId:reply.id});
  await game.action('companion-group-continue',{id:group.id});
 }
 await game.action('companion-group-close',{id:group.id});
 await assert.rejects(game.action('companion-settings',{groupId:group.id,expressionMode:'sentence'}));
 assert.deepEqual(galgamePresentationSettings(await readSettings(),members[0]),privateSettings);
});
