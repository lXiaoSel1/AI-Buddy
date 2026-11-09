import {randomUUID} from 'node:crypto';
import {createNodeNetworkFetch} from './network-node.mjs';
import {NETWORK_DEFAULTS,normalizeNetworkSettings,downloadRequestPlan,proxyRoutes,isLoopback} from './network-settings.mjs';
export async function replyNetworkRoute(worker,row,network){
 if(row?.type!=='network-route')return false;
 try{const url=new URL(row.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid route URL');const routes=await network.resolveRoutes(url.href);worker.postMessage({type:'network-route-result',id:row.id,routes});}
 catch(error){try{worker.postMessage({type:'network-route-result',id:row.id,error:{code:error.code??'NETWORK_CONNECT_FAILED',message:'系统代理解析失败'}});}catch{}}return true;
}
export function createWorkerNetwork(port,config,{unwrap=value=>value}={}){
 const normalize=value=>normalizeNetworkSettings(Object.fromEntries(Object.keys(NETWORK_DEFAULTS).map(key=>[key,(value.settings??value)[key]??NETWORK_DEFAULTS[key]])));
 let settings=normalize(config);const pending=new Map();
 const receive=value=>{const row=unwrap(value);if(row?.type==='network-configure'){settings=normalize(row.network);return;}if(row?.type!=='network-route-result')return;const saved=pending.get(row.id);if(!saved)return;pending.delete(row.id);clearTimeout(saved.timer);row.error?saved.reject(Object.assign(Error(row.error.message),{code:row.error.code})):saved.resolve(row.routes);};
 port.on('message',receive);
 async function resolveRoutes(url){if(isLoopback(url)||settings.mode==='direct')return [{kind:'direct'}];if(settings.mode==='manual')return proxyRoutes(settings.proxyUrl);return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('系统代理解析超时'),{code:'NETWORK_TIMEOUT'}));},30000);timer.unref?.();pending.set(id,{resolve,reject,timer});port.postMessage({type:'network-route',id,url});});}
 return {fetch:createNodeNetworkFetch({resolveRoute:resolveRoutes}),resolveRoutes,planDownload:(url,options)=>downloadRequestPlan(url,settings,options),close:()=>{port.removeListener('message',receive);for(const row of pending.values()){clearTimeout(row.timer);row.reject(Error('Network worker closed'));}pending.clear();}};
}
