import {app,session} from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createNetworkService} from '../../src/network-service.mjs';
import {ApiTransport} from '../../src/api-transport.mjs';

const run=process.env.ROUND2_NETWORK_RUN,result={electron:process.versions.electron,node:process.versions.node,checks:[],proxyHits:[],requests:[],resolved:[]},sockets=new Set();let service,origin,proxy,refuse=false,unsupported=false;
const watchdog=setTimeout(()=>app.exit(3),30000);
function track(server){server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});return server;}
const listen=(server,host)=>new Promise(resolve=>server.listen(0,host,resolve));
async function check(name,work){try{await work();result.checks.push({name,ok:true});}catch(error){result.checks.push({name,ok:false,error:error.stack??String(error)});}}
try{
  const key=await readFile(join(run,'fixture-key.pem')),cert=await readFile(join(run,'fixture-cert.pem'));
  origin=track(https.createServer({key,cert},async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;result.requests.push({path:req.url,method:req.method,body:JSON.parse(body)});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'local PAC success'},finish_reason:'stop'}]}));}));await listen(origin,'127.0.0.2');
  proxy=track(http.createServer((_req,res)=>{res.writeHead(400);res.end();}));
  proxy.on('connect',(req,client,head)=>{
    result.proxyHits.push({authority:req.url,refused:refuse});
    if(refuse){client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');return;}
    const upstream=net.connect(origin.address().port,'127.0.0.2',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});
    sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));upstream.once('error',()=>client.destroy());client.once('close',()=>upstream.destroy());
  });await listen(proxy,'127.0.0.1');
  const pac=`PROXY 127.0.0.1:${proxy.address().port}; SOCKS5 127.0.0.1:${proxy.address().port}; DIRECT;`;
  service=await createNetworkService({session,dataRoot:join(run,'network-data'),userAgent:'AI-Buddy/2.0.14-round2-fixture',resolveSystemProxy:async url=>{result.resolved.push({url,pac:unsupported?'SOCKS5 127.0.0.1:1080':pac});return unsupported?'SOCKS5 127.0.0.1:1080':pac;}});
  const api=new ApiTransport({fetchImpl:service.fetch}),profile={id:'synthetic',kind:'custom',protocol:'chat-completions',baseUrl:`https://127.0.0.2:${origin.address().port}/v1`,model:'stub',key:''};
  async function request(){let text='';for await(const event of api.stream(profile,{messages:[{role:'user',content:'synthetic local fixture'}]}))if(event.type==='text-delta')text+=event.text;assert.equal(text,'local PAC success');}
  await check('mixed PAC resolves through the first HTTP CONNECT route',async()=>{await request();assert.equal(result.proxyHits.length,1);assert.equal(result.requests.length,1);assert.equal(result.proxyHits[0].authority,'127.0.0.2:'+origin.address().port);assert.equal(result.proxyHits[0].refused,false);});
  await check('rejected HTTP CONNECT falls through skipped SOCKS5 to DIRECT without duplicating the model submission',async()=>{refuse=true;await request();assert.equal(result.proxyHits.length,2);assert.equal(result.proxyHits[1].refused,true);assert.equal(result.requests.length,2);});
  await check('unsupported-only system PAC keeps the SOCKS-specific error through ApiTransport',async()=>{unsupported=true;await assert.rejects(request(),error=>error.code==='NETWORK_PROXY_UNSUPPORTED'&&error.message.includes('SOCKS'));assert.equal(result.requests.length,2);assert.equal(result.resolved.length,3);});
}catch(error){result.fatal=error.stack??String(error);}
finally{
  await service?.close();for(const socket of sockets)socket.destroy();await Promise.all([origin,proxy].filter(Boolean).map(server=>new Promise(resolve=>server.close(resolve))));clearTimeout(watchdog);await writeFile(join(run,'result.json'),JSON.stringify(result,null,2)+'\n');app.exit(result.fatal||result.checks.some(row=>!row.ok)?1:0);
}
