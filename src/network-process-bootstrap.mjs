// Preloaded only in the host-owned DSH child. Resolve every destination over
// the child's existing private IPC, before its application/SDK starts.
import http from 'node:http';import https from 'node:https';
import {createWorkerNetwork} from './network-worker.mjs';import {windowsSystemCAs} from './network-node.mjs';
const config=process.env.AI_BUDDY_NETWORK_SETTINGS;
if(config&&process.send){
 const port={postMessage:value=>process.send(value),on:(event,handler)=>process.on(event,handler),removeListener:(event,handler)=>process.removeListener(event,handler)};
 const network=createWorkerNetwork(port,JSON.parse(config));
 globalThis.fetch=network.fetch;
 function agentFor(implementation,protocol){return new class extends implementation.Agent{
  addRequest(request,options){
   const host=options.hostname??options.host,authority=String(host).includes(':')&&!String(host).startsWith('[')?'['+host+']':host;
   const url=protocol+'//'+authority+(options.port?':'+options.port:'')+(options.path??'/');
   void network.resolveRoutes(url).then(routes=>{if(request.destroyed)return;const route=routes[0],proxyEnv=route.kind==='direct'?{}:{HTTP_PROXY:route.url,HTTPS_PROXY:route.url,NO_PROXY:''};const agent=new implementation.Agent({keepAlive:false,proxyEnv,ca:windowsSystemCAs()});request.once('close',()=>agent.destroy());agent.addRequest(request,options);},cause=>request.destroy(cause));
  }
 };}
 http.globalAgent=agentFor(http,'http:');https.globalAgent=agentFor(https,'https:');
 process.once('disconnect',()=>network.close());
}
