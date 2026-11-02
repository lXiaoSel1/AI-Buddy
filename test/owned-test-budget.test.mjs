import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runOwnedTests} from '../scripts/run-owned-tests.mjs';
import * as runner from '../scripts/run-owned-tests.mjs';

function fixture(t,body="throw Error('controlled failure')"){
 const root=fs.mkdtempSync(join(tmpdir(),'owned-budget-fixture-')),sourceRoot=join(root,'source'),tempBase=join(root,'temps'),receiptDirectory=join(root,'receipts');
 for(const p of [join(sourceRoot,'test'),tempBase,receiptDirectory])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(join(sourceRoot,'test','case.test.mjs'),"import test from 'node:test';\nimport fs from 'node:fs';\nimport path from 'node:path';\ntest('fixture',()=>{"+body+"});\n");
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,sourceRoot,tempBase,receiptDirectory,testFiles:['case.test.mjs']};
}
const limits={maxRetainedRoots:1,maxRetainedBytes:1024*1024,maxEntries:1000};
const rootNames=base=>fs.readdirSync(base).filter(name=>name.startsWith('ai-buddy-owned-test-r1-')).sort();

test('owned test root budget stops the next child before allocating more space and preserves failure evidence',async t=>{
 const f=fixture(t),first=await runOwnedTests({...f,retentionLimits:limits});assert.equal(first.status,'failed-retained');
 const before=fs.readFileSync(first.receipt),names=rootNames(f.tempBase);fs.writeFileSync(join(f.tempBase,'unrelated.txt'),'another task');
 await assert.rejects(runOwnedTests({...f,retentionLimits:limits}),{code:'OWNED_TEST_BUDGET_EXCEEDED'});
 assert.deepEqual(rootNames(f.tempBase),names);assert.deepEqual(fs.readFileSync(first.receipt),before);assert.equal(fs.readFileSync(join(f.tempBase,'unrelated.txt'),'utf8'),'another task');
});

test('owned test byte budget is evaluated from retained filesystem bytes, not only root count',async t=>{
 const f=fixture(t,"fs.writeFileSync(path.join(process.env.TEMP,'payload'),Buffer.alloc(4096));throw Error('controlled failure')"),retentionLimits={...limits,maxRetainedRoots:8,maxRetainedBytes:1024};
 const first=await runOwnedTests({...f,retentionLimits});assert.equal(first.status,'failed-retained');await assert.rejects(runOwnedTests({...f,retentionLimits}),{code:'OWNED_TEST_BUDGET_EXCEEDED'});assert.equal(fs.statSync(join(first.root,'payload')).size,4096);
});

test('owned test index records failed roots durably without deleting unresolved evidence',async t=>{
 const f=fixture(t),first=await runOwnedTests({...f,retentionLimits:{...limits,maxRetainedRoots:8}}),index=JSON.parse(fs.readFileSync(join(f.receiptDirectory,'owned-retention-v1.json'),'utf8'));
 assert.equal(index.schemaVersion,1);assert.equal(index.sourceRoot,fs.realpathSync(f.sourceRoot));assert.equal(index.runs[first.runId].root,first.root);assert.equal(index.runs[first.runId].state,'failed-retained');assert.equal(index.runs[first.runId].receipt,first.receipt);assert.ok(fs.existsSync(first.root));
});

test('owned budget refuses a changed retained ownership marker instead of silently ignoring it',async t=>{
 const f=fixture(t),first=await runOwnedTests({...f,retentionLimits:{...limits,maxRetainedRoots:8}}),marker=join(first.root,'.owner.json');fs.writeFileSync(marker,'{"kind":"another-task"}');
 await assert.rejects(runOwnedTests({...f,retentionLimits:{...limits,maxRetainedRoots:8}}),{code:'OWNED_TEST_RETENTION_UNVERIFIED'});assert.equal(fs.readFileSync(marker,'utf8'),'{"kind":"another-task"}');assert.deepEqual(rootNames(f.tempBase),[first.root.split(/[\\/]/).at(-1)]);
});

test('successful owned test roots are cleaned and do not consume retained-root slots',async t=>{
 const f=fixture(t,'return true'),first=await runOwnedTests({...f,retentionLimits:limits}),second=await runOwnedTests({...f,retentionLimits:limits});assert.equal(first.status,'passed-cleaned');assert.equal(second.status,'passed-cleaned');assert.deepEqual(rootNames(f.tempBase),[]);
 const index=JSON.parse(fs.readFileSync(join(f.receiptDirectory,'owned-retention-v1.json'),'utf8'));assert.equal(index.runs[first.runId].state,'passed-cleaned');assert.equal(index.runs[second.runId].state,'passed-cleaned');
});

test('retention scope cannot read or clean another source sharing a temporary parent',async t=>{
 const f=fixture(t),other=fixture(t);other.tempBase=f.tempBase;const first=await runOwnedTests({...f,retentionLimits:limits}),second=await runOwnedTests({...other,retentionLimits:limits});assert.equal(second.status,'failed-retained');assert.ok(fs.existsSync(first.root));assert.ok(fs.existsSync(second.root));
 const index=JSON.parse(fs.readFileSync(join(other.receiptDirectory,'owned-retention-v1.json'),'utf8'));assert.equal(Object.hasOwn(index.runs,first.runId),false);assert.equal(Object.hasOwn(index.runs,second.runId),true);
});

test('shared owned-byte budget blocks another source without deleting either source evidence',async t=>{
 const f=fixture(t,"fs.writeFileSync(path.join(process.env.TEMP,'payload'),Buffer.alloc(4096));throw Error('controlled failure')"),other=fixture(t);other.tempBase=f.tempBase;
 const first=await runOwnedTests({...f,retentionLimits:{...limits,maxSharedBytes:1024}});
 await assert.rejects(runOwnedTests({...other,retentionLimits:{...limits,maxSharedBytes:1024}}),{code:'OWNED_TEST_BUDGET_EXCEEDED'});assert.ok(fs.existsSync(first.root));assert.equal(fs.readFileSync(join(first.root,'payload')).length,4096);
});

test('short owned root resolver finds only a bounded project ancestor and honors explicit absolute override',t=>{
 const f=fixture(t),project=join(f.root,'project'),source=join(project,'integration','deep','candidate','source');fs.mkdirSync(source,{recursive:true});fs.writeFileSync(join(project,'AGENTS.md'),'test project');
 assert.equal(typeof runner.resolveOwnedTestTempBase,'function');
 assert.equal(runner.resolveOwnedTestTempBase({sourceRoot:source,env:{},systemTemp:f.tempBase}),join(project,'integration','ab-tests'));
 assert.equal(runner.resolveOwnedTestTempBase({sourceRoot:source,env:{AI_BUDDY_TEST_TEMP_BASE:f.tempBase},systemTemp:f.tempBase}),resolve(f.tempBase));
 assert.equal(runner.resolveOwnedTestTempBase({sourceRoot:source,env:{},systemTemp:f.tempBase,maxAncestors:1}),join(f.tempBase,'ab-tests'));
 assert.equal(fs.existsSync(join(project,'integration','ab-tests')),false,'resolving a location must not allocate it');
});

test('short root resolver rejects a relative override instead of depending on the shell cwd',t=>{
 const f=fixture(t);assert.equal(typeof runner.resolveOwnedTestTempBase,'function');assert.throws(()=>runner.resolveOwnedTestTempBase({sourceRoot:f.sourceRoot,env:{AI_BUDDY_TEST_TEMP_BASE:'../../other-task'},systemTemp:f.tempBase}),{code:'OWNED_TEST_TEMP_INVALID'});
});
