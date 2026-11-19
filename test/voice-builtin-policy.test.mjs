import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {join} from 'node:path';
import {createBuiltinCloudVoice} from '../src/voice/builtin-cloud.mjs';
import {defaultVoiceSettings} from '../src/voice/settings.mjs';

const key='synthetic-account-key';
const providerId='minimax-cn';
const model='speech-2.8-turbo';
const route='cloud:'+providerId;
const referenceBytes=Uint8Array.of(82,73,70,70);
const reference={version:1,format:'wav',bytes:referenceBytes,text:'Synthetic reference.',language:'zh',sha256:createHash('sha256').update(referenceBytes).digest('hex')};
const roles={deepseek:'Chinese (Mandarin)_Reliable_Executive',qwen:'Chinese (Mandarin)_News_Anchor'};
const consent={targetCharacterId:'deepseek',consentUpload:true,consentActivation:true};
const json=(data={})=>Response.json({base_resp:{status_code:0},...data});
const remoteFailure=code=>Response.json({base_resp:{status_code:code,status_msg:key}});
const completeAudio=()=>new Response('data: {"data":{"status":1,"audio":"0100"}}\n\ndata: {"data":{"status":2}}\n\n');
const action=(cloud,op,arg={})=>cloud.action('builtin-cloud-'+op,arg);
const beginSpeech=(cloud,characterId)=>Array.fromAsync(cloud.speak({characterId,text:'Synthetic alternate sentence.'}));

async function fixture(t,options={}){
  const dataRoot=await mkdtemp(join(tmpdir(),'builtin-cloud-policy-'));
  const secrets=new Map(options.keys??[]);
  const instances=new Set(),calls=[];
  let time=Date.parse('2026-01-15T00:00:00Z');
  t.after(async()=>{for(const cloud of instances)await cloud.close();await rm(dataRoot,{recursive:true,force:true});});
  const open=()=>{
    const cloud=createBuiltinCloudVoice({
      dataRoot,now:()=>time,characters:()=>Object.keys(roles),
      readReference:async()=>options.readReference?options.readReference():options.reference?options.reference():reference,
      referenceInfo:async()=>options.reference?options.reference():reference,
      settings:{get:async()=>options.config??defaultVoiceSettings()},
      getLegacySelections:options.getLegacySelections,allowBackground:options.allowBackground,audit:options.audit,
      credentials:{save:async value=>{const ref='synthetic-ref-'+secrets.size;secrets.set(ref,value);await options.afterSave?.(value);return {ref};},resolve:async ref=>{options.beforeResolve?.(ref);return secrets.get(ref);},removeIfUnused:async(ref,inUse)=>{options.beforeRemove?.(ref);if(!await inUse(ref))secrets.delete(ref);}},
      asr:{status:async()=>({state:'missing'}),auto:async()=>{},close:async()=>{}},
      fetchImpl:async(url,{body,headers})=>{
        const path=new URL(url).pathname;
        const payload=typeof body==='string'?JSON.parse(body):body;
        const auth=new Headers(headers).get('authorization');
        const call={path,payload,auth};
        calls.push(call);
        const overridden=await options.respond?.(call);
        if(overridden)return overridden;
        if(path==='/v1/files/upload')return json({file:{file_id:12345678}});
        if(path==='/v1/voice_clone')return json();
        if(path==='/v1/get_voice')return json({system_voice:Object.values(roles).map(voice_id=>({voice_id})),voice_cloning:[]});
        if(path==='/v1/t2a_v2')return payload.stream?completeAudio():json({data:{status:2,audio:'0100'}});
        throw Error('Unexpected external endpoint '+path);
      },
    });
    instances.add(cloud);
    return cloud;
  };
  return {dataRoot,open,calls,secrets,advance:ms=>{time+=ms;},close:async cloud=>{await cloud.close();instances.delete(cloud);}};
}

async function configure(cloud,apiKey=key){
  const result=await action(cloud,'probe',{providerId,model,key:apiKey});
  assert.equal(result.ok,true);
  await action(cloud,'save',{providerId,model,key:apiKey,proof:result.proof});
  await action(cloud,'route',{route});
}

test('manual retention synthesizes once when the chosen clone reaches its sixth day',async t=>{
  const f=await fixture(t);
  const cloud=f.open();
  await configure(cloud);
  const result=await action(cloud,'clone',consent);
  const retain=()=>action(cloud,'retain',{targetCharacterId:consent.targetCharacterId});
  const requests=()=>f.calls.filter(({path,payload})=>path==='/v1/t2a_v2'&&payload.stream&&payload.voice_setting.voice_id===result.voiceId).length;
  assert.equal(requests(),0,'Activation alone does not send a keepalive');
  assert.deepEqual(await retain(),{ok:true},'An explicit keepalive can run even before day six');
  assert.equal(requests(),1);
});

for(const [label,respond,expectedState,expectedCode] of [
  ['HTTP 200 with business code 2013',()=>remoteFailure(2013),'unavailable','CLOUD_MINIMAX_PARAMETERS'],
  ['HTTP 400',()=>new Response(null,{status:400}),'ready','CLOUD_MINIMAX_PARAMETERS'],
  ['HTTP 422',()=>new Response(null,{status:422}),'ready','CLOUD_MINIMAX_PARAMETERS'],
  ['HTTP 422 with business code 2013',()=>Response.json({base_resp:{status_code:2013}},{status:422}),'ready','CLOUD_MINIMAX_PARAMETERS'],
  ['HTTP 200 with moderation code 1026',()=>remoteFailure(1026),'ready','CLOUD_MINIMAX_MODERATION'],
])test('R6 keepalive voice availability after '+label,async t=>{
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&payload.text==='你好。')return respond();
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'clone',consent);
  await assert.rejects(action(cloud,'retain',{targetCharacterId:consent.targetCharacterId}),{code:expectedCode});
  const snapshot=await cloud.snapshot({characterId:consent.targetCharacterId});
  const row=snapshot.characters.find(({characterId})=>characterId===consent.targetCharacterId);
  assert.equal(row.retentionIssue?.reasonCode,'CLOUD_MINIMAX_PARAMETERS');
  assert.equal(row.state,expectedState);
});

test('an interrupted upload can be replayed after restart and activates just once',async t=>{
  let uploads=0,activations=0;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/files/upload'&&++uploads===1)throw Error('Synthetic offline upload');
    if(path==='/v1/t2a_v2'&&!payload.stream&&payload.voice_setting.voice_id.startsWith('AIBuddy-'))activations++;
  }});
  const first=f.open();
  await configure(first);
  await assert.rejects(action(first,'clone',consent),{code:'CLOUD_NETWORK'});
  await f.close(first);
  const reopened=f.open();
  assert.equal((await reopened.snapshot()).characters.find(row=>row.characterId==='deepseek').cloneRecovery,true);
  assert.equal((await action(reopened,'clone',consent)).state,'ready');
  assert.equal(uploads,2);
  assert.equal(activations,1);
});

