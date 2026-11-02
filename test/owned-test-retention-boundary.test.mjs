import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runOwnedTests} from '../scripts/run-owned-tests.mjs';
function fixture(t,body="throw Error('controlled failure')"){
 const root=fs.mkdtempSync(join(tmpdir(),'owned-retention-')),sourceRoot=join(root,'s'),tempBase=join(root,'t'),receiptDirectory=join(root,'r');for(const p of[join(sourceRoot,'test'),tempBase,receiptDirectory])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(join(sourceRoot,'test','case.test.mjs'),"import test from 'node:test';test('fixture',async()=>{"+body+"});");t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,sourceRoot,tempBase,receiptDirectory,testFiles:['case.test.mjs']};
}
test('new receipt folder cannot bypass same-source retained root budget',async t=>{
 const f=fixture(t),retentionLimits={maxRetainedRoots:1};const first=await runOwnedTests({...f,retentionLimits});
 await assert.rejects(runOwnedTests({...f,receiptDirectory:join(f.root,'r2'),retentionLimits}),{code:'OWNED_TEST_BUDGET_EXCEEDED'});assert.ok(fs.existsSync(first.root));
});
test('changing explicit temporary base keeps exact indexed former roots in the source budget',async t=>{
 const f=fixture(t),retentionLimits={maxRetainedRoots:1};const first=await runOwnedTests({...f,retentionLimits});
 await assert.rejects(runOwnedTests({...f,tempBase:join(f.root,'t2'),retentionLimits}),{code:'OWNED_TEST_BUDGET_EXCEEDED'});assert.ok(fs.existsSync(first.root));
});
test('shared temporary parent rejects concurrent runner before it launches another child',async t=>{
 const f=fixture(t,"await new Promise(r=>setTimeout(r,200));throw Error('controlled failure')");
 const first=runOwnedTests(f);await new Promise(r=>setTimeout(r,30));
 await assert.rejects(runOwnedTests({...f,receiptDirectory:join(f.root,'r2')}),{code:'OWNED_TEST_RUN_BUSY'});assert.equal((await first).status,'failed-retained');
});
