import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {ModelRouter} from '../src/model-router.mjs';

const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
// The fixture reads image pixels, independently of the production challenge code.
const digitRows=['11111/10001/10001/10001/10001/10001/11111','00100/01100/00100/00100/00100/00100/01110','11111/00001/00001/11111/10000/10000/11111','11111/00001/00001/11111/00001/00001/11111','10001/10001/10001/11111/00001/00001/00001','11111/10000/10000/11111/00001/00001/11111','11111/10000/10000/11111/10001/10001/11111','11111/00001/00010/00100/01000/01000/01000','11111/10001/10001/11111/10001/10001/11111','11111/10001/10001/11111/00001/00001/11111'];
function readDigits(data){
 const png=Buffer.from(data,'base64');assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);const chunks=[];let width,height;
 for(let at=8;at<png.length;){const size=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),bytes=png.subarray(at+8,at+8+size);if(type==='IHDR'){width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);assert.equal(bytes[9],0);}if(type==='IDAT')chunks.push(bytes);at+=size+12;}
 const pixels=inflateSync(Buffer.concat(chunks)),ink=(x,y)=>pixels[y*(width+1)+x+1]<128,columns=[];
 for(let x=0;x<width;x++)if(Array.from({length:height},(_,y)=>y).some(y=>ink(x,y)))columns.push(x);
 const runs=[];for(const x of columns){if(!runs.length||x>runs.at(-1).at(-1)+1)runs.push([x]);else runs.at(-1).push(x);}assert.equal(runs.length,6);
 return runs.map(run=>{let top=0;while(!run.some(x=>ink(x,top)))top++;const scale=8,left=run[0],first=ink(left,top);let best=null;for(let digit=0;digit<10;digit++){const grid=digitRows[digit].split('/'),trim=Math.min(...grid.map(row=>row.indexOf('1')).filter(n=>n>=0));if(grid.every((row,y)=>[...row].slice(trim).every((value,x)=>ink(left+x*scale,top+y*scale)===(value==='1')))){best=String(digit);break;}}assert.notEqual(best,null);return best;}).join('');
}
async function fixture(t,{handler,timeoutMs=1000,dataRoot,protocol='chat-completions'}={}){
 const requests=[],usages=[],audits=[];const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push({url:req.url,headers:req.headers,body});try{await handler?.({req,res,body,requests});if(res.writableEnded)return;const parts=body.messages?.[0]?.content??body.input?.[0]?.content??body.contents?.[0]?.parts;const item=parts.find(p=>p.image_url||p.source||p.inlineData),data=item.inlineData?.data??item.source?.data??(typeof item.image_url==='string'?item.image_url:item.image_url.url).split(',')[1],answer=readDigits(data);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:6}}));}catch(error){if(!res.writableEnded){res.statusCode=500;res.end('{}');}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const root=dataRoot??await mkdtemp(join(tmpdir(),'buddy-image-probe-'));
 const codex={defaultModel:'native',enabled:false,setEnabled(value){this.enabled=value;},async *stream(){throw Error('Native probing must remain unavailable');}};
 const router=new ModelRouter({dataRoot:root,codex,crypto,timeoutMs,onUsage:r=>usages.push(r),audit:r=>audits.push(r),searchPolicy:()=>{throw Error('Probe must not search');}});await router.ready;
 const saved=await router.save({kind:'custom',protocol,baseUrl:'http://127.0.0.1:'+server.address().port,model:'manual-model'});await router.activate(saved.id);router.setEnabled(true);
 t.after(async()=>{router.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!dataRoot)await rm(root,{recursive:true,force:true});});
 return {router,profile:router.captureConnection(),requests,usages,audits,dataRoot:root,codex,server};
}
const options=attemptId=>({attemptId,checkCurrent:()=>true,scope:{pluginId:'bili-fixture',lifeId:'life-1'},activityOriginId:'probe-origin'});

