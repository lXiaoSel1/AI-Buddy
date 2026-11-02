import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';

const reserved=new Set(['buddy_work_query','buddy_work_plan','buddy_work_run','buddy_work_control']);
const failure=(message,code)=>Object.assign(Error(message),{code});
const sort=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(sort):Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,sort(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
export const dshMcpToolId=(binding,name)=>'buddy_'+createHash('sha256').update([binding.sourceId,'dsh',binding.packageName??binding.pluginId,name].join('\0')).digest('hex').slice(0,32);
export function dshMcpDescriptor(binding,tool){
  const name=tool?.name??tool?.function?.name;if(typeof name!=='string'||!name||reserved.has(name))return null;
  return {name:dshMcpToolId(binding,name),title:tool.title??name,description:tool.description??tool.function?.description??'',inputSchema:tool.inputSchema??tool.parameters??tool.function?.parameters??{type:'object',properties:{}},...(tool.outputSchema?{outputSchema:tool.outputSchema}:{})};
}
export const dshMcpSchemaHash=descriptor=>hash(descriptor);
export const dshMcpSchemaDigest=descriptors=>hash(descriptors.map(descriptor=>({toolId:descriptor.name,schemaHash:dshMcpSchemaHash(descriptor)})).sort((a,b)=>a.toolId.localeCompare(b.toolId)));
function redact(value,secrets){
  if(typeof value==='string'){let clean=value.replace(/([?&#](?:token|access_token|auth)=)[^&\s]+/gi,'$1[redacted]');for(const secret of secrets)if(typeof secret==='string'&&secret.length>=6)clean=clean.split(secret).join('[redacted]');return clean;}
  if(Array.isArray(value))return value.map(item=>redact(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redact(item,secrets)]));
  return value;
}
const safeError=(error,secrets)=>({code:/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code??'')?error.code:'TOOL_FAILED',message:redact(String(error.message??'Tool failed'),secrets).slice(0,2000)});
/** Real loopback MCP transport. Dynamic bindings carry host-only authority closures. */
export async function createDshMcpExport({bindings,host='127.0.0.1',port=0,onAudit=()=>{}}={}){
  if(host!=='127.0.0.1'||!Array.isArray(bindings)||bindings.some(b=>!b.backend?.listTools||!b.backend?.callTool||!b.pluginId||(!b.contextToken&&typeof b.resolveContext!=='function')))throw TypeError('Trusted scoped tool bindings are required');
  bindings=bindings.map(binding=>{
    const dynamic=typeof binding.resolveContext==='function';
    if(dynamic&&(!Array.isArray(binding.allowedToolIds)||binding.allowedToolIds.some(id=>typeof id!=='string'||!id)||new Set(binding.allowedToolIds).size!==binding.allowedToolIds.length||!/^[a-f0-9]{64}$/.test(binding.schemaDigest??'')||typeof binding.beforeCall!=='function'))throw TypeError('Dynamic tool bindings require frozen IDs, schema digest and authority guard');
    return Object.freeze({...binding,dynamic,allowedToolIds:dynamic?Object.freeze([...binding.allowedToolIds]):null,schemaHashes:binding.schemaHashes?Object.freeze({...binding.schemaHashes}):null});
  });
  const bearer=randomBytes(32).toString('base64url'),sessionId=randomBytes(24).toString('base64url'),running=new Map(),operations=new Set(),secrets=new Set([bearer,...bindings.map(b=>b.contextToken).filter(Boolean)]);
  let tools=new Map(),closed=false,initialized=false,expectedHost=null,closePromise;
  function check(signal){if(closed||signal?.aborted)throw failure('Tool call cancelled','MCP_CANCELLED');}
  async function guard(binding,stage,signal,toolId){check(signal);if(binding.beforeCall)await binding.beforeCall({stage,toolId,signal});check(signal);}
  async function withContext(binding,signal,operation,stage='list'){
    let issued;
    try{check(signal);issued=binding.dynamic?await binding.resolveContext({signal,stage}):{pluginId:binding.pluginId,contextToken:binding.contextToken};if(typeof issued?.contextToken==='string')secrets.add(issued.contextToken);check(signal);
      if(!issued||issued.pluginId!==binding.pluginId||typeof issued.contextToken!=='string'||!issued.contextToken)throw failure('Host tool context is unavailable or mismatched','MCP_CONTEXT_DENIED');
      return await operation({pluginId:binding.pluginId,contextToken:issued.contextToken,signal});
    }finally{if(issued&&binding.dynamic&&typeof binding.releaseContext==='function')await binding.releaseContext(issued);}
  }
  function revoke(binding,error){for(const row of running.values())if(row.binding===binding)row.controller.abort();for(const[id,row]of tools)if(row.binding===binding)tools.delete(id);try{Promise.resolve(binding.onRevoke?.({code:error?.code??'MCP_BINDING_REVOKED'})).catch(()=>{});}catch{}}
  async function discover(signal){
    const next=new Map();
    for(const binding of bindings){
      try{
        await guard(binding,'list',signal);const raw=await withContext(binding,signal,scoped=>binding.backend.listTools(scoped));check(signal);
        const values=Array.isArray(raw)?raw:raw?.tools??raw?.schemas??[],admitted=[];
        for(const tool of values){const descriptor=dshMcpDescriptor(binding,tool);if(!descriptor||binding.dynamic&&!binding.allowedToolIds.includes(descriptor.name))continue;
          if(next.has(descriptor.name))throw failure('Duplicate scoped tool identity','MCP_TOOL_COLLISION');
          if(binding.schemaHashes?.[descriptor.name]&&binding.schemaHashes[descriptor.name]!==dshMcpSchemaHash(descriptor))throw failure('Approved tool schema changed','MCP_SCHEMA_CHANGED');
          admitted.push(descriptor);next.set(descriptor.name,{binding,nativeName:tool.name??tool.function?.name,descriptor});
        }
        if(binding.dynamic){
          if(admitted.length!==binding.allowedToolIds.length)throw failure('An approved tool was removed or disabled','MCP_TOOL_REVOKED');
          if(dshMcpSchemaDigest(admitted)!==binding.schemaDigest)throw failure('Approved tool schemas changed','MCP_SCHEMA_CHANGED');
        }
      }catch(error){revoke(binding,error);throw error;}
    }
    check(signal);tools=next;return [...next.values()].map(row=>row.descriptor);
  }
  function operation(){const controller=new AbortController();let resolve;const done=new Promise(r=>{resolve=r;});const row={controller,done};operations.add(row);return {...row,finish(){operations.delete(row);resolve();}};}
  const server=createServer(async(req,res)=>{
    const json=(status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','Mcp-Session-Id':sessionId,'cache-control':'no-store'});res.end(value===null?'':JSON.stringify(value));};
    if(closed)return json(503,{error:'closed'});
    if(req.headers.host!==expectedHost)return json(403,{error:'invalid-host'});
    if(req.headers.authorization!=='Bearer '+bearer)return json(401,{error:'unauthorized'});
    if(req.headers.origin!==undefined)return json(403,{error:'browser-origin-not-allowed'});
    if(req.url!=='/mcp')return json(404,{error:'unknown-endpoint'});
    if(req.method==='DELETE'){if(req.headers['mcp-session-id']!==sessionId)return json(400,{error:'invalid-session'});for(const row of operations)row.controller.abort();initialized=false;return json(200,{closed:true});}
    if(req.method!=='POST')return json(405,{error:'method-not-allowed'});
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return json(415,{error:'json-content-type-required'});
    let message;
    try{const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)throw Error('Request too large');chunks.push(chunk);}message=JSON.parse(Buffer.concat(chunks).toString());if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')throw Error('Invalid MCP request');}catch{return json(400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC request'}});}
    const reply=result=>json(200,{jsonrpc:'2.0',id:message.id??null,result:redact(result,secrets)}),reject=(code,text)=>json(200,{jsonrpc:'2.0',id:message.id??null,error:{code,message:redact(text,secrets)}});
    if(message.method==='initialize'){initialized=true;return reply({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'AI Buddy scoped DSH tools',version:'1.0.0'}});}
    if(!initialized||req.headers['mcp-session-id']!==sessionId)return reject(-32001,'Initialize this scoped MCP session first');
    if(message.method==='notifications/initialized')return json(202,null);
    if(message.method==='notifications/cancelled'){running.get(message.params?.requestId)?.controller.abort();return json(202,null);}
    if(message.method==='ping')return reply({});
    let active;
    try{
      if(message.method==='tools/list'){active=operation();return reply({tools:await discover(active.controller.signal)});}
      if(message.method==='tools/call'){
        if(!['string','number'].includes(typeof message.id)||typeof message.id==='number'&&!Number.isFinite(message.id)||typeof message.id==='string'&&message.id.length>300)return reject(-32600,'Tool calls require a stable request ID');
        if(running.has(message.id))return reject(-32600,'Duplicate in-flight request ID');active=operation();const {controller}=active;running.set(message.id,{controller,binding:null});
        const abortOnDisconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',abortOnDisconnect);
        try{
          await discover(controller.signal);check(controller.signal);const row=tools.get(message.params?.name);if(!row)return reject(-32602,'Tool is unavailable in this session');
          running.get(message.id).binding=row.binding;await guard(row.binding,'call',controller.signal,message.params.name);
          onAudit({type:'tool-start',requestId:message.id,toolId:message.params.name});
          const raw=await withContext(row.binding,controller.signal,scoped=>row.binding.backend.callTool({name:row.nativeName,arguments:message.params.arguments??{},signal:controller.signal},scoped),'call');
          await guard(row.binding,'result',controller.signal,message.params.name);onAudit({type:'tool-finished',requestId:message.id,toolId:message.params.name});
          if(raw&&Array.isArray(raw.content))return reply(raw);return reply({content:[{type:'text',text:JSON.stringify(redact(raw??null,secrets))}],...(raw&&typeof raw==='object'&&!Array.isArray(raw)?{structuredContent:raw}:{})});
        }catch(error){const value=safeError(error,secrets);onAudit({type:'tool-failed',requestId:message.id,error:value});return reply({isError:true,content:[{type:'text',text:JSON.stringify(value)}]});}
        finally{running.delete(message.id);res.removeListener('close',abortOnDisconnect);}
      }
      return reject(-32601,'Method not found');
    }catch(error){return reject(-32000,safeError(error,secrets).message);}
    finally{active?.finish();}
  });
  server.requestTimeout=0;server.headersTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});expectedHost=`${host}:${server.address().port}`;
  return {url:`http://${expectedHost}/mcp`,headers:{Authorization:'Bearer '+bearer},sessionId,
    snapshot:()=>({state:closed?'closed':'listening',transport:'streamable-http',listChanged:false,scopeCount:bindings.length,activeCalls:running.size}),
    close(){if(closePromise)return closePromise;closed=true;for(const row of operations)row.controller.abort();const stopped=new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();closePromise=(async()=>{await Promise.all([...operations].map(row=>row.done));await stopped;})();return closePromise;}};
}
