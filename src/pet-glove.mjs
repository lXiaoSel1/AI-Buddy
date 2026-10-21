// Native cursor artwork has a fixed logical size, independent of pet/video scale.
export const GLOVE_HOTSPOT=Object.freeze({x:8,y:8});
export const GLOVE_DURATION_MS=200;
export const POKE_FRAME_TIMES=Object.freeze(Array.from({length:10},(_,index)=>index*20));
export const GLOVE_STATES=Object.freeze(['open','closed','grab',...Array.from({length:10},(_,index)=>`poke-${String(index).padStart(2,'0')}`)]);
const EXTENSIONS=Object.freeze([0,.5,1,1,1,.8,.6,.4,.2,0]);
const ACTIVE_MOTIONS=new Set(['dragging','charging','flying','landing']);

export function gloveCursorV2(state='open',{baseUrl='./assets/pet-glove-v2',highDpi=true}={}){
  if(state==='default')return 'default';
  if(!['open','closed','grab'].includes(state)&&!/^poke-0[0-9]$/.test(state))throw new Error('Invalid glove cursor state');
  const path=baseUrl.replace(/\/$/,''),fallback=state==='open'?'pointer':'grabbing';
  const image=highDpi?`image-set(url("${path}/${state}.png") 1x, url("${path}/${state}@2x.png") 2x)`:`url("${path}/${state}.png")`;
  return `${image} ${GLOVE_HOTSPOT.x} ${GLOVE_HOTSPOT.y}, ${fallback}`;
}