test('an unknown API model earns image evidence by answering only the host PNG challenge',async t=>{
 const f=await fixture(t);assert.equal(f.router.imageCapability(f.profile).reason,'MODEL_IMAGE_CAPABILITY_UNKNOWN');
 const capability=await f.router.ensureImageCapability(f.profile,options('start-one'));
 assert.equal(capability.supported,true);assert.equal(f.router.imageCapability(f.profile).supported,true);assert.equal(f.requests.length,1);assert.deepEqual(f.router.captureConnection().models,[]);
 const body=f.requests[0].body;assert.equal(body.max_tokens,128);assert.equal(body.messages.length,1);const answer=readDigits(body.messages[0].content[1].image_url.url.split(',')[1]);assert.ok(!body.messages[0].content[0].text.includes(answer));assert.ok(!f.requests[0].url.includes(answer));
 assert.equal(f.usages.length,1);assert.equal(f.usages[0].purpose,'image-capability-probe');assert.equal(f.usages[0].activityOriginId,'probe-origin');assert.equal(f.usages[0].usage.total,26);assert.ok(!JSON.stringify([...f.usages,...f.audits]).includes(body.messages[0].content[1].image_url.url));
});

test('successful API evidence survives restart without leaking or changing the model catalog',async t=>{
 const f=await fixture(t);assert.equal((await f.router.ensureImageCapability(f.profile,options('first-start'))).supported,true);
 const restarted=new ModelRouter({dataRoot:f.dataRoot,codex:f.codex,crypto});await restarted.ready;t.after(()=>restarted.close());
 assert.equal(restarted.imageCapability(restarted.captureConnection()).supported,true);assert.equal((await restarted.ensureImageCapability(restarted.captureConnection(),options('second-start'))).supported,true);assert.equal(f.requests.length,1);assert.deepEqual(restarted.captureConnection().models,[]);
 const {readFile}=await import('node:fs/promises'),raw=await readFile(join(f.dataRoot,'model-image-capabilities.json'),'utf8'),cache=JSON.parse(raw);
 assert.equal(cache.schemaVersion,1);assert.equal(cache.probeVersion,1);assert.equal(cache.records.length,1);assert.deepEqual(Object.keys(cache.records[0]).sort(),['checkedAt','key','provenAt','status']);assert.equal(cache.records[0].status,'supported');assert.match(cache.records[0].key,/^[0-9a-f]{64}$/);assert.ok(!raw.includes('manual-model'));assert.ok(!raw.includes(f.profile.baseUrl));assert.ok(!raw.includes(f.requests[0].body.messages[0].content[0].text));assert.ok(!raw.includes(f.requests[0].body.messages[0].content[1].image_url.url));
});

test('a 200 self-report never proves image support and one failed attempt cannot silently resubmit',async t=>{
 const f=await fixture(t,{handler:({res})=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Yes, I support images.'},finish_reason:'stop'}]}));}});
 const failed=await f.router.ensureImageCapability(f.profile,options('same-start'));assert.equal(failed.reason,'MODEL_IMAGE_PROBE_MISMATCH');assert.equal(f.router.imageCapability(f.profile).reason,'MODEL_IMAGE_CAPABILITY_UNKNOWN');
 assert.equal((await f.router.ensureImageCapability(f.profile,options('same-start'))).reason,'MODEL_IMAGE_PROBE_MISMATCH');assert.equal(f.requests.length,1);
 assert.equal((await f.router.ensureImageCapability(f.profile,options('new-user-start'))).reason,'MODEL_IMAGE_PROBE_MISMATCH');assert.equal(f.requests.length,2);
 const restarted=new ModelRouter({dataRoot:f.dataRoot,codex:f.codex,crypto});await restarted.ready;restarted.setEnabled(true);t.after(()=>restarted.close());assert.equal((await restarted.ensureImageCapability(restarted.captureConnection(),options('new-user-start'))).reason,'MODEL_IMAGE_PROBE_MISMATCH');assert.equal(f.requests.length,2);
});

test('concurrent authorized starts share one image submission and one success proof',async t=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);const f=await fixture(t,{handler:async()=>{enter();await gate;}});
 const first=f.router.ensureImageCapability(f.profile,options('start-a'));await entered;const second=f.router.ensureImageCapability(f.profile,options('start-b'));release();const results=await Promise.all([first,second]);assert.equal(results.every(value=>value.supported),true);assert.equal(f.requests.length,1);assert.equal(f.usages.length,1);
});

