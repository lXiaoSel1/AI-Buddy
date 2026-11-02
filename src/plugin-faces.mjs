// C-1: the character faces plugin pages may show (--buddy-face-<id>, see plugin-page-appearance.mjs). Built-in
// characters use their theme's head crop; a custom character its own avatar, made small enough to pass the 64 KiB
// limit when the image can be decoded here, otherwise only if it already fits. Nothing else about a character leaves.
import {readFileSync,statSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {themeAsset,THEMES} from './appearance.mjs';
import {FACE_ID,FACE_MAX_BYTES,validFace,PORTRAIT_MAX_BYTES,PORTRAITS_MAX_BYTES,PORTRAITS_MAX,validPortrait} from './plugin-page-appearance.mjs';

const DATA=/^data:image\/(png|jpeg|webp|avif);base64,([A-Za-z0-9+/=\s]+)$/i,MEDIA=/^buddy-media:\/\/([a-f0-9]{64}\.(png|jpeg|webp|avif))\/?$/;
const encoded=bytes=>Math.ceil(bytes/3)*4;
export const FACE_INPUT_BYTES=8*1024*1024,FACES_INPUT_BYTES=16*1024*1024,FACES_INPUT_ITEMS=48,FACE_INPUT_PIXELS=16*1024*1024,FACES_INPUT_PIXELS=32*1024*1024,FACE_INPUT_SIDE=8192,FACE_CACHE_ENTRIES=96,FACE_CACHE_BYTES=4*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const boundedSize=size=>Number.isSafeInteger(size)&&size>0&&size<=FACE_INPUT_BYTES;
function faceSource(avatar,{sizeMedia=()=>null}={},maxBytes=FACE_INPUT_BYTES){
 if(typeof avatar!=='string'||maxBytes<=0||avatar.length>encoded(Math.min(FACE_INPUT_BYTES,maxBytes))+64)return null;
 const stored=MEDIA.exec(avatar);
 if(stored){try{const bytes=sizeMedia(stored[1]);return boundedSize(bytes)&&bytes<=maxBytes?{mime:stored[2],name:stored[1],bytes,key:stored[2]+':'+stored[1].slice(0,64)}:null;}catch{return null;}}
 const inline=DATA.exec(avatar);if(!inline)return null;const data=inline[2].replace(/\s+/g,''),bytes=Buffer.byteLength(data,'base64'),mime=inline[1].toLowerCase();
 return boundedSize(bytes)&&bytes<=maxBytes?{mime,data,bytes,key:mime+':'+hash(data)}:null;
}
export function readFaceFile(file,maxBytes=FACE_INPUT_BYTES){
 let fd;try{fd=openSync(file,'r');const size=fstatSync(fd).size;if(!boundedSize(size)||size>maxBytes)return null;const bytes=Buffer.alloc(size);let at=0;while(at<size){const n=readSync(fd,bytes,at,size-at,at);if(!n)return null;at+=n;}return fstatSync(fd).size===size?bytes:null;}catch{return null;}finally{if(fd!==undefined)closeSync(fd);}
}
function dimensions(bytes,mime){
 if(mime==='png')return bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'?{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}:null;
 if(mime!=='jpeg'||bytes.length<4||bytes[0]!==255||bytes[1]!==216)return null;
 for(let at=2;at+3<bytes.length;){if(bytes[at++]!==255)return null;while(bytes[at]===255)at++;const marker=bytes[at++];if(marker===218||marker===217)return null;if(marker===1||marker>=208&&marker<=215)continue;if(at+2>bytes.length)return null;const size=bytes.readUInt16BE(at);if(size<2||at+size>bytes.length)return null;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return size>=8?{height:bytes.readUInt16BE(at+3),width:bytes.readUInt16BE(at+5)}:null;at+=size;}
 return null;
}
function fromSource(source,{readMedia=()=>null,image=null,side=96,decodeBudget=null}={}){
 let bytes;try{bytes=source.name?readMedia(source.name,source.bytes):Buffer.from(source.data,'base64');}catch{return null;}
 if(!Buffer.isBuffer(bytes)||bytes.length!==source.bytes)return null;
 const plain='data:image/'+source.mime+';base64,'+bytes.toString('base64');
 if(image&&['png','jpeg'].includes(source.mime)){
  const size=dimensions(bytes,source.mime);if(!size||!size.width||!size.height||Math.max(size.width,size.height)>FACE_INPUT_SIDE||size.width*size.height>FACE_INPUT_PIXELS)return null;
  if(decodeBudget){if(size.width*size.height>decodeBudget.pixels)return null;decodeBudget.pixels-=size.width*size.height;}
  try{const picture=image.createFromBuffer(bytes);if(!picture.isEmpty()){const actual=picture.getSize();if(actual.width!==size.width||actual.height!==size.height)return null;const scale=Math.min(1,side/Math.max(size.width,size.height)),small=scale<1?picture.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'good'}):picture;const data='data:image/jpeg;base64,'+small.toJPEG(82).toString('base64');if(data.length<plain.length&&data.length<=FACE_MAX_BYTES)return data;}}catch{}
 }
 return plain.length<=FACE_MAX_BYTES?plain:null;
}
/** Built-in heads from the installed theme assets, read once. A missing or oversized file is left out. */
export function builtinFaces(build,{read=readFileSync,size=file=>statSync(file).size}={}){
 const faces={};
 for(const id of Object.keys(THEMES)){if(!FACE_ID.test(id))continue;const file=join(build,themeAsset(id,'head.webp'));try{const prefix='data:image/webp;base64,';if(prefix.length+encoded(size(file))>FACE_MAX_BYTES)continue;const data=prefix+read(file).toString('base64');if(validFace(id,data))faces[id]=data;}catch{}}
 return faces;
}
/** A custom character's avatar as a small data URL, or null. image: Electron's nativeImage (png/jpeg only). */
export function customFace(avatar,options={}){const source=faceSource(avatar,options);return source?fromSource(source,options):null;}
/** Faces for every custom character in the companion view that has a valid id and an avatar. */
export function customFaces(characters=[],options={}){
 const faces={},decodeBudget={pixels:FACES_INPUT_PIXELS};let count=0,bytes=0;
 for(const character of Array.isArray(characters)?characters:[]){const id=character?.id;if(typeof id!=='string'||!FACE_ID.test(id)||Object.hasOwn(THEMES,id)||character.builtin===true)continue;if(count++>=FACES_INPUT_ITEMS||bytes>=FACES_INPUT_BYTES)break;const source=faceSource(character.avatar,options,FACES_INPUT_BYTES-bytes);if(!source)continue;bytes+=source.bytes;const face=options.convert?options.convert(source,decodeBudget):fromSource(source,{...options,decodeBudget});if(face&&validFace(id,face))faces[id]=face;}
 return faces;
}
export function createCustomFaceProcessor(options={}){
 const cache=new Map();let bytes=0;
 const convert=(source,decodeBudget)=>{if(cache.has(source.key)){const value=cache.get(source.key);cache.delete(source.key);cache.set(source.key,value);return value;}const value=fromSource(source,{...options,decodeBudget});if(value===null)return null;cache.set(source.key,value);bytes+=value.length;while(cache.size>FACE_CACHE_ENTRIES||bytes>FACE_CACHE_BYTES){const key=cache.keys().next().value;bytes-=cache.get(key).length;cache.delete(key);}return value;};
 return Object.freeze({faces:characters=>customFaces(characters,{...options,convert}),snapshot:()=>({entries:cache.size,bytes})});
}

export function builtinPortraits(build,{read=readFaceFile,size=file=>statSync(file).size}={}){
 const portraits={};let bytes=0,count=0;
 for(const id of Object.keys(THEMES)){if(!FACE_ID.test(id)||count>=PORTRAITS_MAX)continue;const file=join(build,themeAsset(id,'portrait.webp'));
  try{const length=size(file),prefix='data:image/webp;base64,',total=prefix.length+encoded(length),row=total+id.length+32;if(!Number.isSafeInteger(length)||length<=0||total>PORTRAIT_MAX_BYTES||bytes+row>PORTRAITS_MAX_BYTES)continue;const input=read(file,length);if(!Buffer.isBuffer(input)||input.length!==length)continue;const data=prefix+input.toString('base64');if(validPortrait(id,data)){portraits[id]=data;bytes+=row;count++;}}catch{}
 }
 return portraits;
}
