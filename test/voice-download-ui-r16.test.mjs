import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {VoiceParts,chatVoiceState,pluginVoiceState} from '../src/voice/design-ui.mjs';
import {ensureVoiceSession} from '../src/voice/client.mjs';
const id='ai-buddy.voice-breeze';
const elements=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(elements)];
const snapshot={working:false,state:{settings:{enabled:true,packages:{[id]:{ttsProvider:'local'}}},selectedPackageId:id,packages:[{id,installed:true,enabled:true,usable:true}],preparation:{state:'idle'},assets:{asr:{state:'missing',bytes:100},tts:{state:'missing',bytes:200}}}};
setLocale('en');

test('Parts offers separate Download and Import actions, with provider accurate totals',()=>{
 const calls=[],node=VoiceParts({snapshot,id,onPrepare:kind=>calls.push(['download',kind]),onImport:kind=>calls.push(['import',kind])});
 const download=elements(node).find(row=>row.props?.['data-voice-download']==='asr'),offline=elements(node).find(row=>row.props?.['data-voice-import']==='asr');
 assert.ok(download);assert.ok(offline);download.props.onClick();offline.props.onClick();
 assert.deepEqual(calls,[['download','asr'],['import','asr']]);
 const html=renderToStaticMarkup(node);assert.match(html,/Download/);assert.match(html,/Import/);assert.doesNotMatch(html,/21\.3/);
 const cloud={...snapshot,state:{...snapshot.state,settings:{...snapshot.state.settings,packages:{[id]:{ttsProvider:'minimax'}}},assets:{...snapshot.state.assets,tts:{state:'not-required'}}}};
 assert.doesNotMatch(renderToStaticMarkup(VoiceParts({snapshot:cloud,id})),/Breeze voice model/);
});

test('persisted progress renders after remount, with byte progress and enabled cancellation while working',()=>{
 const calls=[],current={...snapshot,working:true,state:{...snapshot.state,assetProgress:{state:'preparing',phase:'downloading',engineId:id,provider:'local',kind:'asr',receivedBytes:25,totalBytes:100}}};
 const node=VoiceParts({snapshot:current,id,onCancel:()=>calls.push('cancel')}),cancel=elements(node).find(row=>row.props?.['data-voice-download-cancel']);
 assert.ok(cancel);assert.equal(cancel.props.disabled,false);cancel.props.onClick();assert.deepEqual(calls,['cancel']);
 const html=renderToStaticMarkup(node);assert.match(html,/aria-valuenow="25"/);assert.match(html,/25 B/);assert.match(html,/100 B/);
 assert.equal(chatVoiceState(current),'starting');assert.equal(pluginVoiceState(current,id),'starting');
});

test('renderer configure uses the host owned preparation once and cancellation bypasses a long configure',async()=>{
 let listener,release;const held=new Promise(resolve=>{release=resolve;}),calls=[];
 const api={onEvent:fn=>{listener=fn;return()=>{};},async action(op,payload){calls.push({op,payload});if(op==='state')return snapshot.state;if(op==='configure')await held;return {accepted:true};}};
 const session=ensureVoiceSession(api,{createContext:({sampleRate})=>({sampleRate,state:'running',resume:async()=>{},close:async()=>{}}),captureOptions:{workletURL:'fixture'}}),done=session.retain();
 try{await session.refresh();const enabled=session.configure({enabled:true});await new Promise(resolve=>setImmediate(resolve));
  listener({type:'asset-progress',state:'preparing',kind:'asr',receivedBytes:4,totalBytes:10});
  assert.equal(session.snapshot().state.assetProgress.receivedBytes,4);
  await session.runAction('assets-cancel');assert.equal(calls.some(row=>row.op==='assets-cancel'),true);
  release();await enabled;assert.equal(calls.filter(row=>row.op==='prepare').length,0);
 }finally{release();await done();}
});

test('Live preparation cancellation stops before capture and clears the preparing state',async()=>{
 let resolvePrepared;const prepared=new Promise(resolve=>{resolvePrepared=resolve;}),calls=[];
 const api={onEvent:()=>()=>{},async action(op,payload){calls.push(op);if(op==='state')return snapshot.state;if(op==='prepare')return prepared;return {accepted:true};}};
 const session=ensureVoiceSession(api,{createContext:({sampleRate})=>({sampleRate,state:'running',resume:async()=>{},close:async()=>{}}),captureOptions:{workletURL:'fixture'}}),release=session.retain();
 try{await session.refresh();const starting=session.start('live');await new Promise(resolve=>setImmediate(resolve));
  resolvePrepared({cancelled:true});await starting;
  assert.equal(calls.includes('capture-start'),false);assert.equal(session.snapshot().captureState,'idle');assert.equal(session.snapshot().error,'');
 }finally{resolvePrepared({cancelled:true});await release();}
});
