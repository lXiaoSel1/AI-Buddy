import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {writeAtomicAsync} from '../atomic-write.mjs';
import {createCloudProviderRegistry,validCloudVoiceId} from './cloud-providers/index.mjs';
import {MiniMaxSpeechError,minimaxHttpError,minimaxSpeechStatus} from './minimax-speech-errors.mjs';

const providers=['minimax-cn','minimax-global'];
const routes=['local:breeze','local:gpt',...providers.map(id=>'cloud:'+id)];
const models=['speech-2.8-turbo','speech-2.8-hd'];
const missingVoiceCodes=new Set([2042,2054,20132]);
const day=86400000;
const sixDays=6*day,sevenDays=7*day;
const retentionRetryDelay=60*60*1000,retentionRejectionDelay=6*retentionRetryDelay,automaticRetentionLimit=4;
const retentionHttpReasons={
  400:'CLOUD_MINIMAX_PARAMETERS',401:'CLOUD_MINIMAX_AUTH',403:'CLOUD_MINIMAX_AUTH',
  422:'CLOUD_MINIMAX_PARAMETERS',429:'CLOUD_MINIMAX_RATE_LIMIT',
};
const retentionAccountReasons=new Set(['CLOUD_MINIMAX_AUTH','CLOUD_MINIMAX_BALANCE','CLOUD_MINIMAX_QUOTA']);
const retentionReasons=new Set([...retentionAccountReasons,'CLOUD_NETWORK','CLOUD_TIMEOUT','CLOUD_MINIMAX_RATE_LIMIT','CLOUD_MINIMAX_SERVICE',
  'CLOUD_MINIMAX_PARAMETERS','CLOUD_RETENTION_REJECTED','CLOUD_RETENTION_UNCONFIRMED']);
const fault=(code,message)=>Object.assign(new Error(message),{code});
const iso=time=>new Date(time).toISOString();
const timeOf=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const bindingTimes=['lastUsedAt','activatedAt','createdAt'];
const retentionAge=(row,at)=>at-Math.min(at,timeOf(row.lastUsedAt)??timeOf(row.activatedAt)??timeOf(row.createdAt)??at);
const futureBindingTimes=(row,at)=>bindingTimes.filter(field=>(timeOf(row[field])??-Infinity)>at);
const validCharacter=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)&&!['constructor','prototype','__proto__'].includes(value);
const validKey=value=>typeof value==='string'&&value===value.trim()&&value.length>=8&&value.length<=2048&&!/[\r\n\0]/.test(value);
const validAccountId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const validAccountName=value=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=80&&!/[\x00-\x1f\x7f]/.test(value);
const selectedEngine=config=>config.selectedPackageId==='ai-buddy.voice-gpt-sovits'?'gpt':'breeze';
const accountHold={
  auth:300000,balance:300000,quota:300000,rate_limit:15000,service:15000,timeout:15000,network:15000,
};
const fields={
  reset:['confirm'],
  route:['route','enabled'],probe:['providerId','model','key'],save:['providerId','model','key','proof','accountId','name'],
  'account-select':['accountId'],'account-remove':['accountId'],
  voices:[],bind:['targetCharacterId','voiceId','accountRevision'],clone:['targetCharacterId','consentUpload','consentActivation','accountRevision','confirmActivationVoiceId','expectedActivationVoiceId'],
  'abandon-activation':['targetCharacterId','accountRevision','expectedActivationVoiceId','abandonActivationToken'],
  batch:['targetCharacterIds','consentUpload','consentActivation','accountRevision'],
  'reference-preview':['targetCharacterId'],
  asr:['action'],retention:['enabled'],retain:['targetCharacterId'],'migration-ack':[],
};
const newState=(route,enabled)=>({version:1,route,enabled,autoRetain:true,accounts:{},savedAccounts:{},preferredProviderId:null,bindings:{},choices:{},paidOperations:{},retentionAttempts:{},migration:null});
const routeProvider=value=>providers.find(id=>value.route==='cloud:'+id);
const selectedProvider=value=>(value.enabled&&routeProvider(value))||value.preferredProviderId||routeProvider(value)||providers.find(id=>value.accounts[id])||providers[0];
const publicAccount=(row,selected)=>({id:row.id,name:row.name,providerId:row.providerId,model:row.model,last4:row.last4,configured:true,selected});
const defaultAccountName=(providerId,count)=>'MiniMax '+(providerId==='minimax-cn'?'CN':'Global')+(count>0?' '+(count+1):'');

function selectSavedAccount(value,row){
  value.accounts[row.providerId]=row;
  value.preferredProviderId=row.providerId;
}

function removeProviderSelection(value,row){
  if(value.accounts[row.providerId]?.id!==row.id)return;
  const fallback=Object.values(value.savedAccounts).find(account=>account.providerId===row.providerId);
  if(fallback)value.accounts[row.providerId]=fallback;
  else delete value.accounts[row.providerId];
  if(!fallback&&value.preferredProviderId===row.providerId)value.preferredProviderId=null;
}
const publicStatus=error=>error?.category==='auth'?'key_invalid':['balance','quota'].includes(error?.category)?'balance_insufficient':'unavailable';
const keyMatch=(provider,fingerprint)=>provider+':'+fingerprint;
const ownedKey=(provider,fingerprint,id)=>keyMatch(provider,fingerprint)+':'+id;
const bindingKey=({providerId,fingerprint},characterId,sourceId,version)=>['cloud',providerId,fingerprint,characterId,sourceId,version].join(':');
function referenceBindingKey(account,characterId,reference){
  if(!account||!reference||typeof reference.sha256!=='string'||!/^[a-f0-9]{64}$/.test(reference.sha256)||
    typeof reference.language!=='string'||!/^[a-z]{2,8}$/.test(reference.language))return null;
  return bindingKey(account,characterId,'builtin-reference-'+reference.language,reference.sha256);
}
const retentionKey=({providerId,fingerprint},voiceId)=>'voice:'+ownedKey(providerId,fingerprint,voiceId);
const retentionAccountKey=({providerId,fingerprint})=>'account:'+keyMatch(providerId,fingerprint);

function accountRetentionHold(value,account,time){
  const receipt=value.retentionAttempts[retentionAccountKey(account)];
  return retentionAccountReasons.has(receipt?.reasonCode)&&Number.isFinite(receipt.at)&&time-receipt.at<retentionRejectionDelay?receipt:undefined;
}

function recordAccountRetentionRejection(value,account,receipt){
  if(!retentionAccountReasons.has(receipt.reasonCode)||!Number.isFinite(receipt.at))return;
  const key=retentionAccountKey(account),previous=value.retentionAttempts[key];
  if(!Number.isFinite(previous?.at)||previous.at<=receipt.at){
    value.retentionAttempts[key]={at:receipt.at,reasonCode:receipt.reasonCode};
  }
}

function voiceBindings(value,{providerId,fingerprint},voiceId){
  const prefix='cloud:'+keyMatch(providerId,fingerprint)+':';
  return Object.entries(value.bindings).filter(([id,row])=>id.startsWith(prefix)&&row.voiceId===voiceId);
}

function lastConfirmedUse(bindings,at){
  return bindings.reduce((latest,[,row])=>Math.max(latest,Math.min(at,timeOf(row.lastUsedAt)??timeOf(row.activatedAt)??-Infinity)),-Infinity);
}

function pendingActivationIdentity(value,account,characterId){
  if(!account)return undefined;
  const prefix='cloud:'+ownedKey(account.providerId,account.fingerprint,characterId)+':builtin-reference-';
  // Process older receipts in insertion order if an earlier version left more than one.
  return Object.keys(value.paidOperations).find(identity=>
    identity.startsWith(prefix)&&value.paidOperations[identity]?.phase==='activation');
}

function pendingReference(value,identity){
  const row=identity&&value.bindings[identity];
  return row?.state==='voice_pending'?row:undefined;
}

function roleIssue(row){
  if(row?.state==='voice_missing')return {state:'unavailable',status:'unavailable',category:row.state,code:'CLOUD_VOICE_MISSING',message:'声音已失效，请重新选择'};
  if(row?.state==='voice_pending')return {state:'unavailable',status:'unavailable',category:row.state,code:'CLOUD_VOICE_PENDING',message:'已克隆，待激活'};
}

function retentionReason(value,rejected){
  return retentionReasons.has(value)?value:rejected?'CLOUD_RETENTION_REJECTED':'CLOUD_RETENTION_UNCONFIRMED';
}

function retentionAttempt(value,voiceId){
  const rejected=value?.state==='rejected',tries=Number.isSafeInteger(value?.tries)&&value.tries>0?value.tries:1;
  return {
    state:rejected?'rejected':value?.state==='unknown'?'unknown':'submitted',
    at:typeof value==='number'?value:value?.at,
    voiceId,
    // Older builds counted both outcomes together. Keep every unresolved submission in the uncertain budget.
    unknownCount:Number.isSafeInteger(value?.unknownCount)&&value.unknownCount>=0?value.unknownCount:tries-Number(rejected),
    rejectedCount:Number.isSafeInteger(value?.rejectedCount)&&value.rejectedCount>=0?value.rejectedCount:Number(rejected),
    ...(value?.reasonCode?{reasonCode:retentionReason(value.reasonCode,rejected)}:{}),
  };
}

