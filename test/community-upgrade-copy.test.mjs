import test from 'node:test';
import assert from 'node:assert/strict';
import {communityUpgradeKeepsEnabled} from '../src/community-center.mjs';
test('upgrade enablement copy follows exact saved enablement, schema compatibility and selected grant scope',()=>{const plan={priorEnabled:true,priorDataSchemaVersion:1,priorGrantedCapabilities:['tools.list'],packageRef:{dataSchemaVersion:1}};assert.equal(communityUpgradeKeepsEnabled(plan,['tools.list']),true);assert.equal(communityUpgradeKeepsEnabled(plan,['tools.list','models.request']),false);assert.equal(communityUpgradeKeepsEnabled({...plan,priorEnabled:false},['tools.list']),false);assert.equal(communityUpgradeKeepsEnabled({...plan,priorDataSchemaVersion:2},['tools.list']),false);assert.equal(communityUpgradeKeepsEnabled({},[]),false);});
