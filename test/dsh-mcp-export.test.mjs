import test from 'node:test';
import assert from 'node:assert/strict';
import {createDshMcpExport} from '../src/dsh-platform/mcp-export.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {request as httpRequest} from 'node:http';
// Real loopback HTTP, simulated backend/tools. No DSH process, engine or model.

test('MCP HTTP authenticates, discovers without inference and revokes stale tool handles',async t=>{
  let enabled=true,calls=0;const backend={async listTools(){return enabled?[{name:'echo',inputSchema:{type:'object'}}]:[];},async callTool(call,context){calls++;assert.equal(context.pluginId,'probe');return {echo:call.arguments.text};}};
  const host=await createDshMcpExport({bindings:[{backend,pluginId:'probe',packageName:'dsh-native-probe',sourceId:'test-only',contextToken:'scoped-test-token'}]});t.after(()=>host.close());
  assert.equal((await fetch(host.url,{method:'POST',body:'{}'})).status,401);
  const request=async(method,params,id=1,extra={})=>{const response=await fetch(host.url,{method:'POST',headers:{...host.headers,'Content-Type':'application/json',...(method!=='initialize'?{'Mcp-Session-Id':host.sessionId}:{}),...extra},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});return {response,body:await response.json()};};
  assert.equal((await request('initialize',{protocolVersion:'2025-06-18'})).body.result.protocolVersion,'2025-06-18');
  const list=await request('tools/list',{},2);assert.equal(calls,0);assert.equal(list.body.result.tools.length,1);const name=list.body.result.tools[0].name;
  assert.equal((await request('tools/call',{name,arguments:{text:'actual transport'}},3)).body.result.structuredContent.echo,'actual transport');assert.equal(calls,1);
  enabled=false;assert.equal((await request('tools/call',{name,arguments:{}},4)).body.error.code,-32602);assert.equal(calls,1);
  assert.equal((await request('tools/list',{},5,{Origin:'http://evil.example'})).response.status,403);assert.equal(JSON.stringify(host.snapshot()).includes('scoped-test-token'),false);
});

async function rpc(host,method,params={},id=1){const response=await fetch(host.url,{method:'POST',headers:{...host.headers,'Content-Type':'application/json',...(method==='initialize'?{}:{'Mcp-Session-Id':host.sessionId})},body:JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params})});const text=await response.text();return {response,body:text?JSON.parse(text):null};}

test('unit/sim: MCP rejects rebinding Host, any browser Origin, wrong endpoint and non-JSON content',async t=>{
  const backend={listTools:async()=>[],callTool:async()=>{throw Error('must not call');}},host=await createDshMcpExport({bindings:[{backend,pluginId:'p',contextToken:'scope-secret'}]});t.after(()=>host.close());
  const forged=await new Promise((resolve,reject)=>{const request=httpRequest(host.url,{method:'POST',headers:{...host.headers,Host:'evil.invalid','Content-Type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}}));});assert.equal(forged,403);
  assert.equal((await fetch(host.url,{method:'POST',headers:{...host.headers,Origin:'null','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(host.url,{method:'POST',headers:host.headers,body:'{}'})).status,415);
  assert.equal((await fetch(host.url+'/other',{method:'DELETE',headers:{...host.headers,'Mcp-Session-Id':host.sessionId}})).status,404);
});

test('unit/sim: cancellation reaches native request signal and an ignored abort cannot become success',async t=>{
  let entered,finish,observedSignal;const started=new Promise(r=>{entered=r;}),done=new Promise(r=>{finish=r;});const backend={listTools:async()=>[{name:'slow'}],callTool:async request=>{observedSignal=request.signal;entered();await done;return {incorrectly:'completed after abort'};}};
  const host=await createDshMcpExport({bindings:[{backend,pluginId:'p',contextToken:'scope-secret'}]});t.after(()=>host.close());await rpc(host,'initialize');const name=(await rpc(host,'tools/list')).body.result.tools[0].name;
  const call=rpc(host,'tools/call',{name,arguments:{}},44);await started;assert.equal((await rpc(host,'notifications/cancelled',{requestId:44},null)).response.status,202);assert.equal(observedSignal.aborted,true);finish();const result=(await call).body.result;assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'MCP_CANCELLED');assert.equal(host.snapshot().activeCalls,0);
});

test('unit/sim: cancellation during discovery prevents tool startup and expired context is denied',async t=>{
  let clock=1,slow=false,entered,finish,calls=0;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{finish=r;}),services=createBuddyPluginServices({now:()=>clock,resolveContext:async spec=>({...spec,lifeId:'life',operationId:'op',contextRevision:1})});services.grants.set({pluginId:'p',declared:['tools.list','tools.invoke'],granted:['tools.list','tools.invoke']});
  const token=await services.issueContext({pluginId:'p',characterId:'a',personaId:'u',sessionId:'s',permissionScope:['tools.list','tools.invoke'],connectionRefs:[],ttlMs:10});
  const backend={async listTools(context){await services.authorize({...context,capability:'tools.list'});if(slow){entered();await blocked;}return [{name:'native'}];},async callTool(_request,context){await services.authorize({...context,capability:'tools.invoke'});calls++;return {ok:true};}};
  const host=await createDshMcpExport({bindings:[{backend,pluginId:'p',contextToken:token.contextToken}]});t.after(async()=>{await host.close();await services.close();});await rpc(host,'initialize');const name=(await rpc(host,'tools/list')).body.result.tools[0].name;slow=true;
  const call=rpc(host,'tools/call',{name},55);await started;await rpc(host,'notifications/cancelled',{requestId:55},null);finish();assert.equal((await call).body.result.isError,true);assert.equal(calls,0);
  slow=false;clock=20;const denied=await rpc(host,'tools/list');assert.equal(denied.body.error.code,-32000);assert.match(denied.body.error.message,/expired/);assert.equal(calls,0);
});
