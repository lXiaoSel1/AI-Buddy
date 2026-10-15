import test from 'node:test';
import assert from 'node:assert/strict';
import {MOTION_FIELDS,decodeVector,fieldAt} from '../src/motion-fields.mjs';
test('Packed numeric vectors decode signed fractions across high-byte boundaries',()=>{
 for(const [x,y] of [[0,0],[-.0625,.0625],[-16,33.5],[127.9375,-128]]){const a=x*16+2048,b=y*16+2048;assert.deepEqual(decodeVector(a&255,b&255,(a>>8)|((b>>8)<<4)),[x,y]);}
});
test('Field interpolation decodes before mixing and clamps inside the current atlas tile',()=>{
 const m=MOTION_FIELDS,pixels=new Uint8Array(m.width*m.height*4),pose={row:1,col:2};
 function set(x,y,dx,dy){const a=dx*16+2048,b=dy*16+2048,p=((pose.row*m.gridHeight+y)*m.width+pose.col*m.gridWidth+x)*4;pixels[p]=a&255;pixels[p+1]=b&255;pixels[p+2]=(a>>8)|((b>>8)<<4);pixels[p+3]=255;}
 set(0,0,-.0625,1);set(1,0,.0625,3);set(0,1,-.0625,5);set(1,1,.0625,7);
 assert.deepEqual(fieldAt(pixels,pose,.5+m.stride/2,.5+m.stride/2),[0,4]);
 set(m.gridWidth-1,m.gridHeight-1,9,-4);assert.deepEqual(fieldAt(pixels,pose,1000,1000),[9,-4]);
});
