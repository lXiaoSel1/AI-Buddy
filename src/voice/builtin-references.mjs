import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {PET_CHARACTERS} from '../pet-characters.mjs';
import {VOICE_ENGINES} from './package-contract.mjs';
import {validateWav,voicePresetReceiptKey} from './voice-profiles.mjs';

const indexFile='presets/index.json';
const bundleId='ai-buddy.character-voices-r04';
const roster=new Set(PET_CHARACTERS.map(({id})=>id));
const languages=new Set(['zh','en','ja','ko','yue']);
const maxIndexBytes=1024*1024;
const maxWavBytes=20_000_000;
const unavailable=()=>Object.assign(new Error('这个角色的内置云克隆参考录音不可用'),{code:'CLOUD_REFERENCE'});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

function installedCandidates(platform){
  const statuses=platform?.voicePackageStatus?.()??[];
  return Object.entries(VOICE_ENGINES).flatMap(([id,contract])=>{
    const row=statuses.find(item=>item.id===id);
    if(!row?.installed||!['ready','disabled'].includes(row.state))return [];
    const engine=contract.engine==='gpt-sovits'?'gpt':contract.engine;
    return [{id,engine,row,key:voicePresetReceiptKey(row)+'|'+(row.generation??0)}];
  });
}

async function statStamp(path,bytes){
  const value=await lstat(path);
  if(!value.isFile()||value.nlink!==1||value.size!==bytes)throw unavailable();
  return [value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs].join(':');
}

async function readSignedFile(lease,file,binding,limit){
  if(!binding||!Number.isSafeInteger(binding.bytes)||binding.bytes<1||binding.bytes>limit||!validHash(binding.sha256))throw unavailable();
  const path=join(lease.directory,file);
  lease.assertCurrent();
  await assertPluginTreeNoLinks(path);
  const stamp=await statStamp(path,binding.bytes);
  const bytes=await readFile(path);
  await assertPluginTreeNoLinks(path);
  if(await statStamp(path,binding.bytes)!==stamp||bytes.length!==binding.bytes||digest(bytes)!==binding.sha256)throw unavailable();
  lease.assertCurrent();
  return {bytes,stamp,path};
}

async function signedIndex(platform,candidate){
  const {id,engine,row}=candidate;
  const lease=await platform.resolveVoicePresetPackage(id);
  if(lease?.manifest?.id!==id||!isAbsolute(lease.directory??'')||typeof lease.assertCurrent!=='function'||
    voicePresetReceiptKey({id,sourceId:lease.sourceId,version:lease.version,archiveSha256:lease.archiveSha256})!==voicePresetReceiptKey(row))throw unavailable();
  const files=new Map(lease.manifest.files.map(binding=>[binding.path,binding]));
  const indexBinding=files.get(indexFile);
  const signed=await readSignedFile(lease,indexFile,indexBinding,maxIndexBytes);
  const index=JSON.parse(signed.bytes.toString('utf8'));
  if(index?.schemaVersion!==1||index.bundleId!==bundleId||index.engine!==engine||
    !Number.isSafeInteger(index.version)||index.version<1||!Array.isArray(index.profiles)||index.profiles.length>roster.size)throw unavailable();

  const seen=new Set(),references=new Map();
  for(const {characterId,cloudReference:ref} of index.profiles){
    if(!roster.has(characterId)||seen.has(characterId))throw unavailable();
    seen.add(characterId);
    const expected='presets/audio/'+characterId+(engine==='breeze'?'-calm.wav':'-cloud.wav');
    if(ref?.file!==expected||!Number.isFinite(ref.durationMs)||ref.durationMs<10000||ref.durationMs>300000||
      typeof ref.text!=='string'||ref.text.length>500||!ref.text.trim()||!languages.has(ref.language))continue;
    const binding=files.get(expected);
    if(!binding||!Number.isSafeInteger(ref.bytes)||ref.bytes<44||ref.bytes>maxWavBytes||
      ref.bytes!==binding.bytes||!validHash(ref.sha256)||ref.sha256!==binding.sha256)continue;
    references.set(characterId,{file:expected,binding,language:ref.language,text:ref.text.trim(),durationMs:ref.durationMs,version:index.version,source:engine});
  }
  return {lease,references,index:{path:signed.path,stamp:signed.stamp,bytes:indexBinding.bytes}};
}

