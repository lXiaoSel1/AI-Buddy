// Actual main voice IPC/card callback + actual update reservation and voice host.
// Audio/model processes, package discovery and user dialogs are controlled boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createUpdateReservation} from '../src/update-reservation.mjs';
import {createVoiceHost,trustedVoiceSender} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';

const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const slice=(start,end)=>{
  const from=main.indexOf(start),to=main.indexOf(end,from);
  assert(from>=0&&to>from,'actual main voice boundary anchors must exist');
  return main.slice(from,to);
};

async function fixture(t){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-update-admission-'));
  const settings=createVoiceSettings();await settings.update({enabled:true});
  const selected=(await settings.get()).selectedPackageId;
  const scope={channel:'app-private',characterId:'alice',personaId:'persona',lifeId:'life',operationId:'operation',conversationId:'private'};
  const assetDialog=gate(),assetChosen=gate(),audioEnded=gate(),events=[];
  const runtime={
    async startCapture(){},async feedCapture(){return {partial:'existing'};},
    async finishCapture(){return {text:'existing capture'};},async cancelCapture(){},
    async stopEngine(){},async close(){},
    async *speak(){yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};},
  };
  const voiceHost=createVoiceHost({dataRoot,build:dataRoot,
    getGame:()=>({voiceScope:()=>scope,voiceCancel(){},async voiceReceipt(){return {accepted:true};}}),
    getPlatform:()=>({voicePackageStatus:()=>[{id:selected,engine:'breeze',installed:true,enabled:true,usable:true,trusted:true}]}),
    send:event=>{events.push(event);if(event.type==='audio'&&event.phase==='end')audioEnded.resolve(event);},
    chooseAssets:async()=>{assetDialog.resolve();return assetChosen.promise;},
    components:{settings,runtime,local:{},cloud:{},credentials:{},supervisor:{async close(){}},
      assets:{async resolve(){return {};},async status(){return {state:'ready'};}},
      profiles:{async current(){return {id:'alice-breeze',version:1,characterId:'alice',engine:'breeze'};}},
    },
  });
  t.after(async()=>{assetChosen.resolve(null);await voiceHost.close();await rm(dataRoot,{recursive:true,force:true});});
  let handler;
  const panel={isDestroyed:()=>false,webContents:{mainFrame:{}}};
  const context={createUpdateReservation,voiceHost,trustedVoiceSender,panel,
    gameRequests:0,provider:null,activityClock:{busy:new Set()},game:null,cg:null,agents:null,plugins:null,importBarrier:false,
    extensionOperationBusy:()=>false,assertImportIdle(){},
    ipcMain:{handle:(channel,callback)=>{assert.equal(channel,'voice:action');handler=callback;}},
  };
  const guard=main.split(/\r?\n/).find(line=>line.startsWith('function updateGuard('));assert(guard);
  const cardConfig=slice('voice:{quiesce:()=>voiceHost.quiesce()',',voiceTestFingerprint:');
  vm.runInNewContext(slice('const updateReservation=','const bootstrapUrl=')+'\n'+guard+'\n'+
    slice("ipcMain.handle('voice:action',","ipcMain.handle('plugins:action',")+
    '\nglobalThis.reservation=updateReservation;globalThis.cardVoice=({'+cardConfig+'}).voice;',context);
  return {host:voiceHost,reservation:context.reservation,cardVoice:context.cardVoice,assetDialog,assetChosen,audioEnded,scope,events,
    call:(op,payload={})=>handler({sender:panel.webContents,senderFrame:panel.webContents.mainFrame},op,payload),
  };
}

test('update reservation blocks new voice work, drains capture/playback, and waits for an open asset dialog',async t=>{
  const f=await fixture(t),id='update-owner';
  const capture=await f.call('capture-start',{mode:'record'});assert.ok(capture.id);
  f.reservation.reserve(id);
  assert.equal(f.reservation.status().busy,true,'an existing recording blocks update commitment');
  assert.equal((await f.call('capture-start',{mode:'record'})).code,'APP_UPDATE_RESERVED');
  assert.equal((await f.call('configure',{enabled:false})).code,'APP_UPDATE_RESERVED');
  assert.equal((await f.call('state')).capture.id,capture.id);
  assert.equal((await f.call('capture-feed',{id:capture.id,pcm:new Uint8Array([0,0])})).partial,'existing');
  assert.equal((await f.call('capture-finish',{id:capture.id})).draft,'existing capture');
  assert.equal(f.reservation.status().busy,false);
  assert.equal(f.reservation.release(id),true);

  // An already admitted reply still needs its real terminal playback receipt.
  const turnScope={...f.scope,requestId:'existing-reply'};
  const admission=await f.host.controller.admit(turnScope);assert.ok(admission);
  const envelope={...turnScope,...admission,index:0,segmentId:'existing-reply:voice:0'};
  assert.equal(await f.host.controller.segment({envelope,text:'existing reply'}),true);
  await f.host.controller.finish({requestId:turnScope.requestId});await f.audioEnded.promise;
  f.reservation.reserve(id);
  assert.equal(f.reservation.commit(id).ok,false);
  assert.equal((await f.call('receipt',{envelope,status:'audioCompleted'})).accepted,true);
  await f.call('stop');assert.equal(f.reservation.status().busy,false);
  assert.equal(f.reservation.release(id),true);

  const preparation=f.call('assets-prepare',{kind:'asr'});await f.assetDialog.promise;
  assert.equal(f.host.busy(),false,'the asset dialog itself is outside the audio host busy state');
  f.reservation.reserve(id);
  assert.equal(f.reservation.commit(id).ok,false,'a full admitted asset operation must finish before update commitment');
  assert.ok(f.reservation.status().reasons.some(row=>row.capability==='voice'));
  assert.equal((await f.call('profile-import',{text:'reference'})).code,'APP_UPDATE_RESERVED');
  assert.equal((await f.call('save-key',{key:'synthetic'})).code,'APP_UPDATE_RESERVED');
  assert.equal((await f.call('state')).settings.enabled,true);
  await assert.rejects(async()=>f.cardVoice.cardEvent({eventId:'new-card-speech'}),{code:'APP_UPDATE_RESERVED'});
  assert.equal((await f.cardVoice.cardEvent({type:'scope-update',tableId:'table',handId:'hand',status:'active'})).reason,'scope-update');
  await f.cardVoice.quiesce();
  f.assetChosen.resolve(null);assert.equal((await preparation).cancelled,true);
  assert.equal(f.reservation.commit(id).ok,true,'update can commit after admitted work and continuations settle');
});
