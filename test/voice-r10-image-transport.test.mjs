import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {inflateSync} from 'node:zlib';
import {ModelRouter} from '../src/model-router.mjs';

const WIRE_LIMIT=1024*1024;
const digits=['11111/10001/10001/10001/10001/10001/11111','00100/01100/00100/00100/00100/00100/01110','11111/00001/00001/11111/10000/10000/11111','11111/00001/00001/11111/00001/00001/11111','10001/10001/10001/11111/00001/00001/00001','11111/10000/10000/11111/00001/00001/11111','11111/10000/10000/11111/10001/10001/11111','11111/00001/00010/00100/01000/01000/01000','11111/10001/10001/11111/10001/10001/11111','11111/10001/10001/11111/00001/00001/11111'];
// Only the external HTTP fixture reads pixels; it cannot access the host answer.
function readAnswer(body){
 const parts=body.messages?.[0]?.content??body.input?.[0]?.content??body.contents?.[0]?.parts,item=parts.find(part=>part.image_url||part.source||part.inlineData);
 const data=item.inlineData?.data??item.source?.data??(typeof item.image_url==='string'?item.image_url:item.image_url.url).split(',')[1],png=Buffer.from(data,'base64'),chunks=[];let width,height;
 for(let at=8;at<png.length;){const size=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),bytes=png.subarray(at+8,at+8+size);if(type==='IHDR'){width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);}if(type==='IDAT')chunks.push(bytes);at+=size+12;}
 const pixels=inflateSync(Buffer.concat(chunks)),ink=(x,y)=>pixels[y*(width+1)+x+1]<128,runs=[];
 for(let x=0;x<width;x++)if(Array.from({length:height},(_,y)=>y).some(y=>ink(x,y))){if(!runs.length||x>runs.at(-1).at(-1)+1)runs.push([x]);else runs.at(-1).push(x);}
 assert.equal(runs.length,6);return runs.map(run=>{let top=0;while(!run.some(x=>ink(x,top)))top++;for(let digit=0;digit<10;digit++){const grid=digits[digit].split('/'),trim=Math.min(...grid.map(row=>row.indexOf('1')).filter(n=>n>=0));if(grid.every((row,y)=>[...row].slice(trim).every((value,x)=>ink(run[0]+x*8,top+y*8)===(value==='1'))))return String(digit);}throw Error('Unreadable fixture PNG');}).join('');
}
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const usage=protocol=>protocol==='gemini'?{promptTokenCount:20,candidatesTokenCount:6,totalTokenCount:26}:protocol==='chat-completions'?{prompt_tokens:20,completion_tokens:6,total_tokens:26}:{input_tokens:20,output_tokens:6,total_tokens:26};
function jsonReply(protocol,text,{opaque='',length=false}={}){
 if(protocol==='anthropic')return {id:opaque,type:'message',content:[{type:'text',text}],stop_reason:length?'max_tokens':'end_turn',usage:usage(protocol)};
 if(protocol==='responses')return {id:opaque,status:length?'incomplete':'completed',...(length?{incomplete_details:{reason:'max_output_tokens'}}:{}),output:[{type:'message',content:[{type:'output_text',text}]}],usage:usage(protocol)};
 if(protocol==='gemini')return {responseId:opaque,candidates:[{content:{parts:[{text}]},finishReason:length?'MAX_TOKENS':'STOP'}],usageMetadata:usage(protocol)};
 return {id:opaque,choices:[{message:{content:text},finish_reason:length?'length':'stop'}],usage:usage(protocol)};
}
function sseReply(protocol,text,{opaque='',prefix='',length=false}={}){
 let rows;
 if(protocol==='anthropic')rows=[{type:'message_start',message:{id:opaque,usage:{input_tokens:20}}},{type:'content_block_delta',delta:{type:'text_delta',text}},{type:'message_delta',delta:{stop_reason:length?'max_tokens':'end_turn'},usage:{output_tokens:6}},{type:'message_stop'}];
 else if(protocol==='responses')rows=[{type:'response.created',response:{id:opaque}},{type:'response.output_text.delta',delta:text},length?{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:usage(protocol)}}:{type:'response.completed',response:{status:'completed',usage:usage(protocol)}}];
 else if(protocol==='gemini')rows=[{responseId:opaque,candidates:[{content:{parts:[{text}]},finishReason:length?'MAX_TOKENS':'STOP'}],usageMetadata:usage(protocol)}];
 else rows=[{id:opaque,choices:[{delta:{content:text},finish_reason:null}]},{choices:[{delta:{},finish_reason:length?'length':'stop'}]},{choices:[],usage:usage(protocol)}];
 return prefix+rows.map(event).join('')+'data: [DONE]\n\n';
}
async function fixture(t,{protocol='chat-completions',respond}={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'voice-r10-wire-')),requests=[],usages=[],audits=[],state={};
 const router=new ModelRouter({dataRoot,codex:{defaultModel:'fixture',enabled:false,setEnabled(value){this.enabled=value;},listModels:()=>[],close(){}},crypto:{isEncryptionAvailable:()=>false},timeoutMs:1500,onUsage:value=>usages.push(value),audit:value=>audits.push(value),fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body),answer=readAnswer(body);requests.push({body,url});return respond({body,answer,init,state});
 }});
 await router.ready;const saved=await router.save({kind:'custom',protocol,baseUrl:'http://127.0.0.1:1',model:'fixture'});await router.activate(saved.id);router.setEnabled(true);
 t.after(async()=>{router.close();assert.equal(dirname(dataRoot),resolve(tmpdir()));await rm(dataRoot,{recursive:true,force:true});});
 return {router,profile:router.captureConnection(),requests,usages,audits,state,options:(attemptId='r10-start',extra={})=>({attemptId,scope:{pluginId:'bili-fixture',lifeId:'life-fixture'},activityOriginId:'fixture-origin',checkCurrent:()=>true,...extra})};
}
const response=(wire,text)=>new Response(text,{headers:{'content-type':wire==='SSE'?'text/event-stream':'application/json'}});