async function referenceStamps({lease,references,index}){
  lease.assertCurrent();
  await assertPluginTreeNoLinks(index.path);
  if(await statStamp(index.path,index.bytes)!==index.stamp)throw unavailable();
  await assertPluginTreeNoLinks(join(lease.directory,'presets','audio'));
  const stamps=await Promise.all([...references.values()].map(ref=>statStamp(join(lease.directory,ref.file),ref.binding.bytes)));
  lease.assertCurrent();
  return stamps;
}

export function createBuiltinVoiceReferences({platform=()=>null}={}){
  const metadata=new Map();
  let catalogWork;

  function sources(){
    try{
      const service=platform();
      return {service,candidates:installedCandidates(service)};
    }catch{return {service:null,candidates:[]};}
  }

  async function loadCatalog(){
    const {service,candidates}=sources();
    const active=new Set(candidates.map(row=>row.id));
    for(const id of metadata.keys())if(!active.has(id))metadata.delete(id);
    const result=new Map();
    for(const candidate of candidates){
      try{
        let saved=metadata.get(candidate.id);
        if(saved?.key!==candidate.key){
          const packet=await signedIndex(service,candidate);
          saved={key:candidate.key,packet,stamps:await referenceStamps(packet)};
          metadata.set(candidate.id,saved);
        }else{
          const stamps=await referenceStamps(saved.packet);
          if(stamps.some((stamp,i)=>stamp!==saved.stamps[i]))throw unavailable();
        }
        for(const [id,{durationMs,version,source,binding,language}] of saved.packet.references){
          if(!result.has(id))result.set(id,{durationMs,version,source,sha256:binding.sha256,language});
        }
        if(result.size===roster.size)break;
      }catch{
        metadata.delete(candidate.id);
      }
    }
    return result;
  }

  async function info(characterId){
    if(!roster.has(characterId))return null;
    // The settings page asks for the whole roster concurrently.
    catalogWork??=loadCatalog().finally(()=>{catalogWork=null;});
    const value=(await catalogWork).get(characterId);
    return value?{...value}:null;
  }

  async function read(characterId){
    if(!roster.has(characterId))throw unavailable();
    const {service,candidates}=sources();
    for(const candidate of candidates){
      try{
        const {lease,references,index}=await signedIndex(service,candidate),ref=references.get(characterId);
        if(!ref)continue;
        const audio=await readSignedFile(lease,ref.file,ref.binding,maxWavBytes);
        const {durationMs}=validateWav(audio.bytes,{maxDurationSeconds:300,strictContainer:true});
        if(durationMs<10000||Math.abs(durationMs-ref.durationMs)>1)throw unavailable();
        const assertCurrent=async()=>{
          try{
            lease.assertCurrent();
            await assertPluginTreeNoLinks(index.path);
            await assertPluginTreeNoLinks(audio.path);
            if(await statStamp(index.path,index.bytes)!==index.stamp||
              await statStamp(audio.path,ref.binding.bytes)!==audio.stamp)throw unavailable();
            lease.assertCurrent();
          }catch{throw unavailable();}
        };
        await assertCurrent();
        return {bytes:audio.bytes,text:ref.text,format:'wav',version:ref.version,durationMs,source:ref.source,sha256:ref.binding.sha256,language:ref.language,assertCurrent};
      }catch{
        metadata.delete(candidate.id);
      }
    }
    throw unavailable();
  }

  return {info,read};
}
