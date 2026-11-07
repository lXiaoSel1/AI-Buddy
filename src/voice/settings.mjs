import {readFile,mkdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {writeAtomic} from '../atomic-write.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {VOICE_ENGINES} from './package-contract.mjs';

const ids=Object.keys(VOICE_ENGINES);
const fault=()=>Object.assign(Error('语音设置无效；这里只保存配置和密钥引用'),{code:'VOICE_SETTINGS_INVALID'});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
export const defaultVoiceSettings=()=>({schemaVersion:1,enabled:false,selectedPackageId:ids[0],
  packages:Object.fromEntries(ids.map(id=>[id,{ttsProvider:'local',sttProvider:'local',credentialRef:null}]))});

export function mergeVoiceSettings(current,patch) {
  if(!plain(patch)||Object.keys(patch).some(key=>!['enabled','selectedPackageId','packages','schemaVersion'].includes(key))||
      patch.schemaVersion!==undefined&&patch.schemaVersion!==1||patch.enabled!==undefined&&typeof patch.enabled!=='boolean'||
      patch.selectedPackageId!==undefined&&!ids.includes(patch.selectedPackageId)||patch.packages!==undefined&&!plain(patch.packages))throw fault();
  const next=structuredClone(current);
  if(patch.enabled!==undefined)next.enabled=patch.enabled;
  if(patch.selectedPackageId!==undefined)next.selectedPackageId=patch.selectedPackageId;
  for(const [id,row] of Object.entries(patch.packages??{})){
    if(!ids.includes(id)||!plain(row)||Object.keys(row).some(key=>!['ttsProvider','sttProvider','credentialRef'].includes(key))||
        row.ttsProvider!==undefined&&!['local','minimax'].includes(row.ttsProvider)||
        row.sttProvider!==undefined&&row.sttProvider!=='local'||
        row.credentialRef!==undefined&&row.credentialRef!==null&&!(typeof row.credentialRef==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(row.credentialRef)))throw fault();
    next.packages[id]={...next.packages[id],...row};
  }
  return next;
}

/** Independent plugin choices. Secrets belong to the host credential store. */
export function createVoiceSettings({dataRoot}={}) {
  const path=dataRoot?join(dataRoot,'voice','settings.json'):null;
  let memory=defaultVoiceSettings(),pending=Promise.resolve();
  async function read(){
    if(!path)return structuredClone(memory);
    await assertPluginTreeNoLinks(path);
    try{return mergeVoiceSettings(defaultVoiceSettings(),JSON.parse(await readFile(path,'utf8')));}
    catch(error){if(error.code==='ENOENT')return defaultVoiceSettings();throw error;}
  }
  return {
    get:()=>pending.then(read),
    update(patch){
      const result=pending.then(async()=>{
        const value=mergeVoiceSettings(await read(),patch);
        if(path){await assertPluginTreeNoLinks(path);await mkdir(dirname(path),{recursive:true});await assertPluginTreeNoLinks(path);writeAtomic(path,JSON.stringify(value));}else memory=value;
        return structuredClone(value);
      });
      pending=result.catch(()=>{});return result;
    },
  };
}
