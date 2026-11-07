import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertPluginTreeNoLinks } from '../plugin-archive.mjs';
import { writeAtomic } from '../atomic-write.mjs';

const styles = ['calm', 'happy', 'sad', 'angry'];
const engines = ['breeze', 'gpt'];
const languages = ['zh', 'en', 'ja', 'ko', 'yue'];
const maxReferenceBytes = 16 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = (message, code = 'VOICE_PROFILE_INVALID') => Object.assign(new Error(message), { code });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

function validateWav(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw invalid('声音参考必须是 WAV 文件');
  }
  let format;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw invalid('WAV 文件不完整');
    if (tag === 'fmt ' && size >= 16) {
      format = { codec: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4), block: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    }
    if (tag === 'data') dataSize = size;
    offset = start + size + (size % 2);
  }
  if (!format || ![1, 3].includes(format.codec) || ![1, 2].includes(format.channels) ||
      format.rate < 8000 || format.rate > 192000 || ![8, 16, 24, 32].includes(format.bits) ||
      format.block !== format.channels * format.bits / 8 || (format.codec === 3 && format.bits !== 32) ||
      !dataSize || dataSize % format.block || dataSize / format.block / format.rate > 30) {
    throw invalid('声音参考须为 30 秒以内的单声道或立体声 PCM WAV');
  }
  return {durationMs:dataSize/format.block/format.rate*1000};
}

function publicProfile(row) {
  return { id: row.id, version: row.version, characterId: row.characterId, engine: row.engine, label: row.label,
    availableReferences: styles.filter(style => Object.hasOwn(row.references, style)),
    ...(row.cloudVoiceId ? { cloudVoiceId: row.cloudVoiceId } : {}) };
}

