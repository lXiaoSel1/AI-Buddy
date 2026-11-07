import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createVoiceSettings} from '../src/voice/settings.mjs';

test('each plugin keeps its own TTS choice after reopening, with local recognition and no automatic fallback',async()=>{
  const testRoot=fileURLToPath(new URL('../../test-data/',import.meta.url));
  await mkdir(testRoot,{recursive:true});
  const dataRoot=await mkdtemp(join(testRoot,'voice-settings-'));
  const settings=createVoiceSettings({dataRoot});
  assert.equal((await settings.get()).enabled,false);
  await settings.update({enabled:true,selectedPackageId:'ai-buddy.voice-gpt-sovits',packages:{'ai-buddy.voice-gpt-sovits':{ttsProvider:'minimax',credentialRef:'voice-test-key'}}});
  await settings.update({selectedPackageId:'ai-buddy.voice-breeze'});
  const saved=await createVoiceSettings({dataRoot}).get();
  assert.equal(saved.packages['ai-buddy.voice-gpt-sovits'].ttsProvider,'minimax');
  assert.equal(saved.packages['ai-buddy.voice-breeze'].ttsProvider,'local');
  assert.equal(saved.packages['ai-buddy.voice-gpt-sovits'].sttProvider,'local');
  await assert.rejects(settings.update({packages:{'ai-buddy.voice-breeze':{apiKey:'never-persist-me'}}}),{code:'VOICE_SETTINGS_INVALID'});
  await assert.rejects(settings.update({packages:{'ai-buddy.voice-breeze':{sttProvider:'cloud'}}}),{code:'VOICE_SETTINGS_INVALID'});
  assert.ok(!(await readFile(join(dataRoot,'voice','settings.json'),'utf8')).includes('never-persist-me'));
});
