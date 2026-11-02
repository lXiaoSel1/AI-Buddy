const tag=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9:._-]{0,95}$/i.test(value)?value:'unspecified';
const bools=(value,keys)=>Object.fromEntries(keys.filter(key=>typeof value?.[key]==='boolean').map(key=>[key,value[key]]));
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<1e12;
const rect=value=>value&&['x','y','width','height'].every(key=>finite(value[key]))?Object.fromEntries(['x','y','width','height'].map(key=>[key,value[key]])):null;
const copy=value=>structuredClone(value);
const pid=value=>Number.isSafeInteger(value)&&value>0?value:null;
const handle=value=>Buffer.isBuffer(value)&&(value.length===4||value.length===8)?(value.length===8?value.readBigUInt64LE():BigInt(value.readUInt32LE())).toString():null;

/** Read-only diagnostics. It never shows, focuses, restores or reorders a window. */
export function createPetWindowDiagnostics(getPet,audit=()=>{},options={}){
 if(typeof getPet!=='function')throw Error('Pet window getter is required');
 const {now=Date.now,getExpected=()=>({}),getInteraction=()=>({}),getMainPID=()=>process.pid}=options,limit=Number.isSafeInteger(options.limit)&&options.limit>0?Math.min(1024,options.limit):256,auditLimit=Number.isSafeInteger(options.auditLimit)&&options.auditLimit>=0?Math.min(4096,options.auditLimit):256;
 const records=[];let sequence=0,lastReason='startup',closed=false,audited=0,suppressed=0,auditFailures=0;
 function read(){
  const errors=[],safe=(name,read,convert=value=>value)=>{try{return convert(read());}catch{errors.push(name);return null;}},mainPID=safe('mainPID',getMainPID,pid);
  let win;try{win=getPet();}catch{return {exists:false,destroyed:null,mainPID,readErrors:[...errors,'window']};}
  if(!win)return {exists:false,destroyed:null,mainPID,readErrors:errors};
  const get=(name,method,convert=value=>value)=>safe(name,()=>win[method](),convert);
  const destroyed=get('destroyed','isDestroyed',Boolean),state={exists:true,id:safe('id',()=>win.id,value=>Number.isSafeInteger(value)?value:null),mainPID,destroyed};
  if(destroyed!==false)return {...state,readErrors:errors};
  for(const [name,method]of [['visible','isVisible'],['minimized','isMinimized'],['focused','isFocused'],['focusable','isFocusable'],['minimizable','isMinimizable'],['alwaysOnTop','isAlwaysOnTop']])state[name]=get(name,method,value=>typeof value==='boolean'?value:null);
  state.bounds=get('bounds','getBounds',rect);state.contentBounds=get('contentBounds','getContentBounds',rect);
  // Electron returns the pointer as bytes. Keep an exact decimal string instead
  // of coercing a 64-bit HWND through a potentially lossy JavaScript Number.
  state.nativeHandle=safe('nativeHandle',()=>typeof win.getNativeWindowHandle==='function'?win.getNativeWindowHandle():null,handle);
  state.rendererPID=safe('rendererPID',()=>{const contents=win.webContents;return typeof contents?.getOSProcessId==='function'?contents.getOSProcessId():null;},pid);
  state.readErrors=errors;return state;
 }
 function expected(value){return bools(value,['visible','petVisible','alwaysOnTop','assetsReady','suspended','quitting']);}
 function interaction(value){const result=bools(value,['gestureMode','ignoringMouse','dragging']);if(typeof value?.gestureId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value.gestureId))result.gestureId=value.gestureId;if(typeof value?.motion==='string')result.motion=tag(value.motion);return result;}
 function renderer(value){const result=bools(value,['hidden','hasFocus']);if(['visible','hidden','prerender'].includes(value?.visibilityState))result.visibilityState=value.visibilityState;for(const field of ['draws','renderAt'])if(finite(value?.[field]))result[field]=value[field];return result;}
 function safeGet(fn){try{return fn();}catch{return {};}}
 return {
  reason(value){lastReason=tag(value);return lastReason;},
  snapshot(){return {...read(),expected:expected(safeGet(getExpected)),interaction:interaction(safeGet(getInteraction)),lastReason,sequence,audited,suppressed,auditFailures,disposed:closed};},
  record(event,detail={}){
   if(closed)return null;
   const row={type:'pet-window-state',sequence:++sequence,at:now(),event:tag(event),reason:detail.reason?tag(detail.reason):lastReason,native:read(),expected:expected(detail.expected??safeGet(getExpected)),interaction:interaction(detail.interaction??safeGet(getInteraction))};
   if(detail.renderer)row.renderer=renderer(detail.renderer);
   if(detail.renderGone){row.renderGone={reason:tag(detail.renderGone.reason),...(Number.isInteger(detail.renderGone.exitCode)?{exitCode:detail.renderGone.exitCode}:{})};}
   records.push(row);if(records.length>limit)records.splice(0,records.length-limit);
   // runtime-audit.jsonl has a separate owner. Cap this observer's contribution
   // per process while retaining the latest ring for an explicit state capture.
   if(audited<auditLimit){audited++;try{audit(copy(row));}catch{auditFailures++;}}else suppressed++;
   return copy(row);
  },
  recent(){return copy(records);},
  dispose(){closed=true;},
 };
}