test('cancelling an in-flight challenge keeps a late correct answer from becoming evidence',async t=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);const f=await fixture(t,{handler:async()=>{enter();await gate;}}),controller=new AbortController();
 const pending=f.router.ensureImageCapability(f.profile,{...options('cancelled-start'),signal:controller.signal});await entered;controller.abort();release();const result=await pending;assert.equal(result.code,'ABORT_ERR');assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal((await f.router.ensureImageCapability(f.profile,options('cancelled-start'))).code,'ABORT_ERR');assert.equal(f.requests.length,1);
 assert.equal((await f.router.ensureImageCapability(f.profile,options('fresh-start'))).supported,true);assert.equal(f.requests.length,2);
});

test('the existing request timeout is a hard deadline with a distinct finite probe code',async t=>{
 const f=await fixture(t,{timeoutMs:80,handler:async({res})=>{res.setHeader('content-type','text/event-stream');res.flushHeaders();const timer=setInterval(()=>res.write(': still alive\n\n'),5);await new Promise(resolve=>res.once('close',resolve));clearInterval(timer);}}),started=performance.now();
 const result=await f.router.ensureImageCapability(f.profile,options('timeout-start'));assert.equal(result.code,'MODEL_IMAGE_PROBE_TIMEOUT');assert.ok(performance.now()-started<1000);assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal(f.requests.length,1);assert.equal((await f.router.ensureImageCapability(f.profile,options('timeout-start'))).code,'MODEL_IMAGE_PROBE_TIMEOUT');assert.equal(f.requests.length,1);
});

test('scope is checked before submission and after the response before success can be committed',async t=>{
 let current=true,checks=0;const f=await fixture(t,{handler:()=>{current=false;}}),scoped=attemptId=>({...options(attemptId),checkCurrent:async()=>{checks++;return current;}});
 const result=await f.router.ensureImageCapability(f.profile,scoped('scope-expired'));assert.equal(result.code,'MODEL_IMAGE_PROBE_STALE');assert.equal(f.router.imageCapability(f.profile).supported,false);assert.ok(checks>=2);assert.equal(f.requests.length,1);
 assert.equal((await f.router.ensureImageCapability(f.profile,scoped('still-stale'))).code,'MODEL_IMAGE_PROBE_STALE');assert.equal(f.requests.length,1);
});

test('a cancelled deduplicated caller invalidates the shared late result',async t=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);const f=await fixture(t,{handler:async()=>{enter();await gate;}}),controller=new AbortController();
 const first=f.router.ensureImageCapability(f.profile,options('shared-owner'));await entered;const second=f.router.ensureImageCapability(f.profile,{...options('shared-cancelled'),signal:controller.signal});controller.abort();release();const results=await Promise.all([first,second]);assert.deepEqual(results.map(r=>r.code),['ABORT_ERR','ABORT_ERR']);assert.equal(f.requests.length,1);assert.equal(f.router.imageCapability(f.profile).supported,false);
});

test('probe response buffering is bounded even when a provider ignores max_tokens',async t=>{
 const f=await fixture(t,{handler:({res})=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'x'.repeat(4097)},finish_reason:'stop'}]}));}});
 const result=await f.router.ensureImageCapability(f.profile,options('too-large'));assert.equal(result.code,'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE');assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal(f.requests.length,1);
});

test('catalog declarations and unknown native profiles never require or claim an API probe',async t=>{
 const f=await fixture(t);await f.router.saveModels(f.profile.id,[{id:f.profile.model,inputModalities:['text']}]);let profile=f.router.captureConnection();assert.equal((await f.router.ensureImageCapability(profile,options('text-only'))).reason,'MODEL_IMAGE_UNSUPPORTED');
 await f.router.saveModels(f.profile.id,[{id:f.profile.model,inputModalities:['text','image']}]);profile=f.router.captureConnection();assert.equal((await f.router.ensureImageCapability(profile,options('catalog-image'))).supported,true);assert.equal(f.router.resolveImageCapability().supported,true);
 const native=await f.router.save({kind:'codex',model:'native',reasoningEffort:null});await f.router.activate(native.id);profile=f.router.captureConnection();assert.equal((await f.router.ensureImageCapability(profile,options('native-unknown'))).code,'MODEL_IMAGE_PROBE_NATIVE_UNAVAILABLE');assert.equal(f.router.imageCapability(profile).supported,false);
 await f.router.saveModels(native.id,[{id:'native',inputModalities:['text','image']}]);assert.equal((await f.router.ensureImageCapability(f.router.captureConnection(),options('native-declared'))).supported,true);assert.equal(f.requests.length,0);
});

