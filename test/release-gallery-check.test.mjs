import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyGalleryPlayback} from '../scripts/release-gallery-check.mjs';
function fixture(card,{delay=0,paused=false}={}){
 let elapsed=0;const history=[];
 return {options:{now:()=>elapsed,pause:async ms=>{elapsed+=ms;},timeoutMs:5000,onSample:s=>history.push(s.at(-1)),readState:async()=>({renderer:'canvas-preview-frame-atlas',control:paused?'播放':'暂停',hidden:false,reducedMotion:false,cache:{errors:[]},cards:elapsed<delay?[{id:'jump',draws:0}]:[card(elapsed)]})},history};
}
test('Startup decoding may complete after the old 2.4-second sampling window; require real changing frames afterwards',async()=>{
 const f=fixture(t=>({id:'jump',frame:Math.floor(t/16.667)%43,draws:Math.floor(t/16.667)}),{delay:2700});
 const r=await verifyGalleryPlayback(f.options);assert.ok(r.elapsedMs>2700);assert.ok(r.cards[0].uniqueFrames>=3);assert.ok(r.cards[0].draws>0);
});
test('A permanently frozen frame fails even if phase and draw count advance',async()=>{
 const f=fixture(t=>({id:'jump',frame:0,phase:t,draws:t}));await assert.rejects(verifyGalleryPlayback(f.options),/did not show continuous/);
});
test('A card that never decodes is not silently omitted from the startup check',async()=>{
 const f=fixture(()=>({id:'jump',draws:0}),{delay:10000});await assert.rejects(verifyGalleryPlayback(f.options),/did not show continuous/);
});
test('An existing user pause remains paused without changing preferences',async()=>{
 const f=fixture(()=>({id:'jump',frame:0,draws:1}),{paused:true});assert.equal((await verifyGalleryPlayback(f.options)).paused,true);assert.equal(f.history.length,1);
});
