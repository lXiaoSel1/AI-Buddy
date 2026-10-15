import test from 'node:test';
import assert from 'node:assert/strict';
import {PET_CHARACTERS} from '../src/pet-characters.mjs';
import {petPresentation} from '../src/pet-presentation.mjs';
test('All eleven pets have matching visible idle height and feet while DeepSeek stays unchanged',()=>{
 const base=petPresentation('deepseek');assert.equal(base.factor,1);
 assert.ok(Math.abs(base.x-13.44)<1e-9);assert.ok(Math.abs(base.y-14.56)<1e-9);
 for(const character of PET_CHARACTERS){const p=petPresentation(character.id);
  assert.ok(Math.abs(p.sourceHeight*p.scale/3-541*.86/3)<1e-9,character.id);
  assert.ok(Math.abs(46+p.y+p.sourceFeet*p.scale/3-(46+base.y+602*.86/3))<1e-9,character.id);
  assert.ok(39+p.x>=0&&46+p.y>=0&&39+p.x+192*p.scale<=270&&46+p.y+208*p.scale<=280,character.id+' full motion canvas remains inside the pet window');
 }
 assert.deepEqual(petPresentation('unknown'),base);
});
