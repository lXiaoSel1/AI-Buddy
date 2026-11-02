// A decoder being loaded is not evidence that its requested frame was drawn.
// Deliberate reduced-motion stills are allowed; cold-loading placeholders are not.
export function interactionFrameStatus({expected,displayed,slot,resource,reducedMotion=false}={}){
 if(!expected||typeof resource!=='string'||!resource||slot?.resource!==resource||slot.closed)return {ready:false,failed:false};
 if(slot.error)return {ready:false,failed:true};
 const matching=displayed?.actionId===expected.id&&displayed.displayedResource===resource;
 if(!matching)return {ready:false,failed:false};
 if(reducedMotion)return {ready:displayed.displayedSource==='still'&&displayed.displayedReducedMotion===true,failed:false};
 return {ready:!!(slot.ready&&!slot.seekPending&&slot.video?.readyState>=2&&displayed.displayedSource==='video'),failed:false};
}
