/** Electron PCM capture uses the same repaired 16k worklet as the streaming lab.
 * Only the main-process controller decides endpoints, submission and replay. */
export function createHostVoiceCapture({action,onState=()=>{},onPartial=()=>{},onError=()=>{},
  getMedia=()=>navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}),
  makeContext=()=>new AudioContext({sampleRate:16000}),makeNode=context=>new AudioWorkletNode(context,'voice-capture'),
  workletURL=new URL('./voice-capture-worklet.js',location.href).href}){
  let generation=0,stream,context,node,source,gain,current,hostCaptureId,queue=[],queuedBytes=0,pumping,flushResolve,opening=false;
  const gate=enabled=>node?.port.postMessage({enabled});
  function release(){
    generation++;opening=false;current=null;hostCaptureId=undefined;queue=[];queuedBytes=0;pumping=undefined;gate(false);
    for(const item of [source,node,gain])try{item?.disconnect();}catch{}
    source=node=gain=undefined;const old=stream;stream=undefined;old?.getTracks().forEach(track=>track.stop());
    const audio=context;context=undefined;audio?.close().catch(()=>{});flushResolve?.();flushResolve=undefined;onState('idle');
  }
  async function stop(){release();await action('stop');}
  function fail(error){const id=hostCaptureId;release();void action('stop',{id}).catch(()=>{});onError(error);}
  async function pump(){
    if(pumping)return pumping;
    const ticket=generation;
    const job=(async()=>{
      while(ticket===generation&&current&&queue.length){
        const captured=current,parts=[];let size=0;
        while(queue.length&&size+queue[0].length<=16384){const part=queue.shift();parts.push(part);size+=part.length;queuedBytes-=part.length;}
        const pcm=new Uint8Array(size);let offset=0;for(const part of parts){pcm.set(part,offset);offset+=part.length;}
        await action('capture-feed',{id:captured.id,pcm});
      }
    })();pumping=job;
    try{await job;}finally{if(pumping===job)pumping=undefined;}
  }
  async function start(mode){
    if(current||opening)throw Error('请先结束当前录音');
    const ticket=++generation;opening=true;onState('preparing');let acquired,ack;
    try{
      ack=await action('capture-start',{mode});
      if(ticket!==generation){if(ack?.id)await action('stop',{id:ack.id});return;}
      if(!ack?.id)throw Error('本地识别组件未就绪');
      acquired=await getMedia();
      if(ticket!==generation){acquired.getTracks().forEach(track=>track.stop());return;}
      const audio=makeContext();
      try{await audio.audioWorklet.addModule(workletURL);await audio.resume();}
      catch(error){await audio.close().catch(()=>{});throw error;}
      if(ticket!==generation){acquired.getTracks().forEach(track=>track.stop());await audio.close();return;}
      stream=acquired;context=audio;hostCaptureId=ack.id;current={id:ack.id,mode};source=context.createMediaStreamSource(stream);node=makeNode(context);gain=context.createGain();gain.gain.value=0;
      source.connect(node);node.connect(gain);gain.connect(context.destination);
      node.port.onmessage=({data})=>{
        if(ticket!==generation)return;
        if(data?.type==='flushed'){flushResolve?.();flushResolve=undefined;return;}
        if(!current||!(data instanceof ArrayBuffer))return;
        const pcm=new Uint8Array(data);
        if(!pcm.length||pcm.length%2||pcm.length>16384||queuedBytes+pcm.length>256000){fail(Error('识别连接跟不上录音，已停止；已有草稿保留'));return;}
        queue.push(pcm);queuedBytes+=pcm.length;void pump().catch(error=>{if(ticket===generation)fail(error);});
      };
      const owned=stream;stream.getAudioTracks()[0].onended=()=>{if(stream===owned)fail(Error('麦克风断开，已有草稿保留'));};
      gate(true);onState(mode==='live'?'listening':'recording',{resetPartial:true});
      return ack;
    }catch(error){acquired?.getTracks().forEach(track=>track.stop());if(ticket===generation){release();await action('stop',ack?.id?{id:ack.id}:{}).catch(()=>{});}throw error;}
    finally{if(ticket===generation)opening=false;}
  }
  function event(value){
    if(value.type==='invalidate'){release();return;}
    if(value.type!=='capture')return;
    if(typeof value.partial==='string'){
      if(current?.id===value.id)onPartial(value.partial);
      return;
    }
    if(value.state==='idle'){release();return;}
    if(['processing','waiting-playback'].includes(value.state)){gate(false);queue=[];queuedBytes=0;current=null;onState(value.state);return;}
    if(value.state==='listening'&&stream){
      const resetPartial=current?.id!==value.id;
      hostCaptureId=value.id;current={id:value.id,mode:'live'};gate(true);onState('listening',{resetPartial});
    }
  }
  async function finish(){
    const captured=current;if(!captured)return;
    if(node)await new Promise(resolve=>{const timer=setTimeout(resolve,200);flushResolve=()=>{clearTimeout(timer);resolve();};node.port.postMessage({type:'flush'});gate(false);});
    while(pumping)await pumping;
    if(queue.length)await pump();
    if(current?.id!==captured.id)return;
    const result=await action('capture-finish',{id:captured.id});release();return result;
  }
  return {start,finish,stop,event,release};
}
