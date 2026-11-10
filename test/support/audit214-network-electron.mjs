import {app,session,safeStorage} from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {gzipSync,createGzip,constants,crc32} from 'node:zlib';
import {createNetworkService} from '../../src/network-service.mjs';
import {networkErrorMessage} from '../../src/network-errors.mjs';
import {downloadPinnedFile} from '../../src/network-download.mjs';
import {voiceAssetDownloadStream,downloadVoiceAsset} from '../../src/voice/asset-downloads.mjs';
import {fetchModelResponse,ApiTransport} from '../../src/api-transport.mjs';
import {CgTransport} from '../../src/cg-transport.mjs';
import {QuotaService} from '../../src/quota-service.mjs';
import {createMiniMaxVoiceProvider} from '../../src/voice/batch-voices.mjs';
import {createSocialAccounts} from '../../src/buddy-plugin-services/social-accounts.mjs';
import {createSocialTransport} from '../../src/buddy-plugin-services/social-transport.mjs';
import {createBiliMedia} from '../../src/buddy-plugin-services/bili-media.mjs';
import {createQqComponent} from '../../src/qq-component.mjs';
import {createPluginManager} from '../../src/plugin-manager.mjs';
import {createCommunityService} from '../../src/community/service.mjs';
import {createAppReleaseClient} from '../../src/update-release-proof.mjs';

const run=process.env.AUDIT214_SERVICE_RUN,checks=[],requests=[],nativeCalls=[],sockets=new Set(),services=[];
const allowed=new Set(['github.com','api.github.com','release-assets.githubusercontent.com','raw.githubusercontent.com','huggingface.co','model.audit214.invalid','untrusted.audit214.invalid','api.deepseek.com','api.minimax.cn','api.bilibili.com','fixture.hdslb.com']);
const payload=Buffer.from('AI Buddy audit214 immutable synthetic component. '.repeat(40));
const digest=createHash('sha256').update(payload).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const result={electron:process.versions.electron,node:process.versions.node,checks,requests,nativeCalls};
const check=async(name,work,transport)=>{const requestStart=requests.length,nativeStart=nativeCalls.length;try{const value=await work();checks.push({name,ok:true,...(value?.skip?{skipped:true,skipReason:value.skip}:{}),...(transport?{transport}:{}),requests:[requestStart,requests.length],sessionCalls:[nativeStart,nativeCalls.length]});}catch(error){checks.push({name,ok:false,error:error.stack??String(error),code:error.code,cause:error.cause?.message,...(transport?{transport}:{}),requests:[requestStart,requests.length],sessionCalls:[nativeStart,nativeCalls.length]});}};
const timeout=()=>AbortSignal.timeout(5000);
const consume=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);};
const track=server=>{server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});return server;};
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData',join(run,'profile'));
const deadline=setTimeout(()=>{result.fatal='Harness deadline exceeded';void writeFile(join(run,'result.json'),JSON.stringify(result,null,2)).finally(()=>app.exit(2));},45000);

