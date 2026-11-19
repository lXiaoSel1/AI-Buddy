export const CHAT_FINISH_IDLE_MS=5000;
export const isUsageObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export async function* readSseEvents(response,{onActivity,onBytes,limit,onLimit,tail,signal}){
  const decoder=new TextDecoder(),reader=response.body.getReader();
  const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  let buffer='',data=[],bytes=0,eof=false;
  try{
    for(;;){
      let timer;
      const read=reader.read();
      const chunk=await (tail?.deadline
        ?Promise.race([read,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(0,tail.deadline-performance.now()));})])
        :read).finally(()=>clearTimeout(timer));
      if(chunk===null){tail.timedOut=true;return;}
      if(chunk.done){eof=true;break;}
      if(tail?.deadline&&performance.now()>=tail.deadline){tail.timedOut=true;return;}
      const value=chunk.value;
      if(value.byteLength)onActivity?.();
      bytes+=value.byteLength;
      onBytes?.(bytes);
      if(bytes>limit)throw onLimit();
      buffer+=decoder.decode(value,{stream:true});
      let newline;
      while((newline=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,newline).replace(/\r$/,'');
        buffer=buffer.slice(newline+1);
        if(!line&&data.length){
          const event=data.join('\n');
          data=[];
          yield event;
        }else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());
      }
    }
    buffer+=decoder.decode();
    if(buffer.startsWith('data:'))data.push(buffer.slice(5).trim());
    if(data.length)yield data.join('\n');
  }finally{
    signal?.removeEventListener('abort',abort);
    if(!eof)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
