import {setImmediate as yieldImmediate} from 'node:timers/promises';

const frameBytes=64*1024;
const textChars=8*1024;

// Scope payloads normally fit in workerData. Split large payloads before
// structured cloning so a new inline image or a lengthy record plan cannot
// occupy the host's event loop in one serialization.
function* encode(value,state){
 const {seen}=state;
 if(typeof value==='string'){
  if(value.length<=textChars)return value;
  const id=state.next++;
  yield ['text',id];
  for(let offset=0;offset<value.length;offset+=textChars)
   yield ['chunk',id,value.slice(offset,offset+textChars)];
  yield ['join',id];
  return [id];
 }
 if(value===null||typeof value!=='object')return value;
 if(seen.has(value))return [seen.get(value)];
 const id=state.next++;
 seen.set(value,id);
 if(value instanceof Map){
  yield ['map',id];
  for(const [key,child] of value)
   yield ['set',id,yield* encode(key,state),yield* encode(child,state)];
 }else if(value instanceof Set){
  yield ['set-values',id];
  for(const child of value)yield ['add',id,yield* encode(child,state)];
 }else if(Array.isArray(value)||[Object.prototype,null].includes(Object.getPrototypeOf(value))){
  yield Array.isArray(value)?['array',id,value.length]:['object',id];
  for(const key in value)if(Object.hasOwn(value,key))
   yield ['property',id,yield* encode(key,state),yield* encode(value[key],state)];
 }else{
  // Plans use JSON-compatible state plus the Maps/Sets above. Preserve
  // structured-clone scalar extensions without copying a large backing buffer.
  if((value.buffer?.byteLength??value.byteLength??(value.source?.length??0)*2)>textChars*2)
   throw Error('Companion life metadata contains an oversized binary value');
  yield ['scalar',id,value];
 }
 return [id];
}
function weight(value){
 if(typeof value==='string')return value.length*2;
 if(value&&typeof value==='object')return value.buffer?.byteLength??value.byteLength??32;
 return 16;
}

export async function sendLifeMetadata(worker,payload,relevant){
 const tokens=encode(payload,{seen:new Map(),next:0});
 let frame=[],size=0;
 function send(){
  if(relevant())worker.postMessage({lifeMetadataFrame:frame});
  frame=[];size=0;
 }
 while(relevant()){
  const {done,value}=tokens.next();
  if(done){
   if(frame.length)send();
   if(relevant())worker.postMessage({lifeMetadataRoot:value});
   return;
  }
  const bytes=64+value.reduce((total,item)=>total+weight(item),0);
  if(size+bytes>frameBytes&&frame.length){send();await yieldImmediate();}
  frame.push(value);size+=bytes;
 }
}

export function receiveLifeMetadata(){
 const values=[];
 const resolve=value=>Array.isArray(value)?values[value[0]]:value;
 return {
  append(frame){
   for(const [type,id,key,value] of frame){
    switch(type){
     case 'text': values[id]=[];break;
     case 'chunk': values[id].push(key);break;
     case 'join': values[id]=values[id].join('');break;
     case 'map': values[id]=new Map();break;
     case 'set-values': values[id]=new Set();break;
     case 'array': values[id]=Array(key);break;
     case 'object': values[id]={};break;
     case 'scalar': values[id]=key;break;
     case 'set': values[id].set(resolve(key),resolve(value));break;
     case 'add': values[id].add(resolve(key));break;
     case 'property':Object.defineProperty(values[id],resolve(key),{
      configurable:true,enumerable:true,writable:true,value:resolve(value)
     });break;
     default:throw Error('Unsupported companion life metadata frame');
    }
   }
  },
  finish:resolve
 };
}