test('an activation with unknown result checks the list and needs confirmation after restart',async t=>{
  const attempts=[];
  let completed=0;
  const f=await fixture(t,{respond({path,payload}){
    if(path!=='/v1/t2a_v2'||payload.stream||!payload.voice_setting.voice_id.startsWith('AIBuddy-'))return;
    attempts.push(payload.voice_setting.voice_id);
    if(attempts.length===1)throw Error('Synthetic activation timeout');
    completed++;
  }});
  const first=f.open();
  await configure(first);
  await assert.rejects(action(first,'clone',consent),{code:'CLOUD_NETWORK'});
  await f.close(first);
  const reopened=f.open();
  const retry=await action(reopened,'clone',consent);
  assert.deepEqual({ok:retry.ok,state:retry.state,voiceId:retry.voiceId},{ok:false,state:'activation_confirmation',voiceId:attempts[0]});
  assert.equal(attempts.length,1);
  const confirmed={...consent,confirmActivationVoiceId:retry.voiceId,accountRevision:retry.accountRevision};
  await assert.rejects(action(reopened,'clone',{...confirmed,confirmActivationVoiceId:'wrong-voice'}),{code:'CLOUD_CONFIGURATION_CHANGED'});
  assert.equal((await action(reopened,'clone',confirmed)).state,'ready');
  assert.deepEqual(attempts,[retry.voiceId,retry.voiceId]);
  assert.equal(completed,1);
  assert.equal(f.calls.filter(row=>row.path==='/v1/files/upload').length,1);
});

test('R5 abandonment requires explicit missing evidence and allows a new clone without replaying the old activation',async t=>{
  let oldVoiceId,failActivation=true;
  const events=[];
  const f=await fixture(t,{audit:event=>events.push(event),respond({path,payload}){
    if(path!=='/v1/t2a_v2'||payload.stream||!payload.voice_setting.voice_id.startsWith('AIBuddy-')||!failActivation)return;
    failActivation=false;
    oldVoiceId=payload.voice_setting.voice_id;
    throw Error('Synthetic uncertain activation');
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek});
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_NETWORK'});
  const {accountRevision}=await cloud.snapshot();
  const exact={targetCharacterId:'deepseek',accountRevision,expectedActivationVoiceId:oldVoiceId};
  assert.equal((await action(cloud,'clone',consent)).abandonActivationToken,undefined);
  const callsBefore=f.calls.length;
  const checked=await action(cloud,'clone',{...consent,...exact});
  assert.equal(typeof checked.abandonActivationToken,'string');
  const confirmed={...exact,abandonActivationToken:checked.abandonActivationToken};
  await assert.rejects(action(cloud,'abandon-activation',{...confirmed,targetCharacterId:'qwen'}),{code:'CLOUD_CONFIGURATION_CHANGED'});
  await assert.rejects(action(cloud,'abandon-activation',{...confirmed,abandonActivationToken:'unverified'}),{code:'CLOUD_CONFIGURATION_CHANGED'});
  assert.deepEqual(await action(cloud,'abandon-activation',confirmed),{ok:true,state:'abandoned'});
  assert.deepEqual(f.calls.slice(callsBefore).map(({path})=>path),['/v1/get_voice','/v1/get_voice']);
  assert.deepEqual(events.filter(row=>row.type==='cloud-voice-activation-abandoned'),[
    {type:'cloud-voice-activation-abandoned',category:'activation',code:'CLOUD_ACTIVATION_ABANDONED'},
  ]);
  await assert.rejects(action(cloud,'abandon-activation',confirmed),{code:'CLOUD_CONFIGURATION_CHANGED'});
  const role=(await cloud.snapshot()).characters.find(row=>row.characterId==='deepseek');
  assert.equal(role.activationRecovery,undefined);
  assert.equal(role.voiceId,roles.deepseek);
  const replacement=await action(cloud,'clone',consent);
  assert.equal(replacement.state,'ready');
  assert.notEqual(replacement.voiceId,oldVoiceId);
});

for(const [mode,stage] of [['omitted','check'],['malformed','check'],['omitted','confirmation'],['malformed','confirmation']])
  test('R5 ambiguous clone list evidence preserves the activation receipt on '+stage+' when '+mode,async t=>{
  let oldVoiceId,listMode='verified',failActivation=true;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/get_voice'&&listMode!=='verified')return json(listMode==='omitted'?{}:{voice_cloning:[{}]});
    if(path!=='/v1/t2a_v2'||payload.stream||!payload.voice_setting.voice_id.startsWith('AIBuddy-')||!failActivation)return;
    failActivation=false;
    oldVoiceId=payload.voice_setting.voice_id;
    throw Error('Synthetic uncertain activation');
  }});
  const cloud=f.open();
  await configure(cloud);
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_NETWORK'});
  const {accountRevision}=await cloud.snapshot();
  const exact={targetCharacterId:'deepseek',accountRevision,expectedActivationVoiceId:oldVoiceId};
  const check=()=>action(cloud,'clone',{...consent,...exact});
  if(stage==='check'){
    listMode=mode;
    const inconclusive=await check();
    assert.equal(inconclusive.state,'activation_confirmation');
    assert.equal(typeof inconclusive.abandonActivationToken,'undefined');
  }else{
    const {abandonActivationToken}=await check();
    assert.equal(typeof abandonActivationToken,'string');
    listMode=mode;
    await assert.rejects(action(cloud,'abandon-activation',{...exact,abandonActivationToken}),{code:'CLOUD_CONFIGURATION_CHANGED'});
  }
  assert.equal((await cloud.snapshot()).characters.find(row=>row.characterId==='deepseek').activationRecoveryVoiceId,oldVoiceId);
  assert.deepEqual(await action(cloud,'clone',{...consent,...exact,confirmActivationVoiceId:oldVoiceId}),
    {ok:true,state:'ready',voiceId:oldVoiceId});
});

