import React, {useLayoutEffect,useRef,useState} from 'react'
import {CHARACTER_BOUNDS} from '../character-bounds.generated.mjs'
import {CHARACTER_EXPRESSIONS} from '../character-expressions.generated.mjs'

// Fit the visible silhouette rather than the variable transparent padding.
// Source PNGs remain untouched; a small transparent guard preserves antialiasing.
export function CharacterPortrait({src,spriteKey,alt,className='',align='bottom',onError,registration,viewport}:any){
 const canvas=useRef<HTMLCanvasElement>(null),bounds=CHARACTER_BOUNDS[spriteKey]
 useLayoutEffect(()=>{
  if((!bounds&&!registration)||!canvas.current)return
  const node=canvas.current,image=new Image();let closed=false
  node.dataset.ready='false';delete node.dataset.bounds
  node.getContext('2d')?.clearRect(0,0,node.width,node.height)
  const draw=()=>{
   if(closed||!image.complete||!image.naturalWidth)return
   const box=node.getBoundingClientRect(),dpr=window.devicePixelRatio||1
   node.width=Math.max(1,Math.round(box.width*dpr));node.height=Math.max(1,Math.round(box.height*dpr))
   const [l,t,r,b]=registration?viewport:bounds.visibleBounds,guard=registration?0:5,x=registration?l:Math.max(0,l-guard),y=registration?t:Math.max(0,t-guard)
   const w=registration?r-l:Math.min(image.width,r+guard)-x,h=registration?b-t:Math.min(image.height,b+guard)-y
   const scale=Math.min(node.width/w,node.height/h)*.97,dx=(node.width-w*scale)/2,dy=align==='top'?0:node.height-h*scale
   const ctx=node.getContext('2d');ctx?.clearRect(0,0,node.width,node.height)
   if(registration)ctx?.drawImage(image,dx+(registration.x-x)*scale,dy+(registration.y-y)*scale,image.width*registration.scale*scale,image.height*registration.scale*scale)
   else ctx?.drawImage(image,x,y,w,h,dx,dy,w*scale,h*scale)
   node.dataset.ready='true';node.dataset.bounds=JSON.stringify({x:dx/dpr,y:dy/dpr,width:w*scale/dpr,height:h*scale/dpr})
  }
  image.onload=draw;image.onerror=()=>onError?.();image.src=src
  const observer=new ResizeObserver(draw);observer.observe(node)
  return()=>{closed=true;observer.disconnect();image.onload=null;image.onerror=null}
 },[src,spriteKey,align,registration,viewport])
 return bounds||registration?React.createElement('canvas',{key:src,ref:canvas,role:'img','aria-label':alt,className:className+' whg-character-canvas','data-sprite':spriteKey,style:{width:'100%',height:'100%',display:'block'}}):React.createElement('img',{key:src,src,alt,className,draggable:false,onError})
}

export function ExpressionPortrait({characterId,emotion,src,normalSrc,spriteKey,custom=false,onError,...props}:any){
 const [failed,setFailed]=useState<string|null>(null)
 const role=(CHARACTER_EXPRESSIONS as any)[characterId]
 const requested=!custom&&role?(role.expressions[emotion]||role.normal):null
 const chosen=requested&&failed!==requested.src?requested:(!custom&&role?role.normal:null)
 const fallback=!custom&&!role&&failed===src&&normalSrc?normalSrc:null
 const fail=()=>{if(chosen&&chosen!==role.normal)setFailed(chosen.src);else if(!custom&&!role&&normalSrc&&src!==normalSrc&&failed!==src)setFailed(src);else onError?.()}
 return React.createElement(CharacterPortrait,{...props,src:chosen?.src||fallback||src,spriteKey:custom?null:spriteKey,registration:chosen?.registration,viewport:chosen?role.viewport:null,onError:fail})
}

export function CastPortrait({member,src,normalSrc,request,emotion='normal'}:any){
 const [custom,setCustom]=useState<string|null>(null)
 useLayoutEffect(()=>{let closed=false;setCustom(null);if(member.hasCustomSprite)request('sprite-data',{characterId:member.id}).then((r:any)=>{if(!closed)setCustom(r.dataUrl||null)}).catch(()=>{});return()=>{closed=true}},[member.id,member.hasCustomSprite,member.spriteRevision])
 if(member.hasCustomSprite&&!custom)return React.createElement('div',{'aria-label':member.name,className:'whg-sprite-loading'})
 return React.createElement(ExpressionPortrait,{characterId:member.id,emotion,src:custom||src,normalSrc,spriteKey:custom||member.id==='deepseek'&&emotion!=='normal'?null:member.sprite,custom:!!custom,alt:member.name})
}
