import {join} from 'node:path';
import {readJson,createSnapshotStorage} from './storage.mjs';
import {NETWORK_DEFAULTS,normalizeNetworkSettings,downloadRequestPlan,isLoopback,proxyRoutes} from './network-settings.mjs';
import {createNodeNetworkFetch,windowsSystemCAs,invalidateSystemCAs} from './network-node.mjs';
import {networkFailure} from './network-errors.mjs';
import {fetchDownloadResponse,waitForNetwork} from './network-download.mjs';
const catalog='https://raw.githubusercontent.com/lXiaoSel1/AI-Buddy-Extensions/main/catalog.json';
export async function createNetworkService({dataRoot,session,electronSession,resolveSystemProxy,userAgent='AI-Buddy',onChange=()=>{}}={}){
  invalidateSystemCAs();
  const store=dataRoot?createSnapshotStorage(join(dataRoot,'network-settings.json')):null;
  let settings=normalizeNetworkSettings(store?await readJson(store,{}):{}),revision=0,tail=Promise.resolve();
  const ses=electronSession??session?.fromPartition('ai-buddy-network',{cache:false});
  ses?.setUserAgent?.(userAgent);
  const systemSes=session?.fromPartition('ai-buddy-network-system',{cache:false});if(systemSes)await systemSes.setProxy({mode:'system'});
  const apply=async config=>{if(ses)await ses.setProxy(config.mode==='manual'?{mode:'fixed_servers',proxyRules:config.proxyUrl,proxyBypassRules:'<-loopback>;localhost;127.0.0.1;[::1]'}:{mode:config.mode==='direct'?'direct':'system'});};
  await apply(settings);
  const snapshot=()=>({...settings,revision});
  async function resolveRoutes(value,captured=settings){
    const active=normalizeNetworkSettings(Object.fromEntries(Object.keys(NETWORK_DEFAULTS).map(key=>[key,captured[key]??NETWORK_DEFAULTS[key]])));
    if(isLoopback(value)||active.mode==='direct')return [{kind:'direct'}];
    if(active.mode==='manual')return proxyRoutes(active.proxyUrl);
    const resolver=resolveSystemProxy??(systemSes?url=>systemSes.resolveProxy(url):settings.mode==='system'&&ses?url=>ses.resolveProxy(url):null);
    if(!resolver)throw Object.assign(Error('系统代理解析不可用'),{code:'NETWORK_SYSTEM_PROXY_UNAVAILABLE'});
    return proxyRoutes(await resolver(value));
  }
  const nodeFetch=createNodeNetworkFetch({resolveRoute:resolveRoutes,userAgent});
  async function fetchImpl(input,init={}){
    const value=typeof input==='string'||input instanceof URL?String(input):input.url;
    const redirect=init.redirect??(input instanceof Request?input.redirect:'follow');
    // Chromium rejects manual redirects instead of exposing the 3xx response.
    // Select the transport before sending so a submitted request is never retried.
    try{return ses&&!isLoopback(value)&&redirect!=='manual'?await ses.fetch(input,{credentials:'omit',...init}):await nodeFetch(input,init);}
    catch(cause){if(init.signal?.aborted)throw init.signal.reason;throw networkFailure(cause,value);}
  }
  function save(value){const task=tail.then(async()=>{const next=normalizeNetworkSettings(value),previous=settings;await apply(next);try{if(store)await store.writeText(JSON.stringify(next));}catch(cause){await apply(previous);throw cause;}settings=next;invalidateSystemCAs();revision++;onChange(snapshot());return snapshot();});tail=task.catch(()=>{});return task;}
  const capture=({official=false}={})=>{if(typeof official!=='boolean')throw Error('Invalid official download mode');const captured={...snapshot(),...(official?{githubMirror:'',huggingFaceMirror:''}:{})},downloadConfig=Object.fromEntries(Object.keys(NETWORK_DEFAULTS).map(key=>[key,captured[key]]));return {snapshot:()=>({...captured}),resolveRoutes:url=>resolveRoutes(url,captured),fetch:createNodeNetworkFetch({resolveRoute:url=>resolveRoutes(url,captured),userAgent}),planDownload:(url,options)=>downloadRequestPlan(url,downloadConfig,{...options,official:official||options?.official===true}),childNetworkConfig:async url=>({destinationOrigin:new URL(url).origin,settings:{...downloadConfig},routes:await resolveRoutes(url,captured),ca:windowsSystemCAs().join('\n')})};};
  async function testCatalog(){
    const signal=AbortSignal.timeout(30000),config={...settings};
    const response=await fetchDownloadResponse(catalog,{fetchImpl,planDownload:url=>downloadRequestPlan(url,config),signal,validateUrl:value=>{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid catalog URL');return url;}});
    if(!response.ok){await response.body?.cancel();throw networkFailure(null,catalog,{response});}
    const invalid=()=>Object.assign(Error('扩展目录返回了无效内容'),{code:'NETWORK_CATALOG_INVALID'}),chunks=[];let size=0;
    const reader=response.body?.getReader();if(!reader)throw invalid();
    try{if(/text\/html/i.test(response.headers.get('content-type')??''))throw invalid();while(true){const {done,value}=await waitForNetwork(()=>reader.read(),signal);if(done)break;size+=value.length;if(size>16*1024*1024+20000)throw invalid();chunks.push(Buffer.from(value));}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    let envelope;try{envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw invalid();}
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||envelope.payload?.schemaVersion!==1||!Array.isArray(envelope.payload.packages)||typeof envelope.signature?.value!=='string')throw invalid();
    return {ok:true,message:'可以访问扩展目录',signatureVerified:false};
  }
  return {snapshot,save,capture,fetch:fetchImpl,resolveRoutes,planDownload:(url,options)=>downloadRequestPlan(url,settings,options),
    test:testCatalog,
    childNetworkConfig:async url=>({destinationOrigin:new URL(url).origin,settings:{...settings},routes:await resolveRoutes(url),ca:windowsSystemCAs().join('\n')}),
    close:async()=>{await tail;await ses?.closeAllConnections();await systemSes?.closeAllConnections();}};
}
