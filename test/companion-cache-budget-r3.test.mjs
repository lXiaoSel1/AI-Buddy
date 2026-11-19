import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionCacheStore} from '../src/companion-cache-store.mjs';
import {cacheHash,preparePrivateWindow,privateCacheScope,privateMessageAnchor} from '../src/companion-chat-cache.mjs';
import {privateWireMessage} from '../src/companion-prompt-parts.mjs';
import {privateHistoryPolicy} from '../src/api-cache-capabilities.mjs';
import {estimatePrivateMessageTokens} from '../src/private-token-budget.mjs';
import {tmpDir} from './support/audit-harness.mjs';

const selected={provider:'fixture',model:'synthetic'};
const baseProfile={kind:'custom',protocol:'chat-completions',baseUrl:'http://localhost:1/v1',model:'synthetic'};
const wire=(role,text)=>privateWireMessage(role,text,selected);
const textOf=message=>message.content[0].text;

async function fixture(t,{
 profile=baseProfile,connectionKey='fixture',outputReserve=1600,capacity=262144,
 summary='Synthetic compacted history.',system='Synthetic private instructions.',calibration,
}={}){
 const audits=[],attempts=[],originals=new Map();
 const store=createCompanionCacheStore(tmpDir('private-budget-r3',{t,beforeRemove:()=>store.close()}));
 await store.ready();
 const scope={key:'fixture-scope',characterId:'fixture-character',conversationId:'fixture-conversation'};
 let turn=0;
 return {
  attempts,audits,
  async prepare({history=[],user='Current user',key=connectionKey,requiredIndices=[],requestCapacity=capacity}={}){
   const previous=store.read(scope.key),requestId='fixture-turn-'+ ++turn;
   const entries=history.map(([role,text],index)=>{
    const original={id:'original-'+index,role,text};
    originals.set(original.id,original);
    return {anchor:privateMessageAnchor(original),message:wire(role,text),required:requiredIndices.includes(index)};
   });
   const window=await preparePrivateWindow({
    store,scope,previous,requestId,connectionKey:key,calibration,wireSystem:system,entries,selected,
    historyPolicy:privateHistoryPolicy(profile),
    capacity:{tokens:requestCapacity,reserveTokens:outputReserve},parent:previous?.parent??null,
    buildCurrent:()=>({message:wire('user',user)}),
    buildBaseline:()=>({memoryBaseline:true,anchors:[],message:wire('user','[Current memoryState]\n{"core":[],"guide":[],"corrections":[]}')}),
    validEntry:()=>true,assertScope(){},async verifyEntries(){},
    lookup:id=>originals.get(id),audit:event=>audits.push(event),
    async compact(request){attempts.push(request);return typeof summary==='function'?summary(request):summary;},
   });
   return {
    window,
    async reply(text){
     const userId=requestId+':user',replyId=requestId+':reply';
     originals.set(userId,{id:userId,role:'user',text:user,status:'sent',requestId});
     originals.set(replyId,{id:replyId,role:'assistant',text,requestId});
     window.observeWireSystemMode('plain',true);
     window.observeAssistant(text);
     return window.commit();
    },
   };
  },
 };
}

test('private history below 8k estimated tokens keeps its original Chinese messages even above 8k bytes',async t=>{
 const f=await fixture(t);
 const history=Array.from({length:10},(_,index)=>[index%2?'assistant':'user','往事。'.repeat(150)]);
 const {window}=await f.prepare({history});
 assert.equal(f.attempts.length,0);
 assert.deepEqual(window.messages.slice(0,-1),history.map(([role,text])=>wire(role,text)));
});

test('reported full prompt usage calibrates subsequent private history on only the same connection',async t=>{
 const saved=new Map();
 const calibration={read:async key=>saved.get(key),write:async (key,value)=>saved.set(key,value)};
 const f=await fixture(t,{system:'a'.repeat(3200),calibration});
 const {window}=await f.prepare({user:'b'.repeat(3200)});
 for(const missing of [undefined,0,-1,NaN,Infinity])await window.observeUsage(missing);
 assert.equal(saved.size,0);
 // The system and current user each estimate 964 tokens. A 3,856-token
 // observation lands at 1.2 from the initial 1.0 under the 0.2 EMA.
 await window.observeUsage(3856);
 assert.ok(Math.abs(saved.get('fixture')-1.2)<1e-12);
 await window.observeUsage(1);
 assert.ok(Math.abs(saved.get('fixture')-1.2)<1e-12,'one reported sample per submitted window');

 const history=Array.from({length:28},(_,index)=>[index%2?'assistant':'user','旧话。'.repeat(130)]);
 await f.prepare({history,key:'fixture-other-model'});
 assert.equal(f.attempts.length,0);
 const next=await f.prepare({history});
 assert.equal(f.attempts.length,1);
 assert.match(textOf(next.window.messages[0]),/Synthetic compacted history/);
});