export function createVoiceProfiles({ dataRoot }) {
  const root = join(dataRoot, 'voice', 'profiles');
  const indexPath = join(root, 'index.json');
  let pending = Promise.resolve();

  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  function scope({ characterId, engine }) {
    if (!validId(characterId) || !engines.includes(engine)) throw invalid('声音档案角色或引擎无效');
    return characterId + ':' + engine;
  }

  async function load() {
    await assertPluginTreeNoLinks(indexPath);
    try {
      const saved = JSON.parse(await readFile(indexPath, 'utf8'));
      if (saved.version !== 1 || !saved.profiles || !saved.selections) throw invalid('声音档案版本不支持');
      return saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, profiles: {}, selections: {} };
    }
  }

  async function list(params) {
    scope(params);
    const state = await load();
    return Object.values(state.profiles).filter(row => row.characterId === params.characterId && row.engine === params.engine).map(publicProfile);
  }

  async function current(params) {
    const key = scope(params);
    const state = await load();
    const id = state.selections[key];
    const row = state.profiles[id];
    return row?.characterId === params.characterId && row.engine === params.engine ? publicProfile(row) : null;
  }

  function select(params) {
    const key = scope(params);
    return serialize(async () => {
      const state = await load();
      const row = validId(params.profileId) && state.profiles[params.profileId];
      if (!row || row.characterId !== params.characterId || row.engine !== params.engine) {
        throw invalid('这个声音档案不属于当前角色或引擎', 'VOICE_PROFILE_SCOPE');
      }
      state.selections[key] = row.id;
      writeAtomic(indexPath, JSON.stringify(state));
      return publicProfile(row);
    });
  }

  function importProfile(params) {
    const key = scope(params);
    return serialize(async () => {
      const { characterId, engine, label, references, cloudVoiceId, cloudReference } = params;
      if (typeof label !== 'string' || !label.trim() || label.length > 80 || !references?.calm ||
          Object.keys(references).some(style => !styles.includes(style)) ||
          (cloudVoiceId != null && !validId(cloudVoiceId))) throw invalid('声音档案信息无效');
      const state = await load();
      const prepared = {};
      for (const [style, input] of Object.entries({...references,...(cloudReference?{cloud:cloudReference}:{})})) {
        const { file, text, language } = input;
        if (!isAbsolute(file ?? '') || typeof text !== 'string' || !text.trim() || text.length > 500 ||
            !languages.includes(language)) throw invalid('声音参考或参考文字无效');
        await assertPluginTreeNoLinks(file);
        const info = await lstat(file);
        if (!info.isFile() || info.size > maxReferenceBytes) throw invalid('声音参考文件过大或不可读取');
        const bytes = await readFile(file);
        if (bytes.length !== info.size) throw invalid('声音参考在导入时已变化');
        const {durationMs}=validateWav(bytes);
        prepared[style] = { bytes, text: text.trim(), language, durationMs };
      }

      const id = randomUUID();
      await mkdir(root, { recursive: true });
      const dir = join(root, id);
      await mkdir(dir);
      const stored = {};
      for (const [style, input] of Object.entries(prepared)) {
        const { bytes, text, language, durationMs } = input;
        await writeFile(join(dir, style + '.wav'), bytes, { flag: 'wx', mode: 0o600 });
        stored[style] = { text, language, bytes: bytes.length, sha256: digest(bytes), durationMs };
      }
      const row = { id, version: 1, characterId, engine, label: label.trim(), references: stored, ...(cloudVoiceId ? { cloudVoiceId } : {}) };
      state.profiles[id] = row;
      state.selections[key] = id;
      writeAtomic(indexPath, JSON.stringify(state));
      return publicProfile(row);
    });
  }

  async function resolve(params) {
    const key = scope(params);
    const state = await load();
    const id = params.profileId ?? state.selections[key];
    const row = validId(id) && state.profiles[id];
    if (!row || row.characterId !== params.characterId || row.engine !== params.engine ||
        (params.profileVersion != null && params.profileVersion !== row.version)) {
      throw invalid('当前角色没有匹配的声音档案', 'VOICE_PROFILE_SCOPE');
    }
    const emotion = params.performance?.emotion;
    const manual = styles.includes(params.referenceStyle);
    const proposed = manual ? params.referenceStyle : emotion === 'neutral' ? 'calm' : emotion;
    const eligible = params.engine === 'gpt' && styles.includes(proposed) && Object.hasOwn(row.references, proposed);
    const style = eligible ? proposed : 'calm';
    const source = params.engine === 'breeze' ? 'performance' :
      eligible && manual ? 'manual' : eligible && params.performance?.source === 'model' ? 'automatic' : 'neutral-fallback';
    const ref = row.references[style];
    const file = join(root, id, style + '.wav');
    await assertPluginTreeNoLinks(file);
    const info = await lstat(file);
    if (!info.isFile() || info.size !== ref.bytes || info.size > maxReferenceBytes ||
        digest(await readFile(file)) !== ref.sha256) throw invalid('声音参考文件校验失败', 'VOICE_REFERENCE_CHANGED');
    const cloud=row.references.cloud??row.references.calm;
    const cloudPath=join(root,id,(row.references.cloud?'cloud':'calm')+'.wav');
    await assertPluginTreeNoLinks(cloudPath);
    const cloudInfo=await lstat(cloudPath),cloudBytes=await readFile(cloudPath);
    if(!cloudInfo.isFile()||cloudInfo.size!==cloud.bytes||digest(cloudBytes)!==cloud.sha256)throw invalid('云声音参考校验失败','VOICE_REFERENCE_CHANGED');
    return { id:row.id,version:row.version,characterId:row.characterId,engine:row.engine,
      path:file,text:ref.text,language:ref.language,sha256:ref.sha256,bytes:ref.bytes,durationMs:ref.durationMs,
      cloudReference:{path:cloudPath,text:cloud.text,language:cloud.language,sha256:cloud.sha256,bytes:cloud.bytes,
        durationMs:cloud.durationMs??validateWav(cloudBytes).durationMs,authorized:true},
      referenceStyle:style,referenceSource:source };
  }

  return { list, current, select, importProfile, resolve };
}
