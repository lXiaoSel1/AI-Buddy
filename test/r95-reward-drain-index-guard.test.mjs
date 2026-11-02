// Read-only source-path guard: no monitor constructor, profiles, App or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {TokenMonitor} from '../src/token-monitor.mjs';
function monitor(){
 const calls={allLegacy:0,allGeneric:0,groups:[],meta:0,indexSave:0},legacyKeys=['codex:one','claude:two'],genericKeys=['generic:one'];
 const value={sources:{list:()=>[]},attribution:{revision:0},workUsage:{key:'fixed-scope-key',projectRow:row=>row},repository:{meta:()=>calls.meta++},analyticsSources:JSON.stringify([0,'fixed-scope-key']),
  legacy:{ledger:{requestGroups:{keys(){calls.allLegacy++;return legacyKeys.values();}},dirtyRequestSessions:new Set(),iterateRequestRows:function*(){},sessions:new Map()}},
  ledger:{groups:{keys(){calls.allGeneric++;return genericKeys.values();},get(){return new Map();}},dirtyGroups:new Set()},analytics:{replaceGroup(key,rows){calls.groups.push(key);[...rows];},saveIndex(){calls.indexSave++;}}};
 return {value,calls,run:()=>TokenMonitor.prototype.syncAnalyticsRows.call(value)};
}
test('2500 stable reward drains do not enumerate or replace the historical index',()=>{const f=monitor();for(let n=0;n<2500;n++)f.run();assert.equal(f.calls.allLegacy,0);assert.equal(f.calls.allGeneric,0);assert.deepEqual(f.calls.groups,[]);});
test('one signature change rebuilds groups once rather than once per reward batch',()=>{const f=monitor();f.value.analyticsSources='old-signature';f.run();for(let n=0;n<10;n++)f.run();assert.equal(f.calls.allLegacy,1);assert.equal(f.calls.allGeneric,1);assert.deepEqual(f.calls.groups,['codex:one','claude:two','generic:one']);});
test('stable signature rebuilds only the explicitly dirty session',()=>{const f=monitor();f.value.legacy.ledger.dirtyRequestSessions.add('codex:active');f.run();f.run();assert.equal(f.calls.allLegacy,0);assert.equal(f.calls.allGeneric,0);assert.deepEqual(f.calls.groups,['codex:active']);});
