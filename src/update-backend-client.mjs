import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {normalizedPipe,registeredDataPath} from './installation-record.mjs';
import {updateError} from './update-reservation.mjs';

const digest=/^[a-f0-9]{64}$/;
const versions=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commands=new Set(['check','prepare','apply','status']);
const samePath=(a,b)=>resolve(a).toLowerCase()===resolve(b).toLowerCase();
const managerRelative=version=>`maintenance/${version}/AI Buddy Setup.exe`;
const sameFile=(a,b)=>['ino','dev','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
export function supportsAppUpdate(installation,version){
  return versions.test(version)&&installation?.version===version&&installation.managerProtocol===1&&
    installation.manager===managerRelative(version)&&digest.test(installation.managerSha256??'');
}

export function createAppUpdateBackend({root,build,dataRoot,pipe,installation,version,pid=process.pid,start=spawn}){
  const supported=supportsAppUpdate(installation,version)&&typeof installation.build==='string'&&samePath(join(root,installation.build),build);
  async function verifiedManager(signal){
    if(!supported)throw updateError('APP_UPDATE_BOOTSTRAP');
    const [record,pointer]=await Promise.all(['installation.json','current-build.json'].map(async file=>JSON.parse(await readFile(join(root,'local',file),'utf8'))));
    if(!supportsAppUpdate(record,version)||record.build!==installation.build||record.manifestSha256!==installation.manifestSha256||
      record.managerSha256!==installation.managerSha256||record.edition!==installation.edition||
      pointer.path!==record.build||(pointer.appVersion??pointer.version)!==version||pointer.animationProfile!==record.edition||
      !samePath(registeredDataPath(root,record.dataPath),dataRoot)||normalizedPipe(record.pipe)!==pipe)throw updateError('APP_UPDATE_IDENTITY_CHANGED');
    const path=join(root,record.manager),before=await lstat(path,{bigint:true});
    if(!before.isFile()||before.size<1n||before.size>268435456n||!samePath(await realpath(path),path))throw updateError('APP_UPDATE_MANAGER_UNTRUSTED');
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);
    if(hash.digest('hex')!==record.managerSha256||!sameFile(before,await lstat(path,{bigint:true}))||!samePath(await realpath(path),path))throw updateError('APP_UPDATE_MANAGER_UNTRUSTED');
    return path;
  }
  async function run(command,{nonce,signal,selectionId,onProgress=()=>{}}){
    if(!commands.has(command)||!digest.test(nonce)||(['prepare','apply'].includes(command)&&!digest.test(selectionId??'')))throw updateError('APP_UPDATE_PROTOCOL');
    const path=await verifiedManager(signal);
    signal?.throwIfAborted();
    const args=[`--app-update=${command}`,`--app-root=${root}`,`--app-nonce=${nonce}`,`--app-pid=${pid}`];
    if(selectionId)args.push(`--app-selection=${selectionId}`);
    const child=start(path,args,{cwd:root,stdio:['pipe','pipe','ignore'],windowsHide:true,detached:command==='apply'});
    return new Promise((resolveRun,reject)=>{
      let ready=false,settled=false,result=null,buffer='';
      const deadline=setTimeout(()=>finish(updateError('APP_UPDATE_BACKEND_TIMEOUT')),command==='prepare'?60*60_000:command==='apply'?16*60_000:120_000);
      const startup=setTimeout(()=>finish(updateError('APP_UPDATE_BACKEND_TIMEOUT')),15_000);
      const cancel=()=>{if(child.stdin.writable)child.stdin.write(JSON.stringify({command:'cancel',nonce})+'\n');};
      function finish(error){
        if(settled)return;
        settled=true;clearTimeout(deadline);clearTimeout(startup);signal?.removeEventListener('abort',cancel);
        if(error){cancel();child.stdin.end();child.stdout.destroy();child.unref();reject(error);}else resolveRun(result);
      }
      child.stdin.on('error',()=>{});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if(settled)return;
        buffer+=chunk;
        let newline;
        while((newline=buffer.indexOf('\n'))>=0){
          if(newline>65536)return finish(updateError('APP_UPDATE_PROTOCOL'));
          const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
          let event;
          try{event=JSON.parse(line);}catch{return finish(updateError('APP_UPDATE_PROTOCOL'));}
          if(event?.protocol!==1||event.nonce!==nonce||event.processId!==child.pid||result)return finish(updateError('APP_UPDATE_PROTOCOL'));
          if(!ready){
            if(event.type==='result'&&event.ok===false){result=event;continue;}
            if(event.type!=='ready'||event.version!==version||event.manifestSha256!==installation.manifestSha256)return finish(updateError('APP_UPDATE_PROTOCOL'));
            ready=true;clearTimeout(startup);
          }
          else if(event.type==='progress')onProgress(event);
          else if(event.type==='result')result=event;
          else return finish(updateError('APP_UPDATE_PROTOCOL'));
        }
        if(buffer.length>65536)finish(updateError('APP_UPDATE_PROTOCOL'));
      });
      child.once('error',()=>finish(updateError('APP_UPDATE_BACKEND_START')));
      child.once('close',code=>finish(result&&(ready||result.ok===false)&&!buffer.trim()&&((code===0)===(result.ok===true))?null:updateError('APP_UPDATE_BACKEND_EXIT')));
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)cancel();
    });
  }
  return {supported,run};
}
