import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {writeAtomic} from '../atomic-write.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>Object.assign(Error(message),{code});
const cloneVersion='minimax-voice-clone-v1';
const expiryMs=7*24*60*60*1000;
const validVoice=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const rejectedCode=code=>/^CLOUD_REMOTE_\d+$/.test(code??'')||/^CLOUD_HTTP_4\d\d$/.test(code??'');
const accountRejected=code=>['CLOUD_REMOTE_1002','CLOUD_REMOTE_1004','CLOUD_REMOTE_1008','CLOUD_HTTP_401','CLOUD_HTTP_403','CLOUD_HTTP_429'].includes(code);
const hasVoice=(voices,voiceId)=>voices.some(row=>(typeof row==='string'?row:row?.voiceId??row?.voice_id)===voiceId);
const existingRow=(ctx,binding)=>({characterId:ctx.request.characterId,voiceId:binding.voiceId,status:binding.activatedAt?'activated':'reuse-existing',
  stage:'existing-binding',activationState:binding.activatedAt?'activated':'unknown',provenance:binding.provenance,category:binding.category,action:'reuse-existing',state:'ready'});
const publicRow=row=>({characterId:row.characterId,voiceId:row.voiceId,status:row.status,stage:row.stage,
  activationState:row.activatedAt?'activated':row.stage==='cloned'?'pending':'not-confirmed',
  ...(row.preparedAt?{preparedAt:row.preparedAt,expiresAt:row.activatedAt?null:new Date(Date.parse(row.preparedAt)+expiryMs).toISOString()}:{}),
  ...(row.errorCode?{code:row.errorCode}:{}),...(row.outcome?{outcome:row.outcome}:{}),...(row.remoteVerifiedAt?{remoteVerifiedAt:row.remoteVerifiedAt}:{})});
const activeStatus=status=>['activated','activation-confirmed-query-pending','reuse-existing'].includes(status);
function summary(results){
  const groups=new Map();for(const row of results){const list=groups.get(row.characterId)??[];list.push(row);groups.set(row.characterId,list);}
  const items=[...groups.values()].map(rows=>rows.find(row=>!activeStatus(row.status))??rows[0]);
  const completed=items.filter(row=>activeStatus(row.status)).length;
  return {state:completed===items.length&&items.length?'completed':'pending',total:items.length,completed,results,items,
    counts:{active:completed,prepared:items.filter(row=>row.status==='prepared-awaiting-activation').length,unknown:items.filter(row=>row.status==='unknown').length,
      failed:items.filter(row=>['failed','account-confirmation-required','expired','unavailable'].includes(row.status)).length,pending:items.filter(row=>['pending','preparing','not-prepared'].includes(row.status)).length}};
}

