import React, {useLayoutEffect,useRef,useState} from 'react'
import {CHARACTER_BOUNDS} from '../character-bounds.generated.mjs'
import {CHARACTER_EXPRESSIONS} from '../character-expressions.generated.mjs'

type PreparedImage = {image:HTMLImageElement,ready:boolean,failed:boolean,active:boolean,refresh:()=>void}

function prepareImage(src:string): PreparedImage {
 const image=new Image()
 const entry:PreparedImage={image,ready:false,failed:false,active:true,refresh:()=>{}}
 image.decoding='async'
 const settle=(ready:boolean)=>{
  if(!entry.active)return
  entry.ready=ready
  entry.failed=!ready
  entry.refresh()
 }
 image.onerror=()=>settle(false)
 image.src=src
 if(typeof image.decode==='function')void image.decode().then(()=>settle(true),()=>settle(false))
 else if(image.complete&&image.naturalWidth)settle(true)
 else image.onload=()=>settle(true)
 return entry
}

function releaseImage(entry:PreparedImage) {
 entry.active=false
 entry.image.onload=null
 entry.image.onerror=null
 entry.image.removeAttribute('src')
}

// Keep one persistent canvas so an undecoded successor cannot flash a blank portrait.
export function CharacterPortrait({src,nextSrc,spriteKey,alt,className='',align='bottom',onError,registration,viewport}:any){
 const canvas=useRef<HTMLCanvasElement>(null),bounds=CHARACTER_BOUNDS[spriteKey]
 const images=useRef(new Map<string,PreparedImage>()),onFailure=useRef(onError)
 onFailure.current=onError
 useLayoutEffect(()=>()=>{
  for(const entry of images.current.values())releaseImage(entry)
  images.current.clear()
 },[])
 useLayoutEffect(()=>{
  const node=canvas.current
  if((!bounds&&!registration)||!node||!src)return
  const pool=images.current,wanted=new Set<string>([src,nextSrc].filter(Boolean))
  for(const [url,entry] of pool)if(!wanted.has(url)){releaseImage(entry);pool.delete(url)}
  for(const url of wanted)if(!pool.has(url))pool.set(url,prepareImage(url))
  const entry=pool.get(src)!
  let sentError=false
  const draw=()=>{
   if(entry.failed){if(!sentError){sentError=true;onFailure.current?.()}return}
   if(!entry.ready||!entry.image.naturalWidth)return
   const image=entry.image,box=node.getBoundingClientRect(),dpr=window.devicePixelRatio||1
   const [l,t,r,b]=registration?viewport:bounds.visibleBounds,guard=registration?0:5
   const x=registration?l:Math.max(0,l-guard),y=registration?t:Math.max(0,t-guard)
   const w=registration?r-l:Math.min(image.width,r+guard)-x,h=registration?b-t:Math.min(image.height,b+guard)-y
   const width=Math.max(1,Math.round(box.width*dpr)),height=Math.max(1,Math.round(box.height*dpr))
   if(node.width!==width)node.width=width
   if(node.height!==height)node.height=height
   const scale=Math.min(width/w,height/h)*(registration?1:.97),dx=(width-w*scale)/2,dy=align==='top'?0:height-h*scale
   const ctx=node.getContext('2d')
   if(!ctx)return
   ctx.clearRect(0,0,width,height)
   if(registration){
    ctx.save()
    ctx.beginPath();ctx.rect(dx,dy,w*scale,h*scale);ctx.clip()
    ctx.drawImage(image,dx+(registration.x-x)*scale,dy+(registration.y-y)*scale,image.width*registration.scale*scale,image.height*registration.scale*scale)
    ctx.restore()
   }else ctx.drawImage(image,x,y,w,h,dx,dy,w*scale,h*scale)
   node.dataset.ready='true'
   node.dataset.bounds=JSON.stringify({x:dx/dpr,y:dy/dpr,width:w*scale/dpr,height:h*scale/dpr})
  }
  entry.refresh=draw
  const observer=new ResizeObserver(draw);observer.observe(node)
  draw()
  return()=>{observer.disconnect();entry.refresh=()=>{}}
 },[src,nextSrc,spriteKey,align,registration,viewport])
 return bounds||registration
  ? React.createElement('canvas',{ref:canvas,role:'img','aria-label':alt,className:className+' whg-character-canvas','data-sprite':spriteKey,style:{width:'100%',height:'100%',display:'block'}})
  : React.createElement('img',{src,alt,className,draggable:false,onError})
}

export function ExpressionPortrait({characterId,emotion,nextEmotion,src,normalSrc,spriteKey,custom=false,onError,...props}:any){
 const [failed,setFailed]=useState<string|null>(null)
 const role=(CHARACTER_EXPRESSIONS as any)[characterId]
 const requested=!custom&&role?(role.expressions[emotion]||role.normal):null
 const chosen=requested&&failed!==requested.src?requested:(!custom&&role?role.normal:null)
 const next=chosen&&nextEmotion?(role.expressions[nextEmotion]||role.normal):null
 const fallback=!custom&&!role&&failed===src&&normalSrc?normalSrc:null
 const fail=()=>{if(chosen&&chosen!==role.normal)setFailed(chosen.src);else if(!custom&&!role&&normalSrc&&src!==normalSrc&&failed!==src)setFailed(src);else onError?.()}
 return React.createElement(CharacterPortrait,{...props,src:chosen?.src||fallback||src,nextSrc:next?.src,spriteKey:custom?null:spriteKey,registration:chosen?.registration,viewport:chosen?role.viewport:null,onError:fail})
}

export function CastPortrait({member,src,normalSrc,request,emotion='normal',nextEmotion,align='bottom'}:any){
 const [custom,setCustom]=useState<string|null>(null)
 useLayoutEffect(()=>{let closed=false;setCustom(null);if(member.hasCustomSprite)request('sprite-data',{characterId:member.id}).then((r:any)=>{if(!closed)setCustom(r.dataUrl||null)}).catch(()=>{});return()=>{closed=true}},[member.id,member.hasCustomSprite,member.spriteRevision])
 if(member.hasCustomSprite&&!custom)return React.createElement('div',{'aria-label':member.name,className:'whg-sprite-loading'})
 return React.createElement(ExpressionPortrait,{characterId:member.id,emotion,nextEmotion,align,src:custom||src,normalSrc,spriteKey:custom?null:member.sprite,custom:!!custom||!!member.effective?.sprite,alt:member.name})
}
