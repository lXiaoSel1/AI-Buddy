import {createHash} from 'node:crypto';

export const DSH_PUBLIC_COMPONENT=Object.freeze({schemaVersion:1,sourceCommit:'22ddee3792402c3e70ec5f86a63c3e3e895a2f60',nodeVersion:'24.21.0',pnpmVersion:'11.28.5',bytes:198580207,sha256:'b2dbb9fdd654099e403075c2cb00c6aaa8f51e35514544c9052591433ae78b12',manifestSha256:'1c27979fa533f279e0dd027d91845faeacadc896e0585d9ae4cb14003d026e2f',filename:'ai-buddy-dsh-22ddee379240-node24.21.0-win-x64.tgz',url:'https://github.com/lXiaoSel1/AI-Buddy-Extensions/releases/download/dsh-component-22ddee379240-node24.21.0/ai-buddy-dsh-22ddee379240-node24.21.0-win-x64.tgz'});
const fault=(message,code='DSH_COMPONENT_DOWNLOAD_FAILED')=>Object.assign(Error(message),{code});
const redirected=new Set([301,302,303,307,308]),cdn=new Set(['release-assets.githubusercontent.com','objects.githubusercontent.com']);
export function assertPublicDshComponentDescriptor(value){
  if(!value||Object.entries(DSH_PUBLIC_COMPONENT).some(([key,item])=>value[key]!==item))throw fault('Component descriptor differs from this host release','DSH_COMPONENT_DESCRIPTOR_REQUIRED');
  return {...DSH_PUBLIC_COMPONENT};
}
export function assertDshComponentDownloadUrl(value,{initial=false,fixtureOrigin=null}={}){
  let url;try{url=new URL(value);}catch{throw fault('Invalid component download origin','DSH_COMPONENT_DOWNLOAD_ORIGIN');}
  if(url.username||url.password||url.hash||url.port&&url.port!=='443'||url.protocol!=='https:'){
    if(!fixtureOrigin||url.origin!==fixtureOrigin||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash)throw fault('Invalid component download origin','DSH_COMPONENT_DOWNLOAD_ORIGIN');
  }
  if(fixtureOrigin){if(url.origin!==fixtureOrigin)throw fault('Component fixture redirect leaves its origin','DSH_COMPONENT_DOWNLOAD_ORIGIN');}
  else if(initial?url.href!==DSH_PUBLIC_COMPONENT.url:!cdn.has(url.hostname))throw fault('Untrusted component download origin','DSH_COMPONENT_DOWNLOAD_ORIGIN');
  return url;
}
// The fixture origin is available only to a constructor-injected fetch transport.
// Production always starts at the exact host-owned URL and follows official CDN
// HTTPS redirects manually. Signed locations are never returned or put in errors.
export async function downloadDshComponent(item,{fetchImpl=fetch,signal,timeoutMs=300000,maxRedirects=3,fixtureOrigin=null,onProgress=()=>{},check=()=>{}}={}){
  let url=assertDshComponentDownloadUrl(item.url,{initial:true,fixtureOrigin}),response,total=0;const controller=new AbortController(),cancel=()=>controller.abort(signal.reason),timer=setTimeout(()=>controller.abort(fault('Component download timed out','DSH_COMPONENT_DOWNLOAD_TIMEOUT')),timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const checkpoint=()=>{check();controller.signal.throwIfAborted();};
  try{
    for(let count=0;;count++){
      checkpoint();response=await fetchImpl(url.href,{signal:controller.signal,redirect:'manual',credentials:'omit'});checkpoint();
      if(!redirected.has(response.status))break;
      const location=response.headers.get('location');await response.body?.cancel();if(count>=maxRedirects)throw fault('Too many component download redirects','DSH_COMPONENT_DOWNLOAD_REDIRECTS');
      if(!location)throw fault('Component download redirect has no destination','DSH_COMPONENT_DOWNLOAD_ORIGIN');
      let target;try{target=new URL(location,url);}catch{throw fault('Invalid component redirect destination','DSH_COMPONENT_DOWNLOAD_ORIGIN');}
      url=assertDshComponentDownloadUrl(target.href,{fixtureOrigin});
    }
    if(response.status!==200||!response.body)throw fault('Component download HTTP '+response.status);
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==item.bytes))throw fault('Component archive digest or size differs','DSH_COMPONENT_INVALID');
    const chunks=[],digest=createHash('sha256');for await(const chunk of response.body){checkpoint();total+=chunk.length;if(total>item.bytes)throw fault('Component exceeds pinned size','DSH_COMPONENT_INVALID');const bytes=Buffer.from(chunk);digest.update(bytes);chunks.push(bytes);onProgress({phase:'downloading',receivedBytes:total,totalBytes:item.bytes});}
    checkpoint();if(total!==item.bytes||digest.digest('hex')!==item.sha256)throw fault('Component archive digest or size differs','DSH_COMPONENT_INVALID');return Buffer.concat(chunks,total);
  }catch(cause){
    if(controller.signal.aborted)throw controller.signal.reason?.code==='DSH_COMPONENT_DOWNLOAD_TIMEOUT'?controller.signal.reason:fault('Component installation cancelled','ABORT_ERR');
    if(typeof cause?.code==='string'&&/^(DSH_COMPONENT_|ABORT_ERR$)/.test(cause.code))throw cause;
    throw fault('Component download failed');
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}
}
