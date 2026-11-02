import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {scheduleRenderedAck,createR95ActionClient} from '../src/r95-core-page.mjs';
import {CompanionGroupStage} from '../src/group-stage-ui.mjs';
import {CompanionGroupDialogue} from '../src/companion-ui.mjs';
import {AutoRoundStrip,ChatR95CSS} from '../src/chat-r95-ui.mjs';
import {CompanionDesignCSS} from '../src/companion-design.mjs';
import {setLocale} from '../src/i18n.mjs';
import {groupDialogueText} from '../src/group-stage.mjs';

const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
const scope={characterId:'claude',personaId:'default',lifeId:'life',operationId:'operation',channel:'app-group',conversationId:'group'};
const reply={id:'message',role:'assistant',characterId:'deepseek',characterName:'DeepSeek',text:'A complete reply.',status:'presented',autoRequestId:'auto-request'};
const members=['claude','deepseek','chatgpt','hunyuan'];
const names={claude:'Claude',deepseek:'DeepSeek',chatgpt:'GPT',hunyuan:'Hunyuan'};
const auto=overrides=>({id:'current-auto',status:'active',mode:'rounds',roundLimit:6,roundIndex:1,opportunityIndex:1,members,completed:{},pending:null,...overrides});
function state(autoValue=auto(),overrides={}){
 return {activeGroupId:'group',groups:[{id:'group',name:'Group',memberIds:members,personaId:'default'}],characters:members.map(id=>({id,name:names[id]})),personas:[],groupMessages:[{id:'user',role:'user',text:'Start.'},reply],groupRuntime:{status:'idle',queue:[],currentMessage:reply,streaming:null,canRetry:false,canContinue:false},r95:{scope,groupId:'group',settings:{auto:true},lines:[],auto:autoValue},...overrides};
}
const props=value=>({state:value,request:async()=>({ok:true}),chat:{enabled:true}});
async function settle(){for(let i=0;i<16;i++)await Promise.resolve();}
function detailsBlock(html,attribute){
 const start=html.search(new RegExp('<details\\b[^>]*'+attribute+'(?:=|\\s|>)'));
 assert.ok(start>=0,'Expected an accessible progress details control: '+attribute);
 const tokens=/<\/?details\b[^>]*>/g;tokens.lastIndex=start;let depth=0,match;
 while((match=tokens.exec(html))){depth+=match[0].startsWith('</')?-1:1;if(depth===0)return html.slice(start,tokens.lastIndex);}
 assert.fail('Unclosed details control');
}
function target(){const listeners=new Map();return {listeners,addEventListener(event,callback){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(callback);},removeEventListener(event,callback){listeners.get(event)?.delete(callback);},signal(event){for(const fn of listeners.get(event)??[])fn();}};}
function frames({ready=true,send=()=>({acknowledged:true})}={}){
 const previousWindow=globalThis.window,win={...target(),innerWidth:1000,innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};globalThis.window=win;
 let modal=false,next=1,sendCount=0,errorCount=0;const jobs=new Map(),timers=new Map(),observers=new Set(),errors=[],timerDelays=[];
 const node={dataset:ready?{groupMessageId:reply.id,autoRequestId:reply.autoRequestId}:{},textContent:reply.text,isConnected:true,parentElement:null,getClientRects:()=>[{}],getBoundingClientRect:()=>({width:200,height:50,top:20,left:20,right:220,bottom:70}),getAttribute:()=>null};
 const doc={...target(),hidden:false,documentElement:{},defaultView:win,querySelector:()=>modal?{}:null,querySelectorAll:()=>node.dataset.groupMessageId?[node]:[]};node.ownerDocument=doc;
 class Observer{constructor(callback){this.callback=callback;observers.add(this);}observe(root,options){this.options=options;}disconnect(){observers.delete(this);}}
 const requestFrame=callback=>{const id=next++;jobs.set(id,callback);return id;},cancelFrame=id=>jobs.delete(id),setTimer=(callback,delay)=>{const id=next++;timerDelays.push(delay);timers.set(id,callback);return id;},clearTimer=id=>timers.delete(id);
 let cancel=()=>{};
 return {doc,node,win,jobs,timers,timerDelays,Observer,requestFrame,cancelFrame,setTimer,clearTimer,
  start(extra={}){cancel=scheduleRenderedAck({document:doc,requestFrame,cancelFrame,Observer,setTimer,clearTimer,isReady:()=>!!node.dataset.groupMessageId&&!!node.dataset.autoRequestId&&node.textContent===reply.text,send:()=>{sendCount++;return send(sendCount);},onError:error=>{errorCount++;errors.push(error);},...extra});return cancel;},
  get sent(){return sendCount;},get failed(){return errorCount;},errors,
  frame(){const callbacks=[...jobs.values()];jobs.clear();for(const fn of callbacks)fn();},
  timer(){const callbacks=[...timers.values()];timers.clear();for(const fn of callbacks)fn();},
  mutate(type,attributeName){for(const observer of observers){const options=observer.options,accepted=type==='attributes'?options.attributes&&(!options.attributeFilter||options.attributeFilter.includes(attributeName)):type==='characterData'?options.characterData:options.childList;if(accepted)observer.callback([{type,attributeName,target:node}],observer);}},
  data(){node.dataset.groupMessageId=reply.id;node.dataset.autoRequestId=reply.autoRequestId;this.mutate('attributes','data-group-message-id');this.mutate('attributes','data-auto-request-id');},
  setModal(value){modal=value;},close(){cancel();globalThis.window=previousWindow;}
 };
}
function captureStage(value,request=async()=>({ok:true,r95Result:{acknowledged:true}})){
 const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
 assert.ok(internals&&'H'in internals,'The installed React dispatcher must be available for a hook-only capture');
 const previous=internals.H,effects=[];
 internals.H={useRef:initial=>({current:initial}),useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useEffect:(callback,dependencies)=>effects.push({callback,dependencies})};
 try{CompanionGroupStage({state:value,request});}finally{internals.H=previous;}
 const effect=effects.find(row=>row.callback.toString().includes('auto-rendered'));
 assert.ok(effect,'Expected the actual group rendered ACK effect');return effect;
}

