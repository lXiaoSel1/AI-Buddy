import test from 'node:test';
import assert from 'node:assert/strict';
import {clampToDisplays} from '../src/window-position.mjs';
import {petBounds,positionPet,petWindowOptions} from '../src/pet-window.mjs';
test('Multiple display work areas, mixed DPI in DIP, and removed display recovery',()=>{
 const a={workArea:{x:0,y:0,width:2560,height:1392},scaleFactor:1.5},b={workArea:{x:-1920,y:0,width:1920,height:1080},scaleFactor:1};
 const pet={x:-200,y:1000,width:272,height:280};
 assert.deepEqual(clampToDisplays(pet,[a,b],a),{...pet,x:-272,y:800});
 assert.deepEqual(clampToDisplays(pet,[a],a),{...pet,x:0,y:1000});
 assert.deepEqual(clampToDisplays({...pet,x:5000,y:5000},[a,b],a),{...pet,x:2288,y:1112});
});
test('Restore an expanded old pet at a screen edge without retaining its corrupted size',()=>{
 const display={workArea:{x:0,y:0,width:2560,height:1392},scaleFactor:1.5};
 const saved={x:2500,y:1300,width:1800,height:1200};
 assert.deepEqual(clampToDisplays(petBounds(saved),[display]),{x:2290,y:1112,width:270,height:280});
 assert.deepEqual(petBounds({x:NaN,y:Infinity,width:0,height:0}),{x:0,y:0,width:270,height:280});
});
test('Configured pet scale determines all drag sizes independently of corrupted native bounds',()=>{
 for(const [scale,width,height] of [[.75,203,210],[1,270,280],[1.25,338,350],[1.5,405,420]]){
  const calls=[],window={setContentBounds:(bounds,animate)=>calls.push({bounds,animate})};
  for(let i=0;i<240;i++)positionPet(window,{x:i,y:-i,width:1000+i,height:2000+i},scale);
  assert.ok(calls.every(c=>c.bounds.width===width&&c.bounds.height===height&&!c.animate));
  const options=petWindowOptions({x:-20,y:50},scale);assert.equal(options.minWidth,width);assert.equal(options.maxHeight,height);
  assert.equal(options.resizable,false);assert.equal(options.thickFrame,false);
 }
 assert.throws(()=>petBounds({},10),/scale/);
});