for(const mode of ['already listed','becomes listed','list fails','check expires','check expires during list','activation races'])test('R5 abandonment preserves uncertain or active voices when '+mode,async t=>{
  let oldVoiceId,first=true,listMode='empty';
  const activating=Promise.withResolvers(),finishActivation=Promise.withResolvers();
  const f=await fixture(t,{async respond({path,payload}){
    if(path==='/v1/get_voice'&&listMode==='present')return json({voice_cloning:[{voice_id:oldVoiceId}]});
    if(path==='/v1/get_voice'&&listMode==='error')return Response.json({}, {status:503});
    if(path==='/v1/get_voice'&&listMode==='expires')f.advance(6*60*1000);
    if(path!=='/v1/t2a_v2'||payload.stream||!payload.voice_setting.voice_id.startsWith('AIBuddy-'))return;
    if(first){
      first=false;
      oldVoiceId=payload.voice_setting.voice_id;
      throw Error('Synthetic uncertain activation');
    }
    activating.resolve();
    await finishActivation.promise;
  }});
  const cloud=f.open();
  await configure(cloud);
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_NETWORK'});
  const {accountRevision}=await cloud.snapshot();
  const exact={targetCharacterId:'deepseek',accountRevision,expectedActivationVoiceId:oldVoiceId};
  const check=()=>action(cloud,'clone',{...consent,...exact});
  if(mode==='already listed'){
    listMode='present';
    assert.deepEqual(await check(),{ok:true,state:'ready',voiceId:oldVoiceId});
    return;
  }
  const {abandonActivationToken}=await check();
  assert.equal(typeof abandonActivationToken,'string');
  const confirm=()=>action(cloud,'abandon-activation',{...exact,abandonActivationToken});
  if(mode==='becomes listed'){
    listMode='present';
    assert.deepEqual(await confirm(),{ok:true,state:'ready',voiceId:oldVoiceId});
    return;
  }
  if(mode==='activation races'){
    const activation=action(cloud,'clone',{...consent,...exact,confirmActivationVoiceId:oldVoiceId});
    try{
      await Promise.race([activating.promise,activation]);
      await assert.rejects(confirm(),{code:'CLOUD_BUSY'});
    }finally{finishActivation.resolve();}
    assert.deepEqual(await activation,{ok:true,state:'ready',voiceId:oldVoiceId});
    await assert.rejects(confirm(),{code:'CLOUD_CONFIGURATION_CHANGED'});
    return;
  }
  if(mode==='list fails'){
    listMode='error';
    await assert.rejects(confirm(),{code:'CLOUD_MINIMAX_SERVICE'});
  }else if(mode==='check expires during list'){
    listMode='expires';
    await assert.rejects(confirm(),{code:'CLOUD_CONFIGURATION_CHANGED'});
  }else{
    f.advance(6*60*1000);
    const callsBefore=f.calls.length;
    await assert.rejects(confirm(),{code:'CLOUD_CONFIGURATION_CHANGED'});
    assert.equal(f.calls.length,callsBefore);
  }
  await assert.rejects(confirm(),{code:'CLOUD_CONFIGURATION_CHANGED'});
  const role=(await cloud.snapshot()).characters.find(row=>row.characterId==='deepseek');
  assert.equal(role.activationRecoveryVoiceId,oldVoiceId);
  assert.equal(f.calls.filter(({path,payload})=>path==='/v1/t2a_v2'&&payload.voice_setting.voice_id===oldVoiceId).length,1);
});

