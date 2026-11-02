import test from 'node:test';
import assert from 'node:assert/strict';
import {officialScopeFingerprints,OFFICIAL_SOURCE_FINGERPRINT} from '../src/community/catalog-policy.mjs';

const extra='SHA256:'+'A'.repeat(43);
test('a validation fingerprint widens the official scope only in an app launched with --validation=1',()=>{
 const env={AI_BUDDY_VALIDATION_OFFICIAL_FINGERPRINTS:extra};
 assert.deepEqual([...officialScopeFingerprints(env,['electron','main.mjs'])],[OFFICIAL_SOURCE_FINGERPRINT],'the variable alone is ignored');
 assert.deepEqual([...officialScopeFingerprints(env,['electron','main.mjs','--validation=0'])],[OFFICIAL_SOURCE_FINGERPRINT]);
 assert.deepEqual([...officialScopeFingerprints(env,['electron','wrapper.cjs','--validation=1'])],[OFFICIAL_SOURCE_FINGERPRINT,extra]);
 assert.deepEqual([...officialScopeFingerprints({AI_BUDDY_VALIDATION_OFFICIAL_FINGERPRINTS:'not-a-fingerprint'},['--validation=1'])],[OFFICIAL_SOURCE_FINGERPRINT],'malformed values never count');
 assert.deepEqual([...officialScopeFingerprints({},['--validation=1'])],[OFFICIAL_SOURCE_FINGERPRINT]);
});
