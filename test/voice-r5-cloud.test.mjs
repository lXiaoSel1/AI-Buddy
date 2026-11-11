import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createVoiceCloud} from '../src/voice/cloud.mjs';
import {fixtureVoiceWav} from './support/voice-wav.mjs';
import {createServer} from 'node:http';

const scope={engine:'breeze',packageId:'ai-buddy.voice-breeze',characterId:'whale',profileId:'voice1',profileVersion:1};
async function fixture(t,options={}) {
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-r5-cloud-'));
  const audio=fixtureVoiceWav();
  const path=join(dataRoot,'reference.wav');await writeFile(path,audio);
  let key='synthetic-account-key',connection={provider:'minimax',model:'speech-2.8-turbo',keyRef:'synthetic-ref'};
  const requests=[];
  const build=()=>createVoiceCloud({dataRoot,now:options.now,
    resolveRuntime:async()=>({}),resolveConnection:async()=>connection,
    resolveSecret:async()=>key,resolveProfile:async request=>({id:request.profileId,version:request.profileVersion,characterId:request.characterId,
      cloudReference:{authorized:true,path,sha256:createHash('sha256').update(audio).digest('hex'),bytes:audio.length,durationMs:10000,text:'测试',language:'zh'}}),
    transport:async(assets,request,{signal})=>{
      requests.push(request);
      const rows=request.op==='voices'?[{type:'result',voices:[]}]:request.op==='clone'?
        [{type:'stage',stage:'uploaded',file_id:123},{type:'stage',stage:'clone-request-submitted',file_id:123},{type:'result',voice_id:request.voiceId}]:
        [{type:'pcm',sample_rate:32000,pcm:'AQACAA=='},{type:'done',metrics:{voice_id:request.voiceId}}];
      return {events:(async function*(){for(const row of rows){signal.throwIfAborted();yield row;}})(),cancel:async()=>{},closed:Promise.resolve()};
    },...options});
  let cloud=build();
  t.after(async()=>{await cloud.close();await rm(dataRoot,{recursive:true,force:true});});
  return {get cloud(){return cloud;},dataRoot,requests,setKey:value=>key=value,setConnection:value=>connection=value,
    async reopen(){await cloud.close();cloud=build();return cloud;}};
}

test('unbound cloud readiness identifies missing role voice without component failure',async t=>{
  const f=await fixture(t);
  const status=await f.cloud.status(scope);
  assert.equal(status.state,'unbound');
  assert.equal(status.code,'CLOUD_VOICE_REQUIRED');
  assert.match(status.message,/云端音色/);
  assert.equal(f.requests.length,0);
});

function providerBoundary(overrides={}){
  const counts={upload:0,clone:0,activate:0,voices:0},active=new Set();
  const provider={
    async upload(ctx,bytes,{signal}){signal.throwIfAborted();counts.upload++;return {fileId:counts.upload};},
    async clone(ctx,{voiceId},{signal}){signal.throwIfAborted();counts.clone++;return {voiceId};},
    async activate(ctx,{voiceId},{signal}){signal.throwIfAborted();counts.activate++;active.add(voiceId);return {voiceId};},
    async voices(ctx,{signal}){signal.throwIfAborted();counts.voices++;return [...active];},...overrides,
  };return {provider,counts,active};
}
const profiles=Array.from({length:11},(_,index)=>({...scope,characterId:'role'+index,profileId:'role'+index+'-breeze'}));
const mirror=rows=>rows.map(row=>({...row,engine:'gpt',packageId:'ai-buddy.voice-gpt-sovits',profileId:row.characterId+'-gpt'}));

test('11 roles prepare once, activate through formal synthesis, and reuse across engines and restart',async t=>{
  const external=providerBoundary(),f=await fixture(t,{batchProvider:external.provider});
  const rows=[...profiles,...mirror(profiles)];
  const first=f.cloud.prepareBatch({profiles:rows,consentUpload:true,consentActivation:true});
  const repeated=f.cloud.prepareBatch({profiles:rows,consentUpload:true,consentActivation:true});
  assert.equal(first,repeated,'duplicate UI clicks join the existing batch');
  const answer=await first;assert.equal(answer.total,11);assert.equal(answer.completed,11);
  assert.deepEqual(external.counts,{upload:11,clone:11,activate:11,voices:11});
  await f.reopen();
  await f.cloud.prepareBatch({profiles:rows,consentUpload:true,consentActivation:true});
  assert.deepEqual(external.counts,{upload:11,clone:11,activate:11,voices:11});
  const a=await f.cloud.status(profiles[0]),b=await f.cloud.status(mirror(profiles)[0]);
  assert.equal(a.voiceId,b.voiceId);assert.equal(a.activationState,'activated');
  const receipt=await readFile(join(f.dataRoot,'voice','cloud','preparation.json'),'utf8');
  for(const forbidden of ['synthetic-account-key','reference.wav','测试','audio'])assert.equal(receipt.includes(forbidden),false);
});

