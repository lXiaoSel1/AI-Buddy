import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,open,lstat,statfs} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32,createInflateRaw} from 'node:zlib';
import {pluginRelativePath} from '../plugin-manifest.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {waitVoiceOperation} from './operation-wait.mjs';
import {FFMPEG_COMPONENT_DESCRIPTOR} from '../media-components/ffmpeg-descriptor.mjs';
import {extractSelectedPinnedZip} from '../media-components/pinned-zip.mjs';
import {downloadPinnedFile,verifiedFile} from '../network-download.mjs';

const LIMIT=2*1024**3,IDLE_MS=60000;
const fault=(code,message)=>Object.assign(Error(message),{code});
const invalid=message=>fault('VOICE_ASSET_MANIFEST',message);
const badZip=()=>fault('VOICE_ASSET_ARCHIVE','语音资源 ZIP 不符合受信任清单');
export function voiceAssetDownloadUrl(value){
  let url;try{url=new URL(value);}catch{throw fault('VOICE_ASSET_SOURCE','语音资源下载来源无效');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw fault('VOICE_ASSET_SOURCE','语音资源下载来源无效');
  return url;
}
function redirectAllowed(initial,target){
  return target.hostname===initial.hostname||initial.hostname==='huggingface.co'&&(target.hostname.endsWith('.hf.co')||target.hostname.endsWith('.huggingface.co'))||initial.hostname==='github.com'&&target.hostname.endsWith('.githubusercontent.com');
}
function pinnedFfmpegArchive(archive){
  const pin=FFMPEG_COMPONENT_DESCRIPTOR;
  return archive.format==='pinned-ffmpeg-zip'&&archive.url===pin.url&&archive.bytes===pin.bytes&&archive.sha256===pin.sha256&&archive.files.length===pin.files.length&&pin.files.every(file=>archive.files.some(row=>row.path==='ffmpeg/'+file.path&&row.bytes===file.bytes&&row.sha256===file.sha256));
}
function plain(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function keys(value,allowed){return plain(value)&&Object.keys(value).every(key=>allowed.includes(key));}
export function parseVoiceAssetDownloads(raw,{descriptor,descriptorHash}){
  let data;try{data=JSON.parse(raw);}catch{throw invalid('语音下载清单无法解析');}
  if(!keys(data,['schemaVersion','assetsSha256','archives','directFiles'])||data.schemaVersion!==1||data.assetsSha256!==descriptorHash||!Array.isArray(data.archives)||data.archives.length>65000||data.directFiles!==undefined&&!Array.isArray(data.directFiles))throw invalid('语音下载清单与组件不符');
  const missing=new Map(descriptor.files.filter(file=>!file.url).map(file=>[file.path,file])),covered=new Set(),ids=new Set(),directFiles=[];
  const cover=path=>{
    pluginRelativePath(path);const file=missing.get(path);
    if(!file||covered.has(path.toLowerCase()))throw invalid('语音下载清单包含重复或未声明文件');
    covered.add(path.toLowerCase());return file;
  };
  for(const row of data.directFiles??[]){
    if(!keys(row,['path','url']))throw invalid('语音直接下载条目无效');
    const file=cover(row.path);voiceAssetDownloadUrl(row.url);directFiles.push({...file,url:row.url});
  }
  const archives=data.archives.map(archive=>{
    if(!keys(archive,['id','format','url','bytes','sha256','files'])||typeof archive.id!=='string'||!/^[a-zA-Z0-9._-]{1,100}$/.test(archive.id)||ids.has(archive.id.toLowerCase())||!['zip','pinned-ffmpeg-zip'].includes(archive.format)||!Number.isSafeInteger(archive.bytes)||archive.bytes<22||archive.bytes>LIMIT||!/^[a-f0-9]{64}$/.test(archive.sha256)||!Array.isArray(archive.files)||!archive.files.length||archive.files.length>65000)throw invalid('语音资源归档清单无效');
    ids.add(archive.id.toLowerCase());voiceAssetDownloadUrl(archive.url);
    const files=archive.files.map(cover),unpackedBytes=files.reduce((sum,file)=>sum+file.bytes,0);
    if(unpackedBytes>LIMIT)throw invalid('语音资源归档展开体积超限');
    if(archive.format==='pinned-ffmpeg-zip'&&!pinnedFfmpegArchive({...archive,files}))throw invalid('FFmpeg 下载必须使用固定上游归档与文件');
    return {...archive,files,unpackedBytes};
  });
  if(covered.size!==missing.size)throw invalid('语音下载清单没有覆盖全部缺失来源');
  return {archives,directFiles,downloadBytes:archives.reduce((sum,row)=>sum+row.bytes,0)+directFiles.reduce((sum,row)=>sum+row.bytes,0)+descriptor.files.filter(file=>file.url).reduce((sum,row)=>sum+row.bytes,0)};
}

export async function voiceAssetDownloadStream(file,{signal,fetchImpl}){
  const initial=voiceAssetDownloadUrl(file.url),controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let timer,active,url=initial;
  const timeout=()=>{const error=fault('VOICE_ASSET_DOWNLOAD','语音资源下载连接超时，请重试');active?.destroy(error);controller.abort(error);};
  const reset=()=>{clearTimeout(timer);timer=setTimeout(timeout,IDLE_MS);timer.unref?.();};
  try{
    for(let attempt=0;attempt<=4;attempt++){
      combined.throwIfAborted();reset();
      const response=await waitVoiceOperation(()=>fetchImpl(url,{signal:combined,redirect:'manual',credentials:'omit'}),combined);
      if(response.ok&&response.body){
        const declared=response.headers.get('content-length');
        if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)!==file.bytes)){await response.body.cancel().catch(()=>{});throw fault('VOICE_ASSET_HASH','语音资源下载长度与清单不符');}
        const input=active=Readable.fromWeb(response.body,{signal:combined});
        // Keep the idle deadline alive until the consumer closes this stream.
        input.on('error',()=>{});input.on('data',reset);input.pause();const close=()=>{clearTimeout(timer);controller.abort();};input.once('close',close);input.once('end',()=>clearTimeout(timer));
        return input;
      }
      await response.body?.cancel().catch(()=>{});clearTimeout(timer);
      const location=response.headers.get('location');
      if(![301,302,303,307,308].includes(response.status)||!location)break;
      const target=voiceAssetDownloadUrl(new URL(location,url));
      if(!redirectAllowed(initial,target))throw fault('VOICE_ASSET_SOURCE','语音资源重定向来源无效');url=target;
    }
    throw fault('VOICE_ASSET_DOWNLOAD','语音资源下载失败，请检查连接后重试');
  }catch(error){clearTimeout(timer);controller.abort();throw error;}
}

