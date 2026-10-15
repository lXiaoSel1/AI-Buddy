import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseFlow} from '../scripts/version-release-flow.mjs';
function scenario(fail){const calls=[];const steps=Object.fromEntries(['archivePrevious','stopCurrent','switchBuild','startBuild','checkStartup','rollback','cleanupPrevious'].map(name=>[name,async()=>{calls.push(name);if(name===fail)throw Error(name);} ]));return {calls,steps};}
test('Archive failure leaves production running and does not switch or clean',async()=>{
 const s=scenario('archivePrevious');await assert.rejects(releaseFlow(s.steps));assert.deepEqual(s.calls,['archivePrevious']);
});
test('A failed new startup restores the old version and preserves its build',async()=>{
 const s=scenario('checkStartup');await assert.rejects(releaseFlow(s.steps),error=>error.releaseState.rolledBack===true);
 assert.deepEqual(s.calls,['archivePrevious','stopCurrent','switchBuild','startBuild','checkStartup','rollback']);
});
test('An interrupted pointer switch also attempts recovery',async()=>{
 const s=scenario('switchBuild');await assert.rejects(releaseFlow(s.steps),error=>error.releaseState.rolledBack===true);assert.equal(s.calls.at(-1),'rollback');
});
test('Failure after beginning shutdown restarts the existing version',async()=>{
 const s=scenario('stopCurrent');await assert.rejects(releaseFlow(s.steps),error=>error.releaseState.rolledBack===true);assert.deepEqual(s.calls,['archivePrevious','stopCurrent','rollback']);
});
test('Successful startup precedes cleanup, and cleanup failure keeps the working version',async()=>{
 const s=scenario('cleanupPrevious');const result=await releaseFlow(s.steps);assert.equal(result.ok,true);assert.equal(result.cleanupWarning,'cleanupPrevious');assert.equal(result.rolledBack,false);
 assert.deepEqual(s.calls,['archivePrevious','stopCurrent','switchBuild','startBuild','checkStartup','cleanupPrevious']);
});
