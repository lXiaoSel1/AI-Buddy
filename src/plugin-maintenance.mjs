import {createPluginManager} from './plugin-manager.mjs';
import {createWorkerNetwork} from './network-worker.mjs';
const port=process.parentPort;if(!port)throw Error('Extension maintenance requires a host');
let manager=null,initializing=false,initialization=null,closing=false,serial=0,network=null,requests=0,pendingNetwork=null;const waiting=new Map();
function configureNetwork(value){network?.close();network=createWorkerNetwork(port,value??{},{unwrap:row=>row.data});}
function post(value){try{port.postMessage(value);}catch{}}
function busy(){if(closing)return Promise.resolve(true);const id=++serial;return new Promise(resolve=>{const timer=setTimeout(()=>{waiting.delete(id);resolve(true);},10000);waiting.set(id,{resolve,timer});post({type:'busy',id});});}
async function action(method,params){
 if(method==='close'){closing=true;for(const row of waiting.values()){clearTimeout(row.timer);row.resolve(true);}waiting.clear();try{await initialization;}catch{}try{await manager?.close();}finally{network?.close();}return true;}
 if(closing)throw Error('Extension maintenance is closing');
 if(method==='initialize'){if(manager||initializing)throw Error('Already initialized');if(!params||Object.keys(params).some(key=>!['root','dataRoot','appVersion','voiceTestFingerprint','network'].includes(key)))throw Error('Unsupported extension initialization');if(params.voiceTestFingerprint!==undefined&&!/^SHA256:[A-Za-z0-9+/]{43}$/.test(params.voiceTestFingerprint))throw Error('Invalid isolated voice trust');const{network:settings,...options}=params;configureNetwork(settings);initializing=true;initialization=createPluginManager({...options,fetchImpl:(...args)=>network.fetch(...args),planDownload:(...args)=>network.planDownload(...args),busy,onUpdate:value=>{if(!closing)post({type:'update',value});}});try{manager=await initialization;if(closing){await manager.close();throw Error('Extension maintenance is closing');}return manager.snapshot();}finally{initializing=false;}}
 if(!manager)throw Error('Extension maintenance not initialized');
 if(closing)throw Error('Extension maintenance is closing');
 if(method==='action')return manager.action(params);
 if(method==='prepareOffline')return manager.prepareOffline(params.directory,params.requests);
 if(method==='resolveInstalled')return manager.resolveInstalled(params.id,params.options);
 if(method==='resolveTrustedSource')return manager.resolveTrustedSource(params.sourceId);
 throw Error('Unknown extension maintenance operation');
}
port.on('message',({data})=>{if(data?.type==='network-configure'){if(!closing){if(requests||manager?.snapshot().operation)pendingNetwork=data.network;else configureNetwork(data.network);}return;}if(data?.type==='busy-result'){const row=waiting.get(data.id);if(row){waiting.delete(data.id);clearTimeout(row.timer);row.resolve(data.value===true);}}else if(data?.type==='request'){requests++;void action(data.method,data.params).then(result=>post({type:'response',id:data.id,result}),error=>post({type:'response',id:data.id,error:{message:error.message,code:error.code,host:error.host,retryOfficial:error.retryOfficial===true,originKnownMirror:error.originKnownMirror===true,technicalCode:error.technicalCode}})).finally(()=>{requests--;if(!requests&&pendingNetwork&&!closing&&!manager?.snapshot().operation){configureNetwork(pendingNetwork);pendingNetwork=null;}});}});
