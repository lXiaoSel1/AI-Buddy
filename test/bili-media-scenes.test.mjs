import test from 'node:test';import assert from 'node:assert/strict';
import {mediaUrl,representativeFrames,sceneTimes,transcriptRows} from '../src/buddy-plugin-services/bili-media.mjs';
test('chooses actual shot changes between regular samples and keeps separate windows',()=>{
 const rows=sceneTimes('frame:0 pts_time:0\nlavfi.scene_score=0\nframe:1 pts_time:0.2\nlavfi.scene_score=0.8',4);
 assert.deepEqual(rows,[{time:0,score:0},{time:.2,score:.8}]);
 const frames=Array.from({length:80},(_,i)=>({time:i/2,score:i===37?.95:.01}));const picks=representativeFrames(frames,10,25);
 assert.equal(picks.length,12);assert.ok(picks.some(x=>x.time===18.5));assert.ok(picks.every(x=>x.time>=10&&x.time<25));});
test('does not send credentials to a media CDN or accept foreign source URLs',()=>{for(const u of ['file:///tmp/x','https://bilivideo.com.attacker.org/x','https://a:b@asset.bilivideo.com/x','https://127.0.0.1/x'])assert.throws(()=>mediaUrl(u));assert.ok(mediaUrl('https://upos-hz-mirrorakam.akamaized.net/x'));});
test('local speech uses bounded timestamps and drops markup-only non-speech segments',()=>{const rows=transcriptRows({transcription:[{text:'[Music]',offsets:{from:0,to:50}},{text:'你好',offsets:{from:500,to:2100}}]},2);assert.deepEqual(rows,[{id:'speech:1',start:.5,end:2,text:'你好'}]);});
