import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseVoiceAssetDownloads,extractVoiceAssetArchive} from '../src/voice/asset-downloads.mjs';
import {FFMPEG_COMPONENT_DESCRIPTOR as pinned} from '../src/media-components/ffmpeg-descriptor.mjs';

function delivery(){
  const descriptor={files:pinned.files.map(file=>({path:'ffmpeg/'+file.path,bytes:file.bytes,sha256:file.sha256}))};
  const descriptorHash=createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  const metadata={schemaVersion:1,assetsSha256:descriptorHash,archives:[{id:'gpt-ffmpeg-upstream',format:'pinned-ffmpeg-zip',url:pinned.url,bytes:pinned.bytes,sha256:pinned.sha256,files:descriptor.files.map(file=>file.path)}]};
  return {descriptor,descriptorHash,metadata};
}
test('voice delivery can obtain exactly the three pinned FFmpeg files from the official upstream archive',()=>{
  const {descriptor,descriptorHash,metadata}=delivery();
  const result=parseVoiceAssetDownloads(JSON.stringify(metadata),{descriptor,descriptorHash});
  assert.deepEqual(result.archives[0].files.map(file=>file.path),['ffmpeg/ffmpeg.exe','ffmpeg/LICENSE','ffmpeg/README.txt']);
  assert.equal(result.downloadBytes,266085149);
});
for(const [name,change] of [
  ['URL',row=>row.url='https://example.com/ffmpeg.zip'],
  ['archive hash',row=>row.sha256='0'.repeat(64)],
  ['archive size',row=>row.bytes++],
  ['selected output',row=>row.files.pop()],
])test('pinned FFmpeg transport rejects a changed '+name,()=>{
  const {descriptor,descriptorHash,metadata}=delivery();change(metadata.archives[0]);
  assert.throws(()=>parseVoiceAssetDownloads(JSON.stringify(metadata),{descriptor,descriptorHash}));
});
test('pinned FFmpeg transport rejects component files that differ from the upstream pins',()=>{
  const {descriptor,descriptorHash,metadata}=delivery();descriptor.files[0].sha256='0'.repeat(64);
  assert.throws(()=>parseVoiceAssetDownloads(JSON.stringify(metadata),{descriptor,descriptorHash}));
});
test('pinned FFmpeg extraction refuses a replacement archive before producing any component',async t=>{
  const root=await mkdtemp(join(tmpdir(),'voice-pinned-ffmpeg-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'invalid.zip');await writeFile(path,Buffer.from('not the signed upstream archive'));
  const {descriptor,descriptorHash,metadata}=delivery();
  const [archive]=parseVoiceAssetDownloads(JSON.stringify(metadata),{descriptor,descriptorHash}).archives;
  await assert.rejects(extractVoiceAssetArchive(path,root,archive));
  assert.deepEqual(await readdir(root),['invalid.zip']);
});
