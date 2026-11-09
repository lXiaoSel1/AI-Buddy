import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceCloud} from '../src/voice/cloud.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';

const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-cloud-quiesce-'));
  const reference=Buffer.alloc(64);reference.write('RIFF');reference.write('WAVE',8);
  const file=join(dataRoot,'reference.wav');await writeFile(file,reference);
  const scope={channel:'app-private',characterId:'alice',personaId:'persona',lifeId:'life',operationId:'operation',conversationId:'private'};
  const profile={id:'alice-breeze',version:1,characterId:'alice',engine:'breeze',cloudReference:{path:file,authorized:true,bytes:reference.length,sha256:createHash('sha256').update(reference).digest('hex'),durationMs:10000,text:'approved reference'}};
  const started=gate(),cancelled=gate(),exited=gate(),lateResult=gate();let requests=0;
  const cloud=createVoiceCloud({dataRoot,resolveRuntime:async()=>({}),resolveProfile:async()=>profile,
    resolveConnection:async()=>({provider:'minimax',model:'speech-2.8-turbo',keyRef:'test-ref'}),resolveSecret:async()=>'synthetic-test-key',
    transport:async(_assets,request,{signal})=>{
      requests++;started.resolve();
      return {events:(async function*(){await lateResult.promise;yield {type:'result',voice_id:request.voiceId};})(),
        closed:exited.promise,async cancel(){if(signal.aborted)cancelled.resolve();await exited.promise;}};
    },
  });
  const settings=createVoiceSettings();await settings.update({enabled:true});
  const local={async cancelCapture(){},async stopEngine(){},async close(){}};
  const host=createVoiceHost({dataRoot,build:dataRoot,getGame:()=>({voiceScope:()=>scope,voiceCancel(){}}),
    getPlatform:()=>({async resolveVoicePackage(){return {assertCurrent(){}};},voicePackageStatus:()=>[{id:'ai-buddy.voice-breeze',engine:'breeze',installed:true,enabled:true,usable:true,trusted:true}]}),
    components:{settings,cloud,local,profiles:{async current({engine}){return engine==='breeze'?profile:null;},async resolve(){return profile;},async select(){return profile;}},assets:{},credentials:{},supervisor:{async close(){}}},
  });
  t.after(async()=>{lateResult.resolve();exited.resolve();await host.close();await rm(dataRoot,{recursive:true,force:true});});
  return {host,cloud,started,cancelled,exited,lateResult,dataRoot,requests:()=>requests};
}

for(const stop of ['stop','quiesce','configure-disable','profile-select'])test(`global ${stop} cancels unowned cloud preparation and awaits exit plus failed receipt before returning`,{timeout:5000},async t=>{
  const f=await fixture(t);
  const pending=f.host.action('cloud-prepare',{consentUpload:true});
  const rejected=assert.rejects(pending,error=>error.name==='AbortError');
  await f.started.promise;
  let stopped=false;
  const stopping=(stop==='stop'?f.host.action('stop'):stop==='quiesce'?f.host.quiesce():stop==='configure-disable'?f.host.action('configure',{enabled:false}):f.host.action('profile-select',{profileId:'alice-breeze'})).then(()=>{stopped=true;});
  try{
    await Promise.race([f.cancelled.promise,stopping.then(()=>{throw Error('global stop returned without cancelling the unowned cloud worker');})]);
    assert.equal(stopped,false,'maintenance must wait for the actual exit proof');
    await assert.rejects(f.host.action('cloud-prepare',{consentUpload:true}),{code:'VOICE_STOPPING'});
    assert.equal(f.requests(),1);
    f.lateResult.resolve();f.exited.resolve();
    await stopping;await rejected;
    await assert.rejects(readFile(join(f.dataRoot,'voice','cloud','bindings.json')),{code:'ENOENT'});
    const receipt=(await f.cloud.batchStatus({profiles:[{engine:'breeze',characterId:'alice',profileId:'alice-breeze',profileVersion:1}]})).results[0];
    assert.equal(receipt.status,'unknown');assert.equal(receipt.code,'CLOUD_CANCELLED');
    assert.equal((await f.cloud.status({engine:'breeze',characterId:'alice',profileId:'alice-breeze',profileVersion:1})).state,'unknown','stop preserves the unresolved receipt without permanently closing cloud use');
  }finally{f.lateResult.resolve();f.exited.resolve();await stopping.catch(()=>{});await pending.catch(()=>{});await rejected.catch(()=>{});}
});
