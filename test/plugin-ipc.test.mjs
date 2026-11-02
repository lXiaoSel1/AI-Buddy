import test from 'node:test';
import assert from 'node:assert/strict';
import {pluginActionResult} from '../src/plugin-ipc.mjs';

test('extension IPC preserves source error identity through JSON without forwarding privileged error fields', async () => {
  let calls = 0;
  const service = {async action() {calls++; throw Object.assign(Error('The publisher key changed'), {code:'PLUGIN_SOURCE_KEY_CHANGED',details:{sourceId:'source-a',actualFingerprint:'SHA256:public',requiresConfirmation:true,authorization:'Bearer private-credential',env:{SECRET:'private'}},stack:'private stack'});}};
  const wire = JSON.parse(JSON.stringify(await pluginActionResult(service,{action:'sources-preview',url:'https://example.invalid/source.json'})));
  assert.equal(wire.error.code,'PLUGIN_SOURCE_KEY_CHANGED');assert.equal(wire.error.details.requiresConfirmation,true);assert.equal(wire.error.details.actualFingerprint,'SHA256:public');
  assert.equal(calls,1);assert(!JSON.stringify(wire).includes('private'));
});
test('extension IPC returns service availability as a structured error, with no action replay', async () => {
  const wire = await pluginActionResult(null,{action:'sources-list'});assert.equal(wire.error.code,'PLUGIN_SERVICE_NOT_READY');assert.equal(typeof wire.error.message,'string');
});
test('extension IPC leaves successful and already-structured responses intact', async () => {
  for (const value of [{sources:[]},{error:{code:'PLUGIN_PLAN_EXPIRED',message:'Check again'}},{installed:{},service:{state:'ready'}}]) assert.deepEqual(await pluginActionResult({action:async()=>value},{action:'status'}),value);
});
