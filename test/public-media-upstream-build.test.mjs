import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {upstreamMediaMode,stageUpstreamMediaBuild,validateUpstreamMediaBuild,upstreamMediaMarker} from '../scripts/media-upstream-build.mjs';
import {temporary} from './support/public-distribution-fixtures.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url));
test('upstream mode is explicit and keeps the private kit interface available',()=>{
 assert.equal(upstreamMediaMode([]),false);assert.equal(upstreamMediaMode(['--bili-ffmpeg=x','--bili-ffmpeg-license=y']),false);assert.equal(upstreamMediaMode(['--bili-ffmpeg-upstream']),true);
});
for(const value of ['--bili-media-tools=x','--bili-ffmpeg=x','--bili-ffmpeg-license=x','--bili-ffmpeg-upstream=other'])test('upstream flag rejects ambiguous media input '+value,()=>assert.throws(()=>upstreamMediaMode(['--bili-ffmpeg-upstream',value])));
function fixture(t){const root=temporary(t);stageUpstreamMediaBuild(repo,root);fs.writeFileSync(path.join(root,'ffmpeg-component-worker.mjs'),'isolated fixture worker');return root;}
test('public media build contains exact pinned notices and no bundled executable or archive',t=>{
 const root=fixture(t);assert.deepEqual(validateUpstreamMediaBuild(repo,root),upstreamMediaMarker());
 assert.deepEqual(fs.readdirSync(root).sort(),['bili-ffmpeg-upstream.json','bili-media-mode.json','ffmpeg-component-worker.mjs','media-notices'].sort());
 assert.deepEqual(fs.readdirSync(path.join(root,'media-notices/ffmpeg')).sort(),['LICENSE','README.txt']);assert.equal(fs.existsSync(path.join(root,'bili-media')),false);
});
for(const name of ['bili-media-mode.json','bili-ffmpeg-upstream.json','media-notices/ffmpeg/LICENSE','media-notices/ffmpeg/README.txt'])test('public upstream mode rejects changed '+name,t=>{const root=fixture(t);fs.writeFileSync(path.join(root,name),'{}');assert.throws(()=>validateUpstreamMediaBuild(repo,root));});
test('public upstream mode requires its own worker',t=>{const root=fixture(t);fs.unlinkSync(path.join(root,'ffmpeg-component-worker.mjs'));assert.throws(()=>validateUpstreamMediaBuild(repo,root));});
