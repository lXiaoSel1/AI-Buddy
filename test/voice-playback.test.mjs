import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoicePlayback,ensureVoiceOutput} from '../src/voice/client.mjs';

function audioFactory(){
  const contexts=[];
  const create=({sampleRate})=>{const context={sampleRate,state:'running',currentTime:0,destination:{},resume:async()=>{},close:async()=>{context.state='closed';},
    createGain:()=>({gain:{value:1},connect(){},disconnect(){}}),
    createBuffer:(_channels,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),
    createBufferSource:()=>({connect(){},disconnect(){},start(){},stop(){}})};contexts.push(context);return context;};
  return {create,contexts};
}
const envelope=index=>({requestId:'request',segmentId:'request:voice:'+index,index});
const segment=index=>({type:'segment',state:'queued',envelope:envelope(index),text:'第'+index+'段',speech_text:'第'+index+'段'});
const pcm=index=>({type:'audio',phase:'pcm',envelope:envelope(index),sampleRate:24000,pcm:new Uint8Array([1,0,2,0])});

test('formal playback uses actual PCM rate and keeps future queued segments behind the audio clock',async()=>{
  const audio=audioFactory(),receipts=[],subtitles=[];
  const playback=createVoicePlayback({createContext:audio.create,action:async(op,value)=>receipts.push({op,...value}),onSubtitle:value=>subtitles.push(value),onError:error=>{throw error;}});
  try{
    await playback.handle(segment(0));await playback.handle(segment(1));
    await playback.handle({type:'audio',phase:'start',envelope:envelope(0),sampleRate:32000});
    await playback.handle(pcm(0));
    assert.equal(audio.contexts[0].sampleRate,24000);
    await playback.handle({type:'audio',phase:'end',envelope:envelope(0)});
    await playback.handle({type:'turn',state:'generated',requestId:'request'});
    audio.contexts[0].currentTime=10;await delay(80);
    assert.equal(receipts.filter(row=>row.status==='audioCompleted').length,1);
    assert.equal(subtitles.at(-1).envelope.index,0);
    await playback.handle(pcm(1));await playback.handle({type:'audio',phase:'end',envelope:envelope(1)});
    audio.contexts[0].currentTime=20;await delay(80);
    assert.equal(receipts.filter(row=>row.status==='audioCompleted').length,2);
    assert.equal(subtitles.at(-1),null);
  }finally{await playback.close();}
});

test('failed synthesis is saved as failed, never reported as played',async()=>{
  const calls=[],audio=audioFactory(),errors=[];
  const playback=createVoicePlayback({createContext:audio.create,action:async(...args)=>calls.push(args),onError:error=>errors.push(error.message)});
  await playback.handle(segment(0));await playback.handle({type:'segment',state:'failed',envelope:envelope(0),message:'provider failed'});
  assert.equal(calls[0][1].status,'failed');assert.equal(calls[1][0],'stop');
  assert.equal(calls.some(row=>row[1]?.status==='audioCompleted'),false);assert.equal(errors.length,1);
  await playback.close();
});

test('an emoji-only first segment preserves the local engine rate for the next spoken segment',async()=>{
  const audio=audioFactory(),errors=[];
  const playback=createVoicePlayback({createContext:audio.create,action:async()=>{},onError:error=>errors.push(error.message)});
  try{
    await playback.handle({...segment(0),text:'😊',speech_text:''});await playback.handle(segment(1));
    await playback.handle({type:'audio',phase:'start',envelope:envelope(0),sampleRate:24000,text:'😊',speech_text:''});
    await playback.handle({type:'audio',phase:'end',envelope:envelope(0),skipped:true});await playback.handle(pcm(1));
    assert.equal(audio.contexts[0].sampleRate,24000);assert.deepEqual(errors,[]);
  }finally{await playback.close();}
});

test('ordinary chat cancellation discards buffered audio as soon as the failed turn arrives',async()=>{
  let stopped=0;const audio=audioFactory(),base=audio.create;
  audio.create=options=>{const context=base(options),make=context.createBufferSource;context.createBufferSource=()=>({...make(),stop(){stopped++;}});return context;};
  const playback=createVoicePlayback({createContext:audio.create,action:async()=>{}});
  await playback.handle(segment(0));await playback.handle(pcm(0));
  await playback.handle({type:'turn',state:'generated',requestId:'request',failed:true});
  assert.equal(stopped,1);await playback.close();
});

