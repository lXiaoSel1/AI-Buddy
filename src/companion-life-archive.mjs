import {createHash,randomUUID} from 'node:crypto';
import * as zlib from 'node:zlib';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {mkdirSync,readFileSync,realpathSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';

const LIMITS=Object.freeze({MAX_TOTAL:512*1024*1024,MAX_IMAGE:32*1024*1024,MAX_TEXT:64*1024*1024});
const {MAX_TOTAL,MAX_IMAGE,MAX_TEXT}=LIMITS;
export const archiveHash=bytes=>createHash('sha256').update(bytes).digest('hex');

// ZIP building, structural/hash verification and verified writing. It uses only
// its arguments and globals, so the same source also runs in a worker thread
// (image decoding stays in the main process, where nativeImage lives).
function archiveCore({zlib,crypto,fs},{MAX_TOTAL,MAX_IMAGE,MAX_TEXT}){
 const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 const crc=bytes=>zlib.crc32(bytes)>>>0;
 const asBuffer=value=>Buffer.isBuffer(value)?value:Buffer.from(value.buffer,value.byteOffset,value.byteLength);
 const safePath=value=>typeof value==='string'&&/^(?:text\/state\.json|images\/[a-f0-9]{64}\.(?:png|jpeg|webp|avif)|manifest\.json)$/.test(value);
 function zip(files){const locals=[],directory=[];let offset=0;for(const [name,raw]of files){const key=Buffer.from(name),method=name.endsWith('.json')?8:0,body=method?zlib.deflateRawSync(raw):raw,checksum=crc(raw),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(method,8);header.writeUInt32LE(checksum,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(key.length,26);locals.push(header,key,body);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(method,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(key.length,28);central.writeUInt32LE(offset,42);directory.push(central,key);offset+=header.length+key.length+body.length;}const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,central,end]);}
 function unzip(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>MAX_TOTAL)throw Error('人生备份包大小无效（单包安全上限 512 MiB）');
  const end=bytes.length-22;if(bytes.readUInt32LE(end)!==0x06054b50||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+20))throw Error('ZIP 格式不支持或不完整');
  const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);if(count!==bytes.readUInt16LE(end+8)||offset+size!==end)throw Error('ZIP 索引无效');
  const files=new Map(),ranges=[];let pos=offset,total=0;
  for(let n=0;n<count;n++){
   if(pos+46>end||bytes.readUInt32LE(pos)!==0x02014b50)throw Error('ZIP 索引损坏');
   const flags=bytes.readUInt16LE(pos+8),method=bytes.readUInt16LE(pos+10),checksum=bytes.readUInt32LE(pos+16),packed=bytes.readUInt32LE(pos+20),length=bytes.readUInt32LE(pos+24),names=bytes.readUInt16LE(pos+28),extra=bytes.readUInt16LE(pos+30),comment=bytes.readUInt16LE(pos+32),local=bytes.readUInt32LE(pos+42),attributes=bytes.readUInt32LE(pos+38),name=bytes.subarray(pos+46,pos+46+names).toString('utf8');
   if(!safePath(name)||files.has(name)||flags!==0x800||![0,8].includes(method)||extra||comment||(attributes>>>16&0xf000)===0xa000||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50)throw Error('ZIP 含不允许的路径、重复文件、链接或压缩方式');
   const localNames=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),begin=local+30+localNames+localExtra,endBody=begin+packed;
   if(localExtra||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||bytes.readUInt32LE(local+14)!==checksum||bytes.readUInt32LE(local+18)!==packed||bytes.readUInt32LE(local+22)!==length||bytes.subarray(local+30,local+30+localNames).toString('utf8')!==name||endBody>offset||ranges.some(([a,b])=>local<b&&endBody>a))throw Error('ZIP 本地条目与索引不一致');
   if(length>(name.startsWith('images/')?MAX_IMAGE:MAX_TEXT)||(total+=length)>MAX_TOTAL)throw Error('ZIP 解压内容超过安全大小');
   const compressed=bytes.subarray(begin,endBody),raw=method===0?Buffer.from(compressed):zlib.inflateRawSync(compressed,{maxOutputLength:Math.max(1,length)});if(raw.length!==length||crc(raw)!==checksum)throw Error('ZIP 内容校验失败');files.set(name,raw);ranges.push([local,endBody]);pos+=46+names;
  }
  if(pos!==offset+size||ranges.sort((a,b)=>a[0]-b[0]).some((row,i)=>row[0]!== (i?ranges[i-1][1]:0))||ranges.at(-1)?.[1]!==offset)throw Error('ZIP 含未声明的数据');return files;
 }
 function json(bytes){return JSON.parse(bytes.toString('utf8'),(key,value)=>{if(['__proto__','prototype','constructor'].includes(key))throw Error('备份包含无效对象键');return value;});}
 // Structure, manifest and per-file hashes; image content is checked by the caller.
 function verify(bytes){
  const files=unzip(bytes),manifest=files.get('manifest.json')&&json(files.get('manifest.json'));if(manifest?.format!=='ai-buddy-life'||manifest.version!==1||!Array.isArray(manifest.files)||!Array.isArray(manifest.dependencies))throw Error('不支持的人生存档格式');
  const declared=new Set();let total=0;for(const row of manifest.files){if(!safePath(row.path)||row.path==='manifest.json'||declared.has(row.path)||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/.test(row.sha256??''))throw Error('人生文件清单无效');declared.add(row.path);const raw=files.get(row.path);if(!raw||raw.length!==row.bytes||hash(raw)!==row.sha256)throw Error('人生存档文件哈希不匹配');total+=raw.length;}
  if(files.size!==declared.size+1||!declared.has('text/state.json')||total>MAX_TOTAL)throw Error('人生存档包含未声明的文件或缺少文字');
  return {files,manifest,declared};
 }
 // Prepared entries -> manifest -> ZIP; the hashes computed here are reused by the manifest.
 function build(entries,meta){
  const files=new Map(entries.map(([name,raw])=>[name,asBuffer(raw)]));
  if([...files.values()].reduce((sum,bytes)=>sum+bytes.length,0)>MAX_TOTAL-1024*1024)throw Error('人生存档内容超过安全大小 512 MiB');
  const manifest={format:'ai-buddy-life',version:1,...meta,files:[...files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}))};
  files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));
  const bytes=zip(files);verify(bytes);return bytes;
 }
 function writeVerified(bytes,target,temp){
  fs.writeFileSync(temp,bytes,{flag:'wx'});const fd=fs.openSync(temp,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const digest=hash(bytes);if(hash(fs.readFileSync(temp))!==digest)throw Error('存档写入校验失败');fs.renameSync(temp,target);return {bytes:bytes.length,sha256:digest};
 }
 function run(task){const bytes=task.entries?build(task.entries,task.meta):asBuffer(task.bytes);if(!task.entries)verify(bytes);return writeVerified(bytes,task.target,task.temp);}
 return {zip,unzip,json,verify,build,writeVerified,run,safePath};
}
const core=archiveCore({zlib,crypto,fs},LIMITS);
const WORKER_SOURCE=`const {parentPort,workerData}=require('node:worker_threads');const core=(${archiveCore.toString()})({zlib:require('node:zlib'),crypto:require('node:crypto'),fs:require('node:fs')},workerData);parentPort.on('message',task=>{try{parentPort.postMessage({ok:true,via:'worker',...core.run(task)});}catch(error){parentPort.postMessage({ok:false,message:error.message});}});`;
// Packing, verification and the fsync'd write run off the main thread; if a
// worker cannot start or dies, the same code runs inline.
export function runArchiveTask(task,{worker:useWorker=true}={}){
 return new Promise((resolveTask,rejectTask)=>{
  const inline=()=>{try{rmSync(task.temp,{force:true});resolveTask({via:'inline',...core.run({...task,temp:task.temp+'.inline'})});}catch(error){rejectTask(error);}};
  if(!useWorker)return inline();
  let worker;try{worker=new Worker(WORKER_SOURCE,{eval:true,workerData:LIMITS});}catch{return inline();}
  let settled=false;const fallback=()=>{if(settled)return;settled=true;void worker.terminate();inline();};
  worker.once('message',result=>{settled=true;void worker.terminate();if(result.ok)resolveTask(result);else rejectTask(Error(result.message));});
  worker.once('error',fallback);worker.once('exit',fallback);
  worker.postMessage(task);
 });
}

