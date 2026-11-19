import {MiniMaxSpeechError,minimaxBusinessError,minimaxHttpError,minimaxSpeechStatus} from '../minimax-speech-errors.mjs';
import {createMiniMaxAccountRequest,createMiniMaxOperations,miniMaxBaseUrls,validCloudVoiceId,validCloneVoiceId} from './minimax-account.mjs';
import {launchMiniMaxSpeech} from './minimax-speech.mjs';

export {validCloudVoiceId};

const defaultModel='speech-2.8-turbo';
const probeVoiceId='Chinese (Mandarin)_Reliable_Executive';
const voiceKinds={system_voice:'system',voice_cloning:'clone',voice_generation:'account'};
const capabilities=Object.freeze({clone:true,transport:'http-sse',listVoices:true,formats:Object.freeze(['pcm'])});
const clipFormats=['wav','mp3','m4a'];
const maxReferenceBytes=20*1024*1024;

function validateClip(clip){
  if(!(clip?.bytes instanceof Uint8Array)||!clip.bytes.byteLength||clip.bytes.byteLength>maxReferenceBytes||!clipFormats.includes(clip.format??'wav')){
    throw new MiniMaxSpeechError('parameters');
  }
}

function classifyError(raw,options){
  if(raw instanceof MiniMaxSpeechError)return raw;
  const statusCode=raw?.providerCode??raw?.base_resp?.status_code;
  const httpStatus=raw?.httpStatus;
  return minimaxBusinessError({base_resp:{status_code:statusCode}},options)
    ??(Number.isSafeInteger(httpStatus)&&httpStatus>=400&&httpStatus<600?minimaxHttpError(httpStatus):undefined)
    ??new MiniMaxSpeechError(['CLOUD_PROTOCOL','CLOUD_INCOMPLETE'].includes(raw?.code)?'response':'network');
}

function createProvider(id,base,fetchImpl){
  const operations=createMiniMaxOperations(createMiniMaxAccountRequest(fetchImpl,base));
  const context=(cred,model=cred.model??defaultModel)=>({connection:{key:cred.key,model}});
  return {
    id,
    capabilities,
    async probe(cred,signal){
      try{
        await operations.activate(context(cred),{voiceId:probeVoiceId},{signal});
        return {state:'ready'};
      }catch(raw){
        signal?.throwIfAborted();
        const error=classifyError(raw);
        const state=({auth:'key_invalid',balance:'balance_insufficient'})[error.category]??'unavailable';
        return minimaxSpeechStatus({...error,message:error.message,state});
      }
    },
    async listVoices(cred,{kind='all',includeCloneListEvidence=false}={},signal){
      try{
        const result=await operations.voices(context(cred),{kind,signal,includeCloneListEvidence});
        const voices=(includeCloneListEvidence?result.voices:result).map(voice=>({...voice,kind:voiceKinds[voice.category]}));
        return includeCloneListEvidence?{voices,cloneListComplete:result.cloneListComplete}:voices;
      }catch(raw){
        signal?.throwIfAborted();
        throw classifyError(raw);
      }
    },
    // Usage is available once the caller consumes or closes the audio iterator.
    synthesize(cred,{model=cred.model??defaultModel,voiceId,text,params},signal){
      const job=launchMiniMaxSpeech(fetchImpl,{
        base,key:cred.key,model,voiceId,text,params,performance:params?.performance??params,
      },{signal});
      const usage=Promise.withResolvers();
      const audio=(async function*(){
        try{
          for await(const row of job.events){
            if(row.type==='pcm')yield row.pcm;
            else if(row.type==='done')usage.resolve(row.usage);
          }
        }finally{usage.resolve(undefined);}
      })();
      const close=audio.return.bind(audio);
      return Object.assign(audio,{usage:usage.promise,async return(value){
        try{await job.cancel();return await close(value);}
        finally{usage.resolve(undefined);}
      }});
    },
    async cloneVoice(cred,{reference,prompt,voiceId},signal){
      if(!validCloneVoiceId(voiceId))throw new MiniMaxSpeechError('parameters');
      validateClip(reference);
      if(prompt){
        validateClip(prompt);
        if(typeof prompt.text!=='string'||!prompt.text.trim())throw new MiniMaxSpeechError('parameters');
      }
      try{
        const ctx=context(cred);
        const {fileId}=await operations.upload(ctx,reference.bytes,{signal,format:reference.format});
        let clonePrompt;
        if(prompt){
          const uploaded=await operations.upload(ctx,prompt.bytes,{signal,format:prompt.format,purpose:'prompt_audio'});
          clonePrompt={fileId:uploaded.fileId,text:prompt.text};
        }
        const textValidation=typeof reference.text==='string'&&reference.text.length<=200?reference.text:undefined;
        await operations.clone(ctx,{fileId,voiceId,textValidation,prompt:clonePrompt},{signal});
        return {voiceId,state:'pending-activation'};
      }catch(raw){
        signal?.throwIfAborted();
        throw classifyError(raw,{operation:'clone'});
      }
    },
    async activateVoice(cred,{model,voiceId},signal){
      if(!validCloudVoiceId(voiceId))throw new MiniMaxSpeechError('parameters');
      try{await operations.activate(context(cred,model),{voiceId},{signal});}
      catch(raw){signal?.throwIfAborted();throw classifyError(raw);}
    },
    async deleteVoice(cred,voiceId,signal){
      if(!validCloneVoiceId(voiceId))throw new MiniMaxSpeechError('parameters');
      try{await operations.deleteClone(context(cred),voiceId,{signal});}
      catch(raw){signal?.throwIfAborted();throw classifyError(raw);}
    },
    classifyError,
  };
}

export function createCloudProviderRegistry({fetchImpl=globalThis.fetch}={}){
  return new Map(Object.entries(miniMaxBaseUrls).map(([id,base])=>[id,createProvider(id,base,fetchImpl)]));
}