for(const mode of ['listed after uninstall','absent after uninstall','replaced WAV'])test('R4 activation recovery: '+mode,async t=>{
  let current=reference,voiceId,successfulActivations=0,referenceReads=0,activationAttempts=[];
  const alreadyActive=mode==='listed after uninstall';
  const f=await fixture(t,{
    reference:()=>current,
    readReference(){
      referenceReads++;
      if(!current)throw Object.assign(Error('Synthetic missing recording'),{code:'CLOUD_REFERENCE'});
      return current;
    },
    respond({path,payload}){
      if(path==='/v1/get_voice'&&voiceId&&alreadyActive)return json({voice_cloning:[{voice_id:voiceId}]});
      if(path!=='/v1/t2a_v2'||payload.stream||!payload.voice_setting.voice_id.startsWith('AIBuddy-'))return;
      const requested=payload.voice_setting.voice_id;
      activationAttempts.push(requested);
      if(!voiceId){
        voiceId=requested;
        if(alreadyActive)successfulActivations++;
        throw Error('Synthetic activation timeout');
      }
      successfulActivations++;
    },
  });
  const first=f.open();
  await configure(first);
  await assert.rejects(action(first,'clone',consent),{code:'CLOUD_NETWORK'});
  await f.close(first);
  if(mode==='replaced WAV'){
    const bytes=Uint8Array.of(82,73,70,70,1);
    current={...reference,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  }else current=null;
  const reopened=f.open();
  const snapshot=await reopened.snapshot({characterId:'deepseek'});
  const role=snapshot.characters.find(row=>row.characterId==='deepseek');
  const result=await action(reopened,'clone',{...consent,accountRevision:snapshot.accountRevision})
    .catch(error=>({state:error.code}));
  assert.deepEqual({
    referenceAvailable:role.referenceAvailable,activationRecovery:role.activationRecovery,
    roleState:role.state,resultState:result.state,referenceReads,
    uploads:f.calls.filter(row=>row.path==='/v1/files/upload').length,
  },{
    referenceAvailable:!!current,activationRecovery:true,
    roleState:'voice_pending',resultState:alreadyActive?'ready':'activation_confirmation',referenceReads:1,uploads:1,
  });
  if(alreadyActive){
    assert.deepEqual(result,{ok:true,state:'ready',voiceId});
  }else{
    assert.deepEqual(result,{ok:false,state:'activation_confirmation',voiceId,accountRevision:snapshot.accountRevision});
    assert.deepEqual(activationAttempts,[voiceId]);
    const confirmed={...consent,confirmActivationVoiceId:result.voiceId,accountRevision:result.accountRevision};
    await assert.rejects(action(reopened,'clone',{...confirmed,accountRevision:result.accountRevision+'-stale'}),{code:'CLOUD_CONFIGURATION_CHANGED'});
    assert.deepEqual(await action(reopened,'clone',confirmed),{ok:true,state:'ready',voiceId});
    await assert.rejects(action(reopened,'clone',confirmed),{code:'CLOUD_CONFIGURATION_CHANGED'});
  }
  assert.equal(referenceReads,1);
  assert.equal(f.calls.filter(row=>row.path==='/v1/files/upload').length,1);
  assert.equal(f.calls.filter(row=>row.path==='/v1/voice_clone').length,1);
  assert.deepEqual(activationAttempts,alreadyActive?[voiceId]:[voiceId,voiceId]);
  assert.equal(successfulActivations,1);
  assert.equal((await reopened.status({characterId:'deepseek'})).ready,true);
  const restored=(await reopened.snapshot()).characters.find(row=>row.characterId==='deepseek');
  assert.equal(restored.voiceId,voiceId);
  assert.equal(restored.activationRecovery,undefined);
});

test('R4 stale activation check cannot upload a different recording after another view recovers',async t=>{
  let current=reference,voiceId;
  const f=await fixture(t,{reference:()=>current,respond({path,payload}){
    if(path==='/v1/get_voice'&&voiceId)return json({voice_cloning:[{voice_id:voiceId}]});
    if(path==='/v1/t2a_v2'&&!payload.stream&&payload.voice_setting.voice_id.startsWith('AIBuddy-')&&!voiceId){
      voiceId=payload.voice_setting.voice_id;
      throw Error('Synthetic disconnection after activation');
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_NETWORK'});
  const captured=await cloud.snapshot({characterId:'deepseek'});
  const {activationRecoveryVoiceId}=captured.characters.find(row=>row.characterId==='deepseek');
  const check={...consent,accountRevision:captured.accountRevision,
    ...(activationRecoveryVoiceId?{expectedActivationVoiceId:activationRecoveryVoiceId}:{})};
  const bytes=Uint8Array.of(82,73,70,70,1);
  current={...reference,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  if(activationRecoveryVoiceId){
    const before=f.calls.length;
    await assert.rejects(action(cloud,'clone',{...check,expectedActivationVoiceId:'other-voice'}),{code:'CLOUD_CONFIGURATION_CHANGED'});
    await assert.rejects(action(cloud,'clone',{...check,accountRevision:undefined}),{code:'CLOUD_CONFIGURATION_CHANGED'});
    assert.equal(f.calls.length,before);
  }
  assert.deepEqual(await action(cloud,'clone',check),{ok:true,state:'ready',voiceId});
  const before=f.calls.length;
  const answer=await action(cloud,'clone',check).catch(error=>({code:error.code}));
  assert.deepEqual({code:answer.code,requests:f.calls.slice(before).map(row=>row.path)},
    {code:'CLOUD_CONFIGURATION_CHANGED',requests:[]});
  assert.equal(activationRecoveryVoiceId,voiceId);
});

test('changing the chat scope does not abort an explicit clone for its own role',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture(t,{async respond({path}){
    if(path==='/v1/voice_clone'){
      entered.resolve();
      await release.promise;
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  const result=action(cloud,'clone',consent);
  await entered.promise;
  cloud.revokeScope();
  release.resolve();
  assert.equal((await result).state,'ready');
  assert.equal((await cloud.snapshot()).characters.find(row=>row.characterId==='deepseek').kind,'clone');
});

test('a late clone activation respects a newer explicit voice selection',async t=>{
  const activated=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture(t,{async respond({path,payload}){
    if(path==='/v1/t2a_v2'&&!payload.stream&&!Object.values(roles).includes(payload.voice_setting.voice_id)){
      activated.resolve();
      await release.promise;
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  const clone=action(cloud,'clone',consent);
  await activated.promise;
  try{
    await action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek});
  }finally{release.resolve();}
  await clone;
  assert.equal((await cloud.snapshot()).characters.find(row=>row.characterId==='deepseek').voiceId,roles.deepseek);
});

test('quota holds the account for five minutes and voice errors and moderation leave other voices available',async t=>{
  let failure;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&failure){
      const code=failure;failure=null;
      return remoteFailure(code);
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  for(const [targetCharacterId,voiceId] of Object.entries(roles))await action(cloud,'bind',{targetCharacterId,voiceId});
  const calls=()=>f.calls.filter(({path,payload})=>path==='/v1/t2a_v2'&&payload.stream).length;
  failure=2056;
  await assert.rejects(beginSpeech(cloud,'deepseek'),{code:'CLOUD_MINIMAX_QUOTA'});
  f.advance(299999);
  await assert.rejects(beginSpeech(cloud,'qwen'),{code:'CLOUD_MINIMAX_QUOTA',suppressed:true});
  assert.equal(calls(),1);
  f.advance(1);
  assert.equal((await beginSpeech(cloud,'qwen')).at(-1).type,'done');
  failure=1042;
  await assert.rejects(beginSpeech(cloud,'deepseek'),{code:'CLOUD_MINIMAX_MODERATION'});
  assert.equal((await beginSpeech(cloud,'deepseek')).at(-1).type,'done');
  failure=2054;
  await assert.rejects(beginSpeech(cloud,'deepseek'),{providerCode:2054});
  assert.equal((await cloud.snapshot({characterId:'deepseek'})).characters.find(row=>row.characterId==='deepseek').state,'voice_missing');
  assert.equal((await cloud.status({characterId:'qwen'})).ready,true);
  assert.equal((await beginSpeech(cloud,'qwen')).at(-1).type,'done');
});

test('migration preserves the legacy binding and scopes the migrated clone to its original Key',async t=>{
  const oldProvider='minimax',credentialRef='legacy-synthetic-ref';
  const config=defaultVoiceSettings();
  config.enabled=true;
  config.packages[config.selectedPackageId].ttsProvider='minimax';
  config.cloudConnections={selectedId:'selected-legacy',items:[{id:'selected-legacy',model,provider:oldProvider,credentialRef}]};
  const f=await fixture(t,{keys:[[credentialRef,key]],config});
  const legacyDirectory=join(f.dataRoot,'voice','cloud');
  const legacyPath=join(legacyDirectory,'bindings.json');
  const oldKey=createHash('sha256').update(oldProvider+'\0'+key).digest('hex');
  const oldVoice='synthetic-migrated-clone';
  const legacy=JSON.stringify({schemaVersion:1,scopes:{[oldKey]:{'breeze:deepseek:legacy-profile:1':{
    voiceId:oldVoice,characterId:'deepseek',profileId:'legacy-profile',profileVersion:1,sourceSHA:reference.sha256,activatedAt:'2026-01-14T00:00:00Z',
  }}}});
  await mkdir(legacyDirectory,{recursive:true});
  await writeFile(legacyPath,legacy);
  const cloud=f.open();
  const snapshot=await cloud.snapshot();
  assert.equal(snapshot.route,route);
  assert.equal(snapshot.characters.find(row=>row.characterId==='deepseek').voiceId,oldVoice);
  assert.deepEqual(snapshot.migration,{accounts:1,characters:1,pending:true});
  const before=f.calls.length;
  assert.equal((await action(cloud,'clone',consent)).voiceId,oldVoice);
  assert.equal(f.calls.length,before,'the imported clone matches the reference digest and language');
  assert.equal((await beginSpeech(cloud,'deepseek')).at(-1).type,'done');
  await configure(cloud,'fresh-synthetic-account-key');
  await assert.rejects(beginSpeech(cloud,'deepseek'),{code:'CLOUD_VOICE_REQUIRED'});
  assert.equal(await readFile(legacyPath,'utf8'),legacy);
  assert.deepEqual(f.calls.filter(({payload})=>payload?.stream).map(({payload,auth})=>[payload.voice_setting.voice_id,auth]),[[oldVoice,'Bearer '+key]]);
});


test('a ready legacy import supersedes an unacknowledged upload for the exact recording',async t=>{
  const config=defaultVoiceSettings(),credentialRef='locked-legacy-ref';
  config.enabled=true;
  config.packages[config.selectedPackageId].ttsProvider='minimax';
  config.cloudConnections={selectedId:'legacy',items:[{id:'legacy',model,provider:'minimax',credentialRef}]};
  let locked=true,failedUpload=false;
  const f=await fixture(t,{keys:[[credentialRef,key]],config,beforeResolve(ref){
    if(locked&&ref===credentialRef)throw Object.assign(Error('Synthetic temporary vault lock'),{code:'VOICE_CREDENTIAL_ENCRYPTION'});
  },respond({path}){
    if(path==='/v1/files/upload'&&!failedUpload){failedUpload=true;throw new TypeError('Synthetic offline connection');}
  }});
  const directory=join(f.dataRoot,'voice','cloud');
  await mkdir(directory,{recursive:true});
  const fingerprint=createHash('sha256').update('minimax\0'+key).digest('hex');
  const voiceId='legacy-already-ready';
  await writeFile(join(directory,'bindings.json'),JSON.stringify({schemaVersion:1,scopes:{[fingerprint]:{'breeze:deepseek:migrated:1':{
    voiceId,characterId:'deepseek',profileId:'migrated',profileVersion:1,sourceSHA:reference.sha256,activatedAt:'2026-01-14T00:00:00Z',
  }}}}));
  const cloud=f.open();
  await configure(cloud);
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_NETWORK'});
  await f.close(cloud);
  locked=false;
  const reopened=f.open(),before=f.calls.length;
  const role=(await reopened.snapshot()).characters.find(row=>row.characterId==='deepseek');
  assert.equal((await action(reopened,'clone',consent)).voiceId,voiceId);
  assert.equal(f.calls.length,before);
  assert.equal(role.cloneRecovery,undefined);
});

test('an unknown clone for a removed recording does not appear on another reference',async t=>{
  let current=reference;
  const f=await fixture(t,{reference:()=>current,respond({path}){
    if(path==='/v1/files/upload')throw new TypeError('Synthetic offline connection');
  }});
  const cloud=f.open();
  await configure(cloud);
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_NETWORK'});
  const role=async()=> (await cloud.snapshot()).characters.find(row=>row.characterId==='deepseek');
  assert.equal((await role()).cloneRecovery,true);
  current={...reference,language:'en'};
  assert.equal((await role()).cloneRecovery,undefined);
  current=null;
  assert.equal((await role()).cloneRecovery,undefined);
});

async function saveNamed(cloud,name,apiKey=key,fields={}){
  const result=await action(cloud,'probe',{providerId,model,key:apiKey});
  assert.equal(result.ok,true);
  return action(cloud,'save',{providerId,model,key:apiKey,proof:result.proof,name,...fields});
}

test('two named accounts on one site can be edited, selected, and removed independently',async t=>{
  const f=await fixture(t);
  const cloud=f.open();
  const first=await saveNamed(cloud,'Work');
  const second=await saveNamed(cloud,'Personal','synthetic-personal-key');
  assert.ok(first.account.id && second.account.id);
  assert.notEqual(first.account.id,second.account.id);
  const local=await action(cloud,'account-select',{accountId:first.account.id});
  assert.equal(local.route,'local:breeze');
  assert.equal(local.account.name,'Work');
  assert.deepEqual(local.accounts.map(row=>[row.name,row.selected]),[['Work',true],['Personal',false]]);
  await action(cloud,'route',{route});
  await action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek});
  const renamed=await saveNamed(cloud,'Work renamed',key,{accountId:first.account.id});
  assert.equal(renamed.account.id,first.account.id);
  await action(cloud,'account-select',{accountId:second.account.id});
  await assert.rejects(beginSpeech(cloud,'deepseek'),{code:'CLOUD_VOICE_REQUIRED'});
  await f.close(cloud);
  const reopened=f.open();
  const back=await action(reopened,'account-select',{accountId:first.account.id});
  assert.equal(back.account.name,'Work renamed');
  assert.equal(back.characters.find(row=>row.characterId==='deepseek').voiceId,roles.deepseek);
  const remaining=await action(reopened,'account-remove',{accountId:second.account.id});
  assert.deepEqual(remaining.accounts.map(row=>row.id),[first.account.id]);
  assert.equal(remaining.account.id,first.account.id);
  assert.ok(!JSON.stringify(remaining).includes(key));
  assert.ok(!f.calls.some(row=>row.path==='/v1/delete_voice'));
});

test('batch prepares selected roles in order and leaves later roles unsubmitted after a quota hold',async t=>{
  let blockNext=true;
  const f=await fixture(t,{respond({path}){
    if(path==='/v1/voice_clone'&&blockNext){
      blockNext=false;
      return remoteFailure(2056);
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  const args={targetCharacterIds:['qwen','deepseek'],consentUpload:true,consentActivation:true};
  assert.deepEqual(await action(cloud,'batch',args),{results:[
    {characterId:'qwen',ok:false,code:'CLOUD_MINIMAX_QUOTA'},
    {characterId:'deepseek',ok:false,code:'CLOUD_MINIMAX_QUOTA'},
  ]});
  assert.equal(f.calls.filter(row=>row.path==='/v1/voice_clone').length,1);
  f.advance(300000);
  const success=await action(cloud,'batch',args);
  assert.deepEqual(success.results.map(({characterId,ok,state})=>[characterId,ok,state]),[
    ['qwen',true,'ready'],['deepseek',true,'ready'],
  ]);
});

test('a role scope change cancels pending cloud speech and the next role can still speak',async t=>{
  const started=Promise.withResolvers();
  let waitForRevocation=true;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&waitForRevocation){
      waitForRevocation=false;
      started.resolve();
      return new Promise(()=>{});
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek});
  await action(cloud,'bind',{targetCharacterId:'qwen',voiceId:roles.qwen});
  const pending=beginSpeech(cloud,'deepseek');
  await started.promise;
  try{
    assert.equal(typeof cloud.revokeScope,'function');
    cloud.revokeScope();
    await assert.rejects(pending,{name:'AbortError'});
  }finally{
    cloud.stopEngine();
    await pending.catch(()=>{});
  }
  assert.equal((await beginSpeech(cloud,'qwen')).at(-1).type,'done');
});

test('a clone reported missing stays missing after restart and an explicitly requested replacement gets a new ID',async t=>{
  let missing=true;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&missing){
      missing=false;
      return remoteFailure(2054);
    }
  }});
  const first=f.open();
  await configure(first);
  const original=await action(first,'clone',consent);
  await assert.rejects(beginSpeech(first,'deepseek'),{providerCode:2054});
  await f.close(first);
  const reopened=f.open();
  assert.equal((await reopened.snapshot()).characters.find(row=>row.characterId==='deepseek').state,'voice_missing');
  await assert.rejects(beginSpeech(reopened,'deepseek'),{code:'CLOUD_VOICE_MISSING'});
  const replacement=await action(reopened,'clone',consent);
  assert.notEqual(replacement.voiceId,original.voiceId);
  assert.equal(f.calls.filter(row=>row.path==='/v1/voice_clone').length,2);
});

test('a voice chooser revision cannot accept a voice after the account changes',async t=>{
  const f=await fixture(t);
  const cloud=f.open();
  await configure(cloud);
  const old=(await cloud.snapshot()).accountRevision;
  assert.ok(old);
  await saveNamed(cloud,'Another account','synthetic-replacement-key');
  assert.notEqual((await cloud.snapshot()).accountRevision,old);
  await assert.rejects(action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek,accountRevision:old}),{
    code:'CLOUD_CONFIGURATION_CHANGED',
  });
  assert.ok(!f.calls.some(row=>row.path==='/v1/get_voice'));
});

test('the exact active clone in the account voice list reconciles an uncertain activation without replay',async t=>{
  let confirmedVoice;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&!payload.stream&&!Object.values(roles).includes(payload.voice_setting.voice_id)){
      confirmedVoice=payload.voice_setting.voice_id;
      throw Error('Synthetic disconnect after activation');
    }
    if(path==='/v1/get_voice'&&confirmedVoice)return json({voice_cloning:[{voice_id:confirmedVoice}]});
  }});
  const cloud=f.open();
  await configure(cloud);
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_NETWORK'});
  await f.close(cloud);
  const reopened=f.open();
  assert.deepEqual(await action(reopened,'clone',consent),{ok:true,state:'ready',voiceId:confirmedVoice});
  assert.equal(f.calls.filter(row=>row.path==='/v1/voice_clone').length,1);
  assert.equal(f.calls.filter(({path,payload})=>path==='/v1/t2a_v2'&&payload.voice_setting.voice_id===confirmedVoice).length,1);
});

test('a saved account can explicitly verify its new balance before its hold expires',async t=>{
  let empty=false;
  const f=await fixture(t,{respond({path}){
    if(empty&&path==='/v1/t2a_v2')return remoteFailure(2067);
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek});
  empty=true;
  await assert.rejects(beginSpeech(cloud,'deepseek'),{providerCode:2067});
  const before=f.calls.length;
  assert.equal((await cloud.snapshot()).status,'balance_insufficient');
  assert.equal(f.calls.length,before,'Reading status is free');
  assert.equal((await action(cloud,'probe',{providerId})).ok,false,'The provider still reports an empty balance');
  empty=false;
  const rechecked=await action(cloud,'probe',{providerId});
  assert.deepEqual([rechecked.ok,rechecked.status],[true,'ready']);
  assert.deepEqual(f.calls.slice(before).map(row=>[row.path,row.payload.stream]),[['/v1/t2a_v2',false],['/v1/t2a_v2',false]]);
  assert.equal((await cloud.status({characterId:'deepseek'})).ready,true);
});

test('a missing role speaks no more and still has its own actionable status after restart',async t=>{
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream)return remoteFailure(2054);
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'clone',consent);
  await action(cloud,'bind',{targetCharacterId:'qwen',voiceId:roles.qwen});
  await assert.rejects(beginSpeech(cloud,'deepseek'),{providerCode:2054});
  await f.close(cloud);
  const reopened=f.open(),before=f.calls.length;
  const missing=await reopened.snapshot({characterId:'deepseek'});
  assert.deepEqual([missing.status,missing.category,missing.account.status],['unavailable','voice_missing','ready']);
  assert.equal((await reopened.status({characterId:'deepseek'})).code,'CLOUD_VOICE_MISSING');
  assert.equal((await reopened.snapshot({characterId:'qwen'})).status,'ready');
  await assert.rejects(beginSpeech(reopened,'deepseek'),{code:'CLOUD_VOICE_MISSING'});
  assert.equal(f.calls.length,before);
});

