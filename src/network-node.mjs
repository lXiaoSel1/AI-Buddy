import http from 'node:http';import https from 'node:https';import tls from 'node:tls';
import {Readable} from 'node:stream';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {networkFailure} from './network-errors.mjs';
import {proxyRoutes} from './network-settings.mjs';
const provenance=new WeakMap();
export const networkResponseInfo=response=>provenance.get(response)??null;
let systemCAs;
export function invalidateSystemCAs(){systemCAs=undefined;}
export function windowsSystemCAs(){return systemCAs??=Object.freeze([...new Set([...tls.getCACertificates('default'),...tls.getCACertificates('system')])]);}
export function createNodeNetworkFetch({resolveRoute=async()=>[{kind:'direct'}],ca=windowsSystemCAs}={}){
  async function once(url,request,body,route){
    const secure=url.protocol==='https:',implementation=secure?https:http;
    const proxyEnv=route.kind==='direct'?{}:{HTTP_PROXY:route.url,HTTPS_PROXY:route.url,NO_PROXY:''};
    const agent=new implementation.Agent({keepAlive:false,proxyEnv,ca:typeof ca==='function'?ca():ca});
    return new Promise((resolve,reject)=>{
      const outgoing=implementation.request(url,{method:request.method,headers:Object.fromEntries(request.headers),agent,signal:request.signal},incoming=>{
        const headers=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
        const empty=request.method==='HEAD'||[204,205,304].includes(incoming.statusCode);
        const encoding=headers.get('content-encoding'),decoder=!empty&&(encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null);
        if(decoder){incoming.on('error',cause=>decoder.destroy(cause));decoder.on('close',()=>incoming.destroy());incoming.pipe(decoder);}
        const response=new Response(empty?null:Readable.toWeb(decoder??incoming),{status:incoming.statusCode,statusText:incoming.statusMessage,headers});
        provenance.set(response,{requestUrl:url.href,finalUrl:url.href,proxy:route.kind});
        incoming.once('close',()=>agent.destroy());if(empty)incoming.resume();resolve(response);
      });
      outgoing.once('error',cause=>{agent.destroy();reject(request.signal.aborted?request.signal.reason:networkFailure(cause,url));});
      if(body?.length)outgoing.write(body);outgoing.end();
    });
  }
  return async function networkFetch(input,init={}){
    let request=new Request(input,init),body=request.body?Buffer.from(await request.arrayBuffer()):null;
    for(let hop=0;;hop++){
      request.signal.throwIfAborted();const url=new URL(request.url);if(!['http:','https:'].includes(url.protocol))throw Error('Unsupported network protocol');
      let routes=await resolveRoute(url.href);if(typeof routes==='string')routes=proxyRoutes(routes);if(!Array.isArray(routes)||!routes.length)throw Error('No proxy route available');
      let response,lastError;
      for(const route of routes){try{response=await once(url,request,body,route);break;}catch(cause){lastError=cause;const code=cause?.cause?.code??cause?.cause?.cause?.code;if(request.signal.aborted||!['ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH'].includes(code))throw cause;}}
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
