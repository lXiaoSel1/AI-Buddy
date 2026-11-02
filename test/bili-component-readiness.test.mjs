import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createBiliMedia} from '../src/buddy-plugin-services/bili-media.mjs';
import {createBiliFullMedia} from '../src/buddy-plugin-services/bili-full-media.mjs';
import {createBiliVision} from '../src/buddy-plugin-services/bili-vision.mjs';
const missing=()=>Object.assign(Error('component required'),{code:'FFMPEG_COMPONENT_REQUIRED'});
async function root(t){const value=await mkdtemp(join(tmpdir(),'bili-component-gate-'));t.after(async()=>{assert.ok(resolve(value).startsWith(resolve(tmpdir())+sep));await rm(value,{recursive:true,force:true});});return value;}
test('missing verified executable stops legacy media before playback, download or FFmpeg spawn',async t=>{const directory=await root(t);let playback=0,downloads=0;const acquire=createBiliMedia({tools:directory,tempRoot:join(directory,'jobs'),resolveVerifiedExecutable:async()=>{throw missing();},playback:async()=>playback++,download:async()=>downloads++});await assert.rejects(acquire({video:{duration:30},windows:[],check:async()=>{}}),{code:'FFMPEG_COMPONENT_REQUIRED'});assert.equal(playback,0);assert.equal(downloads,0);assert.deepEqual(await readdir(directory),[]);});
test('full video media preserves component readiness errors before playback, proxy or worker creation',async()=>{let playback=0,fetches=0;const acquire=createBiliFullMedia({resolveVerifiedExecutable:async()=>{throw missing();},playback:async()=>playback++,fetchImpl:async()=>fetches++,validateUrl:value=>value});await assert.rejects(acquire({video:{duration:30},check:async()=>{}}),{code:'FFMPEG_COMPONENT_REQUIRED'});assert.equal(playback,0);assert.equal(fetches,0);});
test('available platform preview metadata cannot swallow a component requirement into a usable reading',async t=>{const directory=await root(t),vision=createBiliVision({directory,renderSheet:async()=>Buffer.alloc(0),analyzeFrames:async()=>[],fetchImpl:async()=>Response.json({code:0,data:{image:['https://i0.hdslb.com/fixture.jpg'],img_x_len:2,img_y_len:1,img_x_size:160,img_y_size:90,index:[0,15]}}),acquireMedia:async()=>{throw missing();}});t.after(()=>vision.close());await assert.rejects(vision.prepare({scope:{pluginId:'bili'},video:{videoId:'BV12345678',cid:1,duration:30},readingId:'component-gate'}),{code:'FFMPEG_COMPONENT_REQUIRED'});assert.deepEqual(await readdir(join(directory,'readings')),[]);});
