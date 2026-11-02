import {createServer} from 'node:http';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';

const fail=(message,code='WORK_HOST_DENIED')=>Object.assign(Error(message),{code});
const secretEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Private Node-to-host job ports. Never returned to a renderer or model. */
export function createWorkHostServer({dispatch,validateLease=()=>{},maxRequestBytes=8*1024*1024}={}){
  if(typeof dispatch!=='function')throw TypeError('A host port dispatcher is required');
  const leases=new Map(),active=new Set();let listening,origin,closed=false;
  const server=createServer(async(req,res)=>{
    const json=(status,value)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    let row,controller;
    try{
      if(closed||req.method!=='POST'||req.headers.origin||req.headers.host!==new URL(origin).host||req.headers['content-type']?.split(';')[0]!=='application/json')return json(403,{error:{code:'WORK_HOST_TRANSPORT_DENIED'}});
      const match=/^\/rpc\/([a-f0-9-]{36})$/.exec(req.url??'');row=match&&leases.get(match[1]);
      if(!row||row.revoked||!secretEqual(req.headers.authorization,'Bearer '+row.bearer))return json(401,{error:{code:'WORK_HOST_AUTH_REQUIRED'}});
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxRequestBytes)throw fail('Host request is too large','WORK_HOST_REQUEST_TOO_LARGE');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body.operation!=='string'||body.payload!=null&&(typeof body.payload!=='object'||Array.isArray(body.payload)))throw fail('Invalid host request');
      controller=new AbortController();const operation={row,controller};active.add(operation);
      res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      try{await validateLease(row,body.operation,body.payload??{});const result=await dispatch({lease:row,operation:body.operation,payload:body.payload??{},signal:controller.signal});return json(200,{result});}finally{active.delete(operation);}
    }catch(error){json(error.code==='WORK_HOST_REQUEST_TOO_LARGE'?413:400,{error:{code:error.code??'WORK_HOST_FAILED',message:error.message}});}
  });
  server.requestTimeout=0;server.headersTimeout=30000;
  async function start(){if(closed)throw fail('Host ports are closed');if(!listening)listening=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();});});await listening;}
  async function createLease(value){await start();const leaseId=randomUUID(),bearer=randomBytes(32).toString('base64url'),row={...value,leaseId,bearer,createdAt:Date.now(),revoked:false};leases.set(leaseId,row);return {leaseId,url:origin+'/rpc/'+leaseId,bearer};}
  function revoke(predicate){for(const[id,row]of leases)if(predicate(row)){row.revoked=true;leases.delete(id);for(const op of active)if(op.row===row)op.controller.abort();}}
  async function close(){if(closed)return;closed=true;revoke(()=>true);if(listening){await listening;await new Promise(r=>server.close(r));server.closeAllConnections?.();}}
  return {createLease,revoke,close,snapshot:()=>({listening:!!origin,leases:leases.size,active:active.size})};
}
