// Match the pinned workers' actual PCM formats. Device conversion happens on
// the continuous context output, not independently at every packet boundary.
const outputSampleRates={breeze:24000,gpt:48000,minimax:32000};

export async function prepareSpeechOutput(previous,sampleRate,create=options=>new AudioContext(options)) {
  let context=previous;
  if(!context||context.state==='closed'||context.sampleRate!==sampleRate){
    if(context&&context.state!=='closed')await context.close();
    context=create({sampleRate});
  }
  if(context.sampleRate!==sampleRate){
    await context.close();
    throw Error('浏览器未采用当前语音的采样率，请更换浏览器后重试。');
  }
  try{await context.resume();}
  catch(error){if(context!==previous&&context.state!=='closed')await context.close();throw error;}
  return context;
}

export function createSpeechOutputManager(create) {
  let current,tail=Promise.resolve(),generation=0,closed=false;
  return {
    current:()=>current,
    invalidate(){generation++;},
    prepare(sampleRate){
      if(closed)return Promise.reject(Error('配音输出已关闭。'));
      const ticket=++generation;
      const result=tail.catch(()=>{}).then(async()=>{
        if(ticket!==generation)return null;
        let candidate;
        try{candidate=await prepareSpeechOutput(current,sampleRate,create);}
        catch(error){if(ticket!==generation)return null;throw error;}
        if(ticket!==generation){if(candidate!==current&&candidate.state!=='closed')await candidate.close();return null;}
        current=candidate;return current;
      });
      tail=result;return result;
    },
    async close(){
      closed=true;generation++;const owned=current;current=undefined;
      try{if(owned&&owned.state!=='closed')await owned.close();}
      finally{await tail.catch(()=>{});}
    }
  };
}