export async function downloadVoiceAsset(file,target,{signal,fetchImpl=fetch,planDownload,onBytes=()=>{},official=false,retries=2,connectMs=30000,idleMs=60000}={}){
 const initial=voiceAssetDownloadUrl(file.url);let previous=0;
 const reused=await verifiedFile(target,file);
 try{await downloadPinnedFile(file,target,{signal,fetchImpl,planDownload,official,retries,connectMs,idleMs,maxRedirects:4,onProgress:value=>{const delta=Math.max(0,value.receivedBytes-previous);previous=value.receivedBytes;onBytes(delta);},validateUrl:(url,{initial:first})=>{const target=voiceAssetDownloadUrl(url);if(!first&&!redirectAllowed(initial,target))throw fault('VOICE_ASSET_SOURCE','语音资源重定向来源无效');return target;}});}
 catch(cause){if(signal?.aborted)throw signal.reason;if(cause.code==='NETWORK_MIRROR_MISMATCH')throw cause;if(/^NETWORK_DOWNLOAD_(HASH|SIZE|RANGE)$/.test(cause.code??''))throw fault('VOICE_ASSET_HASH','语音资源摘要与清单不符');if(cause.code==='NETWORK_TIMEOUT'||cause.code==='NETWORK_DOWNLOAD_REDIRECT')throw fault('VOICE_ASSET_DOWNLOAD','语音资源下载超时或重定向过多，请重试');throw cause;}
 if(reused)onBytes(file.bytes);return target;
}

export async function writeVoiceAsset(input,target,file,{signal,onBytes=()=>{},checksum}={}){
  await assertPluginTreeNoLinks(dirname(target));await mkdir(dirname(target),{recursive:true});signal?.throwIfAborted();
  const hash=createHash('sha256');let count=0,crc=0;
  const check=new Transform({transform(chunk,encoding,done){
    try{signal?.throwIfAborted();count+=chunk.length;if(count>file.bytes)throw fault('VOICE_ASSET_HASH','语音资源大于清单声明');hash.update(chunk);if(checksum!==undefined)crc=crc32(chunk,crc)>>>0;onBytes(chunk.length);done(null,chunk);}catch(error){done(error);}
  }});
  await pipeline(input,check,createWriteStream(target,{flags:'wx',mode:0o600}),{signal});
  if(count!==file.bytes||hash.digest('hex')!==file.sha256||checksum!==undefined&&crc!==checksum)throw fault('VOICE_ASSET_HASH','语音资源摘要与清单不符');
}

export async function checkVoiceAssetDisk(parent,total,archives=[]){
  const info=await statfs(parent,{bigint:true}),available=info.bavail*info.bsize;
  // Only one compressed archive is retained at a time, alongside the output.
  const packed=archives.reduce((maximum,row)=>Math.max(maximum,row.bytes),0);
  if(available<BigInt(total+packed+16*1024**2))throw fault('VOICE_ASSET_DISK','语音资源准备所需磁盘空间不足');
}

