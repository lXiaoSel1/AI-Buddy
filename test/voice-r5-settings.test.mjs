import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceSettings,defaultVoiceSettings} from '../src/voice/settings.mjs';

test('old key references become named cloud configurations and selection survives restart',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-r5-settings-'));
  t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const old=defaultVoiceSettings();
  old.packages['ai-buddy.voice-breeze']={ttsProvider:'minimax',sttProvider:'local',credentialRef:'voice:old:key'};
  await mkdir(join(dataRoot,'voice'));await writeFile(join(dataRoot,'voice','settings.json'),JSON.stringify(old));
  const settings=createVoiceSettings({dataRoot});
  const migrated=await settings.listConnections();
  assert.equal(migrated.items.length,1);assert.equal(migrated.items[0].credentialRef,'voice:old:key');
  const second=await settings.saveConnection({name:'备用 MiniMax',provider:'minimax',model:'speech-2.8-hd',credentialRef:'voice:new:key'});
  await settings.selectConnection(second.id);
  const reopened=createVoiceSettings({dataRoot});
  assert.equal((await reopened.listConnections()).selectedId,second.id);
  assert.deepEqual(await reopened.resolveConnection({packageId:'ai-buddy.voice-breeze'}),{id:second.id,name:'备用 MiniMax',provider:'minimax',model:'speech-2.8-hd',keyRef:'voice:new:key'});
  await reopened.selectConnection(migrated.items[0].id);
  assert.equal((await reopened.resolveConnection({packageId:'ai-buddy.voice-breeze'})).keyRef,'voice:old:key');
  await assert.rejects(reopened.saveConnection({name:'假服务',provider:'arbitrary',model:'anything',credentialRef:'voice:key'}),{code:'VOICE_SETTINGS_INVALID'});
  await assert.rejects(reopened.saveConnection({name:'泄漏',provider:'minimax',model:'speech-2.8-turbo',apiKey:'secret'}),{code:'VOICE_SETTINGS_INVALID'});
});

test('cached settings still observe external replacement and reject plaintext credentials',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-r5-settings-cache-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const settings=createVoiceSettings({dataRoot});await settings.update({enabled:true});assert.equal((await settings.get()).enabled,true);
  const external=defaultVoiceSettings();external.enabled=false;await writeFile(join(dataRoot,'voice','settings.json'),JSON.stringify(external));
  assert.equal((await settings.get()).enabled,false);
  await assert.rejects(settings.update({cloudConnections:{selectedId:'fake',items:[{id:'fake',name:'fake',provider:'minimax',model:'speech-2.8-turbo',credentialRef:null,key:'plaintext'}]}}),{code:'VOICE_SETTINGS_INVALID'});
});
