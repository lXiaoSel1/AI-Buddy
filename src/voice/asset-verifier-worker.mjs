import {parentPort} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';

const stamp=info=>[info.dev,info.ino,info.nlink,info.size,info.mtimeNs,info.ctimeNs].join(':');
const fault=(code,message)=>Object.assign(Error(message),{code});
const plans=new Map(),verified=new Map(),controllers=new Map();
let tail=Promise.resolve();
async function verify(id,selected,signal){
  const {destination,files}=selected;await assertPluginTreeNoLinks(destination);signal.throwIfAborted();
  const directories=new Map([[destination,Promise.resolve()]]);
  function directory(path){
    if(directories.has(path))return directories.get(path);
    const pending=(async()=>{await directory(dirname(path));signal.throwIfAborted();const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw fault('VOICE_ASSET_HASH','语音组件目录类型或链接已改变');})();
    directories.set(path,pending);return pending;
  }
  let completedFiles=0,receivedBytes=0,lastProgress=0;
  const totalBytes=files.reduce((sum,file)=>sum+file.bytes,0);
  for(let start=0;start<files.length;start+=4){
    signal.throwIfAborted();
    const results=await Promise.allSettled(files.slice(start,start+4).map(async expected=>{
      signal.throwIfAborted();const path=join(destination,expected.path);await directory(dirname(path));
      let info;try{info=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')throw fault('VOICE_ASSET_MISSING','语音资源尚未准备');throw error;}
      if(!info.isFile()||info.nlink!==1n||info.size!==BigInt(expected.bytes))throw fault('VOICE_ASSET_HASH','语音资源大小或类型与清单不符');
      const identity=stamp(info),cached=verified.get(path);
      if(cached?.identity!==identity||cached?.sha256!==expected.sha256){
        const hash=createHash('sha256');for await(const bytes of createReadStream(path,{signal}))hash.update(bytes);
        signal.throwIfAborted();
        if(identity!==stamp(await lstat(path,{bigint:true}))||hash.digest('hex')!==expected.sha256)throw fault('VOICE_ASSET_HASH','语音资源摘要与清单不符');
        verified.set(path,{identity,sha256:expected.sha256});
      }
      completedFiles++;receivedBytes+=expected.bytes;
      const now=Date.now();if(completedFiles===1||completedFiles===files.length||now-lastProgress>=100){lastProgress=now;parentPort.postMessage({id,type:'progress',value:{phase:'verifying',completedFiles,totalFiles:files.length,receivedBytes,totalBytes}});}
    }));
    const failure=results.find(value=>value.status==='rejected');if(failure)throw failure.reason;
  }
  signal.throwIfAborted();
}
parentPort.on('message',message=>{
  if(message.type==='cancel'){controllers.get(message.id)?.abort();return;}
  if(message.type!=='verify')return;
  const controller=new AbortController();controllers.set(message.id,controller);
  if(message.plan)plans.set(message.key,message.plan);
  const selected=plans.get(message.key);
  tail=tail.then(async()=>{try{
    if(!selected)throw fault('VOICE_ASSET_VERIFY','语音组件校验计划缺失');
    await verify(message.id,selected,controller.signal);parentPort.postMessage({id:message.id,type:'done'});
  }catch(error){parentPort.postMessage({id:message.id,type:'error',error:{name:error.name,code:error.code??'VOICE_ASSET_VERIFY',message:error.message}});}finally{controllers.delete(message.id);}});
});
