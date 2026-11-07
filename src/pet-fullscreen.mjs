import {execFile,spawn} from 'node:child_process';

const handle=value=>typeof value==='string'&&/^\d{1,20}$/.test(value)?value:null;
const rect=value=>value&&['x','y','width','height'].every(key=>Number.isSafeInteger(value[key]))&&value.width>0&&value.height>0?{x:value.x,y:value.y,width:value.width,height:value.height}:null;
const flags=['visible','minimized','cloaked','maximized','framed','system','topmost'];
function nativeWindow(value){
 if(!value||!handle(value.handle)||!Number.isSafeInteger(value.pid)||value.pid<=0)return null;
 return {handle:value.handle,pid:value.pid,monitor:handle(value.monitor),bounds:rect(value.bounds),frame:rect(value.frame),client:rect(value.client),...Object.fromEntries(flags.map(key=>[key,typeof value[key]==='boolean'?value[key]:null]))};
}
function decode(line){
 if(!line||line.length>4096)return null;
 try{const value=JSON.parse(line);return {foreground:nativeWindow(value.foreground),pet:nativeWindow(value.pet),monitor:rect(value.monitor),foregroundAbovePet:typeof value.foregroundAbovePet==='boolean'?value.foregroundAbovePet:null};}catch{return null;}
}
function fitsMonitor(window,monitor){
 if(!window||!monitor)return false;
 return Math.abs(window.x-monitor.x)<=2&&Math.abs(window.y-monitor.y)<=2&&Math.abs(window.x+window.width-monitor.x-monitor.width)<=2&&Math.abs(window.y+window.height-monitor.y-monitor.height)<=2;
}

export function petVisibility({userVisible,assetsReady,fullscreen,quitting}){
 const hiddenReasons=[];
 if(!userVisible)hiddenReasons.push('user');
 if(!assetsReady)hiddenReasons.push('assets-not-ready');
 if(fullscreen)hiddenReasons.push('fullscreen');
 if(quitting)hiddenReasons.push('quitting');
 return {visible:hiddenReasons.length===0,hiddenReasons};
}

export function createPetFullscreenPolicy({ownerPid=process.pid,now=()=>performance.now(),settleMs=300,onChange}){
 let hidden=false,pending=null;
 function apply(value){pending=null;if(value!==hidden){hidden=value;onChange(value);}}
 return {observe(sample){
  const {foreground,pet,monitor}=sample??{};
  // A browser can retain WS_MAXIMIZE while F11 removes its native frame.
  const borderless=foreground?.maximized===false||foreground?.framed===false;
  const candidate=!!(foreground&&foreground.pid!==ownerPid&&foreground.visible===true&&foreground.minimized===false&&foreground.cloaked===false&&borderless&&foreground.system===false&&foreground.monitor&&foreground.monitor===pet?.monitor&&fitsMonitor(foreground.frame??foreground.bounds,monitor)&&fitsMonitor(foreground.client,monitor));
  if(candidate===hidden){pending=null;return;}
  const identity=candidate?`${foreground.handle}/${foreground.monitor}`:null;
  const at=now();
  if(!pending||pending.identity!==identity){pending={identity,at};return;}
  if(at-pending.at>=settleMs)apply(candidate);
 },reset(){apply(false);}};
}

export function readPetFullscreenSnapshot({path,handle:windowHandle}){
 if(process.platform!=='win32'||!handle(windowHandle))return Promise.resolve(null);
 return new Promise(resolve=>execFile(path,[windowHandle],{windowsHide:true,timeout:1800,maxBuffer:4096},(error,stdout)=>resolve(error?null:decode(stdout))));
}

export function createPetFullscreenObserver({path,handle:windowHandle,onSample,onError}){
 if(!handle(windowHandle))throw Error('Invalid native pet handle');
 const child=spawn(path,[windowHandle,'watch'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
 let buffer='',closed=false,failed=false;
 function report(){if(!closed&&!failed){failed=true;onError();}}
 child.once('error',report);child.once('exit',report);child.stdin.on('error',report);
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',value=>{
  if(closed||failed)return;
  buffer+=value;let end;
  while((end=buffer.indexOf('\n'))>=0){const sample=decode(buffer.slice(0,end));buffer=buffer.slice(end+1);if(sample)onSample(sample);}
  if(buffer.length>4096)buffer='';
 });
 return {sample(){if(!closed&&!failed&&child.stdin.writable)child.stdin.write('\n');},close(){if(!closed){closed=true;child.stdin.end();}}};
}
