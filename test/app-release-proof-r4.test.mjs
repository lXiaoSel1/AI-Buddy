import test from 'node:test';
import assert from 'node:assert/strict';

test('release proof requires both signed protocols, exact official URLs and the pinned key',()=>{
  const missing=releaseFixture({bootstrap:false});
  assert.throws(()=>verifyAppReleaseProof(missing.release,{verifySignature:missing.verifySignature}),{code:'APP_UPDATE_VERIFICATION_FAILED'});
  const fixture=releaseFixture();
  assert.equal(verifyAppReleaseProof(fixture.release,{verifySignature:fixture.verifySignature}).version,'2.0.8');
  assert.throws(()=>verifyAppReleaseProof({...fixture.release,installerUrl:'https://example.com/setup.exe'},{verifySignature:fixture.verifySignature}),{code:'APP_UPDATE_VERIFICATION_FAILED'});
  assert.throws(()=>verifyAppReleaseProof(fixture.release),{code:'APP_UPDATE_VERIFICATION_FAILED'});
});

import {link,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseFixture,fixtureBytes} from './fixtures/app-update-r4.mjs';
import {createAppReleaseClient,verifyAppReleaseProof} from '../src/update-release-proof.mjs';
import {verifyRawSshSignature} from '../src/raw-sshsig.mjs';

test('raw git SSHSIG verifies exact bytes and rejects JSON canonicalization, other namespaces and other keys',()=>{
  const fixture=releaseFixture();
  assert.equal(verifyRawSshSignature(fixture.release.signedPayload,fixture.release.signature,fixture.publicSsh,'git'),true);
  assert.equal(verifyRawSshSignature(fixture.release.signedPayload+'\n',fixture.release.signature,fixture.publicSsh,'git'),false);
  assert.equal(verifyRawSshSignature(JSON.stringify(fixture.release.signedPayload),fixture.release.signature,fixture.publicSsh,'git'),false);
  assert.equal(verifyRawSshSignature(fixture.release.signedPayload,fixture.release.signature,fixture.publicSsh,'ai-buddy-plugin-catalog'),false);
  assert.throws(()=>verifyAppReleaseProof(fixture.release),{code:'APP_UPDATE_VERIFICATION_FAILED'});
});

test('discovery pins an annotated verified stable newer release and all official asset identities',async()=>{
  const fixture=releaseFixture();assert.deepEqual(await fixture.client.check('2.0.7'),fixture.release);
  assert.equal(await fixture.client.check('2.0.8'),null);
  for(const change of [()=>fixture.document.prerelease=true,()=>fixture.reference.object.type='commit',()=>fixture.tagDocument.verification.verified=false,
    ()=>fixture.document.assets[2].digest='sha256:'+'f'.repeat(64),()=>fixture.document.assets.push(fixture.document.assets[0]),()=>fixture.tagDocument.object.sha='a'.repeat(40)]){
    // Apply each mutation to fresh published API documents through the fetch boundary.
    const originals=[fixture.document,fixture.reference,fixture.tagDocument];
    const before=originals.map(value=>structuredClone(value));change();
    await assert.rejects(fixture.client.check('2.0.7'),{code:'APP_UPDATE_VERIFICATION_FAILED'});
    originals.forEach((value,n)=>{for(const key of Object.keys(value))delete value[key];Object.assign(value,before[n]);});
  }
  await assert.rejects(releaseFixture({bootstrap:false}).client.check('2.0.7'),{code:'APP_UPDATE_VERIFICATION_FAILED'});
});

test('verified downloads enforce signed bytes and digest, reuse valid cache and never overwrite linked cache targets',async t=>{
  const cache=await mkdtemp(join(tmpdir(),'release-r4-'));t.after(()=>rm(cache,{recursive:true,force:true}));
  const fixture=releaseFixture(),file=await fixture.client.download(fixture.release,cache);
  assert.deepEqual(await readFile(file),fixtureBytes);
  const offline=createAppReleaseClient({verifySignature:fixture.verifySignature,fetch:()=>assert.fail('valid cache downloaded again')});
  assert.equal(await offline.download(fixture.release,cache),file);
  const protectedFile=join(cache,'kept');await writeFile(protectedFile,'keep');
  const otherCache=join(cache,'linked');await mkdir(otherCache);const alias=join(otherCache,fixture.release.installerSha256+'-'+fixture.release.installerName);await link(protectedFile,alias);
  await fixture.client.download(fixture.release,otherCache);assert.equal(await readFile(protectedFile,'utf8'),'keep');
  const bad=createAppReleaseClient({verifySignature:fixture.verifySignature,fetch:async()=>new Response(Buffer.from('corrupt'))});
  await assert.rejects(bad.download(fixture.release,join(cache,'bad')),{code:'APP_UPDATE_VERIFICATION_FAILED'});
  const overflow=createAppReleaseClient({verifySignature:fixture.verifySignature,fetch:async()=>new Response(Buffer.alloc(fixtureBytes.length+1))});
  await assert.rejects(overflow.download(fixture.release,join(cache,'overflow')),{code:'APP_UPDATE_VERIFICATION_FAILED'});
});

test('cancelling a download removes partial bytes and does not publish a cached executable',async t=>{
  const cache=await mkdtemp(join(tmpdir(),'release-cancel-r4-'));t.after(()=>rm(cache,{recursive:true,force:true}));
  const fixture=releaseFixture(),controller=new AbortController();
  await assert.rejects(fixture.client.download(fixture.release,cache,{signal:controller.signal,onProgress:()=>controller.abort()}),{code:'APP_UPDATE_CANCELLED'});
  assert.deepEqual(await readdir(cache),[]);
});
