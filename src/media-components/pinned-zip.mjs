import {open,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createInflateRaw,crc32} from 'node:zlib';
import {ffmpegError,checkpoint,zipPath,ownedChild,noLinks,hashFile,fileStamp} from './ffmpeg-files.mjs';

const utf8=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw ffmpegError('ZIP_PATH','Invalid archive filename encoding');}};
async function readAt(file,offset,length){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>1024*1024)throw ffmpegError('ZIP_LIMIT','Invalid ZIP read bounds');const bytes=Buffer.alloc(length),read=await file.read(bytes,0,length,offset);if(read.bytesRead!==length)throw ffmpegError('ZIP_TRUNCATED','Truncated FFmpeg archive');return bytes;}
const matchEntry=(entry,pin)=>['name','bytes','compressedBytes','method','crc32','externalAttributes','flags','headerOffset'].every(key=>entry[key]===pin?.[key]);
// This is a selective extractor for one pinned, non-ZIP64 archive identity. It
// validates every central/local row and range, including unselected executables.
export async function extractSelectedPinnedZip(archive,directory,descriptor,{signal,check,onProgress=()=>{}}={}){
  const proof=await hashFile(archive,{bytes:descriptor.bytes,sha256:descriptor.sha256,signal,check}),file=await open(archive,'r');
  try{
    if(fileStamp(await file.stat({bigint:true}))!==proof.stamp)throw ffmpegError('CHANGED','FFmpeg archive changed');const footer=await readAt(file,descriptor.bytes-22,22);if(footer.readUInt32LE(0)!==0x06054b50||footer.readUInt16LE(4)||footer.readUInt16LE(6)||footer.readUInt16LE(20))throw ffmpegError('ZIP_FORMAT','Unsupported FFmpeg ZIP footer');
    const count=footer.readUInt16LE(10),size=footer.readUInt32LE(12),offset=footer.readUInt32LE(16),limits=descriptor.limits;if(!count||count!==footer.readUInt16LE(8)||count!==descriptor.inventory.length||count>limits.entries||size>limits.centralBytes||offset+size!==descriptor.bytes-22||offset!==descriptor.zip.centralOffset||size!==descriptor.zip.centralSize||offset===0xffffffff||size===0xffffffff)throw ffmpegError('ZIP_LIMIT','FFmpeg ZIP directory differs');
    const central=await readAt(file,offset,size),entries=[],names=new Map(),ranges=[];let at=0,expanded=0;
    for(let n=0;n<count;n++){
      checkpoint(signal,check);if(at+46>central.length||central.readUInt32LE(at)!==0x02014b50)throw ffmpegError('ZIP_FORMAT','Invalid FFmpeg ZIP directory');
      const flags=central.readUInt16LE(at+8),method=central.readUInt16LE(at+10),crc=central.readUInt32LE(at+16),packed=central.readUInt32LE(at+20),bytes=central.readUInt32LE(at+24),nameBytes=central.readUInt16LE(at+28),extra=central.readUInt16LE(at+30),comment=central.readUInt16LE(at+32),disk=central.readUInt16LE(at+34),attributes=central.readUInt32LE(at+38),local=central.readUInt32LE(at+42);
      if(central.readUInt16LE(at+6)>20||!nameBytes||nameBytes>limits.nameBytes||at+46+nameBytes+extra+comment>central.length||flags!==0||![0,8].includes(method)||extra!==descriptor.zip.centralExtraBytes||![0,36].includes(extra)||comment||disk||[packed,bytes,local].includes(0xffffffff)||bytes>limits.memberBytes||(expanded+=bytes)>limits.totalBytes)throw ffmpegError('ZIP_LIMIT','Unsupported or oversized FFmpeg ZIP member');
      if(extra===36&&!central.subarray(at+46+nameBytes,at+46+nameBytes+12).equals(Buffer.from('0a0020000000000001001800','hex')))throw ffmpegError('ZIP_FORMAT','Unsupported ZIP extra field');const rawName=central.subarray(at+46,at+46+nameBytes);if(rawName.some(byte=>byte>127))throw ffmpegError('ZIP_PATH','Unsupported ZIP filename');const name=utf8(rawName),directoryRow=name.endsWith('/'),path=zipPath(name,{directory:directoryRow}),key=path.toLowerCase(),mode=attributes>>>16&0xf000;
      if(names.has(key)||attributes&0x400||mode&&mode!==(directoryRow?0x4000:0x8000)||Boolean(attributes&16)!==directoryRow||directoryRow&&(bytes||packed||crc||method))throw ffmpegError('ZIP_TYPE','Duplicate, linked or special FFmpeg ZIP member');names.set(key,directoryRow);
      const row={name,bytes,compressedBytes:packed,method,crc32:crc.toString(16).padStart(8,'0'),externalAttributes:attributes,flags,headerOffset:local};if(!matchEntry(row,descriptor.inventory[n]))throw ffmpegError('ZIP_INVENTORY','FFmpeg ZIP inventory differs');
      const header=await readAt(file,local,30);if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(4)>20||header.readUInt16LE(6)!==flags||header.readUInt16LE(8)!==method||header.readUInt32LE(14)!==crc||header.readUInt32LE(18)!==packed||header.readUInt32LE(22)!==bytes||header.readUInt16LE(26)!==nameBytes||header.readUInt16LE(28))throw ffmpegError('ZIP_HEADER','FFmpeg ZIP local header differs');const localName=await readAt(file,local+30,nameBytes);if(!localName.equals(rawName))throw ffmpegError('ZIP_HEADER','FFmpeg ZIP local filename differs');
      const begin=local+30+nameBytes,end=begin+packed;if(end>offset)throw ffmpegError('ZIP_RANGE','FFmpeg ZIP member overlaps its directory');ranges.push([local,end]);entries.push({...row,begin,end,directory:directoryRow});at+=46+nameBytes+extra;
    }
    for(const name of names.keys()){const parts=name.split('/');for(let n=1;n<parts.length;n++)if(names.get(parts.slice(0,n).join('/'))===false)throw ffmpegError('ZIP_PATH','FFmpeg ZIP file/directory conflict');}
    ranges.sort((a,b)=>a[0]-b[0]);if(expanded!==descriptor.zip.expandedBytes||at!==size||ranges.some(([begin],n)=>begin!==(n?ranges[n-1][1]:0))||ranges.at(-1)?.[1]!==offset)throw ffmpegError('ZIP_RANGE','FFmpeg ZIP has overlapping or undeclared data');
    await noLinks(directory);await mkdir(directory,{recursive:false});const selected=new Set();
    for(const pin of descriptor.files){checkpoint(signal,check);if(selected.has(pin.path.toLowerCase()))throw ffmpegError('ZIP_PATH','Duplicate selected FFmpeg output');selected.add(pin.path.toLowerCase());const row=entries.find(entry=>entry.name===pin.zipPath);if(!row||row.directory||row.bytes!==pin.bytes)throw ffmpegError('ZIP_INVENTORY','Selected FFmpeg member is missing');const target=ownedChild(directory,pin.path);await noLinks(target);await mkdir(dirname(target),{recursive:true});let count=0,crc=0;const hash=createHash('sha256');onProgress({phase:'extracting',file:pin.path});
      const checking=new Transform({transform(chunk,_encoding,done){try{checkpoint(signal,check);count+=chunk.length;if(count>pin.bytes)throw ffmpegError('ZIP_LIMIT','FFmpeg output exceeds selected size');hash.update(chunk);crc=crc32(chunk,crc)>>>0;done(null,chunk);}catch(cause){done(cause);}}});
      await pipeline(file.createReadStream({start:row.begin,end:row.end-1,autoClose:false}),...(row.method===8?[createInflateRaw()]:[]),checking,createWriteStream(target,{flags:'wx',mode:0o600}),{signal});if(count!==pin.bytes||hash.digest('hex')!==pin.sha256||crc.toString(16).padStart(8,'0')!==row.crc32)throw ffmpegError('ZIP_HASH','Selected FFmpeg member digest differs');
    }
    if(fileStamp(await file.stat({bigint:true}))!==proof.stamp)throw ffmpegError('CHANGED','FFmpeg archive changed during extraction');checkpoint(signal,check);return {files:descriptor.files.length,archiveSha256:descriptor.sha256};
  }finally{await file.close();}
}
