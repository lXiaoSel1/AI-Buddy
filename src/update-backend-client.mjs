import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {normalizedPipe,registeredDataPath} from './installation-record.mjs';
import {updateError} from './update-reservation.mjs';
import {readUpdateWorker} from './update-worker-process.mjs';

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
    return readUpdateWorker(child,{command,nonce,signal,onProgress,validateReady:event=>event.version===version&&event.manifestSha256===installation.manifestSha256});
  }
  return {supported,run};
}