test('proof identity includes connection, provider, protocol, URL, model, encrypted key and selected catalog declaration',async t=>{
 const f=await fixture(t);assert.equal((await f.router.ensureImageCapability(f.profile,options('identity-proof'))).supported,true);
 for(const change of [{id:'other-id'},{kind:'openai'},{protocol:'responses'},{baseUrl:f.profile.baseUrl+'/other'},{model:'other-model'},{keyCiphertext:'changed-encrypted-key'},{models:[{id:f.profile.model,name:'new catalog declaration'}]}])assert.equal(f.router.imageCapability({...f.profile,...change}).supported,false,JSON.stringify(change));
 assert.equal(f.router.imageCapability({...f.profile,models:[{id:'unselected-model',inputModalities:['text']}]}).supported,true);assert.equal((await f.router.ensureImageCapability({...f.profile,protocol:'unsupported'},options('bad-protocol'))).reason,'MODEL_IMAGE_TRANSPORT_UNSUPPORTED');assert.equal(f.requests.length,1);
});

test('a concurrent catalog refresh invalidates the frozen probe before it can save success',async t=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);const f=await fixture(t,{handler:async()=>{enter();await gate;}}),pending=f.router.ensureImageCapability(f.profile,options('catalog-race'));await entered;
 await f.router.saveModels(f.profile.id,[{id:f.profile.model,inputModalities:['text']}]);release();assert.equal((await pending).code,'MODEL_IMAGE_PROBE_STALE');assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal(f.router.resolveImageCapability().reason,'MODEL_IMAGE_UNSUPPORTED');assert.equal(f.requests.length,1);
});

test('HTTP failure and truncation retain finite codes, omit provider output and never retry',async t=>{
 for(const kind of ['http','length']){const f=await fixture(t,{handler:({res})=>{res.setHeader('content-type','application/json');if(kind==='http'){res.statusCode=429;res.end(JSON.stringify({error:{message:'provider-private-output',code:'untrusted-private-code'}}));}else res.end(JSON.stringify({choices:[{message:{content:'123456'},finish_reason:'length'}]}));}}),code=kind==='http'?'API_HTTP_ERROR':'MODEL_OUTPUT_TRUNCATED';
  assert.equal((await f.router.ensureImageCapability(f.profile,options(kind))).code,code);assert.equal((await f.router.ensureImageCapability(f.profile,options(kind))).code,code);assert.equal(f.requests.length,1);assert.equal(f.router.imageCapability(f.profile).supported,false);assert.ok(!JSON.stringify([...f.audits,...f.usages]).includes('provider-private-output'));assert.ok(!JSON.stringify([...f.audits,...f.usages]).includes('untrusted-private-code'));
 }
});

test('even the correct image digits are unknown when the HTTP response has no normal terminal',async t=>{
 const f=await fixture(t,{handler:({res,body})=>{const answer=readDigits(body.messages[0].content[1].image_url.url.split(',')[1]);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:answer}}]}));}});
 assert.equal((await f.router.ensureImageCapability(f.profile,options('missing-terminal'))).supported,false);assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal(f.requests.length,1);
});


const probeAnswer=body=>{const parts=body.messages?.[0]?.content??body.input?.[0]?.content??body.contents?.[0]?.parts,item=parts.find(part=>part.image_url||part.source||part.inlineData);return readDigits(item.inlineData?.data??item.source?.data??(typeof item.image_url==='string'?item.image_url:item.image_url.url).split(',')[1]);};