function upgradeRetentionAttempts(value){
  const attempts=value.retentionAttempts;
  for(const [id,attempt] of Object.entries(attempts)){
    if(!id.startsWith('voice:'))continue;
    attempts[id]=retentionAttempt(attempt,attempt?.voiceId);
  }
  for(const [id,row] of Object.entries(value.bindings)){
    const previous=attempts[id];
    if(previous===undefined)continue;
    const [scope,providerId,fingerprint]=id.split(':',3);
    if(scope!=='cloud'||!providers.includes(providerId)||!/^[a-f0-9]{16}$/.test(fingerprint)||!validCloudVoiceId(row.voiceId))continue;
    const key=retentionKey({providerId,fingerprint},row.voiceId);
    const candidate=retentionAttempt(previous,row.voiceId),existing=attempts[key];
    if(!existing)attempts[key]=candidate;
    else{
      const latest=(candidate.at??0)>(existing.at??0)?candidate:existing;
      attempts[key]={...latest,unknownCount:Math.max(candidate.unknownCount,existing.unknownCount),
        rejectedCount:Math.max(candidate.rejectedCount,existing.rejectedCount)};
    }
    delete attempts[id];
  }
  for(const [id,receipt] of Object.entries(attempts)){
    if(!id.startsWith('voice:')||receipt.state!=='rejected')continue;
    const [,providerId,fingerprint]=id.split(':',3);
    if(providers.includes(providerId)&&/^[a-f0-9]{16}$/.test(fingerprint)){
      recordAccountRetentionRejection(value,{providerId,fingerprint},receipt);
    }
  }
}

function clearRetentionAttempts(value,account,active){
  const prefix='voice:'+keyMatch(account.providerId,account.fingerprint)+':',accountKey=retentionAccountKey(account);
  let changed=Object.hasOwn(value.retentionAttempts,accountKey);
  delete value.retentionAttempts[accountKey];
  for(const [id,attempt] of Object.entries(value.retentionAttempts)){
    if(!id.startsWith(prefix))continue;
    if(active?.has(id)&&attempt.state==='submitted'){
      // Preserve the dispatched request but discard both budgets as of the successful check.
      value.retentionAttempts[id]={...attempt,unknownCount:1,rejectedCount:0,rebased:true};
    }else delete value.retentionAttempts[id];
    changed=true;
  }
  return changed;
}

function canRetainAutomatically(previous,time){
  if(!previous)return true;
  if(previous.unknownCount>=automaticRetentionLimit)return false;
  // Keep fixed parameter errors on this voice held until a successful recheck or configuration change.
  if(previous.state==='rejected'&&previous.reasonCode==='CLOUD_MINIMAX_PARAMETERS'&&previous.rejectedCount>0)return false;
  const cooldown=previous.state==='rejected'&&(!previous.reasonCode||retentionAccountReasons.has(previous.reasonCode))?retentionRejectionDelay:retentionRetryDelay;
  return !Number.isFinite(previous.at)||time-previous.at>=cooldown;
}

const storageMessage={
  CLOUD_STORAGE_INVALID:'云配音设置损坏，仍可使用本地语音',
  CLOUD_STORAGE_NEWER:'云配音设置来自更新版本，目前只读',
  CLOUD_STORAGE_UNAVAILABLE:'暂时无法读取云配音设置，请稍后重试',
};
const storageFault=(code='CLOUD_STORAGE_INVALID')=>fault(code,storageMessage[code]);
const describeStorageIssue=code=>({code,message:storageMessage[code],canReset:code==='CLOUD_STORAGE_INVALID'});
function fileFault(error){
  if(error instanceof SyntaxError||['CLOUD_STORAGE_INVALID','INVALID_PLUGIN_ARCHIVE'].includes(error.code))return storageFault();
  return storageFault('CLOUD_STORAGE_UNAVAILABLE');
}

const atomicPartialSuffix=String.raw`\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$`;
const cloudPartialName=new RegExp(String.raw`^builtin-(?:v1|recovered-v1-[1-9][0-9]{0,8})\.json`+atomicPartialSuffix);
const localPartialName=new RegExp(String.raw`^builtin-local-fallback-v1\.json`+atomicPartialSuffix);

async function sweepStalePartials(directory,namePattern,cutoff){
  const sameEntry=(before,after)=>before.dev===after.dev&&before.ino===after.ino&&before.birthtimeNs===after.birthtimeNs;
  const eligible=entry=>entry.isFile()&&entry.nlink===1n&&entry.mtimeNs<cutoff;
  let names,originalDirectory;
  try{
    await assertPluginTreeNoLinks(directory);
    originalDirectory=await lstat(directory,{bigint:true});
    if(!originalDirectory.isDirectory())return;
    names=await readdir(directory);
  }catch{ return; }
  for(const name of names){
    if(!namePattern.test(name))continue;
    const path=join(directory,name);
    try{
      await assertPluginTreeNoLinks(directory);
      const currentDirectory=await lstat(directory,{bigint:true});
      if(!currentDirectory.isDirectory()||!sameEntry(originalDirectory,currentDirectory))return;
      const entry=await lstat(path,{bigint:true});
      if(!eligible(entry))continue;
      await assertPluginTreeNoLinks(directory);
      const finalDirectory=await lstat(directory,{bigint:true});
      if(!finalDirectory.isDirectory()||!sameEntry(originalDirectory,finalDirectory))return;
      const current=await lstat(path,{bigint:true});
      // Path-based unlink still leaves a window for replacement after the final stat.
      if(eligible(current)&&sameEntry(entry,current))await unlink(path);
    }catch{ /* A missing or busy candidate can be retried on the next load. */ }
  }
}