test('the renderer keeps one voice output and acknowledges card audio after chat leaves',async()=>{
  const audio=audioFactory(),receipts=[],listeners=new Set();let subscriptions=0;
  const api={action:async(op,value)=>{receipts.push({op,...value});},onEvent:listener=>{subscriptions++;listeners.add(listener);return()=>listeners.delete(listener);}};
  const output=ensureVoiceOutput(api,{createContext:audio.create}),release=output.retain();
  try{
    const chatOutput=ensureVoiceOutput(api,{createContext:audio.create});
    assert.equal(chatOutput,output);assert.equal(subscriptions,1);
    const chatStates=[],off=chatOutput.subscribe({channel:'app-private',characterId:'pet',personaId:'persona',conversationId:'chat'},state=>chatStates.push(state));
    off();await chatOutput.stopChat();
    const card={...envelope(0),requestId:'card:one',segmentId:'card:one:voice:0',channel:'card-table'};
    for(const event of [{...segment(0),envelope:card},{...pcm(0),envelope:card},{type:'audio',phase:'end',envelope:card},{type:'turn',state:'generated',requestId:card.requestId}])for(const listener of listeners)listener(event);
    await delay(10);assert.equal(audio.contexts.length,1);
    audio.contexts[0].currentTime=10;await delay(80);
    assert.equal(receipts.filter(row=>row.status==='audioCompleted'&&row.envelope.requestId===card.requestId).length,1);
    assert.equal(receipts.filter(row=>row.status==='audioStarted').length,1);
    assert.equal(chatStates.some(state=>state.subtitle?.envelope.channel==='card-table'),false);
  }finally{await release();}
  assert.equal(listeners.size,0);assert.equal(audio.contexts[0].state,'closed');
});

test('stop reading keeps a failed IPC request tracked and ignores old PCM after confirmation',async()=>{
  const audio=audioFactory(),states=[],actions=[];
  let emit,failStop=true,started=0,stopped=0;
  const create=options=>{const context=audio.create(options),source=context.createBufferSource;context.createBufferSource=()=>({...source(),start(){started++;},stop(){stopped++;}});return context;};
  const api={
    async action(op,payload){
      actions.push({op,payload});
      if(op!=='stop-reading')return;
      if(failStop)throw Error('transport failed');
      await emit({type:'turn',state:'skipped',requestId:payload.requestId});
      return {stopped:true};
    },
    onEvent(listener){emit=listener;return()=>{};},
  };
  const output=ensureVoiceOutput(api,{createContext:create}),release=output.retain();
  const scope={channel:'app-private',characterId:'pet',personaId:'persona',conversationId:'chat'};
  const old={...scope,...envelope(0)},next={...old,requestId:'next',segmentId:'next:voice:0'};
  const off=output.subscribe(scope,state=>states.push(state));
  try{
    await emit({...segment(0),envelope:old});
    await emit({...pcm(0),envelope:old});
    await emit({...segment(0),envelope:next});
    await emit({...pcm(0),envelope:next});
    assert.equal(started,1);
    await output.stopReading(old.requestId);
    assert.equal(stopped,0);
    assert.equal(states.at(-1).error,'transport failed');
    assert.equal(states.at(-1).activeRequestId,old.requestId);
    failStop=false;
    await output.stopReading(old.requestId);
    await emit({...pcm(0),envelope:old});
    await output.stopReading(old.requestId);
    await emit({type:'audio',phase:'end',envelope:next});
    assert.equal(stopped,1);
    assert.equal(started,2);
    assert.equal(states.at(-1).activeRequestId,next.requestId);
    assert.deepEqual(actions.filter(row=>row.op==='stop-reading').map(row=>row.payload.requestId),[old.requestId,old.requestId]);
  }finally{off();await release();}
});

