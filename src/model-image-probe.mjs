import {createHash,randomInt,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdirSync,readFileSync,statSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {imageInputCapability,imagePart} from './model-images.mjs';

const PROBE_VERSION=1,SCHEMA_VERSION=1,MAX_RECORDS=256;
const digits=['11111/10001/10001/10001/10001/10001/11111','00100/01100/00100/00100/00100/00100/01110','11111/00001/00001/11111/10000/10000/11111','11111/00001/00001/11111/00001/00001/11111','10001/10001/10001/11111/00001/00001/00001','11111/10000/10000/11111/00001/00001/11111','11111/10000/10000/11111/10001/10001/11111','11111/00001/00010/00100/01000/01000/01000','11111/10001/10001/11111/10001/10001/11111','11111/10001/10001/11111/00001/00001/11111'];
const GUARD_CODES=new Set(['SOCIAL_HOST_CLOSED','TRUSTED_UI_PRINCIPAL_REQUIRED','BUDDY_PLUGIN_DISABLED','BUDDY_CAPABILITY_DENIED','BUDDY_CONTEXT_EXPIRED','BUDDY_CONTEXT_REQUIRED','BUDDY_CONTEXT_STALE','SOCIAL_ACCOUNT_CHANGED','R95_CONNECTION_CHANGED','R95_MODEL_DISABLED']);
const FAILURE_CODES=new Set([...GUARD_CODES,'ABORT_ERR','API_HTTP_ERROR','MODEL_OUTPUT_TRUNCATED','MODEL_IMAGE_PROBE_MISMATCH','MODEL_IMAGE_PROBE_FAILED','MODEL_IMAGE_PROBE_TIMEOUT','MODEL_IMAGE_PROBE_STALE','MODEL_IMAGE_PROBE_STORAGE_FAILED','MODEL_IMAGE_PROBE_CANCELLED','MODEL_IMAGE_PROBE_DISABLED','MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE','MODEL_IMAGE_PROBE_INCOMPLETE']);
const unknown=reason=>({supported:false,reason,code:reason});
const fail=code=>Object.assign(Error(code),{code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const recordId=row=>row.status==='supported'?row.key:row.key+':'+row.attemptHash;
const fingerprint=profile=>createHash('sha256').update(JSON.stringify([PROBE_VERSION,profile?.id,profile?.kind,profile?.protocol,profile?.baseUrl,profile?.model,profile?.keyCiphertext??null,profile?.models?.find(m=>m.id===profile.model||m.model===profile.model)??null])).digest('hex');
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function readRecords(path){
 try{
  if(statSync(path).size>128*1024)return [];
  const value=JSON.parse(readFileSync(path,'utf8'));
  if(value?.schemaVersion!==SCHEMA_VERSION||value.probeVersion!==PROBE_VERSION||!Array.isArray(value.records)||value.records.length>MAX_RECORDS)return [];
  return value.records.filter(row=>{
   if(!row||typeof row.key!=='string'||!/^[a-f0-9]{64}$/.test(row.key)||!validTime(row.checkedAt))return false;
   const fields=Object.keys(row).sort().join(',');
   return row.status==='supported'?fields==='checkedAt,key,provenAt,status'&&validTime(row.provenAt):row.status==='unknown'&&fields==='attemptHash,checkedAt,code,key,status'&&typeof row.attemptHash==='string'&&/^[a-f0-9]{64}$/.test(row.attemptHash)&&FAILURE_CODES.has(row.code);
  });
 }catch{return [];}
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function pngChunk(type,bytes){const name=Buffer.from(type),result=Buffer.alloc(bytes.length+12);result.writeUInt32BE(bytes.length);name.copy(result,4);bytes.copy(result,8);result.writeUInt32BE(crc32(Buffer.concat([name,bytes])),bytes.length+8);return result;}
function challenge(){
 const answer=String(randomInt(1000000)).padStart(6,'0'),scale=8,padding=16,width=padding*2+6*5*scale+5*2*scale,height=padding*2+7*scale,pixels=Buffer.alloc(height*(width+1),255);
 for(let y=0;y<height;y++)pixels[y*(width+1)]=0;
 for(let index=0;index<answer.length;index++)for(const [y,row]of digits[Number(answer[index])].split('/').entries())for(const [x,value]of [...row].entries())if(value==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++)pixels[(padding+y*scale+dy)*(width+1)+1+padding+index*7*scale+x*scale+dx]=0;
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
 return {answer,image:imagePart({mimeType:'image/png',bytes})};
}

export class ModelImageProbe{
 #records=new Map();
 #attempts=new Map();
 #inflight=new Map();
 #root;
 #path;
 #assertCurrent(router,profile,key,signal){if(signal?.aborted)throw fail(signal.reason?.code==='MODEL_IMAGE_PROBE_TIMEOUT'?'MODEL_IMAGE_PROBE_TIMEOUT':'ABORT_ERR');if(!router.enabled)throw fail('MODEL_IMAGE_PROBE_DISABLED');if(fingerprint(router.state?.profiles.find(row=>row.id===profile.id))!==key)throw fail('MODEL_IMAGE_PROBE_STALE');}
 async #checkCaller(router,profile,key,options,deadline){
  this.#assertCurrent(router,profile,key,options.signal);let timer,onAbort;
  const stopped=new Promise((_,reject)=>{onAbort=()=>reject(fail('ABORT_ERR'));options.signal?.addEventListener('abort',onAbort,{once:true});if(options.signal?.aborted)onAbort();timer=setTimeout(()=>reject(fail('MODEL_IMAGE_PROBE_TIMEOUT')),Math.max(0,deadline-Date.now()));});
  try{const current=await Promise.race([Promise.resolve().then(()=>options.checkCurrent?.()),stopped]);this.#assertCurrent(router,profile,key,options.signal);if(current===false)throw fail('MODEL_IMAGE_PROBE_STALE');}
  catch(error){throw fail(FAILURE_CODES.has(error?.code)?error.code:error?.name==='AbortError'?'ABORT_ERR':'MODEL_IMAGE_PROBE_STALE');}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);}
 }
 constructor({dataRoot}){this.#root=dataRoot;this.#path=join(dataRoot,'model-image-capabilities.json');this.ready=Promise.resolve().then(()=>{for(const record of readRecords(this.#path))this.#records.set(recordId(record),record);});}
 #persist(record){
  const next=new Map(readRecords(this.#path).map(row=>[recordId(row),row]));for(const [key,value]of this.#records)next.set(key,value);next.set(recordId(record),record);
  const records=[...next.values()].sort((a,b)=>a.checkedAt.localeCompare(b.checkedAt)).slice(-MAX_RECORDS),temp=this.#path+'.'+randomUUID()+'.tmp';mkdirSync(this.#root,{recursive:true});let fd;
  try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify({schemaVersion:SCHEMA_VERSION,probeVersion:PROBE_VERSION,records}));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,this.#path);this.#records=new Map(records.map(row=>[recordId(row),row]));}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
 }
 capability(profile){const declared=imageInputCapability(profile);if(declared.reason!=='MODEL_IMAGE_CAPABILITY_UNKNOWN'||profile?.kind==='codex'||profile?.protocol==='codex')return declared;const evidence=this.#records.get(fingerprint(profile));return evidence?.status==='supported'?{...declared,supported:true,reason:null,imageInput:'supported',transportSupported:true,transportSource:'probe',source:'probe',sourceUrl:null,checkedAt:evidence.checkedAt,provenAt:evidence.provenAt}:declared;}
 async ensure(router,profile,options={}){
  await this.ready;const capability=this.capability(profile);if(capability.reason!=='MODEL_IMAGE_CAPABILITY_UNKNOWN')return options.signal?.aborted?unknown('ABORT_ERR'):capability;
  if(profile?.kind==='codex'||profile?.protocol==='codex')return unknown('MODEL_IMAGE_PROBE_NATIVE_UNAVAILABLE');
  if(!['responses','chat-completions','anthropic','gemini'].includes(profile?.protocol))return unknown('MODEL_IMAGE_TRANSPORT_UNSUPPORTED');
  if(typeof options.attemptId!=='string'||!options.attemptId.trim()||options.attemptId.length>200)return unknown('MODEL_IMAGE_PROBE_ATTEMPT_REQUIRED');
  const frozen=structuredClone(profile),key=fingerprint(frozen),attemptHash=hash(options.attemptId),attemptKey=key+':'+attemptHash,previous=this.#attempts.get(attemptKey)??this.#records.get(attemptKey);
  if(previous)return unknown(previous.code);
  const finish=code=>{const record={key,status:'unknown',checkedAt:new Date().toISOString(),attemptHash,code};this.#attempts.set(attemptKey,record);try{this.#persist(record);}catch{}return unknown(code);};
  let job=this.#inflight.get(key);if(!job){job={controller:new AbortController(),callers:new Set(),promise:null};this.#inflight.set(key,job);}
  const caller={options:{...options,scope:structuredClone(options.scope??null)}},abort=()=>job.controller.abort(fail('ABORT_ERR'));job.callers.add(caller);
  if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
  if(!job.promise)job.promise=this.#probe(router,frozen,caller.options,key,job).finally(()=>{if(this.#inflight.get(key)===job)this.#inflight.delete(key);});
  try{const result=await job.promise;if(!result.supported)return finish(result.code);try{await this.#checkCaller(router,frozen,key,caller.options,job.deadline);}catch(error){return finish(error.code);}return result;}finally{options.signal?.removeEventListener('abort',abort);}
 }
 async #probe(router,frozen,options,key,job){
  const {answer,image}=challenge(),controller=job.controller;
  job.deadline=Date.now()+Math.min(router.timeoutMs,30000);
  const timer=setTimeout(()=>controller.abort(Object.assign(Error('MODEL_IMAGE_PROBE_TIMEOUT'),{code:'MODEL_IMAGE_PROBE_TIMEOUT'})),Math.min(router.timeoutMs,30000));
  let onAbort;const aborted=new Promise((_,reject)=>{onAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted)onAbort();});let output='',outputBytes=0,finished=false;
  const assertCurrent=()=>this.#assertCurrent(router,frozen,key,controller.signal);
  const guard=async()=>{assertCurrent();for(const caller of job.callers){let current;try{current=await Promise.race([Promise.resolve().then(()=>caller.options.checkCurrent?.()),aborted]);}catch(error){controller.signal.throwIfAborted();throw fail(GUARD_CODES.has(error?.code)?error.code:error?.name==='AbortError'?'ABORT_ERR':'MODEL_IMAGE_PROBE_STALE');}assertCurrent();if(current===false)throw fail('MODEL_IMAGE_PROBE_STALE');}};
  try{
   await guard();
   await Promise.race([router.withRequestContext({},()=>router.runCaptured(frozen,async()=>{for await(const part of router.stream({system:'',messages:[{role:'user',content:[{type:'text',text:'Read the six digits in this image from left to right. Reply with exactly those six digits and nothing else.'},image]}],singleSubmission:true,incremental:true,userLimit:false,maxTokens:128,purpose:'image-capability-probe',scope:options.scope,activityOriginId:options.activityOriginId,checkModelSubmit:guard,signal:controller.signal})){if(part.type==='text-delta'){outputBytes+=Buffer.byteLength(part.text,'utf8');if(outputBytes>4096)throw fail('MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE');output+=part.text;}else if(part.type==='finish')finished=part.reason?.kind==='stop';}},controller.signal,{background:true})),aborted]);
   await guard();
   if(!finished)return unknown('MODEL_IMAGE_PROBE_INCOMPLETE');
   if(output.trim()!==answer)return unknown('MODEL_IMAGE_PROBE_MISMATCH');
   const at=new Date().toISOString();try{this.#persist({key,status:'supported',provenAt:at,checkedAt:at});}catch{return unknown('MODEL_IMAGE_PROBE_STORAGE_FAILED');}return this.capability(frozen);
  }catch(error){const reason=controller.signal.aborted?controller.signal.reason:error;return unknown(FAILURE_CODES.has(reason?.code)?reason.code:'MODEL_IMAGE_PROBE_FAILED');}
  finally{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);controller.abort();}
 }
}
