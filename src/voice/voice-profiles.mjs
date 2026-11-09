import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertPluginTreeNoLinks } from '../plugin-archive.mjs';
import { writeAtomic, writeAtomicAsync } from '../atomic-write.mjs';
import { PET_CHARACTERS } from '../pet-characters.mjs';

const styles = ['calm', 'happy', 'sad', 'angry'];
const engines = ['breeze', 'gpt'];
const languages = ['zh', 'en', 'ja', 'ko', 'yue'];
const maxReferenceBytes = 16 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = (message, code = 'VOICE_PROFILE_INVALID') => Object.assign(new Error(message), { code });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const voicePresetReceiptKey = row => JSON.stringify([row.sourceId,row.id,row.version,row.archiveSha256]);

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
    ...(Number.isFinite(Date.parse(row.importedAt)) ? {importedAt:row.importedAt,...(row.importedAtSource?{importedAtSource:row.importedAtSource}:{})} : {}),
    availableReferences: styles.filter(style => Object.hasOwn(row.references, style)),
    ...(row.cloudVoiceId ? { cloudVoiceId: row.cloudVoiceId } : {}),
    ...(row.bundledPreset ? { bundledPreset: { bundleId: row.bundledPreset.bundleId, version: row.bundledPreset.version } } : {}) };
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
    const rows=Object.values(state.profiles).filter(row => row.characterId === params.characterId && row.engine === params.engine);
    return Promise.all(rows.map(async row=>{
      if(row.bundledPreset||Number.isFinite(Date.parse(row.importedAt)))return publicProfile(row);
      // Older imports predate import timestamps. Report the existing directory's
      // creation date without rewriting their index, references or selection.
      const directory=join(root,validId(row.storageId)?row.storageId:row.id);
      try{await assertPluginTreeNoLinks(directory);const info=await lstat(directory),at=info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs;return publicProfile({...row,importedAt:new Date(at).toISOString(),importedAtSource:'filesystem'});}
      catch(error){if(error.code!=='ENOENT')throw error;return publicProfile(row);}
    }));
  }

  async function hasBundledPresets(receiptKey) {
    return Object.hasOwn((await load()).bundledPresets??{},receiptKey);
  }

  // Only the trusted host supplies this non-activating, signed-package lease.
  // The index is the sole visibility boundary for rows, selections and receipt.
  function ensureBundledPresets({lease,receiptKey}) {
    return serialize(async()=>{
      const fail=message=>invalid(message,'VOICE_PRESET_INVALID');
      lease.assertCurrent();
      if(receiptKey!==voicePresetReceiptKey({sourceId:lease.sourceId,id:lease.manifest.id,version:lease.version,archiveSha256:lease.archiveSha256}))throw fail('预制声线包身份无效');
      if(await hasBundledPresets(receiptKey))return {imported:0,reused:true};
      const manifest=lease.manifest,engine=manifest.id==='ai-buddy.voice-breeze'?'breeze':manifest.id==='ai-buddy.voice-gpt-sovits'?'gpt':null;
      if(!engine)throw fail('预制声线引擎无效');
      const declared=manifest.files.find(row=>row.path==='presets/index.json');
      if(!declared)return {imported:0,missing:true};
      async function boundFile(file,maximum){
        const binding=manifest.files.find(row=>row.path===file);
        if(!binding||!Number.isSafeInteger(binding.bytes)||binding.bytes<1||binding.bytes>maximum)throw fail('预制声线文件未绑定到签名清单');
        const location=join(lease.directory,file);await assertPluginTreeNoLinks(location);
        const info=await lstat(location);if(!info.isFile()||info.nlink!==1||info.size!==binding.bytes)throw fail('预制声线文件大小无效');
        const bytes=await readFile(location);if(bytes.length!==binding.bytes||digest(bytes)!==binding.sha256)throw fail('预制声线文件校验失败');
        lease.assertCurrent();return {bytes,binding};
      }
      const {bytes:indexBytes}=await boundFile('presets/index.json',1024*1024);
      let index;try{index=JSON.parse(indexBytes.toString('utf8'));}catch{throw fail('预制声线清单无效');}
      if(index?.schemaVersion!==1||index.bundleId!=='ai-buddy.character-voices-r04'||index.version!==1||index.engine!==engine||!Array.isArray(index.profiles)||index.profiles.length!==PET_CHARACTERS.length)throw fail('预制声线清单身份无效');
      const seen=new Set(),prepared=[];
      for(const input of index.profiles){
        const {characterId,label,references,cloudReference}=input??{};
        if(!PET_CHARACTERS.some(row=>row.id===characterId)||seen.has(characterId)||typeof label!=='string'||!label.trim()||label.length>80||!references?.calm||Object.keys(references).length!==1||!cloudReference)throw fail('预制声线角色或参考无效');
        seen.add(characterId);const stored={},audio={};
        for(const [style,ref] of [['calm',references.calm],['cloud',cloudReference]]){
          if(!ref||typeof ref.file!=='string'||!/^presets\/audio\/[a-zA-Z0-9_-]+\.wav$/.test(ref.file)||typeof ref.text!=='string'||!ref.text.trim()||ref.text.length>500||!languages.includes(ref.language)||!Number.isFinite(ref.durationMs)||ref.durationMs<=0)throw fail('预制声线参考路径或文字无效');
          const {bytes,binding}=await boundFile(ref.file,maxReferenceBytes);
          if(ref.bytes!==binding.bytes||ref.sha256!==binding.sha256)throw fail('预制声线参考与签名清单不匹配');
          let durationMs;try{({durationMs}=validateWav(bytes));}catch{throw fail('预制声线 WAV 无效');}
          if(Math.abs(durationMs-ref.durationMs)>1||(engine==='gpt'&&style==='calm'&&(durationMs<3000||durationMs>10000)))throw fail('预制声线参考时长无效');
          stored[style]={text:ref.text.trim(),language:ref.language,bytes:bytes.length,sha256:binding.sha256,durationMs};audio[style]=bytes;
        }
        const identity=[index.bundleId,index.version,engine,characterId],id='preset-'+digest(JSON.stringify(identity));
        const contentSha256=digest(JSON.stringify([label.trim(),stored]));
        prepared.push({row:{id,version:1,characterId,engine,label:label.trim(),references:stored,bundledPreset:{bundleId:index.bundleId,version:index.version,engine,contentSha256,packageId:manifest.id,packageVersion:lease.version,sourceId:lease.sourceId,archiveSha256:lease.archiveSha256}},audio});
      }
      lease.assertCurrent();
      const state=await load(),newRows=[];
      for(const item of prepared){
        const existing=state.profiles[item.row.id];
        if(existing){if(existing.bundledPreset?.contentSha256!==item.row.bundledPreset.contentSha256)throw fail('同一预制声线版本的内容已改变');}
        else newRows.push(item);
      }
      await assertPluginTreeNoLinks(root);await mkdir(root,{recursive:true});
      const staging=join(root,'.presets-'+randomUUID()),promoted=[];let committed=false;
      await mkdir(staging);
      try{
        for(const {row,audio} of newRows){
          const dir=join(staging,row.id);await mkdir(dir);
          for(const [style,bytes] of Object.entries(audio))await writeFile(join(dir,style+'.wav'),bytes,{flag:'wx',mode:0o600});
        }
        lease.assertCurrent();
        for(const {row} of newRows){
          const dir=join(root,row.id);await assertPluginTreeNoLinks(dir);
          // Never overwrite an existing (including abandoned) profile directory.
          // A unique storage suffix makes interrupted imports safely retryable.
          row.storageId='preset-data-'+randomUUID();const destination=join(root,row.storageId);
          await rename(join(staging,row.id),destination);promoted.push(destination);
          const key=scope(row),empty=!Object.hasOwn(state.selections,key)&&!Object.values(state.profiles).some(old=>old.characterId===row.characterId&&old.engine===row.engine);
          state.profiles[row.id]=row;if(empty)state.selections[key]=row.id;
        }
        state.bundledPresets??={};state.bundledPresets[receiptKey]={bundleId:index.bundleId,version:index.version,engine,profileIds:prepared.map(item=>item.row.id)};
        lease.assertCurrent();
        await writeAtomicAsync(indexPath,JSON.stringify(state),{renameImpl:async(source,target)=>{lease.assertCurrent();await rename(source,target);}});
        committed=true;return {imported:newRows.length,reused:newRows.length===0};
      }finally{
        await rm(staging,{recursive:true,force:true});
        if(!committed)for(const dir of promoted)await rm(dir,{recursive:true,force:true});
      }
    });
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
      const row = { id, version: 1, characterId, engine, label: label.trim(), importedAt:new Date().toISOString(), references: stored, ...(cloudVoiceId ? { cloudVoiceId } : {}) };
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
    const storageId=validId(row.storageId)?row.storageId:id;
    const file = join(root, storageId, style + '.wav');
    await assertPluginTreeNoLinks(file);
    const info = await lstat(file);
    if (!info.isFile() || info.size !== ref.bytes || info.size > maxReferenceBytes ||
        digest(await readFile(file)) !== ref.sha256) throw invalid('声音参考文件校验失败', 'VOICE_REFERENCE_CHANGED');
    const cloud=row.references.cloud??row.references.calm;
    const cloudPath=join(root,storageId,(row.references.cloud?'cloud':'calm')+'.wav');
    await assertPluginTreeNoLinks(cloudPath);
    const cloudInfo=await lstat(cloudPath),cloudBytes=await readFile(cloudPath);
    if(!cloudInfo.isFile()||cloudInfo.size!==cloud.bytes||digest(cloudBytes)!==cloud.sha256)throw invalid('云声音参考校验失败','VOICE_REFERENCE_CHANGED');
    return { id:row.id,version:row.version,characterId:row.characterId,engine:row.engine,
      path:file,text:ref.text,language:ref.language,sha256:ref.sha256,bytes:ref.bytes,durationMs:ref.durationMs,
      cloudReference:{path:cloudPath,text:cloud.text,language:cloud.language,sha256:cloud.sha256,bytes:cloud.bytes,
        durationMs:cloud.durationMs??validateWav(cloudBytes).durationMs,authorized:true},
      referenceStyle:style,referenceSource:source };
  }

  return { list, current, select, importProfile, resolve, hasBundledPresets, ensureBundledPresets };
}
