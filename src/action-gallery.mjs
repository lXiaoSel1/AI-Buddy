import {t} from './i18n.mjs';
import React,{memo,useState,useEffect,useRef,useCallback} from 'react';
import {PET_ACTIONS,PET_INTERACTION_ACTIONS,actionSample,getPetAction} from './pet-actions.mjs';
import {subscribeAnimationClock} from './animation-clock.mjs';
import {prepareCharacterRenderer} from './motion-renderer.mjs';
import {PET_CHARACTERS,resolvePetCharacter} from './pet-characters.mjs';
import {frameSequence,sequenceSampleFrame} from './frame-sequence.mjs';
const h=React.createElement;

// M-2: every card shows one still; only the card under the pointer or keyboard focus
// plays, so the gallery holds at most one video decoder. Stills are painted straight
// into the card canvas and their images dropped, two loads at a time.
const stillQueue=[];let stillLoads=0;
function pumpStills(){
  while(stillLoads<2&&stillQueue.length){
    const job=stillQueue.shift();if(job.cancelled)continue;stillLoads++;
    const image=new Image(),done=()=>{image.onload=image.onerror=null;image.src='';stillLoads--;pumpStills();};
    image.onload=()=>{if(!job.cancelled)job.paint(image);done();};image.onerror=()=>{if(!job.cancelled)job.fail();done();};image.src=job.src;
  }
}
export function paintStill(canvas,src,{onError=()=>{}}={}){
  const job={src,cancelled:false,fail:onError,paint:image=>{
    if(!canvas.isConnected)return;const box=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round((box.width||192)*dpr));canvas.height=Math.max(1,Math.round((box.height||208)*dpr));
    const ctx=canvas.getContext('2d');ctx.imageSmoothingQuality='high';ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);canvas.dataset.still='true';
  }};
  stillQueue.push(job);pumpStills();return()=>{job.cancelled=true;};
}
function clearCanvas(canvas){if(!canvas)return;canvas.width=0;canvas.height=0;delete canvas.dataset.still;}

const ActionSprite=memo(function ActionSprite({id,label,characterId,motionRenderer,active=false,playing=true,speed=1,onError}){
  const sequence=frameSequence(id,characterId),nativeCount=sequence?.nativeFrameCount??sequence?.interpolation?.nativeFrameCount??sequence?.frames.length,stillSrc=sequence?.staticFrames?.[0]?.src;
  const element=useRef(null),canvas=useRef(null),phase=useRef(0),[inView,setInView]=useState(false);
  const live=active&&playing&&inView&&!!motionRenderer;
  useEffect(()=>{phase.current=0;},[id,characterId]);
  useEffect(()=>{
    const observer=new IntersectionObserver(entries=>setInView(entries[0].isIntersecting),{threshold:0});
    observer.observe(element.current);return()=>observer.disconnect();
  },[]);
  // Idle cards: one still while visible, nothing while scrolled away.
  useEffect(()=>{
    const target=canvas.current;element.current.dataset.animating='false';
    if(live)return;
    if(!inView){clearCanvas(target);return;}
    if(stillSrc)return paintStill(target,stillSrc,{onError});
    if(!motionRenderer)return;
    // Clips without stills use the atlas fallback, which does not open a decoder.
    try{motionRenderer.draw(target,{...actionSample(id,0,{reducedMotion:true}),staticFrame:0,playing:false});}catch(error){element.current.dataset.error=error.message;onError();}
    return()=>motionRenderer.release?.(target);
  },[live,inView,stillSrc,motionRenderer,id,onError]);
  // The active card plays through the renderer and gives its decoder back when it stops.
  useEffect(()=>{
    if(!live)return;
    const target=canvas.current;let active=true,last=null;delete target.dataset.still;
    element.current.dataset.animating='true';
    const draw=()=>{
      if(!active||!element.current||!canvas.current)return;
      try{
        const sample=actionSample(id,phase.current,{reducedMotion:false});sample.clockMs=phase.current;sample.playbackRate=speed;sample.playing=true;
        motionRenderer.draw(canvas.current,sample);
        if(canvas.current.dataset.sequenceError)onError();
        element.current.dataset.frame=sequence?(motionRenderer.displayedSample?.(canvas.current)?.displayedSequenceFrame??sequenceSampleFrame(sequence,sample)):sample.frame;
        element.current.dataset.mix=sequence?'0.0000':sample.mix.toFixed(4);
        element.current.dataset.renderer=motionRenderer.backend;
        element.current.dataset.draws=String(motionRenderer.targetDraws?.(canvas.current)??motionRenderer.draws);
        element.current.dataset.rigDraws=String(motionRenderer.rigDraws??0);
        element.current.dataset.sourceFrameCount=String(sequence?.frames.length??24);
        element.current.dataset.nativeFrameCount=String(nativeCount??24);
        element.current.dataset.playbackSpeed=String(speed);
        element.current.previewPhase=phase.current;
      }catch(error){element.current.dataset.error=error.message;onError();}
    };
    draw();motionRenderer.ready.then(()=>{if(active)draw();}).catch(error=>{if(active&&element.current){element.current.dataset.error=error.message;onError();}});
    const stop=subscribeAnimationClock(now=>{if(last!==null&&(motionRenderer.isAdvancing?.(target)??true)&&(!sequence||motionRenderer.displayedSample?.(target)?.actionId===id))phase.current+=(now-last)*speed;last=now;draw();});
    return()=>{active=false;stop();motionRenderer.release?.(target);phase.current=0;if(element.current)element.current.dataset.animating='false';};
  },[live,id,characterId,motionRenderer,speed,onError]);
  // Focusable on its own: the play button is disabled while the pet is hidden.
  return h('div',{ref:element,className:'action-viewport','data-preview':id,'data-frame':0,'data-active':String(live),tabIndex:0,role:'img','aria-label':t('预览')+' · '+label},
    h('canvas',{ref:canvas,className:'action-sprite','aria-hidden':true}));
});

