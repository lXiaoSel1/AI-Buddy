import {PET_ATLAS,FRAME_SIZE,PET_ACTIONS,actionSample} from './pet-actions.mjs';
import {MOTION_FIELDS,sampleAlpha} from './motion-fields.mjs';
import {MOTION_MANIFEST} from './pet-assets.mjs';
import {HdSourceRenderer} from './hd-source-renderer.mjs';
import {WorkingRigRenderer} from './working-rig-renderer.mjs';
import {AllActionRigRenderer} from './all-action-rig-renderer.mjs';
import {V014RigRenderer} from './v014-rig-renderer.mjs';
import {FrameSequenceRenderer} from './frame-sequence-renderer.mjs';
import {VideoSequenceRenderer} from './video-sequence-renderer.mjs';
import {FRAME_SEQUENCES,CHARACTER_SEQUENCES,activatePetCharacter} from './frame-sequence.mjs';
import {PreviewAtlasRenderer,PREVIEW_ATLASES} from './preview-atlas-renderer.mjs';
const load=async src=>{const image=new Image();image.src=src;await image.decode();return image;};
function readPixels(image){const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data;}
const vertex=`attribute vec2 aPosition;attribute vec2 aUv;varying vec2 vUv;void main(){gl_Position=vec4(aPosition,0.,1.);vUv=aUv;}`;
const fragment=`precision highp float;
varying vec2 vUv;uniform sampler2D uAtlas;uniform sampler2D uForward;uniform sampler2D uBackward;uniform vec2 uFrame;uniform vec2 uNext;uniform float uMix;
const vec2 size=vec2(${FRAME_SIZE.width}.,${FRAME_SIZE.height}.);const vec2 atlasSize=vec2(${PET_ATLAS.width}.,${PET_ATLAS.height}.);const vec2 grid=vec2(${MOTION_FIELDS.gridWidth}.,${MOTION_FIELDS.gridHeight}.);const vec2 fieldSize=vec2(${MOTION_FIELDS.width}.,${MOTION_FIELDS.height}.);
vec2 decode(vec4 value){vec3 bytes=floor(value.rgb*255.+.5);return (vec2(bytes.r+mod(bytes.b,16.)*256.,bytes.g+floor(bytes.b/16.)*256.)-${MOTION_FIELDS.bias}.)/${MOTION_FIELDS.quantization}.;}
vec2 vector(sampler2D field,vec2 p){vec2 gp=clamp((p-.5)/${MOTION_FIELDS.stride}.,vec2(0.),grid-1.);vec2 node=floor(gp),weight=fract(gp);vec2 base=uFrame*grid;vec2 a=decode(texture2D(field,(base+node+.5)/fieldSize));vec2 b=decode(texture2D(field,(base+min(node+vec2(1.,0.),grid-1.)+.5)/fieldSize));vec2 c=decode(texture2D(field,(base+min(node+vec2(0.,1.),grid-1.)+.5)/fieldSize));vec2 d=decode(texture2D(field,(base+min(node+1.,grid-1.)+.5)/fieldSize));return mix(mix(a,b,weight.x),mix(c,d,weight.x),weight.y);}
vec4 drawing(vec2 frame,vec2 p){if(p.x<0.||p.y<0.||p.x>=size.x||p.y>=size.y)return vec4(0.);return texture2D(uAtlas,(frame*size+clamp(p,vec2(.5),size-.5))/atlasSize);}
void main(){vec2 p=vUv*size;if(uMix<=0.){gl_FragColor=drawing(uFrame,p);return;}vec2 a=p,b=p;for(int n=0;n<${MOTION_FIELDS.inverseIterations??3};n++){a=p-uMix*vector(uForward,a);b=p-(1.-uMix)*vector(uBackward,b);}gl_FragColor=drawing(uMix<.5?uFrame:uNext,uMix<.5?a:b);}`;
const transitions=PET_ACTIONS.flatMap(a=>a.transitions);
export function presentationSample(sample){return MOTION_MANIFEST.mode!=='hd-source'&&['flow','warp'].includes(transitions[sample.row*PET_ATLAS.columns+sample.col])?sample:{...sample,mix:0};}
class MotionRenderer{
  constructor(){
    this.canvas=document.createElement('canvas');this.canvas.width=FRAME_SIZE.width;this.canvas.height=FRAME_SIZE.height;
    this.targets=new WeakMap();this.backend='loading';this.draws=0;this.error=null;
    this.ready=this.load();
  }
  async load(){
    const [atlas,forward,backward]=await Promise.all([load(PET_ATLAS.src),load(MOTION_FIELDS.forward),load(MOTION_FIELDS.backward)]);
    this.images={atlas,forward,backward};this.pixels={atlas:readPixels(atlas),forward:readPixels(forward),backward:readPixels(backward)};
    try{this.setupGL();this.backend='webgl-motion';}catch(error){this.error=error.message;this.backend='canvas-source';}
    return this;
  }
  setupGL(){
    const gl=this.canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,preserveDrawingBuffer:true,antialias:false,depth:false,stencil:false});if(!gl)throw Error('WebGL unavailable');
    const compile=(kind,source)=>{const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;};
    const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,1,0,0,-1,-1,0,1,1,1,1,0,1,-1,1,1]),gl.STATIC_DRAW);
    for(const [name,offset] of [['aPosition',0],['aUv',8]]){const location=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,16,offset);}
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    for(const [n,name,uniform] of [[0,'atlas','uAtlas'],[1,'forward','uForward'],[2,'backward','uBackward']]){gl.activeTexture(gl.TEXTURE0+n);const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,n?gl.NEAREST:gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,n?gl.NEAREST:gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,this.images[name]);gl.uniform1i(gl.getUniformLocation(program,uniform),n);}
    this.gl=gl;this.uniforms=Object.fromEntries(['uFrame','uNext','uMix'].map(name=>[name,gl.getUniformLocation(program,name)]));
    if(!this.contextListeners){this.contextListeners=true;
      this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.backend='canvas-source';});
      this.canvas.addEventListener('webglcontextrestored',()=>{try{this.setupGL();this.backend='webgl-motion';}catch(error){this.error=error.message;this.backend='canvas-source';}});
    }
  }
  draw(target,sample,{force=false,blendOnly=false,sourceOnly=false}={}){
    if(!this.images)return false;
    sample=presentationSample(sample);
    if(sourceOnly||blendOnly||this.backend!=='webgl-motion')sample={...sample,mix:0};
    const key=`${sample.row}/${sample.col}/${sample.nextPose.row}/${sample.nextPose.col}/${sample.mix.toFixed(5)}/${this.backend}/${blendOnly}`;
    let state=this.targets.get(target);if(!state){target.width=FRAME_SIZE.width;target.height=FRAME_SIZE.height;state={ctx:target.getContext('2d'),key:null};this.targets.set(target,state);}
    if(!force&&state.key===key)return false;
    const ctx=state.ctx;ctx.clearRect(0,0,target.width,target.height);
    if(this.backend==='webgl-motion'&&!blendOnly){const gl=this.gl;gl.uniform2f(this.uniforms.uFrame,sample.col,sample.row);gl.uniform2f(this.uniforms.uNext,sample.nextPose.col,sample.nextPose.row);gl.uniform1f(this.uniforms.uMix,sample.mix);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);ctx.drawImage(this.canvas,0,0);}
    else {ctx.drawImage(this.images.atlas,sample.col*FRAME_SIZE.width,sample.row*FRAME_SIZE.height,FRAME_SIZE.width,FRAME_SIZE.height,0,0,FRAME_SIZE.width,FRAME_SIZE.height);}
    state.key=key;this.draws++;return true;
  }
  alpha(sample,x,y){sample=presentationSample(sample);if(this.backend!=='webgl-motion')sample={...sample,mix:0};return this.pixels?sampleAlpha(this.pixels,sample,x,y):0;}
}
// All cards share one small offscreen WebGL surface. A context per card would
// exceed Chromium's context limit when the sixteen direction thumbnails mount.
const workingRigPilot=typeof location!=='undefined'&&new URLSearchParams(location.search).get('workingRig')==='1';
const query=typeof location!=='undefined'?new URLSearchParams(location.search):new URLSearchParams();
const allActionRigs=query.get('sourcePreview')!=='1'&&(query.get('allActionRigs')==='1'||typeof __ALL_ACTION_RIGS__!=='undefined'&&__ALL_ACTION_RIGS__);
const fiveActionsV014=typeof __FIVE_ACTIONS_V014__!=='undefined'&&__FIVE_ACTIONS_V014__;
const baseRenderer=MOTION_MANIFEST.mode==='hd-source'?(workingRigPilot?new WorkingRigRenderer():fiveActionsV014?new V014RigRenderer():allActionRigs?new AllActionRigRenderer():new HdSourceRenderer({loadSources:!PET_ACTIONS.filter(action=>action.hd).every(action=>FRAME_SEQUENCES[action.id])})):new MotionRenderer();
export let motionRenderer=Object.values(FRAME_SEQUENCES).some(c=>c.backend==='webm-alpha')?new VideoSequenceRenderer(baseRenderer):Object.keys(FRAME_SEQUENCES).length?new FrameSequenceRenderer(baseRenderer):baseRenderer;
export let galleryRenderer=Object.keys(PREVIEW_ATLASES).length?new PreviewAtlasRenderer(baseRenderer):motionRenderer;
export async function prepareCharacterRenderer(characterId){
 const sequences=CHARACTER_SEQUENCES[characterId];
 if(!sequences?.idle)throw Error('角色动作资源未就绪');
 const next=new VideoSequenceRenderer(baseRenderer,{sequences});
 try{
  await next.ready;
  // A thumbnail alone is not enough to replace a working pet. Verify that the
  // destination idle video can decode before committing the character switch.
  const slot=next.prepare(sequences.idle);
  if(!slot.ready)await new Promise((resolve,reject)=>{
   const clear=()=>{clearTimeout(timer);slot.video.removeEventListener('loadeddata',check);slot.video.removeEventListener('error',check);};
   const check=()=>{if(slot.error||slot.closed){clear();reject(Error(slot.error||'角色动作加载已取消'));}else if(slot.ready){clear();resolve();}};
   const timer=setTimeout(()=>{clear();reject(Error('角色动作加载超时'));},15000);
   slot.video.addEventListener('loadeddata',check);slot.video.addEventListener('error',check);check();
  });
  return next;
 }catch(error){next.dispose();throw error;}
}
export function adoptCharacterRenderer(characterId,next){
 activatePetCharacter(characterId);motionRenderer.dispose?.();motionRenderer=next;galleryRenderer=next;
 if(window.frameSequenceInspection)window.frameSequenceInspection.renderer=next;
 if(window.galleryPreviewInspection)window.galleryPreviewInspection.renderer=next;
}
if(Object.keys(PREVIEW_ATLASES).length||motionRenderer instanceof VideoSequenceRenderer)window.galleryPreviewInspection={renderer:galleryRenderer,cache:()=>galleryRenderer.inspect()};
if(motionRenderer.fullFrameSequences)window.frameSequenceInspection={renderer:motionRenderer,actionSample,PET_ACTIONS,cache:()=>motionRenderer.inspect()};
if(workingRigPilot)window.workingRigInspection={renderer:motionRenderer,actionSample,PET_ACTIONS};
if(allActionRigs)window.allRigInspection={renderer:motionRenderer,actionSample,PET_ACTIONS};
