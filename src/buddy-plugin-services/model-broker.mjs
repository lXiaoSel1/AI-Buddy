import {contextFailure,plain} from './trusted-context.mjs';

const credentialFields=/^(?:key|api[-_]?key|keyCiphertext|authorization|access[-_]?token|refresh[-_]?token|password|credentials?|env)$/i;
export function sanitizePluginValue(value,secrets=[]){
  if(typeof value==='string'){let text=value.replace(/\bBearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g,'[redacted]');for(const secret of secrets)if(typeof secret==='string'&&secret.length>=6)text=text.split(secret).join('[redacted]');return text;}
  if(Array.isArray(value))return value.map(v=>sanitizePluginValue(v,secrets));
  if(plain(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!credentialFields.test(key)).map(([key,v])=>[key,sanitizePluginValue(v,secrets)]));
  return value;
}
function rejectCredentials(value){if(!value||typeof value!=='object')return;for(const[key,item]of Object.entries(value)){if(credentialFields.test(key))throw contextFailure('Plugin model requests accept connection references, not credentials','BUDDY_MODEL_INVALID');if(item&&typeof item==='object')rejectCredentials(item);}}
/** The only materialization happens inside ModelRouter's captured execution lane. */
export function createModelReferenceBroker({getProvider}={}){
  if(typeof getProvider!=='function')throw Error('Model broker requires the core ModelRouter');
  async function request(context,payload,{signal,check=async()=>{}}={}){
    rejectCredentials(payload);
    if(typeof payload.connectionRef!=='string'||!context.connectionRefs.includes(payload.connectionRef))throw contextFailure('Model connection reference is outside the trusted context','BUDDY_MODEL_CONNECTION_DENIED');
    if(!Array.isArray(payload.messages)||payload.messages.length>200||payload.messages.some(m=>!plain(m)||!['user','assistant'].includes(m.role)||typeof m.content!=='string'))throw contextFailure('Invalid model messages','BUDDY_MODEL_INVALID');
    if(Buffer.byteLength(JSON.stringify(payload))>1024*1024||payload.system!=null&&typeof payload.system!=='string')throw contextFailure('Model request exceeds its supported shape','BUDDY_MODEL_INVALID');
    if(payload.maxTokens!=null&&(!Number.isSafeInteger(payload.maxTokens)||payload.maxTokens<1||payload.maxTokens>65536))throw contextFailure('Invalid model output limit','BUDDY_MODEL_INVALID');
    const provider=getProvider();if(!provider||typeof provider.captureConnection!=='function'||typeof provider.runCaptured!=='function'||typeof provider.stream!=='function')throw contextFailure('Core model service is unavailable','BUDDY_SERVICE_UNAVAILABLE');
    await provider.ready;await check();const captured=provider.captureConnection({enabled:true,connectionId:payload.connectionRef});
    if(!captured||captured.id!==payload.connectionRef)throw contextFailure('Referenced model connection no longer exists','BUDDY_MODEL_CONNECTION_DENIED');
    // The snapshot may contain encrypted credentials. It remains in this closure,
    // never in a plugin event, context, request receipt or serialized return value.
    const publicConnection={id:captured.id,kind:captured.kind,model:captured.model},parts=[];
    const scopedSecrets=[captured.key,captured.keyCiphertext];
    if(typeof provider.materialize==='function')scopedSecrets.push(provider.materialize(captured)?.key);
    try{
      await provider.runCaptured(captured,async()=>{
        await check();for await(const part of provider.stream({messages:structuredClone(payload.messages),system:payload.system??'',maxTokens:payload.maxTokens??2048,purpose:'plugin:'+context.pluginId,signal})){await check();if(signal?.aborted)throw contextFailure('Model request cancelled','ABORT_ERR');parts.push(sanitizePluginValue(part,scopedSecrets));}
      },signal,{background:payload.background===true});
      await check();return {connection:publicConnection,parts,text:parts.filter(p=>p.type==='text-delta').map(p=>p.text??'').join(''),usageAccounting:'core-model-router'};
    }catch(error){throw Object.assign(Error(sanitizePluginValue(String(error.message),scopedSecrets)),{code:/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code??'')?error.code:'BUDDY_MODEL_FAILED'});}
  }
  return {request};
}
