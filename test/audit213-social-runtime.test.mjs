import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {buildManagedProcessGuard} from '../scripts/build-managed-process-guard.mjs';
const H=fileURLToPath(new URL('..',import.meta.url));
const baseline=process.env.AUDIT213_BASELINE_DIRECTORY;
const modulePath=name=>pathToFileURL(process.env.AUDIT213_BASELINE?baseline+name:H+'/src/'+name);
const {createBiliVision}=await import(modulePath('buddy-plugin-services/bili-vision.mjs'));
const {createSocialTransport}=await import(modulePath('buddy-plugin-services/social-transport.mjs'));
const {createQqLoginRuntime}=await import(modulePath('qq-login-runtime.mjs'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const scope={pluginId:'fixture',packageName:'@ai-buddy/qq-connect',accountRef:'fixture-account',accountBindingId:'123',bindingGeneration:1,characterId:'fixture',personaId:'fixture',lifeId:'fixture',operationId:'fixture'};

test('C5: numeric DOMException timeout retains preview frames and subtitle state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'audit213-vision-'));
 const vision=createBiliVision({directory,fetchImpl:async url=>new Response(String(url).startsWith('https://api.bilibili.com/')?JSON.stringify({code:0,data:{image:['https://i0.hdslb.com/fixture.jpg'],img_x_len:10,img_y_len:10,img_x_size:160,img_y_size:90,index:Array.from({length:100},(_,i)=>i*6)}}):png),analyzeFrames:async({cells})=>cells.map(()=>0),renderSheet:async()=>png,acquireMedia:async()=>{throw new DOMException('Fixture timeout','TimeoutError');}});
 try{const prepared=await vision.prepare({scope,video:{videoId:'BVfixture123',cid:123,duration:600},hasSubtitles:true});const sheet=await vision.read({scope,readingId:prepared.readingId});assert.equal(sheet.source,'preview');assert.equal(sheet.media.audio,'platform-subtitles');assert.equal(sheet.media.videoIssue,'BILI_MEDIA_TIMEOUT');assert.deepEqual(vision.resolve({scope,readingId:prepared.readingId,visualMaterialRefs:sheet.visualMaterialRefs})[0].bytes,png);}finally{await vision.close();}
});

async function social(){
 const dataRoot=await mkdtemp(join(tmpdir(),'audit213-inbox-'));await mkdir(join(dataRoot,'social-core'));
 const account={ref:'fixture-account',accountId:'123',platform:'qq',enabled:true,generation:1,httpUrl:'http://127.0.0.1:1',webSocketUrl:'ws://127.0.0.1:2'},sockets=[];
 class Socket extends EventTarget{constructor(){super();sockets.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}close(){this.closed=true;this.dispatchEvent(new Event('close'));}message(raw){const event=new Event('message');Object.defineProperty(event,'data',{value:JSON.stringify(raw)});this.dispatchEvent(event);}}
 const at=1700000000000,service=createSocialTransport({dataRoot,accounts:{get:()=>account,secret:()=>({}),subscribe:()=>()=>{}},now:()=>at,fetchImpl:async()=>Response.json({status:'ok',retcode:0,data:{user_id:123}}),WebSocketImpl:Socket});
 const binding=await service.open({connectionRef:account.ref,accountId:'123',newEventsOnly:true,eventFilter:{contacts:['456'],groups:[]}},scope);
 const raw=(id,other={})=>({post_type:'message',message_type:'private',self_id:'123',user_id:'456',sender:{user_id:'456'},message_id:String(id),time:at/1000,message:[{type:'text',data:{text:'Fixture'}}],...other});
 const events=(cursor=0,ackCursor=0)=>service.events({connectionId:binding.connectionId,accountId:'123',newEventsOnly:true,cursor,ackCursor,waitMs:0},scope);
 return {service,binding,socket:sockets[0],raw,events,at,dataRoot};
}
test('C7: non-allowlisted flood is filtered before queueing; accepted backlog survives beyond memory capacity',async()=>{
 const f=await social();try{for(let n=0;n<1100;n++)f.socket.message(f.raw('outside-'+n,{user_id:'999',sender:{user_id:'999'}}));assert.equal((await f.events()).events.length,0);for(let n=0;n<1101;n++)f.socket.message(f.raw(n));let cursor=0,total=0;for(let n=0;n<12;n++){const batch=await f.events(cursor,cursor);total+=batch.events.length;cursor=batch.cursor;}assert.equal(total,1101);assert.notEqual(f.socket.closed,true);assert.equal((await f.events(cursor,cursor)).events.length,0);}finally{await f.service.close();}
});
test('C10: future message produces a visible clock warning without weakening freshness checks',async()=>{
 const f=await social();try{f.socket.message(f.raw('future',{time:f.at/1000+31}));let batch=await f.events();assert.equal(batch.events.length,0);assert.equal(batch.transportStatus?.code,'QQ_CLOCK_SKEW');f.socket.message(f.raw('normal'));batch=await f.events();assert.equal(batch.events.length,1);assert.equal(batch.events[0].message_id,'normal');}finally{await f.service.close();}
});

for(const mode of ['ipc-disconnect','ignore-shutdown'])test('C8: exact owned process is stopped after '+mode+'; same executable sibling stays alive',{timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'audit213-qq-process-')),runtime=join(directory,'runtime');await mkdir(runtime);
 buildManagedProcessGuard(H,directory);
 const script=join(directory,'fixture.mjs');await writeFile(script,`import http from 'node:http';import {readFileSync} from 'node:fs';import {join} from 'node:path';const config=JSON.parse(readFileSync(join(process.env.NAPCAT_WORKDIR,'config','webui.json')));const server=http.createServer((req,res)=>{res.setHeader('connection','close');res.end(JSON.stringify({code:0,data:req.url.endsWith('auth/login')?{Credential:'fixture'}:{isLogin:false,isOffline:false}}));});server.listen(config.port,'127.0.0.1',()=>{if(process.argv[2]==='ipc-disconnect')process.disconnect();});process.on('message',()=>{});setInterval(()=>{},1000);`);
 const original=childProcess.spawn,children=[];let spawned;const started=new Promise(resolve=>spawned=resolve);
 childProcess.spawn=function(command,args,options){if(String(command).endsWith('node.exe')){const child=original(process.execPath,[script,mode],{...options,env:{...options.env,ELECTRON_RUN_AS_NODE:'1'}});children.push(child);spawned(child);return child;}return original(command,args,options);};syncBuiltinESMExports();
 const sibling=original(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore'});
 let ready;const admitted=new Promise(resolve=>ready=resolve);
 const driver=createQqLoginRuntime({dataRoot:directory,build:directory,accounts:{get:()=>null,list:()=>[]},component:{ensure:async()=>runtime,info:()=>({})},stopTimeoutMs:30,onState:event=>{if(event?.type==='guard-ready')ready();}});
 const starting=driver.start({attemptId:'fixture-owned-'+mode,signal:new AbortController().signal});starting.catch(()=>{});
 try{const owned=await started;if(!process.env.AUDIT213_BASELINE)await admitted;await new Promise(r=>setTimeout(r,1000));await driver.stop();assert.ok(owned.exitCode!==null||owned.signalCode!==null);assert.equal(sibling.exitCode,null);await assert.rejects(starting);}
 finally{childProcess.spawn=original;syncBuiltinESMExports();for(const child of children)if(child.exitCode===null)child.kill();sibling.kill();await Promise.allSettled([starting,driver.close()]);}
});
