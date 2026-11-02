import test from 'node:test';
import assert from 'node:assert/strict';
import {renamePluginPath} from '../src/plugin-files.mjs';

test('a transient Windows sharing failure retries the same rename without replacing or deleting anything',async()=>{
 let calls=0,clock=0;const attempts=[],waits=[];
 await renamePluginPath('stage/source','packages/target',{platform:'win32',now:()=>clock,sleepImpl:async ms=>{clock+=ms;waits.push(ms);},renameImpl:async(...args)=>{calls++;attempts.push(args);if(calls<4)throw Object.assign(Error('sharing violation'),{code:'EPERM'});}});
 assert.equal(calls,4);assert.deepEqual(waits,[50,100,250]);assert(attempts.every(args=>args.length===2&&args[0]==='stage/source'&&args[1]==='packages/target'));
});

test('permanent Windows rename failures retain the original error and stop within five seconds',async()=>{
 for(const code of ['EPERM','EACCES','EBUSY']){let clock=0,calls=0;const error=Object.assign(Error('permanent failure'),{code});await assert.rejects(renamePluginPath('source','target',{platform:'win32',now:()=>clock,sleepImpl:async ms=>{clock+=ms;},renameImpl:async()=>{calls++;throw error;}}),value=>value===error);assert(clock<=5000);assert.equal(calls,7);}
});

test('other rename errors and other platforms are never replayed',async()=>{
 for(const [platform,code]of [['win32','ENOENT'],['win32','EXDEV'],['win32','EEXIST'],['linux','EPERM']]){let calls=0;const error=Object.assign(Error('not retryable'),{code});await assert.rejects(renamePluginPath('source','target',{platform,renameImpl:async()=>{calls++;throw error;},sleepImpl:async()=>assert.fail('unexpected delay')}),value=>value===error);assert.equal(calls,1);}
});

test('elapsed filesystem time also consumes the Windows retry budget',async()=>{
 let calls=0,clock=0;await assert.rejects(renamePluginPath('source','target',{platform:'win32',now:()=>clock,sleepImpl:async ms=>{clock+=ms;},renameImpl:async()=>{calls++;clock+=3000;throw Object.assign(Error('slow sharing failure'),{code:'EPERM'});}}),{code:'EPERM'});assert.equal(calls,2);
});

test('an explicit rename retry budget cannot exceed ten seconds or bypass validation',async()=>{
 for(const retryBudgetMs of [-1,4000.5,10001,Infinity,NaN])await assert.rejects(renamePluginPath('source','target',{retryBudgetMs,renameImpl:async()=>assert.fail('invalid budget must not rename')}),RangeError);
});
