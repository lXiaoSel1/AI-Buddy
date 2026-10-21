import {createHash,randomUUID} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {mkdirSync,readFileSync,writeFileSync,renameSync,realpathSync,existsSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';

const MAX_TOTAL=512*1024*1024,MAX_IMAGE=32*1024*1024,MAX_TEXT=64*1024*1024;
export const archiveHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=bytes=>{let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return(value^0xffffffff)>>>0;};
const safePath=value=>typeof value==='string'&&/^(?:text\/state\.json|images\/[a-f0-9]{64}\.(?:png|jpeg|webp|avif)|manifest\.json)$/.test(value);
function zip(files){const locals=[],directory=[];let offset=0;for(const [name,raw]of files){const key=Buffer.from(name),method=name.endsWith('.json')?8:0,body=method?deflateRawSync(raw):raw,checksum=crc(raw),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(method,8);header.writeUInt32LE(checksum,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(key.length,26);locals.push(header,key,body);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(method,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(key.length,28);central.writeUInt32LE(offset,42);directory.push(central,key);offset+=header.length+key.length+body.length;}const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,central,end]);}
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
  const compressed=bytes.subarray(begin,endBody),raw=method===0?Buffer.from(compressed):inflateRawSync(compressed,{maxOutputLength:Math.max(1,length)});if(raw.length!==length||crc(raw)!==checksum)throw Error('ZIP 内容校验失败');files.set(name,raw);ranges.push([local,endBody]);pos+=46+names;
 }
 if(pos!==offset+size||ranges.sort((a,b)=>a[0]-b[0]).some((row,i)=>row[0]!== (i?ranges[i-1][1]:0))||ranges.at(-1)?.[1]!==offset)throw Error('ZIP 含未声明的数据');return files;
}
function json(bytes){return JSON.parse(bytes.toString('utf8'),(key,value)=>{if(['__proto__','prototype','constructor'].includes(key))throw Error('备份包含无效对象键');return value;});}
const assetKey=key=>['assetRef','thumbnailRef'].includes(key);
const secrets=/^(?:key|apiKey|keyCiphertext|cookie|authorization|accessToken|refreshToken|themeConnection)$/i;
export function createLifeArchiveRepository({dataRoot,imageCodec=null}){
 const directory=join(dataRoot,'galgame','life-archives');mkdirSync(directory,{recursive:true});
 function checkImage(bytes){if(!imageCodec)throw Error('图片解码器尚未就绪，未创建不完整备份');const decoded=imageCodec(bytes);if(decoded===false||decoded&&typeof decoded.isEmpty==='function'&&decoded.isEmpty())throw Error('存档图片无法解码');}
 function image(bytes,mime,files){if(bytes.length>MAX_IMAGE)throw Error('存档图片超过 32 MiB');checkImage(bytes);const extension=mime==='jpg'?'jpeg':mime;if(!['png','jpeg','webp','avif'].includes(extension))throw Error('存档图片格式不支持');const path='images/'+archiveHash(bytes)+'.'+extension;files.set(path,bytes);return {$image:path};}
 function separate(value,files,key=''){
  if(typeof value==='string'){
   const embedded=/^data:image\/(png|jpeg|jpg|webp|avif);base64,([a-zA-Z0-9+/=\s]+)$/.exec(value);
   if(embedded){const bytes=Buffer.from(embedded[2],'base64');if(!bytes.length)throw Error('存档图片为空');return image(bytes,embedded[1],files);}
   if(assetKey(key)&&value){const root=realpathSync(dataRoot),file=realpathSync(resolve(root,value)),rel=relative(root,file);if(isAbsolute(value)||rel.startsWith('..')||isAbsolute(rel)||!value.replaceAll('\\','/').startsWith('cg-assets/'))throw Error('存档图片路径越界');return image(readFileSync(file),/\.webp$/i.test(value)?'webp':'png',files);}
   return value;
  }
  if(Array.isArray(value))return value.map(item=>separate(item,files));
  if(value&&typeof value==='object'){const out={};for(const [field,item]of Object.entries(value)){if(secrets.test(field))continue;out[field]=separate(item,files,field);}return out;}return value;
 }
 function prepare(snapshot){
  const files=new Map(),portable=separate(snapshot,files);const state=Buffer.from(JSON.stringify(portable));if(state.length>MAX_TEXT)throw Error('单个人生文本超过安全大小 64 MiB');files.set('text/state.json',state);if([...files.values()].reduce((sum,bytes)=>sum+bytes.length,0)>MAX_TOTAL-1024*1024)throw Error('人生存档内容超过安全大小 512 MiB');
  const manifest={format:'ai-buddy-life',version:1,createdAt:Date.now(),characterId:snapshot.characterId,lifeId:snapshot.life.id,dependencies:snapshot.dependencies??[],files:[...files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:archiveHash(bytes)}))};files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));const bytes=zip(files);decode(bytes);return bytes;
 }
 function decode(bytes){
  const files=unzip(bytes),manifest=files.get('manifest.json')&&json(files.get('manifest.json'));if(manifest?.format!=='ai-buddy-life'||manifest.version!==1||!Array.isArray(manifest.files)||!Array.isArray(manifest.dependencies))throw Error('不支持的人生存档格式');
  const declared=new Set();let total=0;for(const row of manifest.files){if(!safePath(row.path)||row.path==='manifest.json'||declared.has(row.path)||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/.test(row.sha256??''))throw Error('人生文件清单无效');declared.add(row.path);const raw=files.get(row.path);if(!raw||raw.length!==row.bytes||archiveHash(raw)!==row.sha256)throw Error('人生存档文件哈希不匹配');total+=raw.length;if(row.path.startsWith('images/'))checkImage(raw);}
  if(files.size!==declared.size+1||!declared.has('text/state.json')||total>MAX_TOTAL)throw Error('人生存档包含未声明的文件或缺少文字');
  const hydrate=(value,key='')=>{if(typeof value==='string'&&(/^data:image\//i.test(value)||assetKey(key)&&value))throw Error('人生存档图片必须使用已校验的包内引用');if(Array.isArray(value))return value.map(item=>hydrate(item));if(value&&typeof value==='object'){if(Object.hasOwn(value,'$image')){if(Object.keys(value).length!==1||!declared.has(value.$image)||!value.$image.startsWith('images/'))throw Error('人生存档图片引用缺失');const data='data:image/'+value.$image.split('.').at(-1)+';base64,'+files.get(value.$image).toString('base64');return assetKey(key)?{$assetImage:data}:data;}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,hydrate(v,k)]));}return value;};
  const snapshot=hydrate(json(files.get('text/state.json')));if(snapshot?.format!=='ai-buddy-life-state'||snapshot.version!==1||snapshot.characterId!==manifest.characterId||!/^[a-zA-Z0-9_-]{1,100}$/.test(snapshot.characterId)||['__proto__','prototype','constructor'].includes(snapshot.characterId)||snapshot.life?.id!==manifest.lifeId||!snapshot.card||!snapshot.relationships||!Array.isArray(snapshot.conversations))throw Error('人生状态内容不完整');return {manifest,snapshot};
 }
 function file(id){if(!/^archive-[a-f0-9-]{36}$/.test(id))throw Error('人生存档 ID 无效');const target=join(directory,id+'.zip');if(existsSync(target)&&relative(realpathSync(directory),realpathSync(target)).startsWith('..'))throw Error('人生存档路径越界');return target;}
 function write(bytes){decode(bytes);const id='archive-'+randomUUID(),target=file(id),temp=target+'.partial';writeFileSync(temp,bytes,{flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}if(archiveHash(readFileSync(temp))!==archiveHash(bytes))throw Error('存档写入校验失败');renameSync(temp,target);return {id,bytes:bytes.length,sha256:archiveHash(bytes),fileName:id+'.zip'};}
 return {prepare,decode,has:id=>{try{return existsSync(file(id));}catch{return false;}},save:snapshot=>write(prepare(snapshot)),import:bytes=>write(bytes),read(id,expectedHash){const bytes=readFileSync(file(id));if(expectedHash&&archiveHash(bytes)!==expectedHash)throw Error('本地人生存档哈希不匹配');return {...decode(bytes),bytes};}};
}
