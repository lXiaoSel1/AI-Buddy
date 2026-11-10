import http from 'node:http';import https from 'node:https';import tls from 'node:tls';
import {Readable} from 'node:stream';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {networkFailure} from './network-errors.mjs';
import {proxyRoutes} from './network-settings.mjs';
const provenance=new WeakMap();
export const networkResponseInfo=response=>provenance.get(response)??null;
function describeResponse(response,info,redirected){
  const clone=response.clone.bind(response);
  Object.defineProperties(response,{
    url:{value:info.finalUrl,enumerable:true,configurable:true},
    redirected:{value:redirected,enumerable:true,configurable:true},
    clone:{value:()=>describeResponse(clone(),info,redirected),writable:true,configurable:true},
  });
  provenance.set(response,info);return response;
}
let systemCAs;
export function invalidateSystemCAs(){systemCAs=undefined;}
export function windowsSystemCAs(){return systemCAs??=Object.freeze([...new Set([...tls.getCACertificates('default'),...tls.getCACertificates('system')])]);}
export function createNodeNetworkFetch({resolveRoute=async()=>[{kind:'direct'}],ca=windowsSystemCAs,userAgent='node',connectTimeoutMs=10000,headersTimeoutMs=300000}={}){
  async function once(url,request,body,route,redirected){
    const secure=url.protocol==='https:',implementation=secure?https:http;
    const proxyEnv=route.kind==='direct'?{}:{HTTP_PROXY:route.url,HTTPS_PROXY:route.url,NO_PROXY:''};
    const agent=new implementation.Agent({keepAlive:false,proxyEnv,ca:typeof ca==='function'?ca():ca});
    return new Promise((resolve,reject)=>{
      let outgoing,connectingSocket,readySocket,readyEvent,connectTimer,headersTimer,settled=false,ready=false;
      // A proxied HTTPS Agent returns its raw socket before assigning the
      // tunneled TLS socket to the request. Keep that socket reachable so the
      // connection deadline and cancellation also close a stalled CONNECT.
      const createConnection=agent.createConnection.bind(agent);
      agent.createConnection=(...args)=>connectingSocket=createConnection(...args);
      function cleanup(){
        clearTimeout(connectTimer);clearTimeout(headersTimer);
        request.signal.removeEventListener('abort',onAbort);
        if(readyEvent)readySocket?.removeListener(readyEvent,onReady);
      }
      function fail(cause){
        if(settled)return;settled=true;cleanup();
        outgoing?.destroy(cause instanceof Error?cause:undefined);connectingSocket?.destroy();agent.destroy();
        reject(request.signal.aborted?request.signal.reason:networkFailure(cause,url));
      }
      function onAbort(){fail(request.signal.reason);}
      function onReady(){
        if(settled||ready)return;ready=true;clearTimeout(connectTimer);
        if(headersTimeoutMs>0)headersTimer=setTimeout(()=>fail(Object.assign(Error('Response headers timed out'),{code:'UND_ERR_HEADERS_TIMEOUT',phase:'headers'})),headersTimeoutMs);
      }
      if(connectTimeoutMs>0)connectTimer=setTimeout(()=>fail(Object.assign(Error('Network connection timed out'),{code:'ETIMEDOUT',phase:'connect'})),connectTimeoutMs);
      request.signal.addEventListener('abort',onAbort,{once:true});
      try{outgoing=implementation.request(url,{method:request.method,headers:Object.fromEntries(request.headers),agent,signal:request.signal},incoming=>{
        if(settled){incoming.destroy();return;}settled=true;cleanup();
        const headers=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
        const empty=request.method==='HEAD'||[204,205,304].includes(incoming.statusCode);
        const encoding=headers.get('content-encoding'),decoder=!empty&&(encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null);
        if(decoder){incoming.on('error',cause=>decoder.destroy(cause));decoder.on('close',()=>incoming.destroy());incoming.pipe(decoder);}
        const response=describeResponse(new Response(empty?null:Readable.toWeb(decoder??incoming),{status:incoming.statusCode,statusText:incoming.statusMessage,headers}),{requestUrl:url.href,finalUrl:url.href,proxy:route.kind},redirected);
        incoming.once('close',()=>agent.destroy());if(empty)incoming.resume();resolve(response);
      });}catch(cause){settled=true;cleanup();connectingSocket?.destroy();agent.destroy();reject(cause);return;}
      outgoing.once('error',fail);
      outgoing.once('socket',socket=>{
        readySocket=socket;
        if(socket.encrypted&&!socket.authorized){readyEvent='secureConnect';socket.once(readyEvent,onReady);}
        else if(socket.connecting){readyEvent='connect';socket.once(readyEvent,onReady);}
        else onReady();
      });
      if(request.signal.aborted){onAbort();return;}
      if(body?.length)outgoing.write(body);outgoing.end();
    });
  }
  return async function networkFetch(input,init={}){
    let request=new Request(input,init),body=request.body?Buffer.from(await request.arrayBuffer()):null;
    for(const [name,value] of [['user-agent',userAgent],['accept','*/*'],['accept-encoding','gzip, deflate']])if(!request.headers.has(name))request.headers.set(name,value);
    for(let hop=0;;hop++){
      request.signal.throwIfAborted();const url=new URL(request.url);if(!['http:','https:'].includes(url.protocol))throw Error('Unsupported network protocol');
      if(!request.headers.has('content-length')&&!request.headers.has('transfer-encoding')&&(body!==null||['POST','PUT'].includes(request.method)))request.headers.set('content-length',String(body?.length??0));
      let routes=await resolveRoute(url.href);if(typeof routes==='string')routes=proxyRoutes(routes);if(!Array.isArray(routes)||!routes.length)throw Error('No proxy route available');
      let response,lastError;
      for(const route of routes){try{response=await once(url,request,body,route,hop>0);break;}catch(cause){lastError=cause;const code=cause?.cause?.code??cause?.cause?.cause?.code;if(request.signal.aborted||!['ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH'].includes(code)&&!(route.kind!=='direct'&&code==='ERR_PROXY_TUNNEL'))throw cause;}}
      if(!response)throw lastError;
      if(![301,302,303,307,308].includes(response.status)||!response.headers.get('location')||request.redirect==='manual')return response;
      await response.body?.cancel();if(request.redirect==='error')throw Object.assign(Error('Network redirect rejected'),{code:'NETWORK_REDIRECT'});
      if(hop>=19)throw Error('Too many network redirects');const target=new URL(response.headers.get('location'),url);
      const headers=new Headers(request.headers);if(target.origin!==url.origin){headers.delete('authorization');headers.delete('cookie');headers.delete('proxy-authorization');}
      let method=request.method;if(response.status===303&&method!=='HEAD'||[301,302].includes(response.status)&&method==='POST'){method='GET';body=null;headers.delete('content-type');headers.delete('content-length');}
      request=new Request(target,{method,headers,signal:request.signal,redirect:request.redirect,...(body?{body}:{})});
    }
  };
}