async function readRange(handle,start,bytes,limit,signal){
  signal?.throwIfAborted();if(!Number.isSafeInteger(start)||start<0||bytes<0||start+bytes>limit)throw badZip();
  const result=Buffer.alloc(bytes);let at=0;
  while(at<bytes){signal?.throwIfAborted();const {bytesRead}=await handle.read(result,at,bytes-at,start+at);if(!bytesRead)throw badZip();at+=bytesRead;}
  return result;
}
async function inspectZip(handle,size,files,signal){
  const end=size-22,footer=await readRange(handle,end,22,size,signal);
  if(footer.readUInt32LE()!==0x06054b50||footer.readUInt16LE(4)||footer.readUInt16LE(6)||footer.readUInt16LE(20))throw badZip();
  const count=footer.readUInt16LE(10),start=footer.readUInt32LE(16),directoryBytes=footer.readUInt32LE(12);
  if(count!==files.length||count!==footer.readUInt16LE(8)||!count||start+directoryBytes!==end)throw badZip();
  const expected=new Map(files.map(file=>[file.path,file])),entries=[],ranges=[];let at=start,total=0;
  for(let index=0;index<count;index++){
    signal?.throwIfAborted();const central=await readRange(handle,at,46,end,signal);
    if(central.readUInt32LE()!==0x02014b50)throw badZip();
    const needed=central.readUInt16LE(6),flags=central.readUInt16LE(8),method=central.readUInt16LE(10),checksum=central.readUInt32LE(16),packed=central.readUInt32LE(20),bytes=central.readUInt32LE(24),names=central.readUInt16LE(28),extra=central.readUInt16LE(30),comment=central.readUInt16LE(32),disk=central.readUInt16LE(34),attributes=central.readUInt32LE(38),localAt=central.readUInt32LE(42);
    if(needed>20||![0,0x800].includes(flags)||![0,8].includes(method)||extra||comment||disk||!names||method===0&&packed!==bytes)throw badZip();
    const rawName=await readRange(handle,at+46,names,end,signal);let path;try{path=new TextDecoder('utf-8',{fatal:true}).decode(rawName);}catch{throw badZip();}
    if(!flags&&rawName.some(byte=>byte>127))throw badZip();
    const file=expected.get(path),mode=attributes>>>16,type=mode&0xf000;
    if(!file||file.bytes!==bytes||type&&type!==0x8000||attributes&0x410||path.endsWith('/'))throw badZip();expected.delete(path);
    const local=await readRange(handle,localAt,30,start,signal),localNames=local.readUInt16LE(26),localExtra=local.readUInt16LE(28),begin=localAt+30+localNames,stop=begin+packed;
    if(local.readUInt32LE()!==0x04034b50||local.readUInt16LE(4)!==needed||local.readUInt16LE(6)!==flags||local.readUInt16LE(8)!==method||local.readUInt32LE(10)!==central.readUInt32LE(12)||local.readUInt32LE(14)!==checksum||local.readUInt32LE(18)!==packed||local.readUInt32LE(22)!==bytes||localExtra||localNames!==names||stop>start||!(await readRange(handle,localAt+30,localNames,start,signal)).equals(rawName))throw badZip();
    total+=bytes;if(total>LIMIT)throw badZip();entries.push({file,method,checksum,begin,stop,packed});ranges.push([localAt,stop]);at+=46+names;
  }
  ranges.sort((a,b)=>a[0]-b[0]);
  if(expected.size||at!==end||ranges.some(([begin],index)=>begin!==(index?ranges[index-1][1]:0))||ranges.at(-1)[1]!==start)throw badZip();
  return entries;
}
export async function extractVoiceAssetArchive(path,staging,archive,{signal,onBytes}={}){
  await assertPluginTreeNoLinks(path);const info=await lstat(path);if(!info.isFile()||info.nlink!==1||info.size!==archive.bytes)throw badZip();
  if(archive.format==='pinned-ffmpeg-zip'){
    if(!pinnedFfmpegArchive(archive))throw badZip();
    const result=await extractSelectedPinnedZip(path,join(staging,'ffmpeg'),FFMPEG_COMPONENT_DESCRIPTOR,{signal});
    onBytes?.(archive.files.reduce((total,file)=>total+file.bytes,0));return result;
  }
  const handle=await open(path,'r');
  try{
    const entries=await inspectZip(handle,info.size,archive.files,signal);
    for(const entry of entries){
      signal?.throwIfAborted();
      const input=entry.packed?createReadStream(path,{fd:handle.fd,start:entry.begin,end:entry.stop-1,autoClose:false,signal}):Readable.from([]),inflate=entry.method?createInflateRaw():null;
      if(inflate){
        const output=new Transform({transform(chunk,encoding,done){done(null,chunk);}});
        // pipeline owns both source and inflater, including error propagation.
        const producing=pipeline(input,inflate,output,{signal});producing.catch(()=>{});
        await Promise.all([producing,writeVoiceAsset(output,join(staging,entry.file.path),entry.file,{signal,onBytes,checksum:entry.checksum})]);
        if(inflate.bytesWritten!==entry.packed)throw badZip();
      }else await writeVoiceAsset(input,join(staging,entry.file.path),entry.file,{signal,onBytes,checksum:entry.checksum});
    }
  }finally{await handle.close();}
}
