import {randomBytes} from 'node:crypto';
export {imageInputCapability} from './model-image-catalog.mjs';
const fail=code=>Object.assign(Error(code),{code});
const MIME=new Set(['image/png','image/jpeg','image/webp']);
const scopeKeys=['pluginId','characterId','personaId','lifeId','operationId','sessionId','accountBindingId','bindingGeneration'];
const scopeOf=s=>JSON.stringify(scopeKeys.map(k=>s?.[k]??null));
const tickets=new Map();
export function imagePart({mimeType,bytes}){
 if(!MIME.has(mimeType)||!(Buffer.isBuffer(bytes)||bytes instanceof Uint8Array)||!bytes.length||bytes.length>4*1024*1024)throw fail('MODEL_IMAGE_INVALID');
 const b=Buffer.from(bytes);if(mimeType==='image/png'&&!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||mimeType==='image/jpeg'&&!(b[0]===255&&b[1]===216&&b[2]===255)||mimeType==='image/webp'&&!(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'))throw fail('MODEL_IMAGE_INVALID');
 return {type:'image',mimeType,data:b.toString('base64')};
}
export function checkedImagePart(part){
 if(!part||part.type!=='image'||!MIME.has(part.mimeType)||typeof part.data!=='string'||part.data.length>6*1024*1024||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data))throw fail('MODEL_IMAGE_INVALID');
 const value=imagePart({mimeType:part.mimeType,bytes:Buffer.from(part.data,'base64')});if(value.data!==part.data)throw fail('MODEL_IMAGE_INVALID');return value;
}
export function checkedImages(parts){
 if(!Array.isArray(parts)||!parts.length||parts.length>8)throw fail('MODEL_IMAGE_INVALID');const result=parts.map(checkedImagePart);
 if(result.reduce((n,p)=>n+p.data.length,0)>12*1024*1024)throw fail('MODEL_IMAGE_TOO_LARGE');return result;
}
export const imageDataUrl=part=>{const p=checkedImagePart(part);return 'data:'+p.mimeType+';base64,'+p.data;};
export function registerHostImages(images,scope,{beforeSubmit}={}){
 for(const [key,row]of tickets)if(row.expires<=Date.now())tickets.delete(key);
 if(tickets.size>=32)throw fail('MODEL_IMAGE_BUSY');const parts=checkedImages(images.map(imagePart)),token=randomBytes(32).toString('base64url');
 tickets.set(token,{scope:scopeOf(scope),parts,beforeSubmit,expires:Date.now()+60000});return token;
}
export function registerHostSubmission(scope,{beforeSubmit}={}){
 for(const [key,row]of tickets)if(row.expires<=Date.now())tickets.delete(key);
 if(tickets.size>=32||typeof beforeSubmit!=='function')throw fail('MODEL_IMAGE_BUSY');const token=randomBytes(32).toString('base64url');
 tickets.set(token,{scope:scopeOf(scope),parts:null,beforeSubmit,expires:Date.now()+60000});return token;
}
export function takeHostImages(token,scope){const row=tickets.get(token);if(!row||row.expires<=Date.now()||row.scope!==scopeOf(scope))throw fail('MODEL_IMAGE_REFERENCE_DENIED');tickets.delete(token);return {parts:row.parts,beforeSubmit:row.beforeSubmit};}
export function releaseHostImages(token){tickets.delete(token);}
