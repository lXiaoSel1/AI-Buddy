import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {DEFAULT_PREFERENCES,normalizePreferences,validatePreferencesPatch,formatActivityTime} from '../src/preferences.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
test('Legacy settings inherit saved Galgame visibility and valid preferences survive normalization',()=>{
  assert.deepEqual(normalizePreferences(undefined,false),{...DEFAULT_PREFERENCES,petVisible:false});
  const custom={...DEFAULT_PREFERENCES,petScale:1.25,alwaysOnTop:false,monitorRefreshMs:5000,displayTimeZone:'UTC'};
  assert.deepEqual(normalizePreferences(custom),custom);
  assert.equal(normalizePreferences({petScale:500,clickThrough:'false'}).petScale,1.25);
  assert.equal(normalizePreferences({petScale:1}).petScale,1);
  assert.equal(normalizePreferences({clickThrough:'false'}).clickThrough,true);
});
test('Settings whitelist rejects invalid types, injected paths and unsupported values before mutation',()=>{
  for(const patch of [null,[],{petBounds:{x:0}},{dataRoot:'C:\\'},{petVisible:1},{petScale:0},{animationSpeed:0},{animationSpeed:'0.75'},{animationSpeed:2},{monitorRefreshMs:50},{displayTimeZone:'invalid'}])assert.throws(()=>validatePreferencesPatch(patch));
  assert.deepEqual(validatePreferencesPatch({petScale:1.5,petVisible:false,displayTimeZone:'local'}),{petScale:1.5,petVisible:false,displayTimeZone:'local'});
});

test('Existing settings inherit 75% without changing saved values and supported speeds round-trip',()=>{
  const legacy={petScale:1.25,alwaysOnTop:false,followCursor:false};
  assert.deepEqual(normalizePreferences(legacy),{...DEFAULT_PREFERENCES,...legacy,animationSpeed:.75,statisticsTimeZone:"America/New_York"});
  for(const animationSpeed of [.25,.5,.75,1])assert.equal(normalizePreferences(validatePreferencesPatch({animationSpeed})).animationSpeed,animationSpeed);
});
test('Activity display zone changes the timestamp without changing the New York accounting date',()=>{
  const instant='2026-10-08T02:15:00Z';
  assert.match(formatActivityTime(instant,'America/New_York'),/2026\/10\/7.*22:15:00/);
  assert.match(formatActivityTime(instant,'UTC'),/2026\/10\/8.*02:15:00/);
  assert.equal(formatActivityTime(null),'—');
});
test('Preferences and saved position survive reload while all earlier snapshots remain',async()=>{
  const logical=join(import.meta.dirname,'../local/test-runs','preferences-'+Date.now(),'settings.json');
  const first={petBounds:{x:-50,y:100,width:270,height:280},preferences:{...DEFAULT_PREFERENCES}};
  const store=createSnapshotStorage(logical);await store.writeText(JSON.stringify(first));
  const next={...first,preferences:{...first.preferences,petVisible:false,petScale:1.25,monitorRefreshMs:2000}};
  await store.writeText(JSON.stringify(next));assert.deepEqual(await readJson(createSnapshotStorage(logical),null),next);
  assert.equal((await readdir(logical+'.snapshots')).filter(x=>x.endsWith('.json')).length,2);
});
