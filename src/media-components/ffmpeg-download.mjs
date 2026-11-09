import {downloadPinnedFile} from '../network-download.mjs';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ffmpegError,checkpoint} from './ffmpeg-files.mjs';

export const FFMPEG_UPSTREAM_URL='https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-full_build.zip';
const cdn=new Set(['release-assets.githubusercontent.com','objects.githubusercontent.com']),redirects=new Set([301,302,303,307,308]);
export function ffmpegDownloadUrl(value,{initial=false}={}){let url;try{url=new URL(value);}catch{throw ffmpegError('DOWNLOAD_ORIGIN','Invalid FFmpeg download origin');}if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!(initial?url.href===FFMPEG_UPSTREAM_URL:cdn.has(url.hostname)))throw ffmpegError('DOWNLOAD_ORIGIN','Untrusted FFmpeg download origin');return url;}
export async function downloadPinnedFfmpeg(descriptor,target,{fetchImpl=fetch,planDownload,signal,check,onProgress=()=>{},timeoutMs=30000,idleMs=65000,maxRedirects=3,retries=2,official=false}={}){
 try{await downloadPinnedFile(descriptor,target,{fetchImpl,planDownload,official,signal,check,onProgress,retries,maxRedirects,connectMs:Math.min(timeoutMs,30000),idleMs,validateUrl:ffmpegDownloadUrl});return {bytes:descriptor.bytes,sha256:descriptor.sha256};}
 catch(cause){if(signal?.aborted)throw ffmpegError('CANCELLED','FFmpeg preparation cancelled');if(cause.code==='NETWORK_MIRROR_MISMATCH')throw cause;if(cause.code==='NETWORK_TIMEOUT')throw ffmpegError('DOWNLOAD_TIMEOUT','FFmpeg download stalled');if(cause.code==='NETWORK_DOWNLOAD_REDIRECT')throw ffmpegError('DOWNLOAD_REDIRECTS','Too many FFmpeg redirects');if(cause.code==='ENOSPC')throw ffmpegError('DISK_FULL','Disk became full during FFmpeg download');if(cause.code?.startsWith('FFMPEG_'))throw cause;throw ffmpegError('DOWNLOAD','FFmpeg download failed');}
}
