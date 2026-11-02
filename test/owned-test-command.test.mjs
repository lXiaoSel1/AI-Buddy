import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {ownedTestCommand} from '../scripts/run-owned-tests.mjs';
test('the full owned suite uses cwd-relative arguments while retaining exact selected inputs',()=>{const root=path.resolve('long-project-source-name '.repeat(4),'core'),selected=Array.from({length:310},(_,i)=>path.join(root,'test','test-'+i+'.test.mjs')),before=[...selected],command=ownedTestCommand(root,selected);assert.deepEqual(command.slice(0,2),['--test','--test-reporter=tap']);assert.equal(command.length,312);assert.ok(command.join(' ').length<16000);assert.deepEqual(command.slice(2).map(file=>path.resolve(root,file)),selected);assert.deepEqual(selected,before);assert.throws(()=>ownedTestCommand(root,[path.resolve(root,'../escape.test.mjs')]),/outside/);assert.throws(()=>ownedTestCommand(root,[root]),/outside/);});