test('private usage counts Unicode code points and clamps serialized same-connection observations',async t=>{
 let ratio;
 const calibration={read:async()=>ratio,write:async (_key,value)=>{ratio=value;}};
 const f=await fixture(t,{system:'',calibration});
 // One repetition has six East Asian code points, two other code points
 // and one ASCII code point. One hundred repetitions plus overhead make 624.
 const user='𠀀あカ한，。Ａ🧭a'.repeat(100);
 const first=await f.prepare({user}),second=await f.prepare({user});
 await Promise.all([first.window.observeUsage(1248),second.window.observeUsage(1248)]);
 assert.ok(Math.abs(ratio-1.36)<1e-12);
 const high=await f.prepare({user});
 await high.window.observeUsage(100000);
 assert.equal(ratio,2);
 for(let turn=0;turn<8;turn++){
  const low=await f.prepare({user});
  await low.window.observeUsage(1);
 }
 assert.equal(ratio,.5);
});

test('applying a private reply reports a successful window commit and a competing stale revision reports failure',async t=>{
 const f=await fixture(t);
 const first=await f.prepare({user:'First private user'});
 const competing=await f.prepare({user:'Competing private user'});
 assert.equal(await first.reply('Accepted reply'),true);
 assert.equal(await competing.reply('Conflicting reply'),false);
 const {window}=await f.prepare();
 assert.deepEqual(window.messages.map(textOf),['First private user','Accepted reply','Current user']);
});

test('native Codex scopes work without an API URL and rotate with captured reasoning effort',()=>{
 const profile={id:'codex',kind:'codex',protocol:'codex',model:'fixture-codex',baseUrl:'',reasoningEffort:'high'};
 const conversation={characterId:'fixture-character',conversationId:'fixture-conversation',personaId:'fixture-persona'};
 const life={lifeId:'fixture-life',operationId:'fixture-operation'};
 const high=privateCacheScope(profile,conversation,life);
 assert.equal(high.key,privateCacheScope(profile,conversation,life).key);
 assert.notEqual(high.key,privateCacheScope({...profile,reasoningEffort:'low'},conversation,life).key);
});

test('a failed compaction rebases to the tier target and preserves the reduced prefix during cooldown',async t=>{
 let succeeded=false;
 const f=await fixture(t,{summary:()=>succeeded?'Synthetic recovered summary.':''});
 const history=Array.from({length:22},(_,index)=>[index%2?'assistant':'user',(index===0?'OLDEST_RECORD ':'')+'旧事。'.repeat(200)]);
 const first=await f.prepare({history,user:'新问。'.repeat(110)});
 assert.equal(f.attempts.length,1);
 const bounded=first.window.messages.slice(0,-1);
 assert.ok(bounded.length>0&&bounded.reduce((total,message)=>total+estimatePrivateMessageTokens(message),0)<=3200);
 assert.ok(!bounded.some(message=>textOf(message).includes('OLDEST_RECORD')));
 assert.equal(await first.reply('新答。'.repeat(110)),true);
 succeeded=true;
 let next;
 for(let turn=0;turn<20&&f.attempts.length===1;turn++){
  next=await f.prepare({user:'新问。'.repeat(110)});
  if(turn<2){
   assert.deepEqual(next.window.messages.slice(0,bounded.length),bounded);
   assert.equal(f.attempts.length,1);
  }
  assert.equal(await next.reply('新答。'.repeat(110)),true);
 }
 assert.equal(f.attempts.length,2);
 assert.match(textOf(next.window.messages[0]),/Synthetic recovered summary/);
});

test('the next compaction explicitly updates the earlier summary and restores one full memoryState',async t=>{
 let ordinal=0;
 const f=await fixture(t,{summary:()=>++ordinal===1?'Synthetic summary from the first window.':'Synthetic updated rolling summary.'});
 const history=Array.from({length:24},(_,index)=>[index%2?'assistant':'user','旧事。'.repeat(200)]);
 let run=await f.prepare({history,user:'新问。'.repeat(150)});
 await run.reply('新答。'.repeat(150));
 for(let turn=0;turn<13&&f.attempts.length===1;turn++){
  run=await f.prepare({user:'新问。'.repeat(150)});
  await run.reply('新答。'.repeat(150));
 }
 assert.equal(f.attempts.length,2);
 const second=f.attempts[1].messages;
 assert.match(textOf(second[0]),/Synthetic summary from the first window/);
 assert.match(textOf(second.at(-1)),/update the previous history summary/i);
 assert.match(textOf(run.window.messages[0]),/Synthetic updated rolling summary/);
 assert.match(textOf(run.window.messages[1]),/^\[Current memoryState\]/);
 assert.equal(run.window.messages.filter(message=>textOf(message).startsWith('[Current memoryState]')).length,1);
});

