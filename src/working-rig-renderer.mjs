import {HdSourceRenderer} from './hd-source-renderer.mjs';
import {PET_ACTIONS,PET_ATLAS,FRAME_SIZE} from './pet-actions.mjs';
import {WORKING_RIG,rigMesh,rigPhase,rigPose,rigEyeState,rigInverse,workingVertex} from './working-rig.mjs';
const working=PET_ACTIONS.find(a=>a.id==='working');
const isWorking=sample=>{const index=sample.row*PET_ATLAS.columns+sample.col;return index>=working.startFrame&&index<working.startFrame+working.frames;};
const fragment=`precision highp float;varying vec2 vUv;uniform sampler2D uMother;uniform sampler2D uHalfEye;uniform sampler2D uClosedEye;uniform float uEyeState;uniform vec2 uFilter;
vec4 drawing(vec2 uv){vec4 base=texture2D(uMother,uv);if(uEyeState<.5)return base;
 vec2 p=uv*vec2(384.,416.);vec2 center=p.x<192.?vec2(163.,199.):vec2(220.,199.);vec2 q=(p-center)/vec2(25.,23.);float mask=1.-smoothstep(.78,1.,dot(q,q));
 if(mask<=0.)return base;
 vec2 offset=uEyeState<1.5?(p.x<192.?vec2(-1.,11.):vec2(3.,11.)):(p.x<192.?vec2(-3.,16.):vec2(4.,16.));
 vec2 eyeUv=(p+offset)/vec2(384.,416.);vec4 eye=uEyeState<1.5?texture2D(uHalfEye,eyeUv):texture2D(uClosedEye,eyeUv);
 // Local skin/eyelash registration only. Keep the mother's alpha contour exactly.
 return vec4(mix(base.rgb,eye.rgb,mask),base.a);
}
void main(){gl_FragColor=(drawing(vUv+uFilter)+drawing(vUv-uFilter)+drawing(vUv+vec2(uFilter.x,-uFilter.y))+drawing(vUv+vec2(-uFilter.x,uFilter.y)))*.25;}`;
export class WorkingRigRenderer extends HdSourceRenderer{
  constructor(){super();this.workingRigPilot=true;this.rigDraws=0;this.rigResizes=0;this.rigReady=false;this.poseCache=null;const original=this.ready;
    this.ready=original.then(async()=>{[this.mother,this.halfEye,this.closedEye]=await Promise.all(['mother','half-eye','closed-eye'].map(async name=>{const img=new Image();img.src='./assets/working-rig-'+name+'.png';await img.decode();if(img.naturalWidth!==WORKING_RIG.width||img.naturalHeight!==WORKING_RIG.height)throw Error('Working rig texture dimensions differ');return img;}));
      const c=document.createElement('canvas');c.width=WORKING_RIG.width;c.height=WORKING_RIG.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(this.mother,0,0);const rgba=ctx.getImageData(0,0,c.width,c.height).data;this.motherAlpha=new Uint8Array(c.width*c.height);for(let n=0;n<this.motherAlpha.length;n++)this.motherAlpha[n]=rgba[n*4+3];
      this.stage=document.createElement('canvas');this.setupRig();this.stage.addEventListener('webglcontextlost',event=>{event.preventDefault();this.rigReady=false;this.backend='canvas-hd-rig-unavailable';for(const target of this.activeTargets)this.invalidate(target);});
      this.stage.addEventListener('webglcontextrestored',()=>{try{this.setupRig();for(const target of this.activeTargets)this.invalidate(target);}catch(error){this.error=error.message;}});return this;}).catch(error=>{this.error=error.message;this.rigReady=false;this.backend='canvas-hd-rig-unavailable';return this;});
  }
  setupRig(){const gl=this.stage.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true,depth:false,stencil:false});if(!gl)throw Error('Working rig needs WebGL');
    const compile=(kind,source)=>{const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;};
    const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,workingVertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const mesh=rigMesh(),buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,mesh,gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,8,0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    for(const [unit,name,uniform] of [[0,'mother','uMother'],[1,'halfEye','uHalfEye'],[2,'closedEye','uClosedEye']]){const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,this[name]);gl.uniform1i(gl.getUniformLocation(program,uniform),unit);}
    this.gl=gl;this.vertexCount=mesh.length/2;this.uniforms=Object.fromEntries(['uHead','uArms','uDetail','uTailSin','uFilter','uEyeState'].map(name=>[name,gl.getUniformLocation(program,name)]));this.rigReady=true;this.backend='canvas-hd-working-rig';
  }
  pose(sample){const phase=rigPhase(sample);if(this.poseCache?.phase!==phase)this.poseCache={phase,pose:rigPose(phase)};return this.poseCache;}
  draw(target,sample,{force=false,sourceOnly=false,referenceOnly=false}={}){
    if(!isWorking(sample)||sourceOnly||referenceOnly||!this.rigReady)return super.draw(target,sample,{force,sourceOnly});
    const state=this.targetState(target),{phase,pose}=this.pose(sample),key=`working-rig/${phase.toFixed(7)}/${target.width}/${target.height}`;if(!force&&state.key===key)return false;
    const gl=this.gl;if(this.stage.width!==target.width||this.stage.height!==target.height){this.stage.width=target.width;this.stage.height=target.height;this.rigResizes++;}gl.viewport(0,0,target.width,target.height);
    // A small source-footprint filter only when downsampling; never accumulate
    // a previous frame or resize the already rendered image for the next frame.
    this.filter=[.25*Math.max(0,WORKING_RIG.width/target.width-1),.25*Math.max(0,WORKING_RIG.height/target.height-1)];gl.uniform2f(this.uniforms.uFilter,this.filter[0]/WORKING_RIG.width,this.filter[1]/WORKING_RIG.height);
    this.eyeState=rigEyeState(phase);gl.uniform1f(this.uniforms.uEyeState,this.eyeState);gl.uniform4fv(this.uniforms.uHead,pose.head);gl.uniform4fv(this.uniforms.uArms,pose.arms);gl.uniform4fv(this.uniforms.uDetail,pose.detail);gl.uniform1f(this.uniforms.uTailSin,pose.tailSin);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,this.vertexCount);
    const ctx=state.ctx;ctx.clearRect(0,0,target.width,target.height);ctx.save();ctx.imageSmoothingEnabled=false;ctx.drawImage(this.stage,0,0);ctx.restore();state.key=key;this.draws++;this.rigDraws++;return true;
  }
  alpha(sample,x,y){if(!isWorking(sample)||!this.rigReady)return super.alpha(sample,x,y);if(x<0||y<0||x>=FRAME_SIZE.width||y>=FRAME_SIZE.height)return 0;
    const p=rigInverse(x*WORKING_RIG.width/FRAME_SIZE.width,y*WORKING_RIG.height/FRAME_SIZE.height,this.pose(sample).pose);if(!p)return 0;
    const value=(x,y)=>{const px=Math.max(0,Math.min(WORKING_RIG.width-1,x-.5)),py=Math.max(0,Math.min(WORKING_RIG.height-1,y-.5)),ix=Math.floor(px),iy=Math.floor(py),fx=px-ix,fy=py-iy;const at=(dx,dy)=>this.motherAlpha[Math.min(WORKING_RIG.height-1,iy+dy)*WORKING_RIG.width+Math.min(WORKING_RIG.width-1,ix+dx)];return (at(0,0)*(1-fx)+at(1,0)*fx)*(1-fy)+(at(0,1)*(1-fx)+at(1,1)*fx)*fy;};
    const [fx,fy]=this.filter??[0,0];return (value(p[0]+fx,p[1]+fy)+value(p[0]-fx,p[1]-fy)+value(p[0]+fx,p[1]-fy)+value(p[0]-fx,p[1]+fy))*.25;
  }
}
