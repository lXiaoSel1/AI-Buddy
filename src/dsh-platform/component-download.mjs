import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {downloadPinnedFile} from '../network-download.mjs';
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
export async function downloadDshComponent(item,{fetchImpl=fetch,planDownload,signal,timeoutMs=30000,idleMs=60000,maxRedirects=3,fixtureOrigin=null,transportOrigin,onProgress=()=>{},check=()=>{},cacheDirectory}={}){
  const temporary=!cacheDirectory,root=cacheDirectory??await mkdtemp(join(tmpdir(),'buddy-dsh-download-'));
  const target=join(root,item.sha256+'.tgz');
  try{
    await downloadPinnedFile(item,target,{fetchImpl,planDownload,transportOrigin,maxRedirects,signal,onProgress,check,connectMs:Math.min(timeoutMs,30000),idleMs,validateUrl:(url,options)=>assertDshComponentDownloadUrl(url,{initial:options.initial,fixtureOrigin})});
    return await readFile(target,{signal});
  }catch(cause){if(signal?.aborted)throw fault('Component installation cancelled','ABORT_ERR');if(cause.code==='NETWORK_MIRROR_MISMATCH')throw cause;if(cause.code==='NETWORK_TIMEOUT')throw fault('Component download timed out','DSH_COMPONENT_DOWNLOAD_TIMEOUT');if(cause.code==='NETWORK_DOWNLOAD_REDIRECT')throw fault('Too many component redirects','DSH_COMPONENT_DOWNLOAD_REDIRECTS');if(/^NETWORK_DOWNLOAD_(HASH|SIZE|RANGE)$/.test(cause.code??''))throw fault('Component archive digest or size differs','DSH_COMPONENT_INVALID');if(cause.code?.startsWith('DSH_'))throw cause;throw fault('Component download failed');}
  finally{if(temporary)await rm(root,{recursive:true,force:true});}
}