function diagnostic(f){return f.audits.find(value=>value.type==='api-request');}
function assertFiniteAudit(f,{format,wireBytes,answerBytes=6,budgetLayer=null,limit=WIRE_LIMIT,errorCode=null,completed=true}){
 const audit=diagnostic(f);assert.equal(audit.format,format);assert.equal(audit.wireBytes,wireBytes);assert.equal(audit.answerBytes,answerBytes);assert.equal(audit.budgetLayer,budgetLayer);assert.equal(audit.limit,limit);assert.equal(audit.errorCode,errorCode);assert.equal(audit.completed,completed);
 // Existing accounting identity retains its address; the added diagnostic
 // fields checked above are only fixed labels, finite byte counts and codes.
 const serialized=JSON.stringify([...f.audits,...f.usages]);assert.ok(!serialized.includes('opaque-id-'));assert.ok(!serialized.includes('data:image/'));assert.ok(!serialized.includes('six digits'));
}

for(const protocol of ['chat-completions','responses','anthropic','gemini'])for(const format of ['SSE','JSON'])test('R10 real Router '+protocol+' '+format+' accepts bounded opaque protocol envelopes with six visible digits',async t=>{
 let wire;
 const f=await fixture(t,{protocol,respond:({answer})=>{const options={opaque:'opaque-id-'+ 'x'.repeat(20000)};wire=format==='SSE'?sseReply(protocol,answer,options):JSON.stringify(jsonReply(protocol,answer,options));return response(format,wire);}});
 const result=await f.router.ensureImageCapability(f.profile,f.options());
 assert.equal(result.supported,true,JSON.stringify(result));assert.ok(Buffer.byteLength(wire)>16*1024);assert.equal(f.requests.length,1);assert.equal(f.usages.length,1);
 const body=f.requests[0].body;assert.equal(body.max_tokens??body.max_output_tokens??body.generationConfig.maxOutputTokens,128);assert.equal(f.usages[0].usage.total,26);
 assertFiniteAudit(f,{format,wireBytes:Buffer.byteLength(wire)});
});

test('R10 many short SSE delta events count envelope bytes without making them answer bytes',async t=>{
 let wire;const f=await fixture(t,{respond:({answer})=>{
  const empty=Array.from({length:300},(_,sequence)=>event({id:'opaque-id-'+sequence,choices:[{delta:{content:''}}]})).join('');
  const visible=[...answer].map(content=>event({choices:[{delta:{content}}]})).join('');
  wire=empty+visible+sseReply('chat-completions','');return response('SSE',wire);
 }});
 assert.equal((await f.router.ensureImageCapability(f.profile,f.options())).supported,true);assert.ok(Buffer.byteLength(wire)>16*1024);assert.equal(f.requests.length,1);assertFiniteAudit(f,{format:'SSE',wireBytes:Buffer.byteLength(wire)});
});

test('R10 non-answer reasoning metadata remains counted in bounded wire and excluded from the answer',async t=>{
 let wire;const f=await fixture(t,{protocol:'responses',respond:({answer})=>{
  const prefix=event({type:'response.output_item.added',item:{type:'reasoning',encrypted_content:'opaque-id-'+ 'r'.repeat(20000)}});
  wire=sseReply('responses',answer,{prefix});return response('SSE',wire);
 }});
 assert.equal((await f.router.ensureImageCapability(f.profile,f.options())).supported,true);assertFiniteAudit(f,{format:'SSE',wireBytes:Buffer.byteLength(wire)});
});

