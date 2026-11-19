import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionCacheStore} from '../src/companion-cache-store.mjs';
import {cacheHash,preparePrivateWindow,privateMessageAnchor} from '../src/companion-chat-cache.mjs';
import {privateWireMessage} from '../src/companion-prompt-parts.mjs';
import {privateHistoryPolicy} from '../src/api-cache-capabilities.mjs';

const selected={provider:'fixture',model:'synthetic'};
const wire=(role,text)=>privateWireMessage(role,text,selected);
const textOf=message=>message.content[0].text;
const system='Synthetic R5 private instructions.';
const reserve=1600;
const marker=/\[History excerpt\]/;
const profiles=[
 {name:'8k',budget:8000,target:3200,profile:{kind:'custom',protocol:'chat-completions',baseUrl:'http://localhost:1/v1',model:'synthetic'}},
 {name:'16k',budget:16000,target:8000,profile:{kind:'openai',protocol:'chat-completions',baseUrl:'https://api.openai.com/v1',model:'synthetic'}},
 {name:'32k',budget:32000,target:12800,profile:{kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash'}},
];

// The fixtures only use ASCII and Chinese BMP characters. A separate fixture
// estimator and the actual serialized request check the two budget dimensions.
const plainTokens=text=>Math.ceil([...text].reduce((weight,char)=>weight+(char.charCodeAt(0)<128?30:65),0)/100)+4;
const count=(messages,ratio)=>Math.ceil(ratio*messages.reduce((total,message)=>total+plainTokens(textOf(message)),0));
const rawAt=(turn,kind,length)=>String(turn).padStart(3,'0')+' '+kind.repeat(length-4);
const spacing=turns=>turns.length<2?null:Math.min(...turns.slice(1).map((turn,index)=>turn-turns[index]));
const replacesPrefix=(previous,current)=>previous.length>0&&!previous.every((row,index)=>row===current[index]);

async function fixture({profile=profiles[0].profile,ratio=1,capacity=272000,compact=()=> '摘'.repeat(500)+'。'}={}){
 const store=createCompanionCacheStore(null);
 await store.ready();store.isDurable=()=>true;
 const scope={key:'fixture-r5',characterId:'synthetic',conversationId:'synthetic'};
 const originals=new Map(),history=[],attempts=[],audits=[];
 const put=(...rows)=>{for(const row of rows){originals.set(row.id,row);history.push(row);}};
 const entryOf=row=>({anchor:privateMessageAnchor(row),message:wire(row.role,row.text)});
 let ordinal=0;
 return {
  store,scope,history,attempts,audits,put,entryOf,
  async prepare({
   userChars=100,replyChars=1500,userText,seed,previous=store.read(scope.key),required=[],
   localCapacity=capacity,validEntry=()=>true,skipCompaction=false,parent=previous?.parent??null,localOrder,
  }={}){
   const turn=++ordinal,requestId='r5-'+turn;
   const user={id:requestId+':user',role:'user',text:userText??rawAt(turn,'问',userChars),status:'sent',requestId};
   const reply={id:requestId+':reply',role:'assistant',text:rawAt(turn,'答',replyChars),requestId};
   let modelMs=0;
   const start=performance.now();
   const window=await preparePrivateWindow({
    store,scope,previous,requestId,connectionKey:'fixture',calibration:{read:()=>ratio},wireSystem:system,
    entries:(seed??history.slice(-14)).map(row=>({...entryOf(row),required:required.includes(row.id)})),selected,
    historyPolicy:privateHistoryPolicy(profile),capacity:{tokens:localCapacity,reserveTokens:reserve},parent,
    buildCurrent:()=>({message:wire('user',user.text)}),
    buildBaseline:()=>({memoryBaseline:true,anchors:[],message:wire('user','[Current memoryState]{}')}),
    validEntry,skipCompaction,localOrder,assertScope(){},async verifyEntries(){},
    lookup:id=>originals.get(id),audit:event=>audits.push({turn,...event}),
    async compact(request){
     const start=performance.now();
     attempts.push({turn,request});
     try{return await compact(request,turn);}
     finally{modelMs+=performance.now()-start;}
    },
   });
   return {window,turn,user,reply,modelMs,prepareMs:performance.now()-start-modelMs,
    async commit(){put(user,reply);window.observeWireSystemMode('plain',true);window.observeAssistant(reply.text);return window.commit();},
    async interrupt(){put({...user,status:'failed'});window.markSubmitted();await window.interrupt(undefined,'Synthetic partial');},
   };
  },
 };
}

function optionalHistory(messages,requiredTexts=[]){
 return messages.filter(message=>!textOf(message).startsWith('[Current memoryState]')&&!requiredTexts.includes(textOf(message)));
}

test('R5 N1 bounds and measures sent history across three tiers, four ratios and two capacities',async t=>{
 const violations=[];
 for(const {name,profile,budget} of profiles)for(const ratio of [.5,1,1.5,2])for(const capacity of [32768,272000]){
  for(const [label,userChars,replyLength] of [
   ['1500',100,()=>1500],
   ['range',100,turn=>[1500,2400,4000,6500,8000][(turn-1)%5]],
   ['8000',8000,()=>8000],
  ]){
   const f=await fixture({profile,ratio,capacity});
   let previous=[],currentUser,maxHistory=0,maxChars=0,maxBytes=0,convertedUsers=0,emptyAfterStart=0,maxSummary=0;
   const resets=[],sent=[];
   let rawLast=0,giantTurns=0,peakAfterGiant=0,paidAfterGiant=0;
   for(let turn=1;turn<=30;turn++){
    const run=await f.prepare({userChars,replyChars:replyLength(turn)});
    const {messages}=run.window;
    sent.push(messages);
    const rows=optionalHistory(messages.slice(0,-1));
    const current=rows.map(row=>JSON.stringify(row));
    if(replacesPrefix(previous,current))resets.push(turn);
    if(turn>1&&!rows.length)emptyAfterStart++;
    if(currentUser&&rows.some(row=>row.role==='user'&&textOf(row).startsWith(currentUser.slice(0,4))&&textOf(row)!==currentUser))convertedUsers++;
    currentUser=textOf(messages.at(-1));
    if(currentUser!==run.user.text)violations.push([name,ratio,capacity,label,turn,'current']);
    previous=current;
    const cost=count(rows,ratio);
    maxHistory=Math.max(maxHistory,cost);
    if(rawLast>budget){
     giantTurns++;
     peakAfterGiant=Math.max(peakAfterGiant,cost);
     if(f.attempts.at(-1)?.turn===turn)paidAfterGiant++;
    }
    rawLast=count([wire('user',run.user.text),wire('assistant',run.reply.text)],ratio);
    const json=JSON.stringify(messages);
    maxChars=Math.max(maxChars,json.length);
    maxBytes=Math.max(maxBytes,Buffer.byteLength(json));
    if(count(messages,ratio)>budget+count([...messages.slice(0,-1).filter(row=>!rows.includes(row)),messages.at(-1)],ratio))
     violations.push([name,ratio,capacity,label,turn,'request-token-bound']);
    assert.equal(await run.commit(),true);
   }
   for(const {turn,request} of f.attempts){
    const replay=request.messages.slice(0,-1),prior=sent[turn-2];
    const publishedPrefix=prior?.length===replay.length&&prior.every((row,index)=>JSON.stringify(row)===JSON.stringify(replay[index]));
    const history=publishedPrefix?replay.slice(0,-1):replay;
    maxSummary=Math.max(maxSummary,count(optionalHistory(history),ratio));
    if(Buffer.byteLength(JSON.stringify(request.messages))+Buffer.byteLength(system)+request.maxTokens+192>capacity)
     violations.push([name,ratio,capacity,label,'summary-capacity']);
   }
   await f.store.close();
   const minInterval=spacing(resets);
   t.diagnostic(JSON.stringify({name,ratio,capacity,label,maxHistory,maxSummary,maxChars,maxBytes,attempts:f.attempts.length,resets,minInterval,convertedUsers,emptyAfterStart,giantTurns,peakAfterGiant,paidAfterGiant}));
   if(maxHistory>budget||maxSummary>budget||maxBytes+Buffer.byteLength(system)+reserve+192>capacity||emptyAfterStart)
    violations.push([name,ratio,capacity,label,'budget-or-retention']);
   if(peakAfterGiant>budget||paidAfterGiant)violations.push([name,ratio,capacity,label,'giant-turn-budget',peakAfterGiant,paidAfterGiant]);
   if(label==='1500'&&(minInterval===1||name==='8k'&&ratio===2&&minInterval===null))
    violations.push([name,ratio,capacity,label,'prefix-interval']);
  }
 }
 assert.ok(violations.length===0,'violations '+JSON.stringify(violations.slice(0,12))+' of '+violations.length);
});

test('R5 N1 bounds legacy and retry requests, preserves mandatory originals and clips with original anchors',async t=>{
 const f=await fixture({ratio:2});
 t.after(()=>f.store.close());
 const original={id:'oversized-required',role:'user',text:rawAt(90,'源',7500)};
 const old=[original,...Array.from({length:14},(_,index)=>({
  id:'legacy-'+index,role:index%2?'assistant':'user',text:rawAt(91+index,'史',1800),
 }))];
 f.put(...old);
 const legacy={entries:old.map(f.entryOf),sessionUuid:'11111111-1111-4111-8111-111111111111',
  instructionsHash:cacheHash(system),parent:privateMessageAnchor(old.at(-1))};
 const regular=await f.prepare({previous:legacy,seed:old,required:[original.id]});
 const retry=await f.prepare({previous:legacy,seed:old,required:[original.id],skipCompaction:true});
 const bounds=[regular,retry].map(({window})=>count(optionalHistory(window.messages.slice(0,-1),[original.text]),2));
 const summaryBounds=f.attempts.map(({request})=>count(optionalHistory(request.messages.slice(0,-1),[original.text]),2));
 t.diagnostic(JSON.stringify({bounds,summaryBounds,attempts:f.attempts.length}));
 assert.ok(bounds.every(number=>number<=8000)&&summaryBounds.every(number=>number<=8000));
 for(const {window} of [regular,retry])assert.equal(window.messages.filter(row=>textOf(row)===original.text).length,1);

 const transmitted=f.attempts[0]?.request.messages;
 assert.ok(transmitted?.length>1,'the inflated legacy input exercises bounded summary replay');
 const sourceCount=Number(textOf(transmitted.at(-1)).match(/first (\d+) messages above/)?.[1]);
 assert.ok(sourceCount>0&&sourceCount<old.length);
 const addressed=transmitted.slice(0,sourceCount);
 const expectedSources=old.filter(row=>addressed.some(message=>{
  const represented=textOf(message).split('\n[History excerpt]')[0];
  return message.role===row.role&&(textOf(message)===row.text||marker.test(textOf(message))&&row.text.startsWith(represented));
 })).map(row=>row.id).sort();
 assert.equal(await regular.commit(),true);
 const savedSummary=f.store.read(f.scope.key).entries.find(row=>row.summary);
 assert.deepEqual(savedSummary.anchors.map(anchor=>anchor.id).sort(),expectedSources);

 await f.store.clearScope({conversationId:f.scope.conversationId});
 const huge=await f.prepare({seed:[],userChars:8000,replyChars:8000});
 assert.equal(await huge.commit(),true);
 const next=await f.prepare({seed:[]});
 const again=await f.prepare({seed:[]});
 const nextHistory=next.window.messages.slice(0,-1),againHistory=again.window.messages.slice(0,-1);
 assert.ok(count(optionalHistory(nextHistory),2)<=8000);
 assert.ok(nextHistory.some(row=>row.role==='user'&&marker.test(textOf(row))));
 assert.ok(nextHistory.some(row=>row.role==='assistant'&&marker.test(textOf(row))));
 assert.equal(JSON.stringify(nextHistory),JSON.stringify(againHistory),'retry must repeat the deterministic excerpt');
 assert.ok(next.window.inputVersions.some(row=>row.id===huge.reply.id));
 assert.ok(f.history.some(row=>row.id===huge.reply.id&&row.text.length===8000));

 const required=await f.prepare({seed:f.history,required:[huge.user.id,huge.reply.id]});
 for(const row of [huge.user,huge.reply]){
  const matching=required.window.messages.filter(message=>message.role===row.role&&textOf(message).startsWith(row.text.slice(0,4)));
  assert.equal(matching.length,1,'a previously clipped row must be replaced by its original when required');
  assert.ok(textOf(matching[0])===row.text);
 }
});

test('R5 N1 restores the full required original in its chronological place',async t=>{
 const f=await fixture({ratio:2});
 t.after(()=>f.store.close());
 const older={id:'earlier-required',role:'user',text:'Synthetic earlier required original'};
 f.put(older);
 const huge=await f.prepare({seed:[],userChars:8000,replyChars:8000});
 assert.equal(await huge.commit(),true);
 const small=await f.prepare({seed:[]});
 assert.ok(small.window.messages.slice(0,-1).some(row=>row.role==='user'&&marker.test(textOf(row))));
 await small.commit();

 const ordered=f.history.map(row=>row.id);
 const {window}=await f.prepare({
  seed:[older,huge.user],required:[older.id,huge.user.id],localOrder:anchor=>ordered.indexOf(anchor.id),
 });
 const present=new Set(window.inputVersions.map(row=>row.id));
 assert.deepEqual(window.inputVersions.map(row=>row.id),ordered.filter(id=>present.has(id)));
 assert.ok(ordered.slice(-2).every(id=>present.has(id)));
 const olderIndex=window.messages.findIndex(row=>textOf(row)===older.text);
 const hugeIndex=window.messages.findIndex(row=>textOf(row)===huge.user.text);
 assert.ok(olderIndex>=0&&hugeIndex>olderIndex);
});

test('R5 N2 persistent summary errors keep a bounded and reusable history for 120 turns',async t=>{
 const results=[];
 for(const capacity of [32768,272000]){
  const f=await fixture({capacity,compact(){throw Object.assign(Error('Synthetic summary request failed'),{code:'SUMMARY_REQUEST_FAILED'});}});
  let previous=[],maxHistory=0;
  const resets=[];
  for(let turn=1;turn<=120;turn++){
   const run=await f.prepare({userChars:300,replyChars:500});
   const rows=optionalHistory(run.window.messages.slice(0,-1));
   const current=rows.map(row=>JSON.stringify(row));
   if(replacesPrefix(previous,current))resets.push(turn);
   previous=current;
   maxHistory=Math.max(maxHistory,count(rows,1));
   assert.equal(await run.commit(),true);
  }
  await f.store.close();
  const result={capacity,attempts:f.attempts.map(row=>row.turn),resets,minInterval:spacing(resets),maxHistory};
  t.diagnostic(JSON.stringify(result));
  results.push(result);
 }
 assert.ok(results[0].attempts.length===0&&results[1].attempts.length<=13&&results[1].attempts.length>0);
 assert.ok(results.every(row=>row.maxHistory<=8000&&row.minInterval>=2));
});

test('R5 N2 cooldown survives invalidated rows, a changed fingerprint, and interrupted turns before recovery',async t=>{
 let fail=true;
 const f=await fixture({compact(){
  if(fail)throw Object.assign(Error('Synthetic summary request failed'),{code:'SUMMARY_REQUEST_FAILED'});
  return 'Synthetic rolling summary '+f.attempts.length;
 }});
 t.after(()=>f.store.close());
 const seedBatch=page=>Array.from({length:22},(_,index)=>({
  id:page+'-'+index,role:index%2?'assistant':'user',text:rawAt(index,'史',600),
 }));
 const seed=seedBatch('original');
 f.put(...seed);
 const first=await f.prepare({seed,userChars:300,replyChars:500});
 assert.equal(f.attempts.length,1);
 await f.prepare({seed});
 assert.equal(f.attempts.length,1,'failed summary is remembered before the chat submits');
 assert.equal(await first.commit(),true);
 fail=false;
 const nextSeed=seedBatch('edited');
 f.put(...nextSeed);
 const priorRow=f.store.read(f.scope.key).entries.find(row=>row.anchor?.id.startsWith('original-'));
 assert.ok(priorRow,'the failed round must retain an anchored original for the invalidation scenario');
 await f.store.invalidateMessages([{ownerId:f.scope.conversationId,id:priorRow.anchor.id}]);
 const interrupted=await f.prepare({seed:nextSeed,parent:privateMessageAnchor(first.reply),validEntry:row=>!row.anchor?.id.startsWith('original-')});
 await interrupted.interrupt();
 assert.equal(f.attempts.length,1,'editing and interrupting do not consume or reset cooldown');
 const allowed=await f.prepare();
 assert.ok(allowed.window.messages.some(row=>textOf(row).includes('[Previous turn interrupted]')));
 await allowed.commit();

 for(let turn=0;turn<40&&f.attempts.length<3;turn++){
  const run=await f.prepare({userChars:300,replyChars:500});
  await run.commit();
 }
 t.diagnostic(JSON.stringify({attempts:f.attempts.map(row=>row.turn)}));
 assert.equal(f.attempts.length,3);
 assert.ok(f.attempts[1].turn-f.attempts[0].turn>3);
 assert.ok(f.attempts[2].request.messages.some(row=>textOf(row).includes('Synthetic rolling summary 2')));
});

test('R5 N5 a real long-tier compaction adds under 10 ms to nearby ordinary prepares',async t=>{
 const f=await fixture({profile:profiles[2].profile,capacity:272000});
 t.after(()=>f.store.close());
 const times=[];
 for(let turn=1;turn<=400;turn++){
  const run=await f.prepare({userChars:60,replyChars:120});
  times.push({turn,ms:run.prepareMs,modelMs:run.modelMs,compacted:f.attempts.at(-1)?.turn===turn});
  assert.equal(await run.commit(),true);
 }
 const compactions=times.filter(row=>row.compacted).map(row=>{
  const recent=times.slice(Math.max(0,row.turn-11),row.turn-1).filter(entry=>!entry.compacted).map(entry=>entry.ms).sort((a,b)=>a-b);
  const ordinaryMs=recent[Math.floor(recent.length/2)];
  return {...row,ordinaryMs,extraMs:row.ms-ordinaryMs};
 });
 t.diagnostic(JSON.stringify(compactions));
 assert.ok(compactions.length>0);
 assert.ok(compactions.every(row=>row.extraMs<10),'compaction prepare overhead exceeds 10ms');
});