test('card and chat requests play in FIFO order and scoped cancellation preserves the other channel',async()=>{
  const audio=audioFactory(),calls=[],listeners=new Set(),states=[];let stopped=0,started=0;
  const create=options=>{const context=audio.create(options),source=context.createBufferSource;context.createBufferSource=()=>({...source(),start(){started++;},stop(){stopped++;}});return context;};
  const api={action:async(op,value)=>{calls.push({op,...value});},onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const output=ensureVoiceOutput(api,{createContext:create}),release=output.retain();
  const emit=async event=>{await Promise.all([...listeners].map(listener=>listener(event)));await delay(1);};
  const chat={...envelope(0),channel:'app-private',characterId:'pet',personaId:'persona',conversationId:'chat'},card={...envelope(0),requestId:'card:one',segmentId:'card:one:voice:0',channel:'card-table'};
  const queue=async env=>{await emit({...segment(0),envelope:env});await emit({...pcm(0),envelope:env});await emit({type:'audio',phase:'end',envelope:env});await emit({type:'turn',state:'generated',requestId:env.requestId});};
  const off=output.subscribe(chat,state=>states.push(state));
  try{
    await queue(chat);await queue(card);
    assert.equal(started,1);assert.equal(stopped,0);
    await emit({type:'invalidate',channel:'card-table'});
    assert.equal(stopped,0);
    assert.equal(calls.filter(row=>row.status==='interrupted'&&row.envelope.requestId===card.requestId).length,1);
    audio.contexts[0].currentTime=10;await delay(80);
    assert.equal(calls.filter(row=>row.status==='audioCompleted'&&row.envelope.requestId===chat.requestId).length,1);
    const next={...card,requestId:'card:two',segmentId:'card:two:voice:0'};await queue(next);
    await emit({type:'invalidate'});
    assert.equal(stopped,1);
    audio.contexts[0].currentTime=20;await delay(80);
    assert.equal(calls.filter(row=>row.status==='audioCompleted'&&row.envelope.requestId===next.requestId).length,1);
    assert.equal(states.some(state=>state.subtitle?.envelope.channel==='card-table'),false);
  }finally{off();await release();}
});

test('FIFO waits for the terminal acknowledgement and ordinary stop releases the active card output',async()=>{
  const audio=audioFactory(),calls=[],listeners=new Set(),privateStates=[],groupStates=[];let started=0,stopped=0,acknowledge;
  const acknowledgement=new Promise(resolve=>{acknowledge=resolve;});
  const create=options=>{const context=audio.create(options),source=context.createBufferSource;context.createBufferSource=()=>({...source(),start(){started++;},stop(){stopped++;}});return context;};
  const api={action:async(op,value)=>{calls.push({op,...value});if(value?.envelope?.requestId==='chat:first'&&value.status==='audioCompleted')await acknowledgement;},onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const output=ensureVoiceOutput(api,{createContext:create}),release=output.retain();
  const privateScope={channel:'app-private',characterId:'pet',personaId:'persona',conversationId:'chat'};
  const offPrivate=output.subscribe(privateScope,state=>privateStates.push(state)),offGroup=output.subscribe({...privateScope,channel:'app-group'},state=>groupStates.push(state));
  const emit=event=>Promise.all([...listeners].map(listener=>listener(event)));
  const queue=async env=>{await emit({...segment(0),envelope:env});await emit({...pcm(0),envelope:env});await emit({type:'audio',phase:'end',envelope:env});await emit({type:'turn',state:'generated',requestId:env.requestId});};
  try{
    await queue({...privateScope,requestId:'chat:first',segmentId:'chat:first:voice:0',index:0});
    await queue({channel:'card-table',requestId:'card:first',segmentId:'card:first:voice:0',index:0});
    audio.contexts[0].currentTime=10;await delay(80);
    assert.equal(started,1);assert.equal(stopped,0);
    acknowledge();await delay(10);
    assert.equal(started,2);assert.equal(audio.contexts.length,1);
    assert.equal(privateStates.some(state=>state.subtitle?.envelope.channel==='app-private'),true);
    assert.equal(privateStates.some(state=>state.subtitle?.envelope.channel==='card-table'),false);
    assert.equal(groupStates.some(state=>state.subtitle),false);
    const before=stopped;await output.stopChat();assert.equal(stopped,before);
    await output.stop();assert.equal(stopped,before+1);
    assert.equal(calls.filter(row=>row.status==='interrupted'&&row.envelope.requestId==='card:first').length,1);
    assert.equal(calls.filter(row=>row.status==='audioCompleted'&&row.envelope.requestId==='card:first').length,0);
  }finally{acknowledge();offPrivate();offGroup();await release();}
  assert.equal(audio.contexts[0].state,'closed');
});
