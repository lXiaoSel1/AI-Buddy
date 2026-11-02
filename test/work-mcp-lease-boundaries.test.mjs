import test from 'node:test';
import assert from 'node:assert/strict';
import {createDshMcpExport,dshMcpDescriptor,dshMcpToolId,dshMcpSchemaHash,dshMcpSchemaDigest} from '../src/dsh-platform/mcp-export.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
// Actual loopback HTTP + actual host context authority; native tool transport is controlled.
// No DSH process, project code or model runs in this focused suite.
const rpc=async(host,method,params={},id=1)=>{const response=await fetch(host.url,{method:'POST',headers:{...host.headers,'Content-Type':'application/json',...(method==='initialize'?{}:{'Mcp-Session-Id':host.sessionId})},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});return response.json();};
function frozen(binding,tools){const descriptors=tools.map(tool=>dshMcpDescriptor(binding,tool)).filter(Boolean);return {...binding,allowedToolIds:descriptors.map(row=>row.name),schemaHashes:Object.fromEntries(descriptors.map(row=>[row.name,dshMcpSchemaHash(row)])),schemaDigest:dshMcpSchemaDigest(descriptors)};}
const makeTool=(name='echo')=>({name,description:'Actual controlled tool schema',inputSchema:{type:'object',properties:{text:{type:'string'}},additionalProperties:false}});

test('dynamic MCP refreshes real expiring host contexts without model requests or token disclosure',async t=>{
  let clock=1,minted=0,calls=0;const observed=[],audit=[],services=createBuddyPluginServices({now:()=>clock,resolveContext:async spec=>({...spec,lifeId:'life-a',operationId:'operation-a',contextRevision:1})});
  services.grants.set({pluginId:'p',declared:['tools.list','tools.invoke'],granted:['tools.list','tools.invoke']});const tool=makeTool();
  const backend={async listTools(context){await services.authorize({...context,capability:'tools.list'});observed.push(context.contextToken);return [tool];},async callTool(_request,context){await services.authorize({...context,capability:'tools.invoke'});calls++;observed.push(context.contextToken);return {echo:'safe',accidentalToken:context.contextToken};}};
  const base={backend,pluginId:'p',sourceId:'source-a',packageName:'package-a',beforeCall:async()=>{},releaseContext:issued=>services.authority.revoke(issued.contextToken),resolveContext:async()=>{minted++;return services.issueContext({pluginId:'p',characterId:'a',personaId:'u',sessionId:'s',permissionScope:['tools.list','tools.invoke'],connectionRefs:[],ttlMs:10});}};
  const host=await createDshMcpExport({bindings:[frozen(base,[tool])],onAudit:event=>audit.push(event)});t.after(async()=>{await host.close();await services.close();});await rpc(host,'initialize');const listed=await rpc(host,'tools/list');assert.equal(calls,0);clock=100;
  const result=await rpc(host,'tools/call',{name:listed.result.tools[0].name,arguments:{text:'real HTTP'}});assert.equal(result.result.structuredContent.echo,'safe');assert.equal(result.result.structuredContent.accidentalToken,'[redacted]');assert.equal(minted,3);assert.equal(new Set(observed).size,3);
  const publicText=JSON.stringify({result,audit,snapshot:host.snapshot()});for(const token of observed)assert.equal(publicText.includes(token),false);assert.equal(calls,1);assert.equal(services.authority.size(),0);
});

test('frozen schemas exclude additions and all reserved controls; mutation and removal deny native startup',async t=>{
  const tool=makeTool();let available=[tool],calls=0;const base={pluginId:'p',sourceId:'s',packageName:'pkg',resolveContext:async()=>({pluginId:'p',contextToken:'private-context'}),beforeCall:async()=>{},backend:{listTools:async()=>available,callTool:async()=>{calls++;return {};}}};
  const host=await createDshMcpExport({bindings:[frozen(base,[tool])]});t.after(()=>host.close());await rpc(host,'initialize');const name=(await rpc(host,'tools/list')).result.tools[0].name;
  available=[tool,makeTool('new-tool'),...['buddy_work_query','buddy_work_plan','buddy_work_run','buddy_work_control'].map(name=>makeTool(name))];assert.deepEqual((await rpc(host,'tools/list')).result.tools.map(row=>row.name),[name]);
  available=[{...tool,inputSchema:{type:'string'}}];let denied=await rpc(host,'tools/call',{name});assert.equal(JSON.parse(denied.result.content[0].text).code,'MCP_SCHEMA_CHANGED');assert.equal(calls,0);
  available=[];denied=await rpc(host,'tools/call',{name});assert.equal(JSON.parse(denied.result.content[0].text).code,'MCP_TOOL_REVOKED');assert.equal(calls,0);
});

