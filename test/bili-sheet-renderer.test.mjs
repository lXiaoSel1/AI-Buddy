import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {previewDimensions,createBiliSheetRenderer} from '../src/bili-sheet-renderer.mjs';
import {pageEventScript} from '../src/dsh-platform/client-host.mjs';
const png=(w,h)=>{const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
test('preview dimensions reject compressed-image bombs and unknown formats before decoding',async()=>{
 assert.deepEqual(previewDimensions(png(1600,900)),{width:1600,height:900});for(const b of [png(16384,16384),png(0,1),Buffer.from('not an image')])assert.throws(()=>previewDimensions(b),{code:'BILI_VISION_IMAGE_INVALID'});
 let decoded=0;const render=createBiliSheetRenderer({createFromBuffer(){decoded++;},createFromBitmap(){}});await assert.rejects(render({cells:[{bytes:png(16384,16384)}]}),{code:'BILI_VISION_IMAGE_INVALID'});assert.equal(decoded,0);
});
test('storyboard compositor uses actual crop pixels and fixed bounded output',async()=>{
 let output,decodes=0;const image={isEmpty:()=>false,getSize:()=>({width:2,height:2}),crop:r=>{assert.ok(r.x+r.width<=2);return {resize:({width,height})=>({toBitmap:()=>Buffer.alloc(width*height*4,70)})};}};
 const render=createBiliSheetRenderer({createFromBuffer:()=>{decodes++;return image;},createFromBitmap:(b,size)=>{output={b,size};return {toPNG:()=>Buffer.from('encoded-raster')};}}),bytes=png(2,2);
 assert.equal((await render({cells:Array.from({length:9},()=>({bytes,crop:{x:0,y:0,width:2,height:2}}))})).toString(),'encoded-raster');assert.equal(decodes,1);assert.equal(output.b.length,1009*620*4);assert.ok(output.b.includes(70));assert.deepEqual(output.size,{width:1009,height:620,scaleFactor:1});await assert.rejects(render({cells:[{bytes,crop:{x:1,y:0,width:2,height:2}}]}),{code:'BILI_VISION_IMAGE_INVALID'});
});
test('reading window events retain only a validated activity identity, never executable input',()=>{
 const events=[],document={documentElement:{dataset:{}}},window={dispatchEvent:e=>events.push(e)};class CustomEvent{constructor(type,init){this.type=type;this.detail=init?.detail;}}
 vm.runInNewContext(pageEventScript('ai-buddy:bili-reading-open',{activityId:'activity-1',url:'file:///secret',code:'evil()'}),{document,window,CustomEvent});assert.equal(document.documentElement.dataset.buddyReadingActivity,'activity-1');assert.equal(events[0].detail.activityId,'activity-1');assert.equal(Object.keys(events[0].detail).length,1);
 for(const activityId of ['x";evil()', '../file', '', 'x'.repeat(161)])assert.throws(()=>pageEventScript('ai-buddy:bili-reading-open',{activityId}));assert.throws(()=>pageEventScript('ai-buddy:social-accounts-changed',{activityId:'x'}));
});
