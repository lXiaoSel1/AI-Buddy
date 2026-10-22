export function interactionPresentation(value,{now=Date.now(),speed=.75,hasClip=()=>false,cycle=()=>4000}={}){
  if(!value)return null;
  const nativeElapsed=state=>state.animationWaiting?0:Number.isFinite(state.animationElapsedMs)?state.animationElapsedMs+Math.max(0,now-value.at)*(Number.isFinite(state.snapshotSpeed)?state.snapshotSpeed:speed):((Number(state.elapsedMs)||0)+Math.max(0,now-value.at))*speed;
  const elapsed=nativeElapsed(value);
  const motion=value.motion??{},motionElapsed=nativeElapsed(motion);
  let id=null,at=0,hold=false,staticFrame=null,playing=true;
  if(['pressed','dragging','flying','landing','charging'].includes(motion.mode)){
    hold=true;at=motionElapsed;
    // A thrown pet is already off the ground: the hold shows throw-loop frame 0, and the
    // flight continues that loop from there. The standing throw-start would snap back to the floor.
    if(motion.mode==='flying')id='throw-loop';
    else if(motion.button===0&&['pressed','dragging'].includes(motion.mode)){id=motion.mode==='pressed'?'idle':motion.walkDirection<0?'move-left':'move-right';}
    else if(['pressed','dragging','charging'].includes(motion.mode)){id='throw-loop';at=0;staticFrame=0;playing=false;}
    else if(motion.mode==='landing'){id='land-recover';at=Math.min(at,cycle(id)-.01);}
  }else if(value.phase!=='awake'){
    hold=true;id=({'sleep-enter':'sleep-enter',asleep:'sleep-loop',waking:'wake'})[value.phase];at=elapsed;
    if(id!=='sleep-loop')at=Math.min(at,cycle(id)-.01);
  }
  return {id:hasClip(id)?id:null,elapsed:at,hold,staticFrame,playing,readyScope:['flying','landing'].includes(motion.mode)?'motion':'sleep',animationEpoch:['flying','landing'].includes(motion.mode)?motion.animationEpoch:value.animationEpoch,animationWaiting:['flying','landing'].includes(motion.mode)?motion.animationWaiting:value.animationWaiting,missing:id&&!hasClip(id)?id:null,asleep:value.phase==='asleep',motion:motion.mode};
}

// Clips that can start next, so they are decoded before the switch: a flight ends in a
// landing. (The hold before a throw already decodes throw-loop, which the flight continues.)
// The same frozen list is returned for the same situation.
const NO_PRELOADS=Object.freeze([]),FLIGHT_PRELOADS=Object.freeze(['land-recover']);
export function interactionPreloads(motion){
  return motion?.mode==='flying'?FLIGHT_PRELOADS:NO_PRELOADS;
}

// Original vector artwork, independent from Tencent/QQPet cursor assets.
export function gloveCursor(state='open'){
  const paths=state==='open'?'<path d="M12 17V6q0-3 3-3t3 3v9h1V4q0-3 3-2t2 3v11h1V7q0-3 3-2t2 3v12q0-1 2-1 4 0 1 6l-4 7q-1 2-3 2H14q-3 0-5-3l-5-7q-2-4 1-5 2-1 4 2l3 3z"/>':state==='grab'?'<path d="M9 18v-7q0-4 4-3l1 7V9q0-4 4-3l2 8V9q1-4 5-2l1 9 2-3q3-3 5 1l-4 12-3 7H13l-2-7-6-3q-4-3-1-6 2-2 5 1z"/><path fill="none" d="M13 17l6 2 6-1"/>':'<path d="M9 16v-3q0-4 4-3 0-5 5-3 2-4 6-1 5-1 6 4l1 9q0 2-2 5l-2 7H13l-2-5-5-5q-3-4 0-6 2-1 3 1z"/>';
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><g fill="#fffdf8" stroke="#40576d" stroke-width="1.6" stroke-linejoin="round">'+paths+'<path fill="#e3ecf5" d="M13 31h15v5H13z"/></g></svg>';
  return 'url("data:image/svg+xml,'+encodeURIComponent(svg)+'") 18 16, '+(state==='open'?'pointer':'grabbing');
}
