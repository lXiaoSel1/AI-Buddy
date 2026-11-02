import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {apply,createDshStageDiagnostics} from '../src/dsh-platform/native-bridge-host.mjs';

// Controlled Cordis/process transport; no native process, project code or model
// is run. Real-host confirmation is a separate diagnostic candidate exercise.
const CHANNEL='ai-buddy-dsh-platform-v1';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let n=0;n<30;n++){if(check())return;await tick();}assert.fail('Controlled transport did not settle');}
function installControlledBridge(config={},overrides={}){
  const sent=[],handlers=new Map(),effects=[],originalSend=Object.getOwnPropertyDescriptor(process,'send'),originalConnected=Object.getOwnPropertyDescriptor(process,'connected');
  Object.defineProperty(process,'connected',{configurable:true,value:true});
  Object.defineProperty(process,'send',{configurable:true,value:message=>{sent.push(structuredClone(message));overrides.onSend?.(message);return true;}});
  let bridge,guard;
  const ctx={
    typertGateway:{prepareInvocation:async request=>request},
    on:(event,fn)=>handlers.set(event,fn),effect:fn=>effects.push(fn()),
    provide:(name,value)=>{if(name==='buddyPluginServices')bridge=value;},
    tools:{guard:fn=>{guard=fn;},schemas:()=>[],executable:()=>true,...overrides.tools},
    pluginManager:{listBundles:async()=>[],listPlugins:async()=>[],...overrides.pluginManager},
  };
  try{apply(ctx,config);}catch(error){restore();throw error;}
  function restore(){for(const cleanup of effects.reverse())cleanup?.();for(const [key,descriptor]of [['send',originalSend],['connected',originalConnected]]){if(descriptor)Object.defineProperty(process,key,descriptor);else delete process[key];}}
  return {sent,handlers,get bridge(){return bridge;},get guard(){return guard;},restore,request(method,params={},id=randomUUID()){process.emit('message',{channel:CHANNEL,kind:'request',id,method,params});return id;}};
}

test('stage diagnostics are opt-in and whitelist only correlation and timing metadata',()=>{
  const emitted=[],id=randomUUID(),parentRequestId=randomUUID();
  assert.equal(createDshStageDiagnostics({emit:row=>emitted.push(row)}).record('tools.call',id,'rpc.sent'),false);
  const stage=createDshStageDiagnostics({enabled:true,emit:row=>emitted.push(row)});
  assert.equal(stage.record('tools.call',id,'rpc.sent',{elapsedMs:1.25,parentRequestId,token:'private',prompt:'private',url:'http://private',params:{secret:true},error:'private'}),true);
  assert.deepEqual(emitted,[{kind:'rpc-stage',method:'tools.call',requestId:id,phase:'rpc.sent',elapsedMs:1.25,parentRequestId}]);
  for(const args of [['forged.method',id,'rpc.sent'],['tools.call','not-a-uuid','rpc.sent'],['tools.call',id,'forged.phase']])assert.equal(stage.record(...args),false);
  assert.equal(stage.record('tools.call',id,'rpc.reply',{elapsedMs:NaN,parentRequestId:'bad'}),true);
  assert.deepEqual(emitted[1],{kind:'rpc-stage',method:'tools.call',requestId:id,phase:'rpc.reply'});
  assert.doesNotThrow(()=>createDshStageDiagnostics({enabled:true,emit:()=>{throw Error('sink failure');}}).record('tools.call',id,'rpc.sent'));
});

test('management stages identify a pending listPlugins without declaring a result',async()=>{
  let finishInventory;
  const inventory=new Promise(resolve=>{finishInventory=resolve;});
  const harness=installControlledBridge({stageDiagnostics:true},{pluginManager:{listBundles:async()=>[{name:'controlled'}],listPlugins:()=>inventory}});
  try{
    const id=harness.request('management.snapshot');
    await until(()=>harness.sent.some(row=>row.requestId===id&&row.phase==='pm-list-plugins.begin'));
    assert.equal(harness.sent.some(row=>row.kind==='response'&&row.id===id),false);
    assert.equal(harness.sent.some(row=>row.requestId===id&&row.phase==='pm-list-plugins.end'),false);
    assert.deepEqual(harness.sent.filter(row=>row.requestId===id).map(row=>row.phase),['rpc.received','pm-list-bundles.begin','pm-list-bundles.end','pm-list-plugins.begin']);
    finishInventory([{entryId:'actual-controlled-row'}]);
    await until(()=>harness.sent.some(row=>row.kind==='response'&&row.id===id));
    assert.deepEqual(harness.sent.find(row=>row.kind==='response'&&row.id===id).result,{bundles:[{name:'controlled'}],plugins:[{entryId:'actual-controlled-row'}]});
    assert.deepEqual(harness.sent.filter(row=>row.requestId===id).slice(-2).map(row=>row.phase),['pm-list-plugins.end','rpc.reply']);
  }finally{finishInventory([]);await tick();harness.restore();}
});

