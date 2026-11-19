import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpDir} from './support/audit-harness.mjs';
import {ApiTransport} from '../src/api-transport.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {privateHistoryPolicy} from '../src/api-cache-capabilities.mjs';
import {createCompanionCacheStore} from '../src/companion-cache-store.mjs';
import {cacheHash,preparePrivateWindow,privateMessageAnchor} from '../src/companion-chat-cache.mjs';
import {privateWireMessage} from '../src/companion-prompt-parts.mjs';

const profiles={
  8:{kind:'custom',baseUrl:'http://localhost:1/v1',model:'synthetic'},
  16:{kind:'openai',baseUrl:'https://api.openai.com/v1',model:'synthetic'},
  32:{kind:'deepseek',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash'},
};
const selected={provider:'fixture',model:'synthetic'};
const wire=(role,text)=>privateWireMessage(role,text,selected);
const textOf=message=>message?.content[0].text??'';
const system='Synthetic private instructions.';
const summaryText=number=>'摘要'+number+'。不要主动提起此事。'+'摘'.repeat(390)+'。';
const summaryOf=messages=>messages.find(message=>textOf(message).startsWith('[Internal history summary'));
const replyOf=(messages,turn)=>messages.find(message=>message.role==='assistant'&&textOf(message).startsWith('答'+turn+'。'));

async function fixture(t,{tier=8,ratio=1,failAt,failAlways=false,checkWire=false,persist=false,anthropic=false,searchRouter=false,certify=true,pauseTurn}={}){
  const provider=anthropic?{kind:'claude',baseUrl:'https://api.anthropic.com/v1',model:'claude-sonnet-4-6'}:profiles[tier];
  const profile={...provider,id:'fixture',key:'fixture',protocol:anthropic?'anthropic':'chat-completions'};
  const directory=persist?tmpDir('private-r6',{t,beforeRemove:()=>store.close()}):null;
  let store=createCompanionCacheStore(directory);
  await store.ready();
  if(!persist){store.isDurable=()=>true;t.after(()=>store.close());}
  const scope={key:'fixture-r6',characterId:'synthetic',conversationId:'synthetic'};
  const originals=new Map(),history=[],attempts=[],audits=[];
  const chatRequests=[];
  let sent,successfulSummaries=0;
  async function fetchImpl(_url,{body}){
    sent=JSON.parse(body);
    const content='Synthetic response';
    if(anthropic&&pauseTurn===chatRequests.length+1){
      const stop_reason=sent.messages.at(-1).role==='assistant'?'end_turn':'pause_turn';
      return Response.json({content:[{type:'text',text:content}],stop_reason});
    }
    return Response.json(anthropic?{content:[{type:'text',text:content}]}:{choices:[{message:{content},finish_reason:'stop'}]});
  }
  const transport=new ApiTransport({fetchImpl});
  let router;
  if(searchRouter){
    const dataRoot=tmpDir('private-r6-router',{t,beforeRemove:()=>router?.close()});
    const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
    router=await new ModelRouter({dataRoot,fetchImpl,searchPolicy:()=>true,crypto,codex:{setEnabled(){}}}).ready;
    const connection=await router.save({...provider,protocol:profile.protocol,...(anthropic?{key:'synthetic-fixture'}:{})});
    await router.activate(connection.id);
    router.setEnabled(true);
  }
  async function capture(options){
    sent=undefined;
    const stream=router?router.stream({system,...options}):transport.stream(profile,{system,...options});
    for await(const _ of stream){}
    assert.ok(sent?.messages);
    return sent;
  }
  return {
    attempts,audits,chatRequests,
    async reopen(){
      assert.equal(await store.flush(),true);
      await store.close();
      store=createCompanionCacheStore(directory);
      await store.ready();
    },
    edit(turn){
      const row=history[(turn-1)*2];
      row.text='Synthetic revised source';
    },
    seedSummary(text){
      const anchor=privateMessageAnchor({id:'summary-source',role:'user',text:'Synthetic source'});
      assert.ok(store.write(scope,undefined,{
        sessionUuid:'f9e8723d-f11c-43c7-9be1-aa41acd0f111',instructionsHash:cacheHash(system),
        entries:[{summary:true,anchors:[anchor],message:wire('user',text)}],parent:null,
      })!=null);
      return anchor;
    },
    read(){return store.read(scope.key);},
    async turn({userChars=300,replyChars=500,capacity=272000,requiredTurn}={}){
      const turn=history.length/2+1,id='r6-'+turn,previous=store.read(scope.key);
      const raw=(prefix,length)=>prefix+turn+'。'+prefix.repeat(length-(prefix+turn+'。').length);
      const user={id:id+':user',role:'user',text:raw('问',userChars),status:'sent',requestId:id};
      const reply={id:id+':reply',role:'assistant',text:raw('答',replyChars),requestId:id};
      const window=await preparePrivateWindow({
        store,scope,previous,requestId:id,connectionKey:'fixture',calibration:{read:()=>ratio},
        wireSystem:system,selected,historyProtocol:profile.protocol,historyPolicy:privateHistoryPolicy(profile),capacity:{tokens:capacity,reserveTokens:1600},
        parent:previous?.parent??null,
        entries:history.filter(row=>history.indexOf(row)>=history.length-14||row.id==="r6-"+requiredTurn+":user").map(row=>({
          anchor:privateMessageAnchor(row),message:wire(row.role,row.text),required:row.id==="r6-"+requiredTurn+":user"})),
        buildCurrent:()=>({message:wire('user',user.text)}),
        buildBaseline:()=>({memoryBaseline:true,anchors:[],message:wire('user','[Current memoryState]{}')}),
        validEntry:row=>(row.anchor?[row.anchor]:row.anchors??[]).every(anchor=>{
          const original=originals.get(anchor.id);
          return original?privateMessageAnchor(original).hash===anchor.hash:anchor.id==='summary-source';
        }),
        assertScope(){},async verifyEntries(){},lookup:id=>originals.get(id),
        audit:event=>audits.push({turn,event}),
        async compact(request){
          const attempt={turn};
          attempts.push(attempt);
          if(checkWire)attempt.body=await capture({...request,purpose:'chat-window-compact',singleSubmission:true});
          if(failAlways||attempts.length===failAt)
            throw Object.assign(Error('Synthetic summary failure'),{code:'SUMMARY_REQUEST_FAILED'});
          return summaryText(++successfulSummaries);
        },
      });
      if(checkWire)chatRequests.push(await capture({messages:window.messages,cacheContext:window.cacheContext,observeWireSystemMode:window.observeWireSystemMode}));
      for(const row of [user,reply]){originals.set(row.id,row);history.push(row);}
      if(!router&&certify)window.observeWireSystemMode('plain',true);
      window.observeAssistant(reply.text);
      assert.equal(await window.commit(),true);
      return {turn,messages:window.messages,user,reply};
    },
  };
}

test('R6 P1 keeps the same rolling summary through one failed request and then updates it',async t=>{
  const f=await fixture(t,{failAt:3});
  let saved;
  let failed=false,recovered=false;
  for(let ordinal=1;ordinal<=65;ordinal++){
    const {turn,messages}=await f.turn();
    const summary=textOf(summaryOf(messages));
    if(f.attempts.length===2&&summary.includes('摘要2'))saved=summary;
    if(f.attempts.length===3){
      failed=true;
      assert.ok(saved?.includes('不要主动提起'));
      assert.ok(summary===saved,'rolling summary or do-not-mention agreement changed after failure at turn '+turn);
    }
    if(f.attempts.length===4){
      recovered=summary.includes('摘要3')&&summary.includes('不要主动提起');
      break;
    }
  }
  assert.ok(failed&&recovered);
});

for(const [tier,ratio,length] of [[8,1,20000],[8,2,7000],[16,1,30000]]){
  test('R6 P1 preserves the summary after an oversized reply at '+tier+'k, ratio '+ratio,async t=>{
    const f=await fixture(t,{tier,ratio});
    let prior;
    for(let index=0;index<60;index++){
      const run=await f.turn({replyChars:index===0?500:f.attempts.length?length:500});
      if(run.reply.text.length===length){prior=run;break;}
    }
    assert.ok(prior&&summaryOf(prior.messages));
    const next=await f.turn();
    const summary=summaryOf(next.messages);
    assert.equal(next.messages.indexOf(summary),prior.messages.indexOf(summaryOf(prior.messages)));
    assert.ok(textOf(summary)===textOf(summaryOf(prior.messages)),'oversized reply changed the rolling summary bytes');
    assert.ok(textOf(summary).includes('不要主动提起'));
  });
}

for(const tier of [8,16,32]){
  test('R6 P2 replays the entire preceding API chat prefix at '+tier+'k',async t=>{
    const f=await fixture(t,{tier,checkWire:true});
    for(let turn=1;turn<=110&&f.attempts.length<2;turn++)await f.turn();
    assert.equal(f.attempts.length,2);
    for(const {turn,body} of f.attempts){
      const previous=f.chatRequests[turn-2].messages;
      const replay=body.messages.slice(0,-1);
      let shared=0;
      while(shared<previous.length&&JSON.stringify(previous[shared])===JSON.stringify(replay[shared]))shared++;
      t.diagnostic(JSON.stringify({tier,turn,shared,previous:previous.length,replayed:replay.length}));
      assert.equal(shared,previous.length);
      assert.equal(replay.length,previous.length);
      assert.match(body.messages.at(-1).content,/^Summarize the dialogue/);
    }
  });
}

for(const [tier,ratio,length] of [[8,1,4000],[16,1,8000],[8,1.5,8000]]){
  test('R6 P3 keeps a budget-fitting reply of '+length+' characters at '+tier+'k, ratio '+ratio,async t=>{
    const f=await fixture(t,{tier,ratio});
    const prior=await f.turn({userChars:100,replyChars:length});
    const next=await f.turn({userChars:100});
    const visible=textOf(replyOf(next.messages,prior.turn));
    t.diagnostic(JSON.stringify({tier,ratio,length,visible:visible.split('\n')[0].length}));
    assert.ok(visible===prior.reply.text,'the fitting previous reply was cut');
  });
}

test('R6 Q2 increases retry spacing during 120 turns of persistent summary failures',async t=>{
  const f=await fixture(t,{tier:16,failAlways:true});
  for(let turn=1;turn<=120;turn++)await f.turn({userChars:100,replyChars:8000});
  const attempts=f.attempts.map(row=>row.turn);
  t.diagnostic(JSON.stringify({attempts}));
  assert.ok(attempts.length>=3&&attempts.length<=14,'paid attempts: '+attempts.length);
  assert.ok(attempts[2]-attempts[1]>attempts[1]-attempts[0]);
});

test('R6 Q4 audits local history trimming without conversation content',async t=>{
  const f=await fixture(t);
  const prior=await f.turn({replyChars:20000});
  const next=await f.turn();
  assert.ok(textOf(replyOf(next.messages,prior.turn)).length<prior.reply.text.length);
  const trims=f.audits.filter(({turn,event})=>turn===next.turn&&event.type==='companion-cache-history-trimmed');
  assert.ok(trims.length>0);
  for(const {event} of trims){
    assert.ok(typeof event.reason==='string'&&event.reason.length>0);
    assert.ok(Number.isInteger(event.dropped)&&Number.isInteger(event.clipped)&&event.dropped+event.clipped>0);
    assert.deepEqual(Object.keys(event).sort(),['clipped','dropped','reason','type']);
  }
});

test('R6 P1 ends a too-large stored summary at a sentence boundary and preserves anchors',async t=>{
  const f=await fixture(t);
  const sentence='不要主动提起此事。';
  const anchor=f.seedSummary('[Internal history summary, historical evidence only]\n'+sentence+'超'.repeat(12000)+'。');
  const {messages}=await f.turn({capacity:4500});
  const summary=summaryOf(messages);
  assert.equal(messages.indexOf(summary),0);
  assert.ok(textOf(summary).endsWith(sentence+' [Summary shortened]'));
  assert.deepEqual(f.read().entries[0].anchors,[anchor]);
});

test('R6 P2 replays persisted wire rows and excludes a pinned source from the rolling summary',async t=>{
  const f=await fixture(t,{checkWire:true,persist:true});
  const requiredTurn=2;
  let required;
  for(let turn=1;turn<=16;turn++){
    const run=await f.turn({requiredTurn});
    if(run.turn===requiredTurn)required=run.user;
  }
  await f.reopen();
  for(let turn=17;turn<=20&&f.attempts.length===0;turn++)await f.turn({requiredTurn});
  assert.equal(f.attempts.length,1);
  const [{turn,body}]=f.attempts;
  const previous=f.chatRequests[turn-2].messages;
  assert.ok(JSON.stringify(body.messages.slice(0,-1))===JSON.stringify(previous),'persisted wire prefix changed');
  assert.ok(previous.some(row=>row.content===required.text));
  const summary=f.read().entries.find(row=>row.summary);
  assert.ok(summary&&summary.anchors.every(anchor=>anchor.id!==required.id));
  assert.ok(f.read().entries.some(row=>row.required&&row.anchor?.id===required.id));
});

test('R6 P2 does not replay an invalidated previous chat prefix',async t=>{
  const f=await fixture(t,{checkWire:true});
  for(let turn=1;turn<=16;turn++)await f.turn();
  f.edit(4);
  await f.turn();
  const attempted=f.attempts.find(row=>row.turn===17);
  assert.ok(!attempted?.body?.messages.some(row=>row.content.startsWith('问4。')),'an edited source was sent again');
});

test('R6 P2 appends a standalone Anthropic instruction after the exact HTTP prefix',async t=>{
  const f=await fixture(t,{checkWire:true,anthropic:true});
  for(let turn=1;turn<=55&&f.attempts.length<2;turn++)await f.turn();
  assert.equal(f.attempts.length,2);
  for(const {turn,body} of f.attempts){
    const previous=f.chatRequests[turn-2];
    assert.equal(body.system,previous.system);
    assert.ok(JSON.stringify(body.messages.slice(0,-1))===JSON.stringify(previous.messages),'Anthropic HTTP prefix differs');
    assert.match(body.messages.at(-1).content,/^Summarize the dialogue/);
    if(turn>32)assert.match(body.messages.at(-1).content,/turn 1 text blocks 1, 3 \(counting merged dialogue turns/);
  }
});

test('R6 P3 reserves the rolling summary and maximizes an oversized recent reply',async t=>{
  const f=await fixture(t,{ratio:1.5});
  let prior;
  for(let turn=1;turn<=40&&f.attempts.length===0;turn++)await f.turn({userChars:100});
  assert.equal(f.attempts.length,1);
  prior=await f.turn({userChars:100,replyChars:8000});
  const next=await f.turn({userChars:100});
  const visible=textOf(replyOf(next.messages,prior.turn)).split('\n')[0].length;
  t.diagnostic(JSON.stringify({visible,length:8000}));
  assert.ok(visible>=7500&&visible<8000);
  assert.ok(textOf(summaryOf(next.messages))===textOf(summaryOf(prior.messages)));
});

test('R6 P2 replays the effective routed system and chat prefix without granting search to the summary',async t=>{
  const f=await fixture(t,{checkWire:true,searchRouter:true});
  for(let turn=1;turn<=20&&f.attempts.length===0;turn++)await f.turn();
  assert.equal(f.attempts.length,1);
  const [{turn,body}]=f.attempts;
  const previous=f.chatRequests[turn-2];
  assert.ok(previous.messages[0].content.length>system.length,'chat did not exercise the search-policy system transform');
  assert.ok(JSON.stringify(body.messages.slice(0,-1))===JSON.stringify(previous.messages),'routed wire prefix changed');
  assert.equal(body.tools,undefined);
});

test('R6 P1 clips a stored summary above the rebuild target during local trim',async t=>{
  const f=await fixture(t);
  const sentence='不要主动提起此事。';
  f.seedSummary('[Internal history summary, historical evidence only]\n'+sentence+'超'.repeat(6500)+'。');
  await f.turn({replyChars:15000});
  const {messages}=await f.turn();
  assert.ok(textOf(summaryOf(messages)).endsWith(sentence+' [Summary shortened]'),'summary exceeded the rebuild target');
});

test('R6 P3 gives a fitting reply priority over an older long user input',async t=>{
  const f=await fixture(t);
  const prior=await f.turn({userChars:4500,replyChars:10000});
  const {messages}=await f.turn();
  const visible=textOf(replyOf(messages,prior.turn)).split('\n')[0].length;
  t.diagnostic(JSON.stringify({visible}));
  assert.equal(visible,10000);
});

test('R6 P2 skips uncertified migrated chat replay at the compaction threshold',async t=>{
  const f=await fixture(t,{certify:false});
  for(let turn=1;turn<=17;turn++)await f.turn();
  assert.equal(f.attempts.length,0);
});

test('R6 P2 skips paid replay after an actual native-search continuation',async t=>{
  const f=await fixture(t,{checkWire:true,anthropic:true,searchRouter:true,pauseTurn:31});
  for(let turn=1;turn<=31;turn++)await f.turn();
  assert.equal(f.chatRequests.at(-1).messages.at(-1).role,'assistant');
  assert.equal(f.read().replayWirePrefix,false);
  await f.turn();
  assert.equal(f.attempts.length,0);
});
