import {t} from './i18n.mjs';
import React,{memo,useState,useEffect,useRef,useCallback} from 'react';
import {PET_ACTIONS,actionSample} from './pet-actions.mjs';
import {subscribeAnimationClock} from './animation-clock.mjs';
import {galleryRenderer as motionRenderer} from './motion-renderer.mjs';
import {frameSequence,sequenceSampleFrame} from './frame-sequence.mjs';
const h=React.createElement;

const ActionSprite=memo(function ActionSprite({id,playing=true,windowVisible=true,speed=1,onError}){
  const sequence=frameSequence(id),nativeCount=sequence?.nativeFrameCount??sequence?.interpolation?.nativeFrameCount??sequence?.frames.length;
  const element=useRef(null),canvas=useRef(null),phase=useRef(0),[inView,setInView]=useState(true);
  useEffect(()=>{phase.current=0;},[id]);
  useEffect(()=>{
    const observer=new IntersectionObserver(entries=>setInView(entries[0].isIntersecting),{threshold:0});
    observer.observe(element.current);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{const target=canvas.current;return()=>motionRenderer.release?.(target);},[]);
  useEffect(()=>{
    let active=true,last=null;
    element.current.dataset.animating=String(playing&&inView);
    if(!inView||!windowVisible){motionRenderer.release?.(canvas.current);phase.current=0;}
    const draw=()=>{
      if(!active||!inView||!windowVisible||!element.current||!canvas.current)return;
      try{
        const sample=actionSample(id,phase.current,{reducedMotion:!playing&&matchMedia('(prefers-reduced-motion: reduce)').matches});sample.clockMs=phase.current;sample.playbackRate=speed;sample.playing=playing&&inView;
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
    const stop=inView&&windowVisible?subscribeAnimationClock(now=>{if(playing&&last!==null&&(motionRenderer.isAdvancing?.(canvas.current)??true)&&(!sequence||motionRenderer.displayedSample?.(canvas.current)?.actionId===id))phase.current+=(now-last)*speed;last=now;draw();}):null;
    return()=>{active=false;stop?.();};
  },[id,playing,inView,windowVisible,speed,onError]);
  return h('div',{ref:element,className:'action-viewport','data-preview':id,'data-frame':0},
    h('canvas',{ref:canvas,className:'action-sprite','aria-hidden':true}));
});

export function ActionGallery({settings}){
  const [playing,setPlaying]=useState(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [error,setError]=useState(''),[visible,setVisible]=useState(!document.hidden),[assetsReady,setAssetsReady]=useState(false);
  const playbackError=useCallback(()=>setError(t("动作播放失败，请重试。")),[]);
  useEffect(()=>{
    let active=true;
    motionRenderer.ready.then(()=>{if(active)setAssetsReady(true);}).catch(()=>{if(active)setError(t("动作加载失败，请重新打开。"));});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    const hidden=()=>{setVisible(!document.hidden);if(document.hidden)void window.whale.petAuto().catch(()=>{});};
    document.addEventListener('visibilitychange',hidden);
    return()=>{document.removeEventListener('visibilitychange',hidden);void window.whale.petAuto().catch(()=>{});};
  },[]);
  useEffect(()=>{
    const query=matchMedia('(prefers-reduced-motion: reduce)'),change=e=>setPlaying(!e.matches);
    query.addEventListener('change',change);return()=>query.removeEventListener('change',change);
  },[]);
  const hidden=settings?.preferences.petVisible===false,speed=settings?.preferences.animationSpeed??.75;
  async function play(id){
    setError('');
    try{
      const action=PET_ACTIONS.find(a=>a.id===id),cycle=action?.cycleMs??0;
      await window.whale.playPet({id,durationMs:Math.min(action?.sourceFrameCount?60000:15000,Math.max(5000,Math.ceil(cycle/speed)))});
    }catch{playbackError();}
  }
  const actions=(motionRenderer.workingRigPilot?PET_ACTIONS.filter(a=>a.id==='working'):PET_ACTIONS.filter(a=>!['wave','emotion-cheerful','emotion-serious'].includes(a.id))).map(a=>a.id==='reviewing'?{...a,label:t("认真")}:a);
  return h('div',{className:'action-gallery'},
    h('div',{className:'action-heading'},h('h1',null,t("动作展示")),assetsReady&&h('div',{className:'action-toolbar'},
      h('button',{'data-action':'pause-previews','aria-pressed':!playing,onClick:()=>setPlaying(!playing)},playing?t("暂停"):t("播放")))),
    error&&h('p',{className:'settings-error',role:'alert'},error),
    !assetsReady&&!error&&h('p',{className:'action-loading',role:'status'},t("正在加载…")),
    assetsReady&&h('div',{className:'action-grid'},...actions.map(action=>h('section',{className:'action-card',key:action.id,'data-action-card':action.id},
      h('div',{className:'action-card-title'},h('h2',null,t(action.label))),
      h(ActionSprite,{id:action.id,playing:playing&&visible,windowVisible:visible,speed,onError:playbackError}),
      h('button',{'data-pet-play':action.id,disabled:hidden,onClick:()=>{void play(action.id);}},t("在桌宠播放"))))));
}
