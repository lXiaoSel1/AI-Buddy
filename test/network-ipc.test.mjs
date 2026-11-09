import test from 'node:test';
import assert from 'node:assert/strict';
import {createNetworkActions} from '../src/network-ipc.mjs';
test('network settings accept only the workspace sender and a fixed connectivity test',async()=>{
 const sender={},calls=[],network={snapshot:()=>({mode:'system'}),save:async value=>{calls.push(value);return value;},test:async(...args)=>{assert.deepEqual(args,[]);return {ok:true};}};
 const action=createNetworkActions({getNetwork:()=>network,isTrusted:event=>event.sender===sender,onSaved:value=>calls.push(['saved',value])});
 await assert.rejects(action({sender:{}},'save',{mode:'direct'}),/sender/);assert.deepEqual(calls,[]);
 assert.deepEqual(await action({sender},'get'),{mode:'system'});
 assert.deepEqual(await action({sender},'test','http://private.invalid'),{ok:true});
 await action({sender},'save',{mode:'direct'});assert.equal(calls.length,2);
 await assert.rejects(action({sender},'fetch','http://private.invalid'),/operation/);
});
