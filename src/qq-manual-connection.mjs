import {localEndpoint} from './buddy-plugin-services/social-accounts.mjs';
import {qqOneBotUrl} from './qq-onebot-url.mjs';
const fail=code=>Object.assign(Error(code),{code});
// Advanced OneBot connections use their explicitly configured loopback URLs.
// They do not start, reconfigure or terminate an external QQ process.
export function manualQqSession(account,secret){
 const http=localEndpoint(account.httpUrl,['http:','https:']),ws=localEndpoint(account.webSocketUrl,['ws:','wss:']);
 async function request(action){
  const url=qqOneBotUrl(http,action);
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+(secret.accessToken??'')},body:'{}',signal:AbortSignal.timeout(6000)});
  const text=await response.text();if(text.length>4*1024*1024)throw fail('QQ_COMPONENT_RESPONSE_TOO_LARGE');
  const value=JSON.parse(text);if(!response.ok||value.status!=='ok'||value.retcode!==0)throw fail('QQ_ONEBOT_NOT_READY');return value.data;
 }
 async function verify(){const identity=await request('get_login_info');if(String(identity?.user_id)!==account.accountId)throw fail('SOCIAL_LOGIN_IDENTITY_MISMATCH');return identity;}
 async function socket(){
  const url=new URL(ws);url.searchParams.set('access_token',secret.accessToken??'');const client=new WebSocket(url);let timer;
  try{await new Promise((yes,no)=>{client.addEventListener('open',yes,{once:true});client.addEventListener('error',()=>no(fail('QQ_ONEBOT_NOT_READY')),{once:true});timer=setTimeout(()=>no(fail('QQ_ONEBOT_NOT_READY')),6000);});}
  finally{clearTimeout(timer);client.close();}
 }
 return {request,verify,socket};
}
