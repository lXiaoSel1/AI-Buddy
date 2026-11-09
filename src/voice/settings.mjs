import {readFile,mkdir,lstat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {writeAtomic} from '../atomic-write.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {VOICE_ENGINES} from './package-contract.mjs';
import {createHash,randomUUID} from 'node:crypto';

const ids=Object.keys(VOICE_ENGINES);
const fault=()=>Object.assign(Error('语音设置无效；这里只保存配置和密钥引用'),{code:'VOICE_SETTINGS_INVALID'});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const validRef=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const models=['speech-2.8-turbo','speech-2.8-hd'];
export const defaultVoiceSettings=()=>({schemaVersion:1,enabled:false,selectedPackageId:ids[0],
  packages:Object.fromEntries(ids.map(id=>[id,{ttsProvider:'local',sttProvider:'local',credentialRef:null}])),cloudConnections:{selectedId:null,items:[]}});

function validateConnections(value){
  if(!plain(value)||Object.keys(value).some(key=>!['selectedId','items'].includes(key))||!Array.isArray(value.items)||value.items.length>100)throw fault();
  const seen=new Set();
  for(const row of value.items){
    if(!plain(row)||Object.keys(row).some(key=>!['id','name','provider','model','credentialRef'].includes(key))||!validId(row.id)||seen.has(row.id)||
      typeof row.name!=='string'||!row.name.trim()||row.name.length>100||/[\r\n\0]/.test(row.name)||row.provider!=='minimax'||!models.includes(row.model)||
      row.credentialRef!==null&&!validRef(row.credentialRef))throw fault();
    seen.add(row.id);
  }
  if(value.selectedId!==null&&!seen.has(value.selectedId))throw fault();
  return structuredClone(value);
}
function migrateConnections(value){
  value.cloudConnections??={selectedId:null,items:[]};
  const connections=value.cloudConnections;
  for(const row of Object.values(value.packages))if(row.credentialRef&&!connections.items.some(item=>item.credentialRef===row.credentialRef)){
    connections.items.push({id:'legacy-'+createHash('sha256').update(row.credentialRef).digest('hex').slice(0,20),name:connections.items.length?'MiniMax 旧配置 '+(connections.items.length+1):'MiniMax 默认配置',
      provider:'minimax',model:models[0],credentialRef:row.credentialRef});
  }
  if(!connections.selectedId)connections.selectedId=connections.items.find(row=>row.credentialRef===value.packages[value.selectedPackageId]?.credentialRef)?.id??connections.items[0]?.id??null;
  return value;
}

export function mergeVoiceSettings(current,patch) {
  if(!plain(patch)||Object.keys(patch).some(key=>!['enabled','selectedPackageId','packages','schemaVersion','cloudConnections'].includes(key))||
      patch.schemaVersion!==undefined&&patch.schemaVersion!==1||patch.enabled!==undefined&&typeof patch.enabled!=='boolean'||
      patch.selectedPackageId!==undefined&&!ids.includes(patch.selectedPackageId)||patch.packages!==undefined&&!plain(patch.packages))throw fault();
  const next=structuredClone(current);
  if(patch.enabled!==undefined)next.enabled=patch.enabled;
  if(patch.selectedPackageId!==undefined)next.selectedPackageId=patch.selectedPackageId;
  for(const [id,row] of Object.entries(patch.packages??{})){
    if(!ids.includes(id)||!plain(row)||Object.keys(row).some(key=>!['ttsProvider','sttProvider','credentialRef'].includes(key))||
        row.ttsProvider!==undefined&&!['local','minimax'].includes(row.ttsProvider)||
        row.sttProvider!==undefined&&row.sttProvider!=='local'||
        row.credentialRef!==undefined&&row.credentialRef!==null&&!validRef(row.credentialRef))throw fault();
    next.packages[id]={...next.packages[id],...row};
  }
  if(patch.cloudConnections!==undefined)next.cloudConnections=validateConnections(patch.cloudConnections);
  migrateConnections(next);
  // Legacy save-key operations still select the freshly saved reference.
  const changedRef=patch.packages?.[next.selectedPackageId]?.credentialRef;
  if(patch.cloudConnections===undefined&&changedRef)next.cloudConnections.selectedId=next.cloudConnections.items.find(row=>row.credentialRef===changedRef).id;
  return next;
}

/** Independent plugin choices. Secrets belong to the host credential store. */
export function createVoiceSettings({dataRoot}={}) {
  const path=dataRoot?join(dataRoot,'voice','settings.json'):null;
  let memory=defaultVoiceSettings(),pending=Promise.resolve(),cachedSignature;
  const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');
  async function read(){
    if(!path)return structuredClone(memory);
    try{
      const before=await lstat(path,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>1024n*1024n)throw fault();
      if(signature(before)===cachedSignature)return structuredClone(memory);
      await assertPluginTreeNoLinks(path);
      const value=mergeVoiceSettings(defaultVoiceSettings(),JSON.parse(await readFile(path,'utf8'))),after=await lstat(path,{bigint:true});
      if(signature(before)!==signature(after))throw fault();
      memory=value;cachedSignature=signature(after);return structuredClone(value);
    }
    catch(error){if(error.code==='ENOENT')return defaultVoiceSettings();throw error;}
  }
  async function mutate(change){
    const result=pending.then(async()=>{
      const value=await change(await read());
      if(path){await assertPluginTreeNoLinks(path);await mkdir(dirname(path),{recursive:true});await assertPluginTreeNoLinks(path);writeAtomic(path,JSON.stringify(value));cachedSignature=signature(await lstat(path,{bigint:true}));}
      memory=value;
      return structuredClone(value);
    });
    pending=result.catch(()=>{});return result;
  }
  const api={
    get:()=>pending.then(read),
    update(patch){
      return mutate(current=>mergeVoiceSettings(current,patch));
    },
    async listConnections(){return (await api.get()).cloudConnections;},
    async saveConnection(input){
      if(!plain(input)||Object.keys(input).some(key=>!['id','name','provider','model','credentialRef'].includes(key)))throw fault();
      let saved;
      await mutate(current=>{
        const rows=current.cloudConnections.items,previous=input.id?rows.find(row=>row.id===input.id):null;
        if(input.id&&!previous)throw fault();
        saved={...(previous??{id:'minimax-'+randomUUID(),provider:'minimax',model:models[0],credentialRef:null}),...input};
        const items=previous?rows.map(row=>row.id===saved.id?saved:row):[...rows,saved];
        current.cloudConnections=validateConnections({selectedId:current.cloudConnections.selectedId??saved.id,items});
        if(current.cloudConnections.selectedId===saved.id)for(const row of Object.values(current.packages))row.credentialRef=saved.credentialRef;
        return current;
      });
      return structuredClone(saved);
    },
    async selectConnection(id){
      const value=await mutate(current=>{
        const selected=current.cloudConnections.items.find(row=>row.id===id);if(!selected)throw fault();
        current.cloudConnections.selectedId=id;for(const row of Object.values(current.packages))row.credentialRef=selected.credentialRef;
        return current;
      });return value.cloudConnections;
    },
    async removeConnection(id){
      const value=await mutate(current=>{
        const old=current.cloudConnections.items.find(row=>row.id===id);if(!old)throw fault();
        const list=current.cloudConnections;list.items=list.items.filter(row=>row.id!==id);
        if(list.selectedId===id){list.selectedId=list.items[0]?.id??null;for(const row of Object.values(current.packages))row.credentialRef=list.items[0]?.credentialRef??null;}
        return current;
      });return value.cloudConnections;
    },
    async resolveConnection({packageId}={}){
      if(!ids.includes(packageId))throw fault();
      const current=await api.get(),list=current.cloudConnections;
      const row=list.items.find(row=>row.id===list.selectedId);
      if(!row?.credentialRef)throw Object.assign(Error('请先在云配音配置中保存 MiniMax API Key'),{code:'CLOUD_KEY_REQUIRED'});
      return {id:row.id,name:row.name,provider:row.provider,model:row.model,keyRef:row.credentialRef};
    },
  };
  return api;
}