test('a newly required original is sent verbatim even when an existing summary covers its anchor',async t=>{
 const f=await fixture(t);
 const original='REQUIRED_ORIGINAL '+'历史。'.repeat(200);
 const history=Array.from({length:24},(_,index)=>[index%2?'assistant':'user',index===0?original:'旧事。'.repeat(200)]);
 const first=await f.prepare({history});
 assert.match(textOf(first.window.messages[0]),/Synthetic compacted history/);
 assert.equal(await first.reply('Synthetic reply'),true);
 const {window}=await f.prepare({history,requiredIndices:[0]});
 assert.ok(window.messages.some(message=>textOf(message)===original),'summary coverage cannot substitute a mandatory source');
});

test('byte capacity rejects an oversized required source and trims optional history below the token trigger',async t=>{
 const capacity=16384,system='Synthetic safety instructions.';
 const f=await fixture(t,{capacity,system});
 const history=Array.from({length:12},(_,index)=>[index%2?'assistant':'user','旧事。'.repeat(110)]);
 const {window}=await f.prepare({history,user:'a'.repeat(5000)});
 assert.ok(window.messages.length<history.length+1);
 assert.ok(Buffer.byteLength(JSON.stringify(window.messages))+Buffer.byteLength(system)+1600<=capacity);
 assert.ok(f.audits.some(event=>event.type==='companion-cache-capacity-reset'));
 assert.equal(f.attempts.length,0);
 await assert.rejects(f.prepare({history:[['user','必要。'.repeat(900)]],requiredIndices:[0],user:'a'.repeat(8000)}),
  {code:'MEMORY_CONTEXT_CAPACITY'});
});

test('a capacity-limited summary is not requested when the declared ceiling cannot fit',async t=>{
 const f=await fixture(t,{capacity:10400});
 const history=Array.from({length:10},(_,index)=>[index%2?'assistant':'user','a'.repeat(400)]);
 const {window}=await f.prepare({history,user:'b'.repeat(6000)});
 assert.equal(f.attempts.length,0);
 assert.ok(f.audits.some(event=>event.type==='companion-cache-capacity-reset'));
 assert.ok(Buffer.byteLength(JSON.stringify(window.messages))+1600<10400);
});

