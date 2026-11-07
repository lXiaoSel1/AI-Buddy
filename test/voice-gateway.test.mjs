import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceHost,trustedVoiceSender} from '../src/voice/host.mjs';

const ids=['ai-buddy.voice-breeze','ai-buddy.voice-gpt-sovits'];
function fixture(){
  let scope={characterId:'deepseek',lifeId:'life',operationId:'op',personaId:'person',conversationId:'chat',channel:'app-private'};
  const calls=[],config={selectedPackageId:ids[0],packages:Object.fromEntries(ids.map(id=>[id,{credentialRef:'voice:key'}]))};
  const controller={state:async()=>({}),invalidate:async reason=>calls.push(['invalidate',reason]),action:async(...args)=>calls.push(['controller',...args]),close:async()=>{}};
  const cloud={prepareVoice:async args=>{calls.push(['upload',args]);return {voiceId:'role-voice'};},bindVoice:async args=>{calls.push(['bind',args]);return {voiceId:args.voiceId};},close:async()=>{}};
  let accepted=false;
  const game={voiceScope:()=>scope,voiceReceipt:async()=>({accepted}),voiceSubmit:async()=>{}};
  const host=createVoiceHost({dataRoot:'unused',build:'unused',getGame:()=>game,getPlatform:()=>({resolveVoicePackage:async()=>({})}),
    components:{cards:{invalidate:async()=>{},close:async()=>{},busy:()=>false},controller,cloud,local:{},runtime:{},assets:{},supervisor:{close:async()=>{}},
      settings:{get:async()=>config,update:async value=>calls.push(['settings',value])},
      credentials:{save:async()=>({ref:'voice:new-key-ref'})},
      profiles:{current:async({engine,characterId})=>({id:'profile-'+engine,version:1,characterId}),resolve:async()=>({cloudReference:{sha256:'same-full-reference'}})}}});
  return {host,calls,accept:()=>accepted=true,move:()=>scope={...scope,lifeId:'new-life'}};
}

test('only the trusted main panel frame has access to voice IPC',()=>{
  const frame={},contents={mainFrame:frame},panel={isDestroyed:()=>false,webContents:contents};
  assert.equal(trustedVoiceSender({sender:contents,senderFrame:frame},panel),true);
  assert.equal(trustedVoiceSender({sender:contents,senderFrame:{}},panel),false);
  assert.equal(trustedVoiceSender({sender:{},senderFrame:frame},panel),false);
});

test('forged role arguments and unaccepted receipts never reach execution',async()=>{
  const f=fixture();
  await assert.rejects(f.host.action('cloud-prepare',{characterId:'claude',consentUpload:true}),{code:'VOICE_SCOPE_FORGED'});
  assert.equal((await f.host.action('receipt',{envelope:{}})).accepted,false);
  assert.equal(f.calls.length,0);
  f.accept();await f.host.action('receipt',{envelope:{}});
  assert.equal(f.calls[0][0],'controller');
});

test('one shared API key configures both plugins without exposing the secret',async()=>{
  const f=fixture(),result=await f.host.action('save-key',{key:'test-private-key'});
  assert.deepEqual(result,{configured:true});
  const patch=f.calls.find(row=>row[0]==='settings')[1];
  assert.deepEqual(Object.keys(patch.packages),ids);
  assert.equal(JSON.stringify(f.calls).includes('test-private-key'),false);
});

test('cloud preparation requires explicit upload consent and uses only the host role',async()=>{
  const f=fixture();
  await assert.rejects(f.host.action('cloud-prepare',{}),{code:'CLOUD_UPLOAD_CONSENT'});
  assert.equal(f.calls.some(row=>row[0]==='upload'),false);
  const result=await f.host.action('cloud-prepare',{consentUpload:true});
  assert.equal(result.sharedWithOtherPlugin,true);
  assert.equal(f.calls.filter(row=>row[0]==='upload').length,1);
  const uploaded=f.calls.find(row=>row[0]==='upload')[1],bound=f.calls.find(row=>row[0]==='bind')[1];
  assert.equal(uploaded.characterId,'deepseek');assert.equal(bound.characterId,'deepseek');
  assert.equal(bound.packageId,ids[1]);assert.equal(bound.voiceId,'role-voice');
});
