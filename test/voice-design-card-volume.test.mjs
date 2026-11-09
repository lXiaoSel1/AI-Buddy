import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeVoiceGamesFacade} from '../src/voice-games/native-facade.mjs';
import {CONTRACT_HASH,CONTRACT_VERSION} from '../src/voice-games/contract.mjs';
import {createVoicePlayback,ensureVoiceOutput} from '../src/voice/client.mjs';
import {createChatPlayer} from '../src/voice/browser.mjs';

async function volumeFixture(t,{allow=true}={}){
 const root=await mkdtemp(join(tmpdir(),'voice-design-volume-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const origin={runtimeId:'fixture-runtime',profileId:'fixture-profile',pid:12345},identity={pluginId:'fixture-cards',packageName:'@ai-buddy/card-games',sourceDigest:'a'.repeat(64),exactVersion:'1.1.1'},received=[];let gameCalls=0,clock=0;
 const facade=createNativeVoiceGamesFacade({dataRoot:root,now:()=>clock,resolveGrant:()=>({...identity,enabled:true,generation:1,declaredCapabilities:['games.table'],granted:allow?['games.table']:[]}),authorizeUI:async()=>true,onAudioSettings:async value=>{received.push(value);return value;},games:{describe:()=>({}),principalScope:()=>({personaId:'fixture'}),invoke:async()=>{gameCalls++;return{};},pauseAll:async()=>{},close:async()=>{}}});
 const session=await facade.open({identity,origin,contractHash:CONTRACT_HASH,contractVersion:CONTRACT_VERSION});t.after(()=>facade.close());
 const authorize=()=>facade.dispatch({sessionToken:session.sessionToken,method:'ui.authorize',payload:{request:{method:'POST'},action:'games.table.audio'}},origin);
 const send=(principal,value,from=origin)=>facade.dispatch({sessionToken:session.sessionToken,method:'games.table.audio',payload:{...value,principal}},from);
 return{facade,session,origin,received,authorize,send,gameCalls:()=>gameCalls,advance:ms=>{clock+=ms;}};
}

test('authenticated card volume updates only local playback and preserves existing table capability',async t=>{
 const f=await volumeFixture(t),principal=await f.authorize();
 assert.equal(f.session.description.cardAudioVolume,true);
 assert.deepEqual(await f.send(principal,{voice:.8,muted:false}),{voice:.8,muted:false});
 assert.deepEqual(f.received,[{voice:.8,muted:false}]);assert.equal(f.gameCalls(),0);
});

test('card volume rejects invalid ranges, forged sessions, expired principals and extra fields',async t=>{
 const f=await volumeFixture(t),principal=await f.authorize();
 for(const value of [{voice:-1,muted:false},{voice:1.1,muted:false},{voice:'1',muted:false},{voice:NaN,muted:false},{voice:.5,muted:0},{voice:.5,muted:false,command:'model'}])await assert.rejects(f.send(principal,value),{code:'VOICE_GAMES_AUDIO_INVALID'});
 await assert.rejects(f.send(principal,{voice:.5,muted:false},{...f.origin,pid:9}),{code:'VOICE_GAMES_RUNTIME_DENIED'});
 f.advance(300001);await assert.rejects(f.send(principal,{voice:.5,muted:false}),{code:'VOICE_GAMES_PRINCIPAL_REQUIRED'});assert.equal(f.received.length,0);
 const denied=await volumeFixture(t,{allow:false});await assert.rejects(denied.authorize(),{code:'VOICE_GAMES_CAPABILITY_DENIED'});
});

test('a supplied output destination changes gain routing without changing speech timing or PCM',()=>{
 const destination={id:'destination'},gain={id:'card-gain'},connections=[],values=[];let source;
 const context={currentTime:0,state:'running',destination,createBuffer:(_channels,size,rate)=>({duration:size/rate,getChannelData:()=>{const data=new Float32Array(size);values.push(data);return data;}}),createBufferSource:()=>source={connect:node=>connections.push(node),disconnect(){},start(at){this.startedAt=at;},stop(){}}};
 const player=createChatPlayer({context,destination:gain});
 try{player.accept({type:'start',requestId:'card:fixture'});player.accept({type:'segment',requestId:'card:fixture',index:0,text:'三条',speech_text:'三条'});player.accept({type:'pcm',requestId:'card:fixture',index:0,pcm:'AQACAAMA',sample_rate:24000});assert.deepEqual(connections,[gain]);assert.equal(source.startedAt,.3);assert.equal(values[0][0],1/32768);}finally{player.stop();}
});

test('the real output owner applies card gain events immediately and leaves private speech at full gain',async()=>{
 let listener;const gains=[],connections=[],calls=[];
 const context={sampleRate:24000,currentTime:0,state:'running',destination:{id:'device'},resume:async()=>{},close:async()=>{context.state='closed';},createGain:()=>{const node={gain:{value:1},connect(){},disconnect(){}};gains.push(node);return node;},createBuffer:(_c,size,rate)=>({duration:size/rate,getChannelData:()=>new Float32Array(size)}),createBufferSource:()=>({connect:node=>connections.push(node),disconnect(){},start(){},stop(){}})};
 const api={action:async(op,payload)=>{calls.push({op,payload});},onEvent:fn=>{listener=fn;return()=>{};}};
 const output=ensureVoiceOutput(api,{createContext:()=>context}),release=output.retain();
 const emit=event=>listener(event),env={requestId:'cards',segmentId:'cards:0',index:0,channel:'card-table'};
 try{output.setCardMix({voice:.8,muted:false});await emit({type:'segment',state:'queued',envelope:env,text:'三条',speech_text:'三条'});await emit({type:'audio',phase:'pcm',envelope:env,sampleRate:24000,pcm:new Uint8Array([1,0,2,0])});assert.equal(gains.length,1);assert.equal(gains[0].gain.value,.8);assert.equal(connections[0],gains[0]);
 await emit({type:'card-volume',voice:.2,muted:false});assert.equal(gains[0].gain.value,.2);await emit({type:'card-volume',voice:.2,muted:true});assert.equal(gains[0].gain.value,0);await emit({type:'invalidate',channel:'card-table'});
 const chat={...env,requestId:'chat',segmentId:'chat:0',channel:'app-private'};await emit({type:'segment',state:'queued',envelope:chat,text:'你好',speech_text:'你好'});await emit({type:'audio',phase:'pcm',envelope:chat,sampleRate:24000,pcm:new Uint8Array([1,0,2,0])});assert.equal(connections.at(-1),context.destination);assert.equal(gains.length,1);assert.equal(calls.some(row=>row.op==='configure'),false);
 }finally{await release();}
});
