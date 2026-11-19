import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalgame} from '../src/galgame-host.mjs';
import {presentedState} from './support/presented-state.mjs';
import {gate,tmpDir} from './support/audit-harness.mjs';

async function fixture(t,{language='zh-CN',taggedReply,groupReply,splitReply=false,voice}={}){
 const priorZone=process.env.TZ;
 process.env.TZ='America/New_York';
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2042-04-06T23:59:00-04:00')});
 let game,modelGate,selectionGate;
 const dataRoot=tmpDir('galgame-clock',{t,beforeRemove:()=>game?.close()});
 t.after(()=>{if(priorZone===undefined)delete process.env.TZ;else process.env.TZ=priorZone;});
 const connection={id:'clock-stub',model:'fixture-chat',kind:'custom',contextTokens:272000};
 const calls=[],events=[],chatCommits=[];
 const provider={
  enabled:true,currentSelection:()=>({provider:connection.id,model:connection.model}),listProviders:()=>[],listModels:()=>[],
  captureConnection:()=>connection,resolveSearchCapability:()=>({supported:false}),
  async runTurn(fn){
   if(modelGate){const wait=modelGate;modelGate=undefined;wait.entered.resolve();await wait.release.promise;}
   return fn();
  },
  runCaptured(_profile,fn){return provider.runTurn(fn);},
  async resolveModelInfo(){
   if(selectionGate){const wait=selectionGate;selectionGate=undefined;wait.entered.resolve();await wait.release.promise;}
  },
  async *stream(request){
   calls.push(request);
   const reply=request.purpose==='group-chat'?(groupReply??(taggedReply?JSON.stringify({text:taggedReply,emotion:'serious',affection:0}):'{"text":"群聊回复","emotion":"normal","affection":0}')):
    request.purpose==='mood'?'{"changed":false}':
    request.scope?'{"speak":true,"mode":"awake","text":"自然招呼"}':
    /选项生成器/.test(request.system)?'{"positive":"继续","neutral":"等等","negative":"稍后"}':(taggedReply??'固定角色回复');
   for(const text of splitReply?[...reply]:[reply])yield {type:'text-delta',text};
   yield {type:'finish',reason:{kind:'stop'}};
  },
 };
 game=await createGalgame({dataRoot,provider,model:connection.model,getLanguage:()=>language,voice,onOutput:event=>events.push(event),onChatCommitted:event=>chatCommits.push(event),
  r95Options:{tickAllowed:()=>false,getTimeZone:()=> 'UTC',getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:1})}});
 return {game,calls,events,chatCommits,holdNextModel:()=>modelGate={entered:gate(),release:gate()},holdModelSelection:()=>selectionGate={entered:gate(),release:gate()}};
}

function systemLine(request,label='当前本地时间：'){
 return request?.system.split('\n').find(line=>line.startsWith(label));
}

test('private Galgame reply receives the current system-local date, weekday, time and zone',async t=>{
 const {game,calls}=await fixture(t);
 await game.action('chat',{text:'昨天在故事里，才下午三点。现在呢？'});
 const request=calls.find(row=>!row.purpose&&row.incremental);
 const expected='当前本地时间：2042-04-06（星期日）23:59（America/New_York）';
 assert.equal(systemLine(request),expected);
 assert.ok(request.messages.some(row=>row.content.some(part=>part.text==='昨天在故事里，才下午三点。现在呢？')));
 assert.ok(!JSON.stringify(request.messages).includes(expected));
 const state=await presentedState(game);
 assert.ok(state.messages.some(row=>row.text==='固定角色回复'));
 assert.ok(!JSON.stringify(state.messages).includes(expected));
});

test('private Galgame samples the clock after asynchronous model selection', {timeout:5000}, async t=>{
 const {game,calls,holdModelSelection}=await fixture(t);
 const selection=holdModelSelection(),chat=game.action('chat',{text:'现在几点？'});
 try{
  await selection.entered.promise;
  t.mock.timers.tick(120000);
  process.env.TZ='Asia/Shanghai';
 }finally{selection.release.resolve();}
 await chat;
 assert.equal(systemLine(calls.find(row=>!row.purpose&&row.incremental)),'当前本地时间：2042-04-07（星期一）12:01（Asia/Shanghai）');
});