test('private runtime identity is a fresh IPC response with no plugin inventory dependency',async()=>{
  const runtimeId=randomUUID(),profileId='controlled-identity';let inventoryReads=0;
  const harness=installControlledBridge({runtimeId,profileId,stageDiagnostics:true},{pluginManager:{listBundles:()=>{inventoryReads++;throw Error('inventory must not run');},listPlugins:()=>{inventoryReads++;throw Error('inventory must not run');}}});
  try{const id=harness.request('runtime.identity');await until(()=>harness.sent.some(row=>row.kind==='response'&&row.id===id));assert.deepEqual(harness.sent.find(row=>row.kind==='response'&&row.id===id).result,{runtimeId,profileId,pid:process.pid,purpose:'ui',protocolVersion:1});assert.equal(inventoryReads,0);}finally{harness.restore();}
});

test('tool guard, body and private host roundtrip retain one request correlation',async()=>{
  let harness;
  harness=installControlledBridge({stageDiagnostics:true},{onSend:message=>{
    if(message.kind==='buddy-request')queueMicrotask(()=>process.emit('message',{channel:CHANNEL,kind:'buddy-response',id:message.id,result:{state:'controlled-ok'}}));
  },tools:{execute:async({calls,signal})=>{
    const call=calls[0],exec={callId:call.id,name:call.name,token:Symbol('native-token'),agent:undefined,signal};
    const decision=harness.guard(exec);if(decision)throw Error(decision);
    return harness.handlers.get('tools/execute')(exec,()=>harness.bridge.forCall(exec).invoke('work.host',{operation:'context',prompt:'must-not-be-logged'}));
  }}});
  try{
    const id=harness.request('tools.call',{name:'buddy_work_query',arguments:{secret:'never log'},admission:{pluginId:'controlled-plugin',contextToken:'private-context',allowedNames:['buddy_work_query'],readOnlyToolNames:['buddy_work_query'],planState:'planning'}});
    await until(()=>harness.sent.some(row=>row.kind==='response'&&row.id===id));
    assert.deepEqual(harness.sent.find(row=>row.kind==='response'&&row.id===id).result,{state:'controlled-ok'});
    const phases=harness.sent.filter(row=>row.requestId===id).map(row=>row.phase);
    assert.deepEqual(phases,['rpc.received','native-scope.begin','native-scope.end','tools-execute.begin','tool-guard.begin','tool-guard.end','tool-body.begin','tool-body.end','tools-execute.end','rpc.reply']);
    const nested=harness.sent.filter(row=>row.kind==='rpc-stage'&&row.method==='buddy.invoke');
    assert.deepEqual(nested.map(row=>row.phase),['buddy.sent','buddy.reply']);
    assert.equal(nested.every(row=>row.parentRequestId===id),true);
    assert.equal(new Set(nested.map(row=>row.requestId)).size,1);
    const diagnosticText=JSON.stringify(harness.sent.filter(row=>row.kind==='rpc-stage'));
    for(const secret of ['private-context','must-not-be-logged','never log','controlled-plugin'])assert.equal(diagnosticText.includes(secret),false);
    assert.equal(harness.guard({callId:'ordinary-native-call',name:'buddy_work_query'}),'DSH_HOST_TOOL_ADMISSION_REQUIRED');
  }finally{harness.restore();}
});

test('default bridge keeps diagnostic traffic off and errors retain native failure',async()=>{
  const harness=installControlledBridge({}, {pluginManager:{listPlugins:async()=>{throw Object.assign(Error('controlled failure'),{code:'CONTROLLED_FAILURE'});}}});
  try{
    const id=harness.request('management.snapshot');
    await until(()=>harness.sent.some(row=>row.kind==='response'&&row.id===id));
    assert.equal(harness.sent.some(row=>row.kind==='rpc-stage'),false);
    assert.equal(harness.sent.find(row=>row.kind==='response'&&row.id===id).error.code,'CONTROLLED_FAILURE');
  }finally{harness.restore();}
});
