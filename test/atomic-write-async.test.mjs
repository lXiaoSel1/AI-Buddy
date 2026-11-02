import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rename,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as atomic from '../src/atomic-write.mjs';
const fault=code=>Object.assign(Error('synthetic '+code),{code});
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'atomic-async-')),target=join(directory,'state.json');await writeFile(target,'old durable');t.after(()=>rm(directory,{recursive:true,force:true}));assert.equal(typeof atomic.writeAtomicAsync,'function');return {directory,target};}

test('async atomic write yields and retries only the same fsynced original temp after one Windows EPERM',async t=>{
 const f=await fixture(t),calls=[],waits=[];let yielded=false;
 await atomic.writeAtomicAsync(f.target,'new complete',{platform:'win32',sleepImpl:async ms=>{waits.push(ms);await new Promise(setImmediate);yielded=true;},renameImpl:async(source,target)=>{calls.push([source,target]);assert.equal(await readFile(source,'utf8'),'new complete');assert.equal(await readFile(target,'utf8'),'old durable');if(calls.length===1)throw fault('EPERM');assert.equal(yielded,true);await rename(source,target);}});
 assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(waits,[50]);assert.equal(await readFile(f.target,'utf8'),'new complete');assert.deepEqual(await readdir(f.directory),['state.json']);
});

test('permanent async publication failure is bounded and retains old target plus the original owned temp evidence',async t=>{
 const f=await fixture(t),error=fault('EPERM'),sources=[];let clock=0;await assert.rejects(atomic.writeAtomicAsync(f.target,'unpublished complete',{platform:'win32',now:()=>clock,sleepImpl:async ms=>{clock+=ms;},renameImpl:async source=>{sources.push(source);throw error;}}),value=>value===error);
 assert.equal(sources.length,7);assert.equal(new Set(sources).size,1);assert.ok(clock<=4000);assert.equal(await readFile(f.target,'utf8'),'old durable');assert.equal(await readFile(sources[0],'utf8'),'unpublished complete');assert.equal(error.atomicWrite.temporary,sources[0]);assert.equal(error.atomicWrite.target,f.target);
});

test('a replaced temp owner is never published or removed during an async retry',async t=>{
 const f=await fixture(t);let source,calls=0,retained;await assert.rejects(atomic.writeAtomicAsync(f.target,'original candidate',{platform:'win32',renameImpl:async path=>{source=path;calls++;throw fault('EPERM');},sleepImpl:async()=>{retained=source+'.retained';await rename(source,retained);await writeFile(source,'foreign replacement');}}),{code:'ATOMIC_TEMP_CHANGED'});
 assert.equal(calls,1);assert.equal(await readFile(f.target,'utf8'),'old durable');assert.equal(await readFile(source,'utf8'),'foreign replacement');assert.equal(await readFile(retained,'utf8'),'original candidate');
});

test('changed bytes in the same temp cannot be committed after an async sharing retry',async t=>{
 const f=await fixture(t);let source,calls=0;await assert.rejects(atomic.writeAtomicAsync(f.target,'original',{platform:'win32',renameImpl:async path=>{source=path;calls++;throw fault('EPERM');},sleepImpl:async()=>writeFile(source,'tampered')}),{code:'ATOMIC_TEMP_CHANGED'});assert.equal(calls,1);assert.equal(await readFile(f.target,'utf8'),'old durable');assert.equal(await readFile(source,'utf8'),'tampered');
});

test('a changed destination is preserved instead of overwritten during an async sharing retry',async t=>{
 const f=await fixture(t);let calls=0;await assert.rejects(atomic.writeAtomicAsync(f.target,'candidate',{platform:'win32',renameImpl:async()=>{calls++;throw fault('EPERM');},sleepImpl:async()=>writeFile(f.target,'external current')}),{code:'ATOMIC_TARGET_CHANGED'});assert.equal(calls,1);assert.equal(await readFile(f.target,'utf8'),'external current');
});

test('an originally absent destination acquired by another owner is preserved',async t=>{
 const f=await fixture(t);await rm(f.target);let calls=0;await assert.rejects(atomic.writeAtomicAsync(f.target,'candidate',{platform:'win32',renameImpl:async()=>{calls++;throw fault('EPERM');},sleepImpl:async()=>writeFile(f.target,'new owner')}),{code:'ATOMIC_TARGET_CHANGED'});assert.equal(calls,1);assert.equal(await readFile(f.target,'utf8'),'new owner');
});

for(const [platform,code]of [['win32','EIO'],['linux','EPERM']])test('async publication does not retry '+platform+' '+code,async t=>{const f=await fixture(t);let calls=0;await assert.rejects(atomic.writeAtomicAsync(f.target,'candidate',{platform,renameImpl:async()=>{calls++;throw fault(code);},sleepImpl:async()=>assert.fail('must not sleep')}),{code});assert.equal(calls,1);assert.equal(await readFile(f.target,'utf8'),'old durable');});