// Playback timing and silence-aware boundary pauses follow the repaired r16 lab.
function boundaryBreath(text) {
  const end=text.trimEnd().replace(/[”’」』）》】"')\]]+$/u,'');
  if(/[？?]$/u.test(end))return .85;
  if(/[。！.!…]$/u.test(end))return .75;
  if(/[；;：:]$/u.test(end))return .45;
  if(/[，,、]$/u.test(end))return .30;
  return .08;
}

function quietEdges(samples,rate) {
  const size=Math.max(1,Math.round(rate*.01));
  const quiet=(from,to)=>{
    let energy=0;for(let i=from;i<to;i++)energy+=samples[i]*samples[i];
    return energy/(to-from)<.004*.004;
  };
  let head=0,tail=samples.length;
  while(head<samples.length&&quiet(head,Math.min(head+size,samples.length)))head=Math.min(head+size,samples.length);
  while(tail>head&&quiet(Math.max(head,tail-size),tail))tail=Math.max(head,tail-size);
  return {head:head/rate,tail:head===samples.length?samples.length/rate:(samples.length-tail)/rate,all:head===samples.length};
}

export function createChatPlayer({context,onDisplay=()=>{},onPlayed=()=>{},onDrained=()=>{},onBlocked=()=>{},onError=()=>{},onDiagnostic}) {
  const segments=new Map(),sources=new Set();
  let requestId=null,endAt=0,displayed=-1,generated=false,drained=false,timer=null;
  const observe=value=>{if(onDiagnostic)try{onDiagnostic(value);}catch{}};
  function stop() {
    if(requestId&&onDiagnostic)observe({type:'player_stop',requestId,now:context.currentTime,queuedEnd:endAt,queuedSources:sources.size});
    requestId=null;
    if(timer!==null)clearInterval(timer);timer=null;
    for(const source of sources){try{source.stop();}catch{}source.disconnect();}
    sources.clear();segments.clear();endAt=0;displayed=-1;generated=false;drained=false;
  }
  function tick() {
    if(!requestId)return;
    if(context.state!=='running'){onBlocked(true);return;}
    onBlocked(false);
    const now=context.currentTime,id=requestId;
    for(const [index,segment] of segments){
      if(segment.start!==null&&now>=segment.start&&index>displayed){displayed=index;onDisplay(segment);}
      if(segment.done&&segment.end!==null&&now>=segment.end&&!segment.ackRequested){
        segment.ackRequested=true;
        if(onDiagnostic)observe({type:'played_request',requestId:id,index,now,end:segment.end});
        Promise.resolve().then(()=>requestId===id?onPlayed({requestId:id,index}):undefined).then(()=>{
          if(requestId!==id)return;
          segment.acked=true;
          if(generated&&!drained&&[...segments.values()].every(row=>row.acked)){
            drained=true;onDrained();
          }
        }).catch(error=>{if(requestId===id){stop();onError(error);}});
      }
    }
    if(generated&&!drained&&[...segments.values()].every(row=>row.acked)){drained=true;onDrained();}
  }
  function accept(event) {
    if(event.type==='start'){
      stop();requestId=event.requestId;timer=setInterval(tick,60);return;
    }
    if(!requestId||event.requestId!==requestId)return;
    if(event.type==='generated'){generated=true;tick();return;}
    if(event.type==='segment'){
      if(!Number.isSafeInteger(event.index)||event.index!==segments.size||typeof event.text!=='string'||typeof event.speech_text!=='string')throw Error('配音语段顺序异常，请停止后重试。');
      const segment={...event,start:null,end:null,audioStart:null,tailSilence:0,done:false,ackRequested:false,acked:false,breathApplied:false};
      if(!event.speech_text.trim()){segment.start=Math.max(endAt,context.currentTime);segment.end=segment.start+.6;endAt=segment.end;}
      segments.set(event.index,segment);return;
    }
    const segment=segments.get(event.index);
    if(!segment)return;
    if(event.type==='segment_done'){
      if(segment.end===null)throw Error('配音没有返回可播放的音频，回复文字已保留。');
      segment.done=true;if(segment.start===null)segment.start=segment.audioStart;tick();return;
    }
    if(event.type!=='pcm')return;
    if(segment.done||!segment.speech_text.trim()||!Number.isInteger(event.sample_rate)||event.sample_rate<8000||event.sample_rate>192000||typeof event.pcm!=='string')throw Error('收到无效配音数据。');
    const binary=atob(event.pcm);
    if(!binary.length||binary.length%2)throw Error('收到不完整配音数据。');
    const bytes=Uint8Array.from(binary,value=>value.charCodeAt(0)),view=new DataView(bytes.buffer);
    const buffer=context.createBuffer(1,bytes.length/2,event.sample_rate),values=buffer.getChannelData(0);
    for(let i=0;i<values.length;i++)values[i]=view.getInt16(i*2,true)/32768;
    const now=context.currentTime,edges=quietEdges(values,event.sample_rate),previousEnd=endAt,continuingSegment=segment.audioStart!==null;
    // A block already queued before the previous one ends must join it
    // exactly. Only a real underrun needs a new scheduling lead-in.
    let start=endAt?(endAt>=now?endAt:now+.025):now+.3;
    const scheduledBeforeBreath=start;
    if(!segment.breathApplied&&!edges.all){
      const previous=segments.get(event.index-1);
      if(previous?.end!==null&&previous?.end!==undefined)start=Math.max(start,previous.end+boundaryBreath(previous.speech_text||previous.text)-previous.tailSilence-edges.head);
      segment.breathApplied=true;
    }
    const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);sources.add(source);
    source.onended=()=>{source.disconnect();sources.delete(source);if(onDiagnostic)observe({type:'source_ended',index:event.index,now:context.currentTime,end:start+buffer.duration});};source.start(start);
    if(onDiagnostic)observe({type:'pcm_schedule',index:event.index,now,start,end:start+buffer.duration,previousEnd,continuingSegment,
      genuineUnderrun:continuingSegment&&previousEnd>0&&previousEnd<now,underrunSeconds:continuingSegment&&previousEnd>0?Math.max(0,now-previousEnd):0,
      initialBufferingSeconds:previousEnd===0?scheduledBeforeBreath-now:0,intendedBreathAddedSeconds:start-scheduledBeforeBreath,queuedAheadSeconds:previousEnd>0?previousEnd-now:0,
      headSilenceSeconds:edges.head,allSilent:edges.all,samples:values.length,sourceRate:event.sample_rate,outputRate:context.sampleRate,state:context.state});
    if(segment.audioStart===null)segment.audioStart=start;
    if(segment.start===null&&!edges.all)segment.start=start+edges.head;
    segment.end=start+buffer.duration;endAt=segment.end;
    segment.tailSilence=edges.all?segment.tailSilence+buffer.duration:edges.tail;
  }
  return {accept,stop};
}

