import {createHash} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeAtomic} from './atomic-write.mjs';

// B4: pictures of the companion store live in galgame/media/<sha256>.<ext>, and the
// state keeps the short URL buddy-media://<sha256>.<ext>. The panel loads that URL
// through the restricted buddy-media protocol; code that needs the bytes (engine
// sync, CG references, exports, life archives) calls resolve().
export const MEDIA_SCHEME='buddy-media';
const NAME=/^[a-f0-9]{64}\.(?:png|jpeg|webp|avif)$/;
const URL_FORM=/^buddy-media:\/\/([a-f0-9]{64}\.(?:png|jpeg|webp|avif))\/?$/;
// Only canonical data URLs are stored as files, so resolve() returns the exact string.
const CANONICAL=/^data:image\/(png|jpeg|webp|avif);base64,([A-Za-z0-9+/]+={0,2})$/;
// True when put() would store this value and resolve() would give it back unchanged.
export function canonicalImage(value){const match=typeof value==='string'?CANONICAL.exec(value):null;return !!match&&Buffer.from(match[2],'base64').toString('base64')===match[2]&&match[2].length>0;}
export const mediaName=value=>typeof value==='string'?URL_FORM.exec(value)?.[1]??null:null;
export const isMediaUrl=value=>mediaName(value)!==null;
export const MEDIA_MIME={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',avif:'image/avif'};

// Where the companion store keeps pictures: [holder, key, path].
export function* imageSlots(state){
 for(const bucket of ['cards','draftCards'])for(const [id,card]of Object.entries(state?.[bucket]??{})){
  if(!card||typeof card!=='object')continue;yield [card,'avatar',bucket+'/'+id+'/avatar'];
  for(const field of ['sprite','backgroundImage','referenceImage'])if(card.fields?.[field]&&typeof card.fields[field]==='object')yield [card.fields[field],'value',bucket+'/'+id+'/'+field];
 }
 for(const [id,persona]of Object.entries(state?.personas??{}))if(persona&&typeof persona==='object')yield [persona,'avatar','personas/'+id+'/avatar'];
 for(const [id,group]of Object.entries(state?.groups??{}))if(group&&typeof group==='object')yield [group,'background','groups/'+id+'/background'];
 for(const [id,archive]of Object.entries(state?.lifeArchives??{}))if(archive&&typeof archive==='object')yield [archive,'avatar','lifeArchives/'+id+'/avatar'];
}

export function createMediaStore(dataRoot){
 const directory=join(dataRoot,'galgame','media');
 const file=name=>{if(!NAME.test(name??''))throw Error('图片引用无效');return join(directory,name);};
 // Returns the media URL for a canonical image data URL, or null for anything else.
 function put(value){
  if(!canonicalImage(value))return null;const match=CANONICAL.exec(value),bytes=Buffer.from(match[2],'base64');
  const name=createHash('sha256').update(bytes).digest('hex')+'.'+match[1],target=file(name);
  if(!existsSync(target)){
   mkdirSync(directory,{recursive:true});writeAtomic(target,bytes);
  }
  return MEDIA_SCHEME+'://'+name;
 }
 const read=value=>readFileSync(file(mediaName(value)));
 // Media URLs become data URLs; other values pass through. A missing file gives `missing`.
 function resolve(value,{missing=''}={}){
  const name=mediaName(value);if(!name)return value;
  try{return 'data:image/'+name.split('.').at(-1)+';base64,'+readFileSync(file(name)).toString('base64');}catch(error){if(error.code==='ENOENT')return missing;throw error;}
 }
 return {directory,file,put,read,resolve,has:value=>{const name=mediaName(value);return !!name&&existsSync(file(name));}};
}

// The card fields the engine reads as data URLs.
export function resolveCardImages(media,effective){
 if(!media||!effective)return effective;const value={...effective};
 for(const field of ['sprite','backgroundImage','referenceImage'])if(isMediaUrl(value[field]))value[field]=media.resolve(value[field]);
 return value;
}
// A copy of a store-shaped object (state or export) with every media URL resolved.
// A missing picture file is an error, so an export never drops it silently.
export function resolveStateImages(media,value){
 if(!media)return value;const copy=structuredClone(value),missing=[];
 for(const [holder,key,path]of imageSlots(copy))if(isMediaUrl(holder[key])){const data=media.resolve(holder[key],{missing:null});if(data===null)missing.push(path);else holder[key]=data;}
 if(missing.length)throw Object.assign(Error('有 '+missing.length+' 张图片文件已丢失，导出没有完成：'+missing.slice(0,5).join('，')),{code:'MEDIA_FILE_MISSING',missing});
 return copy;
}
