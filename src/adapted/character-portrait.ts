import React, {useLayoutEffect,useRef,useState} from 'react'
import {CHARACTER_BOUNDS} from '../character-bounds.generated.mjs'

// Fit the visible silhouette rather than the variable transparent padding.
// Source PNGs remain untouched; a small transparent guard preserves antialiasing.
export function CharacterPortrait({src,spriteKey,alt,className='',onError}:any){
 const canvas=useRef<HTMLCanvasElement>(null),bounds=CHARACTER_BOUNDS[spriteKey]
 useLayoutEffect(()=>{
  if(!bounds||!canvas.current)return
  const node=canvas.current,image=new Image();let closed=false
  node.dataset.ready='false';delete node.dataset.bounds
  node.getContext('2d')?.clearRect(0,0,node.width,node.height)
  const draw=()=>{
   if(closed||!image.complete||!image.naturalWidth)return
   const box=node.getBoundingClientRect(),dpr=window.devicePixelRatio||1
   node.width=Math.max(1,Math.round(box.width*dpr));node.height=Math.max(1,Math.round(box.height*dpr))
   const [l,t,r,b]=bounds.visibleBounds,guard=5,x=Math.max(0,l-guard),y=Math.max(0,t-guard)
   const w=Math.min(image.width,r+guard)-x,h=Math.min(image.height,b+guard)-y
   const scale=Math.min(node.width/w,node.height/h)*.97,dx=(node.width-w*scale)/2,dy=node.height-h*scale
   const ctx=node.getContext('2d');ctx?.clearRect(0,0,node.width,node.height);ctx?.drawImage(image,x,y,w,h,dx,dy,w*scale,h*scale)
   node.dataset.ready='true';node.dataset.bounds=JSON.stringify({x:dx/dpr,y:dy/dpr,width:w*scale/dpr,height:h*scale/dpr})
  }
  image.onload=draw;image.onerror=()=>onError?.();image.src=src
  const observer=new ResizeObserver(draw);observer.observe(node)
  return()=>{closed=true;observer.disconnect();image.onload=null;image.onerror=null}
 },[src,spriteKey])
 return bounds?React.createElement('canvas',{key:src,ref:canvas,role:'img','aria-label':alt,className:className+' whg-character-canvas','data-sprite':spriteKey,style:{width:'100%',height:'100%',display:'block'}}):React.createElement('img',{key:src,src,alt,className,draggable:false,onError})
}

export function CastPortrait({member,src,request}:any){
 const [custom,setCustom]=useState<string|null>(null)
 useLayoutEffect(()=>{let closed=false;setCustom(null);if(member.hasCustomSprite)request('sprite-data',{characterId:member.id}).then((r:any)=>{if(!closed)setCustom(r.dataUrl||null)}).catch(()=>{});return()=>{closed=true}},[member.id,member.hasCustomSprite,member.spriteRevision])
 return React.createElement(CharacterPortrait,{src:custom||src,spriteKey:custom?null:member.sprite,alt:member.name})
}
