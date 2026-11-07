import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,open,realpath,rename,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {verifyRawSshSignature} from './raw-sshsig.mjs';
import {updateError} from './update-reservation.mjs';

export const APP_RELEASE_REPOSITORY='lXiaoSel1/AI-Buddy';
export const APP_RELEASE_PUBLIC_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFLmFoAgOaffTLAwNJ+U1v0MK4iaTHbMZ+BjaidVla05';
export const APP_INSTALLER_LIMIT=256*1024*1024;
const api='https://api.github.com/repos/'+APP_RELEASE_REPOSITORY,web='https://github.com/'+APP_RELEASE_REPOSITORY;
const apiLimit=4*1024*1024,digest=/^[a-f0-9]{64}$/,commit=/^[a-f0-9]{40}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>updateError('APP_UPDATE_VERIFICATION_FAILED');
const requireProof=value=>{if(!value)throw invalid();};
const localVerify=(payload,signature)=>verifyRawSshSignature(Buffer.from(payload,'utf8'),signature,APP_RELEASE_PUBLIC_KEY,'git');
function versionParts(value){requireProof(typeof value==='string'&&value.length<=128&&/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value));return value.split('.').map(BigInt);}
function newer(a,b){const x=versionParts(a),y=versionParts(b);for(let n=0;n<3;n++)if(x[n]!==y[n])return x[n]>y[n];return false;}
function lines(text,separator){const result=new Map();for(const line of text.split('\n')){const n=line.indexOf(separator);if(n<0)continue;const key=line.slice(0,n);requireProof(!result.has(key));result.set(key,line.slice(n+separator.length));}return result;}