for(const format of ['SSE','JSON'])test('R10 '+format+' total wire over one MiB is unknown and never retries the same attempt',async t=>{
 let wire;const f=await fixture(t,{respond:({answer})=>{wire=format==='SSE'?sseReply('chat-completions',answer,{prefix:(': '+ 'm'.repeat(1024)+'\n\n').repeat(1025)}):JSON.stringify(jsonReply('chat-completions',answer,{opaque:'opaque-id-'+ 'x'.repeat(WIRE_LIMIT)}));return response(format,wire);}});
 const first=await f.router.ensureImageCapability(f.profile,f.options());assert.equal(first.code,'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE');assert.equal(f.router.imageCapability(f.profile).supported,false);
 assert.equal((await f.router.ensureImageCapability(f.profile,f.options())).code,first.code);assert.equal(f.requests.length,1);assert.equal(f.usages.length,1);assert.equal(f.usages[0].usage.total,null);
 assertFiniteAudit(f,{format,wireBytes:Buffer.byteLength(wire),answerBytes:0,budgetLayer:'wire',errorCode:first.code,completed:false});
});

test('R10 a single oversized unterminated SSE event closes its response before parsing it',async t=>{
 const f=await fixture(t,{respond:({state})=>response('SSE',new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'opaque-id-'+ 'x'.repeat(WIRE_LIMIT)})));},cancel(){state.cancelled=true;}}))});
 const result=await f.router.ensureImageCapability(f.profile,f.options());assert.equal(result.code,'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE');assert.equal(f.state.cancelled,true);assert.equal(f.requests.length,1);
 const audit=diagnostic(f);assert.ok(audit.wireBytes>WIRE_LIMIT);assert.equal(audit.answerBytes,0);assert.equal(audit.budgetLayer,'wire');assert.equal(audit.limit,WIRE_LIMIT);assert.equal(audit.errorCode,result.code);assert.equal(audit.completed,false);
});

for(const format of ['SSE','JSON'])test('R10 '+format+' retains the 4096 UTF-8 visible-answer limit below the wire limit',async t=>{
 let wire;const text='界'.repeat(1366),f=await fixture(t,{respond:()=>{wire=format==='SSE'?sseReply('chat-completions',text):JSON.stringify(jsonReply('chat-completions',text));return response(format,wire);}});
 const result=await f.router.ensureImageCapability(f.profile,f.options());assert.equal(result.code,'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE');assert.equal(f.requests.length,1);assert.ok(Buffer.byteLength(wire)<16*1024);assert.equal(f.router.imageCapability(f.profile).supported,false);
 assertFiniteAudit(f,{format,wireBytes:Buffer.byteLength(wire),answerBytes:4098,budgetLayer:'answer',limit:4096,errorCode:result.code,completed:format==='JSON'});
});

test('R10 cancellation while bounded SSE metadata streams closes the body and cannot save late success',async t=>{
 let entered,closed;const ready=new Promise(resolve=>entered=resolve),bodyClosed=new Promise(resolve=>closed=resolve),controller=new AbortController();
 const f=await fixture(t,{respond:({init,state})=>response('SSE',new ReadableStream({start(stream){
  const abort=()=>{state.closed=true;stream.error(init.signal.reason);closed();};
  init.signal.addEventListener('abort',abort,{once:true});stream.enqueue(new TextEncoder().encode(': bounded metadata\n\n'));entered();
 },cancel(){state.closed=true;closed();}}))});
 const pending=f.router.ensureImageCapability(f.profile,f.options('cancelled',{signal:controller.signal}));await ready;controller.abort();
 const result=await pending;await bodyClosed;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(result.code,'ABORT_ERR');assert.equal(f.state.closed,true);assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal(f.requests.length,1);assert.equal(f.usages.length,1);assert.equal(diagnostic(f).errorCode,'ABORT_ERR');
});

test('R10 correct digits with a length terminal remain unknown after one POST and retain tail usage',async t=>{
 let wire;const f=await fixture(t,{respond:({answer})=>{wire=sseReply('chat-completions',answer,{length:true});return response('SSE',wire);}});
 const result=await f.router.ensureImageCapability(f.profile,f.options());assert.equal(result.code,'MODEL_OUTPUT_TRUNCATED');assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal(f.requests.length,1);assert.equal(f.usages[0].usage.total,26);
 assert.equal((await f.router.ensureImageCapability(f.profile,f.options())).code,result.code);assert.equal(f.requests.length,1);assertFiniteAudit(f,{format:'SSE',wireBytes:Buffer.byteLength(wire),errorCode:result.code});
});

test('R10 six correct digits do not resolve before the normal terminal and following usage arrive',async t=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve);let settled=false;
 const f=await fixture(t,{respond:({answer})=>response('SSE',new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(event({choices:[{delta:{content:answer}}]})));release=()=>{controller.enqueue(new TextEncoder().encode(sseReply('chat-completions','')));controller.close();};entered();}}))});
 const pending=f.router.ensureImageCapability(f.profile,f.options()).then(value=>{settled=true;return value;});await ready;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release();
 assert.equal((await pending).supported,true);assert.equal(f.requests.length,1);assert.equal(f.usages[0].usage.total,26);assert.equal(diagnostic(f).completed,true);
});
