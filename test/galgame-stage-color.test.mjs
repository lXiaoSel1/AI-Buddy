import test from 'node:test';
import assert from 'node:assert/strict';
import * as stage from '../src/galgame-redesign.mjs';

function swatch(value){
 const pixels=new Uint8ClampedArray(64*36*4);
 for(let at=0;at<pixels.length;at+=4){
  pixels.fill(at<64*18*4?255:value,at,at+3);
  pixels[at+3]=255;
 }
 return pixels;
}

test('a background is classified using linear sRGB from only its lower half',()=>{
 assert.ok(stage.stageBackgroundLuminance(swatch(29),64,36)<.03,'dark underwater background');
 assert.ok(stage.stageBackgroundLuminance(swatch(235),64,36)>.8,'light study background');
 assert.ok(Math.abs(stage.stageBackgroundLuminance(swatch(128),64,36)-.21586)<.001,'mid-gray is linearized before comparison');
});

test('stage color policy follows the background and keeps matching theme colors',()=>{
 for(const [theme,luminance,scheme] of [
  ['light',.8,'light'],['light',.02,'dark'],['dark',.8,'light'],['dark',.02,'dark'],
  ['dark',.4,'light'],['light',undefined,'light'],['dark',undefined,'dark'],
 ])assert.equal(stage.galgameStageScheme(theme,luminance),scheme);
});
