import {randomBytes,randomUUID} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';
import {join} from 'node:path';
import {Worker,threadId} from 'node:worker_threads';
import {createEconomyStore as openCore} from './companion-economy-store.mjs';
import {economyWrites} from './companion-economy-operations.mjs';
import {gameRulesRegistration} from './voice-games/rule-artifact.mjs';

const commits=channel('ai-buddy.companion.economy-sql');
const transportLost=Symbol('economy transport lost');
const receiptBusinessError=Symbol('economy receipt business error');
const fail=(message,code,cause)=>Object.assign(Error(message,{cause}),{code});
const lost=(cause,posted=false)=>Object.assign(Error('Economy writer did not acknowledge the request',{cause}),{[transportLost]:{posted}});
const reopen=cause=>fail('经济服务未能确认写入结果，请重新启动 AI 酱','ECONOMY_WORKER_REOPEN',cause);
const closed=()=>fail('投喂服务已经关闭','ECONOMY_CLOSED');
const workerFile=()=>typeof __dirname==='string'
 ? join(__dirname,'companion-economy-worker.mjs')
 : new URL('./companion-economy-worker.mjs',import.meta.url);

function startSession(data,{audit,workerFactory,workerTimeoutMs}){
 const worker=workerFactory(workerFile(),{workerData:data,execArgv:[]});
 let flight,ended=false,workerError;
 function finish(error,value){
  if(!flight)return;
  const current=flight;
  flight=undefined;
  clearTimeout(current.timer);
  current.signal?.removeEventListener('abort',current.cancel);
  if(error)current.reject(error);
  else current.resolve(value);
  if(!ended&&!current.keepAlive)worker.unref();
 }
 const exited=new Promise(resolve=>worker.once('exit',code=>{
  ended=true;
  finish(lost(workerError??Error('Economy worker exit code '+code),flight?.posted));
  resolve();
 }));
 worker.on('error',error=>{workerError=error;});
 worker.on('message',message=>{
  if(message.audit){audit(message.audit);return;}
  if(message.commit){commits.publish(message.commit);return;}
  if(message.requestId!==flight?.requestId)return;
  if(message.error){
   const {message:description,...details}=message.error;
   const error=Object.assign(Error(description),details);
   if(message.receiptBusinessError===true)error[receiptBusinessError]=true;
   finish(error);
  }else finish(null,message.value);
 });
 async function stop(){
  if(!ended)await worker.terminate();
  await exited;
 }
 function exchange(message,id=message.requestId,signal){
  if(ended)return Promise.reject(lost(workerError));
  if(signal?.aborted)return Promise.reject(fail('经济操作已取消','ECONOMY_GUARD_REJECTED'));
  return new Promise((resolve,reject)=>{
   worker.ref();
   const timer=setTimeout(()=>finish(lost(Error('Economy worker request timed out'),flight?.posted)),workerTimeoutMs);
   const cancel=()=>{
    // Rule registration has no durable write; tell the worker to discard its
    // late import before releasing the client queue for committed operations.
    try{worker.postMessage({op:'cancel',requestId:id});}catch{}
    finish(fail('经济操作已取消','ECONOMY_GUARD_REJECTED'));
   };
   flight={requestId:id,timer,resolve,reject,keepAlive:message?.op==='close',posted:false,signal,cancel};
   signal?.addEventListener('abort',cancel,{once:true});
   if(message)try{worker.postMessage(message);flight.posted=true;}catch(error){finish(lost(error));}
  });
 }
 return {ready:exchange(null,'ready'),send:exchange,exited,stop};
}