// Retain these Image objects for the renderer lifetime. Decoding all possible
// cursor frames up front avoids a system-arrow flash on the first rapid poke,
// including after a per-monitor density change. A failed frame never rejects
// the public readiness promise or silently enables an incomplete animation.
export function preloadGloveArtwork({baseUrl='./assets/pet-glove-v2',highDpi=true,ImageClass=globalThis.Image,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const images=[],path=baseUrl.replace(/\/$/,''),names=GLOVE_STATES.flatMap(state=>highDpi?[`${state}.png`,`${state}@2x.png`]:[`${state}.png`]);
  const ready=Promise.all(names.map(async name=>{
    let image,timeout;
    try{
      image=new ImageClass();images.push(image);
      // One deadline covers both network/file loading and decoding. decode()
      // itself can stall; clearing the timer at onload would leave ready hung.
      const deadline=new Promise((resolve,reject)=>{timeout=setTimer(()=>reject(new Error('image load/decode timeout')),10000);});
      const loaded=new Promise((resolve,reject)=>{
        image.onload=resolve;image.onerror=()=>reject(new Error('image load failed'));
        try{
          image.src=`${path}/${name}`;
          if(image.complete)image.naturalWidth>0?resolve():reject(new Error('empty image'));
        }catch(error){reject(error);}
      });
      await Promise.race([loaded.then(async()=>{
        image.onload=null;image.onerror=null;
        if(typeof image.decode==='function')await image.decode();
        if(!(image.naturalWidth>0))throw new Error('empty image');
      }),deadline]);
      return null;
    }catch{return name;}
    finally{if(timeout!==undefined)clearTimer(timeout);if(image){image.onload=null;image.onerror=null;}}
  })).then(results=>{
    const failures=results.filter(Boolean);
    return {artReady:failures.length===0,artError:failures.length?`Cursor artwork unavailable: ${failures.join(', ')}`:null};
  });
  return {images,ready};
}

// This clock deliberately uses neither animationSpeed nor the video clock.
// Only a main-process-confirmed touch may start a poke. DOM click is not input.
export class PetGloveController{
  constructor({now=()=>performance.now(),wallNow=()=>Date.now(),baseUrl='./assets/pet-glove-v2',highDpi=true}={}){
    this.now=now;this.wallNow=wallNow;this.cursorOptions={baseUrl,highDpi};
    this.context={opaque:false,down:false,mode:'rest',characterId:null,visible:true,reducedMotion:false,artReady:true,artError:null};
    this.gestures=new Map();this.events=new Set();this.lastGestureId=null;this.poke=null;
    this.pokeCount=0;this.lastEventId=null;this.reason='initial';
  }
  setContext(value={}){
    const previous=this.context;this.context={...previous,...value};
    if(previous.characterId!==this.context.characterId)this.cancel('character-change');
    else if(!this.context.artReady)this.cancel('art-unavailable');
    else if(!this.context.visible)this.cancel('hidden');
    else if(!this.context.opaque&&!this.context.down)this.cancel('outside-contour');
    else if(ACTIVE_MOTIONS.has(this.context.mode))this.cancel('motion-priority');
    return this.sample();
  }
  beginGesture(id,{characterId=this.context.characterId,startedAt=this.wallNow()}={}){
    if(typeof id!=='string'||!id||this.gestures.has(id))return false;
    // Retain the visible extension just long enough to bridge a rapid tap.
    const extension=this.sample().extension;
    this.poke=null;this.context.down=true;this.lastGestureId=id;
    this.gestures.set(id,{characterId,startedAt,released:false,cancelled:false,confirmed:false,extension});
    while(this.gestures.size>64)this.gestures.delete(this.gestures.keys().next().value);
    this.reason='pressed';return true;
  }
  releaseGesture(id,{reason='released'}={}){
    const gesture=this.gestures.get(id);if(!gesture)return false;
    if(reason==='released')gesture.released=true;else gesture.cancelled=true;
    if(this.lastGestureId===id)this.context.down=false;
    if(reason!=='released'&&this.lastGestureId===id)this.cancel(reason);return true;
  }
  cancel(reason='cancelled'){
    const gesture=this.gestures.get(this.lastGestureId);if(gesture)gesture.cancelled=true;
    if(this.poke||this.context.down||gesture&&!gesture.released)this.reason=reason;
    this.poke=null;
  }
  touch(value){
    if(value?.source!=='touch'||typeof value.eventId!=='string'||!value.eventId||typeof value.gestureId!=='string')return false;
    if(this.events.has(value.eventId))return false;
    this.events.add(value.eventId);while(this.events.size>128)this.events.delete(this.events.values().next().value);
    const gesture=this.gestures.get(value.gestureId),context=this.context;
    if(!gesture||gesture.cancelled||gesture.confirmed||!gesture.released||value.gestureId!==this.lastGestureId||value.characterId!==context.characterId||gesture.characterId!==value.characterId)return false;
    if(!Number.isFinite(value.capturedAt)||!Number.isFinite(value.confirmedAt)||value.confirmedAt<value.capturedAt||Math.abs(value.capturedAt-gesture.startedAt)>2000||Math.abs(this.wallNow()-value.confirmedAt)>1500)return false;
    if(!context.artReady||!context.visible||!context.opaque||context.down||ACTIVE_MOTIONS.has(context.mode))return false;
    gesture.confirmed=true;this.poke={at:this.now(),extension:gesture.extension,reducedMotion:context.reducedMotion,eventId:value.eventId};
    this.lastEventId=value.eventId;this.pokeCount++;this.reason='confirmed-touch';return true;
  }
  sample(now=this.now()){
    let frame=null,extension=0;
    if(this.poke){
      const elapsed=Math.max(0,now-this.poke.at),duration=this.poke.reducedMotion?80:GLOVE_DURATION_MS;
      if(elapsed>=duration){this.poke=null;this.reason='completed';}
      else if(this.poke.reducedMotion){frame=3;extension=1;}
      else if(elapsed<40){
        extension=this.poke.extension+(1-this.poke.extension)*elapsed/40;
        // Continuing from an extended pose avoids snapping back on rapid taps.
        frame=extension>=.9?2:extension>=.25?1:0;
      }else if(elapsed<100){frame=2+Math.floor((elapsed-40)/20);extension=1;}
      else {frame=5+Math.min(4,Math.floor((elapsed-100)/20));extension=EXTENSIONS[frame];}
    }
    const context=this.context;
    const cursorState=!context.artReady||!context.visible||!context.opaque?'default':context.down?(['dragging','charging'].includes(context.mode)?'grab':'closed'):frame!==null?'poke':'open';
    if(cursorState!=='poke'){frame=null;extension=0;}
    const cursorCss=gloveCursorV2(cursorState==='poke'?`poke-${String(frame).padStart(2,'0')}`:cursorState,this.cursorOptions);
    return {cursorState,state:cursorState,pokeCount:this.pokeCount,lastEventId:this.lastEventId,eventId:this.lastEventId,frame,cursorCss,reason:this.reason,extension,active:cursorState==='poke',startedAt:this.poke?.at??null,hotspot:{...GLOVE_HOTSPOT},artReady:context.artReady,artError:context.artError};
  }
}
