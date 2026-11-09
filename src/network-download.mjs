import {createReadStream} from 'node:fs';import {mkdir,lstat,open,rename,stat} from 'node:fs/promises';import {dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';
import {networkFailure,networkErrorMessage} from './network-errors.mjs';
const redirects=new Set([301,302,303,307,308]),details=new WeakMap();
const failure=(code,message)=>Object.assign(Error(message??code),{code});
export const downloadResponseInfo=response=>details.get(response)??null;
export function waitForNetwork(operation,signal){
 signal?.throwIfAborted();return new Promise((resolve,reject)=>{
  const abort=()=>{signal?.removeEventListener('abort',abort);reject(signal.reason);};signal?.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(operation).then(value=>{signal?.removeEventListener('abort',abort);if(signal?.aborted){void value?.body?.cancel().catch(()=>{});reject(signal.reason);}else resolve(value);},cause=>{signal?.removeEventListener('abort',abort);reject(cause);});
 });
}
export function createDownloadDeadline(signal,{connectMs=30000,idleMs=60000}={}){
 const controller=new AbortController();let timer;
 const touch=(ms=idleMs)=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(failure('NETWORK_TIMEOUT',networkErrorMessage('NETWORK_TIMEOUT'))),ms);};
 touch(connectMs);return {signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,touch,dispose:()=>clearTimeout(timer)};
}
export async function fetchDownloadResponse(value,{fetchImpl=fetch,planDownload,validateUrl=url=>new URL(url),maxRedirects=5,transportOrigin,official=false,...init}={}){
 let logical=new URL(value);validateUrl(logical.href,{initial:true});
 for(let hop=0;;hop++){
  const plan=planDownload?planDownload(logical.href,{official}):{logicalUrl:logical.href,requestUrl:logical.href,mirror:null},actual=new URL(plan.requestUrl);
  if(actual.username||actual.password||actual.hash||!(actual.protocol==='https:'||actual.protocol==='http:'&&actual.hostname==='127.0.0.1'))throw failure('NETWORK_DOWNLOAD_ORIGIN');
  const response=await waitForNetwork(()=>fetchImpl(actual.href,{...init,redirect:'manual',credentials:'omit'}),init.signal);
  const observed=response.url?new URL(response.url):actual;
  const fixture=transportOrigin&&fetchImpl!==globalThis.fetch&&new URL(transportOrigin).protocol==='http:'&&new URL(transportOrigin).hostname==='127.0.0.1'&&observed.origin===transportOrigin;
  if(observed.href!==actual.href&&!fixture){await response.body?.cancel();throw failure('NETWORK_DOWNLOAD_ORIGIN','Download transport changed its endpoint');}
  details.set(response,{...plan,finalUrl:observed.href});
  if(!redirects.has(response.status))return response;
  const location=response.headers.get('location');await response.body?.cancel();if(!location||hop>=maxRedirects)throw failure('NETWORK_DOWNLOAD_REDIRECT');
  const next=new URL(location,actual);
  // A mirror-relative redirect keeps the original logical authority. An
  // absolute official CDN redirect is checked as that CDN, never disguised.
  if(plan.mirror&&next.origin===actual.origin){next.protocol=logical.protocol;next.host=logical.host;}
  validateUrl(next.href,{initial:false,previous:logical.href});logical=next;
 }
}
export async function verifiedFile(path,item){
 await assertPluginTreeNoLinks(path);let info;try{info=await lstat(path);}catch(cause){if(cause.code==='ENOENT')return false;throw cause;}
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw failure('NETWORK_DOWNLOAD_PATH','Download cache is not an owned file');
 if(item.bytes!==undefined&&info.size!==item.bytes||item.maxBytes!==undefined&&info.size>item.maxBytes)return false;const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex')===item.sha256;
}
async function exists(path){try{return await lstat(path);}catch(cause){if(cause.code==='ENOENT')return null;throw cause;}}
async function retainRejected(path){if(await exists(path)){await assertPluginTreeNoLinks(path);await rename(path,path+'.rejected-'+randomUUID());}}
export async function downloadPinnedFile(item,target,{fetchImpl=fetch,planDownload,validateUrl,transportOrigin,maxRedirects=5,signal,onProgress=()=>{},check=()=>{},connectMs=30000,idleMs=60000,retries=2,official=false,partial=target+'.partial'}={}){
 const limit=item.bytes??item.maxBytes;if(!Number.isSafeInteger(limit)||limit<0||!/^[a-f0-9]{64}$/.test(item.sha256??''))throw failure('NETWORK_DOWNLOAD_DESCRIPTOR');
 await assertPluginTreeNoLinks(dirname(target));await mkdir(dirname(target),{recursive:true});
 const sameTarget=target===partial;
 if(!sameTarget){const candidate=await exists(target);if(candidate?.isFile()&&!candidate.isSymbolicLink()&&candidate.nlink>1)await retainRejected(target);
 if(await verifiedFile(target,item))return target;if(await exists(target))await retainRejected(target);}
 for(let attempt=0;;attempt++){
  signal?.throwIfAborted();check();await assertPluginTreeNoLinks(partial);let offset=(await exists(partial))?.size??0;
  if(offset>limit){await retainRejected(partial);offset=0;}
  if(offset===item.bytes){if(await verifiedFile(partial,item)){if(!sameTarget)await rename(partial,target);return target;}await retainRejected(partial);offset=0;}
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let timer,response,file,mirror=false;
  const touch=ms=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(failure('NETWORK_TIMEOUT',networkErrorMessage('NETWORK_TIMEOUT'))),ms);timer.unref?.();};
  try{
   touch(connectMs);response=await fetchDownloadResponse(item.url,{fetchImpl,planDownload,validateUrl,transportOrigin,maxRedirects,official,signal:combined,headers:{'accept-encoding':'identity',...(offset?{Range:'bytes='+offset+'-'}:{})}});mirror=!!downloadResponseInfo(response)?.mirror;touch(idleMs);
   if(!response.ok||!response.body)throw networkFailure(null,item.url,{response});
   if(response.status===200)offset=0;
   else if(response.status===206){const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');if(!match||Number(match[1])!==offset||Number(match[3])>limit||item.bytes!==undefined&&Number(match[3])!==item.bytes||Number(match[2])<offset||Number(match[2])>=Number(match[3]))throw failure('NETWORK_DOWNLOAD_RANGE');}
   else throw failure('NETWORK_DOWNLOAD_RANGE');
   const encoding=response.headers.get('content-encoding');if(encoding&&encoding!=='identity')throw failure('NETWORK_DOWNLOAD_RANGE');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit-offset))throw failure('NETWORK_DOWNLOAD_SIZE');
   file=await open(partial,offset?'a':'w',0o600);const opened=await file.stat();if(!opened.isFile()||opened.nlink!==1)throw failure('NETWORK_DOWNLOAD_PATH');
   let received=offset;onProgress({phase:'downloading',receivedBytes:received,totalBytes:item.bytes});
   const reader=response.body.getReader(),abortRead=()=>{void reader.cancel(combined.reason).catch(()=>{});};combined.addEventListener('abort',abortRead,{once:true});
   try{while(true){combined.throwIfAborted();const {done,value:chunk}=await reader.read();combined.throwIfAborted();if(done)break;check();touch(idleMs);received+=chunk.length;if(received>limit)throw failure('NETWORK_DOWNLOAD_SIZE');await file.write(chunk);onProgress({phase:'downloading',receivedBytes:received,totalBytes:item.bytes});}}
   finally{combined.removeEventListener('abort',abortRead);reader.releaseLock();}
   await file.sync();await file.close();file=null;combined.throwIfAborted();check();
   if(item.bytes!==undefined&&received!==item.bytes)throw failure('NETWORK_DOWNLOAD_INCOMPLETE');
   if(!await verifiedFile(partial,item)){await retainRejected(partial);throw failure('NETWORK_DOWNLOAD_HASH','下载校验不一致，已拒绝');}
   if(!sameTarget)await rename(partial,target);return target;
  }catch(cause){
   if(file){await file.close();file=null;}if(signal?.aborted)throw signal.reason;
   const original=controller.signal.aborted?controller.signal.reason:cause;
   const error=typeof original?.code==='string'?original:networkFailure(original,item.url);
   if(mirror&&['NETWORK_DOWNLOAD_SIZE','NETWORK_DOWNLOAD_INCOMPLETE','NETWORK_DOWNLOAD_RANGE','NETWORK_DOWNLOAD_HASH'].includes(error.code)){
    await retainRejected(partial);
    throw Object.assign(failure('NETWORK_MIRROR_MISMATCH',networkErrorMessage('NETWORK_MIRROR_MISMATCH')),{network:true,retryOfficial:true,technicalCode:error.code,technical:{code:error.code},cause:error});
   }
   const retriable=['NETWORK_CONNECT_FAILED','NETWORK_DOWNLOAD_INCOMPLETE','NETWORK_TIMEOUT','ECONNRESET','ETIMEDOUT','ECONNREFUSED'].includes(error?.code)||error instanceof TypeError;
   if(!retriable||error.status>=400&&error.status<500&&error.status!==429||attempt>=retries)throw error;
   // Retry only transport failures. The verified prefix stays at .partial.
  }finally{clearTimeout(timer);if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}
 }
}
