import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceController} from '../src/voice/controller.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createGalgame} from '../src/galgame-host.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const calls=[],events=[],settings=createVoiceSettings();await settings.update({enabled:true});
 const rows=[{id:'ai-buddy.voice-breeze',engine:'breeze',installed:true,enabled:true,usable:true,trusted:true,archiveSha256:'package-a'}];
 let game,engineReady=false,profileVersion=1,profileMissing=false,failPreparation=false,failCancellation=false,proof='asset-a',readiness=true;
 const runtime={async prepare(){calls.push('prepare');if(failPreparation)throw Object.assign(Error('fixture preparation failed'),{code:'FIXTURE_PREPARE_FAILED'});engineReady=true;return {ready:true};},async ready(){calls.push('ready');return {ready:engineReady&&readiness};},async cancelCurrent(){calls.push('cancelCurrent');if(failCancellation)throw Error('fixture cancellation failed');},async cancelCapture(){calls.push('cancelCapture');},async stopEngine(){calls.push('stopEngine');engineReady=false;},async startCapture(){calls.push('startCapture');},async close(){}};
 const voice=createVoiceController({getScope:()=>game?.voiceScope(),settings,listPackages:()=>rows,runtime,profiles:{async current({characterId,engine}){return profileMissing?null:{id:'profile-'+characterId,version:profileVersion,characterId,engine};}},assets:{resolve:async()=>{calls.push('resolve');return {proof};},status:async()=>({state:'ready'})},submit:async()=>assert.fail('lifecycle transitions must never submit a chat turn'),send:event=>events.push(event)});
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'never-called'}),listProviders:()=>[],listModels:()=>[],runTurn:async()=>assert.fail('model calls prohibited'),async *stream(){assert.fail('model calls prohibited');}};
 game=await createGalgame({dataRoot:mkdtempSync(join(tmpdir(),'voice-page-r15-')),voice,provider,model:'never-called',automaticWorkAllowed:()=>false});
 const group=(await game.action('companion-group-save',{name:'Lifecycle fixture',memberIds:['deepseek','claude'],mode:'list'})).group;
 t.after(async()=>{await game.close();await voice.close().catch(()=>{});});
 const settled=async()=>{for(let i=0;i<80;i++){const state=await voice.state();if(!state.stopping)return state;await tick();}assert.fail('scope invalidation did not settle');};
 return {voice,game,settings,rows,events,calls,group,runtime,settled,get engineReady(){return engineReady;},setProfileVersion(value){profileVersion=value;},missProfile(){profileMissing=true;},failPreparation(){failPreparation=true;},failCancellation(){failCancellation=true;},changeAsset(){proof='asset-b';},unready(){readiness=false;}};
}
function assertReady(state,f){assert.equal(state.settings.enabled,true,'navigation must preserve the user switch');assert.equal(f.engineReady,true,'navigation must preserve a resident engine');assert.deepEqual(state.preparation,{state:'ready',target:'speech'},'resident speech must remain usable without a new start gesture');assert.equal(state.live,false);assert.equal(state.capture,null);}

for(const transition of ['private-to-group','group-to-private'])test(`${transition} preserves enabled speech through the real companion lifecycle`,async t=>{
 const f=await fixture(t);if(transition==='group-to-private'){await f.game.action('companion-group-select',{id:f.group.id});await f.settled();}
 await f.voice.action('prepare',{target:'speech'});const prepared=f.calls.filter(x=>x==='prepare').length;
 await f.game.action(transition==='private-to-group'?'companion-group-select':'companion-group-close',transition==='private-to-group'?{id:f.group.id}:{});
 const state=await f.settled(),finalState=f.events.filter(event=>event.type==='state').at(-1)?.state;assertReady(state,f);assert.deepEqual(finalState?.scope,state.scope,'real renderer must receive the new scope before enabling its recording and Live controls');assert.equal(finalState.stopping,false,'the final renderer event must publish completed cleanup');assert.equal(state.stopping,false,'the internal gate clears only when cleanup has settled');assert.equal(f.calls.filter(x=>x==='prepare').length,prepared,'navigation must not reload models');assert.equal(f.calls.includes('stopEngine'),false);assert.equal(f.calls.includes('resolve'),false,'navigation only queries marker/readiness and never re-verifies component trees');
});

