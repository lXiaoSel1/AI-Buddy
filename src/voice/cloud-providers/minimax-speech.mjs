import {createHash} from 'node:crypto';
import {readSseEvents} from '../../api-sse.mjs';
import {createDownloadDeadline,waitForNetwork} from '../../network-download.mjs';
import {MiniMaxSpeechError,minimaxBusinessError,minimaxHttpError} from '../minimax-speech-errors.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const aborted=()=>new DOMException('云配音已停止','AbortError');

const maxSpeechResponseBytes=32*1024*1024;

async function* readMiniMaxSpeech(response,deadline) {
  if(!response.body) throw response.ok?new MiniMaxSpeechError('response'):minimaxHttpError(response.status);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  const abort=()=>{void reader.cancel().catch(()=>{});};
  deadline.signal.addEventListener('abort',abort,{once:true});
  if(deadline.signal.aborted)abort();
  let bytes=0;
  const businessError=row=>{
    const error=minimaxBusinessError(row);
    if(error&&!response.ok)error.httpStatus=response.status;
    return error;
  };
  const read=async()=>{
    deadline.signal.throwIfAborted();
    const chunk=await reader.read();
    deadline.signal.throwIfAborted();
    if(chunk.value?.byteLength){
      deadline.touch();bytes+=chunk.value.byteLength;
      if(bytes>maxSpeechResponseBytes)throw new MiniMaxSpeechError('protocol');
    }
    return chunk;
  };
  try{
    const contentType=response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase();
    const jsonType=contentType==='application/json'||contentType?.endsWith('+json');
    const sseFields=['data:','event:','id:','retry:',':'];
    const prefix=[];
    let lead='',sse=false;
    // MiniMax documents SSE on an application/json response. Inspect the
    // framing even when a media type is present, including split prefixes.
    for(;;){
      const chunk=await read();
      if(chunk.done)break;
      if(!chunk.value?.byteLength)continue;
      prefix.push(chunk.value);
      const part=decoder.decode(chunk.value,{stream:true});
      lead+=(lead?part:part.trimStart()).slice(0,6-lead.length);
      sse=sseFields.some(field=>lead.startsWith(field));
      if(sse||!sseFields.some(field=>field.startsWith(lead)))break;
      if(bytes>=64*1024)throw new MiniMaxSpeechError('protocol');
    }
    if(!sse&&(jsonType||lead[0]==='{'||lead[0]==='[')){
      const bodyDecoder=new TextDecoder();
      let body=prefix.map(chunk=>bodyDecoder.decode(chunk,{stream:true})).join('');
      for(;;){
        const chunk=await read();
        if(chunk.done)break;
        body+=bodyDecoder.decode(chunk.value,{stream:true});
      }
      body+=bodyDecoder.decode();
      let row;
      try{row=JSON.parse(body);}catch{ /* Unexpected JSON or a plain HTTP error. */ }
      throw businessError(row)??(response.ok?new MiniMaxSpeechError('response'):minimaxHttpError(response.status));
    }
    if(!sse){
      if(!response.ok)throw minimaxHttpError(response.status);
      throw new MiniMaxSpeechError('response');
    }

    const body=new ReadableStream({
      async pull(controller){
        const chunk=prefix.length?{value:prefix.shift()}:await read();
        if(chunk.done)controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel:abort,
    },{highWaterMark:0});
    for await(const event of readSseEvents({body},{signal:deadline.signal})){
      let row;
      try{row=JSON.parse(event);}catch{
        if(!response.ok)continue;
        throw new MiniMaxSpeechError('protocol');
      }
      const business=businessError(row);
      if(business)throw business;
      if(!response.ok)continue;
      if(row?.base_resp?.status_code!==undefined && row.base_resp.status_code!==0)throw new MiniMaxSpeechError('protocol');
      yield row;
    }
    if(!response.ok)throw minimaxHttpError(response.status);
  }finally{
    deadline.signal.removeEventListener('abort',abort);
    abort();reader.releaseLock();
  }
}

function speechUsage({usage_characters:characters,usage_voice_count:voices}={}){
  const result={};
  if(Number.isSafeInteger(characters)&&characters>=0)result.characters=characters;
  if(Number.isSafeInteger(voices)&&voices>=0)result.voices=voices;
  return Object.keys(result).length?result:undefined;
}

export function launchMiniMaxSpeech(fetchSpeech,request,{signal}={}) {
  const cancellation=new AbortController();
  const sampleRate=32000;
  const protocol=()=>new MiniMaxSpeechError('protocol');
  const events=(async function*(){
    const timeout=AbortSignal.timeout(300000);
    const deadline=createDownloadDeadline(AbortSignal.any([...(signal?[signal]:[]),cancellation.signal,timeout]),{connectMs:30000,idleMs:120000});
    const startedAt=performance.now();
    let response,incomplete;
    try {
      const {speed=1,volume=1,pitch=0}=request.params??{};
      const voice={voice_id:request.voiceId,speed,vol:volume,pitch};
      const emotion=request.performance?.emotion==='neutral'?'calm':request.performance?.emotion;
      if (['happy','sad','angry','fearful','disgusted','surprised','calm'].includes(emotion)) voice.emotion=emotion;
      const endpoint=request.base+'/v1/t2a_v2';
      const init={
        method:'POST',redirect:'error',credentials:'omit',signal:deadline.signal,
        headers:{authorization:'Bearer '+request.key,'content-type':'application/json',accept:'text/event-stream'},
        body:JSON.stringify({model:request.model,text:request.text,stream:true,stream_options:{exclude_aggregated_audio:true},
          language_boost:'Chinese',output_format:'hex',voice_setting:voice,audio_setting:{format:'pcm',sample_rate:sampleRate,channel:1}}),
      };
      response=await waitForNetwork(()=>{
        deadline.signal.throwIfAborted();
        return fetchSpeech(endpoint,init);
      },deadline.signal);
      if (response.redirected || (response.url && response.url!==endpoint)) throw protocol();
      if (response.status>=300 && response.status<400) throw minimaxHttpError(response.status);
      deadline.touch();

      // Compare a terminal aggregate with the streamed prefix without buffering
      // earlier audio. With exclude_aggregated_audio, status 2 usually has no audio.
      const streamed=createHash('sha256');
      let total=0,firstPcm,tail=Buffer.alloc(0),completed=false,usage;
      for await (const row of readMiniMaxSpeech(response,deadline)) {
        const {status,audio}=row?.data??{};
        if (status!==1 && status!==2) throw protocol();
        if (audio!==undefined && audio!==null && audio!=='') {
          if (typeof audio!=='string' || audio.length%2 || !/^[0-9a-f]+$/i.test(audio)) throw protocol();
          let pcm=Buffer.from(audio,'hex');
          if (status===2 && total) {
            if (pcm.length<total || hash(pcm.subarray(0,total))!==streamed.digest('hex')) throw protocol();
            pcm=pcm.subarray(total);
          }
          if (status===1) streamed.update(pcm);
          total+=pcm.length;
          if (tail.length) pcm=Buffer.concat([tail,pcm]);
          const aligned=pcm.length-pcm.length%2;
          tail=pcm.subarray(aligned);
          if (aligned) {
            firstPcm??=(performance.now()-startedAt)/1000;
            yield {type:'pcm',pcm:pcm.subarray(0,aligned),sample_rate:sampleRate};
          }
        }
        if (status===2) {completed=true;usage=speechUsage(row.extra_info??undefined);break;}
      }
      deadline.signal.throwIfAborted();
      if (!completed || tail.length || !total) {
        incomplete=fail('CLOUD_INCOMPLETE','云配音没有确认完整尾音');
        throw incomplete;
      }
      yield {type:'done',metrics:{voice_id:request.voiceId,first_pcm_seconds:firstPcm,
        generation_seconds:(performance.now()-startedAt)/1000,audio_seconds:total/2/sampleRate,input_text_chunks:1},usage};
    } catch(error) {
      if (signal?.aborted || cancellation.signal.aborted) throw aborted();
      if (deadline.signal.aborted || error?.name==='TimeoutError' || error?.code==='NETWORK_RESPONSE_TIMEOUT') throw new MiniMaxSpeechError('timeout');
      if (error instanceof MiniMaxSpeechError || error===incomplete&&incomplete) throw error;
      throw new MiniMaxSpeechError('network');
    } finally {
      deadline.dispose();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(()=>{});
    }
  })();
  return {events,cancel:()=>{cancellation.abort();return events.return();}};
}

export function launchHttpSpeech(fetchSpeech,request,options){
  const job=launchMiniMaxSpeech(fetchSpeech,request,options);
  const events=(async function*(){
    for await(const {usage,...row} of job.events){
      yield row.type==='pcm'?{...row,pcm:row.pcm.toString('base64')}:row;
    }
  })();
  return {events,cancel:job.cancel};
}
