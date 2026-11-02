import test from 'node:test';
import assert from 'node:assert/strict';
import {dshRemoteActionDecision,installDshHostUiPolicy,normalizeDshUiPolicy} from '../src/dsh-platform/native-bridge-host.mjs';

// Policy boundary tests use controller doubles. Real HTTP/WS evidence is
// collected separately against the pinned native runtime.
test('host-mediated policy cannot be disabled or bypassed by owner principal',async()=>{
  assert.deepEqual(normalizeDshUiPolicy(),{mode:'host-mediated',version:1});
  assert.throws(()=>normalizeDshUiPolicy({mode:'unrestricted'}),/DSH_UI_POLICY_REQUIRED/);
  let dispatched=0;const handlers=new Map(),effects=[],denied=[];
  const gateway={prepareInvocation:async function(request){dispatched++;return request;}};
  const original=gateway.prepareInvocation;
  const ctx={typertGateway:gateway,effect:fn=>effects.push(fn()),on:(event,fn)=>handlers.set(event,fn)};
  const pendingAgentIds=new Set(['actual-private-id']);
  installDshHostUiPolicy(ctx,{pendingAgentIds,onDenied:e=>denied.push(e)});
  for(const action of ['session/create','session/prompt','session/fork','terminal/create','terminal/attach','directoryPicker/createDirectory','dynamicCordisRunner/runHostHalf','dynamicCordisRunner/invoke','commands/execute','subagents/prompt','pluginManager/installBundle','pluginManager/setPluginEnabled','settings/update','credentials/set','account/startSignIn','workspaceFiles/read','fileUploads/upload']){
    const [namespace,method]=action.split('/');
    await assert.rejects(gateway.prepareInvocation({namespace,method,peer:{principal:{kind:'owner'}}}),{code:'DSH_HOST_REMOTE_ADMISSION_REQUIRED'});
  }
  assert.equal(dispatched,0);assert.equal(denied.length,17);
  await gateway.prepareInvocation({namespace:'pluginManager',method:'listBundles'});
  await gateway.prepareInvocation({namespace:'ordinaryNativePlugin',method:'originalPageMethod'});
  assert.equal(dispatched,2);
  handlers.get('agent/created')({agent:{id:'actual-private-id'}});
  assert.equal(pendingAgentIds.size,0);
  assert.throws(()=>handlers.get('agent/created')({agent:{id:'actual-private-id'}}),/DSH_HOST_AGENT_ADMISSION_REQUIRED/);
  assert.throws(()=>handlers.get('agent/created')({agent:{id:'buddy-tools-forged-prefix'}}),/DSH_HOST_AGENT_ADMISSION_REQUIRED/);
  await assert.rejects(async()=>{for await(const _ of handlers.get('llm/stream')({provider:'forged'},()=>{throw Error('provider must never run');})){}},/DSH_HOST_MODEL_ADMISSION_REQUIRED/);
  effects[0]();assert.equal(gateway.prepareInvocation,original);
});
test('only exact audited official read actions are allowed; no name heuristic',()=>{
  for(const action of ['session/list','session/page','session/control','settings/describe','credentials/describe','pluginInventory/list','pluginManager/listPlugins','terminal/list','remoteAccess/follow'])assert.equal(dshRemoteActionDecision(...action.split('/')),undefined);
  for(const action of ['terminal/readAndExecute','pluginManager/listThenInstall','session/readAndPrompt','credentials/readSecret'])assert.equal(dshRemoteActionDecision(...action.split('/')),'DSH_HOST_REMOTE_ADMISSION_REQUIRED');
  assert.equal(dshRemoteActionDecision('../terminal','create'),'DSH_HOST_REMOTE_DENIED');
});
test('pinned gateway seam absence is an explicit startup failure',()=>{
  assert.throws(()=>installDshHostUiPolicy({typertGateway:{}},{pendingAgentIds:new Set()}),/DSH_HOST_GATEWAY_SEAM_UNAVAILABLE/);
});
test('welcome acknowledgement permits only the exact public pure UI mutation',()=>{
 const args={ns:'ui-settings-general',ops:[{op:'set',path:['welcomeNoticeVersion'],value:'2026-09-28.1'}],expectedRevision:0};
 assert.equal(dshRemoteActionDecision('settings','mutate',args),undefined);
 for(const changed of [{...args,ns:'llm-deepseek'},{...args,ops:[...args.ops,{op:'set',path:['apiKey'],value:'forged'}]},{...args,ops:[{...args.ops[0],path:['model']}]},{...args,ops:[{...args.ops[0],value:'forged'}]},{...args,unexpected:'extra'}])assert.equal(dshRemoteActionDecision('settings','mutate',changed),'DSH_HOST_REMOTE_ADMISSION_REQUIRED');
});
