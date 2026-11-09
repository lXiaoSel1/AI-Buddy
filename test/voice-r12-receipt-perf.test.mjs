import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createGalgame} from '../src/galgame-host.mjs';
import {startDesktopSample,stopDesktopSample} from '../src/desktop-diagnostics.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(check){for(let i=0;i<100;i++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('voice receipt fixture did not settle');}

test('early valid voice receipts stay durable without cloning the archive before the reply exists',async t=>{
 const parent=resolve(process.env.R12_TEST_ROOT??tmpdir());await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(parent,'voice-r12-receipt-')),release=gate(),segments=[],finishes=[];
 const voice={admit:()=>({epoch:4,voiceProfileVersion:9}),segment:value=>segments.push(value),finish:value=>finishes.push(value)};
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'m'}),listModels:()=>[{id:'m'}],listProviders:()=>[{id:'fixture'}],runTurn:fn=>fn(),async *stream(options){
  if(options.purpose==='choices')yield {type:'text-delta',text:'{"positive":"ok","neutral":"continue","negative":"wait"}'};
  else{
   yield {type:'text-delta',text:JSON.stringify({type:'segment',text:'Synthetic spoken reply.',performance:{emotion:'happy',strength:'mild',delivery:'Calm'}})+'\n'};
   await release.promise;
   yield {type:'text-delta',text:JSON.stringify({type:'control',emotion:'cheerful',affection:1})+'\n'};
  }
  yield {type:'finish',reason:{kind:'stop'}};
 }};
 const options={dataRoot:root,provider,model:'m',voice,automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false}};
 let game=await createGalgame(options);
 t.after(async()=>{stopDesktopSample();release.resolve();await game.close();assert.equal(dirname(root),parent);await rm(root,{recursive:true,force:true});});
 const scope=game.voiceScope();await game.voiceSubmit({scope,text:'A synthetic request',submissionId:'receipt-fixture'});
 const envelope=await until(()=>segments[0]?.envelope),statuses=['textDisplayed','audioStarted','audioCompleted'];
 startDesktopSample('message');
 for(const status of statuses)assert.equal((await game.voiceReceipt({envelope,status,playedMs:100})).accepted,true);
 const sample=stopDesktopSample();t.diagnostic(JSON.stringify(sample));
 assert.equal(sample.timings['companion-clone']?.count??0,0,'a receipt with no attached reply must not clone the archive');
 assert.equal(sample.timings['companion-serialize']?.count??0,0,'a receipt with no attached reply must not serialize the archive');
 release.resolve();await until(()=>finishes.length);
 const saved=await until(async()=>{const value=await game.action('view');return value.companion.messages.find(row=>row.id===envelope.messageId);});
 assert.deepEqual(saved.voicePresentation.map(row=>row.status),statuses);
 await game.close();game=await createGalgame(options);
 const restored=(await game.action('view')).companion.messages.find(row=>row.id===envelope.messageId);
 assert.deepEqual(restored.voicePresentation.map(row=>row.status),statuses);
 assert.equal(restored.voicePresentation.at(-1).playedMs,100);
});
