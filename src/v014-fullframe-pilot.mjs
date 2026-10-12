import {subscribeAnimationClock} from './animation-clock.mjs';

const config=__WHOLE_FRAME_PILOT__;
const images=config.frames.map(frame=>{const image=new Image();image.src=frame.hdUrl;return image;});
const canvases=[...document.querySelectorAll('canvas[data-view]')];
let ready=false,playing=false,position=0,anchor=0,rate=1,current=-1,unsubscribe=null;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const stats={clock:[],drawCosts:[],changes:[],draws:0};
let lastTick=null,lastChange=null;
const phaseAt=now=>position+(playing&&!document.hidden?(now-anchor)*.75*rate:0);
function configure(canvas){const rect=canvas.getBoundingClientRect(),width=Math.round(rect.width*devicePixelRatio),height=Math.round(rect.height*devicePixelRatio);if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}return canvas.getContext('2d');}
function draw(frame,force=false){if(!ready||(!force&&frame===current))return;const before=performance.now();for(const canvas of canvases){const ctx=configure(canvas);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(images[frame],0,0,384,416,0,0,canvas.width,canvas.height);}current=frame;document.querySelector('#frame').textContent=String(frame).padStart(2,'0')+' / 23';document.querySelectorAll('[data-frame]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.frame)===frame));stats.drawCosts.push(performance.now()-before);stats.draws++;}
function tick(now){if(lastTick!==null)stats.clock.push(now-lastTick);lastTick=now;const frame=Math.floor(((phaseAt(now)%800)+800)%800/800*24);if(frame!==current){if(lastChange!==null)stats.changes.push(now-lastChange);lastChange=now;draw(frame);}}
function stop(){if(playing&&!document.hidden)position=phaseAt(performance.now());playing=false;unsubscribe?.();unsubscribe=null;lastTick=null;document.querySelector('#toggle').textContent='播放';}
function start(){if(!ready)return;anchor=performance.now();playing=true;unsubscribe??=subscribeAnimationClock(tick);document.querySelector('#toggle').textContent='暂停';}
function seek(frame){stop();position=frame*800/24;draw(frame,true);}
function resetRate(value){const now=performance.now();position=phaseAt(now);anchor=now;rate=value;document.querySelector('#speed').textContent=value===1?'75% 速度':'四分之一慢速（18.75%）';}
document.querySelector('#toggle').addEventListener('click',()=>playing?stop():start());
document.querySelector('#normal').addEventListener('click',()=>resetRate(1));document.querySelector('#slow').addEventListener('click',()=>resetRate(.25));
document.querySelector('#previous').addEventListener('click',()=>seek((current+23)%24));document.querySelector('#next').addEventListener('click',()=>seek((current+1)%24));
const grid=document.querySelector('#frames');for(let n=0;n<24;n++){const b=document.createElement('button');b.type='button';b.dataset.frame=String(n);b.setAttribute('aria-label','查看第 '+n+' 帧');const img=document.createElement('img');img.src=config.frames[n].hdUrl;img.alt='';const label=document.createElement('span');label.textContent=String(n).padStart(2,'0');b.append(img,label);b.addEventListener('click',()=>seek(n));grid.append(b);}
const resize=new ResizeObserver(()=>draw(Math.max(current,0),true));canvases.forEach(c=>resize.observe(c));window.addEventListener('resize',()=>draw(Math.max(current,0),true));
let hiddenPlaying=false;document.addEventListener('visibilitychange',()=>{if(document.hidden){hiddenPlaying=playing;if(playing)position+=(performance.now()-anchor)*.75*rate;playing=false;unsubscribe?.();unsubscribe=null;lastTick=null;}else if(hiddenPlaying){hiddenPlaying=false;start();}});
reduced.addEventListener('change',()=>{if(reduced.matches)stop();});
const readyPromise=Promise.all(images.map(i=>i.decode())).then(()=>{ready=true;draw(0,true);if(!reduced.matches)start();return true;});
window.wholeFramePilot={ready:readyPromise,stats,seek,start,stop,resetRate,get state(){return {frame:current,playing,rate,position,sourceCount:24,renderPolicy:'one-complete-PNG-per-frame',baseCycleMs:800,speed:.75,sourceChangesPerSecond:22.5};}};
