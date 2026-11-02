export const PET_SIZE=Object.freeze({width:270,height:280});
// Electron's Windows `floating` level reorders the activated window behind
// Shell_TrayWnd. A fullscreen taskbar can be non-topmost, demoting the pet too.
// `pop-up-menu` keeps the normal topmost policy without that taskbar reorder.
export function applyPetTopmost(window,enabled,platform=process.platform) {
  if(!window||window.isDestroyed())return false;
  window.setAlwaysOnTop(enabled===true,platform==='win32'?'pop-up-menu':'floating');
  return true;
}
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
  // A taskbar-less pet has no normal minimize affordance or recovery button.
  // This disables that capability; it does not prove the fullscreen bug fixed.
  return {...petBounds(bounds,scale),useContentSize:true,minWidth:size.width,maxWidth:size.width,minHeight:size.height,maxHeight:size.height,frame:false,thickFrame:false,transparent:true,resizable:false,minimizable:false,maximizable:false,fullscreenable:false,alwaysOnTop:true,skipTaskbar:true,focusable:true,show:false,hasShadow:false};
}
export function positionPet(window,bounds,scale=1) {
  const fixed=petBounds(bounds,scale);
  window.setContentBounds(fixed,false);
  return fixed;
}
