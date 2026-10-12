import {WorkingRigRenderer} from './working-rig-renderer.mjs';
import {PET_ACTIONS,PET_ATLAS,FRAME_SIZE} from './pet-actions.mjs';
import {ACTION_RIGS,phaseOf,expressionState,jointPose,actionPose,actionPoint,actionPointInto,meshNodes,meshIndices} from './action-rigs.mjs';
import {smooth,TAU} from './working-rig.mjs';
const W=384,H=416;
const canvas=()=>{const c=document.createElement('canvas');c.width=W;c.height=H;return c;};
const clone=image=>{const c=canvas();c.getContext('2d').drawImage(image,0,0);return c;};
const frameAction=sample=>PET_ACTIONS.find(a=>{const i=sample.row*PET_ATLAS.columns+sample.col;return i>=a.startFrame&&i<a.startFrame+a.frames;});
const distance=(x,y,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);};
function limbMask(image,bone,{leg=false,index=0,fold=false}={}){
 const c=clone(image),ctx=c.getContext('2d',{willReadFrequently:true}),pixels=ctx.getImageData(0,0,W,H),original=new Uint8ClampedArray(pixels.data),mask=new Uint8Array(W*H);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const i=(y*W+x)*4,r=pixels.data[i],g=pixels.data[i+1],b=pixels.data[i+2];
  const skin=r>150&&r>g*1.045&&g>b*1.025,white=r>195&&g>185&&b>165,dark=r<48&&g<65&&b<110;
  const root=leg?y>bone.pivot[1]+10:true,side=fold?(index===0?x<196:x>=196):true;
  const inside=distance(x,y,bone.pivot,bone.end)<bone.radius&&root&&side&&(leg||skin||white||dark);
  mask[y*W+x]=inside?pixels.data[i+3]:0;
  if(!inside){pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=pixels.data[i+3]=0;}
 }
 const seed=new Uint8Array(mask);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const k=y*W+x;if(seed[k])continue;let near=false;for(let dy=-2;dy<=2&&!near;dy++)for(let dx=-2;dx<=2;dx++)if(seed[k+dy*W+dx]){near=true;break;}if(near){mask[k]=original[k*4+3];for(let n=0;n<4;n++)pixels.data[k*4+n]=original[k*4+n];}}
 ctx.putImageData(pixels,0,0);return {canvas:c,mask,bone};
}
function removePart(base,part,donor){
 const ctx=base.getContext('2d',{willReadFrequently:true}),a=ctx.getImageData(0,0,W,H),d=donor?.getContext('2d',{willReadFrequently:true}).getImageData(0,0,W,H).data;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  let marked=false;for(let dy=-1;dy<=1&&!marked;dy++)for(let dx=-1;dx<=1;dx++){const q=(y+dy)*W+x+dx;if(x+dx>=0&&x+dx<W&&y+dy>=0&&y+dy<H&&part.mask[q]>0){marked=true;break;}}
  if(!marked)continue;const i=(y*W+x)*4;if(d){
   for(let n=0;n<4;n++)a.data[i+n]=d[i+n];
  }else a.data[i]=a.data[i+1]=a.data[i+2]=a.data[i+3]=0;
 }
 ctx.putImageData(a,0,0);
}
function patch(base,source,sourceCenter,targetCenter,radii){
 const [rx,ry]=radii,[tx,ty]=targetCenter,[sx,sy]=sourceCenter,c=canvas(),ctx=c.getContext('2d');
 ctx.drawImage(source,sx-rx,sy-ry,rx*2,ry*2,tx-rx,ty-ry,rx*2,ry*2);
 const pixels=ctx.getImageData(0,0,W,H);for(let y=Math.max(0,Math.floor(ty-ry));y<Math.min(H,ty+ry);y++)for(let x=Math.max(0,Math.floor(tx-rx));x<Math.min(W,tx+rx);x++){const q=((x-tx)/rx)**2+((y-ty)/ry)**2;pixels.data[(y*W+x)*4+3]*=1-smooth(.65,1,q);}ctx.putImageData(pixels,0,0);base.getContext('2d').drawImage(c,0,0);
}
function eyePatch(base,source,sourceCenter,eye){
 const [x,y,rx,ry]=eye,c=canvas(),ctx=c.getContext('2d');ctx.drawImage(source,sourceCenter[0]-25,sourceCenter[1]-23,50,46,x-rx,y-ry,rx*2,ry*2);
 const pixels=ctx.getImageData(0,0,W,H);for(let py=Math.max(0,Math.floor(y-ry));py<Math.min(H,y+ry);py++)for(let px=Math.max(0,Math.floor(x-rx));px<Math.min(W,x+rx);px++){const q=((px-x)/rx)**2+((py-y)/ry)**2;pixels.data[(py*W+px)*4+3]*=1-smooth(.78,1,q);}ctx.putImageData(pixels,0,0);base.getContext('2d').drawImage(c,0,0);
}
function faceBounds(image){
 const a=image.getContext('2d',{willReadFrequently:true}).getImageData(0,0,W,H).data,mask=new Uint8Array(W*H),seen=new Uint8Array(mask.length);let best={count:0,bounds:[140,120,245,212]};
 for(let y=80;y<228;y++)for(let x=65;x<315;x++){const i=(y*W+x)*4;if(a[i+3]>128&&a[i]>160&&a[i]>a[i+1]*1.055&&a[i+1]>a[i+2]*1.055)mask[y*W+x]=1;}
 for(let i=0;i<mask.length;i++){if(!mask[i]||seen[i])continue;const stack=[i],b=[W,H,0,0];seen[i]=1;let count=0;while(stack.length){const k=stack.pop(),x=k%W,y=Math.floor(k/W);count++;b[0]=Math.min(b[0],x);b[1]=Math.min(b[1],y);b[2]=Math.max(b[2],x);b[3]=Math.max(b[3],y);for(const q of [k-1,k+1,k-W,k+W])if(q>=0&&q<mask.length&&!seen[q]&&mask[q]){seen[q]=1;stack.push(q);}}if(count>best.count)best={count,bounds:b};}return best.bounds;
}
const vertex=`attribute vec2 aPosition;attribute vec2 aUv;varying vec2 vUv;void main(){vUv=aUv;gl_Position=vec4(aPosition/vec2(384.,416.)*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);}`;
const fragment=`precision highp float;varying vec2 vUv;uniform sampler2D uImage;uniform vec2 uFilter;void main(){gl_FragColor=(texture2D(uImage,vUv+uFilter)+texture2D(uImage,vUv-uFilter)+texture2D(uImage,vUv+vec2(uFilter.x,-uFilter.y))+texture2D(uImage,vUv+vec2(-uFilter.x,uFilter.y)))*.25;}`;
export class AllActionRigRenderer extends WorkingRigRenderer{
 constructor(){super();this.workingRigPilot=false;this.allActionsRig=true;this.actionRigReady=false;this.actionDraws={};this.nodes=meshNodes();this.indices=meshIndices();this.buffers=new Float32Array(this.nodes.length*4);const parent=this.ready;
  this.ready=parent.then(()=>{this.prepare();this.actionStage=canvas();this.setupActionGL();this.actionStage.addEventListener('webglcontextlost',e=>{e.preventDefault();this.actionRigReady=false;this.backend='canvas-hd-rig-unavailable';for(const target of this.activeTargets)this.invalidate(target);});this.actionStage.addEventListener('webglcontextrestored',()=>{try{this.setupActionGL();for(const target of this.activeTargets)this.invalidate(target);}catch(error){this.error=error.message;}});return this;}).catch(error=>{this.error=error.message;this.actionRigReady=false;this.backend='canvas-hd-rig-unavailable';return this;});
 }
 prepare(){this.rigs={};for(const [id,cfg] of Object.entries(ACTION_RIGS)){
  const needed=new Set(cfg.look?Array.from({length:24},(_,n)=>n):[cfg.mother,...(cfg.armKeys??[]).map(k=>k.frame),...(cfg.jump?[6,10]:cfg.fail?[0,23]:id==='waiting'?[12]:[])]);
  const frames=Array.from({length:24},(_,frame)=>{if(!needed.has(frame))return null;const c=canvas();c.getContext('2d').drawImage(this.images.pages[id],frame%8*W,Math.floor(frame/8)*H,W,H,0,0,W,H);return c;}),base=clone(frames[cfg.mother]),parts=new Map();
  if(cfg.arms&&!cfg.meshLimbs)for(let index=0;index<cfg.arms.length;index++){
   const framesNeeded=new Set([cfg.mother,...(cfg.armKeys??[]).map(k=>k.frame)]);for(const frame of framesNeeded){const k=cfg.armKeys?.find(k=>k.frame===frame),bone={...cfg.arms[index],end:k?.ends[index]??cfg.arms[index].end},part=limbMask(frames[frame],bone,{index,fold:id==='waiting'&&frame===0});parts.set('arm/'+index+'/'+frame,part);}
   const alternate=id==='waiting'?12:id==='jump'?6:id==='fail'?0:19,donor=frames[alternate];removePart(base,parts.get('arm/'+index+'/'+cfg.mother),donor);
  }
  if(cfg.legs&&!cfg.meshLimbs)for(let index=0;index<cfg.legs.length;index++){const part=limbMask(frames[0],cfg.legs[index],{leg:true,index});parts.set('leg/'+index,part);removePart(base,part,null);}
  const variants={open:base};for(const [state,source] of [['half',this.halfEye],['closed',this.closedEye]]){const v=clone(base);(cfg.eyes??[]).forEach((eye,n)=>eyePatch(v,source,[n===1?state==='half'?223:224:state==='half'?162:160,state==='half'?210:215],eye));variants[state]=v;}
  if(cfg.fail){variants.cry=base;for(const [state,frame,offset] of [['fear',0,[0,0]],['sad',23,[-1,2]]]){const v=clone(base);patch(v,frames[frame],[192+offset[0],213+offset[1]],[192,213],[58,35]);variants[state]=v;}}
  if(cfg.jump){const v=clone(base);cfg.eyes.forEach((eye,n)=>eyePatch(v,frames[10],[n?226:163,178],eye));patch(v,frames[10],[194,198],[195,223],[15,11]);variants.joy=v;}
  // Direction drawings retain their complete hair contours. Anatomical
  // registration deforms the original image; cutting it at the neck would
  // truncate long hair and create a horizontal seam during turns.
  if(cfg.look)for(let frame=0;frame<24;frame++)variants['look/'+frame]=frames[frame];
  this.rigs[id]={cfg,frames,parts,variants,lookBounds:cfg.look?frames.map(faceBounds):null};
 } }
 setupActionGL(){const gl=this.actionStage.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true,depth:false,stencil:false});if(!gl)throw Error('Action rigs need WebGL');const compile=(kind,source)=>{const s=gl.createShader(kind);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
  this.actionBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.actionBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.buffers.byteLength,gl.DYNAMIC_DRAW);for(const [name,offset] of [['aPosition',0],['aUv',8]]){const p=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,16,offset);}const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,this.indices,gl.STATIC_DRAW);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);gl.uniform1i(gl.getUniformLocation(program,'uImage'),0);this.actionFilter=gl.getUniformLocation(program,'uFilter');for(const rig of Object.values(this.rigs)){rig.textures={};for(const [name,image] of Object.entries(rig.variants)){const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);rig.textures[name]=texture;}}
  this.actionGL=gl;this.actionRigReady=true;this.backend='canvas-hd-all-action-rigs';
 }
 draw(target,sample,{force=false,sourceOnly=false,referenceOnly=false}={}){
  const action=frameAction(sample),id=action?.id;
  if(id==='working'){const result=super.draw(target,sample,{force,sourceOnly,referenceOnly});if(this.actionRigReady&&this.rigReady)this.backend='canvas-hd-all-action-rigs';this.lastActionState={id,t:phaseOf(sample),expression:['open','half','closed'][this.eyeState??0],stage:null};return result;}
  if(sourceOnly||referenceOnly||!this.actionRigReady)return super.draw(target,sample,{force,sourceOnly,referenceOnly});
  const rig=this.rigs[id];if(!rig)return super.draw(target,sample,{force,sourceOnly,referenceOnly});
  this.backend='canvas-hd-all-action-rigs';
  // Exact native drawings for the fixed sixteen direction buttons.
  if(id==='look'&&sample.nextPose.row===sample.row&&sample.nextPose.col===sample.col){const result=super.draw(target,sample,{force});this.lastAlpha={target,sample};return result;}
  const state=this.targetState(target),t=phaseOf(sample),pose=actionPose(rig.cfg,t),key=`all-rig/${id}/${t.toFixed(7)}/${target.width}/${target.height}`;if(!force&&state.key===key)return false;
  let variant=expressionState(id,t),registration=null;
  if(id==='look'){const a=sample.frame,b=(a+1)%24,mix=sample.mix??0,nearest=mix<.5?a:b;variant='look/'+nearest;const ab=rig.lookBounds[a],bb=rig.lookBounds[b],sb=rig.lookBounds[nearest],bounds=ab.map((v,n)=>v+(bb[n]-v)*mix),clamp=(v,l,h)=>Math.max(l,Math.min(h,v)),sx=clamp((bounds[2]-bounds[0])/(sb[2]-sb[0]),.98,1.02),sy=clamp((bounds[3]-bounds[1])/(sb[3]-sb[1]),.98,1.02),cx=(sb[0]+sb[2])/2,cy=(sb[1]+sb[3])/2;registration={sx,sy,dx:cx*(1-sx)+clamp((bounds[0]+bounds[2])/2-cx,-5,5),dy:cy*(1-sy)+clamp((bounds[1]+bounds[3])/2-cy,-5,5)};}
  const point=(x,y)=>{const q=actionPoint(rig.cfg,pose,x,y);if(registration){const h=1-smooth(215,306,y);q[0]+=h*(x*(registration.sx-1)+registration.dx);q[1]+=h*(y*(registration.sy-1)+registration.dy);}return q;};
  for(let n=0;n<this.nodes.length;n++){const node=this.nodes[n],x=node[0],y=node[1],i=n*4;actionPointInto(rig.cfg,pose,x,y,this.buffers,i);if(registration){const h=1-smooth(215,306,y);this.buffers[i]+=h*(x*(registration.sx-1)+registration.dx);this.buffers[i+1]+=h*(y*(registration.sy-1)+registration.dy);}this.buffers[i+2]=x/W;this.buffers[i+3]=y/H;}
  const gl=this.actionGL;if(this.actionStage.width!==target.width||this.actionStage.height!==target.height){this.actionStage.width=target.width;this.actionStage.height=target.height;this.rigResizes++;}gl.viewport(0,0,target.width,target.height);gl.bindBuffer(gl.ARRAY_BUFFER,this.actionBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,this.buffers);gl.bindTexture(gl.TEXTURE_2D,rig.textures[variant]??rig.textures.open);gl.uniform2f(this.actionFilter,.25*Math.max(0,W/target.width-1)/W,.25*Math.max(0,H/target.height-1)/H);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawElements(gl.TRIANGLES,this.indices.length,gl.UNSIGNED_SHORT,0);
  const ctx=state.ctx;ctx.clearRect(0,0,target.width,target.height);
  const limb=(part,angle,scale=1)=>{const p=point(...part.bone.pivot);ctx.save();ctx.scale(target.width/W,target.height/H);ctx.translate(...p);ctx.rotate(angle);ctx.scale(scale,scale);ctx.translate(-part.bone.pivot[0],-part.bone.pivot[1]);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(part.canvas,0,0);ctx.restore();};
  if(rig.cfg.legs&&!rig.cfg.meshLimbs)rig.cfg.legs.forEach((leg,index)=>limb(rig.parts.get('leg/'+index),(index?1:-1)*.43*Math.sin(TAU*t),1));
  ctx.save();ctx.imageSmoothingEnabled=false;ctx.drawImage(this.actionStage,0,0);ctx.restore();
  if(rig.cfg.arms&&!rig.cfg.meshLimbs)rig.cfg.arms.forEach((_,index)=>{const joint=jointPose(rig.cfg,t,index),part=rig.parts.get('arm/'+index+'/'+joint.sourceFrame);let angle=joint.angle;if(rig.cfg.fail)angle+=pose.quiver*.01;limb(part,angle,joint.scale);});
  state.key=key;this.draws++;this.rigDraws++;this.actionDraws[id]=(this.actionDraws[id]??0)+1;this.lastAlpha={target,sample};this.lastActionState={id,t,expression:variant,stage:pose.stage};return true;
 }
 alpha(sample,x,y){const id=frameAction(sample)?.id;if(id==='working')return super.alpha(sample,x,y);if(!this.actionRigReady||!this.lastAlpha)return super.alpha(sample,x,y);if(x<0||y<0||x>=FRAME_SIZE.width||y>=FRAME_SIZE.height)return 0;
  // Read the actual composed contour: arms, legs, fixed direction and body use
  // one hit-test result, including Canvas antialiasing on rotating limb edges.
  const target=this.lastAlpha.target,px=Math.min(target.width-1,Math.floor(x/FRAME_SIZE.width*target.width)),py=Math.min(target.height-1,Math.floor(y/FRAME_SIZE.height*target.height));return this.targets.get(target).ctx.getImageData(px,py,1,1).data[3];
 }
}