async function waitForCall(calls,predicate){
 for(let n=0;n<200;n++){
  const call=calls.find(predicate);if(call)return call;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.fail('No model request reached the local fixture');
}

test('manual and Auto Galgame turns use the system clock when each member starts speaking', {timeout:5000}, async t=>{
 const {game,calls,holdNextModel}=await fixture(t);
 const scene='剧情时间是2001-01-01 15:00。';
 const {group}=await game.action('companion-group-save',{name:'时钟测试',scene,memberIds:['deepseek'],mode:'list'});
 await game.action('companion-group-select',{id:group.id});
 await game.action('companion-group-send',{id:group.id,text:'按这个剧情继续。',forceCharacterId:'deepseek'});
 const manual=await waitForCall(calls,row=>row.purpose==='group-chat');
 assert.equal(systemLine(manual),'当前本地时间：2042-04-06（星期日）23:59（America/New_York）');
 assert.ok(manual.system.includes(scene));
 await game.action('companion-group-stop',{id:group.id});

 await game.r95.action('social-settings',{auto:true});
 await game.r95.auto.start({groupId:group.id,scope:game.r95.activeScope(),authorizationId:'clock-auto-probe',mode:'rounds',rounds:2,memberIds:['deepseek']});
 const queue=holdNextModel();
 const next=game.r95.auto.next({groupId:group.id});
 try{
  await queue.entered.promise;
  t.mock.timers.tick(120000);
 }finally{queue.release.resolve();}
 await next;
 const automatic=await waitForCall(calls,row=>row.purpose==='group-chat'&&row!==manual);
 assert.equal(systemLine(automatic),'当前本地时间：2042-04-07（星期一）00:01（America/New_York）');
 assert.ok(automatic.system.includes(scene));
});

test('Galgame proactive greeting and self-talk get fresh local time, including after a queued midnight', {timeout:5000}, async t=>{
 const {game,calls,holdNextModel}=await fixture(t,{language:'en'});
 await game.r95.action('social-settings',{proactive:true,selfTalk:true});
 const scope=game.r95.activeScope();
 await game.r95.userInteraction({scope,eventId:'clock-probe-event',kind:'chat',text:'I am back.'});
 const {candidates}=game.r95.proactive.view({scope});
 const greeting=candidates.find(row=>row.kind==='greeting');
 const selfTalk=candidates.find(row=>row.kind==='selftalk');
 assert.ok(greeting&&selfTalk);

 const queue=holdNextModel();
 const greetingRun=game.r95.proactive.tick({candidateId:greeting.id});
 try{
  await queue.entered.promise;
  t.mock.timers.tick(120000);
 }finally{queue.release.resolve();}
 await greetingRun;
 const request=calls.find(row=>row.purpose==='greeting');
 assert.equal(systemLine(request,'Current local time:'),'Current local time: 2042-04-07 (Mon) 00:01 (America/New_York)');
 const line=game.r95.view().lines.find(row=>row.candidateId===greeting.id);
 assert.ok(line);
 await game.r95.action('speech-presented',{messageId:line.messageId});
 await game.r95.action('speech-read',{messageId:line.messageId});

 t.mock.timers.tick(60000);
 await game.r95.proactive.tick({candidateId:selfTalk.id});
 const reflection=calls.find(row=>row.purpose==='selftalk');
 assert.equal(systemLine(reflection,'Current local time:'),'Current local time: 2042-04-07 (Mon) 00:02 (America/New_York)');
});

test('Galgame sends the full alias-aware instruction and stores clean sentence ranges in private and group replies', async t=>{
 const reply='没写标签。[[emotion:关心]]我听着呢。继续说吧。[[emotion:undefined]]到这里。';
 const f=await fixture(t,{taggedReply:reply});
 await f.game.action('chat',{text:'测试逐句表情'});
 const state=await presentedState(f.game);
 const message=state.messages.findLast(row=>row.role==='assistant');
 assert.equal(message.text,'没写标签。我听着呢。继续说吧。到这里。');
 assert.deepEqual(message.emotionSentences.map(row=>row.emotion),['normal','gentle','gentle','normal']);
 assert.ok(f.calls.find(row=>!row.purpose&&row.incremental).system.includes('撒娇=coax'));
 const {group}=await f.game.action('companion-group-save',{name:'表情小组',memberIds:['deepseek'],mode:'list'});
 await f.game.action('companion-group-select',{id:group.id});
 await f.game.action('companion-group-send',{id:group.id,text:'测试群聊逐句表情',forceCharacterId:'deepseek'});
 const request=await waitForCall(f.calls,row=>row.purpose==='group-chat');
 assert.ok(request.system.includes('撒娇=coax'));
 const groupMessage=await waitForGroupPending(f.game);
 assert.equal(groupMessage.text,message.text);
 assert.deepEqual(groupMessage.emotionSentences.map(row=>row.emotion),['serious','gentle','gentle','normal']);
});

async function waitForGroupPending(game){
 for(let n=0;n<200;n++){
  const {companion}=await game.action('companion-state');
  if(companion.groupRuntime?.pendingMessage)return companion.groupRuntime.pendingMessage;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.fail('Group fixture did not reach presentation');
}

test('dense streamed model chunks coalesce while final Galgame text and expression ranges remain exact',async t=>{
 const taggedReply='[[emotion:温柔]]'+('句子很长。'.repeat(80))+'[[emotion:得意]]结束了。';
 const f=await fixture(t,{taggedReply,splitReply:true});
 await f.game.action('chat',{text:'测密集流'});
 const streamed=f.events.filter(event=>event.type==='text.delta');
 assert.ok(streamed.length>0&&streamed.length<50,'bounded presentation flushes for dense input');
 const message=(await presentedState(f.game)).messages.findLast(row=>row.role==='assistant');
 assert.equal(message.text,'句子很长。'.repeat(80)+'结束了。');
 assert.equal(message.emotionSentences.at(-1).emotion,'smug');
 const {group}=await f.game.action('companion-group-save',{name:'密集流群聊',memberIds:['deepseek'],mode:'list'});
 await f.game.action('companion-group-select',{id:group.id});
 await f.game.action('companion-group-send',{id:group.id,text:'测群聊密集流',forceCharacterId:'deepseek'});
 const pending=await waitForGroupPending(f.game);
 const groupStream=f.events.filter(event=>event.type==='group.text'&&event.payload.text);
 assert.ok(groupStream.length>0&&groupStream.length<50,'group emits only current presentation batches');
 assert.equal(pending.text,message.text);
 assert.equal(pending.emotionSentences.at(-1).emotion,'smug');
});


for(const [label,taggedReply,groupReply,emotion,emotionSource] of [
 ['last tagged expression','[[emotion:温柔]]A。[[emotion:哭]]B。随后歇会儿。',undefined,'frightened','structured'],
 ['keyword fallback','哈哈太好了','哈哈太好了','cheerful','keyword'],
 ['legacy trailing expression','你说对了。[[emotion:shy]]','你说对了。[[emotion:shy]]','shy','structured'],
]){
 test('desk pet uses the '+label+' for private and group replies',async t=>{
  const {game,chatCommits}=await fixture(t,{taggedReply,groupReply});
  const petEmotion=({emotion,emotionSource})=>({emotion,emotionSource});
  await game.action('chat',{text:'测试桌宠情绪'});
  assert.deepEqual(petEmotion(chatCommits.find(row=>!row.group)),{emotion,emotionSource},'private desk pet notification');
  await presentedState(game);
  const {group}=await game.action('companion-group-save',{name:'桌宠情绪小组',memberIds:['deepseek'],mode:'list'});
  await game.action('companion-group-select',{id:group.id});
  await game.action('companion-group-send',{id:group.id,text:'测试群聊桌宠情绪',forceCharacterId:'deepseek'});
  const pending=await waitForGroupPending(game);
  if(emotionSource==='keyword')assert.deepEqual(petEmotion(pending),{emotion:'normal',emotionSource:'compatibility'},'the visible stage preserves plain-reply compatibility');
  await game.action('companion-group-present',{id:group.id,requestId:pending.id});
  assert.deepEqual(petEmotion(chatCommits.find(row=>row.group)),{emotion,emotionSource},'group desk pet notification');
 });
}

test('desk pet projection retains sentence emotion after voice strips the markup',async t=>{
 const text=['[[emotion:温柔]]A。','[[emotion:哭]]B。','歇会儿。[[emotion:shy]]'];
 const segments=text.map(line=>JSON.stringify({type:'segment',text:line}));
 const control=JSON.stringify({type:'control',emotion:'shy',affection:0});
 const groupReply=[JSON.stringify({type:'decision',speak:true}),...segments,control].join('\n');
 const emitted=[];
 const voice={admit:()=>({epoch:4,voiceProfileVersion:9}),segment:value=>emitted.push(value),finish(){}};
 const {game,chatCommits}=await fixture(t,{taggedReply:[...segments,control].join('\n'),groupReply,voice});
 const value=await game.action('chat',{text:'测试私聊配音表情'});
 assert.deepEqual(value.companionCommit.petEmotion,{emotion:'frightened',emotionSource:'structured'});
 async function complete(requestId){
  for(const {envelope} of emitted.filter(row=>row.envelope.requestId===requestId)){
   await game.voiceReceipt({envelope,status:'textDisplayed'});
   await game.voiceReceipt({envelope,status:'audioStarted'});
   await game.voiceReceipt({envelope,status:'audioCompleted',playedMs:100});
  }
 }
 const privateRequest=emitted[0].envelope.requestId;
 await complete(privateRequest);
 await presentedState(game);
 const {group}=await game.action('companion-group-save',{name:'配音情绪小组',memberIds:['deepseek'],mode:'list'});
 await game.action('companion-group-select',{id:group.id});
 await game.action('companion-group-send',{id:group.id,text:'测试群聊配音表情',forceCharacterId:'deepseek'});
 const pending=await waitForGroupPending(game);
 await complete(pending.id);
 const commit=await waitForCall(chatCommits,row=>row.group);
 assert.equal(commit.emotion,'frightened');
 assert.equal(commit.emotionSource,'structured');
});