export async function createEconomyStore(dataRoot,{
 now=Date.now,audit,sqlClock,walMaintenanceIntervalMs,workerTimeoutMs=30_000,
 workerFactory=(url,options)=>new Worker(url,options)
}={}){
 let session,reader,artifact,closing,unavailable;
 let tail=Promise.resolve();
 function record(event){try{audit?.(event);}catch{}}
 async function connect(){
  const next=startSession({dataRoot,walMaintenanceIntervalMs,ruleArtifact:artifact},{audit:record,workerFactory,workerTimeoutMs});
  try{await next.ready;return next;}
  catch(error){await next.stop();throw error;}
 }
 async function stopWriter(){
  if(!session)return;
  try{await session.send({op:'close',requestId:randomUUID()});await session.exited;}
  finally{await session.stop();}
 }
 try{
  session=await connect();
  reader=openCore(dataRoot,{readOnly:true,now,sqlClock,audit:event=>record({...event,thread:'main',threadId})});
 }catch(error){
  try{reader?.close();}finally{try{await stopWriter();}catch{}}
  throw error;
 }

 function checkGuard(guard){
  if(!guard)return;
  const invalid=()=>fail('经济操作已失效','ECONOMY_GUARD_REJECTED');
  if(guard.constructor?.name==='AsyncFunction')throw invalid();
  const allowed=guard();
  if(allowed?.then){
   Promise.resolve(allowed).catch(()=>{});
   throw invalid();
  }
  if(allowed===false)throw invalid();
 }
 async function submit(message,guard,signal){
  if(signal?.aborted)throw fail('经济操作已取消','ECONOMY_GUARD_REJECTED');
  if(unavailable)throw unavailable;
  checkGuard(guard);
  try{return await session.send(message,undefined,signal);}
  catch(error){
   const transport=error[transportLost];
   if(!transport)throw error;
   const {retry,receipt}=economyWrites[message.op];
   try{
    await session.stop();
    if(transport.posted&&!retry)throw error;
    session=await connect();
    if(transport.posted&&receipt){
     const outcome=await session.send({...message,receiptOnly:true,observeCommits:false});
     if(outcome.committed)return outcome.value;
    }
   }catch(recoveryError){
    if(recoveryError[receiptBusinessError])throw recoveryError;
    unavailable=reopen(recoveryError);
    throw unavailable;
   }
   try{checkGuard(guard);}
   catch(recoveryError){
    if(!transport.posted||receipt)throw recoveryError;
    unavailable=reopen(recoveryError);
    throw unavailable;
   }
   try{return await session.send(message,undefined,signal);}
   catch(recoveryError){
    if(!recoveryError[transportLost])throw recoveryError;
    try{await session.stop();}finally{unavailable=reopen(recoveryError);}
    throw unavailable;
   }
  }
 }
 function enqueue(op,args,guard,onAck,signal){
  if(unavailable||closing)return Promise.reject(unavailable??closed());
  let request;
  try{
   request={op,args:structuredClone(args),requestId:randomUUID(),at:now(),observeCommits:commits.hasSubscribers};
   if(economyWrites[op].random)request.seed=randomBytes(32).toString('hex');
  }catch(error){return Promise.reject(error);}
  const result=tail.then(()=>submit(request,guard,signal)).then(value=>{onAck?.(value);return value;});
  tail=result.catch(()=>{});
  return result;
 }
 function write(op){
  const {arity}=economyWrites[op];
  return (...args)=>{
   const last=args.at(-1),guardOnly=last&&typeof last==='object'&&Object.keys(last).length===1&&typeof last.guard==='function';
   const options=args.length>arity||guardOnly?args.pop():undefined;
   return enqueue(op,args,options?.guard);
  };
 }

 const economy={...reader,games:{...reader.games,workerBacked:true}};
 for(const op of Object.keys(economyWrites)){
  if(op.startsWith('games.'))economy.games[op.slice(6)]=write(op);
  else economy[op]=write(op);
 }
 const {settings,getHunger,games:{binding,request}}=economy;
 economy.settings=(patch,options)=>patch===undefined?reader.settings():settings(patch,options);
 economy.getHunger=(scope,options,guard)=>options?.create===false?reader.getHunger(scope):getHunger(scope,options,guard);
 economy.games.binding=(value,options)=>typeof value==='string'?reader.games.binding(value):binding(value,options);
 economy.games.request=(value,options)=>typeof value==='string'?reader.games.request(value):request(value,options);
 economy.games.registerRules=(value,{guard,signal}={})=>{
  const metadata={path:value?.path,sha256:value?.sha256},module=value?.module;
  if(!module?.RULE_MANIFEST)return Promise.reject(fail('GAME_RULE_REGISTRATION_INVALID','GAME_RULE_REGISTRATION_INVALID'));
  return enqueue('games.registerRules',[metadata],guard,()=>{
   reader.games.registerRules(gameRulesRegistration({...metadata,module}));
   artifact=metadata;
  },signal);
 };
 economy.close=()=>{
  if(closing)return closing;
  closing=(async()=>{
   await tail;
   try{reader.close();}
   finally{
    if(unavailable)await session.stop();
    else await stopWriter();
   }
  })();
  return closing;
 };
 return economy;
}