const deepseek={kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1'};
const kimi={kind:'kimi',protocol:'chat-completions',baseUrl:'https://api.moonshot.ai/v1',model:'kimi-k3.1-pro'};
const codex={kind:'codex',protocol:'codex',baseUrl:'',model:'fixture-codex'};

test('supported official alternate routes qualify for their history budgets while lookalike endpoints and unknown models do not',()=>{
 const v4Pro={...deepseek,model:'deepseek-v4-pro'};
 assert.equal(privateHistoryPolicy({...v4Pro,protocol:'responses',baseUrl:'https://api.deepseek.com'}).triggerTokens,32000);
 assert.equal(privateHistoryPolicy({kind:'openai',protocol:'chat-completions',baseUrl:'https://api.openai.com/v1'}).triggerTokens,16000);
 assert.equal(privateHistoryPolicy({...kimi,baseUrl:'https://api.moonshot.cn/v1'}).triggerTokens,16000);
 for(const profile of [
  {...v4Pro,model:'unknown-deepseek-model'},
  {...v4Pro,kind:'custom'},
  {...v4Pro,baseUrl:'https://api.deepseek.com.example.invalid/v1'},
  {...v4Pro,baseUrl:'https://api.deepseek.com/v1/proxy'},
  {...v4Pro,baseUrl:'https://api.deepseek.com@proxy.invalid/v1'},
 ])assert.equal(privateHistoryPolicy(profile).triggerTokens,8000);
});

test('summary bodies are clipped to both the character and UTF-8 byte cap of each budget tier',async t=>{
 for(const [profile,rows,summary,maxChars,maxBytes] of [
  [baseProfile,22,'🧭'.repeat(1000),600,2048],
  [kimi,42,'A'.repeat(1500),900,3072],
  [{...deepseek,model:'deepseek-v4-pro'},84,'史'.repeat(1500),1350,4096],
 ]){
  const f=await fixture(t,{profile,summary});
  const history=Array.from({length:rows},(_,index)=>[index%2?'assistant':'user','旧事。'.repeat(200)]);
  const {window}=await f.prepare({history});
  assert.equal(f.attempts.length,1);
  const body=textOf(window.messages[0]).split('\n')[1];
  assert.match(body,/\[Summary shortened\]$/);
  assert.ok([...body].length<=maxChars);
  assert.ok(Buffer.byteLength(body)<=maxBytes);
  assert.ok([...body].length===maxChars||Buffer.byteLength(body)>maxBytes-4,'clip at the first reached cap');
 }
});

for(const [label,profile,first,min,max] of [
 ['DeepSeek Flash',{...deepseek,model:'deepseek-flash'},55,24,48],
 ['DeepSeek V4 Pro',{...deepseek,model:'deepseek-v4-pro'},55,24,48],
 ['Kimi',kimi,28,10,20],
 ['OpenAI',{kind:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',model:'fixture-openai'},28,10,20],
 ['Grok',{kind:'grok',protocol:'chat-completions',baseUrl:'https://api.x.ai/v1',model:'fixture-grok'},28,10,20],
 ['Claude',{kind:'claude',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:'fixture-claude'},28,10,20],
 ['Codex',codex,28,10,20],
 ['custom',baseProfile,15,6,12],
]){
 test(label+' private history compacts at its token tier and preserves the Chinese prefix between summaries',async t=>{
  const f=await fixture(t,{profile});
  // Two 450-character CJK messages add 594 uncalibrated history tokens.
  const question='问题。'.repeat(150),answer='回答。'.repeat(150);
  const submitted=[];
  let previousMessages=[];
  for(let turn=1;turn<=first+max&&submitted.length<2;turn++){
   const count=f.attempts.length;
   const run=await f.prepare({user:question+turn});
   const reply=wire('assistant',answer+turn);
   if(f.attempts.length!==count){
    submitted.push(turn);
    const [compaction]=f.attempts.slice(-1);
    const budget=privateHistoryPolicy(profile).triggerTokens;
    const history=compaction.messages.slice(0,-1);
    const tokens=rows=>rows.filter(row=>!textOf(row).startsWith('[Current memoryState]')).reduce((total,row)=>total+estimatePrivateMessageTokens(row),0);
    const priorChat=previousMessages.slice(0,-1);
    assert.deepEqual(history,priorChat,'summary replays the entire prior chat input');
    assert.ok(tokens(history.slice(0,-1))<=budget,'optional summary request history stays within the tier');
    assert.match(textOf(run.window.messages[0]),/Synthetic compacted history/);
   }else{
    assert.deepEqual(run.window.messages.slice(0,-1),previousMessages,'ordinary private turn appends');
   }
   assert.equal(await run.reply(answer+turn),true);
   previousMessages=[...run.window.messages,reply];
  }
  assert.equal(submitted.length,2);
  assert.equal(submitted[0],first);
  const interval=submitted[1]-submitted[0];
  t.diagnostic('First compaction at turn '+first+'; next compaction '+interval+' turns later');
  assert.ok(interval>=min&&interval<=max);
 });
}

async function r4DefaultRun(t,ratio){
 const originals=new Map(),history=[],audits=[],attempts=[],successful=[];
 const store=createCompanionCacheStore(tmpDir('private-default-r4',{t,beforeRemove:()=>store.close()}));
 await store.ready();
 const scope={key:'default-r4',characterId:'synthetic',conversationId:'synthetic'};
 const core=Array.from({length:12},(_,i)=>({text:'记'.repeat(142),kind:'fact',eventIds:['00000000-0000-4000-8000-00000000000'+(i%10)]}));
 const baseline='[Current memoryState]\n'+JSON.stringify({core,guide:[],corrections:[]});
 assert.ok(Buffer.byteLength(baseline)>6000&&Buffer.byteLength(baseline)<6144);
 const calibration={read:()=>ratio};
 for(let turn=1;turn<=60;turn++){
  const previous=store.read(scope.key),requestId='r4-'+turn;
  const user={id:requestId+':user',role:'user',text:'问'.repeat(300),status:'sent',requestId},reply={id:requestId+':reply',role:'assistant',text:'答'.repeat(500),requestId};
  const window=await preparePrivateWindow({store,scope,previous,requestId,wireSystem:'Synthetic system',selected,
   entries:history.slice(-14).map(row=>({anchor:privateMessageAnchor(row),message:wire(row.role,row.text)})),
   historyPolicy:privateHistoryPolicy(baseProfile),capacity:{tokens:131072,reserveTokens:1600},parent:previous?.parent??null,
   connectionKey:'fixture',calibration,buildCurrent:()=>({message:wire('user',user.text)}),
   buildBaseline:()=>({memoryBaseline:true,anchors:[],message:wire('user',baseline)}),
   validEntry:()=>true,lookup:id=>originals.get(id),assertScope(){},async verifyEntries(){},audit:event=>audits.push(event),
   async compact(){attempts.push(turn);return '摘'.repeat(500)+'。';},
  });
  if(attempts.at(-1)===turn&&textOf(window.messages[0]).startsWith('[Internal history summary'))successful.push(turn);
  originals.set(user.id,user);originals.set(reply.id,reply);history.push(user,reply);
  window.observeWireSystemMode('plain',true);
  window.observeAssistant(reply.text);assert.equal(await window.commit(),true);
 }
 return {attempts,successful,failures:audits.filter(event=>event.type==='companion-cache-compaction-failed').map(event=>event.code),resets:audits.filter(event=>event.type==='companion-cache-capacity-reset').length};
}

const representativeR4Ratios=[.5,.75,1,1.4,1.5,1.6,1.75,2];
const denseR4Ratios=[...new Set([...representativeR4Ratios,...Array.from({length:31},(_,index)=>Number((.5+index*.05).toFixed(2)))])].sort((a,b)=>a-b);
for(const ratio of denseR4Ratios)test('R4 60-round default history with near-full memory baseline at ratio '+ratio,async t=>{
 const result=await r4DefaultRun(t,ratio);
 t.diagnostic(JSON.stringify({ratio,...result,intervals:result.successful.slice(1).map((turn,index)=>turn-result.successful[index])}));
 assert.deepEqual(result.failures,[],'predictable insufficient gain must not be paid for');
 assert.equal(result.resets,0,'soft trigger must not reset the prefix');
 assert.ok(result.successful.length>0,'history should compact repeatedly even with a full baseline');
 assert.deepEqual(result.attempts,result.successful);
});

test('R4 recovery keeps a bounded suffix and its anchorless incomplete reply in order',async t=>{
 const store=createCompanionCacheStore(null);
 t.after(()=>store.close());
 const originals=new Map(),history=['R4 discarded user','R4 discarded reply','R4 kept user','R4 kept reply'].map((text,index)=>{
  const row={id:'r4-seed-'+index,role:index%2?'assistant':'user',text};originals.set(row.id,row);return {anchor:privateMessageAnchor(row),message:wire(row.role,text)};
 });
 originals.set('r4-prior:user',{id:'r4-prior:user',role:'user',status:'failed',text:'R4 prior user',requestId:'r4-prior'});
 const window=await preparePrivateWindow({store,scope:{key:'r4-bounded'},previous:{sessionUuid:'11111111-1111-4111-8111-111111111111',instructionsHash:cacheHash('r4-system'),entries:history.slice(2),parent:history[3].anchor},
  requestId:'r4-next',wireSystem:'r4-system',entries:history,selected,parent:null,capacity:{tokens:16000,reserveTokens:1600},
  buildCurrent:()=>({message:wire('user','R4 current user')}),buildBaseline:()=>({memoryBaseline:true,message:wire('user','R4 baseline')}),
  recovery:{requestId:'r4-prior',visibleText:'R4 partial reply'},validEntry:()=>true,lookup:id=>originals.get(id),assertScope(){},async verifyEntries(){},audit(){} });
 assert.deepEqual(window.messages.map(textOf),['R4 kept user','R4 kept reply','R4 prior user\n[Previous turn interrupted]','[Incomplete reply]\nR4 partial reply','R4 current user']);
});


test('a hard capacity reset cannot bypass the failure cooldown',async t=>{
 let succeeds=false;
 const f=await fixture(t,{summary:()=>succeeds?'Synthetic hard-cap summary.':''});
 const history=Array.from({length:22},(_,index)=>[index%2?'assistant':'user','a'.repeat(1250)]);
 const first=await f.prepare({history});
 assert.equal(f.attempts.length,1);
 assert.equal(await first.reply('Synthetic reply after soft failure'),true);
 succeeds=true;
 const {window}=await f.prepare({history,user:'b'.repeat(7000),requestCapacity:13000});
 assert.equal(f.attempts.length,1);
 assert.ok(Buffer.byteLength(JSON.stringify(window.messages))+1600<13000);
 assert.ok(f.audits.some(event=>event.type==='companion-cache-capacity-reset'));
});