for(const keepVoice of [false,true])test('an activation rejection exposes a pending clone after restart, prior binding '+keepVoice,async t=>{
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&!payload.stream&&payload.voice_setting.voice_id.startsWith('AIBuddy-'))return remoteFailure(1008);
  }});
  const cloud=f.open();
  await configure(cloud);
  if(keepVoice)await action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek});
  await assert.rejects(action(cloud,'clone',consent),{providerCode:1008});
  await f.close(cloud);
  const reopened=f.open(),before=f.calls.length;
  const view=await reopened.snapshot({characterId:'deepseek'}),row=view.characters.find(row=>row.characterId==='deepseek');
  if(keepVoice){
    assert.deepEqual([row.state,row.voiceId,row.pendingState],['ready',roles.deepseek,'voice_pending']);
    assert.match(row.pendingVoiceId,/^AIBuddy-/);
    assert.equal((await reopened.status({characterId:'deepseek'})).ready,true);
  }else{
    assert.deepEqual([row.state,view.category],['voice_pending','voice_pending']);
    assert.equal((await reopened.status({characterId:'deepseek'})).code,'CLOUD_VOICE_PENDING');
  }
  assert.equal(f.calls.length,before);
});

test('turning off retention during a two-role pass prevents the second paid request',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  let requests=0;
  const f=await fixture(t,{async respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&payload.text==='你好。'&&++requests===1){entered.resolve();await release.promise;}
  }});
  const cloud=f.open();
  await configure(cloud);
  for(const targetCharacterId of Object.keys(roles))await action(cloud,'clone',{...consent,targetCharacterId});
  await cloud.activate();
  f.advance(6*86400000);
  t.mock.timers.tick(15*60*1000);
  await entered.promise;
  try{await action(cloud,'retention',{enabled:false});}finally{release.resolve();}
  await pause(80);
  assert.equal(requests,1);
  const unchanged=(await cloud.snapshot()).characters.find(row=>row.characterId==='qwen');
  assert.equal(unchanged.due,true);
});

