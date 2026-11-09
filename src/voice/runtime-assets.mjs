import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertPluginTreeNoLinks } from '../plugin-archive.mjs';
import { pluginRelativePath } from '../plugin-manifest.mjs';
import { renamePluginPath } from '../plugin-files.mjs';
import {createVoiceAssetVerifier} from './asset-verifier.mjs';
import {waitVoiceOperation} from './operation-wait.mjs';
import {voiceAssetRecovery} from './asset-errors.mjs';
import {voiceAssetDownloadUrl,voiceAssetDownloadStream,parseVoiceAssetDownloads,writeVoiceAsset,checkVoiceAssetDisk,extractVoiceAssetArchive} from './asset-downloads.mjs';

const ids = { breeze: 'ai-buddy.voice-breeze', gpt: 'ai-buddy.voice-gpt-sovits' };
const scripts = { asr: 'asr_worker.py', breeze: 'breeze_worker.py', gpt: 'gpt_worker.py' };
const fault = (code, message) => Object.assign(new Error(message), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = info => [info.dev, info.ino, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');

function downloadUrl(value) {
  return voiceAssetDownloadUrl(value);
}

function validate(kind, descriptor) {
  const { schemaVersion, platform, arch, version, python, files, ffmpegDirectory } = descriptor;
  if (schemaVersion !== 1 || descriptor.kind !== kind || platform !== 'win32' || arch !== 'x64' ||
      typeof version !== 'string' || !/^[a-zA-Z0-9._-]{1,48}$/.test(version) ||
      !Array.isArray(files) || !files.length || files.length > 65000) {
    throw fault('VOICE_ASSET_MANIFEST', '语音组件清单无效');
  }
  pluginRelativePath(python);
  if (ffmpegDirectory != null) pluginRelativePath(ffmpegDirectory);
  const names = new Set();
  const directories = new Map();
  let total = 0;
  for (const file of files) {
    const name = pluginRelativePath(file.path).toLowerCase();
    if (names.has(name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        file.bytes > 24 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw fault('VOICE_ASSET_MANIFEST', '语音资源文件清单无效');
    }
    names.add(name);
    const parts=file.path.split('/');parts.pop();
    while(parts.length){const directory=parts.join('/'),key=directory.toLowerCase();if(directories.has(key)&&directories.get(key)!==directory)throw fault('VOICE_ASSET_MANIFEST','语音资源目录大小写冲突');directories.set(key,directory);parts.pop();}
    total += file.bytes;
    if (file.url != null) downloadUrl(file.url);
  }
  if ([...directories.keys()].some(name=>names.has(name)) || total > 60 * 1024 ** 3 || !files.some(file=>file.path===python) ||
      (ffmpegDirectory && !names.has((ffmpegDirectory + '/ffmpeg.exe').toLowerCase()))) {
    throw fault('VOICE_ASSET_MANIFEST', '语音组件入口缺失');
  }
  return total;
}

export function createVoiceAssets({ dataRoot, resolveVoicePackage, fetchImpl = fetch,promote=renamePluginPath,verificationWorker }) {
  const root = join(dataRoot, 'voice', 'components');
  const pending = new Map();
  const descriptors = new Map();
  const verificationFailures = new Map();
  const verifier=createVoiceAssetVerifier({workerPath:verificationWorker});
  const lifetime=new AbortController();

  async function plan(kind, engineId, {signal}={}) {
    const wait=operation=>waitVoiceOperation(operation,signal);
    signal?.throwIfAborted();
    if (!Object.hasOwn(scripts, kind)) throw fault('VOICE_ASSET_MANIFEST', '未知语音组件');
    const requested = kind === 'asr' ? engineId : kind;
    const id = ids[requested] ?? requested;
    if (!Object.values(ids).includes(id)) throw fault('VOICE_PLUGIN_REQUIRED', '请启用一个语音插件');
    const owner = await wait(()=>resolveVoicePackage(id,{signal}));
    const record = kind === 'asr' ? owner.shared : owner;
    if (!isAbsolute(record?.directory ?? '') || !isAbsolute(owner.shared?.directory ?? '')) {
      throw fault('VOICE_PLUGIN_REQUIRED', '语音插件共享运行依赖缺失');
    }
    const file = join(record.directory, 'assets.json');
    await wait(()=>assertPluginTreeNoLinks(file));
    const info=await wait(()=>lstat(file,{bigint:true}));
    if(!info.isFile()||info.nlink!==1n)throw fault('VOICE_ASSET_MANIFEST','语音组件清单类型无效');
    const identity=stamp(info),key=[kind,file,record.sourceId,record.archiveSha256,identity].join('|');
    let cached=descriptors.get(key);
    if(!cached){
      const bytes=await wait(()=>readFile(file)),descriptorHash=digest(bytes);
      if(identity!==stamp(await wait(()=>lstat(file,{bigint:true}))))throw fault('VOICE_ASSET_MANIFEST','语音组件清单在读取中发生变化');
      const descriptor=JSON.parse(bytes),total=validate(kind,descriptor);
      cached={descriptorHash,descriptor,total,bytes:bytes.length};descriptors.set(key,cached);if(descriptors.size>8)descriptors.delete(descriptors.keys().next().value);
    }
    const {descriptorHash,descriptor,total}=cached;
    if(record.manifest&&!record.manifest.files.some(row=>row.path==='assets.json'&&row.sha256===descriptorHash&&row.bytes===cached.bytes))throw fault('VOICE_ASSET_MANIFEST','语音组件清单与插件签名不符');
    let downloads,downloadsHash;
    const deliveryFile=join(record.directory,'downloads.json'),deliveryRow=record.manifest?.files.find(row=>row.path==='downloads.json');
    await wait(()=>assertPluginTreeNoLinks(deliveryFile));
    let deliveryInfo;try{deliveryInfo=await wait(()=>lstat(deliveryFile,{bigint:true}));}catch(error){if(error.code!=='ENOENT'||deliveryRow)throw error;}
    if(deliveryInfo){
      if(!deliveryRow||!deliveryInfo.isFile()||deliveryInfo.nlink!==1n||deliveryInfo.size>16n*1024n*1024n)throw fault('VOICE_ASSET_MANIFEST','语音下载清单没有有效插件签名');
      const deliveryIdentity=stamp(deliveryInfo),deliveryKey=key+'|downloads|'+deliveryIdentity+'|'+deliveryRow.sha256+'|'+deliveryRow.bytes;
      let delivery=descriptors.get(deliveryKey);
      if(!delivery){const raw=await wait(()=>readFile(deliveryFile));downloadsHash=digest(raw);if(stamp(await wait(()=>lstat(deliveryFile,{bigint:true})))!==deliveryIdentity||raw.length!==deliveryRow.bytes||downloadsHash!==deliveryRow.sha256)throw fault('VOICE_ASSET_MANIFEST','语音下载清单与插件签名不符');delivery={downloadsHash,downloads:parseVoiceAssetDownloads(raw,{descriptor,descriptorHash})};descriptors.set(deliveryKey,delivery);if(descriptors.size>8)descriptors.delete(descriptors.keys().next().value);}
      ({downloads,downloadsHash}=delivery);
    }
    const proof = [kind, record.sourceId, record.archiveSha256, descriptorHash].join(':');
    const destination = join(root, kind, descriptorHash);
    const cacheRoot = join(root, 'cache', kind, descriptorHash);
    const proofFile=join(root,'.verification',digest(Buffer.from(proof+'|'+destination))+'.json');
    return { descriptor, destination, cacheRoot, proof, proofFile,total, downloads,downloadsHash,script: join(record.directory, scripts[kind]), sharedDirectory: owner.shared.directory };
  }

  async function checkMarker(selected,{signal}={}) {
    const marker = join(selected.destination, '.ready');
    await waitVoiceOperation(()=>assertPluginTreeNoLinks(marker),signal);
    try {
      if ((await waitVoiceOperation(()=>readFile(marker, 'utf8'),signal)) !== selected.proof) throw fault('VOICE_ASSET_HASH', '语音组件的准备凭据与安装包不符');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw fault('VOICE_ASSET_MISSING', '语音资源尚未准备');
    }
  }

  async function checkReady(selected,options={}) {
    options.signal?.throwIfAborted();await checkMarker(selected,options);options.signal?.throwIfAborted();
    const result=await verifier.verify(selected,options);
    options.signal?.throwIfAborted();return result;
  }

  async function installedMarker(selected,{signal}={}){
    const marker=join(selected.destination,'.ready');await waitVoiceOperation(()=>assertPluginTreeNoLinks(marker),signal);
    const info=await waitVoiceOperation(()=>lstat(marker),signal);
    if(!info.isFile()||info.nlink!==1)throw fault('VOICE_ASSET_HASH','语音组件准备凭据类型无效');
    return waitVoiceOperation(()=>readFile(marker,'utf8'),signal);
  }
  const matchingDescriptor=(marker,selected)=>{const old=marker.split(':'),current=selected.proof.split(':');return old.length===4&&old[0]===current[0]&&old[3]===current[3];};

  function rememberFailure(selected,error){
    const code=error.code==='ENOENT'?'VOICE_ASSET_MISSING':typeof error.code==='string'?error.code:error.name==='AbortError'?'ABORT_ERR':'VOICE_ASSET_VERIFY';
    verificationFailures.set(selected.proof,{code,...(error.path?{path:error.path}:{})});
  }

  async function status(kind, engineId, options={}) {
    try {
      const selected = await plan(kind, engineId,options);
      const base = { version: selected.descriptor.version, bytes: selected.total,...(selected.downloads?{downloadAvailable:true,downloadBytes:selected.downloads.downloadBytes}:{}) };
      if (pending.has(selected.destination)) return { ...base, state: 'preparing' };
      // A settings/status read reports the completed install transaction. Full
      // file identity and hash verification remains mandatory in resolve(),
      // before a worker can execute. Settings never enumerate or stat payload
      // members; explicit Verify or the use boundary detects damaged files.
      const failure=verificationFailures.get(selected.proof);if(failure){const downloadRequired=voiceAssetRecovery(failure.code)==='download';return {...base,...failure,state:downloadRequired?(failure.code==='VOICE_ASSET_MISSING'?'missing':'error'):'verification-needed',verificationFailed:true,downloadRequired};}
      try { await checkMarker(selected,options); }
      catch (error) {
        options.signal?.throwIfAborted();
        if(error.code==='VOICE_ASSET_HASH')try{
          const marker=await installedMarker(selected,options);
          if(matchingDescriptor(marker,selected))return {...base,state:'verification-needed',code:'VOICE_ASSET_VERIFY_REQUIRED',downloadRequired:false};
        }catch(cause){options.signal?.throwIfAborted();return {...base,state:cause.code==='ENOENT'||cause.code==='VOICE_ASSET_MISSING'?'missing':'error',code:cause.code};}
        return { ...base, state: error.code === 'VOICE_ASSET_MISSING' ? 'missing' : 'error', code: error.code,downloadRequired:voiceAssetRecovery(error.code)==='download' };
      }
      return { ...base, state: 'ready',verification:'before-use' };
    } catch (error) {
      options.signal?.throwIfAborted();
      return { state: 'unavailable', code: error.code ?? 'VOICE_ASSET_MANIFEST' };
    }
  }

  async function resolve(kind, engineId, options={}) {
    options.signal?.throwIfAborted();const selected = await plan(kind, engineId,options);
    let verificationDetails;try{verificationDetails=await checkReady(selected,options);verificationFailures.delete(selected.proof);}catch(error){rememberFailure(selected,error);throw error;}
    await waitVoiceOperation(()=>assertPluginTreeNoLinks(selected.cacheRoot),options.signal);
    await waitVoiceOperation(()=>mkdir(selected.cacheRoot, { recursive: true }),options.signal);
    const { descriptor, destination } = selected;
    return { python: join(destination, descriptor.python), script: selected.script, root: destination, assetRoot: destination,
      cacheRoot: selected.cacheRoot, sharedDirectory: selected.sharedDirectory, proof: selected.proof,verification:verificationDetails?.verification,verificationDetails,
      ...(descriptor.ffmpegDirectory ? { ffmpegDirectory: join(destination, descriptor.ffmpegDirectory) } : {}) };
  }

  async function prepare(kind, { engineId, localRoot, verifyOnly=false,forceDownload=false,signal, onProgress = () => {} } = {}) {
    signal=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
    signal.throwIfAborted();
    if (localRoot != null && !isAbsolute(localRoot)) throw fault('VOICE_ASSET_SOURCE', '本地语音组件目录无效');
    const selected = await plan(kind, engineId,{signal});
    if (pending.has(selected.destination)) return waitVoiceOperation(pending.get(selected.destination),signal);
    const admit=async()=>{signal.throwIfAborted();const current=await plan(kind,engineId,{signal});if(current.proof!==selected.proof||current.downloadsHash!==selected.downloadsHash)throw fault('VOICE_ASSET_REVOKED','语音插件或组件版本已更改');};
    let receivedBytes=0,downloadReceivedBytes=0,lastProgress=0,progressTimer,latestProgress,progressError;
    const emit=()=>{progressTimer=undefined;if(!latestProgress)return;lastProgress=Date.now();const row=latestProgress;latestProgress=undefined;try{onProgress(row);}catch(error){progressError=error;}};
    const reportRow=row=>{if(progressError)throw progressError;latestProgress={kind,state:'preparing',...row};if(!progressTimer){const delay=Math.max(0,100-(Date.now()-lastProgress));if(!delay)emit();else progressTimer=setTimeout(emit,delay);}};
    const flushProgress=async()=>{if(latestProgress)await waitVoiceOperation(()=>new Promise(resolve=>setTimeout(resolve,Math.max(0,100-(Date.now()-lastProgress)))),signal);if(latestProgress){clearTimeout(progressTimer);emit();}if(progressError)throw progressError;signal.throwIfAborted();};
    const verificationProgress=value=>reportRow(value);
    const report=phase=>reportRow({phase,receivedBytes,totalBytes:selected.total,...(!localRoot?{downloadReceivedBytes,downloadBytes:selected.downloads?.downloadBytes??selected.total}:{})});
    const operation = (async () => {
      if(verifyOnly){
        const temporary=join(selected.destination,'.ready-'+randomUUID()),fresh=createVoiceAssetVerifier({workerPath:verificationWorker});
        try{
          const marker=await installedMarker(selected,{signal});if(!matchingDescriptor(marker,selected))throw fault('VOICE_ASSET_HASH','语音组件准备凭据与清单不符');
          const readProof=marker===selected.proof?undefined:{proof:marker,proofFile:join(dirname(selected.proofFile),digest(Buffer.from(marker+'|'+selected.destination))+'.json')};
          await fresh.verify({...selected,readProof},{signal,onProgress:verificationProgress});await flushProgress();await admit();
          if(await installedMarker(selected,{signal})!==marker)throw fault('VOICE_ASSET_CHANGED','语音组件凭据在校验中发生变化');
          await writeFile(temporary,selected.proof,{flag:'wx',mode:0o600});await admit();
          await renamePluginPath(temporary,join(selected.destination,'.ready'));verificationFailures.delete(selected.proof);return {state:'ready',reused:true};
        }catch(error){rememberFailure(selected,error);throw error;}
        finally{await fresh.close();await rm(temporary,{force:true});}
      }
      try { if(forceDownload)throw fault('VOICE_ASSET_MISSING','需要重新下载');await checkReady(selected,{signal,onProgress:verificationProgress});await flushProgress();await admit();return { state: 'ready', reused: true }; }
      catch (error) {
        if(error.code==='VOICE_ASSET_HASH'){
          const marker=await installedMarker(selected,{signal});if(marker!==selected.proof&&matchingDescriptor(marker,selected))throw fault('VOICE_ASSET_VERIFY_REQUIRED','这台电脑上已经有这些文件，请先校验');throw error;
        }
        if (error.code !== 'VOICE_ASSET_MISSING') throw error;
      }
      const { descriptor, destination } = selected;
      const parent = dirname(destination);
      await assertPluginTreeNoLinks(parent);
      await mkdir(parent,{recursive:true});
      // A completed tree remains unadmitted after a failed Windows rename.
      // Recheck its signed bytes and ownership before retrying that promotion.
      for(const entry of forceDownload?[]:await readdir(parent,{withFileTypes:true})){
        if(!entry.isDirectory()||!/^stage-[a-f0-9-]{36}$/.test(entry.name))continue;
        const previous=join(parent,entry.name);await assertPluginTreeNoLinks(previous);
        let marker;try{marker=await readFile(join(previous,'.ready'),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(marker!==selected.proof)continue;
        await checkReady({...selected,destination:previous},{signal,onProgress:verificationProgress});await flushProgress();signal?.throwIfAborted();
        await admit();
        await promote(previous,destination,{retryBudgetMs:10000});return {state:'ready',reused:true,resumed:true};
      }
      if (!localRoot && !selected.downloads && descriptor.files.some(file => !file.url)) {
        throw fault('VOICE_ASSET_OFFLINE_REQUIRED', '请先选择此版本的已验证离线语音运行组件目录');
      }
      signal.throwIfAborted();await checkVoiceAssetDisk(parent,selected.total,localRoot?[]:selected.downloads?.archives);signal.throwIfAborted();
      const staging = join(parent, 'stage-' + randomUUID());
      await assertPluginTreeNoLinks(staging);
      await mkdir(parent, { recursive: true });
      await mkdir(staging);
      let complete=false;
      try {
        report(localRoot?'copying':'downloading');
        const directFiles=localRoot?descriptor.files:[...descriptor.files.filter(file=>file.url),...(selected.downloads?.directFiles??[])];
        for (const file of directFiles) {
          signal?.throwIfAborted();
          const target = join(staging, file.path);
          await mkdir(dirname(target), { recursive: true });
          let input;
          if (localRoot) {
            const source = join(localRoot, file.path);
            await assertPluginTreeNoLinks(source);
            const info = await lstat(source);
            if (!info.isFile() || info.size !== file.bytes) throw fault('VOICE_ASSET_HASH', '本地语音资源不符合清单');
            input = createReadStream(source, { signal });
          } else {
            input = await voiceAssetDownloadStream(file,{signal,fetchImpl});
          }
          await writeVoiceAsset(input,target,file,{signal,onBytes:count=>{receivedBytes+=count;if(!localRoot)downloadReceivedBytes+=count;report(localRoot?'copying':'downloading');}});
          report(localRoot?'copying':'downloading');
        }
        if(!localRoot)for(const archive of selected.downloads?.archives??[]){
          signal.throwIfAborted();const temporary=join(staging,archive.id+'.'+randomUUID()+'.download');
          try{
            report('downloading');const input=await voiceAssetDownloadStream(archive,{signal,fetchImpl});
            await writeVoiceAsset(input,temporary,archive,{signal,onBytes:count=>{downloadReceivedBytes+=count;report('downloading');}});
            report('extracting');await extractVoiceAssetArchive(temporary,staging,archive,{signal,onBytes:count=>{receivedBytes+=count;report('extracting');}});report('extracting');
          }finally{await rm(temporary,{force:true});}
        }
        await flushProgress();signal?.throwIfAborted();
        await admit();
        const marker = createWriteStream(join(staging, '.ready'), { flags: 'wx', mode: 0o600 });
        await pipeline(Readable.from([selected.proof]), marker, { signal });
        await admit();complete=true;
        if(forceDownload){
          const previous=join(parent,'replaced-'+randomUUID());let moved=false;
          try{await assertPluginTreeNoLinks(destination);try{await renamePluginPath(destination,previous);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}await promote(staging,destination,{retryBudgetMs:10000});}
          catch(error){if(moved)await renamePluginPath(previous,destination);throw error;}
          if(moved)await rm(previous,{recursive:true,force:true});
        }else await promote(staging, destination,{retryBudgetMs:10000});
        verificationFailures.delete(selected.proof);
        return { state: 'ready', reused: false };
      } finally {
        await assertPluginTreeNoLinks(staging);
        if(!complete)await rm(staging, { recursive: true, force: true });
      }
    })();
    pending.set(selected.destination, operation);
    try { return await operation; }
    finally { clearTimeout(progressTimer);pending.delete(selected.destination); }
  }

  async function prepareSelected({engineId,provider='local',signal,onProgress=()=>{}}={}){
    if(!['local','minimax'].includes(provider))throw fault('VOICE_ASSET_MANIFEST','未知语音服务');
    const selectedEngine=Object.keys(ids).find(key=>key===engineId||ids[key]===engineId);
    if(!selectedEngine)throw fault('VOICE_PLUGIN_REQUIRED','请启用一个语音插件');
    const components=[];
    for(const kind of provider==='minimax'?['asr']:['asr',selectedEngine]){signal?.throwIfAborted();const result=await prepare(kind,{engineId:selectedEngine,signal,onProgress});components.push({kind,...result});}
    return {state:'ready',components};
  }

  return { status, prepare, prepareSelected,resolve, close:async()=>{lifetime.abort();await Promise.allSettled([...pending.values()]);await verifier.close();} };
}
