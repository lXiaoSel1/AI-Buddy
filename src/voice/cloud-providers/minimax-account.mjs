import {waitForNetwork} from '../../network-download.mjs';
import {MiniMaxSpeechError,minimaxBusinessError,minimaxHttpError} from '../minimax-speech-errors.mjs';

const maxResponseBytes=12*1024*1024;
const fail=(code,message)=>Object.assign(Error(message),{code});
const providerVoiceTypes={system:'system',cloned:'voice_cloning',account:'voice_generation',all:'all'};
const voiceCategories=['system_voice','voice_cloning','voice_generation'];

export const miniMaxBaseUrls=Object.freeze({'minimax-cn':'https://api.minimax.cn','minimax-global':'https://api.minimax.io'});
export const validCloudVoiceId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:() -]{1,256}$/.test(value)&&value.trim()===value;
export const validCloneVoiceId=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(value);
const mime={wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4'};

export function parseMiniMaxJson(text){
  // MiniMax file IDs are numeric on the wire, but may exceed Number.MAX_SAFE_INTEGER.
  return JSON.parse(text.replace(/("(?:file_id|prompt_audio)"\s*:\s*)([0-9]{16,})(?=\s*[,}])/g,'$1"$2"'));
}

export function miniMaxJsonBody(body){
  return JSON.stringify(body).replace(/("(?:file_id|prompt_audio)":)"([0-9]{1,30})"/g,'$1$2');
}

/** The existing batch workflow and the built-in provider use the same API payloads. */
export function createMiniMaxOperations(request,{validVoice=validCloudVoiceId,maxVoices=5000}={}){
  return {
    async upload(ctx,bytes,{format='wav',purpose='voice_clone',...options}={}){
      const body=new FormData();
      body.set('purpose',purpose);
      body.set('file',new Blob([bytes],{type:mime[format]}),'voice-reference.'+format);
      const value=await request(ctx,'/v1/files/upload',body,{...options,form:true,operation:'clone'});
      const fileId=value?.file?.file_id;
      if(!['string','number'].includes(typeof fileId)||!/^[0-9]{1,30}$/.test(String(fileId)))throw fail('CLOUD_PROTOCOL','MiniMax 没有确认上传文件标识');
      return {fileId};
    },
    async clone(ctx,{fileId,voiceId,textValidation,prompt},options){
      await request(ctx,'/v1/voice_clone',{
        file_id:fileId,voice_id:voiceId,need_noise_reduction:false,need_volume_normalization:false,
        ...(textValidation?{text_validation:textValidation}:{}),
        ...(prompt?{clone_prompt:{prompt_audio:prompt.fileId,prompt_text:prompt.text}}:{}),
      },{...options,operation:'clone'});
      return {voiceId};
    },
    async activate(ctx,{voiceId},options){
      const value=await request(ctx,'/v1/t2a_v2',{
        model:ctx.connection.model,text:'你好。',stream:false,
        voice_setting:{voice_id:voiceId,speed:1,vol:1,pitch:0},
        audio_setting:{format:'pcm',sample_rate:32000,channel:1},language_boost:'Chinese',
      },options);
      if(value?.data?.status!==2||typeof value.data.audio!=='string'||!/^([a-fA-F0-9]{2})+$/.test(value.data.audio)){
        throw fail('CLOUD_INCOMPLETE','MiniMax 未确认首次正式合成完成；请先核对音色状态');
      }
      return {voiceId};
    },
    async voices(ctx,{kind='all',includeCloneListEvidence=false,...options}={}){
      if(!Object.hasOwn(providerVoiceTypes,kind))throw new MiniMaxSpeechError('parameters');
      const voiceType=providerVoiceTypes[kind];
      const value=await request(ctx,'/v1/get_voice',{voice_type:voiceType},options);
      const voices=[];
      let count=0;
      for(const category of voiceCategories){
        const rows=value[category];
        if(rows==null)continue;
        if(!Array.isArray(rows)||(count+=rows.length)>maxVoices)throw fail('CLOUD_PROTOCOL','MiniMax 音色列表无效');
        if(voiceType!=='all'&&category!==voiceType&&!(category==='system_voice'&&voiceType==='system'))continue;
        for(const row of rows){
          if(!validVoice(row?.voice_id))continue;
          const name=typeof row.voice_name==='string'?row.voice_name:typeof row.name==='string'?row.name:row.voice_id;
          voices.push({voiceId:row.voice_id,name:name.slice(0,200),category});
        }
      }
      if(!includeCloneListEvidence)return voices;
      const clones=value.voice_cloning;
      const cloneListComplete=(kind==='all'||kind==='cloned')&&Array.isArray(clones)&&clones.every(row=>validVoice(row?.voice_id));
      return {voices,cloneListComplete};
    },
    async deleteClone(ctx,voiceId,options){
      await request(ctx,'/v1/delete_voice',{voice_type:'voice_cloning',voice_id:voiceId},options);
    },
  };
}

async function readJsonBody(response,signal){
  if(!response.body)return undefined;
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let bytes=0,text='';
  try{
    for(;;){
      const {value,done}=await waitForNetwork(()=>reader.read(),signal);
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>maxResponseBytes)throw new MiniMaxSpeechError('protocol');
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
  }finally{
    void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  try{return parseMiniMaxJson(text);}catch{return undefined;}
}

export function createMiniMaxAccountRequest(fetchImpl,base){
  return async function request({connection},path,body,{signal,form=false,operation}={}){
    signal?.throwIfAborted();
    const timeout=AbortSignal.timeout(120000);
    const bounded=signal?AbortSignal.any([signal,timeout]):timeout;
    const endpoint=base+path;
    let response;
    try{
      response=await waitForNetwork(()=>fetchImpl(endpoint,{
        method:'POST',redirect:'error',credentials:'omit',signal:bounded,
        headers:{Authorization:'Bearer '+connection.key,accept:'application/json',...(!form?{'Content-Type':'application/json'}:{})},
        body:form?body:miniMaxJsonBody(body),
      }),bounded);
      if(response.redirected||response.url&&response.url!==endpoint)throw new MiniMaxSpeechError('protocol');
      if(response.status>=300&&response.status<400)throw minimaxHttpError(response.status);
      const payload=await readJsonBody(response,bounded);
      const business=minimaxBusinessError(payload,{operation});
      if(business)throw business;
      if(!response.ok)throw minimaxHttpError(response.status);
      if(payload?.base_resp?.status_code!==0)throw new MiniMaxSpeechError('protocol');
      return payload;
    }catch(error){
      signal?.throwIfAborted();
      if(timeout.aborted||error?.name==='TimeoutError'||error?.code==='NETWORK_RESPONSE_TIMEOUT')throw new MiniMaxSpeechError('timeout');
      if(error instanceof MiniMaxSpeechError)throw error;
      throw new MiniMaxSpeechError('network');
    }finally{
      if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{});
    }
  };
}