const assetKey=key=>['assetRef','thumbnailRef'].includes(key);
// Credential fields never enter a portable archive. "key" is a credential only on
// connection-like objects; elsewhere (a group photo's scene template, for example) it is data.
const secrets=/^(?:apiKey|keyCiphertext|cookie|authorization|accessToken|refreshToken|themeConnection)$/i;
const connectionLike=value=>['baseUrl','protocol','keyCiphertext','apiKey'].some(field=>Object.hasOwn(value,field));
// Fields that hold pictures, directly or as a {mode,value} wrapper (card.fields.sprite.value).
// Other strings are text, even when they happen to start with "data:image/".
const IMAGE_FIELDS=new Set(['avatar','sprite','background','backgroundOverride','backgroundImage','customSprite','dataUrl','image','thumbnail','portrait','cover','icon']);
const imageField=(key,parentKey)=>IMAGE_FIELDS.has(key)||key==='value'&&IMAGE_FIELDS.has(parentKey);
const SUPPORTED=['png','jpeg','webp','avif'],CODEC_READS=['png','jpeg','jpg','webp'];
const dataImage=/^data:image\/([a-z0-9.+-]+)((?:;[a-z0-9-]+=[^;,]*)*);base64,([a-zA-Z0-9+/=\s]+)$/i;
const sniff=bytes=>bytes[0]===0xff&&bytes[1]===0xd8?'jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':bytes.toString('ascii',4,12)==='ftypavif'?'avif':'png';

