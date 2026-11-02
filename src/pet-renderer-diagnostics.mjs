/**
 * Explicit page-info query only. It reads the existing renderer inspection
 * facade and DOM; it never renders, schedules work or changes window state.
 * Keep the established page-info.pet fields unchanged for external probes.
 */
function petRendererDiagnostic(){
 const errors=[],read=(field,get,fallback=null)=>{try{const value=get();return value===undefined?fallback:value;}catch{if(errors.length<24&&!errors.includes(field))errors.push(field);return fallback;}};
 const count=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<1e12?value:null;
 const dimension=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<1e7?value:null;
 const backend=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9:._-]{0,63}$/i.test(value)?value:null;
 const bool=value=>typeof value==='boolean'?value:null;
 const rect=selector=>{const node=document.querySelector(selector);return node?node.getBoundingClientRect().toJSON():null;};
 const result={
  width:read('width',()=>innerWidth),height:read('height',()=>innerHeight),
  scale:read('scale',()=>getComputedStyle(document.body).transform),
  badgeHidden:read('badgeHidden',()=>document.querySelector('.badge')?.hidden),
  sprite:read('sprite',()=>{const node=document.querySelector('.sprite');return node?getComputedStyle(node).backgroundPosition:null;}),
  spriteRect:read('spriteRect',()=>rect('.sprite')),badgeRect:read('badgeRect',()=>rect('.badge')),
  input:read('input',()=>window.petInputDiagnostic),action:read('action',()=>window.petActionDiagnostic),
 };
 const live={
  queriedAt:read('queriedAt',()=>{const value=Date.now();return Number.isSafeInteger(value)&&value>=0?value:null;}),
  documentHidden:read('documentHidden',()=>bool(document.hidden)),
  visibilityState:read('visibilityState',()=>['visible','hidden','prerender'].includes(document.visibilityState)?document.visibilityState:null),
  hasFocus:read('hasFocus',()=>bool(document.hasFocus())),canvases:[],
  renderer:{backend:null,targets:null,decoders:null,playing:null,draws:null},errors,
 };
 const canvases=read('canvases',()=>document.querySelectorAll('canvas'));
 const canvasCount=canvases?read('canvases',()=>count(canvases.length),0):0;
 for(let index=0;index<Math.min(canvasCount??0,4);index++){
  const node=read('canvases',()=>canvases[index]);if(!node)continue;const size={};
  for(const field of ['width','height','clientWidth','clientHeight'])size[field]=read('canvases.'+field,()=>dimension(node[field]));
  live.canvases.push(size);
 }
 const renderer=read('renderer',()=>window.frameSequenceInspection?.renderer);
 if(renderer){
  const inspection=read('renderer.inspect',()=>typeof renderer.inspect==='function'?renderer.inspect():null);
  live.renderer.backend=read('renderer.backend',()=>backend(inspection?.backend??renderer.backend));
  for(const field of ['targets','decoders','playing'])live.renderer[field]=read('renderer.'+field,()=>count(inspection?.[field]));
  live.renderer.draws=read('renderer.draws',()=>count(renderer.draws));
 }
 result.live=live;return result;
}

export const PET_RENDERER_DIAGNOSTIC_SCRIPT=`(${petRendererDiagnostic.toString()})()`;