test('group ACK wakes when only message data attributes arrive after the initial not-ready check',async t=>{
 const f=frames({ready:false});t.after(()=>f.close());f.start();assert.equal(f.jobs.size,0);f.data();assert.equal(f.jobs.size,1);f.frame();await settle();assert.equal(f.sent,0);f.frame();await settle();assert.equal(f.sent,1);
});
test('group ACK wakes for character data readiness and still waits two frames',async t=>{
 const f=frames();t.after(()=>f.close());f.node.textContent='partial';f.start();f.node.textContent=reply.text;f.mutate('characterData');assert.equal(f.jobs.size,1);f.frame();await settle();assert.equal(f.sent,0);f.frame();await settle();assert.equal(f.sent,1);
});
test('a rejected ACK retries after a timer through fresh hidden/modal and two-frame checks',async t=>{
 const f=frames({send:count=>count===1?Promise.reject(Error('temporary bridge error')):{acknowledged:true}});t.after(()=>f.close());f.start();f.frame();f.frame();await settle();assert.equal(f.sent,1);assert.equal(f.timers.size,1);
 f.doc.hidden=true;f.timer();f.frame();f.frame();await settle();assert.equal(f.sent,1,'A retry must not acknowledge a hidden document');
 f.doc.hidden=false;f.setModal(true);f.doc.signal('visibilitychange');f.frame();f.frame();await settle();assert.equal(f.sent,1,'An open modal still blocks the retry');
 f.setModal(false);f.mutate('attributes','open');f.frame();await settle();assert.equal(f.sent,1);f.frame();await settle();assert.equal(f.sent,2);assert.equal(f.timers.size,0);
});
test('ACK retries are finite and unmount cancels a queued retry',async t=>{
 const f=frames({send:()=>Promise.reject(Error('still unavailable'))});t.after(()=>f.close());const cancel=f.start();f.frame();f.frame();await settle();assert.equal(f.timers.size,1);
 let attempts=0;while(f.timers.size&&attempts++<12){f.timer();f.frame();f.frame();await settle();}
 assert.equal(f.sent,4,'One initial attempt and exactly three communication retries');assert.deepEqual(f.timerDelays,[250,1000,2500]);assert.equal(f.timers.size,0);assert.equal(f.jobs.size,0);f.close();
 const g=frames({send:()=>Promise.reject(Error('temporary'))});t.after(()=>g.close());const stop=g.start();g.frame();g.frame();await settle();assert.equal(g.timers.size,1);stop();assert.equal(g.timers.size,0);g.timer();g.frame();g.frame();await settle();assert.equal(g.sent,1);cancel();
});
test('a non-retryable ACK rejection does not schedule a timer',async t=>{
 const f=frames({send:()=>Promise.reject(Object.assign(Error('stale message'),{retryable:false}))});t.after(()=>f.close());f.start();f.frame();f.frame();await settle();assert.equal(f.sent,1);assert.equal(f.timers.size,0);assert.equal(f.jobs.size,0);
});
test('auto-rendered action requires an explicit acknowledged receipt and preserves retryability',async()=>{
 for(const receipt of [{acknowledged:false,retryable:true,reason:'not-ready'},{acknowledged:false,reason:'stale-message'},{}]){
  const client=createR95ActionClient(async()=>({ok:true,r95Result:receipt}));
  await assert.rejects(client('auto-rendered',{groupId:'group',messageId:reply.id,autoRequestId:reply.autoRequestId,scope}),error=>error.retryable===(receipt.retryable===true));
 }
 const client=createR95ActionClient(async()=>({ok:true,r95Result:{acknowledged:true,duplicate:true}}));assert.deepEqual(await client('auto-rendered',{messageId:reply.id}),{acknowledged:true,duplicate:true});
});
test('the real GroupStage ACK effect depends on streaming readiness, not every streamed character',()=>{
 const noStream=state(),a=state(),b=state();a.groupRuntime={...a.groupRuntime,streaming:{requestId:reply.id,text:'partial'}};b.groupRuntime={...b.groupRuntime,streaming:{requestId:reply.id,text:'a longer partial'}};
 assert.deepEqual(captureStage(a).dependencies,captureStage(b).dependencies,'Changing nonempty stream text must not rebuild the ACK controller');assert.notDeepEqual(captureStage(a).dependencies,captureStage(noStream).dependencies,'Clearing the stream must recheck the stable message DOM');
});
test('the real GroupStage sends the full group/message/request/scope identity through the action client',async t=>{
 const f=frames(),saved=Object.fromEntries(['document','requestAnimationFrame','cancelAnimationFrame','MutationObserver'].map(key=>[key,globalThis[key]]));let cleanup;t.after(()=>{cleanup?.();Object.assign(globalThis,saved);f.close();});Object.assign(globalThis,{document:f.doc,requestAnimationFrame:f.requestFrame,cancelAnimationFrame:f.cancelFrame,MutationObserver:f.Observer});const calls=[];
 const effect=captureStage(state(),async(action,payload)=>{calls.push({action,payload});return {ok:true,r95Result:{acknowledged:true}};});cleanup=effect.callback();f.frame();f.frame();await settle();assert.deepEqual(calls,[{action:'companion-r95',payload:{action:'auto-rendered',args:{groupId:'group',messageId:reply.id,autoRequestId:reply.autoRequestId,scope}}}]);
});
test('paused or failed Auto keeps its own compact progress instead of exposing the cumulative manual round',()=>{
 setLocale('zh-CN');const history=[{id:'u',role:'user',text:'Start.'},...Array.from({length:20},(_,index)=>({...reply,id:'old-'+index,characterId:members[index%members.length]}))];
 for(const pending of [null,{characterId:'deepseek',requestId:'failed',status:'failed'}]){const value=state(auto({status:'paused',pending}),{groupMessages:history});value.groupRuntime={...value.groupRuntime,status:pending?'failed':'idle',canRetry:!!pending,queue:pending?['deepseek']:[],error:pending?'Request rejected':null};const html=render(CompanionGroupDialogue,props(value));assert.match(html,/data-auto-strip="group"/);assert.doesNotMatch(html,/data-group-round/);if(pending)assert.match(html,/重试 DeepSeek/);}
});
test('a paused Auto does not hide ordinary interjection continuation or stop controls',()=>{
 setLocale('zh-CN');const user={id:'interjection',role:'user',text:'A new ordinary turn.'},normal={...reply,id:'ordinary-reply',autoRequestId:undefined};
 for(const mode of ['list',undefined]){const value=state(auto({status:'paused'}),{groupMessages:[reply,user,normal],groupRuntime:{mode,roundId:'ordinary-round',status:'awaiting-continue',queue:['claude','chatgpt'],currentMessage:normal,pendingMessage:null,streaming:null,canContinue:true,canRetry:false}}),html=render(CompanionGroupDialogue,props(value));assert.match(html,/Auto 已暂停/);assert.match(html,/data-group-round/);const details=detailsBlock(html,'data-group-progress-details'),controls=html.replace(details,'');assert.match(controls,/data-companion-group-continue="true"/);assert.match(controls,/data-companion-group-stop="true"/);assert.doesNotMatch(controls,/disabled=""[^>]*data-companion-group-continue/);}
 const owned=state(auto({status:'paused',pending:{characterId:'deepseek',status:'failed'}}));owned.groupRuntime={...owned.groupRuntime,mode:'auto',roundId:'auto-round',status:'failed',queue:['deepseek'],canRetry:true,error:'Rejected'};assert.doesNotMatch(render(CompanionGroupDialogue,props(owned)),/data-group-round/);
});
for(const preserveLiteral of [false,true])test('GroupStage ACK exactly matches Dialogue for a name and source prefix'+(preserveLiteral?' explicitly quoted by the user':''),async t=>{
 const label='[2026-10-31; character-statement; group:group]',raw='DeepSeek：'+label+' 台词',message={...reply,text:groupDialogueText(raw,'DeepSeek'),request:{preserveSourceLiteral:preserveLiteral}},user={id:'u-prefix',role:'user',text:preserveLiteral?'请原样引用 '+label:'请继续讨论。'},value=state();value.groupMessages=[user,message];value.groupRuntime={...value.groupRuntime,mode:'auto',currentMessage:message};
 const expected=preserveLiteral?label+' 台词':'台词',html=render(CompanionGroupDialogue,props(value));assert.ok(html.includes('data-auto-request-id="auto-request">'+expected+'</div>'));assert.equal(message.text,label+' 台词','The stored/projected message remains intact');assert.equal(message.request.preserveSourceLiteral,preserveLiteral);
 const f=frames(),saved=Object.fromEntries(['document','requestAnimationFrame','cancelAnimationFrame','MutationObserver'].map(key=>[key,globalThis[key]]));let cleanup;t.after(()=>{cleanup?.();Object.assign(globalThis,saved);f.close();});Object.assign(globalThis,{document:f.doc,requestAnimationFrame:f.requestFrame,cancelAnimationFrame:f.cancelFrame,MutationObserver:f.Observer});let calls=0;f.node.textContent=expected+'wrong';cleanup=captureStage(value,async()=>{calls++;return {ok:true,r95Result:{acknowledged:true}};}).callback();f.frame();f.frame();await settle();assert.equal(calls,0,'A different body must not acknowledge, even when identities match');f.node.textContent=expected;f.mutate('characterData');f.frame();await settle();assert.equal(calls,0);f.frame();await settle();assert.equal(calls,1);assert.equal(message.text,label+' 台词');assert.equal(raw,'DeepSeek：'+label+' 台词');
});
test('Auto progress is collapsed, bounded, scoped to its completed records, and labels silent opportunities',()=>{
 setLocale('zh-CN');const current=auto({completed:{a:{characterId:'claude',roundIndex:0,opportunityIndex:0,status:'presented',messageId:'old'},b:{characterId:'deepseek',roundIndex:0,opportunityIndex:1,status:'silent',evidenceId:'silent-proof'},c:{characterId:'claude',roundIndex:1,opportunityIndex:0,status:'presented',messageId:'current'}}});const value=state(current);value.groupMessages.push({...reply,id:'foreign-old',characterName:'Old session only'});const html=render(CompanionGroupDialogue,props(value)),details=detailsBlock(html,'data-auto-progress-details');assert.doesNotMatch(details.match(/^<details[^>]*>/)[0],/\sopen(?:=|\s|>)/);assert.match(details,/data-auto-round-index="0"/);assert.match(details,/data-auto-round-index="1"/);assert.match(details,/沉默/);assert.doesNotMatch(details,/Old session only/);assert.match(html.replace(details,''),/暂停/);assert.match(html.replace(details,''),/停止/);assert.match(html.replace(details,''),/whg-line-now/,'Collapsing progress must not unmount the reply or its ACK DOM');
});
test('an ended Auto shows a compact summary until a new ordinary user round begins',()=>{
 setLocale('zh-CN');const value=state(auto({status:'ended',roundIndex:6,endedReason:'round-limit'}));let html=render(CompanionGroupDialogue,props(value));assert.match(html,/data-auto-ended/);assert.doesNotMatch(html,/data-group-round/);
 const user={id:'new-user',role:'user',text:'A new ordinary turn.'};value.groupMessages.push(user);value.groupRuntime={status:'queued',queue:['claude'],currentMessage:user,streaming:null,canRetry:false,canContinue:false};html=render(CompanionGroupDialogue,props(value));assert.match(html,/data-group-round/);assert.doesNotMatch(html,/data-auto-ended/);
});
test('ordinary progress defaults to collapsed and leaves continuation and stop outside its details',()=>{
 setLocale('zh-CN');const value=state(null);value.groupRuntime={...value.groupRuntime,status:'awaiting-continue',queue:['claude','chatgpt'],canContinue:true};const html=render(CompanionGroupDialogue,props(value)),details=detailsBlock(html,'data-group-progress-details');assert.doesNotMatch(details.match(/^<details[^>]*>/)[0],/\sopen(?:=|\s|>)/);const controls=html.replace(details,'');assert.match(controls,/data-companion-group-continue/);assert.match(controls,/data-companion-group-stop/);assert.match(controls,/whg-line-now/);
});
test('expanded progress bodies have a 120px internal scrolling limit',()=>{
 const css=CompanionDesignCSS+'\n'+ChatR95CSS,body=css.match(/\.buddy-progress-body\s*\{([^}]+)\}/)?.[1];assert.ok(body,'Use one bounded progress body for ordinary and Auto details');assert.match(body,/max-height:\s*120px/);assert.match(body,/overflow(?:-y)?:\s*auto/);
});
test('Auto uses actual wait reasons while non-blocked generation takes precedence and older views stay conservative',()=>{
 setLocale('zh-CN');const waiting={presenting:/等待上一句显示/,input:/等待输入结束/,model:/等待模型/,['awaiting-user']:/等待你的回复/,['not-visible']:/等待对话窗口可见/,ready:/准备下一位/};
 for(const[reason,label]of Object.entries(waiting)){const html=render(AutoRoundStrip,{view:{groupId:'group',auto:auto(),autoWait:{reason,messageId:reply.id,characterId:'deepseek'}},onAction:async()=>{},nameOf:id=>names[id]});assert.match(html,label);}
 const busy=render(AutoRoundStrip,{view:{groupId:'group',auto:auto(),autoWait:{reason:'presenting'}},onAction:async()=>{},nameOf:id=>names[id],busy:true,speaker:'DeepSeek'});assert.match(busy,/DeepSeek/);assert.match(busy,/正在说|正在回复/);assert.doesNotMatch(busy,/等待上一句显示/);
 const legacy=render(AutoRoundStrip,{view:{groupId:'group',auto:auto()},onAction:async()=>{},nameOf:id=>names[id]});assert.match(legacy,/Auto 进行中/);assert.doesNotMatch(legacy,/等待上一句显示/);
});
test('new progress and wait labels have English translations',()=>{
 setLocale('en');try{for(const reason of ['presenting','input','model','awaiting-user','not-visible','ready']){const html=render(AutoRoundStrip,{view:{groupId:'group',auto:auto(),autoWait:{reason}},onAction:async()=>{},nameOf:id=>names[id]});assert.doesNotMatch(html,/[\u3400-\u9fff]/);assert.match(html,/details/);}}finally{setLocale('zh-CN');}
});
