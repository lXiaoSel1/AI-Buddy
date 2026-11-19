import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';

test('router closes the complete Codex provider and waits for its bounded cleanup',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'cache-r3-router-'));
 t.after(()=>rm(dataRoot,{recursive:true,force:true}));
 const events=[];let finish;
 const codex={defaultModel:'synthetic',setEnabled:value=>events.push(['enabled',value]),close:()=>{events.push(['close']);return new Promise(resolve=>{finish=resolve;});}};
 const router=await new ModelRouter({dataRoot,codex}).ready;
 let closed=false;const closing=Promise.resolve(router.close()).then(()=>{closed=true;});
 await Promise.resolve();
 assert.equal(events.some(row=>row[0]==='close'),true);
 assert.equal(closed,false);
 finish();await closing;assert.equal(closed,true);
});

test('router exposes private thread host commit and deletion lifecycle to the companion service',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'cache-r3-router-forward-'));
 t.after(()=>rm(dataRoot,{recursive:true,force:true}));
 const calls=[];
 const codex={defaultModel:'synthetic',commitPrivateThread:async(...args)=>{calls.push(['commit',...args]);return true;},discardPrivateThread:async(...args)=>calls.push(['discard',...args]),deletePrivateThreads:async(...args)=>calls.push(['delete',...args])};
 const router=await new ModelRouter({dataRoot,codex}).ready;
 assert.equal(typeof router.commitPrivateThread,'function');
 assert.equal(await router.commitPrivateThread('request',{lastMessageId:'reply'}),true);
 await router.discardPrivateThread('request');
 await router.deletePrivateThreads({conversationId:'own-conversation'});
 assert.deepEqual(calls,[['commit','request',{lastMessageId:'reply'}],['discard','request'],['delete',{conversationId:'own-conversation'}]]);
});
