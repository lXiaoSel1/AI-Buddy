import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {createGalgame} from '../src/galgame-host.mjs';

async function until(check) {
  for (let attempt=0;attempt<100;attempt++) {
    const result=await check();
    if(result)return result;
    await pause(20);
  }
  throw Error('host voice scenario timed out');
}

async function fixture(t, stream) {
  const root=await mkdtemp(join(tmpdir(),'buddy-host-voice-'));
  const segments=[], finishes=[];
  const voice={
    admit:()=>({epoch:4,voiceProfileVersion:9}),
    segment:event=>segments.push(event),
    finish:event=>finishes.push(event),
  };
  const provider={
    enabled:true,currentSelection:()=>({provider:'fixture',model:'m'}),listModels:()=>[{id:'m'}],listProviders:()=>[{id:'fixture'}],runTurn:fn=>fn(),
    async *stream(options) {
      if(options.purpose==='choices')yield {type:'text-delta',text:'{"positive":"好","neutral":"继续","negative":"等等"}'};
      else yield*stream(options);
      yield {type:'finish',reason:{kind:'stop'}};
    }
  };
  let game=await createGalgame({dataRoot:root,provider,model:'m',voice});
  t.after(async()=>{await game.close();await rm(root,{recursive:true,force:true});});
  return {game,segments,finishes,async restart(){await game.close();game=await createGalgame({dataRoot:root,provider,model:'m',voice});return game;}};
}
const line=value=>({type:'text-delta',text:JSON.stringify(value)+'\n'});
const segment=text=>line({type:'segment',text,performance:{emotion:'happy',strength:'mild',delivery:'温柔地开心。'},personaId:'forged',epoch:99});
const control=line({type:'control',emotion:'cheerful',interactionTarget:'group',affectionTarget:'none',affection:1});

test('host voice submission is durable, uses the existing model once and preserves trusted reply identity',async t=>{
  let calls=0;
  const {game,segments,finishes,restart}=await fixture(t,async function*(options){
    if(!options.system.includes('逐行 JSON'))return;
    calls++;
    assert.match(options.system,/当前自己的心情/);
    assert.match(options.system,/逐行 JSON/);
    yield segment('角色原文。');
    yield control;
  });
  const scope=game.voiceScope();
  assert.equal(scope.channel,'app-private');
  const payload={scope,text:'本次最终识别',submissionId:'capture-1'};
  const [first,second]=await Promise.all([game.voiceSubmit(payload),game.voiceSubmit(payload)]);
  assert.equal(first.messageId,second.messageId);
  await until(()=>finishes.length);
  const envelope=segments[0].envelope;
  assert.equal(envelope.personaId,scope.personaId);
  assert.equal(envelope.epoch,4);
  assert.equal(envelope.voiceProfileVersion,9);
  assert.equal(envelope.moodVersion,0);
  assert.equal(envelope.index,0);
  const original=await game.action('view');
  assert.equal(original.companion.messages.filter(row=>row.role==='user').length,1);
  assert.equal(original.companion.messages.at(-1).text,'角色原文。');
  assert.equal(original.companion.messages.at(-1).emotion,'cheerful');
  assert.equal((await game.action('companion-private-present',{conversationId:scope.conversationId,id:envelope.messageId})).presentationDeferred,true);
  await assert.rejects(game.action('chat',{text:'不能抢断正在播放的上一句'}),/配音播放完成|先停止语音/);
  assert.deepEqual(await game.voiceReceipt({envelope:{...envelope,lifeId:'forged'},status:'audioCompleted'}),{accepted:false,ready:false});
  await game.voiceReceipt({envelope,status:'textDisplayed'});
  await game.voiceReceipt({envelope,status:'audioStarted'});
  assert.equal((await game.voiceReceipt({envelope,status:'audioCompleted',playedMs:470})).ready,true);
  await game.action('companion-private-present',{conversationId:scope.conversationId,id:envelope.messageId});
  const restarted=await restart();
  const repeated=await restarted.voiceSubmit({...payload,scope:restarted.voiceScope()});
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.messageId,first.messageId);
  assert.equal(calls,1);
  const saved=(await restarted.action('view')).companion.messages.at(-1);
  assert.equal(saved.presentation,'presented');
  assert.deepEqual(saved.voicePresentation.map(row=>row.status),['textDisplayed','audioStarted','audioCompleted']);
  assert.equal(saved.voicePresentation.at(-1).playedMs,470);
  assert.deepEqual(saved.voicePresentation.at(-1).textRange,{start:0,end:'角色原文。'.length});
});

test('host group presentation waits for the current audio and preserves silent/control semantics',async t=>{
  const {game,segments}=await fixture(t,async function*(options){
    assert.match(options.system,/第一行只写/);
    yield line({type:'decision',speak:true});
    yield segment('甲的台词。');
    yield control;
  });
  const created=await game.action('companion-group-save',{name:'顺序测试',memberIds:['deepseek','gemini'],mode:'list'});
  const id=created.group.id;
  await game.action('companion-group-select',{id});
  const scope=game.voiceScope();
  assert.equal(scope.channel,'app-group');
  assert.equal(scope.conversationId,id);
  await game.voiceSubmit({scope,text:'你好',submissionId:'group-capture-1'});
  const pending=await until(async()=> (await game.action('view')).companion.groupRuntime.pendingMessage);
  assert.equal(segments[0].envelope.characterId,pending.characterId);
  assert.equal(pending.interactionTarget,'group');
  assert.equal(pending.affectionTarget,'none');
  assert.equal((await game.action('companion-group-present',{id,requestId:pending.id})).presentationDeferred,true);
  await game.action('companion-group-continue',{id});
  assert.equal((await game.action('view')).companion.groupMessages.length,1);
  await game.voiceReceipt({envelope:segments[0].envelope,status:'audioStarted'});
  await game.voiceReceipt({envelope:segments[0].envelope,status:'audioCompleted'});
  await game.action('companion-group-present',{id,requestId:pending.id});
  const presented=(await game.action('view')).companion.groupMessages.at(-1);
  assert.equal(presented.text,'甲的台词。');
  assert.deepEqual(presented.voicePresentation.map(row=>row.status),['audioStarted','audioCompleted']);
});