/** Private API boundary. No response body, audio, reference text or key is logged. */
export function createMiniMaxVoiceProvider({fetchImpl=globalThis.fetch}={}){
  async function request(ctx,path,body,{signal,form=false}={}){
    signal?.throwIfAborted();
    const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)]);
    let response;
    try{response=await fetchImpl((ctx.connection.provider==='minimax-global'?'https://api.minimax.io':'https://api.minimax.cn')+path,
      {method:'POST',headers:{Authorization:'Bearer '+ctx.connection.key,...(!form?{'Content-Type':'application/json'}:{})},body:form?body:JSON.stringify(body).replace(/("file_id":)"([0-9]{1,30})"/g,'$1$2'),signal:bounded,redirect:'error'});}
    catch(error){if(signal?.aborted)throw signal.reason;throw fail('CLOUD_CONNECTION','MiniMax 连接中断；已提交的请求需先核对结果');}
    if(!response.ok)throw fail('CLOUD_HTTP_'+response.status,response.status===401?'MiniMax API Key 无效或已过期，请更新云配音配置':'MiniMax 请求失败，请检查连接或账户权限');
    const text=await response.text();
    if(text.length>12*1024*1024)throw fail('CLOUD_PROTOCOL','MiniMax 返回的数据过大');
    let value;try{value=JSON.parse(text.replace(/("file_id"\s*:\s*)([0-9]{16,})(?=\s*[,}])/g,'$1"$2"'));}catch{throw fail('CLOUD_PROTOCOL','MiniMax 返回的数据无效');}
    const code=value?.base_resp?.status_code;
    if(code!==0)throw fail('CLOUD_REMOTE_'+(Number.isSafeInteger(code)?code:'UNKNOWN'),code===1002?'MiniMax 请求频率受限，请稍后手动重试':'MiniMax 请求未成功，请检查 Key、余额、实名及音色权限');
    return value;
  }
  return {
    async upload(ctx,bytes,options){
      const body=new FormData();body.set('purpose','voice_clone');body.set('file',new Blob([bytes],{type:'audio/wav'}),'voice-reference.wav');
      const value=await request(ctx,'/v1/files/upload',body,{...options,form:true});
      const fileId=value?.file?.file_id;
      if(!['string','number'].includes(typeof fileId)||!/^[0-9]{1,30}$/.test(String(fileId)))throw fail('CLOUD_PROTOCOL','MiniMax 没有确认上传文件标识');
      return {fileId};
    },
    async clone(ctx,{fileId,voiceId,textValidation},options){
      const value=await request(ctx,'/v1/voice_clone',{file_id:fileId,voice_id:voiceId,need_noise_reduction:false,need_volume_normalization:false,
        ...(textValidation?{text_validation:textValidation}:{})},options);
      return {voiceId};
    },
    async activate(ctx,{voiceId},options){
      const value=await request(ctx,'/v1/t2a_v2',{model:ctx.connection.model,text:'你好。',stream:false,
        voice_setting:{voice_id:voiceId,speed:1,vol:1,pitch:0},audio_setting:{format:'pcm',sample_rate:32000,channel:1},language_boost:'Chinese'},options);
      if(value?.data?.status!==2||typeof value.data.audio!=='string'||!value.data.audio.length||!/^([a-fA-F0-9]{2})+$/.test(value.data.audio))throw fail('CLOUD_INCOMPLETE','MiniMax 未确认首次正式合成完成；请先核对音色状态');
      return {voiceId};
    },
    async voices(ctx,options){
      const value=await request(ctx,'/v1/get_voice',{voice_type:'all'},options),voices=[];
      for(const category of ['system_voice','voice_cloning','voice_generation']){
        if(value[category]!=null&&!Array.isArray(value[category]))throw fail('CLOUD_PROTOCOL','MiniMax 音色列表无效');
        for(const row of value[category]??[])if(validVoice(row?.voice_id))voices.push({voiceId:row.voice_id,name:typeof row.voice_name==='string'?row.voice_name.slice(0,200):typeof row.name==='string'?row.name.slice(0,200):row.voice_id,category});
      }return voices;
    },
  };
}