test('single-role upload reuses its stable clone and mirror binding without get_voice',async t=>{
  const f=await fixture(t);
  const first=await f.cloud.prepareVoice({...scope,consentUpload:true});
  const second=await f.cloud.prepareVoice({...scope,consentUpload:true});
  assert.equal(first.voiceId,second.voiceId);assert.equal(f.requests.filter(row=>row.op==='clone').length,1);
  await f.cloud.bindVoice({...mirror([scope])[0],voiceId:first.voiceId});
  assert.equal(f.requests.filter(row=>row.op==='voices').length,0);
  assert.equal((await f.cloud.status(mirror([scope])[0])).activationState,'pending');
});

test('cloned preview stays pending and becomes expired after seven days without silent reclone',async t=>{
  let time=Date.parse('2026-01-01T00:00:00Z');
  const f=await fixture(t,{now:()=>time});
  await f.cloud.prepareVoice({...scope,consentUpload:true});
  assert.equal((await f.cloud.status(scope)).activationState,'pending');
  time+=7*86400000;
  const expired=await f.cloud.status(scope);assert.equal(expired.state,'expired');assert.match(expired.message,/7 天/);
  await assert.rejects(f.cloud.prepareVoice({...scope,consentUpload:true}),{code:'CLOUD_PREPARE_FAILED'});
  assert.equal(f.requests.length,1);
});

test('lost clone response is durable unknown, other roles finish, and explicit reconciliation never reclones',async t=>{
  let clones=0;
  const external=providerBoundary({async clone(ctx,{voiceId}){clones++;if(ctx.request.characterId==='role1')throw Object.assign(Error('fake connection lost'),{code:'CLOUD_CONNECTION'});return {voiceId};}});
  const f=await fixture(t,{batchProvider:external.provider});
  const result=await f.cloud.prepareBatch({profiles:profiles.slice(0,3),consentUpload:true,consentActivation:true});
  assert.equal(result.completed,2);assert.equal(result.results[1].status,'unknown');
  await f.reopen();
  const pending=(await f.cloud.batchStatus({profiles:profiles.slice(0,3)})).results[1];assert.equal(pending.status,'unknown');
  const retried=await f.cloud.prepareBatch({profiles:profiles.slice(0,3),consentUpload:true,consentActivation:true});
  assert.equal(retried.results[1].status,'unknown');assert.equal(clones,3);
  const checked=await f.cloud.reconcileVoice(profiles[1]);assert.equal(checked.status,'unknown');assert.equal(clones,3);
  external.active.add(pending.voiceId);
  assert.equal((await f.cloud.reconcileVoice(profiles[1])).status,'activated');
});

test('changed key pauses preparation rather than silently cloning the same eleven roles again',async t=>{
  const external=providerBoundary(),f=await fixture(t,{batchProvider:external.provider});
  await f.cloud.prepareBatch({profiles:profiles.slice(0,1),consentUpload:true,consentActivation:true});
  f.setKey('another-account-or-key-rotation');
  const next=await f.cloud.prepareBatch({profiles:profiles.slice(0,1),consentUpload:true,consentActivation:true});
  assert.equal(next.results[0].code,'CLOUD_ACCOUNT_CONFIRMATION');assert.equal(external.counts.clone,1);
});

const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
test('global stop cancels HTTP preparation, drains its receipt, and restart never resubmits unknown upload',async t=>{
  const started=gate(),aborted=gate(),release=gate();let uploads=0;
  const external=providerBoundary({async upload(ctx,bytes,{signal}){
    uploads++;started.resolve();await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted.resolve();resolve();},{once:true}));
    await release.promise;signal.throwIfAborted();
  }}),f=await fixture(t,{batchProvider:external.provider});
  const batch=f.cloud.prepareBatch({profiles,consentUpload:true,consentActivation:true});
  const rejected=assert.rejects(batch,{name:'AbortError'});await started.promise;
  let stopped=false;const stopping=f.cloud.stopEngine().then(()=>stopped=true);await aborted.promise;
  assert.equal(stopped,false);release.resolve();await stopping;await rejected;
  await f.reopen();const status=await f.cloud.batchStatus({profiles});assert.equal(status.results[0].status,'unknown');
  assert.equal(status.results[1].status,'not-prepared');assert.equal(uploads,1);
});

test('known uploaded receipt survives configuration revocation and resumes clone without uploading again',async t=>{
  let allowed=true,uploads=0,clones=0;
  const external=providerBoundary({async upload(){uploads++;allowed=false;return {fileId:123};},async clone(ctx,{voiceId}){clones++;return {voiceId};}});
  const f=await fixture(t,{batchProvider:external.provider});
  await assert.rejects(f.cloud.prepareBatch({profiles:profiles.slice(0,1),consentUpload:true,
    checkCurrent(){if(!allowed)throw Object.assign(Error('changed'),{code:'CLOUD_CONFIGURATION_CHANGED'});}}),{code:'CLOUD_CONFIGURATION_CHANGED'});
  await f.reopen();allowed=true;
  const result=await f.cloud.prepareBatch({profiles:profiles.slice(0,1),consentUpload:true});
  assert.equal(result.results[0].status,'prepared-awaiting-activation');assert.equal(uploads,1);assert.equal(clones,1);
});