// Test injection is a cryptographic boundary only. Production always uses the pinned release key and git namespace.
export function verifyAppReleaseProof(release,{verifySignature=localVerify}={}){
  requireProof(release&&typeof release==='object');versionParts(release.version);
  const {version,tag,installerName}=release;
  requireProof(tag==='v'+version&&installerName===`AI-Buddy-Setup-${version}-win-x64.exe`&&
    release.releaseUrl===web+'/releases/tag/'+tag&&release.installerUrl===web+'/releases/download/'+tag+'/'+installerName&&
    Number.isSafeInteger(release.bytes)&&release.bytes>0&&release.bytes<=APP_INSTALLER_LIMIT&&
    [release.installerSha256,release.manifestSha256,release.checksumsSha256].every(value=>digest.test(value??''))&&
    [release.sourceCommit,release.tagObjectSha].every(value=>commit.test(value??'')));
  const {signedPayload:payload,signature}=release;
  requireProof(typeof payload==='string'&&Buffer.byteLength(payload,'utf8')<=apiLimit&&typeof signature==='string'&&signature.length<=16384&&
    signature.startsWith('-----BEGIN SSH SIGNATURE-----\n')&&verifySignature(payload,signature));
  const n=payload.indexOf('\n\n');requireProof(n>=0);
  const headers=lines(payload.slice(0,n),' '),bindings=lines(payload.slice(n+2),': ');
  requireProof(headers.get('object')===release.sourceCommit&&headers.get('type')==='commit'&&headers.get('tag')===tag&&
    bindings.get('Source')===release.sourceCommit&&bindings.get('Installer SHA-256')===release.installerSha256&&
    bindings.get('Manifest SHA-256')===release.manifestSha256&&bindings.get('Checksums SHA-256')===release.checksumsSha256&&
    bindings.get('App Update Protocol')==='1'&&bindings.get('App Bootstrap Protocol')==='1');
  return Object.freeze({...release});
}
export function bootstrapSelectionId(source,release){
  requireProof(digest.test(source?.installationSha256??'')&&digest.test(source?.pointerSha256??''));
  return sha(['AI-Buddy-App-Bootstrap-1',source.installationSha256,source.pointerSha256,release.version,release.installerSha256,
    release.manifestSha256,release.checksumsSha256,release.sourceCommit,release.tagObjectSha,String(release.bytes),sha(release.signedPayload),sha(release.signature)].join('\n'));
}
export function appReleaseNotes(release){
  const text=release.signedPayload.slice(release.signedPayload.indexOf('\n\n')+2);
  return text.split('\n').map(value=>value.trim()).filter(value=>value&&!/^(Source|Installer SHA-256|Manifest SHA-256|Checksums SHA-256|App Update Protocol|App Bootstrap Protocol):/.test(value))
    .slice(0,12).map(value=>value.replace(/^Notes:\s*/, '')).join('\n').slice(0,4000)||null;
}
const samePath=(a,b)=>resolve(a).toLowerCase()===resolve(b).toLowerCase();
export async function assertNoUpdateLinks(path){
  for(let current=resolve(path);;current=dirname(current)){
    try{const stat=await lstat(current);requireProof(!stat.isSymbolicLink());requireProof(samePath(await realpath(current),current));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(current)===current)return;
  }
}
export async function verifyCachedInstaller(path,release,signal){
  await assertNoUpdateLinks(path);const before=await lstat(path,{bigint:true});
  requireProof(before.isFile()&&before.nlink===1n&&before.size===BigInt(release.bytes));
  const hash=createHash('sha256');for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);
  const after=await lstat(path,{bigint:true});await assertNoUpdateLinks(path);
  requireProof(hash.digest('hex')===release.installerSha256&&['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>before[key]===after[key]));
  return path;
}
function asset(r,name,limit){
  requireProof(Array.isArray(r.assets));const found=r.assets.filter(value=>value?.name===name);requireProof(found.length===1);
  const item=found[0],url=web+'/releases/download/'+r.tag_name+'/'+name;
  requireProof(item.state==='uploaded'&&item.browser_download_url===url&&Number.isSafeInteger(item.size)&&item.size>0&&item.size<=limit&&
    typeof item.digest==='string'&&item.digest.startsWith('sha256:')&&digest.test(item.digest.slice(7)));
  return {url,bytes:item.size,hash:item.digest.slice(7)};
}
function httpFailure(response){
  const retry=Number(response.headers?.get('retry-after'));
  const reset=Number(response.headers?.get('x-ratelimit-reset'));
  const delay=Number.isFinite(retry)&&retry>0?retry*1000:response.headers?.get('x-ratelimit-remaining')==='0'&&reset>0?reset*1000-Date.now():null;
  return Object.assign(updateError(delay>0||response.status===429?'APP_UPDATE_RATE_LIMITED':'APP_UPDATE_NETWORK_FAILED'),{retryAfterMs:delay>0?Math.min(86400000,delay):undefined});
}
export function createAppReleaseClient({fetch:request=globalThis.fetch,verifySignature=localVerify,idleMs=60000}={}){
  const verify=release=>verifyAppReleaseProof(release,{verifySignature});
  async function consume(url,limit,signal,handle,{expectedBytes,download=false}={}){
    const controller=new AbortController();let timer;
    const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),idleMs);timer.unref?.();};reset();
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try{
      const response=await request(url,{signal:combined,redirect:download?'follow':'error',headers:{'User-Agent':'AI-Buddy-App-Update','Accept-Encoding':'identity',...(download?{}:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})}});
      if(response.status!==200)throw httpFailure(response);
      const length=response.headers?.get('content-length'),encoding=response.headers?.get('content-encoding');
      requireProof((!encoding||encoding==='identity')&&(!length||/^\d+$/.test(length)&&Number(length)<=limit&&(expectedBytes===undefined||Number(length)===expectedBytes)));
      if(response.url){const end=new URL(response.url);requireProof(end.protocol==='https:'&&!end.username&&!end.password&&
        (download?['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(end.hostname):response.url===url));}
      requireProof(response.body&&typeof response.body[Symbol.asyncIterator]==='function');
      let total=0;for await(const value of response.body){combined.throwIfAborted();reset();const bytes=Buffer.from(value);total+=bytes.length;requireProof(total<=limit);await handle(bytes,total);}
      combined.throwIfAborted();if(expectedBytes!==undefined)requireProof(total===expectedBytes);return total;
    }catch(error){if(signal?.aborted)throw updateError('APP_UPDATE_CANCELLED');if(controller.signal.aborted)throw updateError('APP_UPDATE_NETWORK_FAILED');if(error.code?.startsWith('APP_UPDATE_'))throw error;throw updateError('APP_UPDATE_NETWORK_FAILED');}
    finally{clearTimeout(timer);controller.abort();}
  }
  async function json(url,signal){const chunks=[];await consume(url,apiLimit,signal,bytes=>chunks.push(bytes));try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw invalid();}}
  async function check(currentVersion,{signal}={}){
    versionParts(currentVersion);const r=await json(api+'/releases/latest',signal);
    requireProof(r&&r.draft===false&&r.prerelease===false&&typeof r.tag_name==='string'&&r.tag_name.startsWith('v'));
    const version=r.tag_name.slice(1);versionParts(version);
    requireProof(r.html_url===web+'/releases/tag/'+r.tag_name&&commit.test(r.target_commitish??''));
    if(!newer(version,currentVersion))return null;
    const installerName=`AI-Buddy-Setup-${version}-win-x64.exe`,installer=asset(r,installerName,APP_INSTALLER_LIMIT),manifest=asset(r,`install-manifest-${version}.json`,16*1024*1024),checksums=asset(r,`SHA256SUMS-${version}.txt`,4*1024*1024);
    const reference=await json(api+'/git/ref/tags/'+r.tag_name,signal);
    requireProof(reference?.ref==='refs/tags/'+r.tag_name&&reference.object?.type==='tag'&&commit.test(reference.object.sha??''));
    const tag=await json(api+'/git/tags/'+reference.object.sha,signal),v=tag?.verification;
    requireProof(tag?.sha===reference.object.sha&&tag.tag===r.tag_name&&tag.object?.type==='commit'&&tag.object.sha===r.target_commitish&&
      v?.verified===true&&v.reason==='valid'&&typeof v.payload==='string'&&typeof v.signature==='string');
    const n=v.payload.indexOf('\n\n');requireProof(n>=0&&tag.message===v.payload.slice(n+2)+v.signature);
    return verify({version,tag:r.tag_name,releaseUrl:r.html_url,installerUrl:installer.url,installerName,bytes:installer.bytes,
      installerSha256:installer.hash,manifestSha256:manifest.hash,sourceCommit:r.target_commitish,tagObjectSha:tag.sha,
      signedPayload:v.payload,signature:v.signature,checksumsSha256:checksums.hash});
  }
  async function download(release,cache,{signal,onProgress=()=>{}}={}){
    release=verify(release);await assertNoUpdateLinks(cache);await mkdir(cache,{recursive:true});await assertNoUpdateLinks(cache);
    const final=join(cache,release.installerSha256+'-'+release.installerName);
    try{return await verifyCachedInstaller(final,release,signal);}catch(error){if(error.code!=='ENOENT'&&error.code!=='APP_UPDATE_VERIFICATION_FAILED')throw error;}
    const partial=final+'.'+randomBytes(16).toString('hex')+'.partial';let output;
    try{
      signal?.throwIfAborted();output=await open(partial,'wx');const hash=createHash('sha256');
      await consume(release.installerUrl,release.bytes,signal,async(bytes,total)=>{await output.writeFile(bytes);hash.update(bytes);onProgress({phase:'update-download',bytes:total,total:release.bytes});},{expectedBytes:release.bytes,download:true});
      requireProof(hash.digest('hex')===release.installerSha256);await output.sync();await output.close();output=null;
      signal?.throwIfAborted();await assertNoUpdateLinks(cache);await assertNoUpdateLinks(final);
      await rename(partial,final);return await verifyCachedInstaller(final,release,signal);
    }catch(error){
      if(signal?.aborted)throw updateError('APP_UPDATE_CANCELLED');
      if(['ENOSPC','EDQUOT'].includes(error.code))throw updateError('APP_UPDATE_DISK_SPACE');
      throw error;
    }finally{await output?.close();await unlink(partial).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  return {check,download,verify};
}
