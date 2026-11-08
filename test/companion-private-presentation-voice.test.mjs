import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {createGalgame} from '../src/galgame-host.mjs';

async function until(check){for(let attempt=0;attempt<100;attempt++){const result=await check();if(result)return result;await pause(5);}throw Error('Synthetic voice presentation timed out');}

test('private presentation stays deferred until audio completes and host completion settles it once',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-private-presentation-')),segments=[],finishes=[];
 const voice={admit:()=>({epoch:4,voiceProfileVersion:9}),segment:value=>segments.push(value),finish:value=>finishes.push(value)};
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'m'}),listModels:()=>[{id:'m'}],listProviders:()=>[{id:'fixture'}],runTurn:fn=>fn(),async *stream(options){
  if(options.purpose==='choices')yield {type:'text-delta',text:'{"positive":"好","neutral":"继续","negative":"等等"}'};
  else yield {type:'text-delta',text:JSON.stringify({type:'segment',text:'Synthetic spoken reply.',performance:{emotion:'happy',strength:'mild',delivery:'Calm'}})+'\n'+JSON.stringify({type:'control',emotion:'cheerful',affection:1})+'\n'};
  yield {type:'finish',reason:{kind:'stop'}};
 }};
 const game=await createGalgame({dataRoot:root,provider,model:'m',voice});
 t.after(async()=>{await game.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'buddy-private-presentation-'));await rm(root,{recursive:true,force:true});});
 const scope=game.voiceScope(),before=(await game.action('view')).companion.relationship.affection;
 await game.voiceSubmit({scope,text:'喜欢你',submissionId:'presentation-capture'});await until(()=>finishes.length);
 const envelope=segments[0].envelope,args={conversationId:scope.conversationId,id:envelope.messageId};
 assert.deepEqual(await game.action('companion-private-present',args),{ok:true,presentationDeferred:true},'deferred confirmation must not construct a full view');
 await game.voiceReceipt({envelope,status:'textDisplayed'});await game.voiceReceipt({envelope,status:'audioStarted'});
 const waiting=await game.action('view');assert.equal(waiting.companion.messages.at(-1).presentation,'pending');assert.equal(waiting.companion.relationship.affection,before);
 assert.equal((await game.voiceReceipt({envelope,status:'audioCompleted',playedMs:100})).ready,true);
 const completed=await until(async()=>{const value=await game.action('view');return value.companion.messages.at(-1).presentation==='presented'&&value.companion.relationship.affection===before+1?value:null;});
 assert.equal(completed.companion.messages.at(-1).voicePresentation.at(-1).status,'audioCompleted');
 await Promise.all(Array.from({length:4},()=>game.action('companion-private-present',args)));
 assert.equal((await game.action('view')).companion.relationship.affection,before+1);
});
