import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceCredentials} from '../src/voice/credentials.mjs';

test('voice keys survive restart encrypted and public views never contain the key',async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'buddy-voice-key-'));
  const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('cipher:'+Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString().slice(7),'base64').toString()};
  try{
    const store=createVoiceCredentials({dataRoot,crypto});
    const saved=await store.save('test-private-voice-key');
    assert.match(saved.ref,/^voice:minimax:/);
    assert.equal(JSON.stringify(saved).includes('test-private'),false);
    assert.equal((await readFile(join(dataRoot,'voice','credentials.json'),'utf8')).includes('test-private'),false);
    assert.equal(await createVoiceCredentials({dataRoot,crypto}).resolve(saved.ref),'test-private-voice-key');
    await assert.rejects(()=>store.resolve('model:someone-elses-key'),{code:'VOICE_CREDENTIAL_INVALID'});
  }finally{await rm(dataRoot,{recursive:true,force:true});}
});

test('voice credentials fail closed if OS encryption is unavailable',async()=>{
  const store=createVoiceCredentials({dataRoot:tmpdir(),crypto:{isEncryptionAvailable:()=>false}});
  await assert.rejects(()=>store.save('a-private-key'),{code:'VOICE_CREDENTIAL_ENCRYPTION'});
});
