import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createVoiceHost} from '../src/voice/host.mjs';
import {locale,setLocale,t as translate} from '../src/i18n.mjs';

const model='speech-2.8-turbo';
const providerId='minimax-cn';
const sampleKey='synthetic-key-only';
const voiceId='Chinese (Mandarin)_Reliable_Executive';
const scope={characterId:'deepseek',lifeId:'synthetic-life',operationId:'synthetic-operation',personaId:'synthetic-persona',conversationId:'synthetic-chat',channel:'app-private'};
const stream=()=>new Response('data: '+JSON.stringify({base_resp:{status_code:0},data:{status:1,audio:'0100'}})+'\n\ndata: '+JSON.stringify({base_resp:{status_code:0},data:{status:2}})+'\n\n',{headers:{'content-type':'text/event-stream'}});

async function fixture(t,{references}={}){
  const root=await mkdtemp(join(process.env.CLOUD_HOST_TEST_TMP??import.meta.dirname,'builtin-cloud-host-'));
  const keys=new Map(),calls=[],audio=[];
  const game={voiceScope:()=>scope,viewState:()=>({characters:[{id:scope.characterId}]}),voiceCancel(){}};
  const dataRoot=join(root,'data');
  const voice=createVoiceHost({dataRoot,build:root,getGame:()=>game,getPlatform:()=>({voicePackageStatus:()=>[]}),send:row=>audio.push(row),
    network:{fetch:async(url,{body,headers})=>{
      const path=new URL(url).pathname;
      calls.push({path,auth:new Headers(headers).get('Authorization')});
      if(path==='/v1/get_voice')return Response.json({base_resp:{status_code:0},system_voice:[{voice_id:voiceId,voice_name:'Synthetic'}]});
      if(path==='/v1/t2a_v2')return JSON.parse(body).stream===false?Response.json({base_resp:{status_code:0},data:{status:2,audio:'0100'}}):stream();
      throw Error('Unexpected external endpoint '+path);
    }},components:{
      ...(references?{builtinReferences:references}:{}),
      credentials:{async save(key){const ref='test-slot-'+keys.size;keys.set(ref,key);return {ref};},async resolve(ref){return keys.get(ref);}},
      assets:{async status(){return {state:'missing'};},async prepare(){throw Object.assign(Error('No downloadable fixture assets'),{code:'VOICE_ASSET_REQUIRED'});},async resolve(){throw Error('No local voice components');},async close(){}},
      supervisor:{async close(){}},
      local:{async cancelCapture(){},async stopEngine(){},async close(){},async ready(){return {ready:false};},speak(){throw Error('No local voice plugin');}}
    }
  });
  t.after(async()=>{await voice.close();await rm(root,{recursive:true,force:true});});
  return {voice,calls,audio};
}

async function save(voice,key=sampleKey){
  const p=await voice.action('builtin-cloud-probe',{providerId,model,key});
  assert.equal(p.ok,true);
  await voice.action('builtin-cloud-save',{providerId,model,key,proof:p.proof});
}

test('a fresh installation can select and use built-in cloud voice without voice plugins or local recognition',async t=>{
  const {voice,calls}=await fixture(t);
  await save(voice);
  await voice.action('builtin-cloud-route',{route:'cloud:'+providerId});
  const voices=await voice.action('builtin-cloud-voices',{});
  assert.ok(voices.some(row=>row.voiceId===voiceId));
  await voice.action('builtin-cloud-bind',{targetCharacterId:scope.characterId,voiceId});
  const state=await voice.action('state');
  assert.deepEqual(state.packages,[]);
  assert.equal(state.builtinCloud.status,'ready');
  assert.ok(['missing','failed'].includes(state.builtinCloud.asr.state));
  assert.equal(state.builtinCloud.characters[0].voiceId,voiceId);
  assert.ok(!JSON.stringify(state).includes(sampleKey));
  assert.ok(await voice.controller.admit({...scope,requestId:'synthetic-turn'}));
  await assert.rejects(voice.action('capture-start',{mode:'record'}),{code:'VOICE_ASR_NOT_READY'});
  await assert.rejects(voice.action('prepare',{target:'live'}),{code:'VOICE_ASR_NOT_READY'});
  assert.equal(calls.filter(row=>row.path==='/v1/t2a_v2').length,1,'only the explicitly requested Key probe has sent a synthesis');
});

test('permission to save the tested Key cannot be used after editing it or selecting a different site',async t=>{
  const {voice}=await fixture(t);
  const p=await voice.action('builtin-cloud-probe',{providerId,model,key:sampleKey});
  await assert.rejects(voice.action('builtin-cloud-save',{providerId,model,key:'different-synthetic-key',proof:p.proof}),{code:'CLOUD_PROBE_REQUIRED'});
  await assert.rejects(voice.action('builtin-cloud-save',{providerId:'minimax-global',model,key:sampleKey,proof:p.proof}),{code:'CLOUD_PROBE_REQUIRED'});
});

test('local reference preview needs a verified reference but no cloud account or worker',async t=>{
  const bytes=Buffer.from('synthetic-wav');
  const {voice,calls}=await fixture(t,{references:{
    async info(){return {durationMs:12345,version:1,source:'breeze'};},
    async read(){return {bytes,text:'synthetic reference',format:'wav',version:1};},
  }});
  const view=await voice.action('state');
  assert.equal(view.builtinCloud.characters[0].referenceSource,'breeze');
  const result=await voice.action('builtin-cloud-reference-preview',{targetCharacterId:scope.characterId});
  assert.deepEqual(result,{pcmWav:Uint8Array.from(bytes)});
  await assert.rejects(voice.action('builtin-cloud-reference-preview',{targetCharacterId:'unknown-role'}),{code:'CLOUD_SCOPE'});
  await assert.rejects(voice.action('builtin-cloud-reference-preview',{targetCharacterId:scope.characterId,path:'C:/private.wav'}),{code:'VOICE_ACTION_INVALID'});
  assert.equal(calls.length,0);
});

test('removing the reference after the consent cannot submit the upload and leaves the action retryable',async t=>{
  let removed=true;
  const {voice,calls}=await fixture(t,{references:{
    async info(){return {durationMs:12345,version:1,source:'breeze'};},
    async read(){
      const bytes=Buffer.from('synthetic-wav');
      return {bytes,text:'synthetic reference',format:'wav',version:1,language:'zh',sha256:createHash('sha256').update(bytes).digest('hex'),
      assertCurrent(){if(removed)throw Object.assign(Error('Synthetic reference removed'),{code:'CLOUD_REFERENCE'});}};},
  }});
  await save(voice);
  await voice.action('builtin-cloud-route',{route:'cloud:'+providerId});
  const request={targetCharacterId:scope.characterId,consentUpload:true,consentActivation:true};
  const before=calls.length;
  await assert.rejects(voice.action('builtin-cloud-clone',request),{code:'CLOUD_REFERENCE'});
  assert.equal(calls.length,before);
  removed=false;
  await assert.rejects(voice.action('builtin-cloud-clone',request),{code:'CLOUD_NETWORK'});
  assert.equal(calls.at(-1).path,'/v1/files/upload','after restoration the upload is attempted once, not marked previously submitted');
});

test('public cloud host and ASR errors are readable in the English interface',()=>{
  const prior=locale();
  try{
    setLocale('en');
    const messages=[
      '请先准备本机语音识别组件',
      '云配音尚未开启',
      '请先选择云端音色',
      '云配音配置已变化，请重试',
    ];
    for(const message of messages)assert.notEqual(translate(message),message);
  }finally{setLocale(prior);}
});
