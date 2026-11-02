import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkPluginGate} from '../src/work-plugin-gate.mjs';

test('ACR host: short work RPC releases exactly its issued context on both success and failure',async t=>{
 const root=await mkdtemp(join(tmpdir(),'acr-work-release-')),pluginId='dsh.'+'a'.repeat(32),scope={characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
 const record={packageName:'@ai-buddy/work-collaboration',packageKey:'fixture-work',pluginId,sourceDigest:'a'.repeat(64),exactVersion:'2.0.9',enabled:true,enabledIntent:true,generation:1};
 const issued=[],released=[];let fail=false;
 const backend={identity:async()=>({pid:123456,runtimeId:'fixture-runtime',profileId:'fixture-profile',phase:'running'}),snapshot:async()=>({pid:123456,runtimeId:'fixture-runtime',profileId:'fixture-profile'}),close:async()=>{},callTool:async()=>{if(fail)throw Error('synthetic tool failure');return {results:[{result:{value:{synthetic:true}}}]};}};
 const platform={snapshot:()=>({dsh:{installed:[record]}}),bridge:{grants:{get:()=>({enabled:true,generation:1})},authority:{revoke:token=>released.push(token)}},createIsolatedWorkBackend:async()=>backend,issueToolContext:async value=>{const context={...value,contextToken:'short-'+issued.length};issued.push(context.contextToken);return context;},runtimeDescriptor:async()=>{throw Error('No native runtime in fixture');}};
 const proof={stopped:true,osActiveProcesses:0,registered:1},supervisor={registerRoot:async()=>({guardReady:true}),identity:async pid=>({pid,creationTime:'fixture-birth'}),status:async()=>proof,awaitStopped:async()=>proof,stopOwned:async()=>proof,close:async()=>{}};
 const game={context:()=>scope,pluginScope:()=>({...scope,contextRevision:1}),action:async()=>({companion:{characters:[]}})};
 const gate=createWorkPluginGate({dataRoot:root,build:root,getPlatform:()=>platform,getGame:()=>game,getProvider:()=>null,supervisor});
 t.after(async()=>{await gate.close();await rm(root,{recursive:true,force:true});});
 assert.deepEqual(await gate.action('projects.discover',{}),{synthetic:true});assert.deepEqual(released,issued);
 fail=true;await assert.rejects(gate.action('projects.discover',{}),/synthetic tool failure/);assert.equal(issued.length,2);assert.deepEqual(released,issued);
});
