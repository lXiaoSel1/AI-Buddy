import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {recordMoodRequest} from './support/mood-request.mjs';

// R13: while a voiced group line is still playing, the group stage asks companion-group-present every
// 200 ms. Each deferred answer used to rebuild the whole view (and, before r13, copy the archive 13
// times), which kept the main thread busy for the whole line. A deferred answer changes nothing, so it
// must stay as small as the private one: {ok:true,presentationDeferred:true}.
const until=async check=>{for(let n=0;n<400;n++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw Error('group voice fixture timeout');};
const isArchive=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&'cards' in value&&'conversations' in value&&'relationships' in value;

test('a group line that is still being voiced defers presentation without building a view',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-group-deferred-r13-')),segments=[],finishes=[],moodCalls=[],members=['deepseek','claude'];
 const voice={admit:()=>({epoch:4,voiceProfileVersion:9}),segment:value=>segments.push(value),finish:value=>finishes.push(value)};
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(options){
  if(recordMoodRequest(options,moodCalls,{characterIds:members})){yield {type:'text-delta',text:'{"changed":false}'};return;}
  yield {type:'text-delta',text:'{"text":"本地模拟群聊台词","emotion":"normal","affection":1}'};yield {type:'finish',reason:{kind:'stop'}};
 }};
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',voice});
 t.after(async()=>{await game.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'buddy-group-deferred-r13-'));await rm(root,{recursive:true,force:true});});
 const group=(await game.action('companion-group-save',{name:'配音呈现检查',mode:'list',memberIds:members})).group;
 await game.action('companion-group-select',{id:group.id});
 await game.action('companion-group-send',{id:group.id,text:'用本地模拟回复检查配音呈现'});
 const pending=await until(async()=>{const c=(await game.action('companion-state')).companion;return c.groupRuntime?.status==='awaiting-presentation'&&c.groupRuntime.pendingMessage;});
 const envelope=(await until(()=>segments.find(row=>row.envelope?.requestId===pending.id)))?.envelope??segments[0].envelope;

 const original=globalThis.structuredClone;let clones=0;
 globalThis.structuredClone=(value,options)=>{if(isArchive(value))clones++;return original(value,options);};
 let deferred;
 try{deferred=await game.action('companion-group-present',{id:group.id,requestId:pending.id});}finally{globalThis.structuredClone=original;}
 assert.deepEqual(deferred,{ok:true,presentationDeferred:true},'a deferred group presentation must not construct a full view');
 assert.equal(clones,0,'a deferred group presentation copied the archive '+clones+' time(s)');

 for(const status of ['textDisplayed','audioStarted'])await game.voiceReceipt({envelope,status});
 await game.voiceReceipt({envelope,status:'audioCompleted',playedMs:100});
 const presented=await until(async()=>{const value=await game.action('companion-group-present',{id:group.id,requestId:pending.id});const c=(await game.action('companion-state')).companion;return c.groupMessages?.some(m=>m.id===pending.id&&m.status==='presented')?value:null;});
 assert.equal(presented.ok,true);
});
