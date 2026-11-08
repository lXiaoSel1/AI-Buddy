import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require=createRequire(new URL('../package.json',import.meta.url));
const {transformSync}=require('esbuild');
const source=await readFile(new URL('../src/adapted/galgame-client.ts',import.meta.url),'utf8');
const setStart=source.indexOf('  const setS = (nextOrUpdater: any) => {');
const setEnd=source.indexOf('\n  useEffect(() => {',setStart);
const presentationStart=source.indexOf('  const privatePresentation=useRef');
const presentationEnd=[source.indexOf('\n  const [groupBrowseRequest',presentationStart),source.indexOf('\n  const group = activeCompanionGroup',presentationStart)].filter(index=>index>presentationStart).sort((a,b)=>a-b)[0];
assert.ok(setStart>=0&&setEnd>setStart&&presentationStart>setEnd&&presentationEnd>presentationStart,'real private presentation lifecycle must be extracted');
const compiled=transformSync(`function renderExtractedBlock(){\n${source.slice(setStart,setEnd)}\n${source.slice(presentationStart,presentationEnd)}\n}`,{loader:'ts',target:'es2022'}).code;
let createPrivatePresentation,privatePresentationKey;
try{({createPrivatePresentation,privatePresentationKey}=await import('../src/private-presentation.mjs'));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

async function fixture({replyMode='deferred',hidden=false,waiting=false,response}={}){
 const calls=[],applied=[],frames=new Map(),refs=[],effects=[],listeners=new Map();
 let view={key:'session',value:{companion:{revision:1,activeGroupId:null,activeCharacterId:'claude',activePersonaId:'default',activeConversationId:'conversation',characters:[{id:'claude',life:{id:'life'}}],messages:[{id:'reply',requestId:'request',lifeId:'life',lifeToken:{lifeId:'life',operationId:'operation'},role:'assistant',presentation:'pending'}]}}},requested=false,hook=0,effect=0,nextFrame=0;
 const document={hidden,querySelector:()=>null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const context=vm.createContext({createPrivatePresentation:()=>createPrivatePresentation({schedule:fn=>context.requestAnimationFrame(fn),cancel:id=>context.cancelAnimationFrame(id)}),privatePresentationKey,document,cacheKey:'session',companionPanel:null,
  voiceClient:{presentation:{requests:waiting?[{requestId:'request'}]:[]}},
  cachedView:()=>view.value,rememberView:()=>{},
  setViewState:fn=>{const next=fn(view);if(next!==view){requested=true;applied.push(next.value);}view=next;},
  useRef:initial=>{const index=hook++;return refs[index]??(refs[index]={current:initial});},
  useEffect:(fn,deps)=>{const index=effect++,old=effects[index],changed=!deps||!old||deps.some((value,i)=>value!==old.deps?.[i]);if(changed)effects[index]={fn,deps,previous:old,run:true};},
  requestAnimationFrame:fn=>{const id=++nextFrame;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
  callApi:(action,args)=>{calls.push({action,args});const next=structuredClone(view.value);if(replyMode==='presented')next.companion.messages.at(-1).presentation='presented';const result={view:next,...(replyMode==='deferred'?{presentationDeferred:true}:{})};return response?response(result,calls.length):Promise.resolve(result);}
 });
 vm.runInContext(compiled,context);
 function render(){hook=0;effect=0;context.s=view.value;vm.runInContext('renderExtractedBlock()',context);for(const entry of effects)if(entry?.run)entry.previous?.cleanup?.();for(const entry of effects)if(entry?.run){entry.cleanup=entry.fn();entry.run=false;delete entry.previous;}requested=false;}
 async function frame(){const queued=[...frames.values()];frames.clear();for(const fn of queued)fn();for(let i=0;i<10;i++)await Promise.resolve();if(requested)render();}
 render();
 return {calls,applied,frames,document,context,render,frame,settlementPending(){Object.assign(view.value.companion.messages.at(-1),{presentation:'presented',presentationSettlementPending:true});render();},visibility(hidden){document.hidden=hidden;listeners.get('visibilitychange')?.();},switchLife(){const companion=view.value.companion;companion.characters[0].life.id='next-life';Object.assign(companion.messages.at(-1),{lifeId:'next-life',lifeToken:{lifeId:'next-life',operationId:'next-operation'},presentation:'presented'});render();},async framesFor(count){for(let i=0;i<count;i++)await frame();},close(){for(const entry of effects)entry?.cleanup?.();}};
}

test('real private presentation lifecycle does not resubmit deferred reply on its own render feedback',async()=>{
 const f=await fixture();try{await f.framesFor(8);assert.equal(f.calls.length,1);assert.equal(f.applied.length,0);assert.equal(f.frames.size,0);}finally{f.close();}
});

test('voice waiting and hidden pages do not send ordinary text presentation confirmations',async()=>{
 for(const options of [{waiting:true},{hidden:true}]){const f=await fixture(options);try{await f.framesFor(8);assert.equal(f.calls.length,0);assert.equal(f.applied.length,0);}finally{f.close();}}
});

test('a failed request can retry when visibility returns, without retrying on unrelated renders',async()=>{
 const f=await fixture({replyMode:'presented',response:(result,count)=>count===1?Promise.reject(Error('Synthetic unavailable')):Promise.resolve(result)});
 try{await f.frame();for(let i=0;i<8;i++){f.render();await f.frame();}assert.equal(f.calls.length,1);f.visibility(true);f.visibility(false);await f.framesFor(2);assert.equal(f.calls.length,2);assert.equal(f.applied.length,1);}finally{f.close();}
});

test('a failed settlement exposed by a later presented view retries on real reentry only',async()=>{
 const f=await fixture({replyMode:'presented',response:(result,count)=>{if(count===1){f.settlementPending();return Promise.reject(Error('Synthetic settlement unavailable'));}delete result.view.companion.messages.at(-1).presentationSettlementPending;return Promise.resolve(result);}});
 try{await f.frame();for(let i=0;i<8;i++){f.render();await f.frame();}assert.equal(f.calls.length,1);f.visibility(true);f.visibility(false);await f.framesFor(3);assert.equal(f.calls.length,2);assert.equal(f.applied.length,1);assert.equal(f.applied[0].companion.messages.at(-1).presentationSettlementPending,undefined);assert.equal(f.frames.size,0);}finally{f.close();}
});

test('visibility reentry while a request is in flight waits then requests fresh state once',async()=>{
 let release;const held=new Promise(resolve=>release=resolve);
 const f=await fixture({replyMode:'presented',response:(result,count)=>count===1?held.then(()=>result):Promise.resolve(result)});
 try{await f.frame();f.visibility(true);f.visibility(false);await f.frame();assert.equal(f.calls.length,1,'reentry must preserve the in-flight guard');release();await f.frame();assert.equal(f.applied.length,0,'the pre-hide response must not be applied');await f.framesFor(2);assert.equal(f.calls.length,2,'the real reentry permits one fresh attempt after the old request finishes');assert.equal(f.applied.length,1);assert.equal(f.frames.size,0);}finally{release();f.close();}
});

test('an old life response cannot replace the current view after a life switch',async()=>{
 let release;const held=new Promise(resolve=>release=resolve);const f=await fixture({replyMode:'presented',response:result=>held.then(()=>result)});
 try{await f.frame();f.switchLife();release();await f.framesFor(3);assert.equal(f.calls.length,1);assert.equal(f.applied.length,0);}finally{release();f.close();}
});