test('leaving the chat view and reading it again does not change voice authority',async t=>{
 const f=await fixture(t);await f.voice.action('prepare',{target:'speech'});const before=[...f.calls];
 await f.game.action('view');await f.voice.state();await f.game.action('view');assertReady(await f.voice.state(),f);assert.deepEqual(f.calls,before);
});

test('a scope switch cancels Live capture and rejects its stale microphone frames while retaining speech',async t=>{
 const f=await fixture(t);await f.voice.action('prepare',{target:'live'});const capture=await f.voice.action('capture-start',{mode:'live'});
 await f.game.action('companion-group-select',{id:f.group.id});const state=await f.settled();assertReady(state,f);
 await assert.rejects(f.voice.action('capture-feed',{id:capture.id,pcm:new Uint8Array(32)}),{code:'VOICE_STALE_CAPTURE'});assert.equal(f.calls.filter(x=>x==='startCapture').length,1,'navigation must never reopen a microphone');
});

for(const invalidation of ['configuration-changed','profile-changed','user-stop'])test(`${invalidation} must not inherit scope-only readiness`,async t=>{
 const f=await fixture(t);await f.voice.action('prepare',{target:'speech'});await f.voice.invalidate(invalidation);assert.deepEqual((await f.voice.state()).preparation,{state:'idle',target:null});
});

for(const change of ['disabled-package','changed-package','missing-profile','unready-runtime'])test(`scope retention does not invent readiness after ${change}`,async t=>{
 const f=await fixture(t);await f.voice.action('prepare',{target:'speech'});
 if(change==='disabled-package')f.rows[0].enabled=false;if(change==='changed-package')f.rows[0].archiveSha256='package-b';if(change==='missing-profile')f.missProfile();if(change==='unready-runtime')f.unready();
 await f.game.action('companion-group-select',{id:f.group.id});assert.deepEqual((await f.settled()).preparation,{state:'idle',target:null});
});

test('a failed preparation cannot be restored as ready by navigation',async t=>{
 const f=await fixture(t);f.failPreparation();await assert.rejects(f.voice.action('prepare',{target:'speech'}),{code:'FIXTURE_PREPARE_FAILED'});await f.game.action('companion-group-select',{id:f.group.id});const state=await f.settled();assert.notEqual(state.preparation.state,'ready');assert.equal(f.engineReady,false);
});

test('failed cancellation keeps the gate sealed and never announces retained readiness',async t=>{
 const f=await fixture(t);await f.voice.action('prepare',{target:'speech'});f.failCancellation();const boundary=f.events.length;await assert.rejects(f.voice.invalidate('scope-changed'),{code:'VOICE_CLEANUP_FAILED'});assert.equal((await f.voice.state()).stopping,true);assert.equal(f.events.slice(boundary).some(x=>x.type==='preparation'&&x.preparation.state==='ready'),false);assert.equal(f.events.slice(boundary).some(x=>x.type==='state'&&x.state.stopping===false),false,'failed cleanup must never publish successful completion');
});

test('rapid private-to-group-to-private navigation rechecks the latest scope while resident readiness is pending',async t=>{
 const f=await fixture(t);await f.voice.action('prepare',{target:'speech'});const originalScope=(await f.voice.state()).scope,prepared=f.calls.filter(x=>x==='prepare').length;
 let entered,release,held=true;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),ready=f.runtime.ready;
 f.runtime.ready=async request=>{if(held){held=false;entered();await gate;}return ready(request);};
 try{
  await f.game.action('companion-group-select',{id:f.group.id});await started;
  await f.game.action('companion-group-close');release();
  const state=await f.settled(),finalState=f.events.filter(event=>event.type==='state').at(-1)?.state;
  assertReady(state,f);assert.deepEqual(state.scope,originalScope);assert.deepEqual(finalState.scope,originalScope,'a delayed group readiness result must not replace the latest private scope');assert.equal(finalState.stopping,false);
  assert.equal(f.calls.filter(x=>x==='prepare').length,prepared,'rapid navigation must not reload the engine');assert.equal(f.calls.includes('startCapture'),false,'rapid navigation must not reopen Live');assert.equal(f.calls.includes('resolve'),false,'rapid navigation must not run full component verification');
 }finally{release();}
});
