import {open} from 'node:fs/promises';
import {basename,dirname} from 'node:path';
import {zstdDecompressSync} from 'node:zlib';

export const DSH_LINE_LIMIT=8*1024*1024;
export const DSH_FRAME_LIMIT=32*1024*1024;
const ENCODED_LIMIT=64*1024*1024;
export const isDshLog=path=>/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(basename(path));
export function selectDshLogs(paths){
 const chosen=new Map();
 for(const path of paths){const version=Number(basename(path).match(/\.v(\d+)\./)?.[1]||0),key=dirname(path).toLowerCase(),old=chosen.get(key);
  if(!old||version>old.version||(version===old.version&&path.endsWith('.zstd')&&!old.path.endsWith('.zstd')))chosen.set(key,{path,version});
 }
 return [...chosen.values()].map(row=>row.path);
}

// Find a complete frame from its block headers before allocating or decoding it.
// A partial tail is retried, without repeatedly decompressing an ever-growing prefix.
async function frameSize(handle,position,size){
 const read=async(at,length)=>{if(at+length>size)return null;const b=Buffer.alloc(length),r=await handle.read(b,0,length,at);return r.bytesRead===length?b:null;};
 const header=await read(position,5);if(!header)return null;
 const magic=header.readUInt32LE(0);
 if((magic&0xfffffff0)>>>0===0x184d2a50){const h=await read(position,8);if(!h)return null;const length=8+h.readUInt32LE(4);if(length>ENCODED_LIMIT)throw Error('Harness 压缩段超过大小限制');return position+length<=size?{length,skip:true}:null;}
 if(magic!==0xfd2fb528)throw Error('Harness 压缩日志损坏');
 const flag=header[4];if(flag&8)throw Error('Harness 压缩日志头无效');
 const single=!!(flag&32),contentFlag=flag>>6,dict=[0,1,2,4][flag&3],content=[single?1:0,2,4,8][contentFlag];
 let cursor=position+5+(single?0:1)+dict+content;
 if(cursor>size)return null;
 for(;;){const block=await read(cursor,3);if(!block)return null;const bits=block[0]|block[1]<<8|block[2]<<16,type=(bits>>1)&3;
  if(type===3)throw Error('Harness 压缩日志块无效');
  cursor+=3+(type===1?1:bits>>>3);
  if(cursor-position>ENCODED_LIMIT)throw Error('Harness 压缩段超过大小限制');
  if(cursor>size)return null;
  if(bits&1){if(flag&4)cursor+=4;return cursor<=size?{length:cursor-position,skip:false}:null;}
 }
}

function parseLine(bytes,index){
 if(bytes.length>DSH_LINE_LIMIT)throw Error('单条日志超过 8 MB');
 const text=bytes.toString('utf8').replace(/^\uFEFF/,'');if(!text.trim())return null;
 try{return {row:JSON.parse(text),index};}catch{throw Error('Harness 日志记录损坏');}
}

export async function* dshFileRecords(path,offset=0){
 const handle=await open(path,'r');let position=offset,pending=Buffer.alloc(0),lineIndex=0;
 try{const size=(await handle.stat()).size;
  if(!path.endsWith('.zstd')){
   let committed=offset;const chunk=Buffer.alloc(65536);
   while(position<size){const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,size-position),position);if(!bytesRead)break;position+=bytesRead;pending=Buffer.concat([pending,chunk.subarray(0,bytesRead)]);let at;
    while((at=pending.indexOf(10))>=0){const item=parseLine(pending.subarray(0,at),committed);pending=pending.subarray(at+1);committed+=at+1;if(item)yield item;yield {checkpoint:true,offset:committed};}
    if(pending.length>DSH_LINE_LIMIT)throw Error('单条日志超过 8 MB');
   }return;
  }
  while(position<size){
   if(!pending.length)yield {checkpoint:true,offset:position};
   const frame=await frameSize(handle,position,size);if(!frame)return;
   if(frame.skip){position+=frame.length;if(!pending.length)yield {checkpoint:true,offset:position};continue;}
   const encoded=Buffer.alloc(frame.length);let read=0;
   while(read<encoded.length){const r=await handle.read(encoded,read,encoded.length-read,position+read);if(!r.bytesRead)return;read+=r.bytesRead;}
   let decoded;try{const result=zstdDecompressSync(encoded,{info:true,maxOutputLength:DSH_FRAME_LIMIT});if(result.engine.bytesWritten!==frame.length)throw Error('Frame boundary mismatch');decoded=result.buffer;}catch(e){throw Error(e.code==='ERR_BUFFER_TOO_LARGE'?'Harness 压缩段解码超过 32 MB':'Harness 压缩日志损坏');}
   position+=frame.length;
   let start=0,at;
   while((at=decoded.indexOf(10,start))>=0){const bytes=pending.length?Buffer.concat([pending,decoded.subarray(start,at)]):decoded.subarray(start,at);const item=parseLine(bytes,lineIndex++);pending=Buffer.alloc(0);start=at+1;if(item)yield item;}
   pending=Buffer.concat([pending,decoded.subarray(start)]);if(pending.length>DSH_LINE_LIMIT)throw Error('单条日志超过 8 MB');
   if(!pending.length)yield {checkpoint:true,offset:position};
  }
 }finally{await handle.close();}
}

export async function inspectDshLog(path){
 const named=basename(path).match(/\.v(\d+)\./);if(named&&Number(named[1])!==4)throw Error('Harness 日志版本暂不支持');
 let header=null,cut=-1;
 for await(const item of dshFileRecords(path)){
  if(!item.row)continue;
  if(!header){header=item.row;if(header.type!=='session'||header.version!==4)throw Error('Harness 日志版本暂不支持');if(typeof header.id!=='string'||!header.id)throw Error('Harness 会话标识缺失');if(!header.isSeeded)break;}
  else if(item.row.type==='session/end-seed'&&item.row.data?.inherited===true)cut=item.row.seq;
 }
 if(!header)return null;
 if(header.isSeeded&&(!Number.isSafeInteger(cut)||cut<0))throw Error('Harness 分叉日志缺少继承边界');
 return {dshVersion:4,sessionId:header.id,workspace:typeof header.cwd==='string'?header.cwd:'',startTime:header.createdAt,kind:header.delegationDepth>0?'subagent':'main',dshInheritedCut:cut,dshSeeded:header.isSeeded===true};
}