test('key changed while upload completes saves known receipt and prevents the next remote submission',async t=>{
  let f,clones=0;
  const external=providerBoundary({async upload(){f.setKey('rotated-during-upload');return {fileId:123};},async clone(){clones++;throw Error('must not submit');}});
  f=await fixture(t,{batchProvider:external.provider});
  await assert.rejects(f.cloud.prepareBatch({profiles:profiles.slice(0,1),consentUpload:true}),{code:'CLOUD_CONFIGURATION_CHANGED'});
  assert.equal(clones,0);
  const result=await f.cloud.prepareBatch({profiles:profiles.slice(0,1),consentUpload:true});assert.equal(result.results[0].code,'CLOUD_ACCOUNT_CONFIRMATION');
});

test('key unavailable and unreadable states retain stable configuration messages without remote work',async t=>{
  const missing=await fixture(t,{resolveSecret:async()=>{throw Object.assign(Error('secret echo'),{code:'VOICE_CREDENTIAL_MISSING'});}});
  const status=await missing.cloud.status(scope);assert.equal(status.state,'key-missing');assert.equal(status.code,'CLOUD_KEY_REQUIRED');assert.match(status.message,/Key 缺失/);
  const unreadable=await fixture(t,{resolveSecret:async()=>{throw Object.assign(Error('secret echo'),{code:'VOICE_CREDENTIAL_ENCRYPTION'});}});
  const encrypted=await unreadable.cloud.status(scope);assert.equal(encrypted.code,'CLOUD_KEY_UNREADABLE');assert.match(encrypted.message,/不能解密/);assert.equal(encrypted.message.includes('secret echo'),false);
});

test('official HTTP upload clone formal activation and query cross a local server without preview billing',async t=>{
  const requests=[];let voiceId;
  const server=createServer(async(req,res)=>{
    const body=Buffer.concat(await Array.fromAsync(req)).toString('utf8');requests.push({url:req.url,body,authorization:req.headers.authorization});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/files/upload')res.end('{"file":{"file_id":9223372036854775806},"base_resp":{"status_code":0}}');
    else if(req.url==='/v1/voice_clone'){assert.match(body,/"file_id":9223372036854775806/);voiceId=JSON.parse(body).voice_id;res.end('{"base_resp":{"status_code":0}}');}
    else if(req.url==='/v1/t2a_v2')res.end('{"data":{"status":2,"audio":"01000200"},"base_resp":{"status_code":0}}');
    else if(req.url==='/v1/get_voice')res.end(JSON.stringify({voice_cloning:[{voice_id:voiceId}],base_resp:{status_code:0}}));
    else{res.statusCode=404;res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const f=await fixture(t,{fetchImpl:(url,options)=>fetch('http://127.0.0.1:'+server.address().port+new URL(url).pathname,options)});
  const result=await f.cloud.prepareBatch({profiles:[scope],consentUpload:true,consentActivation:true});
  assert.equal(result.completed,1);assert.deepEqual(requests.map(row=>row.url),['/v1/files/upload','/v1/voice_clone','/v1/t2a_v2','/v1/get_voice']);
  assert.match(requests[0].body,/name="purpose"\r\n\r\nvoice_clone/);
  const clone=JSON.parse(requests[1].body);assert.equal(clone.text,undefined);assert.equal(clone.model,undefined);
  const activation=JSON.parse(requests[2].body);assert.equal(activation.voice_setting.voice_id,voiceId);assert.equal(activation.stream,false);assert.equal(activation.text,'你好。');
  assert.equal((await f.cloud.status(scope)).activationState,'activated');
});

test('unscoped pre-r5 unknown receipt blocks new submission and remains explicitly reconcilable',async t=>{
  const external=providerBoundary(),f=await fixture(t,{batchProvider:external.provider});
  const audio=fixtureVoiceWav();
  await mkdir(join(f.dataRoot,'voice','cloud','receipts'),{recursive:true});
  await writeFile(join(f.dataRoot,'voice','cloud','receipts','old-receipt.json'),JSON.stringify({schemaVersion:1,characterId:scope.characterId,
    provider:'minimax',voiceId:'buddy-old-unknown',sourceSHA:createHash('sha256').update(audio).digest('hex'),status:'failed-or-unconfirmed',stages:[{stage:'clone-request-submitted'}]}));
  assert.equal((await f.cloud.batchStatus([scope])).items[0].status,'unknown');
  const prepared=await f.cloud.prepareBatch({profiles:[scope],consentUpload:true,consentActivation:true});
  assert.equal(prepared.items[0].status,'unknown');assert.equal(external.counts.upload,0);assert.equal(external.counts.clone,0);
  external.active.add('buddy-old-unknown');assert.equal((await f.cloud.reconcileVoice(scope)).status,'activated');
});
