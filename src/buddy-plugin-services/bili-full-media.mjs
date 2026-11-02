import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {join} from 'node:path';

const fail=code=>Object.assign(Error(code),{code});
const MiB=1024*1024,agent='Mozilla/5.0 AI-Buddy/2.0.2';
// Fixed-size upstream ranges remove the old 192 MiB/30-minute whole-file gate.
// The loopback server streams each range with backpressure and holds no video file.
async function rangeProxy(source,{signal,check,fetchImpl=fetch}){
 const token=randomBytes(24).toString('hex');let active=0;const requests=new Set();
 const server=createServer(async(req,res)=>{const ctl=new AbortController();requests.add(ctl);const stop=()=>ctl.abort();req.once('aborted',stop);res.once('close',stop);const combined=AbortSignal.any([signal,ctl.signal].filter(Boolean));
  try{if(req.url!=='/'+token||!['GET','HEAD'].includes(req.method)||++active>2)throw fail('BILI_FULL_PROXY_DENIED');const requested=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'bytes=0-');if(!requested)throw fail('BILI_FULL_PROXY_RANGE');let offset=Number(requested[1]),end=requested[2]?Number(requested[2]):null,started=false;
   for(;;){combined.throwIfAborted();await check?.();const last=Math.min(offset+8*MiB-1,end??Number.MAX_SAFE_INTEGER),up=await fetchImpl(source,{method:'GET',headers:{range:`bytes=${offset}-${last}`,referer:'https://www.bilibili.com/','user-agent':agent},redirect:'error',signal:AbortSignal.any([combined,AbortSignal.timeout(65000)])});const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(up.headers.get('content-range')??'');
    if(up.status!==206||!range||Number(range[1])!==offset||Number(range[2])>last||Number(range[2])<offset||!up.body){await up.body?.cancel();throw fail('BILI_FULL_ORIGINAL_UNAVAILABLE');}const total=Number(range[3]);end=Math.min(end??total-1,total-1);if(!started){res.writeHead(206,{'content-type':'video/mp4','accept-ranges':'bytes','content-range':`bytes ${offset}-${end}/${total}`,'content-length':String(end-offset+1),'cache-control':'no-store'});started=true;if(req.method==='HEAD'){await up.body.cancel();break;}}
    let received=0;for await(const b of up.body){combined.throwIfAborted();received+=b.length;if(received>8*MiB||received>Number(range[2])-offset+1)throw fail('BILI_FULL_PROXY_RANGE');if(!res.write(b))await new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(fail('BILI_FULL_PAUSED'));},drain=()=>{cleanup();resolve();},cleanup=()=>{combined.removeEventListener('abort',abort);res.off('drain',drain);};combined.addEventListener('abort',abort,{once:true});res.once('drain',drain);});}if(received!==Number(range[2])-offset+1)throw fail('BILI_FULL_ORIGINAL_UNAVAILABLE');offset=Number(range[2])+1;if(offset>end)break;
   }res.end();
  }catch(error){if(!res.headersSent)res.writeHead(503);res.destroy(error);}finally{active=Math.max(0,active-1);requests.delete(ctl);req.off('aborted',stop);res.off('close',stop);}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:`http://127.0.0.1:${server.address().port}/${token}`,async close(){for(const ctl of requests)ctl.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
export function createBiliFullMedia({tools,playback,validateUrl,fetchImpl=fetch,workerPath,resolveVerifiedExecutable}){
 let active=false;
 return async function fullSampling({scope,video,config,sheets,signal,check,onSheet,stopAfterSheets}){
  if(active)throw fail('BILI_MEDIA_BUSY');active=true;let proxy,worker;const lifetime=new AbortController(),combined=AbortSignal.any([signal,lifetime.signal].filter(Boolean));
  try{combined.throwIfAborted();await check?.();const verified=resolveVerifiedExecutable?await resolveVerifiedExecutable({signal:combined}):{executable:join(tools,'ffmpeg.exe')};combined.throwIfAborted();await check?.();const data=await playback({scope,video,signal:combined});if(!data||data.is_preview||!(data.timelength>0)||Math.abs(data.timelength/1000-video.duration)>4)throw fail('BILI_FULL_ORIGINAL_UNAVAILABLE');
   const tracks=[...(data.dash?.video??[])].filter(t=>t.baseUrl||t.base_url).sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0)),track=tracks[0],mux=data.durl?.length===1&&/mp4/i.test(data.format??'')?data.durl[0].url:null;
   const source=validateUrl(track?.baseUrl??track?.base_url??mux);proxy=await rangeProxy(source,{signal:combined,check,fetchImpl});
   combined.throwIfAborted();await check?.();const executable=resolveVerifiedExecutable?(await resolveVerifiedExecutable({signal:combined})).executable:verified.executable;combined.throwIfAborted();await check?.();if(executable!==verified.executable)throw fail('FFMPEG_COMPONENT_CHANGED');
   worker=new Worker(workerPath??new URL('./bili-full-media-worker.mjs',import.meta.url),{workerData:{executable,url:proxy.url,duration:video.duration,config,sheets,stopAfterSheets}});
   return await new Promise((resolve,reject)=>{let settled=false,chain=Promise.resolve();const abort=()=>{worker.postMessage({type:'abort'});done(reject,combined.reason??fail('BILI_FULL_PAUSED'));},done=(fn,value)=>{if(settled)return;settled=true;combined.removeEventListener('abort',abort);fn(value);};combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();
    worker.on('message',msg=>{if(msg.type==='sheet'){chain=chain.then(async()=>{combined.throwIfAborted();await check?.();await onSheet({...msg.sheet,png:Buffer.from(msg.sheet.png)});worker.postMessage({type:'ack',sequence:msg.sequence});}).catch(e=>{worker.postMessage({type:'abort'});done(reject,e);});}if(msg.type==='done')chain.then(()=>done(resolve,{visual:'original-video',audio:'unavailable',emitted:msg.emitted,transcript:[]}));if(msg.type==='error')done(reject,fail(msg.code));});worker.once('error',e=>done(reject,e));worker.once('exit',code=>{if(!settled)done(reject,fail(code?'BILI_FULL_DECODE_INCOMPLETE':'BILI_FULL_FRAMES_MISSING'));});
   });
  }catch(error){if(combined.aborted||error.code?.startsWith('FFMPEG_COMPONENT_'))throw error;throw error.code?.startsWith('BILI_FULL_')?error:fail('BILI_FULL_ORIGINAL_UNAVAILABLE');}finally{lifetime.abort();if(worker){if(worker.threadId!==-1){let timer;const exited=new Promise(resolve=>worker.once('exit',resolve));try{worker.postMessage({type:'abort'});await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);}finally{clearTimeout(timer);if(worker.threadId!==-1)await worker.terminate();}}}await proxy?.close();active=false;}
 };
}