export function createLifeArchiveRepository({dataRoot,imageCodec=null,imageConverter=null,worker=true}){
 const directory=join(dataRoot,'galgame','life-archives');mkdirSync(directory,{recursive:true});
 function checkImage(bytes){if(!imageCodec)throw Error('图片解码器尚未就绪，未创建不完整备份');const decoded=imageCodec(bytes);if(decoded===false||decoded&&typeof decoded.isEmpty==='function'&&decoded.isEmpty())throw Error('存档图片无法解码');}
 function image(bytes,mime,files){if(bytes.length>MAX_IMAGE)throw Error('存档图片超过 32 MiB');checkImage(bytes);const extension=mime==='jpg'?'jpeg':mime;if(!SUPPORTED.includes(extension))throw Error('存档图片格式不支持');const path='images/'+archiveHash(bytes)+'.'+extension;files.set(path,bytes);return {$image:path};}
 // GIF (first frame), SVG and other formats the codec cannot read are rasterized to
 // PNG before packing; the manifest lists which fields were converted.
 async function convertImages(snapshot){
  const pending=new Map(),walk=(value,key='',parentKey='')=>{
   if(typeof value==='string'){const mime=imageField(key,parentKey)&&/^data:image\/([^;,]+)/i.exec(value)?.[1].toLowerCase();if(mime&&!CODEC_READS.includes(mime))pending.set(value,{mime,field:key==='value'?parentKey:key});}
   else if(Array.isArray(value))for(const item of value)walk(item,'',key);
   else if(value&&typeof value==='object')for(const [field,item]of Object.entries(value))walk(item,field,key);
  };
  if(imageConverter)walk(snapshot);
  const converted=new Map();
  for(const [dataUrl,{mime,field}]of pending){let png=null;try{png=await imageConverter(dataUrl);}catch{}if(png?.length)converted.set(dataUrl,{png:Buffer.from(png),note:{field,from:mime,to:'png'}});}
  return converted;
 }
 function separate(value,files,ctx,key='',parentKey='',parent=null){
  if(typeof value==='string'){
   const isImage=imageField(key,parentKey);
   if(isImage&&ctx.converted.has(value)){const {png,note}=ctx.converted.get(value);if(!ctx.notes.some(row=>row.field===note.field&&row.from===note.from))ctx.notes.push(note);return image(png,'png',files);}
   const embedded=dataImage.exec(value),mime=embedded?.[1].toLowerCase();
   if(isImage&&/^data:image\//i.test(value)){
    if(!embedded||!SUPPORTED.includes(mime==='jpg'?'jpeg':mime))throw Error('存档图片格式不支持：'+(mime??/^data:image\/([^;,]+)/i.exec(value)?.[1]??'未知')+'（'+(key==='value'?parentKey:key)+'），请换成 PNG、JPEG 或 WebP');
    const bytes=Buffer.from(embedded[3],'base64');if(!bytes.length)throw Error('存档图片为空');return image(bytes,mime,files);
   }
   // Pictures in other fields are packed when they decode; anything else stays text.
   if(embedded&&SUPPORTED.includes(mime)&&!embedded[2]){const bytes=Buffer.from(embedded[3],'base64');if(bytes.length)try{return image(bytes,mime,files);}catch{}}
   if(assetKey(key)&&value){
    const root=realpathSync(dataRoot),normalized=value.replaceAll('\\','/');
    if(isAbsolute(value)||!normalized.startsWith('cg-assets/'))throw Error('存档图片路径越界');
    if(!existsSync(resolve(root,value))){ctx.missing.push({cgId:parent?.id??null,label:parent?.label??null,at:parent?.at??null,level:parent?.level??null,kind:parent?.kind??null,groupId:parent?.groupId??null,ref:normalized});return value;}
    const file=realpathSync(resolve(root,value)),rel=relative(root,file);if(rel.startsWith('..')||isAbsolute(rel))throw Error('存档图片路径越界');
    const bytes=readFileSync(file);return image(bytes,sniff(bytes),files);
   }
   return value;
  }
  if(Array.isArray(value))return value.map(item=>separate(item,files,ctx,'',key,parent));
  if(value&&typeof value==='object'){const out={};for(const [field,item]of Object.entries(value)){if(secrets.test(field)||field==='key'&&connectionLike(value))continue;out[field]=separate(item,files,ctx,field,key,value);}return out;}return value;
 }
 // Snapshot -> archive entries. Images are decoded once, here. CG records whose
 // files are gone are collected and reported together so the user can clean them up.
 function entriesFor(snapshot,converted=new Map()){
  const files=new Map(),ctx={missing:[],converted,notes:[]},portable=separate(snapshot,files,ctx);
  if(ctx.missing.length){const byId=new Map();for(const row of ctx.missing)if(!byId.has(row.cgId??row.ref))byId.set(row.cgId??row.ref,row);const missing=[...byId.values()];throw Object.assign(Error(`有 ${missing.length} 张 CG 的图片文件已丢失，人生存档没有保存。可以先清理这些缺失记录，再重新保存`),{code:'LIFE_ARCHIVE_MISSING_CG',missing});}
  const state=Buffer.from(JSON.stringify(portable));if(state.length>MAX_TEXT)throw Error('单个人生文本超过安全大小 64 MiB');files.set('text/state.json',state);
  return {entries:[...files],meta:{createdAt:Date.now(),characterId:snapshot.characterId,lifeId:snapshot.life.id,dependencies:snapshot.dependencies??[],...(ctx.notes.length?{convertedImages:ctx.notes}:{})}};
 }
 function prepare(snapshot){const {entries,meta}=entriesFor(snapshot);return core.build(entries,meta);}
 function decode(bytes){
  const {files,manifest,declared}=core.verify(bytes);
  for(const path of declared)if(path.startsWith('images/'))checkImage(files.get(path));
  const hydrate=(value,key='',parentKey='')=>{if(typeof value==='string'&&(imageField(key,parentKey)&&/^data:image\//i.test(value)||assetKey(key)&&value))throw Error('人生存档图片必须使用已校验的包内引用');if(Array.isArray(value))return value.map(item=>hydrate(item,'',key));if(value&&typeof value==='object'){if(Object.hasOwn(value,'$image')){if(Object.keys(value).length!==1||!declared.has(value.$image)||!value.$image.startsWith('images/'))throw Error('人生存档图片引用缺失');const data='data:image/'+value.$image.split('.').at(-1)+';base64,'+files.get(value.$image).toString('base64');return assetKey(key)?{$assetImage:data}:data;}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,hydrate(v,k,key)]));}return value;};
  const snapshot=hydrate(core.json(files.get('text/state.json')));if(snapshot?.format!=='ai-buddy-life-state'||snapshot.version!==1||snapshot.characterId!==manifest.characterId||!/^[a-zA-Z0-9_-]{1,100}$/.test(snapshot.characterId)||['__proto__','prototype','constructor'].includes(snapshot.characterId)||snapshot.life?.id!==manifest.lifeId||!snapshot.card||!snapshot.relationships||!Array.isArray(snapshot.conversations))throw Error('人生状态内容不完整');return {manifest,snapshot};
 }
 function file(id){if(!/^archive-[a-f0-9-]{36}$/.test(id))throw Error('人生存档 ID 无效');const target=join(directory,id+'.zip');if(existsSync(target)&&relative(realpathSync(directory),realpathSync(target)).startsWith('..'))throw Error('人生存档路径越界');return target;}
 async function write(task){const id='archive-'+randomUUID(),target=file(id),result=await runArchiveTask({...task,target,temp:target+'.partial'},{worker});return {id,bytes:result.bytes,sha256:result.sha256,fileName:id+'.zip'};}
 return {prepare,decode,has:id=>{try{return existsSync(file(id));}catch{return false;}},
  async save(snapshot){return write(entriesFor(snapshot,await convertImages(snapshot)));},
  // An import is fully decoded here (images included) before the worker writes it.
  async import(bytes){decode(bytes);return write({bytes});},
  read(id,expectedHash){const bytes=readFileSync(file(id));if(expectedHash&&archiveHash(bytes)!==expectedHash)throw Error('本地人生存档哈希不匹配');return {...decode(bytes),bytes};}};
}
