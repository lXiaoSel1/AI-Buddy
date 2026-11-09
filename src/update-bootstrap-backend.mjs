import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {lstat,mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join,resolve,sep} from 'node:path';
import {normalizedPipe,registeredDataPath} from './installation-record.mjs';
import {supportsAppUpdate} from './update-backend-client.mjs';
import {appReleaseNotes,assertNoUpdateLinks,bootstrapSelectionId,createAppReleaseClient,verifyCachedInstaller} from './update-release-proof.mjs';
import {readUpdateWorker} from './update-worker-process.mjs';
import {updateError} from './update-reservation.mjs';

const digest=/^[a-f0-9]{64}$/,stable=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&resolve(a).toLowerCase()===resolve(b).toLowerCase();
const recover=()=>updateError('APP_UPDATE_RECOVERY_REQUIRED');
const requireSource=value=>{if(!value)throw recover();};
function under(root,value){
  requireSource(typeof value==='string'&&value&&!value.includes('\\')&&!isAbsolute(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':')));
  const full=resolve(root,value);requireSource(full.startsWith(resolve(root)+sep));return full;
}
async function readJson(path,{optional=false}={}){
  try{await assertNoUpdateLinks(path);const stat=await lstat(path);requireSource(stat.isFile()&&stat.nlink===1&&stat.size<=128*1024);const bytes=await readFile(path);requireSource(bytes.length<=128*1024);return {value:JSON.parse(bytes.toString('utf8')),bytes};}
  catch(error){if(optional&&error.code==='ENOENT')return null;if(error.code==='APP_UPDATE_RECOVERY_REQUIRED')throw error;throw recover();}
}

