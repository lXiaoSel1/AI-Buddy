import test from 'node:test';
import assert from 'node:assert/strict';
import {workContextCapacity} from '../src/work-context-capacity.mjs';
test('native work budget follows captured model and never falls through to active chat',()=>{
 const provider={captureConnection(binding){assert.deepEqual(binding,{enabled:true,connectionId:'work'});return {id:'work',model:'chat-model',models:[{id:'work-model',contextWindow:65536},{id:'chat-model',contextWindow:8192}]};},resolveContextCapacity(){throw Error('chat capacity called');}};
 const cap=workContextCapacity({connectionRef:'work',model:'work-model',parameters:{contextTokens:32768}},provider);
 assert.equal(cap.tokens,32768);assert.equal(cap.model,'work-model');assert.equal(cap.connectionRef,'work');
 assert.equal(workContextCapacity({connectionRef:'work',model:'work-model'},provider).tokens,65536);
});
test('unknown native capacity uses explicit application default; missing named connection is refused',()=>{
 const provider={captureConnection(){throw Error('must not consult global chat');}};
 assert.equal(workContextCapacity({engine:'codex',model:'native'},provider).source,'application-default');
 assert.throws(()=>workContextCapacity({connectionRef:'missing',model:'native'},{captureConnection:()=>null}),{code:'WORK_CONNECTION_DENIED'});
 assert.throws(()=>workContextCapacity({parameters:{contextTokens:NaN}}),{code:'WORK_CONTEXT_CAPACITY'});
});
