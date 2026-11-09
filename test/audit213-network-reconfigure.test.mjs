import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerNetwork} from '../src/network-worker.mjs';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
test('an existing runtime accepts a host configuration change for future routes without changing an earlier capture',async()=>{
 const port=new EventEmitter();port.postMessage=()=>assert.fail('manual routing must not request a PAC result');
 const network=createWorkerNetwork(port,{mode:'manual',proxyUrl:'http://first.example:8080'});
 const first=await network.resolveRoutes('https://api.example');
 port.emit('message',{type:'network-configure',network:{mode:'manual',proxyUrl:'http://second.example:8080'}});
 assert.equal(first[0].url,'http://first.example:8080');assert.equal((await network.resolveRoutes('https://api.example'))[0].url,'http://second.example:8080');
 port.emit('message',{type:'network-configure',network:{mode:'direct'}});assert.deepEqual(await network.resolveRoutes('https://api.example'),[{kind:'direct'}]);network.close();
});
test('saving network settings reaches the instantiated plugin backends rather than only the maintenance utility',async()=>{
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8'),platform=await readFile(new URL('../src/plugin-platform.mjs',import.meta.url),'utf8'),backend=await readFile(new URL('../src/dsh-platform/backend.mjs',import.meta.url),'utf8');
 assert.match(main,/await plugins\?\.configureNetwork\?\.\(\)/);assert.match(platform,/currentBackend[^;]+configureNetwork/s);assert.match(backend,/type:'network-configure'/);
});

test('the same real preloaded Node child switches future fetches from manual proxy A to B', {timeout:15000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'audit213-network-child-')),requestsA=[],requestsB=[];
 const proxy=name=>createServer((request,response)=>{(name==='A'?requestsA:requestsB).push(request.url);if(request.url!=='http://destination.invalid/path'){response.writeHead(403);response.end();return;}response.writeHead(200,{'content-type':'text/plain','connection':'close'});response.end('proxy-'+name);});
 const first=proxy('A'),second=proxy('B');
 const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
 const proxyA=await listen(first),proxyB=await listen(second),script=join(directory,'child.mjs');
 await writeFile(script,`process.on('message',async row=>{
  if(row?.type==='network-configure'){process.send({type:'fixture-configured',id:row.id,pid:process.pid});return;}
  if(row?.type==='fixture-stop'){process.disconnect();setImmediate(()=>process.exit(0));return;}
  if(row?.type!=='fixture-fetch')return;
  try{const response=await fetch('http://destination.invalid/path',{signal:AbortSignal.timeout(5000)});process.send({type:'fixture-result',id:row.id,pid:process.pid,status:response.status,body:await response.text()});}
  catch(error){process.send({type:'fixture-result',id:row.id,pid:process.pid,error:{name:error.name,code:error.code??null}});}
 });process.send({type:'fixture-ready',pid:process.pid,node:process.versions.node});\n`);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_USE_SYSTEM_CA','NODE_USE_ENV_PROXY'].includes(key.toUpperCase())));
 const child=spawn(process.execPath,['--import',new URL('../src/network-process-bootstrap.mjs',import.meta.url).href,script],{cwd:directory,env:{...env,AI_BUDDY_NETWORK_SETTINGS:JSON.stringify({mode:'manual',proxyUrl:proxyA})},windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',()=>{});
 const exited=new Promise(resolve=>child.once('close',resolve));
 function receive(type,id){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>finish(Error('Owned child fixture timed out: '+type)),7000);
  const message=row=>{if(row?.type===type&&(id===undefined||row.id===id))finish(null,row);},exit=()=>finish(Error('Owned child exited before '+type+': '+stderr)),error=cause=>finish(cause);
  function finish(cause,value){clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',exit);child.removeListener('error',error);cause?reject(cause):resolve(value);}
  child.on('message',message);child.once('exit',exit);child.once('error',error);
 });}
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null){if(child.connected)child.send({type:'fixture-stop'});const stopped=await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);if(!stopped){child.kill();await exited;}}
  first.closeAllConnections();second.closeAllConnections();await Promise.all([new Promise(resolve=>first.close(resolve)),new Promise(resolve=>second.close(resolve))]);await rm(directory,{recursive:true,force:true});
 });
 const ready=await receive('fixture-ready');
 const initialResult=receive('fixture-result','first');child.send({type:'fixture-fetch',id:'first'});const initial=await initialResult;
 assert.equal(initial.status,200);assert.equal(initial.body,'proxy-A');assert.equal(initial.pid,ready.pid);
 const configured=receive('fixture-configured','configure');child.send({type:'network-configure',id:'configure',network:{mode:'manual',proxyUrl:proxyB}});assert.equal((await configured).pid,ready.pid);
 const nextResult=receive('fixture-result','second');child.send({type:'fixture-fetch',id:'second'});const next=await nextResult;
 assert.equal(next.status,200);assert.equal(next.body,'proxy-B');assert.equal(next.pid,ready.pid);
 assert.deepEqual(requestsA,['http://destination.invalid/path']);assert.deepEqual(requestsB,['http://destination.invalid/path']);
 if(process.env.AI_BUDDY_NETWORK_EVIDENCE)await writeFile(process.env.AI_BUDDY_NETWORK_EVIDENCE,JSON.stringify({node:ready.node,initialPid:initial.pid,secondPid:next.pid,sameChild:true,initialProxy:'A',secondProxy:'B',requestsA,requestsB},null,2)+'\n');
});
