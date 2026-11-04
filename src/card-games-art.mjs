import {createHash} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {THEMES} from './appearance.mjs';
import {EMOTIONS} from './emotions.mjs';
import {mediaName} from './media-store.mjs';

const KINDS=new Set(['b','bg','pet','orn','p']);
const CHARACTER_ID=/^[a-zA-Z0-9_-]{1,100}$/;
const INLINE=/^data:image\/(png|jpeg|webp|avif);base64,([a-zA-Z0-9+/=\s]+)$/;
const MAX_BUILTIN=2*1024*1024,MAX_SPRITE_URL=26_000_000,MAX_SPRITE=Math.floor(MAX_SPRITE_URL*3/4);
const invalid=()=>Object.assign(Error('Invalid card table artwork request'),{code:'GAME_ART_INVALID'});

async function readImage(root,parts,maxBytes){
 try{
  const file=join(await realpath(root),...parts);
  const info=await lstat(file);
  if(!info.isFile()||info.size<1||info.size>maxBytes||relative(file,await realpath(file))!=='')return null;
  const handle=await open(file,'r');
  try{
   const opened=await handle.stat();
   if(!opened.isFile()||opened.size!==info.size||opened.ino!==info.ino||opened.dev!==info.dev)return null;
   const bytes=Buffer.alloc(opened.size);
   for(let offset=0;offset<bytes.length;){
    const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
    if(!bytesRead)return null;
    offset+=bytesRead;
   }
   if((await handle.stat()).size!==bytes.length)return null;
   return bytes;
  }finally{await handle.close();}
 }catch{return null;}
}
const imageUrl=(mime,bytes)=>'data:image/'+mime+';base64,'+bytes.toString('base64');
const webp=bytes=>bytes?.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)===bytes.length-8;

// The requester chooses named artwork, never a file path, media hash, or URL.
export function createCardGamesArt({build,dataRoot,getGame}){
 const buildRoot=resolve(build),profileRoot=resolve(dataRoot);
 return async function cardGamesArt(input){
  if(!input||Object.keys(input).some(key=>!['kind','id','emotion'].includes(key)))throw invalid();
  const {kind,id,emotion}=input;
  if(!KINDS.has(kind)||typeof id!=='string'||!CHARACTER_ID.test(id)||
     (kind==='b'?typeof emotion!=='string'||!Object.hasOwn(EMOTIONS,emotion):emotion!==undefined))throw invalid();
  if(Object.hasOwn(THEMES,id)||kind==='orn'&&id==='whale'){
   const name=kind==='b'?id+'-'+emotion:id,bytes=await readImage(buildRoot,['assets','card-games',kind,name+'.webp'],MAX_BUILTIN);
   return {url:webp(bytes)?imageUrl('webp',bytes):null};
  }
  if(kind!=='p')return {url:null};
  const sprite=getGame()?.cardGamesPortrait?.(id),name=mediaName(sprite);
  if(name){
   const bytes=await readImage(profileRoot,['galgame','media',name],MAX_SPRITE);
   if(!bytes||createHash('sha256').update(bytes).digest('hex')!==name.slice(0,64))return {url:null};
   return {url:imageUrl(name.split('.').at(-1),bytes)};
  }
  const inline=typeof sprite==='string'&&sprite.length<=MAX_SPRITE_URL?INLINE.exec(sprite):null;
  if(!inline)return {url:null};
  const bytes=Buffer.from(inline[2],'base64');
  return {url:bytes.length&&bytes.toString('base64')===inline[2].replace(/\s+/g,'')?imageUrl(inline[1],bytes):null};
 };
}
