import assert from 'node:assert/strict';

// First paint can overlap profile/log indexing. Observe actual per-card frames
// within a bounded startup window; phase advancement alone is not playback.
export async function verifyGalleryPlayback({readState,pause,now=Date.now,timeoutMs=20000,onSample=()=>{}}){
 const started=now(),samples=[],intervals=[137,223,311,179,263,197];
 while(now()-started<timeoutMs){
  const state=await readState();samples.push({atMs:now()-started,...state});await onSample(samples);
  assert.ok(['canvas-preview-frame-atlas','canvas-transparent-webm'].includes(state.renderer));assert.deepEqual(state.cache?.errors??[],[]);
  if(state.control!=='暂停')return {paused:true,systemReducedMotion:state.reducedMotion};
  if(!state.hidden&&state.cards.length){
   const evidence=state.cards.map(card=>{
    const rows=samples.flatMap(sample=>sample.cards?.filter(row=>row.id===card.id&&Number.isInteger(row.frame))??[]);
    return {id:card.id,uniqueFrames:new Set(rows.map(row=>row.frame)).size,draws:rows.length?rows.at(-1).draws-rows[0].draws:0,frames:rows.map(row=>row.frame)};
   });
   if(now()-started>=1500&&evidence.every(row=>row.uniqueFrames>=3&&row.draws>0))return {elapsedMs:now()-started,cards:evidence};
  }
  await pause(intervals[(samples.length-1)%intervals.length]);
 }
 const last=samples.at(-1);throw Error('Gallery did not show continuous per-card playback before the startup deadline: '+JSON.stringify({hidden:last?.hidden,cards:last?.cards,samples:samples.length}));
}
