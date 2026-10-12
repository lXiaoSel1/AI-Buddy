import {PET_ATLAS,FRAME_SIZE,PET_ACTIONS} from './pet-actions.mjs';
const load=async src=>{const image=new Image();image.src=src;await image.decode();return image;};
const sourceActions=PET_ACTIONS.filter(action=>action.hd);
const frameActions=sourceActions.flatMap(action=>Array(action.frames).fill(action));
function alphaPlane(image){const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;const alpha=new Uint8Array(rgba.length/4);for(let n=0;n<alpha.length;n++)alpha[n]=rgba[n*4+3];return alpha;}

// Native poses are sampled once into a canvas matching its final screen pixels.
// No low-resolution staging canvas, optical warp, dissolve, or half-phase flip.
export class HdSourceRenderer{
  constructor({loadSources=true}={}){this.loadSources=loadSources;this.targets=new WeakMap();this.activeTargets=new Set();this.backend='loading';this.draws=0;this.error=null;this.geometryReads=0;
    this.observer=new ResizeObserver(entries=>{for(const entry of entries)this.invalidate(entry.target);});
    const dirty=()=>{for(const target of this.activeTargets)this.invalidate(target);};
    window.addEventListener('resize',dirty);window.visualViewport?.addEventListener('resize',dirty);
    const dpi=()=>{this.dpiQuery?.removeEventListener('change',dpi);dirty();this.dpiQuery=matchMedia(`(resolution: ${devicePixelRatio}dppx)`);this.dpiQuery.addEventListener('change',dpi);};dpi();
    this.ready=this.load();
  }
  async load(){const actions=this.loadSources?sourceActions:[],[atlas,...pages]=await Promise.all([load(PET_ATLAS.src),...actions.map(a=>load(a.hd.src))]);
    this.images={atlas,pages:Object.fromEntries(actions.map((a,n)=>[a.id,pages[n]]))};
    this.pixels={atlas:true,alpha:Object.fromEntries(actions.map((a,n)=>[a.id,alphaPlane(pages[n])]))};this.backend='canvas-hd-source';return this;
  }
  invalidate(target){const state=this.targets.get(target);if(state){state.dirty=true;state.key=null;}}
  release(target){if(!target)return;this.observer.unobserve(target);this.activeTargets.delete(target);this.targets.delete(target);}
  targetState(target){let state=this.targets.get(target);if(!state){state={ctx:target.getContext('2d'),dirty:true,key:null};this.targets.set(target,state);this.activeTargets.add(target);this.observer.observe(target);}
    if(state.dirty){this.geometryReads++;const rect=target.getBoundingClientRect();const width=Math.max(1,Math.round((rect.width||FRAME_SIZE.width)*devicePixelRatio)),height=Math.max(1,Math.round((rect.height||FRAME_SIZE.height)*devicePixelRatio));
      if(target.width!==width||target.height!==height){target.width=width;target.height=height;state.ctx.imageSmoothingEnabled=true;state.ctx.imageSmoothingQuality='high';}state.dirty=false;state.key=null;
    }return state;
  }
  draw(target,sample,{force=false,sourceOnly=false}={}){if(!this.images||!target)return false;
    const state=this.targetState(target),index=sample.row*PET_ATLAS.columns+sample.col,action=frameActions[index];if(!action)throw Error('Invalid source frame');
    const frame=index-action.startFrame,key=`${index}/${sourceOnly}/${target.width}/${target.height}`;if(!force&&state.key===key)return false;
    const ctx=state.ctx;ctx.clearRect(0,0,target.width,target.height);
    if(sourceOnly||!this.loadSources)ctx.drawImage(this.images.atlas,sample.col*FRAME_SIZE.width,sample.row*FRAME_SIZE.height,FRAME_SIZE.width,FRAME_SIZE.height,0,0,target.width,target.height);
    else {const hd=action.hd;ctx.drawImage(this.images.pages[action.id],(frame%hd.columns)*hd.frameWidth,Math.floor(frame/hd.columns)*hd.frameHeight,hd.frameWidth,hd.frameHeight,0,0,target.width,target.height);}
    state.key=key;this.draws++;return true;
  }
  alpha(sample,x,y){if(!this.pixels||x<0||y<0||x>=FRAME_SIZE.width||y>=FRAME_SIZE.height)return 0;
    const index=sample.row*PET_ATLAS.columns+sample.col,action=frameActions[index],frame=index-action.startFrame,hd=action.hd,alpha=this.pixels.alpha[action.id];
    const px=Math.max(0,Math.min(hd.frameWidth-1,x*hd.frameWidth/FRAME_SIZE.width-.5)),py=Math.max(0,Math.min(hd.frameHeight-1,y*hd.frameHeight/FRAME_SIZE.height-.5)),x0=Math.floor(px),y0=Math.floor(py),fx=px-x0,fy=py-y0;
    const sampleAt=(dx,dy)=>alpha[(Math.floor(frame/hd.columns)*hd.frameHeight+Math.min(hd.frameHeight-1,y0+dy))*hd.width+(frame%hd.columns)*hd.frameWidth+Math.min(hd.frameWidth-1,x0+dx)];
    return (sampleAt(0,0)*(1-fx)+sampleAt(1,0)*fx)*(1-fy)+(sampleAt(0,1)*(1-fx)+sampleAt(1,1)*fx)*fy;
  }
}
