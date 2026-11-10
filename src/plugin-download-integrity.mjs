import {downloadResponseInfo} from './network-download.mjs';
const metadata=new WeakMap();
export function rememberPluginMetadata(value,response){if(value&&typeof value==='object')metadata.set(value,downloadResponseInfo(response));return value;}
export function pluginMirrorIntegrity(cause,info){
 if(!info?.mirror)return cause;
 const technicalCode=typeof cause?.code==='string'?cause.code:'PLUGIN_CATALOG_INVALID';let host='';try{host=new URL(info.finalUrl??info.requestUrl).hostname;}catch{return cause;}
 return Object.assign(Error('镜像返回的文件和官方记录不一致，已拒绝',{cause}),{code:'NETWORK_MIRROR_MISMATCH',originKnownMirror:true,retryOfficial:true,host,technicalCode});
}
export function verifyPluginMetadata(value,verify){try{return verify(value);}catch(cause){throw pluginMirrorIntegrity(cause,metadata.get(value));}}

const transientDownloadCodes=new Set(['NETWORK_CONNECT_FAILED','NETWORK_RESPONSE_TIMEOUT','NETWORK_TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
export async function retryPluginDownload(run,signal){for(let attempt=0;;attempt++){signal?.throwIfAborted();try{return await run();}catch(cause){if(signal?.aborted)throw signal.reason;const code=typeof cause?.code==='string'?cause.code:typeof cause?.cause?.code==='string'?cause.cause.code:'';if(attempt>=2||!(transientDownloadCodes.has(code)||!code&&cause instanceof TypeError))throw cause;}}}
