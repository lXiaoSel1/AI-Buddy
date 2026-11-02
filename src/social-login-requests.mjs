export const LOGIN_REQUEST_TTL=120000,LOGIN_REQUEST_LIMIT=256;
export function createSocialLoginRequests({open,ack=()=>{},close=()=>{},now=Date.now}={}){
 const seen=new Map();let active=null,disposed=false;
 const prune=at=>{for(const [id,expires]of seen)if(expires<=at)seen.delete(id);};
 const acknowledge=id=>void Promise.resolve().then(()=>ack(id)).catch(()=>{});
 return {
  take(value,pulled=false){
   if(disposed||!['bilibili','qq'].includes(value?.platform)||typeof value.requestId!=='string'||!value.requestId||value.requestId.length>100)return false;
   const at=now();prune(at);if(!Number.isFinite(value.at)||value.at>at+5000||at-value.at>=LOGIN_REQUEST_TTL)return false;
   if(seen.has(value.requestId)||seen.size>=LOGIN_REQUEST_LIMIT)return false;
   seen.set(value.requestId,value.at+LOGIN_REQUEST_TTL);acknowledge(value.requestId);active={platform:value.platform,requestId:value.requestId};open(active,pulled);return true;
  },
  close(requestId){if(disposed||active?.requestId!==requestId)return false;active=null;close();return true;},
  dispose(){disposed=true;active=null;seen.clear();}
 };
}
