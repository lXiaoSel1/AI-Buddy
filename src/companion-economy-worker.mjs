import {createHmac} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';
import {parentPort,threadId,workerData} from 'node:worker_threads';
import {createEconomyStore} from './companion-economy-store.mjs';
import {economyWrites} from './companion-economy-operations.mjs';
import {businessReceiptCodes} from './companion-economy-error-codes.mjs';
import {importCachedGameRules,gameRulesRegistration} from './voice-games/rule-artifact.mjs';

const {dataRoot,walMaintenanceIntervalMs,ruleArtifact}=workerData;
const commits=channel('ai-buddy.companion.economy-sql');
const annotated=event=>({...event,thread:'economy-worker',threadId});
const audit=event=>parentPort.postMessage({audit:annotated(event)});
const commit=event=>parentPort.postMessage({commit:annotated(event)});
const failure=error=>({message:error.message,code:error.code,errcode:error.errcode,errstr:error.errstr});
const reply=(requestId,value)=>parentPort.postMessage({requestId,value});
const reject=(requestId,error,receiptBusinessError=false)=>parentPort.postMessage({requestId,error:failure(error),receiptBusinessError});

let at,seed,counter,store;
function draw(max){
 const range=0x1_0000_0000,limit=range-range%max;
 // Replay starts at counter zero, with the same host-generated secret seed.
 // Rejection sampling keeps the bound uniform during shuffling and seat choice.
 for(;;){
  const value=createHmac('sha256',seed).update(String(counter++)).digest().readUInt32BE(0);
  if(value<limit)return value%max;
 }
}
const registrations=new Map();
async function registerRules(artifact,pending){
 const module=await importCachedGameRules(artifact);
 if(pending?.cancelled)return;
 return store.games.registerRules(gameRulesRegistration({...artifact,module}));
}

try{
 store=createEconomyStore(dataRoot,{
  now:()=>at??Date.now(),audit,walMaintenanceIntervalMs,checkpointInWriter:true,randomInt:draw
 });
 if(ruleArtifact)await registerRules(ruleArtifact);
 reply('ready',true);
}catch(error){
 try{await store?.close();}catch{}
 store=undefined;
 reject('ready',error);
 parentPort.close();
}

if(store)parentPort.on('message',async message=>{
 const {op,args,requestId,observeCommits,receiptOnly}=message;
 if(op==='cancel'){
  const pending=registrations.get(requestId);
  if(pending)pending.cancelled=true;
  return;
 }
 // Rules import is asynchronous and nonpersistent. It must not own the
 // global SQL request context while a committed write or close proceeds.
 if(op==='games.registerRules'&&Array.isArray(args)&&args.length<=1&&!receiptOnly){
  const pending={cancelled:false};registrations.set(requestId,pending);
  try{const result=await registerRules(args[0],pending);if(!pending.cancelled)reply(requestId,result);}
  catch(error){if(!pending.cancelled)reject(requestId,error);}
  finally{registrations.delete(requestId);}
  return;
 }
 if(observeCommits)commits.subscribe(commit);
 try{
  if(op==='close'){
   try{await store.close();reply(requestId,true);}
   catch(error){reject(requestId,error);}
   finally{parentPort.close();}
   return;
  }
  if(!Object.hasOwn(economyWrites,op)||!Array.isArray(args)||args.length>economyWrites[op].arity||receiptOnly&&!economyWrites[op].receipt)
   throw Object.assign(Error('Economy worker operation is not allowed'),{code:'ECONOMY_OPERATION_DENIED'});
  at=message.at;
  seed=message.seed;
  counter=0;
  const game=op.startsWith('games.'),target=game?store.games:store;
  const perform=()=>target[game?op.slice(6):op](...args);
  reply(requestId,receiptOnly?store.reconcileReceipt(perform):perform());
 }catch(error){reject(requestId,error,receiptOnly===true&&error.errcode===undefined&&businessReceiptCodes.has(error.code));}
 finally{
  at=seed=undefined;
  if(observeCommits)commits.unsubscribe(commit);
 }
});