test('dynamic MCP bindings require frozen authority and reject context identity substitution',async()=>{
  const tool=makeTool(),base={pluginId:'p',backend:{listTools:async()=>[tool],callTool:async()=>assert.fail('must not invoke')},resolveContext:async()=>({pluginId:'other',contextToken:'not-my-context'}),beforeCall:async()=>{}};
  await assert.rejects(createDshMcpExport({bindings:[base]}),/frozen IDs/);const host=await createDshMcpExport({bindings:[frozen(base,[tool])]});try{await rpc(host,'initialize');assert.match((await rpc(host,'tools/list')).error.message,/mismatched/);}finally{await host.close();}
});

test('two host-only leases retain exact source and context identity',async t=>{
  const contexts=[],hosts=[];for(const scope of ['alice','bob']){const tool=makeTool(),base={pluginId:'p-'+scope,sourceId:'s-'+scope,packageName:'pkg',resolveContext:async()=>({pluginId:'p-'+scope,contextToken:'context-'+scope}),beforeCall:async()=>{},backend:{listTools:async()=>[tool],callTool:async(_call,context)=>{contexts.push(context);return {scope};}}};hosts.push(await createDshMcpExport({bindings:[frozen(base,[tool])]}));}t.after(()=>Promise.all(hosts.map(host=>host.close())));
  for(const host of hosts)await rpc(host,'initialize');const names=await Promise.all(hosts.map(async host=>(await rpc(host,'tools/list')).result.tools[0].name));assert.notEqual(names[0],names[1]);assert.equal((await rpc(hosts[0],'tools/call',{name:names[1]})).error.code,-32602);assert.equal(contexts.length,0);
  await Promise.all(hosts.map((host,index)=>rpc(host,'tools/call',{name:names[index]})));assert.deepEqual(contexts.map(row=>row.pluginId).sort(),['p-alice','p-bob']);assert.deepEqual(contexts.map(row=>row.contextToken).sort(),['context-alice','context-bob']);
});

test('lease close aborts then waits for actual native promise drain instead of claiming stop early',async()=>{
  let enter,finish,signal;const entered=new Promise(resolve=>{enter=resolve;}),drain=new Promise(resolve=>{finish=resolve;}),tool=makeTool();const base={pluginId:'p',resolveContext:async()=>({pluginId:'p',contextToken:'private-context'}),beforeCall:async()=>{},backend:{listTools:async()=>[tool],callTool:async call=>{signal=call.signal;enter();await drain;return {unsafe:'late success'};}}};
  const host=await createDshMcpExport({bindings:[frozen(base,[tool])]});await rpc(host,'initialize');const name=(await rpc(host,'tools/list')).result.tools[0].name,call=rpc(host,'tools/call',{name},22);await entered;
  let closed=false;const closing=host.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(signal.aborted,true);assert.equal(closed,false);assert.equal(host.snapshot().activeCalls,1);finish();const result=await call;await closing;assert.equal(JSON.parse(result.result.content[0].text).code,'MCP_CANCELLED');assert.equal(host.snapshot().activeCalls,0);assert.equal(closed,true);
});

test('removed tools revoke another pending native call and authority is rechecked after return',async t=>{
  let available=[makeTool()],allowed=true,enter,finish,signal,calls=0;const entered=new Promise(resolve=>{enter=resolve;}),drain=new Promise(resolve=>{finish=resolve;}),base={pluginId:'p',resolveContext:async()=>({pluginId:'p',contextToken:'private-context'}),beforeCall:async()=>{if(!allowed)throw Object.assign(Error('Lifecycle revoked'),{code:'WORK_SCOPE_STALE'});},backend:{listTools:async()=>available,callTool:async request=>{calls++;signal=request.signal;enter();await drain;return {late:true};}}};
  const host=await createDshMcpExport({bindings:[frozen(base,available)]});t.after(()=>host.close());await rpc(host,'initialize');const name=(await rpc(host,'tools/list')).result.tools[0].name,call=rpc(host,'tools/call',{name},77);await entered;available=[];assert.match((await rpc(host,'tools/list',{},78)).error.message,/removed/);assert.equal(signal.aborted,true);finish();assert.equal(JSON.parse((await call).result.content[0].text).code,'MCP_CANCELLED');allowed=false;assert.match((await rpc(host,'tools/list',{},79)).error.message,/Lifecycle revoked/);assert.equal(calls,1);
});

test('schema helpers are stable under object key order and reserved tool IDs never become descriptors',()=>{
  const binding={pluginId:'p',sourceId:'s'};assert.equal(dshMcpToolId(binding,'echo'),dshMcpDescriptor(binding,makeTool()).name);assert.equal(dshMcpSchemaHash({name:'n',inputSchema:{type:'object',properties:{b:{},a:{}}}}),dshMcpSchemaHash({inputSchema:{properties:{a:{},b:{}},type:'object'},name:'n'}));assert.equal(dshMcpDescriptor(binding,{name:'buddy_work_run'}),null);
});
