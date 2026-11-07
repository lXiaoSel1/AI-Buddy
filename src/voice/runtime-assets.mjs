import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertPluginTreeNoLinks } from '../plugin-archive.mjs';
import { pluginRelativePath } from '../plugin-manifest.mjs';
import { renamePluginPath } from '../plugin-files.mjs';
import {createVoiceAssetVerifier} from './asset-verifier.mjs';

const ids = { breeze: 'ai-buddy.voice-breeze', gpt: 'ai-buddy.voice-gpt-sovits' };
const scripts = { asr: 'asr_worker.py', breeze: 'breeze_worker.py', gpt: 'gpt_worker.py' };
const fault = (code, message) => Object.assign(new Error(message), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = info => [info.dev, info.ino, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');

function downloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw fault('VOICE_ASSET_SOURCE', '语音资源下载来源无效');
  }
  return url;
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
  let total = 0;
  for (const file of files) {
    const name = pluginRelativePath(file.path).toLowerCase();
    if (names.has(name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        file.bytes > 24 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw fault('VOICE_ASSET_MANIFEST', '语音资源文件清单无效');
    }
    names.add(name);
    total += file.bytes;
    if (file.url != null) downloadUrl(file.url);
  }
  if (total > 60 * 1024 ** 3 || !names.has(python.toLowerCase()) ||
      (ffmpegDirectory && !names.has((ffmpegDirectory + '/ffmpeg.exe').toLowerCase()))) {
    throw fault('VOICE_ASSET_MANIFEST', '语音组件入口缺失');
  }
  return total;
}

function redirectAllowed(initial, target) {
  if (target.hostname === initial.hostname) return true;
  if (initial.hostname === 'huggingface.co') {
    return target.hostname.endsWith('.hf.co') || target.hostname.endsWith('.huggingface.co');
  }
  if (initial.hostname === 'github.com') {
    return target.hostname.endsWith('.githubusercontent.com');
  }
  return false;
}

async function download(file, signal, fetchImpl) {
  const initial = downloadUrl(file.url);
  let url = initial;
  for (let attempt = 0; attempt <= 4; attempt++) {
    const response = await fetchImpl(url, { signal, redirect: 'manual', credentials: 'omit' });
    if (response.ok && response.body) return Readable.fromWeb(response.body);
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    const target = downloadUrl(new URL(location, url));
    if (!redirectAllowed(initial, target)) throw fault('VOICE_ASSET_SOURCE', '语音资源重定向来源无效');
    url = target;
  }
  throw fault('VOICE_ASSET_DOWNLOAD', '语音资源下载失败，请检查连接后重试');
}

export function createVoiceAssets({ dataRoot, resolveVoicePackage, fetchImpl = fetch,promote=renamePluginPath,verificationWorker }) {
  const root = join(dataRoot, 'voice', 'components');
  const pending = new Map();
  const descriptors = new Map();
  const verifier=createVoiceAssetVerifier({workerPath:verificationWorker});

  async function plan(kind, engineId) {
    if (!Object.hasOwn(scripts, kind)) throw fault('VOICE_ASSET_MANIFEST', '未知语音组件');
    const requested = kind === 'asr' ? engineId : kind;
    const id = ids[requested] ?? requested;
    if (!Object.values(ids).includes(id)) throw fault('VOICE_PLUGIN_REQUIRED', '请启用一个语音插件');
    const owner = await resolveVoicePackage(id);
    const record = kind === 'asr' ? owner.shared : owner;
    if (!isAbsolute(record?.directory ?? '') || !isAbsolute(owner.shared?.directory ?? '')) {
      throw fault('VOICE_PLUGIN_REQUIRED', '语音插件共享运行依赖缺失');
    }
    const file = join(record.directory, 'assets.json');
    await assertPluginTreeNoLinks(file);
    const info=await lstat(file,{bigint:true});
    if(!info.isFile())throw fault('VOICE_ASSET_MANIFEST','语音组件清单类型无效');
    const identity=stamp(info),key=[kind,file,record.sourceId,record.archiveSha256,identity].join('|');
    let cached=descriptors.get(key);
    if(!cached){
      const bytes=await readFile(file),descriptorHash=digest(bytes);
      if(identity!==stamp(await lstat(file,{bigint:true})))throw fault('VOICE_ASSET_MANIFEST','语音组件清单在读取中发生变化');
      const descriptor=JSON.parse(bytes),total=validate(kind,descriptor);
      cached={descriptorHash,descriptor,total,bytes:bytes.length};descriptors.set(key,cached);if(descriptors.size>8)descriptors.delete(descriptors.keys().next().value);
    }
    const {descriptorHash,descriptor,total}=cached;
    if(record.manifest&&!record.manifest.files.some(row=>row.path==='assets.json'&&row.sha256===descriptorHash&&row.bytes===cached.bytes))throw fault('VOICE_ASSET_MANIFEST','语音组件清单与插件签名不符');
    const proof = [kind, record.sourceId, record.archiveSha256, descriptorHash].join(':');
    const destination = join(root, kind, descriptorHash);
    const cacheRoot = join(root, 'cache', kind, descriptorHash);
    return { descriptor, destination, cacheRoot, proof, total, script: join(record.directory, scripts[kind]), sharedDirectory: owner.shared.directory };
  }

  async function checkMarker(selected) {
    const marker = join(selected.destination, '.ready');
    await assertPluginTreeNoLinks(marker);
    try {
      if ((await readFile(marker, 'utf8')) !== selected.proof) throw fault('VOICE_ASSET_HASH', '语音组件的准备凭据与安装包不符');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw fault('VOICE_ASSET_MISSING', '语音资源尚未准备');
    }
  }

  async function checkReady(selected,options={}) {
    options.signal?.throwIfAborted();await checkMarker(selected);options.signal?.throwIfAborted();
    await verifier.verify(selected,options);options.signal?.throwIfAborted();
  }

  async function status(kind, engineId) {
    try {
      const selected = await plan(kind, engineId);
      const base = { version: selected.descriptor.version, bytes: selected.total };
      if (pending.has(selected.destination)) return { ...base, state: 'preparing' };
      // A settings/status read reports the completed install transaction. Full
      // file identity and hash verification remains mandatory in resolve(),
      // before a worker can execute; do not read gigabytes just to open settings.
      try { await checkMarker(selected); }
      catch (error) { return { ...base, state: error.code === 'VOICE_ASSET_MISSING' ? 'missing' : 'error', code: error.code }; }
      return { ...base, state: 'ready',verification:'before-use' };
    } catch (error) {
      return { state: 'unavailable', code: error.code ?? 'VOICE_ASSET_MANIFEST' };
    }
  }

  async function resolve(kind, engineId, options={}) {
    options.signal?.throwIfAborted();const selected = await plan(kind, engineId);
    await checkReady(selected,options);
    await assertPluginTreeNoLinks(selected.cacheRoot);
    await mkdir(selected.cacheRoot, { recursive: true });
    const { descriptor, destination } = selected;
    return { python: join(destination, descriptor.python), script: selected.script, root: destination, assetRoot: destination,
      cacheRoot: selected.cacheRoot, sharedDirectory: selected.sharedDirectory, proof: selected.proof,
      ...(descriptor.ffmpegDirectory ? { ffmpegDirectory: join(destination, descriptor.ffmpegDirectory) } : {}) };
  }

  async function prepare(kind, { engineId, localRoot, signal, onProgress = () => {} } = {}) {
    if (localRoot != null && !isAbsolute(localRoot)) throw fault('VOICE_ASSET_SOURCE', '本地语音组件目录无效');
    const selected = await plan(kind, engineId);
    if (pending.has(selected.destination)) return pending.get(selected.destination);
    const operation = (async () => {
      try { await checkReady(selected,{signal,onProgress}); return { state: 'ready', reused: true }; }
      catch (error) {
        if (error.code !== 'VOICE_ASSET_MISSING') throw error;
      }
      const { descriptor, destination } = selected;
      const parent = dirname(destination);
      await assertPluginTreeNoLinks(parent);
      await mkdir(parent,{recursive:true});
      // A completed tree remains unadmitted after a failed Windows rename.
      // Recheck its signed bytes and ownership before retrying that promotion.
      for(const entry of await readdir(parent,{withFileTypes:true})){
        if(!entry.isDirectory()||!/^stage-[a-f0-9-]{36}$/.test(entry.name))continue;
        const previous=join(parent,entry.name);await assertPluginTreeNoLinks(previous);
        let marker;try{marker=await readFile(join(previous,'.ready'),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(marker!==selected.proof)continue;
        await checkReady({...selected,destination:previous},{signal,onProgress});signal?.throwIfAborted();
        if((await plan(kind,engineId)).proof!==selected.proof)throw fault('VOICE_ASSET_REVOKED','语音组件版本已更改');
        await promote(previous,destination,{retryBudgetMs:10000});return {state:'ready',reused:true,resumed:true};
      }
      if (!localRoot && descriptor.files.some(file => !file.url)) {
        throw fault('VOICE_ASSET_OFFLINE_REQUIRED', '请先选择此版本的已验证离线语音运行组件目录');
      }
      const staging = join(parent, 'stage-' + randomUUID());
      await assertPluginTreeNoLinks(staging);
      await mkdir(parent, { recursive: true });
      await mkdir(staging);
      let total = 0,complete=false;
      try {
        for (const file of descriptor.files) {
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
            input = await download(file, signal, fetchImpl);
          }
          const hash = createHash('sha256');
          let count = 0;
          const check = new Transform({ transform(chunk, _, done) {
            count += chunk.length;
            if (count > file.bytes) return done(fault('VOICE_ASSET_HASH', '语音资源大于清单声明'));
            hash.update(chunk);
            done(null, chunk);
          } });
          await pipeline(input, check, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
          if (count !== file.bytes || hash.digest('hex') !== file.sha256) {
            throw fault('VOICE_ASSET_HASH', '语音资源摘要与清单不符');
          }
          total += count;
          onProgress({ kind, receivedBytes: total, totalBytes: selected.total });
        }
        signal?.throwIfAborted();
        if ((await plan(kind, engineId)).proof !== selected.proof) throw fault('VOICE_ASSET_REVOKED', '语音插件或组件版本已更改');
        const marker = createWriteStream(join(staging, '.ready'), { flags: 'wx', mode: 0o600 });
        await pipeline(Readable.from([selected.proof]), marker, { signal });
        complete=true;
        await promote(staging, destination,{retryBudgetMs:10000});
        return { state: 'ready', reused: false };
      } finally {
        await assertPluginTreeNoLinks(staging);
        if(!complete)await rm(staging, { recursive: true, force: true });
      }
    })();
    pending.set(selected.destination, operation);
    try { return await operation; }
    finally { pending.delete(selected.destination); }
  }

  return { status, prepare, resolve, close:()=>verifier.close() };
}
