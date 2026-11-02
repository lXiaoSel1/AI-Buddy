import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,setupCommunity} from './support/community-fixtures.mjs';

test('controlled old bridge refuses a signed schema2 Work release before native runtime inspection',async t=>{
 const f=await setupCommunity(t,{bridgeCompatibilityVersion:'1.0.0'}),value=catalog(f.pub);value.works[0].releases[0].package.compatibility.bridge='^1.1.0';value.works[0].releases[0].package.dataSchemaVersion=2;await f.load(value);
 await assert.rejects(f.service.action({action:'dsh-plan',sourceId:f.pub.source.sourceId,id:'test.tools'}),{code:'PLUGIN_INCOMPATIBLE'});assert.deepEqual(f.calls,[]);assert.equal(f.service.snapshot().dsh.installed.length,0);
});

test('bridge1.1 accepts a signed schema2 release while retaining old bridge1 plugin compatibility',async t=>{
 const f=await setupCommunity(t),value=catalog(f.pub);value.works[0].releases[0].package.compatibility.bridge='^1.1.0';value.works[0].releases[0].package.dataSchemaVersion=2;await f.load(value);
 const plan=await f.service.action({action:'dsh-plan',sourceId:f.pub.source.sourceId,id:'test.tools'});assert.equal(plan.packageRef.dataSchemaVersion,2);assert.equal(f.calls.filter(row=>row[0]==='plan').length,1);
 const prior=await setupCommunity(t);await prior.load();await prior.install();assert.equal(prior.service.snapshot().dsh.installed[0].dataSchemaVersion,1);
});
