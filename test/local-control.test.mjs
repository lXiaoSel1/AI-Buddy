import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {randomUUID} from 'node:crypto';
import {createLocalControlServer,requestLocalControl} from '../src/local-control.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,onRequest,options={}) {
 const pipe='\\\\.\\pipe\\whale-control-test-'+randomUUID(),errors=[];
 const server=createLocalControlServer({onRequest,onSocketError:e=>errors.push(e.code),...options});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
 t.after(()=>new Promise(resolve=>server.close(resolve)));return {pipe,errors};
}
function raw(pipe,send){return new Promise((resolve,reject)=>{const socket=connect(pipe,()=>send(socket));let text='';socket.setEncoding('utf8');socket.on('error',reject);socket.on('data',c=>text+=c);socket.on('end',()=>{try{resolve(text?JSON.parse(text):null);}catch(error){reject(error);}});});}

test('Client ending its write side before a delayed reply cannot crash the pipe server',async t=>{
 const {pipe}=await fixture(t,async request=>{await pause(50);return {message:request.message};});
 const early=await raw(pipe,s=>s.end(JSON.stringify({command:'echo',message:'鲸鱼娘'})+'\n'));
 // Windows named pipes may close both directions here; an already-disconnected
 // client cannot receive a reply. Server survival is the required behavior.
 if(early!==null)assert.deepEqual(early,{message:'鲸鱼娘'});
 await pause(80);
 assert.deepEqual(await requestLocalControl(pipe,{command:'echo',message:'still alive'}),{message:'still alive'});
});
test('Abrupt clients and timed-out responses leave the named-pipe server alive',async t=>{
 let requests=0;const {pipe}=await fixture(t,async()=>{requests++;await pause(90);return {payload:'x'.repeat(128000)};});
 for(let n=0;n<8;n++)await new Promise(resolve=>{const socket=connect(pipe,()=>{socket.write('{"command":"snapshot"}\n');setTimeout(()=>socket.destroy(),12);});socket.on('error',()=>{});socket.on('close',resolve);});
 await assert.rejects(requestLocalControl(pipe,{command:'snapshot'},{timeoutMs:12}),/timeout/);
 await pause(120);assert.ok(requests>=8);const response=await requestLocalControl(pipe,{command:'snapshot'});assert.equal(response.payload.length,128000);
});
test('Segmented UTF8 request and duplicate frames dispatch only one command',async t=>{
 let requests=0;const {pipe}=await fixture(t,async r=>{requests++;await pause(50);return {message:r.message};});
 const payload=Buffer.from('{"command":"echo","message":"鲸鱼娘"}\n');const split=payload.indexOf(Buffer.from('鲸'))+1;
 const response=await raw(pipe,s=>{s.write(payload.subarray(0,split));setTimeout(()=>{s.write(payload.subarray(split));s.write('{"command":"other"}\n');},10);});
 assert.equal(response.message,'鲸鱼娘');assert.equal(requests,1);
});
test('Malformed, truncated and oversized control requests do not execute actions',async t=>{
 let requests=0;const {pipe}=await fixture(t,()=>{requests++;return {ok:true};},{maxRequestBytes:64});
 assert.equal((await raw(pipe,s=>s.write('invalid\n'))).error,'Invalid local request');
 const partial=await raw(pipe,s=>s.end('{"command":"partial"'));if(partial!==null)assert.equal(partial.error,'Incomplete local request');
 assert.equal((await raw(pipe,s=>s.write('x'.repeat(100)))).error,'Local request too large');assert.equal(requests,0);
});
test('Rejected handlers and unserializable replies produce one error response',async t=>{
 const {pipe}=await fixture(t,r=>{if(r.command==='reject')throw new Error('fixture failure');const cyclic={};cyclic.self=cyclic;return cyclic;});
 assert.equal((await requestLocalControl(pipe,{command:'reject'})).error,'fixture failure');
 assert.match((await requestLocalControl(pipe,{command:'cycle'})).error,/circular/i);
});