async function safeJson(path,limit){
  try{
    await assertPluginTreeNoLinks(path);
    const before=await lstat(path);
    if(!before.isFile()||before.nlink!==1||before.size>limit)throw storageFault();
    const value=JSON.parse(await readFile(path,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw storageFault();
    return value;
  }catch(error){if(error.code==='ENOENT')return null;throw fileFault(error);}
}

export function createBuiltinCloudVoice({dataRoot,credentials,settings,characters,readReference,referenceInfo=async()=>null,getLegacySelections=async()=>[],allowBackground=()=>true,asr,publish=()=>{},audit=()=>{},fetchImpl,registry=createCloudProviderRegistry({fetchImpl}),now=Date.now}){
  const directory=join(dataRoot,'voice','cloud');
  const originalPath=join(directory,'builtin-v1.json');
  const localChoicePath=join(dataRoot,'voice','builtin-local-fallback-v1.json');
  let path=originalPath,recoveryNumber=0,storageIssue,fallbackChoice;
  const legacyPath=join(directory,'bindings.json');
  let loading,state,queue=Promise.resolve(),closed=false,generation=0,scopeController=new AbortController(),speechController=new AbortController(),maintenance,probeProof,batchPending=false;
  let accountRevision=randomUUID();
  const accountFailures=new Map(),voiceFailures=new Map(),voiceLists=new Map(),pendingReferences=new Set(),activeRetention=new Set();
  const activationChecks=new Map();
  const seal=()=>{if(closed)throw fault('CLOUD_CLOSED','云配音已关闭');};
  function resetSpeech(){speechController.abort();speechController=new AbortController();}
  function resetContext(){
    generation++;
    accountRevision=randomUUID();
    activationChecks.clear();
    scopeController.abort();scopeController=new AbortController();
    resetSpeech();
    probeProof=null;
  }
  function checkAccountRevision(input){
    if(input.accountRevision!==undefined&&input.accountRevision!==accountRevision){
      throw fault('CLOUD_CONFIGURATION_CHANGED','云配音配置已变化，请重试');
    }
  }
  async function persist(next,check=seal,retryBudgetMs){
    await assertPluginTreeNoLinks(path);
    await mkdir(directory,{recursive:true});
    await assertPluginTreeNoLinks(path);
    await writeAtomicAsync(resolve(path),JSON.stringify(next),{check,retryBudgetMs});
    state=next;
  }
  async function recoveryFile(){
    try{
      await assertPluginTreeNoLinks(directory);
      for(const name of await readdir(directory)){
        const match=/^builtin-recovered-v1-([1-9][0-9]{0,8})\.json$/.exec(name);
        if(match)recoveryNumber=Math.max(recoveryNumber,Number(match[1]));
      }
    }catch(error){if(error.code!=='ENOENT')throw fileFault(error);}
    return recoveryNumber?join(directory,'builtin-recovered-v1-'+recoveryNumber+'.json'):originalPath;
  }
  function serial(work){
    const task=queue.then(work);
    queue=task.catch(()=>{});
    return task;
  }
  function fingerprint(secret,key){
    return createHmac('sha256',secret).update(key).digest('hex').slice(0,16);
  }
  async function fingerprintSecret(next){
    if(!next.fingerprintKeyRef){
      const secret=randomBytes(32).toString('hex');
      next.fingerprintKeyRef=(await credentials.save(secret,{providerId:'cloud-hmac'})).ref;
      return secret;
    }
    return credentials.resolve(next.fingerprintKeyRef);
  }
  async function migrate(config,prior){
    const connections=config.cloudConnections??{items:[],selectedId:null};
    const byId=connections.items.find(row=>row.id===connections.selectedId);
    const region=row=>row.provider==='minimax-global'?'minimax-global':'minimax-cn';
    const cloudSelected=config.packages?.[config.selectedPackageId]?.ttsProvider==='minimax';
    const engine=selectedEngine(config);
    const route=cloudSelected?'cloud:'+(byId?region(byId):providers[0]):'local:'+engine;
    const next=prior?structuredClone(prior):newState(route,cloudSelected&&config.enabled);
    const legacy=await safeJson(legacyPath,1024*1024);
    if(legacy&&(!legacy.scopes||typeof legacy.scopes!=='object'||Array.isArray(legacy.scopes)))throw storageFault();
    const retry=prior?.migrationRetry,deferred=[];
    const accountSet=new Set(retry?.accounts),characterSet=new Set(retry?.characters);
    const ordered=[...connections.items.filter(row=>row!==byId),...(byId?[byId]:[])]
      .filter(row=>!retry||retry.ids.includes(row.id));
    const profileSelections=new Map();
    let importedSelection=false;
    if(legacy?.scopes&&ordered.length){
      for(const {characterId,profile} of await getLegacySelections(engine)??[]){
        if(validCharacter(characterId)&&validCharacter(profile?.id)&&Number.isSafeInteger(profile.version)&&profile.version>=1){
          profileSelections.set(characterId,profile);
        }
      }
    }
    for(const row of ordered){
      if(!row.credentialRef||!models.includes(row.model))continue;
      let raw;
      try{raw=await credentials.resolve(row.credentialRef);}catch(error){
        if(!['ENOENT','VOICE_CREDENTIAL_INVALID','VOICE_CREDENTIAL_MISSING'].includes(error?.code))deferred.push(row.id);
        continue;
      }
      if(!validKey(raw))continue;
      const providerId=region(row),fp=fingerprint(await fingerprintSecret(next),raw);
      const oldFp=createHash('sha256').update(row.provider+'\0'+raw).digest('hex');
      const count=Object.values(next.savedAccounts).filter(account=>account.providerId===providerId).length;
      const name=validAccountName(row.name)&&!row.name.includes(raw)?row.name.trim():defaultAccountName(providerId,count);
      const account={id:randomUUID(),name,providerId,fingerprint:fp,ref:(await credentials.save(raw,{providerId})).ref,model:row.model,last4:raw.slice(-4)};
      next.savedAccounts[account.id]=account;
      if(row===byId)importedSelection=true;
      if(!prior)selectSavedAccount(next,account);
      else if(!prior.accounts[providerId]){
        next.accounts[providerId]=account;
        next.preferredProviderId??=providerId;
      }
      accountSet.add(keyMatch(providerId,fp));
      const rows=Object.entries(legacy?.scopes?.[oldFp]??{}).sort(([left],[right])=>Number(left.startsWith(engine+':'))-Number(right.startsWith(engine+':')));
      for(const [oldId,value] of rows){
        const [oldEngine]=oldId.split(':',1);
        const {characterId,profileId,profileVersion,voiceId}=value??{};
        if(!['breeze','gpt'].includes(oldEngine)||!validCharacter(characterId)||!validCharacter(profileId)||!Number.isSafeInteger(profileVersion)||profileVersion<1||!validCloudVoiceId(voiceId))continue;
        const id=bindingKey(account,characterId,'legacy-'+oldEngine+'-'+profileId,profileVersion);
        const kind=value.category==='system_voice'?'system':value.sourceSHA?'clone':'account';
        const activatedAt=value.activatedAt??null;
        next.bindings[id]??={voiceId,kind,model:row.model,state:value.preparedAt&&!activatedAt?'voice_pending':'ready',createdAt:value.preparedAt??activatedAt??iso(now()),activatedAt,lastUsedAt:activatedAt};
        const selected=profileSelections.get(characterId);
        const target=ownedKey(providerId,fp,characterId);
        const selectedLegacy=!selected||oldEngine===engine&&selected.id===profileId&&selected.version===profileVersion;
        if(kind==='clone'){
          const identity=referenceBindingKey(account,characterId,{sha256:value.sourceSHA,language:value.language??'zh'});
          const candidate=next.bindings[id],priorReference=identity&&next.bindings[identity];
          // Keep legacy selections distinct if multiple paid voices used the same audio.
          if(identity&&!prior?.bindings[identity]&&(!priorReference||
            candidate.state==='ready'&&(priorReference.state!=='ready'||selectedLegacy))){
            next.bindings[identity]=candidate;
          }
        }
        if(!prior?.choices[target]&&selectedLegacy){
          next.choices[target]=id;
        }
        characterSet.add(characterId);
      }
    }
    if(deferred.length){
      next.migrationRetry={ids:deferred,accounts:[...accountSet],characters:[...characterSet]};
    }else delete next.migrationRetry;
    if(ordered.includes(byId)&&!importedSelection&&!prior?.accounts[region(byId)])delete next.accounts[region(byId)];
    next.migration={accounts:accountSet.size,characters:characterSet.size,pending:!deferred.length&&accountSet.size>0};
    await persist(next);
    return next;
  }
  async function get(){
    seal();
    if(storageIssue)throw storageFault(storageIssue.code);
    if(loading)return loading;
    if(state)return state;
    loading=(async()=>{
      const partialCutoff=BigInt(Date.now()-10*60*1000)*1000000n;
      await sweepStalePartials(directory,cloudPartialName,partialCutoff);
      await sweepStalePartials(join(dataRoot,'voice'),localPartialName,partialCutoff);
      path=await recoveryFile();
      // A later version can still upgrade the original file after local recovery.
      const original=await safeJson(originalPath,4*1024*1024).catch(error=>{
        if(path!==originalPath&&error.code==='CLOUD_STORAGE_INVALID')return null;
        throw error;
      });
      if(original?.version>1)throw storageFault('CLOUD_STORAGE_NEWER');
      const value=path===originalPath?original:await safeJson(path,4*1024*1024);
      if(value){
        if(value.version>1)throw storageFault('CLOUD_STORAGE_NEWER');
        const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
        if(value.version!==1||!routes.includes(value.route)||![value.accounts,value.choices,value.bindings].every(record)||
          Object.values(value.bindings).some(row=>!record(row))||Object.values(value.accounts).some(row=>!record(row))||
          [value.paidOperations,value.retentionAttempts,value.savedAccounts].some(v=>v!=null&&!record(v))||
          Object.values(value.savedAccounts??{}).some(row=>!record(row))||
          value.migrationRetry&&!['ids','accounts','characters'].every(key=>Array.isArray(value.migrationRetry[key])))throw storageFault();
        value.paidOperations??={};value.retentionAttempts??={};
        upgradeRetentionAttempts(value);
        if(!value.savedAccounts){
          value.savedAccounts={};
          for(const providerId of providers){
            const old=value.accounts[providerId];
            if(!old)continue;
            const row={...old,id:randomUUID(),name:defaultAccountName(providerId,0)};
            value.savedAccounts[row.id]=row;
            value.accounts[providerId]=row;
          }
          value.preferredProviderId=selectedProvider(value);
          await persist(value);
        }
        return value.migrationRetry?migrate(await settings.get(),value):(state=value);
      }
      return migrate(await settings.get());
    })().then(async value=>{
      const choice=await savedLocalChoice();
      if(!choice)return state=value;
      const next={...value,...choice};
      if(value.route!==choice.route||value.enabled!==choice.enabled||value.localEnabled!==choice.localEnabled){
        await persist(next);
      }
      await clearLocalChoice();
      return state=next;
    }).catch(error=>{
      state=undefined;
      if(error.code==='CLOUD_CLOSED')throw error;
      if(['CLOUD_STORAGE_INVALID','CLOUD_STORAGE_NEWER'].includes(error.code)){
        storageIssue=describeStorageIssue(error.code);
        throw error;
      }
      throw storageFault('CLOUD_STORAGE_UNAVAILABLE');
    }).finally(()=>{loading=null;});
    return loading;
  }
  async function savedLocalChoice(){
    if(fallbackChoice)return fallbackChoice;
    const row=await safeJson(localChoicePath,1024).catch(error=>{
      if(error.code==='CLOUD_STORAGE_INVALID')return null;
      throw error;
    });
    if(row?.version===1&&['local:breeze','local:gpt'].includes(row.route)&&typeof row.localEnabled==='boolean'){
      fallbackChoice={route:row.route,enabled:false,localEnabled:row.localEnabled};
    }
    return fallbackChoice;
  }
  async function localFallback(){
    const saved=await savedLocalChoice().catch(()=>null);
    if(saved)return saved;
    let config;
    try{config=await settings.get();}catch{ /* Local defaults remain available during migration. */ }
    return {route:'local:'+selectedEngine(config??{}),enabled:false};
  }
  async function saveLocalChoice(route,localEnabled){
    try{
      await safeJson(localChoicePath,1024);
      await mkdir(join(dataRoot,'voice'),{recursive:true});
      await assertPluginTreeNoLinks(localChoicePath);
      await writeAtomicAsync(resolve(localChoicePath),JSON.stringify({version:1,route,localEnabled}),{check:seal});
      fallbackChoice={route,enabled:false,localEnabled};
    }catch(error){if(error.code==='CLOUD_CLOSED')throw error;throw storageFault('CLOUD_STORAGE_UNAVAILABLE');}
  }
  async function clearLocalChoice(){
    if(!fallbackChoice)return;
    try{await assertPluginTreeNoLinks(localChoicePath);await unlink(localChoicePath);}
    catch(error){if(error.code!=='ENOENT')throw storageFault('CLOUD_STORAGE_UNAVAILABLE');}
    fallbackChoice=null;
  }
  async function route(){
    let value;
    try{value=await get();}catch(error){if(error.code==='CLOUD_CLOSED')throw error;return localFallback();}
    return {route:value.route,enabled:value.enabled,providerId:routeProvider(value),...(typeof value.localEnabled==='boolean'?{localEnabled:value.localEnabled}:{})};
  }
  async function resetStorage(input){
    if(input.confirm!==true)throw fault('VOICE_ACTION_INVALID','云配音操作参数无效');
    await serial(async()=>{
      if(storageIssue?.canReset)storageIssue=null;
      try{await get();throw fault('VOICE_ACTION_INVALID','云配音操作参数无效');}
      catch(error){if(error.code!=='CLOUD_STORAGE_INVALID')throw error;}
      const choice=await localFallback(),next=newState(choice.route,false);
      if(typeof choice.localEnabled==='boolean')next.localEnabled=choice.localEnabled;
      await recoveryFile();
      path=join(directory,'builtin-recovered-v1-'+(++recoveryNumber)+'.json');
      await persist(next);
      storageIssue=null;resetContext();
    });
    publish();
    return snapshot();
  }
  async function scope({providerId,characterId,signal,allowDisabled=false}={}){
    const currentGeneration=generation;
    const value=await get();
    const id=providerId??selectedProvider(value);
    if(!providers.includes(id)||characterId!==undefined&&!validCharacter(characterId))throw fault('CLOUD_SCOPE','云配音角色或服务商无效');
    if(!allowDisabled&&(!value.enabled||value.route!=='cloud:'+id))throw fault('CLOUD_DISABLED','云配音尚未开启');
    const account=value.accounts[id];
    if(!account?.ref)throw fault('CLOUD_KEY_REQUIRED','请先保存云配音 API Key');
    const actionSignal=signal?AbortSignal.any([signal,scopeController.signal]):scopeController.signal;
    const check=()=>{
      actionSignal.throwIfAborted();
      if(closed||generation!==currentGeneration||state.accounts[id]?.ref!==account.ref)throw fault('CLOUD_CONFIGURATION_CHANGED','云配音配置已变化，请重试');
    };
    check();
    const key=await credentials.resolve(account.ref);
    check();
    if(!validKey(key))throw fault('CLOUD_KEY_REQUIRED','请重新保存云配音 API Key');
    const choice=characterId===undefined?null:value.choices[ownedKey(id,account.fingerprint,characterId)];
    return {provider:registry.get(id),account,key,choice,characterId,signal:actionSignal,check};
  }
  const binding=ctx=>state.bindings[ctx.choice];
  async function currentBinding(ctx){
    const row=binding(ctx);
    if(row||ctx.characterId===undefined)return row;
    const activationIdentity=pendingActivationIdentity(state,ctx.account,ctx.characterId);
    if(activationIdentity)return pendingReference(state,activationIdentity);
    const reference=await referenceInfo(ctx.characterId);
    ctx.check();
    return pendingReference(state,referenceBindingKey(ctx.account,ctx.characterId,reference));
  }
  function activeAccountFailure(account){
    const key=keyMatch(account.providerId,account.fingerprint),saved=accountFailures.get(key);
    if(!saved)return;
    const time=now();
    if(saved.at>time){
      saved.retryAt=time+(saved.retryAt-saved.at);
      saved.at=time;
    }
    if(saved.retryAt>time)return saved;
    accountFailures.delete(key);
  }
  const accountFailureFor=ctx=>activeAccountFailure(ctx.account);
  function failureFor(ctx,row=binding(ctx)){
    return accountFailureFor(ctx)??roleIssue(row)??(row?voiceFailures.get(ownedKey(ctx.account.providerId,ctx.account.fingerprint,row.voiceId)):undefined);
  }
  function noteFailure(ctx,error,voiceId){
    if(!error?.category||ctx.signal.aborted)return;
    const account=keyMatch(ctx.account.providerId,ctx.account.fingerprint);
    const details={...minimaxSpeechStatus(error),status:publicStatus(error)};
    if(Object.hasOwn(accountHold,error.category)){
      const time=now();
      error.retryAt=time+accountHold[error.category];
      accountFailures.set(account,{...details,at:time,retryAt:error.retryAt});
    }else if(error.category==='parameters'&&voiceId){
      voiceFailures.set(account+':'+voiceId,details);
    }
    const raw=error.providerCode??error.httpStatus;
    try{audit({type:'minimax-speech-failed',category:error.category,...(Number.isSafeInteger(raw)?{code:raw}:{})});}catch{}
    publish();
  }
  function rejectHeld(ctx,accountOnly=false,row){
    const failure=accountOnly?accountFailureFor(ctx):failureFor(ctx,row);
    if(failure)throw Object.assign(fault(failure.code,failure.message),failure,{suppressed:true});
  }
  async function status(request){
    let ctx;
    try{ctx=await scope(request);}catch(error){
      return {ready:false,state:error.code==='CLOUD_KEY_REQUIRED'?'key-missing':'unavailable',code:error.code};
    }
    const row=await currentBinding(ctx);
    const failure=failureFor(ctx,row);
    if(failure)return {...failure,ready:false,suppressed:true};
    if(!row||row.state!=='ready')return {ready:false,state:'unbound',code:'CLOUD_VOICE_REQUIRED'};
    return {ready:true,state:'ready'};
  }
  async function saveBinding(ctx,row,id){
    return serial(async()=>{
      ctx.check();
      const next=structuredClone(await get());
      ctx.check();
      next.bindings[id]=row;
      next.choices[ownedKey(ctx.account.providerId,ctx.account.fingerprint,ctx.characterId)]=id;
      await persist(next,ctx.check);
    });
  }
  async function noteUsed(ctx,row){
    if(!ctx.choice)return;
    try{
      await serial(async()=>{
        ctx.check();
        const current=await get();
        ctx.check();
        const bindings=voiceBindings(current,ctx.account,row.voiceId);
        if(!bindings.length)return;
        const time=now(),today=Math.floor(time/day),key=retentionKey(ctx.account,row.voiceId);
        const alreadyRecorded=bindings.every(([,binding])=>{
          const lastUsed=timeOf(binding.lastUsedAt);
          return lastUsed!==null&&lastUsed<=time&&Math.floor(lastUsed/day)===today;
        });
        if(alreadyRecorded&&!Object.hasOwn(current.retentionAttempts,key))return;
        const next=structuredClone(current);
        if(!alreadyRecorded){
          const usedAt=iso(time);
          for(const [id] of bindings)next.bindings[id].lastUsedAt=usedAt;
        }
        delete next.retentionAttempts[key];
        await persist(next,ctx.check);
      });
    }catch(error){
      if(!ctx.signal.aborted)try{audit({type:'cloud-voice-usage-save-failed',code:'CLOUD_USAGE_SAVE'});}catch{}
    }
  }
  async function markVoiceMissing(ctx,error,voiceId){
    if(!missingVoiceCodes.has(error?.providerCode)||ctx.signal.aborted)return;
    try{
      await serial(async()=>{
        const next=structuredClone(await get());
        ctx.check();
        let changed=false;
        for(const [,row] of voiceBindings(next,ctx.account,voiceId)){
          if(row.state==='ready'){
            row.state='voice_missing';
            changed=true;
          }
        }
        if(changed)await persist(next,ctx.check);
      });
    }catch{
      if(!ctx.signal.aborted)try{audit({type:'cloud-voice-missing-save-failed',code:'CLOUD_CONFIG'});}catch{}
    }
  }
  async function* speak(request){
    const signal=request.signal?AbortSignal.any([request.signal,speechController.signal]):speechController.signal;
    const ctx=await scope({...request,signal});
    const row=await currentBinding(ctx);
    rejectHeld(ctx,false,row);
    if(row?.state!=='ready')throw fault('CLOUD_VOICE_REQUIRED','请先选择云端音色');
    const job=ctx.provider.synthesize({key:ctx.key},{model:ctx.account.model,voiceId:row.voiceId,text:request.text,params:{performance:request.performance}},ctx.signal);
    try{
      yield {type:'reference',source:'cloud',style:'minimax'};
      for await(const pcm of job){ctx.check();yield {type:'pcm',pcm,sampleRate:32000};}
      ctx.check();
      await noteUsed(ctx,row);
      ctx.check();
      yield {type:'done',metrics:await job.usage};
    }catch(error){await markVoiceMissing(ctx,error,row.voiceId);noteFailure(ctx,error,row.voiceId);throw error;}
  }
  async function list(ctx,{reload=false,includeCloneListEvidence=false}={}){
    const id=keyMatch(ctx.account.providerId,ctx.account.fingerprint),cached=voiceLists.get(id);
    if(!includeCloneListEvidence&&!reload&&cached&&cached.at+15000>now())return cached.voices;
    try{
      const result=await ctx.provider.listVoices({key:ctx.key},{kind:'all',includeCloneListEvidence},ctx.signal);
      ctx.check();
      voiceLists.set(id,{at:now(),voices:includeCloneListEvidence?result.voices:result});
      return result;
    }catch(error){noteFailure(ctx,error);throw error;}
  }
  async function selectedCharacter(id){
    if(!validCharacter(id)||!characters().includes(id))throw fault('CLOUD_SCOPE','当前角色无法选择云端音色');
    return id;
  }
  function expiredRetentionVoices(value,account){
    const at=now(),prefix=keyMatch(account.providerId,account.fingerprint)+':',held=accountRetentionHold(value,account,at);
    const voices=new Set();
    for(const [target,identity] of Object.entries(value.choices)){
      if(!target.startsWith(prefix))continue;
      const row=value.bindings[identity];
      if(row?.kind!=='clone'||row.state!=='ready')continue;
      if(retentionAge(row,at)>sevenDays&&(held||value.retentionAttempts[retentionKey(account,row.voiceId)]))voices.add(row.voiceId);
    }
    return voices;
  }
  async function probe(input){
    const {providerId,model='speech-2.8-turbo',key}=input;
    if(!providers.includes(providerId)||!models.includes(model))throw fault('CLOUD_CONFIG','云配音服务商或模型无效');
    await get();
    if(key===undefined){
      const ctx=await scope({providerId,allowDisabled:true});
      const result=await ctx.provider.probe({key:ctx.key,model:ctx.account.model},ctx.signal);
      ctx.check();
      if(result.state!=='ready'){
        noteFailure(ctx,result);
        return {ok:false,status:publicStatus(result),...minimaxSpeechStatus(result)};
      }
      const expired=expiredRetentionVoices(state,ctx.account);
      const listed=expired.size?new Set((await list(ctx,{reload:true})).filter(row=>row.kind==='clone').map(row=>row.voiceId)):null;
      await serial(async()=>{
        ctx.check();
        const next=structuredClone(state);
        let changed=false;
        if(listed){
          for(const voiceId of expiredRetentionVoices(next,ctx.account)){
            if(!expired.has(voiceId)||listed.has(voiceId))continue;
            for(const [,row] of voiceBindings(next,ctx.account,voiceId)){
              if(row.state==='ready'){row.state='voice_missing';changed=true;}
            }
          }
        }
        if(clearRetentionAttempts(next,ctx.account,activeRetention)||changed)await persist(next,ctx.check);
      });
      ctx.check();
      accountFailures.delete(keyMatch(providerId,ctx.account.fingerprint));
      publish();
      return {ok:true,status:'ready'};
    }
    if(!validKey(key))throw fault('CLOUD_KEY_REQUIRED','请填写有效的云配音 API Key');
    const current=generation,provider=registry.get(providerId);
    const controller=scopeController;
    const result=await provider.probe({key,model},controller.signal);
    if(controller.signal.aborted||current!==generation)throw fault('CLOUD_CONFIGURATION_CHANGED','云配音配置已变化，请重试');
    if(result.state!=='ready'){probeProof=null;return {ok:false,...minimaxSpeechStatus(result),status:publicStatus(result)};}
    const proof=randomUUID();
    probeProof={proof,providerId,model,key,expires:now()+120000};
    return {ok:true,status:'ready',proof};
  }
  async function removeUnusedAccountKey(ref){
    if(typeof ref!=='string'||ref.startsWith('voice:cloud-hmac:')||!credentials.removeIfUnused)return false;
    try{
      await credentials.removeIfUnused(ref,async value=>{
        const config=await settings.get();
        return state?.fingerprintKeyRef===value||Object.values(state?.savedAccounts??{}).some(row=>row.ref===value)||
          config.cloudConnections?.items?.some(row=>row.credentialRef===value)||
          Object.values(config.packages??{}).some(row=>row.credentialRef===value);
      });
      return false;
    }catch{return true;}
  }
  function queueOldKey(next,ref){
    if(ref&&credentials.removeIfUnused)next.obsoleteCredentialRefs=[...new Set([...(next.obsoleteCredentialRefs??[]),ref])];
  }
  async function cleanupOldKeys(){
    return serial(async()=>{
      const refs=state?.obsoleteCredentialRefs;
      if(closed||!Array.isArray(refs)||!refs.length)return false;
      const pending=[];
      for(const ref of refs)if(await removeUnusedAccountKey(ref))pending.push(ref);
      if(pending.length!==refs.length){
        try{await persist({...state,obsoleteCredentialRefs:pending});}
        catch{return true;}
      }
      return pending.length>0;
    });
  }
  async function save(input){
    const {providerId,model,key,proof,accountId,name}=input,expected=probeProof;
    if(accountId!==undefined&&!validAccountId(accountId)||name!==undefined&&(!validAccountName(name)||validKey(key)&&name.includes(key))){
      throw fault('CLOUD_CONFIG','云配音账号配置无效');
    }
    if(!expected||expected.expires<now()||expected.proof!==proof||expected.providerId!==providerId||expected.model!==model||expected.key!==key)throw fault('CLOUD_PROBE_REQUIRED','请先测试当前服务商和 Key');
    probeProof=null;
    let createdRef;
    const result=await serial(async()=>{
      const version=generation,next=structuredClone(await get());
      if(Object.keys(next.accounts).length>providers.length)throw fault('CLOUD_CONFIG','云配音账号配置无效');
      const fp=fingerprint(await fingerprintSecret(next),key);
      const current=next.accounts[providerId];
      const previous=accountId?next.savedAccounts[accountId]:
        name===undefined?Object.values(next.savedAccounts).find(row=>row.providerId===providerId&&row.fingerprint===fp):undefined;
      if(accountId&&!previous)throw fault('CLOUD_CONFIG','云配音账号配置无效');
      const ref=previous?.providerId===providerId&&previous.fingerprint===fp?previous.ref:(createdRef=(await credentials.save(key,{providerId})).ref);
      if(closed||generation!==version)throw fault('CLOUD_CONFIGURATION_CHANGED','云配音配置已变化，请重试');
      const count=Object.values(next.savedAccounts).filter(row=>row.providerId===providerId).length;
      const account={id:previous?.id??randomUUID(),name:name?.trim()??previous?.name??defaultAccountName(providerId,count),
        providerId,model,fingerprint:fp,ref,last4:key.slice(-4)};
      if(previous&&previous.providerId!==providerId){
        delete next.savedAccounts[previous.id];
        removeProviderSelection(next,previous);
      }
      next.savedAccounts[account.id]=account;
      selectSavedAccount(next,account);
      if(current?.fingerprint!==fp||current?.model!==model||previous&&
        (previous.providerId!==providerId||previous.fingerprint!==fp||previous.model!==model)){
        clearRetentionAttempts(next,account);
      }
      if(previous?.ref!==ref)queueOldKey(next,previous?.ref);
      await persist(next,()=>{seal();if(generation!==version)throw fault('CLOUD_CONFIGURATION_CHANGED','云配音配置已变化，请重试');});
      resetContext();
      const accountKey=keyMatch(providerId,fp);
      accountFailures.delete(accountKey);
      for(const id of voiceFailures.keys())if(id.startsWith(accountKey+':'))voiceFailures.delete(id);
      publish();
      return {ok:true,status:'ready',account:{...publicAccount(account,selectedProvider(next)===providerId),status:'ready'}};
    }).catch(async error=>{
      if(createdRef)await removeUnusedAccountKey(createdRef);
      throw error;
    });
    return await cleanupOldKeys()?{...result,credentialCleanupPending:true}:result;
  }
  async function changeAccount(accountId,remove){
    if(!validAccountId(accountId))throw fault('CLOUD_CONFIG','云配音账号配置无效');
    await serial(async()=>{
      const next=structuredClone(await get());
      const row=next.savedAccounts[accountId];
      if(!row)throw fault('CLOUD_CONFIG','云配音账号配置无效');
      if(remove){
        queueOldKey(next,row.ref);
        delete next.savedAccounts[row.id];
        removeProviderSelection(next,row);
      }else{
        selectSavedAccount(next,row);
        if(next.enabled&&routeProvider(next))next.route='cloud:'+row.providerId;
      }
      await persist(next);
      resetContext();
    });
    const credentialCleanupPending=await cleanupOldKeys();
    publish();
    return {...await snapshot(),...(credentialCleanupPending?{credentialCleanupPending}: {})};
  }
  function paidUpdate(ctx,identity,record,change,check=ctx.check){
    return serial(async()=>{
      const next=structuredClone(await get());
      check();
      if(record)next.paidOperations[identity]=record;
      else delete next.paidOperations[identity];
      change?.(next);
      await persist(next,check);
    });
  }
  function rejectionConfirmed(error){
    return Number.isSafeInteger(error?.providerCode)&&error.providerCode!==2039&&
      ['auth','balance','quota','rate_limit','moderation','parameters','clone_duration','clone_identity','clone_prompt_duration','clone_quality','clone_slots'].includes(error.category);
  }
  function requireCloneConsent(consents){
    if(consents.consentUpload!==true||consents.consentActivation!==true)throw fault('CLOUD_UPLOAD_CONSENT','请先确认上传参考录音和激活费用');
  }
  async function reconcileActivation(ctx,target,identity,receipt,row,hold){
    const ready={voiceId:receipt.voiceId,kind:'clone',model:ctx.account.model,state:'ready',createdAt:row?.createdAt??receipt.at,
      activatedAt:row?.activatedAt??receipt.at,lastUsedAt:row?.lastUsedAt??receipt.at};
    await paidUpdate(ctx,identity,null,next=>{
      next.bindings[identity]=ready;
      if((next.choices[target]??null)===(ctx.choice??null))next.choices[target]=identity;
    });
    clearActivationTransportHold(ctx,hold);
    publish();
    return {ok:true,voiceId:ready.voiceId,state:'ready'};
  }
  function clearActivationTransportHold(ctx,hold){
    if(['network','timeout','service'].includes(hold?.category)&&accountFailureFor(ctx)===hold){
      accountFailures.delete(keyMatch(ctx.account.providerId,ctx.account.fingerprint));
    }
  }
  async function abandonActivation(id,input){
    const ctx=await scope({characterId:id});
    checkAccountRevision(input);
    const target=ownedKey(ctx.account.providerId,ctx.account.fingerprint,id);
    if(pendingReferences.has(target))throw fault('CLOUD_BUSY','音色正在处理，请稍后核对');
    const identity=pendingActivationIdentity(state,ctx.account,id);
    const receipt=state.paidOperations[identity],challenge=activationChecks.get(target);
    const stale=()=>fault('CLOUD_CONFIGURATION_CHANGED','云配音配置已变化，请重试');
    if(!input.accountRevision||!challenge||input.abandonActivationToken!==challenge.token||
      input.expectedActivationVoiceId!==receipt?.voiceId||challenge.revision!==input.accountRevision||
      challenge.identity!==identity||challenge.voiceId!==receipt?.voiceId||challenge.receiptAt!==receipt?.at){
      throw stale();
    }
    const checkFresh=()=>{
      ctx.check();
      const age=now()-challenge.at;
      if(age<0||age>5*60*1000)throw stale();
    };
    checkFresh();
    activationChecks.delete(target);
    pendingReferences.add(target);
    try{
      const hold=accountFailureFor(ctx);
      const {voices,cloneListComplete}=await list(ctx,{includeCloneListEvidence:true});
      const matchingVoices=voices.filter(voice=>voice.voiceId===receipt.voiceId);
      if(matchingVoices.some(voice=>voice.kind==='clone')){
        const row=state.bindings[identity];
        return await reconcileActivation(ctx,target,identity,receipt,row?.voiceId===receipt.voiceId?row:undefined,hold);
      }
      if(!cloneListComplete||matchingVoices.length)throw stale();
      await paidUpdate(ctx,identity,null,next=>{
        const row=next.bindings[identity];
        if(row?.state==='voice_pending'&&row.voiceId===receipt.voiceId){
          delete next.bindings[identity];
          if(next.choices[target]===identity)delete next.choices[target];
        }
      },checkFresh);
      clearActivationTransportHold(ctx,hold);
      try{audit({type:'cloud-voice-activation-abandoned',category:'activation',code:'CLOUD_ACTIVATION_ABANDONED'});}catch{}
      publish();
      return {ok:true,state:'abandoned'};
    }finally{pendingReferences.delete(target);}
  }
  async function clone(id,consents){
    requireCloneConsent(consents);
    const ctx=await scope({characterId:id});
    checkAccountRevision(consents);
    const target=ownedKey(ctx.account.providerId,ctx.account.fingerprint,id);
    const activationIdentity=pendingActivationIdentity(state,ctx.account,id);
    const activation=activationIdentity?state.paidOperations[activationIdentity]:undefined;
    const confirmedId=consents.confirmActivationVoiceId;
    const expectedIds=[consents.expectedActivationVoiceId,confirmedId].filter(voiceId=>voiceId!==undefined);
    if(expectedIds.length&&(!consents.accountRevision||!activation||expectedIds.some(voiceId=>voiceId!==activation.voiceId))){
      throw fault('CLOUD_CONFIGURATION_CHANGED','云配音配置已变化，请重试');
    }
    if(pendingReferences.has(target))throw fault('CLOUD_BUSY','音色正在处理，请稍后核对');
    pendingReferences.add(target);
    activationChecks.delete(target);
    let identity=activationIdentity,row,working=false;
    try{
      let reference;
      if(!activation){
        reference=await readReference(id);
        ctx.check();
        identity=referenceBindingKey(ctx.account,id,reference);
        if(!identity)throw fault('CLOUD_REFERENCE','参考录音不可用');
      }
      const previous=state.paidOperations[identity],existing=state.bindings[identity];
      if(existing?.state!=='voice_missing'&&(!activation||existing?.voiceId===activation.voiceId))row=existing;
      const hold=accountFailureFor(ctx);
      const recoverTransport=previous&&['network','timeout','service'].includes(hold?.category);
      if(!activation&&existing?.state==='ready'){
        if(ctx.choice!==identity||previous?.phase==='clone'){
          // A ready import supersedes an unconfirmed upload for this recording.
          await paidUpdate(ctx,identity,null,next=>{next.choices[target]=identity;});
        }
        publish();
        return {ok:true,voiceId:row.voiceId,state:'ready'};
      }
      if(!recoverTransport)rejectHeld(ctx,true);
      if(activation){
        const {voices,cloneListComplete}=await list(ctx,{includeCloneListEvidence:true});
        const matchingVoices=voices.filter(voice=>voice.voiceId===previous.voiceId);
        if(matchingVoices.some(voice=>voice.kind==='clone')){
          return await reconcileActivation(ctx,target,identity,previous,row,hold);
        }
        if(confirmedId===undefined){
          const result={ok:false,state:'activation_confirmation',voiceId:previous.voiceId,accountRevision};
          if(consents.expectedActivationVoiceId!==undefined&&cloneListComplete&&!matchingVoices.length){
            const token=randomUUID();
            activationChecks.set(target,{token,identity,voiceId:previous.voiceId,receiptAt:previous.at,revision:accountRevision,at:now()});
            result.abandonActivationToken=token;
          }
          return result;
        }
        row={voiceId:previous.voiceId,kind:'clone',model:ctx.account.model,state:'voice_pending',createdAt:row?.createdAt??previous.at,
          activatedAt:null,lastUsedAt:null};
      }
      if(!row||previous?.phase==='clone'){
        // A lost clone acknowledgement may already have reserved the previous voice ID.
        const voiceId='AIBuddy-'+randomUUID();
        await paidUpdate(ctx,identity,{phase:'clone',voiceId,at:iso(now())});
        try{await reference.assertCurrent?.();}
        catch(error){
          // The upload has not started, so leave no ambiguous paid-operation receipt.
          await paidUpdate(ctx,identity,null);
          throw error;
        }
        ctx.check();
        working=true;
        await ctx.provider.cloneVoice({key:ctx.key},{reference,voiceId},ctx.signal);
        ctx.check();
        row={voiceId,kind:'clone',model:ctx.account.model,state:'voice_pending',createdAt:iso(now()),activatedAt:null,lastUsedAt:null};
      }
      await paidUpdate(ctx,identity,{phase:'activation',voiceId:row.voiceId,at:iso(now())},next=>{next.bindings[identity]=row;});
      working=true;
      await ctx.provider.activateVoice({key:ctx.key},{model:ctx.account.model,voiceId:row.voiceId},ctx.signal);
      ctx.check();
      row={...row,state:'ready',activatedAt:iso(now()),lastUsedAt:iso(now())};
      await paidUpdate(ctx,identity,null,next=>{
        next.bindings[identity]=row;
        if((next.choices[target]??null)===(ctx.choice??null))next.choices[target]=identity;
      });
      if(recoverTransport&&accountFailureFor(ctx)===hold)accountFailures.delete(keyMatch(ctx.account.providerId,ctx.account.fingerprint));
      publish();
      return {ok:true,voiceId:row.voiceId,state:'ready'};
    }catch(error){
      if(working&&!ctx.signal.aborted&&rejectionConfirmed(error))await paidUpdate(ctx,identity,null,next=>{
        if(row&&missingVoiceCodes.has(error.providerCode))next.bindings[identity]={...row,state:'voice_missing'};
      });
      noteFailure(ctx,error,row?.voiceId);throw error;
    }finally{pendingReferences.delete(target);}
  }
  async function prepareBatch(input){
    requireCloneConsent(input);
    const ids=input.targetCharacterIds;
    if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw fault('VOICE_ACTION_INVALID','云配音操作参数无效');
    if(batchPending)throw fault('CLOUD_BUSY','音色正在处理，请稍后核对');
    batchPending=true;
    try{
      for(const id of ids)await selectedCharacter(id);
      const batchScope=await scope();
      checkAccountRevision(input);
      const results=[];
      for(const characterId of ids){
        if(batchScope.signal.aborted){
          results.push({characterId,ok:false,code:'CLOUD_CONFIGURATION_CHANGED'});
          continue;
        }
        const hold=accountFailureFor(batchScope);
        if(hold){
          results.push({characterId,ok:false,code:hold.code});
          continue;
        }
        try{
          batchScope.check();
          const result=await clone(characterId,input);
          results.push({characterId,ok:result.ok,state:result.state});
        }catch(error){
          const code=batchScope.signal.aborted?'CLOUD_CONFIGURATION_CHANGED':
            /^CLOUD_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'CLOUD_PREPARE_FAILED';
          results.push({characterId,ok:false,code});
        }
      }
      return {results};
    }finally{batchPending=false;}
  }
  async function settleRetention(ctx,{attempt,previous},outcome,code){
    let matched=false;
    try{
      await serial(async()=>{
        const value=await get();
        ctx.check();
        const key=retentionKey(ctx.account,attempt.voiceId),entry=value.retentionAttempts[key];
        if(entry?.state!=='submitted'||entry.voiceId!==attempt.voiceId||entry.at!==attempt.at)return;
        matched=true;
        const next=structuredClone(value);
        if(outcome==='cancelled'){
          if(previous&&!entry.rebased)next.retentionAttempts[key]=previous;
          else delete next.retentionAttempts[key];
        }else{
          const rejected=outcome==='rejected';
          const receipt={state:outcome,at:now(),voiceId:entry.voiceId,reasonCode:retentionReason(code,rejected),
            unknownCount:entry.unknownCount-Number(rejected),rejectedCount:entry.rejectedCount+Number(rejected)};
          next.retentionAttempts[key]=receipt;
          if(rejected)recordAccountRetentionRejection(next,ctx.account,receipt);
        }
        await persist(next,ctx.check);
      });
    }catch{
      if(!ctx.signal.aborted)try{audit({type:'cloud-voice-retention-save-failed',code:'CLOUD_CONFIG'});}catch{}
    }
    return matched&&!ctx.signal.aborted;
  }
  async function retain(id,{manual=true}={}){
    if(!manual&&!allowBackground())return {ok:false};
    const ctx=await scope({characterId:id});
    const row=binding(ctx);
    if(row?.kind!=='clone'||row.state!=='ready')return {ok:false};
    const key=retentionKey(ctx.account,row.voiceId);
    const time=now();
    if(activeRetention.has(key)||!manual&&(accountRetentionHold(state,ctx.account,time)||!canRetainAutomatically(state.retentionAttempts[key],time)))return {ok:false};
    if(!manual)rejectHeld(ctx);
    activeRetention.add(key);
    let reservation;
    try{
      reservation=await serial(async()=>{
        const next=structuredClone(await get());
        ctx.check();
        const selected=next.choices[ownedKey(ctx.account.providerId,ctx.account.fingerprint,id)];
        const current=next.bindings[selected];
        if(selected!==ctx.choice||current?.voiceId!==row.voiceId||current.state!=='ready')return;
        const time=now(),confirmed=lastConfirmedUse(voiceBindings(next,ctx.account,row.voiceId),time);
        const last=Number.isFinite(confirmed)?confirmed:Math.min(time,timeOf(current.createdAt)??time);
        if(!manual&&time-last<sixDays)return;
        const previous=next.retentionAttempts[key];
        if(!manual&&(!next.autoRetain||!allowBackground()||time-last>=sevenDays||
          accountRetentionHold(next,ctx.account,time)||!canRetainAutomatically(previous,time)))return;
        // An interrupted or unacknowledged request counts toward the uncertain budget.
        const attempt={state:'submitted',at:time,voiceId:row.voiceId,unknownCount:(previous?.unknownCount??0)+1,
          rejectedCount:previous?.rejectedCount??0};
        next.retentionAttempts[key]=attempt;
        await persist(next,ctx.check);
        return {attempt,previous};
      });
      if(!reservation)return {ok:false};
      if(!manual&&(!state.autoRetain||!allowBackground())){
        await settleRetention(ctx,reservation,'cancelled');
        return {ok:false};
      }
      publish();
      try{
        ctx.check();
        const job=ctx.provider.synthesize({key:ctx.key},{model:ctx.account.model,voiceId:row.voiceId,text:'你好。'},ctx.signal);
        for await(const _ of job)ctx.check();
        await noteUsed(ctx,row);
        return {ok:true};
      }catch(error){
        const businessCode=Number.isSafeInteger(error?.providerCode)&&error.category!=='unknown';
        const httpReason=!businessCode&&retentionHttpReasons[error?.httpStatus];
        let statusError=error;
        if(httpReason==='CLOUD_MINIMAX_AUTH'&&error.httpStatus===403){
          statusError=new MiniMaxSpeechError('auth',{httpStatus:403,providerCode:error.providerCode});
        }else if(!businessCode&&error?.providerCode!==undefined&&Number.isSafeInteger(error.httpStatus)){
          statusError=minimaxHttpError(error.httpStatus);
          statusError.providerCode=error.providerCode;
        }
        const rejected=Boolean(httpReason)||rejectionConfirmed(error);
        const reason=statusError.category==='moderation'?'CLOUD_MINIMAX_PARAMETERS':statusError.code;
        const matched=!ctx.signal.aborted&&await settleRetention(ctx,reservation,rejected?'rejected':'unknown',reason);
        await markVoiceMissing(ctx,error,row.voiceId);
        // HTTP parameter rejections use the persisted retry gate. Successful HTTP responses can still fail the voice.
        const httpParameterRejection=statusError.category==='parameters'&&Number.isSafeInteger(error.httpStatus);
        if(matched)noteFailure(ctx,statusError,httpParameterRejection?undefined:row.voiceId);
        throw statusError;
      }
    }finally{
      activeRetention.delete(key);
      if(reservation)publish();
    }
  }
  async function rebaseFutureRetention(value){
    const time=now();
    const hasFutureRetry=Object.entries(value.retentionAttempts).some(([key,receipt])=>receipt?.at>time&&!activeRetention.has(key));
    if(!hasFutureRetry&&!Object.values(value.bindings).some(row=>futureBindingTimes(row,time).length))return value;
    return serial(async()=>{
      const current=await get(),observed=now();
      const future=Object.entries(current.retentionAttempts)
        .filter(([key,receipt])=>receipt?.at>observed&&!activeRetention.has(key));
      const bindings=Object.entries(current.bindings)
        .flatMap(([key,row])=>futureBindingTimes(row,observed).map(field=>[key,field]));
      if(!future.length&&!bindings.length)return current;
      const next=structuredClone(current);
      for(const [key] of future)next.retentionAttempts[key].at=observed;
      for(const [key,field] of bindings)next.bindings[key][field]=iso(observed);
      let result=current;
      try{
        // A clock correction is opportunistic. Normal settings writes still retry sharing errors.
        await persist(next,seal,0);
        result=next;
      }catch{
        // The view already clamps dates. A later read can try to persist the correction again.
      }
      seal();
      return result;
    });
  }
  async function snapshot({characterId}={}){
    let value;
    try{value=await rebaseFutureRetention(await get());}catch(error){
      if(!Object.hasOwn(storageMessage,error.code))throw error;
      return {...await localFallback(),providerId:providers[0],status:'unavailable',storageIssue:describeStorageIssue(error.code),
        accounts:[],account:{configured:false,status:'off'},characters:characters().map(characterId=>({characterId,state:'off',retentionInFlight:false})),asr:await asr.status()};
    }
    const revision=accountRevision;
    const selected={route:value.route,enabled:value.enabled,providerId:routeProvider(value)};
    const providerId=selectedProvider(value),account=value.accounts[providerId];
    const time=now(),retentionHold=account&&accountRetentionHold(value,account,time);
    const view=await Promise.all(characters().map(async id=>{
      const reference=await referenceInfo(id);
      const referenceState={referenceAvailable:!!reference,...(reference?{
        referenceDurationMs:reference.durationMs,referenceVersion:reference.version,referenceSource:reference.source,
      }:{})};
      const identity=referenceBindingKey(account,id,reference);
      const activationIdentity=pendingActivationIdentity(value,account,id);
      if(activationIdentity){
        referenceState.activationRecovery=true;
        referenceState.activationRecoveryVoiceId=value.paidOperations[activationIdentity].voiceId;
      }else if(identity&&value.bindings[identity]?.state!=='ready'&&value.paidOperations[identity]?.phase==='clone')referenceState.cloneRecovery=true;
      const choice=account?value.choices[ownedKey(providerId,account.fingerprint,id)]:null;
      const pending=pendingReference(value,activationIdentity??identity),row=value.bindings[choice]??pending;
      if(!row)return {characterId:id,...referenceState,state:'off',retentionInFlight:false};
      const held=voiceFailures.get(keyMatch(providerId,account.fingerprint)+':'+row.voiceId);
      const voiceMissing=row.state==='voice_missing'||missingVoiceCodes.has(held?.providerCode);
      const key=retentionKey(account,row.voiceId),retentionInFlight=activeRetention.has(key);
      const attempt=value.retentionAttempts[key];
      const age=retentionAge(row,time);
      const retainable=row.kind==='clone'&&row.state==='ready'&&!voiceMissing,due=retainable&&age>=sixDays;
      const ownIssue=retainable&&attempt&&(attempt.state!=='submitted'||!retentionInFlight)?
        retentionReason(attempt.reasonCode,attempt.state==='rejected'):undefined;
      const reasonCode=ownIssue??(due?retentionHold?.reasonCode:undefined);
      const retentionIssue=reasonCode?{reasonCode,daysRemaining:Math.max(0,Math.floor((sevenDays-age)/day)),
        ...(age>sevenDays?{expired:true}:{})}:undefined;
      return {characterId:id,...referenceState,voiceId:row.voiceId,kind:row.kind,state:voiceMissing?'voice_missing':held?'unavailable':row.state,
        ...(pending&&pending!==row?{pendingState:pending.state,pendingVoiceId:pending.voiceId}:{}),
        lastUsedAt:(timeOf(row.lastUsedAt)??-Infinity)>time?iso(time):row.lastUsedAt,due,retentionInFlight,...(retentionIssue?{retentionIssue}:{})};
    }));
    const accountFailure=account&&activeAccountFailure(account);
    const row=characterId?view.find(item=>item.characterId===characterId):undefined;
    const voiceFailure=row?.voiceId&&voiceFailures.get(keyMatch(providerId,account.fingerprint)+':'+row.voiceId);
    const failure=accountFailure??roleIssue(row)??voiceFailure;
    const status=selected.providerId&&selected.enabled&&account?failure?.status??'ready':'off';
    return {...selected,providerId,status,accountRevision:revision,...(failure?{code:failure.code,category:failure.category,retryAt:failure.retryAt}:{}),
      accounts:Object.values(value.savedAccounts).map(row=>publicAccount(row,row.id===account?.id)),
      account:account?{...publicAccount(account,true),status:accountFailure?.status??'ready'}:{configured:false,last4:null,status:'off'},
      characters:view,asr:await asr.status(),autoRetain:value.autoRetain,migration:value.migration};
  }
  async function maintenanceTick(){
    if(!allowBackground())return;
    const value=await rebaseFutureRetention(await get());
    if(!value.enabled||!value.autoRetain)return;
    const account=value.accounts[routeProvider(value)];
    if(!account)return;
    activeAccountFailure(account);
    if(accountRetentionHold(state,account,now()))return;
    const view=await snapshot();
    if(!view.enabled||!view.route.startsWith('cloud:')||!view.autoRetain||view.account.status!=='ready')return;
    for(const row of view.characters.filter(row=>row.due)){
      if(closed||generation!==maintenance?.generation||!allowBackground())return;
      try{await retain(row.characterId,{manual:false});}catch{ /* Scoped status already records the failure. */ }
      if(accountRetentionHold(state,account,now()))return;
    }
  }
  async function activate(){
    const current=await route();
    if(current.providerId&&current.enabled)await asr.auto();
    if(closed||maintenance)return;
    await cleanupOldKeys();
    if(closed||maintenance)return;
    const timer=setInterval(()=>{
      if(maintenance.running||closed)return;
      maintenance.generation=generation;
      maintenance.running=maintenanceTick().catch(()=>{}).finally(()=>{if(maintenance)maintenance.running=null;});
      return maintenance.running;
    },15*60*1000);
    timer.unref();
    maintenance={timer};
  }
  async function action(op,input){
    const name=op.slice('builtin-cloud-'.length);
    if(!Object.hasOwn(fields,name)||Object.keys(input).some(key=>!fields[name].includes(key)))throw fault('VOICE_ACTION_INVALID','云配音操作参数无效');
    if(name==='reset')return resetStorage(input);
    if(name==='probe')return probe(input);
    if(name==='save')return save(input);
    if(name==='account-select'||name==='account-remove')return changeAccount(input.accountId,name==='account-remove');
    if(name==='batch')return prepareBatch(input);
    if(name==='route'){
      if(!routes.includes(input.route)||input.enabled!==undefined&&typeof input.enabled!=='boolean')throw fault('CLOUD_CONFIG','配音位置无效');
      await serial(async()=>{
        let value;
        try{value=await get();}catch(error){
          if(!input.route.startsWith('local:')||!Object.hasOwn(storageMessage,error.code))throw error;
          await saveLocalChoice(input.route,input.enabled??true);
          resetContext();
          return;
        }
        const next=structuredClone(value);
        next.route=input.route;
        next.enabled=next.route.startsWith('cloud:')?(input.enabled??true):false;
        if(next.route.startsWith('local:'))next.localEnabled=input.enabled??true;
        if(routeProvider(next))next.preferredProviderId=routeProvider(next);
        await persist(next);
        try{await clearLocalChoice();}catch(error){state=value;throw error;}
        resetContext();
      });
      if(input.route.startsWith('cloud:')&&input.enabled!==false)void activate().catch(()=>{});
      publish();
      return snapshot();
    }
    if(name==='migration-ack'||name==='retention'){
      await serial(async()=>{
        const next=structuredClone(await get());
        if(name==='migration-ack'&&next.migration)next.migration.pending=false;
        if(name==='retention'){
          if(typeof input.enabled!=='boolean')throw fault('CLOUD_CONFIG','自动保留选项无效');
          next.autoRetain=input.enabled;
        }
        await persist(next);
      });
      publish();
      return snapshot();
    }
    if(name==='asr'){
      if(!['pause','resume'].includes(input.action))throw fault('VOICE_ACTION_INVALID','语音识别操作无效');
      return asr[input.action]();
    }
    if(name==='voices'){
      const ctx=await scope({allowDisabled:true});
      return list(ctx);
    }
    const characterId=await selectedCharacter(input.targetCharacterId);
    if(name==='reference-preview'){
      const reference=await readReference(characterId);
      await reference.assertCurrent?.();
      return {pcmWav:Uint8Array.from(reference.bytes)};
    }
    if(name==='clone')return clone(characterId,input);
    if(name==='abandon-activation')return abandonActivation(characterId,input);
    if(name==='retain')return retain(characterId);
    const ctx=await scope({characterId,allowDisabled:true});
    checkAccountRevision(input);
    if(!validCloudVoiceId(input.voiceId))throw fault('CLOUD_VOICE_REQUIRED','音色无效');
    const selected=(await list(ctx)).find(row=>row.voiceId===input.voiceId);
    if(!selected)throw fault('CLOUD_VOICE_REQUIRED','当前账号没有这个音色');
    const sourceId='account-'+createHash('sha256').update(selected.voiceId).digest('hex').slice(0,24);
    const id=bindingKey(ctx.account,ctx.characterId,sourceId,1);
    const old=state.bindings[id],at=now(),time=iso(at);
    const used=lastConfirmedUse(voiceBindings(state,ctx.account,selected.voiceId),at);
    const row={voiceId:selected.voiceId,kind:selected.kind,model:ctx.account.model,state:'ready',createdAt:old?.createdAt??time,
      activatedAt:old?.activatedAt??null,lastUsedAt:Number.isFinite(used)?iso(used):null};
    await saveBinding(ctx,row,id);
    voiceFailures.delete(keyMatch(ctx.account.providerId,ctx.account.fingerprint)+':'+selected.voiceId);
    publish();
    return {ok:true,voiceId:row.voiceId};
  }

  return {route,snapshot,status,speak,action,activate,revokeScope:resetSpeech,
    stopEngine:resetSpeech,
    async close(){
      closed=true;resetContext();
      if(maintenance){clearInterval(maintenance.timer);await maintenance.running;}
      await asr.close();
      await queue;
    },
  };
}
