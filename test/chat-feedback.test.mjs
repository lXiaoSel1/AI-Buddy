import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {EMOTION_KEYS} from '../src/emotions.mjs';

test('A committed reply delivers its label before choices, and historical views do not classify again',async()=>{
  const root=join(import.meta.dirname,'../local/test-runs','chat-event-'+Date.now());
  let calls=0,choicesStarted=false,releaseChoices;const events=[];
  const gate=new Promise(resolve=>releaseChoices=resolve);
  const provider={enabled:true,listProviders:()=>[{id:'codex',name:'Codex'}],listModels:()=>[{id:'gpt-6.1-sol'}],async *stream(options){
    calls++;
    const classify=/情绪分类器/.test(options.system),choices=/选项生成器/.test(options.system);
    if(choices){choicesStarted=true;await gate;}
    yield {type:'text-delta',text:classify?'normal':choices?'{"positive":"休息","neutral":"聊聊","negative":"安静"}':'听到啦。我们慢慢来。'};
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  let game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol',onChatCommitted:value=>events.push(value)});
  const pending=game.action('chat',{text:'你好棒'});
  for(let n=0;n<100&&!choicesStarted;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(choicesStarted,true);assert.equal(events.length,1);assert.equal(events[0].emotion,'normal');assert.equal(events[0].emotionSource,'fallback');assert.equal(events[0].characterId,'deepseek');assert.ok(events[0].messageId);assert.equal(events[0].text,'听到啦。我们慢慢来。');
  releaseChoices();await pending;assert.equal(calls,2);
  const view=await game.action('view');assert.ok(JSON.stringify(view).includes('"emotionSource":"fallback"'));assert.equal(calls,2);game.close();
  game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol',onChatCommitted:value=>events.push(value)});
  await game.action('view');assert.equal(calls,2);assert.equal(events.length,1);game.close();
});

test('Every original emotion reaches the committed event exactly once with its recorded source',async()=>{
  const root=join(import.meta.dirname,'../local/test-runs','all-emotions-'+Date.now()),events=[];let label='normal',calls=0;
  const provider={enabled:true,resolveContextCapacity:()=>({tokens:128000,source:'test-interface',verified:true}),listProviders:()=>[{id:'codex'}],listModels:()=>[{id:'gpt-6.1-sol'}],async *stream(options){calls++;yield {type:'text-delta',text:/情绪分类器/.test(options.system)?label:/选项生成器/.test(options.system)?'{"positive":"休息","neutral":"聊聊","negative":"安静"}':'听到了。[[emotion:'+label+']]'};yield {type:'finish',reason:{kind:'stop'}};}};
  const game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol',onChatCommitted:value=>events.push(value)});
  for(const emotion of [...EMOTION_KEYS,'normal']){label=emotion;const before=calls;await game.action('chat',{text:'普通输入'});assert.equal(calls-before,2);assert.equal(events.at(-1).emotion,emotion);assert.equal(events.at(-1).emotionSource,'structured');assert.equal(events.at(-1).role,'heroine');}
  assert.equal(new Set(events.map(value=>value.messageId)).size,9);
  label='not-an-emotion';await game.action('chat',{text:'太过分了'});assert.equal(events.at(-1).emotion,'normal');assert.equal(events.at(-1).emotionSource,'fallback');
  await game.action('chat',{text:'今天几点？'});assert.equal(events.at(-1).emotion,'normal');assert.equal(events.at(-1).emotionSource,'fallback');
  const before=calls;await game.action('view');assert.equal(calls,before);game.close();
});