export function ActionGallery({settings}){
  const [characterId,setCharacterId]=useState(()=>settings?.effectivePetCharacter??settings?.petCharacterId??resolvePetCharacter(settings?.preferences,settings?.themeCharacter));
  const [motionRenderer,setRenderer]=useState(null),[activeId,setActiveId]=useState(null);
  const [playing,setPlaying]=useState(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [error,setError]=useState(''),[visible,setVisible]=useState(!document.hidden),[panelVisible,setPanelVisible]=useState(true),[assetsReady,setAssetsReady]=useState(false);
  const shown=visible&&panelVisible;
  const playbackError=useCallback(()=>setError(t("动作播放失败，请重试。")),[]);
  // M-1: a hidden panel keeps no renderer, so its targets, prepared videos and still
  // cache are all released; showing the panel prepares a fresh one.
  useEffect(()=>{
    setAssetsReady(false);setRenderer(null);setActiveId(null);
    if(!shown){window.galleryPreviewInspection=null;return;}
    let active=true,renderer=null;setError('');
    prepareCharacterRenderer(characterId).then(value=>{
      renderer=value;if(!active){value.dispose();return;}
      // The idle clip opened during preparation is only a load check; no card is playing yet.
      value.release(null);
      setRenderer(value);setAssetsReady(true);window.galleryPreviewInspection={renderer:value,cache:()=>value.inspect()};
    }).catch(()=>{if(active)setError(t("动作加载失败，请重新打开。"));});
    return()=>{active=false;renderer?.dispose();};
  },[characterId,shown]);
  useEffect(()=>{
    const hidden=()=>{setVisible(!document.hidden);if(document.hidden)void window.whale.petAuto().catch(()=>{});};
    document.addEventListener('visibilitychange',hidden);
    const offPanel=window.whale.onPanelVisibility?.(value=>{const next=value?.visible!==false;setPanelVisible(next);if(!next)void window.whale.petAuto().catch(()=>{});});
    return()=>{document.removeEventListener('visibilitychange',hidden);offPanel?.();void window.whale.petAuto().catch(()=>{});};
  },[]);
  useEffect(()=>{
    const query=matchMedia('(prefers-reduced-motion: reduce)'),change=e=>setPlaying(!e.matches);
    query.addEventListener('change',change);return()=>query.removeEventListener('change',change);
  },[]);
  const hidden=settings?.preferences.petVisible===false,speed=settings?.preferences.animationSpeed??.75;
  async function play(id){
    setError('');
    try{
      const action=getPetAction(id,characterId),cycle=action.cycleMs;
      await window.whale.playPet({id,characterId,durationMs:Math.min(60000,Math.max(5000,Math.ceil(cycle/speed)))});
    }catch{playbackError();}
  }
  const leave=id=>setActiveId(current=>current===id?null:current);
  const actions=[...PET_ACTIONS,...PET_INTERACTION_ACTIONS.filter(a=>frameSequence(a.id,characterId))].map(a=>a.id==='reviewing'?{...a,label:t("审查中")}:a);
  return h('div',{className:'action-gallery'},
    h('div',{className:'action-heading'},h('div',null,h('h1',null,t("动作展示")),h('p',{className:'action-hint'},t("鼠标移到卡片上或用 Tab 选中时播放预览。"))),h('div',{className:'action-toolbar'},
      h('select',{'aria-label':t('桌宠角色'),'data-gallery-character':true,value:characterId,onChange:async e=>{const id=e.target.value;if(settings?.resources?.characters.find(c=>c.id===id)?.installed===false){try{await window.whale.resources.manage(id);}catch(error){setError(error.message);}return;}setCharacterId(id);}},...PET_CHARACTERS.map(c=>h('option',{key:c.id,value:c.id},t(c.name)+(settings?.resources?.characters.find(r=>r.id===c.id)?.installed===false?' · '+t('待安装'):'')))),
      h('button',{'data-action':'pause-previews','aria-pressed':!playing,onClick:()=>setPlaying(!playing)},playing?t("暂停"):t("播放")))),
    error&&h('p',{className:'settings-error',role:'alert'},error),
    shown&&!assetsReady&&!error&&h('p',{className:'action-loading',role:'status'},t("正在加载…")),
    shown&&assetsReady&&h('div',{className:'action-grid'},...actions.map(action=>h('section',{className:'action-card',key:action.id,'data-action-card':action.id,
        onPointerEnter:()=>setActiveId(action.id),onPointerLeave:()=>leave(action.id),
        onFocus:()=>setActiveId(action.id),onBlur:e=>{if(!e.currentTarget.contains(e.relatedTarget))leave(action.id);}},
      h('div',{className:'action-card-title'},h('h2',null,t(action.label))),
      h(ActionSprite,{id:action.id,label:t(action.label),characterId,motionRenderer,active:activeId===action.id,playing,speed,onError:playbackError}),
      h('button',{'data-pet-play':action.id,disabled:hidden,onClick:()=>{void play(action.id);}},t("在桌宠播放"))))));
}
