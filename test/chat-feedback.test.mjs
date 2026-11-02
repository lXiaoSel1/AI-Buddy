import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {EMOTION_KEYS} from '../src/emotions.mjs';
import {waitForReplyChoices} from './support/reply-ready.mjs';

test('A committed reply delivers its label before choices, and historical views do not classify again',async()=>{
  const root=join(import.meta.dirname,'../local/test-runs','chat-event-'+Date.now());
  let calls=0,choicesStarted=false,releaseChoices;const events=[],moodCalls=[];
  const gate=new Promise(resolve=>releaseChoices=resolve);
  const provider={enabled:true,currentSelection:()=>({provider:'codex',model:'gpt-6.1-sol'}),listProviders:()=>[{id:'codex',name:'Codex'}],listModels:()=>[{id:'gpt-6.1-sol'}],async *stream(options){
    if(options.purpose==='mood'){moodCalls.push(options);assert.ok(events.length>0,'the original chat must commit before its mood assessment');yield{type:'text-delta',text:'{"changed":false}'};yield{type:'finish',reason:{kind:'stop'}};return;}
    calls++;
    const classify=/情绪分类器/.test(options.system),choices=/选项生成器/.test(options.system);
    if(choices){choicesStarted=true;await gate;}
    yield {type:'text-delta',text:classify?'normal':choices?'{"positive":"休息","neutral":"聊聊","negative":"安静"}':'听到啦。我们慢慢来。'};
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  let game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol',onChatCommitted:value=>events.push(value)});await game.action('settings-set',{characterMode:'manual',characterId:'deepseek'});
  const pending=game.action('chat',{text:'你好棒'});
  for(let n=0;n<100&&!choicesStarted;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(choicesStarted,true);assert.equal(events.length,1);assert.equal(events[0].emotion,'normal');assert.equal(events[0].emotionSource,'fallback');assert.equal(events[0].characterId,'deepseek');assert.ok(events[0].messageId);assert.equal(events[0].text,'听到啦。我们慢慢来。');
  releaseChoices();await pending;await waitForReplyChoices(game);assert.equal(calls,2);assert.equal(moodCalls.length,1);assert.equal(moodCalls[0].scope.characterId,'deepseek');assert.equal(moodCalls[0].scope.personaId,'default');assert.ok(moodCalls[0].scope.lifeId&&moodCalls[0].scope.operationId&&moodCalls[0].activityOriginId);
  const view=await game.action('view');assert.ok(JSON.stringify(view).includes('"emotionSource":"fallback"'));assert.equal(calls,2);await game.close();
  game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol',onChatCommitted:value=>events.push(value)});await game.action('settings-set',{characterMode:'manual',characterId:'deepseek'});
  await game.action('view');assert.equal(calls,2);assert.equal(events.length,1);await game.close();
});

test('Every original emotion reaches the committed event exactly once with its recorded source',async()=>{
  const root=join(import.meta.dirname,'../local/test-runs','all-emotions-'+Date.now()),events=[],moodCalls=[];let label='normal',calls=0;
  const provider={enabled:true,currentSelection:()=>({provider:'codex',model:'gpt-6.1-sol'}),resolveContextCapacity:()=>({tokens:128000,source:'test-interface',verified:true}),listProviders:()=>[{id:'codex'}],listModels:()=>[{id:'gpt-6.1-sol'}],async *stream(options){if(options.purpose==='mood'){moodCalls.push(options);assert.ok(events.length>0,'mood cannot precede a committed chat');yield{type:'text-delta',text:'{"changed":false}'};yield{type:'finish',reason:{kind:'stop'}};return;}calls++;yield {type:'text-delta',text:/情绪分类器/.test(options.system)?label:/选项生成器/.test(options.system)?'{"positive":"休息","neutral":"聊聊","negative":"安静"}':'听到了。[[emotion:'+label+']]'};yield {type:'finish',reason:{kind:'stop'}};}};
  const game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol',onChatCommitted:value=>events.push(value)});await game.action('settings-set',{characterMode:'manual',characterId:'deepseek'});
  for(const emotion of [...EMOTION_KEYS,'normal']){label=emotion;const before=calls;await game.action('chat',{text:'普通输入'});assert.equal(calls-before,1);assert.equal(events.at(-1).emotion,emotion);assert.equal(events.at(-1).emotionSource,'structured');assert.equal(events.at(-1).role,'heroine');await waitForReplyChoices(game);assert.equal(calls-before,2);}
  assert.equal(new Set(events.map(value=>value.messageId)).size,9);assert.ok(moodCalls.length>0);assert.ok(moodCalls.every(row=>row.scope.characterId==='deepseek'&&row.scope.personaId==='default'&&row.scope.lifeId&&row.scope.operationId&&row.activityOriginId));
  label='not-an-emotion';await game.action('chat',{text:'太过分了'});assert.equal(events.at(-1).emotion,'normal');assert.equal(events.at(-1).emotionSource,'fallback');await waitForReplyChoices(game);
  await game.action('chat',{text:'今天几点？'});assert.equal(events.at(-1).emotion,'normal');assert.equal(events.at(-1).emotionSource,'fallback');await waitForReplyChoices(game);
  const before=calls;await game.action('view');assert.equal(calls,before);await game.close();
});