await app.whenReady();
let tlsServer,proxy,loopbackServer;
try{
  const publicProof=process.env.AUDIT214_PUBLIC_PROOF&&process.env.AUDIT214_PUBLIC_INSTALLER?JSON.parse(await readFile(process.env.AUDIT214_PUBLIC_PROOF,'utf8')):null;
  const installer=publicProof?await readFile(process.env.AUDIT214_PUBLIC_INSTALLER):null;
  const communityEnvelope=process.env.AUDIT214_COMMUNITY_CACHE?JSON.parse(await readFile(process.env.AUDIT214_COMMUNITY_CACHE,'utf8')).sources.official.envelope:null;
  if(publicProof)assert.equal(createHash('sha256').update(installer).digest('hex'),publicProof.release.installerSha256);
  result.publicFixture={...(publicProof?{version:publicProof.release.version,installerBytes:installer.length,installerSha256:publicProof.release.installerSha256}:{}),...(communityEnvelope?{communityGeneratedAt:communityEnvelope.payload.generatedAt}:{})};
  const file=Buffer.from('Synthetic NapCat component. No runtime is executed.'),filename=Buffer.from('fixture.txt'),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt32LE(crc32(file),14);local.writeUInt32LE(file.length,18);local.writeUInt32LE(file.length,22);local.writeUInt16LE(filename.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt32LE(crc32(file),16);central.writeUInt32LE(file.length,20);central.writeUInt32LE(file.length,24);central.writeUInt16LE(filename.length,28);
  const zipHead=Buffer.concat([local,filename,file]),zipDirectory=Buffer.concat([central,filename]);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(zipDirectory.length,12);end.writeUInt32LE(zipHead.length,16);
  const qqZip=Buffer.concat([zipHead,zipDirectory,end]);
  const cert=await readFile(join(run,'fixture-cert.pem')),key=await readFile(join(run,'fixture-key.pem')),fingerprint=new X509Certificate(cert).fingerprint256;
  tlsServer=track(https.createServer({cert,key},async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks),row={host:req.headers.host,path:req.url,method:req.method,headers:req.headers,bytes:body.length};requests.push(row);
    if(req.headers.host==='api.github.com'&&req.url==='/repos/lXiaoSel1/AI-Buddy/releases/latest'){res.writeHead(403,{'x-ratelimit-remaining':'0'});return res.end('{}');}
    if(req.url==='/lXiaoSel1/AI-Buddy/releases/latest/download/app-release-proof.json'){res.writeHead(302,{location:'https://release-assets.githubusercontent.com/audit214-proof.json'});return res.end();}
    if(req.url==='/audit214-proof.json'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(publicProof));}
    if(req.url==='/lXiaoSel1/AI-Buddy/releases/download/v2.0.13/AI-Buddy-Setup-2.0.13-win-x64.exe'){res.writeHead(302,{location:'https://release-assets.githubusercontent.com/audit214-installer.exe'});return res.end();}
    if(req.url==='/audit214-installer.exe'){res.writeHead(200,{'content-length':installer.length});return res.end(installer);}
    if(req.url==='/lXiaoSel1/AI-Buddy-Extensions/main/community/catalog-v1.json'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(communityEnvelope));}
    if(req.url==='/api-models/v1/models'){res.writeHead(302,{location:'/api-models/final'});return res.end();}
    if(req.url==='/api-models/final'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"data":[{"id":"synthetic-model"}]}');}
    if(req.url==='/api-sse/v1/chat/completions'){
      res.writeHead(200,{'content-type':'text/event-stream','content-encoding':'gzip'});const gzip=createGzip();gzip.pipe(res);
      gzip.write('data: '+JSON.stringify({choices:[{delta:{content:'synthetic '}}]})+'\n\n');gzip.flush(constants.Z_SYNC_FLUSH);
      return setTimeout(()=>gzip.end('data: '+JSON.stringify({choices:[{delta:{content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:2}})+'\n\ndata: [DONE]\n\n'),20);
    }
    if(req.url==='/cg/v1/images/generations'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({data:[{url:'https://model.audit214.invalid/cg/image.png'}]}));}
    if(req.url==='/cg/image.png'){res.writeHead(200,{'content-type':'image/png','content-length':png.length});return res.end(png);}
    if(req.headers.host==='api.deepseek.com'&&req.url==='/user/balance'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({is_available:true,balance_infos:[{currency:'USD',total_balance:'3.5',granted_balance:'1',topped_up_balance:'2.5'}]}));}
    if(req.headers.host==='api.minimax.cn'&&req.url==='/v1/files/upload'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"base_resp":{"status_code":0},"file":{"file_id":214}}');}
    if(req.headers.host==='api.minimax.cn'&&req.url==='/v1/get_voice'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"base_resp":{"status_code":0},"voice_cloning":[{"voice_id":"fixture_voice_214","voice_name":"Synthetic"}]}');}
    if(req.headers.host==='api.bilibili.com'&&req.url.startsWith('/x/web-interface/view')){res.writeHead(200,{'content-type':'application/json'});return res.end('{"code":0,"data":{"title":"Synthetic"}}');}
    if(req.headers.host==='fixture.hdslb.com'&&req.url==='/media.mp4'){res.writeHead(206,{'content-length':payload.length,'content-range':`bytes 0-${payload.length-1}/${payload.length}`});return res.end(payload);}
    if(req.url==='/qq-component.zip'){res.writeHead(302,{location:'https://release-assets.githubusercontent.com/qq-component-final.zip'});return res.end();}
    if(req.url==='/qq-component-final.zip'){res.writeHead(200,{'content-length':qqZip.length});return res.end(qqZip);}
    if(req.url==='/redirect'){res.writeHead(302,{location:'/asset'});return res.end();}
    if(req.url==='/github-download'){res.writeHead(302,{location:'https://release-assets.githubusercontent.com/asset'});return res.end();}
    if(req.url==='/model-same'){res.writeHead(302,{location:'/model-final'});return res.end();}
    if(req.url==='/model-cross'){res.writeHead(307,{location:'https://github.com/should-not-send'});return res.end();}
    if(req.url==='/model-final'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"ok":true}');}
    if(req.url==='/asset'||req.url==='/voice-compression'){
      const encoded=req.url==='/voice-compression'&&req.headers['accept-encoding']!=='identity';
      const bytes=encoded?gzipSync(payload):payload;res.writeHead(200,{'content-length':bytes.length,...(encoded?{'content-encoding':'gzip'}:{})});return res.end(bytes);
    }
    if(req.url==='/gzip'){const bytes=gzipSync(payload);res.writeHead(200,{'content-encoding':'gzip','content-length':bytes.length});return res.end(bytes);}
    if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: one\n\n');return setTimeout(()=>res.end('data: two\n\n'),30);}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({headers:req.headers,body:body.toString('utf8')}));
  }));
  await listen(tlsServer);
  proxy=track(http.createServer((_req,res)=>{res.writeHead(400);res.end();}));
  proxy.on('connect',(req,client,head)=>{
    const target=new URL('https://'+req.url);if(!allowed.has(target.hostname)){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const upstream=net.connect(tlsServer.address().port,'127.0.0.1');sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
    upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
    upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
  });
  await listen(proxy);
  const ses=session.fromPartition('audit214-network-real-session',{cache:false});
  ses.setCertificateVerifyProc((request,callback)=>{
    let matches=false;try{matches=new X509Certificate(request.certificate.data).fingerprint256===fingerprint;}catch{}
    callback(allowed.has(request.hostname)&&request.hostname!=='untrusted.audit214.invalid'&&matches?0:-3);
  });
  const nativeFetch=ses.fetch.bind(ses);
  // Observation only: every call forwards unchanged to this real Session.
  ses.fetch=(input,init)=>{nativeCalls.push({url:String(input instanceof Request?input.url:input),redirect:init?.redirect??'follow'});return nativeFetch(input,init);};
  const service=await createNetworkService({electronSession:ses,userAgent:'AI-Buddy/2.0.14'});services.push(service);
  await service.save({mode:'manual',proxyUrl:'http://127.0.0.1:'+proxy.address().port});
  await check('F6 nonloopback requests pass through the real Electron Session',async()=>{
    const before=nativeCalls.length,response=await service.fetch('https://model.audit214.invalid/echo',{signal:timeout()});assert.equal(response.status,200);await response.json();assert.equal(nativeCalls.length,before+1);
  });
  await check('native Electron manual 302 control reproduces Redirect was cancelled',async()=>{
    await assert.rejects(nativeFetch('https://github.com/redirect',{redirect:'manual',credentials:'omit',signal:timeout()}),/Redirect was cancelled/);
  });
  await check('F2-F5 manual mode returns 302 without retrying or following the submitted request',async()=>{
    const before=requests.length,response=await service.fetch('https://github.com/redirect',{method:'POST',body:'single-submission',redirect:'manual',signal:timeout()});
    assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/asset');await response.body?.cancel();
    assert.equal(requests.slice(before).filter(row=>row.path==='/redirect').length,1);assert.equal(requests.slice(before).some(row=>row.path==='/asset'),false);
    assert.equal(requests[before].headers['user-agent'],'AI-Buddy/2.0.14');
    const request=new Request('https://github.com/redirect',{redirect:'manual'}),fromRequest=await service.fetch(request,{signal:timeout()});assert.equal(fromRequest.status,302);await fromRequest.body?.cancel();
    const nativeBefore=nativeCalls.length,overridden=await service.fetch(request,{redirect:'follow',signal:timeout()});assert.deepEqual(Buffer.from(await overridden.arrayBuffer()),payload);assert.equal(nativeCalls.length,nativeBefore+1);
  });
  await check('F5 model same-host redirects work and cross-host redirects remain rejected',async()=>{
    const response=await fetchModelResponse(service.fetch,'https://model.audit214.invalid/model-same',{method:'POST',body:'fixture',headers:{authorization:'Bearer synthetic-only'},signal:timeout()});assert.deepEqual(await response.json(),{ok:true});
    const before=requests.length;await assert.rejects(fetchModelResponse(service.fetch,'https://model.audit214.invalid/model-cross',{method:'POST',body:'fixture',headers:{authorization:'Bearer synthetic-only'},signal:timeout()}),{code:'NETWORK_REDIRECT'});
    assert.equal(requests.slice(before).some(row=>row.path==='/should-not-send'),false);
  });
  await check('F3-F4 pinned component downloads survive a real 302 with identity encoding',async()=>{
    const before=requests.length,target=join(run,'component.bin');await downloadPinnedFile({url:'https://github.com/github-download',bytes:payload.length,sha256:digest},target,{fetchImpl:service.fetch,signal:timeout(),retries:0});
    assert.deepEqual(await readFile(target),payload);assert.deepEqual(requests.slice(before).map(row=>row.headers['accept-encoding']),['identity','identity']);
  });
  await check('F2 voice stream survives a real same-host 302',async()=>{
    const stream=await voiceAssetDownloadStream({url:'https://huggingface.co/redirect',bytes:payload.length},{fetchImpl:service.fetch,signal:timeout()});assert.deepEqual(await consume(stream),payload);
  });
  await check('F2 voice stream requests identity and accepts the pinned uncompressed length',async()=>{
    const before=requests.length,stream=await voiceAssetDownloadStream({url:'https://huggingface.co/voice-compression',bytes:payload.length},{fetchImpl:service.fetch,signal:timeout()});assert.deepEqual(await consume(stream),payload);assert.equal(requests[before].headers['accept-encoding'],'identity');
  });
  await check('F8 the network partition uses the explicit app UA and preserves caller UA',async()=>{
    const ordinary=await (await service.fetch('https://model.audit214.invalid/ua',{signal:timeout()})).json();assert.equal(ordinary.headers['user-agent'],'AI-Buddy/2.0.14');
    const explicit=await (await service.fetch('https://model.audit214.invalid/ua-explicit',{headers:{'user-agent':'FixtureClient/1.0'},signal:timeout()})).json();assert.equal(explicit.headers['user-agent'],'FixtureClient/1.0');
  });
  await check('F8 blocked Chromium ports have a specific bilingual explanation',async()=>{
    await assert.rejects(service.fetch('http://127.0.0.2:6000/unsafe',{signal:timeout()}),{code:'NETWORK_UNSAFE_PORT'});
    assert.match(networkErrorMessage('NETWORK_UNSAFE_PORT',{language:'zh-CN'}),/端口/);assert.match(networkErrorMessage('NETWORK_UNSAFE_PORT',{language:'en'}),/port/i);
  });
  await check('certificate verification still rejects a host outside the trusted fixture SAN',async()=>{
    await assert.rejects(service.fetch('https://untrusted.audit214.invalid/echo',{signal:timeout()}),{code:'NETWORK_CERTIFICATE'});
    await assert.rejects(service.fetch('https://untrusted.audit214.invalid/echo',{redirect:'manual',signal:timeout()}),{code:'NETWORK_CERTIFICATE'});
  });
  await check('real Session preserves POST auth, range, binary, FormData and streaming responses',async()=>{
    const posted=await (await service.fetch('https://model.audit214.invalid/post',{method:'POST',body:Buffer.from([65,66]),headers:{authorization:'Bearer synthetic-only',range:'bytes=0-1'},signal:timeout()})).json();assert.equal(posted.body,'AB');assert.equal(posted.headers.authorization,'Bearer synthetic-only');assert.equal(posted.headers.range,'bytes=0-1');
    const data=new FormData();data.set('file',new Blob(['fixture-bytes']),'fixture.txt');const uploaded=await (await service.fetch('https://model.audit214.invalid/upload',{method:'POST',body:data,signal:timeout()})).json();assert.match(uploaded.headers['content-type'],/^multipart\/form-data; boundary=/);assert.match(uploaded.body,/fixture-bytes/);
    const response=await service.fetch('https://model.audit214.invalid/stream',{signal:timeout()}),reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/data: one/);assert.match(new TextDecoder().decode((await reader.read()).value),/data: two/);reader.releaseLock();
  });
  await check('gzip decoding retains the response headers used by native Node fetch',async()=>{
    const response=await service.fetch('https://model.audit214.invalid/gzip',{redirect:'manual',signal:timeout()});assert.deepEqual(Buffer.from(await response.arrayBuffer()),payload);assert.equal(response.headers.get('content-encoding'),'gzip');assert.equal(Number(response.headers.get('content-length')),gzipSync(payload).length);
  });
  await check('consumer ApiTransport lists models through a real same-host 302',async()=>{
    const before=nativeCalls.length,transport=new ApiTransport({fetchImpl:service.fetch});
    const rows=await transport.listModels({id:'synthetic',kind:'custom',protocol:'chat-completions',baseUrl:'https://model.audit214.invalid/api-models/v1',model:'synthetic-model',key:'synthetic-only'},timeout());
    assert.equal(rows[0].id,'synthetic-model');assert.equal(nativeCalls.length,before);
  },'Node manual');
  await check('consumer ApiTransport parses gzip SSE and reaches a protocol finish',async()=>{
    const before=nativeCalls.length,usage=[],transport=new ApiTransport({fetchImpl:service.fetch,onUsage:value=>usage.push(value)}),events=[];
    for await(const event of transport.stream({id:'synthetic',kind:'custom',protocol:'chat-completions',baseUrl:'https://model.audit214.invalid/api-sse/v1',model:'synthetic-model',key:'synthetic-only'},{messages:[{role:'user',content:'Synthetic fixture request'}],signal:timeout()}))events.push(event);
    assert.equal(events.filter(row=>row.type==='text-delta').map(row=>row.text).join(''),'synthetic answer');assert.equal(events.at(-1).type,'finish');assert.equal(usage.length,1);assert.equal(nativeCalls.length,before);
  },'Node manual');
  await check('consumer CgTransport submits image generation and downloads a small PNG',async()=>{
    const before=nativeCalls.length,transport=new CgTransport({fetchImpl:service.fetch});
    const image=await transport.generate({kind:'custom',protocol:'openai-images',baseUrl:'https://model.audit214.invalid/cg/v1',model:'synthetic-image',key:'synthetic-only',options:{references:false}},{prompt:'Synthetic fixture image',signal:timeout()});
    assert.deepEqual(image.buffer,png);assert.equal(nativeCalls.length,before+2);
  },'Session');
  await check('consumer QuotaService refresh uses the real DeepSeek adapter protocol',async()=>{
    const before=nativeCalls.length,quota=new QuotaService({dataRoot:join(run,'quota'),home:run,crypto:safeStorage,fetchImpl:service.fetch,timeoutMs:5000});
    try{const {id}=await quota.action('save',{kind:'deepseek',name:'Synthetic fixture',enabled:true,key:'synthetic-only'}),state=await quota.action('refresh',{id});assert.equal(state.profiles[0].status,'ok');assert.equal(state.profiles[0].snapshot.balances[0].amount,3.5);assert.equal(state.profiles[0].snapshot.source,'https://api.deepseek.com/user/balance');assert.equal(nativeCalls.length,before+1);}finally{await quota.close();}
  },'Session');
  await check('consumer MiniMax provider sends list JSON and upload FormData to the fixture',async()=>{
    const before=nativeCalls.length,start=requests.length,provider=createMiniMaxVoiceProvider({fetchImpl:service.fetch}),ctx={connection:{provider:'minimax',model:'synthetic',key:'synthetic-only'}};
    assert.equal((await provider.voices(ctx,{signal:timeout()}))[0].voiceId,'fixture_voice_214');assert.equal((await provider.upload(ctx,Buffer.from('RIFF synthetic audio only'),{signal:timeout()})).fileId,214);
    assert.equal(nativeCalls.length,before+2);assert.match(requests[start+1].headers['content-type'],/^multipart\/form-data; boundary=/);assert.equal(requests[start+1].headers.authorization,'Bearer synthetic-only');
  },'Session');
  await check('consumer community refresh fetches and verifies the public signed catalog',async()=>{
    if(!communityEnvelope)return {skip:'Set AUDIT214_COMMUNITY_CACHE to a preserved public signed catalog cache for this optional fixture check.'};
    const before=nativeCalls.length,root=join(run,'community-root'),dataRoot=join(run,'community-data');
    const manager=await createPluginManager({root,dataRoot,appVersion:'2.0.14',fetchImpl:service.fetch,planDownload:service.planDownload});let community;
    try{community=await createCommunityService({root,dataRoot,legacyManager:manager,fetchImpl:service.fetch,planDownload:service.planDownload,pollMs:0});const refreshed=await community.action({action:'community-refresh',sourceId:'official'});assert.equal(refreshed.results[0].ok,true);assert.equal(refreshed.snapshot.community.configured,true);assert.ok(refreshed.snapshot.community.works>0);assert.equal(nativeCalls.length,before);}finally{if(community)await community.close();else await manager.close();}
  },'Node manual');
  await check('consumer old bootstrap release client verifies public proof and downloads the pinned installer',async()=>{
    if(!publicProof)return {skip:'Set AUDIT214_PUBLIC_PROOF and AUDIT214_PUBLIC_INSTALLER to a preserved public signed release fixture for this optional check.'};
    const before=nativeCalls.length,client=createAppReleaseClient({fetch:service.fetch,planDownload:service.planDownload}),release=await client.check('2.0.12',{signal:timeout()});
    assert.equal(release.installerSha256,publicProof.release.installerSha256);const path=await client.download(release,join(run,'bootstrap-cache'),{signal:timeout()});assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),publicProof.release.installerSha256);assert.equal(nativeCalls.length,before+1);
  },'Session discovery; Node manual proof and installer');
  await check('consumer NapCat component ensure follows 302 and verifies/extracts a pinned ZIP',async()=>{
    const before=nativeCalls.length,descriptor={version:'4.18.41',bytes:qqZip.length,expandedBytes:file.length,sha256:createHash('sha256').update(qqZip).digest('hex'),url:'https://github.com/qq-component.zip',files:[{path:'fixture.txt',bytes:file.length,sha256:createHash('sha256').update(file).digest('hex')}]};
    const component=createQqComponent({directory:join(run,'qq-component'),descriptor,network:service,fetchImpl:service.fetch}),directory=await component.ensure({signal:timeout()});assert.deepEqual(await readFile(join(directory,'fixture.txt')),file);assert.equal(nativeCalls.length,before);
  },'Node manual');
  await check('consumer voice downloadVoiceAsset verifies the downloaded component bytes',async()=>{
    const before=nativeCalls.length,target=join(run,'voice-consumer.bin');await downloadVoiceAsset({url:'https://huggingface.co/redirect',bytes:payload.length,sha256:digest},target,{fetchImpl:service.fetch,planDownload:service.planDownload,signal:timeout(),retries:0});assert.deepEqual(await readFile(target),payload);assert.equal(nativeCalls.length,before);
  },'Node manual');
  loopbackServer=track(http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push({host:req.headers.host,path:req.url,method:req.method,headers:req.headers,bytes:Buffer.concat(chunks).length});res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok","retcode":0,"data":{"user_id":214}}');
  }));
  loopbackServer.on('upgrade',(req,socket)=>{const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('data',bytes=>{if((bytes[0]&15)===8)socket.end(Buffer.from([0x88,0x02,0x03,0xe8]));});});await listen(loopbackServer);
  await check('consumer QQ social transport opens its configured loopback HTTP and WebSocket',async()=>{
    const before=nativeCalls.length,base='127.0.0.1:'+loopbackServer.address().port,accounts=createSocialAccounts({dataRoot:join(run,'qq-social'),crypto:safeStorage});let social;
    try{const account=accounts.save({pluginId:'@ai-buddy/qq-connect',accountId:'214',label:'Synthetic QQ',httpUrl:'http://'+base+'/',webSocketUrl:'ws://'+base+'/events',secret:{accessToken:'synthetic-only'}});social=createSocialTransport({dataRoot:join(run,'qq-social'),accounts,fetchImpl:service.fetch});const scope={pluginId:'fixture.qq',packageName:'@ai-buddy/qq-connect',characterId:'fixture',personaId:'fixture',lifeId:'fixture',operationId:'fixture',accountBindingId:account.accountId,bindingGeneration:account.generation};const opened=await social.open({connectionRef:account.ref,accountId:account.accountId,newEventsOnly:true},scope,{signal:timeout()});assert.equal(opened.accountId,'214');assert.equal(nativeCalls.length,before);await social.closeConnection(opened.connectionId,scope);}finally{await social?.close();accounts.close();}
  },'Node loopback HTTP; native loopback WebSocket');
  await check('consumer Bili social HTTP preserves its managed cookie and Referer',async()=>{
    const before=nativeCalls.length,start=requests.length,accounts=createSocialAccounts({dataRoot:join(run,'bili-social'),crypto:safeStorage});let social;
    try{const account=accounts.save({pluginId:'@ai-buddy/bilibili-companion',accountId:'214',label:'Synthetic Bili',secret:{cookie:'SESSDATA=synthetic-only; bili_jct=synthetic-only'}});social=createSocialTransport({dataRoot:join(run,'bili-social'),accounts,fetchImpl:service.fetch});const response=await social.request({platform:'bilibili',connectionRef:account.ref,accountId:account.accountId,url:'https://api.bilibili.com/x/web-interface/view?bvid=BVfixture',credentialBinding:{connectionRef:account.ref}},{pluginId:'fixture.bili'},{signal:timeout()});assert.equal(JSON.parse(response.body).code,0);assert.equal(requests[start].headers.cookie,'SESSDATA=synthetic-only; bili_jct=synthetic-only');assert.equal(requests[start].headers.referer,'https://www.bilibili.com/');assert.equal(nativeCalls.length,before+1);}finally{await social?.close();accounts.close();}
  },'Session');
  await check('consumer Bili media download preserves Range and Referer before intentional decode stop',async()=>{
    const before=nativeCalls.length,start=requests.length,controller=new AbortController(),stop=Error('Synthetic fixture stops after network download');
    const acquire=createBiliMedia({tools:run,tempRoot:join(run,'bili-media'),fetchImpl:service.fetch,resolveVerifiedExecutable:async()=>({executable:join(run,'never-executed.exe'),localSpeechRecognition:false}),playback:async()=>({timelength:1000,format:'mp4',durl:[{url:'https://fixture.hdslb.com/media.mp4'}]})});
    await assert.rejects(acquire({scope:{},video:{duration:1},windows:[],hasSubtitles:true,signal:controller.signal,check:()=>{if(requests.slice(start).some(row=>row.path==='/media.mp4'))controller.abort(stop);}}),error=>error===stop);
    assert.equal(requests[start].headers.range,'bytes=0-');assert.equal(requests[start].headers.referer,'https://www.bilibili.com/');assert.equal(nativeCalls.length,before+1);
  },'Session; intentionally stops before ffmpeg');
}catch(error){result.fatal=error.stack??String(error);}
finally{
  clearTimeout(deadline);for(const service of services)await service.close().catch(()=>{});for(const socket of sockets)socket.destroy();
  await Promise.all([tlsServer,proxy,loopbackServer].filter(Boolean).map(server=>new Promise(resolve=>server.close(resolve))));
  await writeFile(join(run,'result.json'),JSON.stringify(result,null,2)+'\n');app.exit(result.fatal?2:0);
}