// This is intentionally independent of the legacy manager. Only a verified target
// installer can run the bootstrap worker; no renderer URL, path or key is accepted.
export function createAppBootstrapBackend({root,build,dataRoot,pipe,installation,version,pid=process.pid,start=spawn,releaseClient=createAppReleaseClient()}){
  root=resolve(root);build=resolve(build);dataRoot=resolve(dataRoot);
  const control=join(root,'local','installer'),cache=join(control,'app-bootstrap-cache'),selectionPath=join(control,'app-bootstrap-discovery.json');
  let selected=null;
  async function readSourceSnapshot(selectionId,manifestHash){
    requireSource(stable.test(version)&&installation&&installation.version===version&&samePath(under(root,installation.build),build)&&Number.isSafeInteger(pid)&&pid>0);
    await assertNoUpdateLinks(root);await assertNoUpdateLinks(build);await assertNoUpdateLinks(dataRoot);
    const [registration,pointerRecord]=await Promise.all([readJson(join(root,'local','installation.json')),readJson(join(root,'local','current-build.json'))]);
    const record=registration.value,pointer=pointerRecord.value;
    requireSource(record?.schemaVersion===1&&record.version===version&&record.build===installation.build&&record.runtime===installation.runtime&&
      record.manager===installation.manager&&record.packageHashes&&typeof record.packageHashes==='object'&&!Array.isArray(record.packageHashes)&&Object.values(record.packageHashes).every(value=>digest.test(value))&&
      !record.startup?.safeMode&&!record.startup?.onboarding&&record.startup?.startupFailure==null&&record.edition===installation.edition&&['30fps','60fps'].includes(record.edition)&&
      Array.isArray(record.characters)&&record.characters.length>0&&record.characters.every(value=>typeof value==='string')&&new Set(record.characters).size===record.characters.length&&record.characters.includes(record.initialCharacter)&&
      JSON.stringify(record.characters)===JSON.stringify(installation.characters)&&record.initialCharacter===installation.initialCharacter&&
      pointer.path===record.build&&pointer.version===version&&(pointer.appVersion==null||pointer.appVersion===version)&&pointer.animationProfile===record.edition&&pointer.runtime?.path===record.runtime&&
      samePath(registeredDataPath(root,record.dataPath),dataRoot)&&normalizedPipe(record.pipe)===pipe&&
      ['managerProtocol','managerSha256','manifestSha256'].every(key=>record[key]===installation[key]));
    requireSource(!supportsAppUpdate(record,version));
    requireSource(record.managerProtocol==null);
    requireSource(record.managerSha256==null||digest.test(record.managerSha256));
    requireSource(record.manifestSha256==null||record.manifestSha256===''||digest.test(record.manifestSha256));
    requireSource(/^maintenance\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\/AI Buddy Setup\.exe$/.test(record.manager));
    for(const relative of [record.build,record.runtime,record.manager]){const path=under(root,relative);await assertNoUpdateLinks(path);const stat=await lstat(path);requireSource(relative===record.manager?stat.isFile()&&stat.nlink===1:stat.isDirectory());}
    // Any digest already recorded remains authoritative, even on a legacy install.
    if(digest.test(record.managerSha256??'')){
      const stat=await lstat(under(root,record.manager));requireSource(stat.size>0&&stat.size<=256*1024*1024);
      await verifyCachedInstaller(under(root,record.manager),{bytes:stat.size,installerSha256:record.managerSha256});
    }
    // Public legacy pointers predate the manifest field. The registered manifest
    // remains authoritative; an explicitly present pointer digest must match it.
    if(record.manifestSha256){const manifest=join(root,'local','install-manifests',record.manifestSha256+'.json');await assertNoUpdateLinks(manifest);const stat=await lstat(manifest);requireSource(stat.size>0&&stat.size<=16*1024*1024&&(!Object.hasOwn(pointer,'manifestSha256')||pointer.manifestSha256===record.manifestSha256));await verifyCachedInstaller(manifest,{bytes:stat.size,installerSha256:record.manifestSha256});}
    const source={root,build,dataRoot,pipe,version,pid,installationSha256:sha(registration.bytes),pointerSha256:sha(pointerRecord.bytes)};
    const journal=await readJson(join(control,'transaction.json'),{optional:true});
    if(journal){const j=journal.value;
      requireSource(['complete','rolled-back','staging','prepared'].includes(j.phase));
      if(['staging','prepared'].includes(j.phase))requireSource(digest.test(selectionId??'')&&j.appSelection===selectionId&&j.manifestHash===(manifestHash??selected?.release.manifestSha256)&&j.previousInstallation===registration.bytes.toString('utf8')&&j.previousPointer===pointerRecord.bytes.toString('utf8'));
    }
    const imported=await readJson(join(control,'data-import-transaction.json'),{optional:true});
    if(imported)requireSource(['complete','failed','cancelled','rolled-back'].includes(imported.value.phase));
    const state=await readJson(join(control,'app-update-status.json'),{optional:true});
    if(state)requireSource(!['applying','recovery-required'].includes(state.value.result?.stage));
    return source;
  }
  async function sourceSnapshot(selectionId,manifestHash){
    try{return await readSourceSnapshot(selectionId,manifestHash);}catch(error){if(error.name==='AbortError'||error.code==='APP_UPDATE_CANCELLED')throw error;throw recover();}
  }
  async function saveSelection(selection){
    await assertNoUpdateLinks(control);await mkdir(control,{recursive:true});await assertNoUpdateLinks(control);
    const temp=selectionPath+'.'+randomBytes(16).toString('hex')+'.tmp';let file;
    try{file=await open(temp,'wx');await file.writeFile(JSON.stringify(selection));await file.sync();await file.close();file=null;await assertNoUpdateLinks(selectionPath);await rename(temp,selectionPath);}
    finally{await file?.close();await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async function restoreSelection(){
    if(selected)return selected;
    const saved=await readJson(selectionPath,{optional:true});if(!saved)return null;
    let release;try{release=releaseClient.verify(saved.value.release);}catch{throw recover();}
    const source=await sourceSnapshot(saved.value.selectionId,release.manifestSha256);
    requireSource(bootstrapSelectionId(source,release)===saved.value.selectionId);
    return selected={source,release,selectionId:saved.value.selectionId};
  }
  const fields=selection=>({selectionId:selection.selectionId,version:selection.release.version,installerBytes:selection.release.bytes,notes:appReleaseNotes(selection.release),migration:true});
  async function run(command,{nonce,signal,selectionId,onProgress=()=>{},official=false}={}){
    if(!['status','check','prepare','apply'].includes(command)||!digest.test(nonce??'')||(['prepare','apply'].includes(command)&&!digest.test(selectionId??'')))throw updateError('APP_UPDATE_PROTOCOL');
    signal?.throwIfAborted();
    if(command==='status'){
      const selection=await restoreSelection();await sourceSnapshot(selection?.selectionId);
      if(!selection)return {ok:true,stage:'bootstrap'};
      const state=await readJson(join(control,'app-update-status.json'),{optional:true});
      if(state?.value.result?.stage==='recovery-required')throw recover();
      const result=state?.value.result;
      if(result?.stage==='ready'&&result.selectionId===selection.selectionId&&state.value.sourceStamp===selection.source.installationSha256+':'+selection.source.pointerSha256){
        const path=join(cache,selection.release.installerSha256+'-'+selection.release.installerName);await verifyCachedInstaller(path,selection.release,signal);
        return {...result,...fields(selection),ok:true};
      }
      return {ok:true,stage:'available',...fields(selection)};
    }
    if(command==='check'){
      const existing=await restoreSelection();const source=await sourceSnapshot(existing?.selectionId);
      const journal=await readJson(join(control,'transaction.json'),{optional:true});
      if(existing&&['prepared','staging'].includes(journal?.value.phase))return {ok:true,stage:'available',...fields(existing)};
      const release=await releaseClient.check(version,{signal,official});
      if(!release){selected=null;await assertNoUpdateLinks(selectionPath);await unlink(selectionPath).catch(error=>{if(error.code!=='ENOENT')throw error;});return {ok:true,stage:'current',version,migration:true};}
      selected={source,release,selectionId:bootstrapSelectionId(source,release)};await saveSelection(selected);
      return {ok:true,stage:'available',...fields(selected)};
    }
    const selection=await restoreSelection();
    if(!selection||selection.selectionId!==selectionId)throw updateError('APP_UPDATE_RECHECK_REQUIRED');
    const source=await sourceSnapshot(selection.selectionId);releaseClient.verify(selection.release);
    requireSource(bootstrapSelectionId(source,selection.release)===selectionId);
    const path=command==='prepare'?await releaseClient.download(selection.release,cache,{signal,onProgress,official}):
      await verifyCachedInstaller(join(cache,selection.release.installerSha256+'-'+selection.release.installerName),selection.release,signal);
    // Recheck both the source and cached executable immediately before creating the worker.
    requireSource(bootstrapSelectionId(await sourceSnapshot(selectionId),selection.release)===selectionId);
    await verifyCachedInstaller(path,selection.release,signal);signal?.throwIfAborted();
    const initial={protocol:1,type:'bootstrap',nonce,source,release:selection.release,official};
    if(Buffer.byteLength(JSON.stringify(initial),'utf8')>128*1024)throw updateError('APP_UPDATE_PROTOCOL');
    const child=start(path,[`--app-bootstrap-worker=${command}`,`--app-root=${root}`,`--nonce=${nonce}`,`--pid=${pid}`],{cwd:root,stdio:['pipe','pipe','ignore'],windowsHide:true,detached:command==='apply'});
    const result=await readUpdateWorker(child,{command,nonce,signal,onProgress,initial,validateReady:event=>event.version===selection.release.version&&event.manifestSha256===selection.release.manifestSha256&&
      event.selectionId===selectionId&&event.appUpdateProtocol===1&&event.appBootstrapProtocol===1});
    if(result.ok===true&&(result.selectionId!==selectionId||result.version!==selection.release.version||result.stage!==(command==='prepare'?'ready':'completed')))throw updateError('APP_UPDATE_PROTOCOL');
    return {...result,migration:true};
  }
  return {run};
}
