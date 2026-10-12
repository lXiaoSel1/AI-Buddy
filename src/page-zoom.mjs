export function lockPageZoom(window,onError=()=>{}){
 const contents=window.webContents;
 const apply=()=>{
  if(contents.isDestroyed())return;
  try{contents.setZoomMode('disabled');void contents.setVisualZoomLevelLimits(1,1).catch(onError);}catch(error){onError(error);}
 };
 apply();contents.on('did-finish-load',apply);
}
