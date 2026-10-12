export const PET_SIZE=Object.freeze({width:270,height:280});
export function petSize(scale=1){
  if(![0.75,1,1.25,1.5].includes(scale))throw new Error('Invalid pet scale');
  return {width:Math.ceil(PET_SIZE.width*scale),height:Math.ceil(PET_SIZE.height*scale)};
}

// Saved/native outer bounds can contain old frame padding or a corrupted size.
// Always position a fresh, fixed client rectangle, never feed its size back in.
export function petBounds(bounds={},scale=1) {
  return {x:Math.round(Number.isFinite(bounds.x)?bounds.x:0),y:Math.round(Number.isFinite(bounds.y)?bounds.y:0),...petSize(scale)};
}
export function petWindowOptions(bounds={},scale=1) {
  const size=petSize(scale);
  return {...petBounds(bounds,scale),useContentSize:true,minWidth:size.width,maxWidth:size.width,minHeight:size.height,maxHeight:size.height,frame:false,thickFrame:false,transparent:true,resizable:false,maximizable:false,fullscreenable:false,alwaysOnTop:true,skipTaskbar:true,focusable:true,show:false,hasShadow:false};
}
export function positionPet(window,bounds,scale=1) {
  const fixed=petBounds(bounds,scale);
  window.setContentBounds(fixed,false);
  return fixed;
}
