import {MOTION_MANIFEST as metadata} from './pet-assets.mjs';
import {PET_ATLAS,FRAME_SIZE} from './pet-actions.mjs';
export const MOTION_FIELDS=Object.freeze(metadata);
export function decodeVector(r,g,b){return [(r+(b&15)*256-metadata.bias)/metadata.quantization,(g+(b>>4)*256-metadata.bias)/metadata.quantization];}
export function fieldAt(pixels,pose,x,y){
  const gx=Math.max(0,Math.min(metadata.gridWidth-1,(x-.5)/metadata.stride)),gy=Math.max(0,Math.min(metadata.gridHeight-1,(y-.5)/metadata.stride));
  const ix=Math.floor(gx),iy=Math.floor(gy),tx=gx-ix,ty=gy-iy;
  const point=(dx,dy)=>{const px=pose.col*metadata.gridWidth+Math.min(metadata.gridWidth-1,ix+dx),py=pose.row*metadata.gridHeight+Math.min(metadata.gridHeight-1,iy+dy),p=(py*metadata.width+px)*4;return decodeVector(pixels[p],pixels[p+1],pixels[p+2]);};
  const a=point(0,0),b=point(1,0),c=point(0,1),d=point(1,1);
  return [0,1].map(n=>(a[n]*(1-tx)+b[n]*tx)*(1-ty)+(c[n]*(1-tx)+d[n]*tx)*ty);
}
function atlasAlpha(pixels,pose,x,y){
  if(x<0||y<0||x>=FRAME_SIZE.width||y>=FRAME_SIZE.height)return 0;
  const gx=Math.max(0,Math.min(FRAME_SIZE.width-1,x-.5)),gy=Math.max(0,Math.min(FRAME_SIZE.height-1,y-.5)),ix=Math.floor(gx),iy=Math.floor(gy),tx=gx-ix,ty=gy-iy;
  const alpha=(dx,dy)=>pixels[((pose.row*FRAME_SIZE.height+Math.min(FRAME_SIZE.height-1,iy+dy))*PET_ATLAS.width+pose.col*FRAME_SIZE.width+Math.min(FRAME_SIZE.width-1,ix+dx))*4+3];
  return (alpha(0,0)*(1-tx)+alpha(1,0)*tx)*(1-ty)+(alpha(0,1)*(1-tx)+alpha(1,1)*tx)*ty;
}
export function confidenceAt(pixels,pose,x,y,component){
  const gx=Math.max(0,Math.min(metadata.gridWidth-1,(x-.5)/metadata.stride)),gy=Math.max(0,Math.min(metadata.gridHeight-1,(y-.5)/metadata.stride)),ix=Math.floor(gx),iy=Math.floor(gy),tx=gx-ix,ty=gy-iy;
  const value=(dx,dy)=>pixels[((pose.row*metadata.gridHeight+Math.min(metadata.gridHeight-1,iy+dy))*metadata.width+pose.col*metadata.gridWidth+Math.min(metadata.gridWidth-1,ix+dx))*4+component]/255;
  return (value(0,0)*(1-tx)+value(1,0)*tx)*(1-ty)+(value(0,1)*(1-tx)+value(1,1)*tx)*ty;
}
export function sampleAlpha({atlas,forward,backward},sample,x,y,{flow=true}={}){
  const t=sample.mix||0;
  if(!t)return atlasAlpha(atlas,sample,x,y);
  let ax=x,ay=y,bx=x,by=y;
  for(let n=0;n<(metadata.inverseIterations??3);n++){const a=flow?fieldAt(forward,sample,ax,ay):[0,0],b=flow?fieldAt(backward,sample,bx,by):[0,0];ax=x-t*a[0];ay=y-t*a[1];bx=x-(1-t)*b[0];by=y-(1-t)*b[1];}
  return t<.5?atlasAlpha(atlas,sample,ax,ay):atlasAlpha(atlas,sample.nextPose,bx,by);
}