test('migration keeps all configured accounts from the same site and selects the legacy choice',async t=>{
  const config=defaultVoiceSettings();
  config.enabled=true;
  config.packages[config.selectedPackageId].ttsProvider='minimax';
  config.cloudConnections={selectedId:'selected-two',items:[
    {id:'selected-two',name:'Selected account',model,provider:'minimax',credentialRef:'old-two'},
    {id:'old-one',name:'Other account',model,provider:'minimax',credentialRef:'old-one'},
  ]};
  const f=await fixture(t,{keys:[['old-one','synthetic-account-one'],['old-two','synthetic-account-two']],config});
  const cloud=f.open();
  const snapshot=await cloud.snapshot();
  assert.equal(snapshot.account.name,'Selected account');
  assert.equal(snapshot.migration.accounts,2);
  assert.deepEqual(snapshot.accounts.map(row=>[row.name,row.selected]),[['Other account',false],['Selected account',true]]);
});

test('a deleted legacy key cannot switch the user to another billable account',async t=>{
  const config=defaultVoiceSettings();
  config.enabled=true;
  config.packages[config.selectedPackageId].ttsProvider='minimax';
  config.cloudConnections={selectedId:'gone',items:['other','gone'].map(id=>({id,name:id,model,provider:'minimax',credentialRef:id}))};
  const f=await fixture(t,{config,keys:[['other','synthetic-other-account']]});
  const view=await f.open().snapshot();
  assert.equal(view.accounts.length,1);
  assert.equal(view.account.configured,false);
  assert.equal(f.calls.length,0);
});

