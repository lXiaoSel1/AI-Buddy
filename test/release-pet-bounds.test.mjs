import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedReleasePetBounds} from '../scripts/release-pet-bounds.mjs';
const displays=[{workArea:{x:0,y:0,width:2560,height:1375}}],settings={preferences:{petScale:1}};
test('A regular visible desktop pet must preserve its live rectangle exactly',()=>{
 const bounds={x:120,y:240,width:270,height:280};assert.deepEqual(expectedReleasePetBounds({petContentBounds:bounds,settings,displays},{petBounds:{x:1,y:2}}),{mode:'visible-content-bounds',bounds});
});
test('The Windows minimized zero rectangle restores the saved position within the current screen',()=>{
 const state={petContentBounds:{x:-21333,y:-21333,width:0,height:0},settings,displays};assert.deepEqual(expectedReleasePetBounds(state,{petBounds:{x:2719,y:1095,width:900,height:900}}),{mode:'saved-normal-bounds',bounds:{x:2290,y:1095,width:270,height:280}});
});
test('A minimized pet uses its selected scale and retains a position on a secondary screen',()=>{
 const state={petContentBounds:{width:0,height:0},settings:{preferences:{petScale:1.5}},displays:[...displays,{workArea:{x:2560,y:0,width:1920,height:1080}}]};assert.deepEqual(expectedReleasePetBounds(state,{petBounds:{x:2800,y:200}}).bounds,{x:2800,y:200,width:405,height:420});
});
test('A missing saved position cannot silently bypass the startup bounds check',()=>{
 assert.throws(()=>expectedReleasePetBounds({petContentBounds:{width:0,height:0},settings,displays},{}),/saved normal position evidence/);
});