/** Durable, serial preparation. The host supplies all identities and consent. */
export function createVoiceBatch({dataRoot,resolveContext,readReference,findBinding,saveBinding,hasOtherAccount=async()=>false,provider,now=()=>Date.now()}){
  const root=join(dataRoot,'voice','cloud'),path=join(root,'preparation.json');
  let operation,legacyRecords;
  const time=()=>new Date(now()).toISOString();
  async function load(){
    await assertPluginTreeNoLinks(path);
    try{
      const stat=await lstat(path);if(!stat.isFile()||stat.size>4*1024*1024)throw Error();
      const value=JSON.parse(await readFile(path,'utf8'));
      if(value.schemaVersion!==1||!value.rows||typeof value.rows!=='object'||Array.isArray(value.rows))throw Error();
      if(Object.keys(value.rows).length>1000)throw Error();
      for(const [id,row] of Object.entries(value.rows))if(!row||typeof row!=='object'||row.id!==id||!/^([a-f0-9]{64})$/.test(id)||!/^([a-f0-9]{64})$/.test(row.accountScope)||
        !/^([a-f0-9]{64})$/.test(row.sourceSHA)||typeof row.characterId!=='string'||!validVoice(row.voiceId)||
        !['pending','upload-submitted','uploaded','clone-submitted','cloned','activation-submitted','activated'].includes(row.stage))throw Error();
      return value;
    }catch(error){if(error.code==='ENOENT')return {schemaVersion:1,rows:{}};throw fail('CLOUD_RECEIPTS','云音色准备回执不可读取；未重新提交');}
  }
  async function persist(state){await assertPluginTreeNoLinks(path);await mkdir(root,{recursive:true});await assertPluginTreeNoLinks(path);writeAtomic(path,JSON.stringify(state));}
  async function oldReceipts(){
    if(legacyRecords)return legacyRecords;
    const directory=join(root,'receipts');await assertPluginTreeNoLinks(directory);
    try{
      const names=await readdir(directory);if(names.length>1000)throw Error();
      const records=[];
      for(const name of names){
        if(!/^[a-zA-Z0-9-]{1,100}\.json$/.test(name))throw Error();
        const target=join(directory,name);await assertPluginTreeNoLinks(target);const stat=await lstat(target);
        if(!stat.isFile()||stat.size>1024*1024)throw Error();const row=JSON.parse(await readFile(target,'utf8'));
        if(row.schemaVersion!==1||!validVoice(row.voiceId)||!/^([a-f0-9]{64})$/.test(row.sourceSHA??''))throw Error();records.push(row);
      }
      legacyRecords=records;return records;
    }catch(error){if(error.code==='ENOENT'){legacyRecords=[];return [];}throw fail('CLOUD_RECEIPTS','旧云音色回执不可读取；未重新上传或克隆');}
  }
  async function oldMatch(ctx){return (await oldReceipts()).find(row=>row.characterId===ctx.request.characterId&&row.sourceSHA===ctx.profile.cloudReference?.sha256&&row.provider===ctx.connection.provider);}
  function identity(ctx){
    const sourceSHA=ctx.profile.cloudReference?.sha256,language=ctx.profile.cloudReference?.language??'zh';
    if(!/^[a-f0-9]{64}$/.test(sourceSHA??'')||typeof language!=='string'||!/^[a-zA-Z-]{2,20}$/.test(language))throw fail('CLOUD_REFERENCE','角色没有有效的云音色参考摘要和语言');
    const accountScope=ctx.connection.accountScope,characterId=ctx.request.characterId;
    const id=hash([accountScope,characterId,sourceSHA,language,cloneVersion].join('\0'));
    return {id,accountScope,characterId,sourceSHA,language,cloneVersion,provider:ctx.connection.provider};
  }
  function refresh(row){
    if(rejectedCode(row.errorCode)&&['upload-submitted','clone-submitted','activation-submitted'].includes(row.stage)){row.status='failed';row.outcome='rejected';}
    else if(row.stage==='cloned'&&!row.activatedAt&&Date.parse(row.preparedAt)+expiryMs<=now())row.status='expired';
    else if(row.stage==='upload-submitted'||row.stage==='clone-submitted'||row.stage==='activation-submitted')row.status='unknown';
    return row;
  }
  async function project(ctx,row){
    await saveBinding(ctx,{characterId:ctx.request.characterId,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion,
      voiceId:row.voiceId,provider:ctx.connection.provider,sourceSHA:row.sourceSHA,language:row.language,receiptId:row.id,preparedAt:row.preparedAt,
      ...(row.activatedAt?{activatedAt:row.activatedAt}:{}),provenance:row.activatedAt?'approved-reference-clone-activated':'approved-reference-clone-pending-audition'});
  }
  async function check(ctx,options){
    options.signal?.throwIfAborted();await options.checkCurrent?.();options.signal?.throwIfAborted();
    const current=await resolveContext(ctx.request,options.signal);
    if(current.connection.accountScope!==ctx.connection.accountScope||current.request.characterId!==ctx.request.characterId||current.profile.cloudReference?.sha256!==ctx.profile.cloudReference?.sha256||
      current.profile.cloudReference?.language!==ctx.profile.cloudReference?.language||current.request.profileId!==ctx.request.profileId||current.request.profileVersion!==ctx.request.profileVersion||
      current.connection.model!==ctx.connection.model||current.connection.keyRef!==ctx.connection.keyRef)throw fail('CLOUD_CONFIGURATION_CHANGED','云配音账号、配置或角色声音档案已改变；准备已暂停');
  }
  async function one(params,options,state){
    const ctx=await resolveContext(params,options.signal);
    await check(ctx,options);
    const existing=await findBinding(ctx);
    // The current binding is the user's choice. Never replay an older failed receipt over it.
    if(existing&&!existing.provenance?.startsWith('approved-reference-clone'))return existingRow(ctx,existing);
    const key=identity(ctx);let row=state.rows[key.id];
    if(existing&&row&&row.voiceId!==existing.voiceId)return existingRow(ctx,existing);
    if(!row&&existing){
      row={...key,voiceId:existing.voiceId,stage:'cloned',preparedAt:existing.preparedAt??existing.boundAt??time(),status:existing.activatedAt?'activated':'prepared-awaiting-activation',
        ...(existing.activatedAt?{activatedAt:existing.activatedAt}:{}),legacy:true};state.rows[key.id]=row;await persist(state);
    }
    if(!row){
      const old=await oldMatch(ctx);
      if(old){
        // Older receipts did not record credential scope. Never assume a new Key owns them.
        row={...key,voiceId:old.voiceId,stage:'clone-submitted',status:'unknown',createdAt:old.createdAt??time(),legacyUnscoped:true,errorCode:'CLOUD_LEGACY_ACCOUNT_UNCONFIRMED'};
        state.rows[key.id]=row;await persist(state);
      }
    }
    if(!row){
      if(!options.consentAccountChange&&(await hasOtherAccount(ctx)||Object.values(state.rows).some(other=>other.characterId===key.characterId&&other.sourceSHA===key.sourceSHA&&other.accountScope!==key.accountScope)))
        throw fail('CLOUD_ACCOUNT_CONFIRMATION','此参考已在另一个 Key 范围准备；更换 Key 不代表更换账号，请先核对原音色，避免重复计费');
      row={...key,voiceId:'buddy-'+key.id.slice(0,48),stage:'pending',status:'pending',createdAt:time()};state.rows[key.id]=row;await persist(state);
    }
    refresh(row);
    if(row.status==='failed'&&row.outcome==='rejected'){
      row.lastRejection={code:row.errorCode,stage:row.stage,at:row.updatedAt??row.createdAt};
      row.stage=row.stage==='activation-submitted'?'cloned':row.fileId?'uploaded':'pending';row.status='pending';delete row.errorCode;delete row.outcome;
    }
    const notify=async()=>{try{await options.onProgress?.(publicRow(row));}catch{ /* UI notification cannot change a confirmed provider result. */ }};
    const save=async()=>{row.updatedAt=time();await persist(state);await notify();};
    const failed=async error=>{
      row.errorCode=error.name==='AbortError'?'CLOUD_CANCELLED':error.code??'CLOUD_PREPARE_FAILED';
      row.outcome=rejectedCode(row.errorCode)?'rejected':'unknown';row.status=row.outcome==='rejected'?'failed':'unknown';
      await save();error.preparationUnknown=row.outcome==='unknown';error.preparationRejected=row.outcome==='rejected';error.accountBlocked=accountRejected(row.errorCode);throw error;
    };
    await notify();
    if(row.legacy&&!row.activatedAt&&options.consentActivation===true){
      await check(ctx,options);
      const voices=await provider.voices(ctx,{signal:options.signal});
      if(hasVoice(voices,row.voiceId)){row.stage='activated';row.status='activated';row.activatedAt=time();row.remoteVerifiedAt=time();await save();}
    }
    if(row.status==='unknown')return publicRow(row);
    if(row.status==='expired')return publicRow(row);
    if(row.stage==='pending'||row.stage==='uploaded'){
      const reference=await readReference(ctx);await check(ctx,options);
      if(options.legacyClone){
        row.stage='clone-submitted';row.status='preparing';await save();await check(ctx,options);
        try{
          const answer=await options.legacyClone(ctx,{voiceId:row.voiceId,reference},async event=>{
            if(event.stage==='uploaded'){row.fileId=event.file_id;await save();}
          });
          if(answer.voice_id!==row.voiceId)throw fail('CLOUD_PROTOCOL','MiniMax 克隆返回不同音色身份');
          row.stage='cloned';row.preparedAt=time();row.status='prepared-awaiting-activation';await save();
        }catch(error){await failed(error);}
      }else{
        if(row.stage==='pending'){
          row.stage='upload-submitted';row.status='preparing';await save();await check(ctx,options);
          try{const result=await provider.upload(ctx,reference.bytes,{signal:options.signal});row.fileId=result.fileId;row.stage='uploaded';row.status='preparing';await save();}
          catch(error){await failed(error);}
        }
        await check(ctx,options);row.stage='clone-submitted';await save();await check(ctx,options);
        try{
          const answer=await provider.clone(ctx,{fileId:row.fileId,voiceId:row.voiceId,...(reference.reference.text.length&&reference.reference.text.length<=200?{textValidation:reference.reference.text}:{})},{signal:options.signal});
          if(answer.voiceId!==row.voiceId)throw fail('CLOUD_PROTOCOL','MiniMax 克隆返回不同音色身份');
          row.stage='cloned';row.preparedAt=time();row.status='prepared-awaiting-activation';await save();
        }catch(error){await failed(error);}
      }
    }
    await check(ctx,options);
    if(options.consentActivation===true&&!row.activatedAt){
      row.stage='activation-submitted';row.status='activating';await save();await check(ctx,options);
      try{
        const result=await provider.activate(ctx,{voiceId:row.voiceId},{signal:options.signal});
        if(result.voiceId!==row.voiceId)throw fail('CLOUD_PROTOCOL','MiniMax 首次合成返回不同音色身份');
        row.activatedAt=time();row.stage='activated';row.status='activation-confirmed-query-pending';delete row.errorCode;await save();
      }catch(error){await failed(error);}
      await check(ctx,options);
      try{const voices=await provider.voices(ctx,{signal:options.signal});if(hasVoice(voices,row.voiceId)){row.remoteVerifiedAt=time();row.status='activated';await save();}}
      catch(error){if(options.signal?.aborted)throw error;row.errorCode=error.code??'CLOUD_QUERY_PENDING';await save();}
    }
    await check(ctx,options);await project(ctx,row);
    return {...publicRow(row),state:'ready',cloudListeningAcceptance:'pending'};
  }
  async function run(profiles,options){
    if(options.consentUpload!==true)throw fail('CLOUD_CONSENT','请先确认上传角色完整参考音并创建 MiniMax 云端音色');
    if(!Array.isArray(profiles)||profiles.length<1||profiles.length>100)throw fail('CLOUD_SCOPE','云配音批量角色清单无效');
    const state=await load(),results=[];
    for(const params of profiles){
      options.signal?.throwIfAborted();await options.checkCurrent?.();
      try{results.push(await one(params,options,state));}
      catch(error){
        if(options.signal?.aborted||error.name==='AbortError'||error.code==='CLOUD_CONFIGURATION_CHANGED')throw error;
        results.push({characterId:params.characterId,status:error.preparationUnknown?'unknown':error.code==='CLOUD_ACCOUNT_CONFIRMATION'?'account-confirmation-required':'failed',...(error.preparationRejected||rejectedCode(error.code)?{outcome:'rejected'}:{}),code:/^CLOUD_[A-Z0-9_]+$/.test(error.code??'')?error.code:'CLOUD_PREPARE_FAILED',
          message:error.preparationUnknown?'已提交的云音色操作尚未确认，请先核对结果；不会自动重新提交':/^CLOUD_[A-Z0-9_]+$/.test(error.code??'')?error.message:'云音色准备未完成，请检查声音档案和配置'});
        if(error.accountBlocked||accountRejected(error.code))break;
      }
    }
    return summary(results);
  }
  return {
    prepare(profiles,options={}){
      if(operation)return operation;
      const task=run(profiles,options);operation=task;void task.finally(()=>{if(operation===task)operation=null;}).catch(()=>{});return task;
    },
    async status(profiles){
      const state=await load(),results=[];
      for(const params of profiles){
        try{const ctx=await resolveContext(params),binding=await findBinding(ctx);
          if(binding&&!binding.provenance?.startsWith('approved-reference-clone')){results.push(existingRow(ctx,binding));continue;}
          const key=identity(ctx),row=state.rows[key.id],old=!row&&!binding&&await oldMatch(ctx);
          if(row)refresh(row);
          results.push(binding&&(!binding.provenance?.startsWith('approved-reference-clone')||row&&row.voiceId!==binding.voiceId)?existingRow(ctx,binding):row?publicRow(row):binding?existingRow(ctx,binding):old?{characterId:params.characterId,voiceId:old.voiceId,status:'unknown',code:'CLOUD_LEGACY_ACCOUNT_UNCONFIRMED'}:{characterId:params.characterId,status:'not-prepared'});}
        catch(error){results.push({characterId:params.characterId,status:'unavailable',code:error.code,message:error.message});}
      }return summary(results);
    },
    async preview(profiles,selectedCharacterIds=[]){
      const state=await load(),actions=[],fingerprints=[],seen=new Set();let providerName='minimax';
      for(const params of profiles){
        try{
          const ctx=await resolveContext(params),binding=await findBinding(ctx);providerName=ctx.connection.provider;
          if(binding&&!binding.provenance?.startsWith('approved-reference-clone')){
            fingerprints.push({accountScope:ctx.connection.accountScope,characterId:ctx.request.characterId,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion,engine:ctx.request.engine,
              sourceSHA:ctx.profile.cloudReference?.sha256??null,language:ctx.profile.cloudReference?.language??null,model:ctx.connection.model,keyRevision:ctx.connection.keyRef,connectionId:ctx.connection.id,
              binding:{voiceId:binding.voiceId,provenance:binding.provenance,category:binding.category,activatedAt:binding.activatedAt}});
            const choiceKey=JSON.stringify([ctx.connection.accountScope,ctx.request.characterId,'existing',binding.voiceId]);
            if(!seen.has(choiceKey)){seen.add(choiceKey);actions.push({characterId:ctx.request.characterId,voiceId:binding.voiceId,action:'reuse-existing',provenance:binding.provenance,cloneRequired:false,activationRequired:false});}
            continue;
          }
          const key=identity(ctx),row=state.rows[key.id]&&refresh(state.rows[key.id]);
          const boundFingerprint=binding?{voiceId:binding.voiceId,provenance:binding.provenance,category:binding.category,sourceSHA:binding.sourceSHA,activatedAt:binding.activatedAt}:null;
          fingerprints.push({key,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion,engine:ctx.request.engine,model:ctx.connection.model,keyRevision:ctx.connection.keyRef,connectionId:ctx.connection.id,binding:boundFingerprint,
            receipt:row?{voiceId:row.voiceId,stage:row.stage,status:row.status,outcome:row.outcome,code:row.errorCode,activatedAt:row.activatedAt,fileId:row.fileId}:null});
          const choiceKey=key.id+'\0'+(binding&&(!binding.provenance?.startsWith('approved-reference-clone')||row&&row.voiceId!==binding.voiceId)?'existing:'+binding.voiceId:'clone');
          if(seen.has(choiceKey))continue;seen.add(choiceKey);
          const base={characterId:key.characterId,sourceSHA:key.sourceSHA,language:key.language,voiceId:binding?.voiceId??row?.voiceId,cloneRequired:false,activationRequired:false};
          if(binding&&(!binding.provenance?.startsWith('approved-reference-clone')||row&&row.voiceId!==binding.voiceId))actions.push({...base,action:'reuse-existing',provenance:binding.provenance});
          else if(row?.status==='unknown'||row?.status==='expired')actions.push({...base,action:'blocked-unknown',code:row.errorCode??(row.status==='expired'?'CLOUD_VOICE_EXPIRED':'CLOUD_PREPARE_UNKNOWN')});
          else if(row?.activatedAt||binding?.activatedAt)actions.push({...base,action:'reuse-existing',provenance:binding?.provenance});
          else if(row?.stage==='cloned'||row?.stage==='activation-submitted'&&row.outcome==='rejected'||binding)actions.push({...base,action:'activation',activationRequired:true});
          else if(!row&&await oldMatch(ctx)||!row&&(await hasOtherAccount(ctx)||Object.values(state.rows).some(other=>other.characterId===key.characterId&&other.sourceSHA===key.sourceSHA&&other.accountScope!==key.accountScope)))actions.push({...base,action:'blocked-unknown',code:'CLOUD_ACCOUNT_CONFIRMATION'});
          else actions.push({...base,action:'new-clone',cloneRequired:true,activationRequired:true});
        }catch(error){actions.push({characterId:params.characterId,engine:params.engine,action:'blocked-unknown',cloneRequired:false,activationRequired:false,code:error.code??'CLOUD_CONFIG'});fingerprints.push({params,code:error.code??'CLOUD_CONFIG'});}
      }
      const cloneCount=actions.filter(row=>row.cloneRequired).length,firstUseCount=actions.filter(row=>row.activationRequired).length,global=providerName==='minimax-global',cloneUnitPrice=global?1.5:9.9;
      const pricing={currency:global?'USD':'CNY',cloneUnitPrice,cloneEstimate:Math.round(firstUseCount*cloneUnitPrice*100)/100,estimateOnly:true,
        sourceUrl:global?'https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise':'https://platform.minimax.cn/docs/pricing/overview',checkedOn:'2026-11-07'};
      return {selectedCharacterIds,selectedCount:selectedCharacterIds.length,cloneCount,firstUseCount,activationCount:actions.filter(row=>row.activationRequired).length,reuseCount:actions.filter(row=>row.action==='reuse-existing').length,
        blockedCount:actions.filter(row=>row.action==='blocked-unknown').length,actions,pricing,planHash:hash(JSON.stringify({fingerprints,selectedCharacterIds,actions,pricing}))};
    },
    async reconcile(params,options={}){
      const state=await load(),ctx=await resolveContext(params,options.signal),key=identity(ctx),row=state.rows[key.id];
      if(!row)throw fail('CLOUD_RECEIPT_REQUIRED','没有可核对的云音色准备回执');
      await check(ctx,options);const voices=await provider.voices(ctx,{signal:options.signal});
      const binding=await findBinding(ctx);
      if(binding&&binding.voiceId!==row.voiceId)return {...existingRow(ctx,binding),message:'当前角色已选择其他云端音色，保留当前绑定'};
      if(hasVoice(voices,row.voiceId)){row.stage='activated';row.status='activated';row.activatedAt??=time();row.remoteVerifiedAt=time();delete row.errorCode;delete row.outcome;await persist(state);await check(ctx,options);await project(ctx,row);}
      else refresh(row);
      return {...publicRow(row),message:hasVoice(voices,row.voiceId)?'MiniMax 已确认该音色可用':'音色未出现在已激活列表；这不能证明未创建，请在 MiniMax 核对后再处理，未重新提交'};
    },
    async markActivated(ctx,voiceId){
      const state=await load(),row=state.rows[identity(ctx).id];
      // WebSocket completion is observed but HTTP/query remains the explicit retention proof.
      if(row?.voiceId===voiceId&&!row.activatedAt){row.lastSynthesisAt=time();await persist(state);}
    },
  };
}