for(const newChoice of [false,true])test('migration resumes a temporarily locked legacy account without overriding an intervening selection '+newChoice,async t=>{
  const config=defaultVoiceSettings();
  config.enabled=true;
  config.packages[config.selectedPackageId].ttsProvider='minimax';
  config.cloudConnections={selectedId:'wanted',items:['other','wanted'].map(id=>({id,name:id,model,provider:'minimax',credentialRef:id}))};
  let locked=true;
  const f=await fixture(t,{config,keys:[['other','synthetic-other-key'],['wanted','synthetic-wanted-key']],beforeResolve(ref){
    if(locked&&ref==='wanted')throw Object.assign(Error('temporary storage lock'),{code:'VOICE_CREDENTIAL_ENCRYPTION'});
  }});
  const cloud=f.open();
  const partial=await cloud.snapshot();
  assert.deepEqual(partial.accounts.map(row=>row.name),['other']);
  assert.equal(partial.account.configured,false,'A different, chargeable account cannot silently become the active one');
  assert.equal(partial.migration.pending,false,'The completion notice waits until recovery');
  if(newChoice)await action(cloud,'account-select',{accountId:partial.accounts[0].id});
  await f.close(cloud);
  locked=false;
  const complete=await f.open().snapshot();
  assert.deepEqual(complete.accounts.map(row=>row.name),['other','wanted']);
  assert.equal(complete.account.name,newChoice?'other':'wanted');
  assert.deepEqual(complete.migration,{accounts:2,characters:0,pending:true});
  assert.equal(f.calls.length,0);
});

for(const [name,selection,expected] of [
  ['exact selected version',{id:'multiple',version:1},'synthetic-picked-voice'],
  ['selected profile without a saved voice',{id:'unbound',version:1},undefined],
  ['no stored selection',null,'synthetic-later-voice'],
])test('migration keeps the legacy voice for '+name,async t=>{
  const config=defaultVoiceSettings();
  const credentialRef='legacy-voice-slot';
  config.enabled=true;
  config.packages[config.selectedPackageId].ttsProvider='minimax';
  config.cloudConnections={selectedId:'legacy-cloud-options',items:[
    {id:'legacy-cloud-options',name:'Synthetic account',model,provider:'minimax',credentialRef},
  ]};
  const f=await fixture(t,{keys:[[credentialRef,key]],config,getLegacySelections:async engine=>{
    assert.equal(engine,'breeze');
    return [{characterId:'deepseek',profile:selection}];
  }});
  const directory=join(f.dataRoot,'voice','cloud');
  await mkdir(directory,{recursive:true});
  const fingerprint=createHash('sha256').update('minimax\0'+key).digest('hex');
  const binding=(voiceId,profileVersion)=>({characterId:'deepseek',voiceId,profileId:'multiple',profileVersion,category:'system_voice'});
  const file=join(directory,'bindings.json');
  const legacy=JSON.stringify({schemaVersion:1,scopes:{[fingerprint]:{
    'breeze:deepseek:multiple:1':binding('synthetic-picked-voice',1),
    'gpt:deepseek:multiple:1':binding('synthetic-other-engine',1),
    'breeze:deepseek:multiple:2':binding('synthetic-later-voice',2),
  }}});
  await writeFile(file,legacy);
  const snapshot=await f.open().snapshot();
  assert.equal(snapshot.characters.find(row=>row.characterId==='deepseek').voiceId,expected);
  assert.equal(await readFile(file,'utf8'),legacy);
  assert.equal(f.calls.length,0,'Migration uses local records');
});

test('automatic retention recovers from an unknown request after one hour including restart',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const submitted=Promise.withResolvers(),recovered=Promise.withResolvers();
  let keepalives=0;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&payload.text==='你好。'){
      if(++keepalives===1){
        submitted.resolve();
        throw Error('Synthetic offline keepalive');
      }
      recovered.resolve();
    }
  }});
  const first=f.open();
  await configure(first);
  await action(first,'clone',consent);
  await first.activate();
  f.advance(6*86400000);
  t.mock.timers.tick(15*60*1000);
  await submitted.promise;
  await f.close(first);
  f.advance(45*60000);
  const reopened=f.open();
  await reopened.activate();
  t.mock.timers.tick(15*60*1000);
  await pause(50);
  assert.equal(keepalives,1);
  f.advance(15*60000);
  t.mock.timers.tick(15*60*1000);
  await Promise.race([recovered.promise,pause(320)]);
  assert.equal(keepalives,2);
});

test('rechecking a topped-up account allows the rejected automatic keepalive to run again',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let keepalives=0;
  const recovered=Promise.withResolvers();
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&payload.text==='你好。'){
      if(++keepalives===1)return remoteFailure(1008);
      recovered.resolve();
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'clone',consent);
  f.advance(6*86400000);
  await assert.rejects(action(cloud,'retain',{targetCharacterId:'deepseek'}),{code:'CLOUD_MINIMAX_BALANCE'});
  await cloud.activate();
  assert.equal((await action(cloud,'probe',{providerId})).ok,true);
  t.mock.timers.tick(15*60*1000);
  await Promise.race([recovered.promise,pause(320)]);
  assert.equal(keepalives,2);
});

