import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {openCompanionStore} from '../src/companion-store.mjs';
import {readCompanionRollbackCounts,verifyCompanionRollbackCounts} from '../src/companion-rollback-counts.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
import {tmpDir} from './support/audit-harness.mjs';

test('SQLite rollback checks every private and group owner including zero and rejects a redistributed total',async t=>{
 const root=tmpDir('rollback-census',{t});
 const directory=join(root,'galgame');
 const fixture={schema:2,conversations:{one:{messages:[{id:'m1',text:'first'}]},empty:{messages:[]}},groups:{party:{messages:[{id:'m2',text:'second'}]}}};
 await createSnapshotStorage(join(directory,'companion.json')).writeText(JSON.stringify(fixture));
 const store=await openCompanionStore(root);await store.close();
 const census=readCompanionRollbackCounts(join(directory,'companion.sqlite'));
 assert.equal(census.totalMessageCount,2);
 assert.deepEqual(verifyCompanionRollbackCounts(census,fixture),{activeMessageCount:2,ownerCounts:[
  {type:'group',ownerId:'party',sqliteCount:1,jsonCount:1},
  {type:'private',ownerId:'empty',sqliteCount:0,jsonCount:0},
  {type:'private',ownerId:'one',sqliteCount:1,jsonCount:1},
 ]});
 const redistributed=structuredClone(fixture);redistributed.conversations.empty.messages.push(redistributed.conversations.one.messages.pop());
 assert.throws(()=>verifyCompanionRollbackCounts(census,redistributed),/owner message count mismatch/);
 const missing=structuredClone(fixture);delete missing.conversations.empty;
 assert.throws(()=>verifyCompanionRollbackCounts(census,missing),/owner message count mismatch/);
 assert.throws(()=>verifyCompanionRollbackCounts({...census,activeMessageCount:3},fixture),/total message count mismatch/);
});
