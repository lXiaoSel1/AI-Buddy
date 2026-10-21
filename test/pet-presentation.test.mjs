import test from 'node:test';
import assert from 'node:assert/strict';
import {PET_CHARACTERS} from '../src/pet-characters.mjs';
import {petPresentation,petActionPresentation,petCollisionInsets} from '../src/pet-presentation.mjs';
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
test('A new clip keeps the idle ground position after a fixed canvas offset without resizing',()=>{
 const idle=petPresentation('deepseek'),clip={actionId:'sleep-enter',anchor:{x:281,y:602},canvas:{width:576,height:624}};
 const shifted=petActionPresentation('deepseek',clip);
 assert.equal(shifted.scale,idle.scale);
 assert.ok(Math.abs(shifted.x+281/3*shifted.scale-(idle.x+276/3*idle.scale))<1e-9);
 assert.ok(Math.abs(shifted.y+602/3*shifted.scale-(idle.y+602/3*idle.scale))<1e-9);
 assert.deepEqual(petActionPresentation('deepseek',{}),idle);
 for(const character of PET_CHARACTERS)assert.deepEqual(petActionPresentation(character.id,{actionId:'idle',anchor:{x:276,y:602},canvas:{width:576,height:624}}),petPresentation(character.id),'Original calibration must stay unchanged: '+character.id);
});
test('All character collision feet match their displayed feet at every pet scale',()=>{
 for(const scale of [.75,1,1.25,1.5])for(const character of PET_CHARACTERS){
  const p=petPresentation(character.id),insets=petCollisionInsets(character.id,scale);
  assert.ok(Object.values(insets).every(n=>Number.isFinite(n)&&n>=0));
  assert.ok(Math.abs(Math.ceil(280*scale)-insets.bottom-(46+p.y+p.sourceFeet/3*p.scale)*scale)<1e-9);
  assert.ok(insets.left+insets.right<Math.ceil(270*scale));
 }
});
test('New samples match the real approved idle body height and keep the same ground anchor',()=>{
 const idle=petPresentation('deepseek'),clip={actionId:'sleep-enter',anchor:{x:281,y:602},canvas:{width:576,height:624},presentationScale:1.125},p=petActionPresentation('deepseek',clip);
 assert.ok(Math.abs(480*p.scale-540*idle.scale)<1e-9);
 assert.ok(Math.abs(p.x+281/3*p.scale-(idle.x+276/3*idle.scale))<1e-9);
 assert.ok(Math.abs(p.y+602/3*p.scale-(idle.y+602/3*idle.scale))<1e-9);
 const scale=1.25,inset=petCollisionInsets('deepseek',scale,{sample:clip}),bodyRight=Math.ceil(270*scale)-inset.right;
 assert.ok(inset.left<=(39+p.x)*scale);assert.ok(bodyRight>=(39+p.x+192*p.scale)*scale-1e-9);
 assert.ok(Math.abs(Math.ceil(280*scale)-inset.bottom-(46+p.y+602/3*p.scale)*scale)<1e-9);
});
