import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

// Mood is a separate, metered purpose. Legacy dialogue fixtures must not turn
// its structured request into another chat reply or hide it from the trace.
export function recordMoodRequest(options, requests, {characterIds, personaId='default'}={}) {
  if(options.purpose!=='mood')return false;
  requests.push(options);
  assert.ok(options.scope?.characterId,'mood has a captured character');
  if(characterIds)assert.ok(characterIds.includes(options.scope.characterId),'mood belongs to a member in this fixture');
  assert.equal(options.scope.personaId,personaId);
  assert.ok(options.scope.lifeId&&options.scope.operationId&&options.activityOriginId,'mood retains life, operation and trusted activity identity');
  return true;
}

export async function waitForMoodRequest(find, timeoutMs=5000) {
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    const value=find();
    if(value)return value;
    await delay(10);
  }
  assert.fail('No matching background mood assessment reached the model');
}
