import {parentPort} from 'node:worker_threads';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,watch} from 'node:fs';
import {lstat,readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';

const stamp=info=>[info.dev,info.ino,info.nlink,info.size,info.mtimeNs,info.ctimeNs].join(':');
const rootIdentity=info=>[info.dev,info.ino].join(':');
const fault=(code,message)=>Object.assign(Error(message),{code});
const plans=new Map(),states=new Map(),controllers=new Map();
let tail=Promise.resolve();

function observe(destination,identity){
  // Watch ownership exists even when the first verification fails. Recording
  // it only after success would leave a recovered tree watched at the old inode.
  const state={identity,generation:0,checkedGeneration:-1,rootStamp:null,cache:new Map(),loaded:false,watching:false};
  // Local ReadDirectoryChangesW notifications are scoped to this tree. UNC
  // paths and unsupported/erroring watchers use a metadata pass instead.
  try{
    if(/^\\\\/.test(destination))return state;
    const watcher=state.watcher=watch(destination,{recursive:true},()=>{state.generation++;});
    state.watching=true;watcher.unref();
    watcher.on('error',()=>{state.generation++;state.watching=false;watcher.close();});
    watcher.on('close',()=>{state.watching=false;});
  }catch{}
  return state;
}

async function loadProof(selected,state,identity){
  state.loaded=true;
  if(!selected.proofFile)return;
  try{
    await assertPluginTreeNoLinks(selected.proofFile);
    const info=await lstat(selected.proofFile);
    if(!info.isFile()||info.nlink!==1)return;
    const value=JSON.parse(await readFile(selected.proofFile,'utf8'));
    if(value.schemaVersion!==1||value.proof!==selected.proof||value.destination!==selected.destination||value.rootIdentity!==identity||!Array.isArray(value.files)||value.files.length!==selected.files.length)return;
    const expected=new Map(selected.files.map(file=>[file.path,file.sha256]));
    for(const file of value.files){
      if(!file||expected.get(file.path)!==file.sha256||typeof file.identity!=='string'||state.cache.has(file.path)){state.cache.clear();return;}
      state.cache.set(file.path,{identity:file.identity,sha256:file.sha256});
    }
  }catch{state.cache.clear();}
}

async function persistProof(selected,cache,identity,signal){
  if(!selected.proofFile)return;
  await assertPluginTreeNoLinks(selected.proofFile);await mkdir(dirname(selected.proofFile),{recursive:true});signal.throwIfAborted();
  const temporary=selected.proofFile+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify({schemaVersion:1,proof:selected.proof,destination:selected.destination,rootIdentity:identity,
      files:[...cache].map(([path,value])=>({path,...value}))}),{flag:'wx',mode:0o600});
    signal.throwIfAborted();await rename(temporary,selected.proofFile);
  }finally{await rm(temporary,{force:true});}
}

async function verify(id,key,selected,signal){
  const {destination,files}=selected;await assertPluginTreeNoLinks(destination);signal.throwIfAborted();
  const root=await lstat(destination,{bigint:true});
  if(!root.isDirectory()||root.isSymbolicLink())throw fault('VOICE_ASSET_HASH','语音组件目录类型或链接已改变');
  const identity=rootIdentity(root);
  let state=states.get(key);
  if(state?.identity&&state.identity!==identity){state.watcher?.close();state=undefined;}
  if(!state){state=observe(destination,identity);states.set(key,state);}
  if(!state.loaded)await loadProof(selected,state,identity);
  // Yield once so already queued filesystem notifications revoke the fast path.
  await nextTurn();signal.throwIfAborted();
  if(state.watching&&state.rootStamp===stamp(root)&&state.checkedGeneration===state.generation){
    return {verification:'reused',checkedFiles:0,hashedFiles:0,hashedBytes:0,watching:true};
  }
  const generation=state.generation,cache=new Map(),directories=new Map([[destination,Promise.resolve()]]);
  function directory(path){
    if(directories.has(path))return directories.get(path);
    const pending=(async()=>{await directory(dirname(path));signal.throwIfAborted();const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw fault('VOICE_ASSET_HASH','语音组件目录类型或链接已改变');})();
    directories.set(path,pending);return pending;
  }
  let completedFiles=0,receivedBytes=0,lastProgress=0,hashedFiles=0,hashedBytes=0;
  const totalBytes=files.reduce((sum,file)=>sum+file.bytes,0);
  for(let start=0;start<files.length;start+=4){
    signal.throwIfAborted();
    const results=await Promise.allSettled(files.slice(start,start+4).map(async expected=>{
      signal.throwIfAborted();const path=join(destination,expected.path);await directory(dirname(path));
      let info;try{info=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')throw fault('VOICE_ASSET_MISSING','语音资源尚未准备');throw error;}
      if(!info.isFile()||info.nlink!==1n||info.size!==BigInt(expected.bytes))throw fault('VOICE_ASSET_HASH','语音资源大小或类型与清单不符');
      const identity=stamp(info),cached=state.cache.get(expected.path);
      if(cached?.identity!==identity||cached?.sha256!==expected.sha256){
        const hash=createHash('sha256');for await(const bytes of createReadStream(path,{signal}))hash.update(bytes);
        signal.throwIfAborted();
        if(identity!==stamp(await lstat(path,{bigint:true}))||hash.digest('hex')!==expected.sha256)throw fault('VOICE_ASSET_HASH','语音资源摘要与清单不符');
        hashedFiles++;hashedBytes+=expected.bytes;
      }
      cache.set(expected.path,{identity,sha256:expected.sha256});completedFiles++;receivedBytes+=expected.bytes;
      const now=Date.now();if(completedFiles===1||completedFiles===files.length||now-lastProgress>=100){lastProgress=now;parentPort.postMessage({id,type:'progress',value:{phase:'verifying',completedFiles,totalFiles:files.length,receivedBytes,totalBytes,hashedFiles,hashedBytes}});}
    }));
    const failure=results.find(value=>value.status==='rejected');if(failure){state.checkedGeneration=-1;throw failure.reason;}
  }
  signal.throwIfAborted();
  const after=await lstat(destination,{bigint:true});await nextTurn();signal.throwIfAborted();
  if(generation!==state.generation||stamp(root)!==stamp(after)){
    state.checkedGeneration=-1;throw fault('VOICE_ASSET_CHANGED','语音组件在校验期间发生变化，请重试');
  }
  await persistProof(selected,cache,identity,signal);signal.throwIfAborted();
  state.cache=cache;state.identity=identity;state.rootStamp=stamp(after);state.checkedGeneration=generation;
  return {verification:hashedFiles===files.length?'full':'metadata',checkedFiles:completedFiles,hashedFiles,hashedBytes,watching:state.watching};
}
parentPort.on('message',message=>{
  if(message.type==='cancel'){controllers.get(message.id)?.abort();return;}
  if(message.type!=='verify')return;
  const controller=new AbortController();controllers.set(message.id,controller);
  if(message.plan)plans.set(message.key,message.plan);
  const selected=plans.get(message.key);
  tail=tail.then(async()=>{try{
    if(!selected)throw fault('VOICE_ASSET_VERIFY','语音组件校验计划缺失');
    const value=await verify(message.id,message.key,selected,controller.signal);parentPort.postMessage({id:message.id,type:'done',value});
  }catch(error){const state=states.get(message.key);if(state)state.checkedGeneration=-1;parentPort.postMessage({id:message.id,type:'error',error:{name:error.name,code:error.code??'VOICE_ASSET_VERIFY',message:error.message}});}finally{controllers.delete(message.id);}});
});