test('review Anthropic JSON without stop_reason cannot create success proof',async t=>{
 const f=await fixture(t,{protocol:'anthropic',handler:({res,body})=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({content:[{type:'text',text:probeAnswer(body)}]}));}});
 const result=await f.router.ensureImageCapability(f.profile,options('review-anthropic-no-terminal'));assert.equal(result.code,'MODEL_IMAGE_PROBE_INCOMPLETE');assert.equal(f.router.imageCapability(f.profile).supported,false);
});

function reviewJson(protocol,answer,complete){
 if(protocol==='anthropic')return {type:'message',role:'assistant',content:[{type:'text',text:answer}],...(complete?{stop_reason:'end_turn'}:{})};
 if(protocol==='responses')return {object:'response',status:complete?'completed':'in_progress',output:[{type:'message',content:[{type:'output_text',text:answer}]}]};
 if(protocol==='gemini')return {candidates:[{content:{parts:[{text:answer}]},...(complete?{finishReason:'STOP'}:{})}]};
 return {choices:[{message:{content:answer},...(complete?{finish_reason:'stop'}:{})}]};
}
function reviewSse(protocol,answer,complete){
 const rows=protocol==='anthropic'?[{type:'content_block_delta',delta:{type:'text_delta',text:answer}},...(complete?[{type:'message_delta',delta:{stop_reason:'end_turn'}}]:[]),{type:'message_stop'}]:protocol==='responses'?[{type:'response.output_text.delta',delta:answer},...(complete?[{type:'response.completed',response:{status:'completed'}}]:[])]:protocol==='gemini'?[reviewJson(protocol,answer,complete)]:[{choices:[{delta:{content:answer}}]},...(complete?[{choices:[{delta:{},finish_reason:'stop'}]}]:[])];
 return rows.map(row=>'data: '+JSON.stringify(row)+'\n\n').join('')+'data: [DONE]\n\n';
}
for(const protocol of ['chat-completions','responses','anthropic','gemini'])for(const wire of ['JSON','SSE'])test('review '+protocol+' '+wire+' requires its own real terminal evidence',async t=>{
 for(const complete of [true,false]){
  const f=await fixture(t,{protocol,handler:({res,body})=>{res.setHeader('content-type',wire==='SSE'?'text/event-stream':'application/json');const answer=probeAnswer(body);res.end(wire==='SSE'?reviewSse(protocol,answer,complete):JSON.stringify(reviewJson(protocol,answer,complete)));}});
  const result=await f.router.ensureImageCapability(f.profile,options('review-'+wire+'-'+complete));assert.equal(result.supported,complete,JSON.stringify(result));if(!complete)assert.equal(result.code,'MODEL_IMAGE_PROBE_INCOMPLETE');assert.equal(f.router.imageCapability(f.profile).supported,complete);assert.equal(f.requests.length,1);
 }
});

for(const wire of ['JSON','SSE'])test('review raw '+wire+' response is stopped at one MiB before parsing ignored wrapper bytes',async t=>{
 const f=await fixture(t,{handler:({res,body})=>{res.setHeader('content-type',wire==='SSE'?'text/event-stream':'application/json');const answer=probeAnswer(body);res.end(wire==='SSE'?': '+ 'x'.repeat(1024*1024)+'\n\n'+reviewSse('chat-completions',answer,true):JSON.stringify({...reviewJson('chat-completions',answer,true),ignored:'x'.repeat(1024*1024)}));}});
 const result=await f.router.ensureImageCapability(f.profile,options('review-raw-'+wire));assert.equal(result.code,'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE');assert.equal(f.router.imageCapability(f.profile).supported,false);assert.equal(f.requests.length,1);
});

test('review queues interactive work before a waiting background image probe',async t=>{
 const order=[];let entered,release;const active=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),f=await fixture(t,{handler:()=>{order.push('probe');}});
 const blocking=f.router.runCaptured(f.profile,async()=>{entered();await gate;});await active;const probe=f.router.ensureImageCapability(f.profile,options('review-background'));
 await new Promise(resolve=>setImmediate(resolve));const chat=f.router.runCaptured(f.profile,()=>{order.push('chat');});release();await Promise.all([blocking,probe,chat]);assert.deepEqual(order,['chat','probe']);
});
