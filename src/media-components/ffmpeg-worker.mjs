import {parentPort,workerData} from 'node:worker_threads';
import {createFfmpegEngine} from './ffmpeg-engine.mjs';
import {FFMPEG_COMPONENT_DESCRIPTOR} from './ffmpeg-descriptor.mjs';
import {ffmpegError} from './ffmpeg-files.mjs';

const controller=new AbortController(),cancelled=new Int32Array(workerData.abortBuffer),deadline=Date.now()+40*60000;let lastAt=0,lastPhase='';
const check=()=>{if(Atomics.load(cancelled,0)!==0)throw ffmpegError('CANCELLED','FFmpeg preparation cancelled');if(Date.now()>=deadline)throw ffmpegError('TIMEOUT','FFmpeg preparation timed out');};
parentPort.on('message',row=>{if(row?.type==='cancel')controller.abort(ffmpegError('CANCELLED','FFmpeg preparation cancelled'));});
const onProgress=value=>{const now=Date.now();if(value.phase!==lastPhase||now-lastAt>=150||value.receivedBytes===value.totalBytes){lastAt=now;lastPhase=value.phase;parentPort.postMessage({type:'progress',value});}};
try{const engine=createFfmpegEngine({directory:workerData.directory,bundledTools:workerData.bundledTools,bundledNotices:workerData.bundledNotices,signal:controller.signal,check,onProgress});let value;if(workerData.kind==='verify')value=await engine.verify();else if(workerData.kind==='prepare'){if(process.platform!==FFMPEG_COMPONENT_DESCRIPTOR.platform||process.arch!==FFMPEG_COMPONENT_DESCRIPTOR.arch)throw ffmpegError('UNSUPPORTED','This FFmpeg component requires Windows x64');value=await engine.prepare({repair:workerData.repair===true,operationId:workerData.operationId});}else throw ffmpegError('INVALID','Invalid FFmpeg worker task');parentPort.postMessage({type:'result',value});}
catch(cause){const code=controller.signal.aborted||Atomics.load(cancelled,0)!==0?'FFMPEG_COMPONENT_CANCELLED':cause?.code?.startsWith('FFMPEG_COMPONENT_')?cause.code:cause?.code==='ENOSPC'?'FFMPEG_COMPONENT_DISK_FULL':'FFMPEG_COMPONENT_PREPARATION_FAILED';parentPort.postMessage({type:'error',error:{code,message:cause?.code?.startsWith('FFMPEG_COMPONENT_')?cause.message:'FFmpeg component preparation failed'}});}
finally{parentPort.close();}