test('manual retention can retry an unresolved attempt but deduplicates shared voice concurrency',async t=>{
  const release=Promise.withResolvers(),entered=Promise.withResolvers();
  let keepalives=0,active=0,peak=0,shared;
  const f=await fixture(t,{async respond({path,payload}){
    if(path==='/v1/get_voice'&&shared)return json({voice_cloning:[{voice_id:shared}]});
    if(path==='/v1/t2a_v2'&&payload.stream&&payload.text==='你好。'){
      keepalives++;
      if(keepalives===1)throw Error('Synthetic uncertain keepalive');
      peak=Math.max(peak,++active);
      entered.resolve();
      try{await release.promise;}finally{active--;}
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  shared=(await action(cloud,'clone',consent)).voiceId;
  await action(cloud,'bind',{targetCharacterId:'qwen',voiceId:shared});
  f.advance(6*86400000);
  await assert.rejects(action(cloud,'retain',{targetCharacterId:'deepseek'}),{code:'CLOUD_NETWORK'});
  f.advance(15000);
  const retry=action(cloud,'retain',{targetCharacterId:'deepseek'});
  await Promise.race([entered.promise,pause(320)]);
  try{
    assert.equal(keepalives,2);
    assert.deepEqual(await action(cloud,'retain',{targetCharacterId:'qwen'}),{ok:false});
  }finally{release.resolve();await retry;}
  assert.equal(peak,1);
});

test('maintenance honors the automatic-work gate and leaves manual retention available',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let keepalives=0;
  const f=await fixture(t,{allowBackground:()=>false,respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&payload.text==='你好。')keepalives++;
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'clone',consent);
  await cloud.activate();
  f.advance(6*86400000);
  t.mock.timers.tick(15*60*1000);
  await pause(150);
  assert.equal(keepalives,0);
  assert.deepEqual(await action(cloud,'retain',{targetCharacterId:'deepseek'}),{ok:true});
  assert.equal(keepalives,1);
});

test('a paid keepalive refreshes a shared clone for every role that selected it',async t=>{
  const shared='synthetic-shared-clone';
  let keepalives=0;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/get_voice')return json({voice_cloning:[{voice_id:shared}]});
    if(path==='/v1/t2a_v2'&&payload.stream&&payload.text==='你好。')keepalives++;
  }});
  const cloud=f.open();
  await configure(cloud);
  for(const targetCharacterId of Object.keys(roles)){
    await action(cloud,'bind',{targetCharacterId,voiceId:shared});
  }
  f.advance(6*86400000);
  assert.deepEqual(await action(cloud,'retain',{targetCharacterId:'deepseek'}),{ok:true});
  const snapshot=await cloud.snapshot();
  assert.equal(snapshot.characters.find(row=>row.characterId==='qwen').lastUsedAt,snapshot.characters.find(row=>row.characterId==='deepseek').lastUsedAt);
  assert.equal(snapshot.characters.some(row=>row.due),false,'The shared clone is not due for automatic retention');
  assert.equal(keepalives,1);
});

test('saving a working model clears this account’s held voice parameters',async t=>{
  let reject=true;
  const f=await fixture(t,{respond({path,payload}){
    if(path==='/v1/t2a_v2'&&payload.stream&&reject){
      reject=false;
      return remoteFailure(2061);
    }
  }});
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'bind',{targetCharacterId:'deepseek',voiceId:roles.deepseek});
  await assert.rejects(beginSpeech(cloud,'deepseek'),{code:'CLOUD_MINIMAX_PARAMETERS'});
  const model='speech-2.8-hd',probe=await action(cloud,'probe',{providerId,model,key});
  await action(cloud,'save',{providerId,model,key,proof:probe.proof});
  assert.equal((await beginSpeech(cloud,'deepseek')).at(-1).type,'done');
});

test('successful speech updates a shared voice use date once per UTC day',async t=>{
  const f=await fixture(t);
  const cloud=f.open();
  await configure(cloud);
  await action(cloud,'clone',consent);
  f.advance(10000);
  const lastUsed=async()=>(await cloud.snapshot()).characters.find(row=>row.characterId==='deepseek').lastUsedAt;
  const first=await lastUsed();
  await beginSpeech(cloud,'deepseek');
  assert.equal(await lastUsed(),first);
  f.advance(86400000);
  await beginSpeech(cloud,'deepseek');
  assert.notEqual(await lastUsed(),first);
});

test('after saving a revised Key the unreferenced encrypted slot is removed',async t=>{
  const f=await fixture(t);
  const cloud=f.open();
  await configure(cloud);
  const accountId=(await cloud.snapshot()).account.id;
  const newKey='new-synthetic-account-key';
  const probe=await action(cloud,'probe',{providerId,model,key:newKey});
  await action(cloud,'save',{providerId,model,key:newKey,proof:probe.proof,accountId});
  assert.equal((await cloud.snapshot()).account.id,accountId);
  assert.equal([...f.secrets.values()].includes(newKey),true);
  assert.equal([...f.secrets.values()].includes(key),false);
});

test('a transient cleanup failure is retried after reopening cloud voice',async t=>{
  let failOnce=true;
  const f=await fixture(t,{beforeRemove(){if(failOnce){failOnce=false;throw Error('Synthetic vault write error');}}});
  const cloud=f.open();
  await configure(cloud);
  const accountId=(await cloud.snapshot()).account.id,newKey='new-synthetic-account-key';
  const probe=await action(cloud,'probe',{providerId,model,key:newKey});
  const saved=await action(cloud,'save',{providerId,model,key:newKey,proof:probe.proof,accountId});
  assert.equal(saved.credentialCleanupPending,true);
  assert.equal([...f.secrets.values()].includes(key),true);
  await f.close(cloud);
  await f.open().activate();
  assert.equal([...f.secrets.values()].includes(key),false);
  assert.equal([...f.secrets.values()].includes(newKey),true);
});

test('a failed configuration write leaves its previously saved key and removes its abandoned new slot',async t=>{
  let original,backup;
  const newKey='new-synthetic-account-key';
  const f=await fixture(t,{async afterSave(value){
    if(value!==newKey)return;
    await rename(original,backup);
    await mkdir(original);
  }});
  const cloud=f.open();
  await configure(cloud);
  original=join(f.dataRoot,'voice','cloud','builtin-v1.json');
  backup=original+'.fixture-original';
  const accountId=(await cloud.snapshot()).account.id;
  const probe=await action(cloud,'probe',{providerId,model,key:newKey});
  try{await assert.rejects(action(cloud,'save',{providerId,model,key:newKey,proof:probe.proof,accountId}));}
  finally{await rm(original,{recursive:true});await rename(backup,original);}
  assert.equal([...f.secrets.values()].includes(key),true);
  assert.equal([...f.secrets.values()].includes(newKey),false);
  assert.equal((await action(cloud,'probe',{providerId})).ok,true);
});
