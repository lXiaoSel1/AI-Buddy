import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PetGloveController,gloveCursorV2,preloadGloveArtwork,GLOVE_HOTSPOT,GLOVE_DURATION_MS,POKE_FRAME_TIMES} from '../src/pet-glove.mjs';

function fixture(options={}){
  let now=0,wall=10000;
  const glove=new PetGloveController({now:()=>now,wallNow:()=>wall,...options});
  glove.setContext({opaque:true,characterId:'deepseek'});
  const begin=(id='gesture-1',characterId='deepseek')=>glove.beginGesture(id,{characterId,startedAt:wall});
  const release=(id='gesture-1')=>glove.releaseGesture(id);
  const event=(id='gesture-1',eventId='event-1',extra={})=>({source:'touch',eventId,gestureId:id,characterId:'deepseek',capturedAt:wall,confirmedAt:wall,...extra});
  const click=(id='gesture-1',eventId='event-1')=>{begin(id);release(id);return glove.touch(event(id,eventId));};
  return {glove,begin,release,event,click,at(value){now=value;return glove.sample();},wall(value){wall=value;}};
}

test('native cursors keep 32 DIP artwork and a shared 8,8 hotspot at both image densities',()=>{
  assert.deepEqual(GLOVE_HOTSPOT,{x:8,y:8});assert.equal(GLOVE_DURATION_MS,200);
  assert.deepEqual(POKE_FRAME_TIMES,[0,20,40,60,80,100,120,140,160,180]);
  for(const state of ['open','closed','grab','poke-00','poke-09']){
    const css=gloveCursorV2(state);
    assert.match(css,new RegExp(`${state}\\.png"\\) 1x`));assert.match(css,new RegExp(`${state}@2x\\.png"\\) 2x`));assert.match(css,/8 8,/);
  }
  assert.match(gloveCursorV2('open',{highDpi:false}),/^url\(/);assert.doesNotMatch(gloveCursorV2('open',{highDpi:false}),/image-set/);
  assert.throws(()=>gloveCursorV2('../../secret'));assert.equal(gloveCursorV2('default'),'default');
});

test('only confirmed, released touches play once; stationary native reset before feedback is valid',()=>{
  const f=fixture();f.begin();
  assert.equal(f.glove.touch(f.event()),false);
  // A main-process release has already cleared renderer button state; no DOM
  // dragEnd promise needs to resolve for the next confirmed event to work.
  f.release();assert.equal(f.glove.touch(f.event('gesture-1','event-2')),true);
  assert.equal(f.glove.sample().pokeCount,1);assert.equal(f.glove.sample().cursorState,'poke');
  assert.equal(f.glove.touch(f.event('gesture-1','event-2')),false);
  assert.equal(f.glove.touch(f.event('gesture-1','event-3')),false);
  assert.equal(f.glove.sample().pokeCount,1);
});

test('ten frames span exactly 40ms extension, 60ms contact, 100ms recovery on a real clock',()=>{
  const f=fixture();assert.equal(f.click(),true);
  const frames=POKE_FRAME_TIMES.map(t=>f.at(t).frame);
  assert.deepEqual(frames,[0,1,2,3,4,5,6,7,8,9]);
  assert.equal(f.at(199).active,true);assert.equal(f.at(200).active,false);
  assert.equal(f.glove.sample().cursorState,'open');assert.equal(f.glove.sample().reason,'completed');
});

test('pet animation speed and 30fps/60fps parameters never alter poke duration',()=>{
  for(const speed of [.25,.5,.75,1])for(const fps of [30,60]){
    const f=fixture();f.glove.setContext({animationSpeed:speed,fps});f.click();
    assert.equal(f.at(80).frame,4);assert.equal(f.at(180).frame,9);assert.equal(f.at(200).active,false);
  }
});

test('reduced motion provides brief contact feedback without running the full sequence',()=>{
  const f=fixture();f.glove.setContext({reducedMotion:true});f.click();
  assert.equal(f.at(0).frame,3);assert.equal(f.at(79).frame,3);assert.equal(f.at(80).active,false);
});

test('rapid valid clicks bridge the current extension and replace rather than enqueue',()=>{
  const f=fixture();f.click();assert.equal(f.at(120).extension,.6);
  f.begin('gesture-2');assert.equal(f.glove.sample().cursorState,'closed');f.release('gesture-2');
  assert.equal(f.glove.touch(f.event('gesture-2','event-2')),true);
  assert.equal(f.at(120).frame,1);assert.equal(f.at(140).frame,1);
  assert.equal(f.at(160).frame,2);assert.equal(f.at(319).active,true);assert.equal(f.at(320).active,false);
  assert.equal(f.glove.sample().pokeCount,2);
});

test('late old-gesture or wrong-character feedback cannot replace a newer gesture',()=>{
  const f=fixture();f.begin('old');f.release('old');f.begin('new');
  assert.equal(f.glove.touch(f.event('old','event-old')),false);assert.equal(f.glove.sample().cursorState,'closed');
  f.release('new');assert.equal(f.glove.touch(f.event('new','event-wrong',{characterId:'claude'})),false);
  assert.equal(f.glove.touch(f.event('new','event-new')),true);
});

test('a delayed old cancellation cannot cancel a newer gesture or reuse an old gesture identity',()=>{
  const f=fixture();f.begin('old');f.release('old');f.begin('new');
  assert.equal(f.glove.beginGesture('old'),false);
  f.glove.releaseGesture('old',{reason:'escape'});
  assert.equal(f.glove.sample().cursorState,'closed');f.release('new');
  assert.equal(f.glove.touch(f.event('new','event-new')),true);
});

test('hidden, contour exit, blur/cancel, and character switches invalidate delayed touches',()=>{
  for(const action of [g=>g.setContext({visible:false}),g=>g.setContext({opaque:false}),g=>g.cancel('window-blur'),g=>g.setContext({characterId:'kimi'})]){
    const f=fixture();f.begin();f.release();action(f.glove);
    f.glove.setContext({visible:true,opaque:true,characterId:'deepseek'});
    assert.equal(f.glove.touch(f.event()),false);assert.equal(f.glove.sample().active,false);
  }
});

test('dragging, charging, flight, landing and their cancellations preempt poke without replay',()=>{
  for(const mode of ['dragging','charging','flying','landing']){
    const f=fixture();f.click();assert.equal(f.glove.sample().active,true);
    f.glove.setContext({mode});assert.equal(f.glove.sample().active,false);
    f.glove.setContext({mode:'rest'});assert.equal(f.glove.sample().active,false);
    assert.equal(f.glove.touch(f.event('gesture-1','another-event')),false);
  }
  const f=fixture();f.begin();f.glove.setContext({mode:'dragging'});assert.equal(f.glove.sample().cursorState,'grab');
  f.glove.setContext({mode:'charging'});assert.equal(f.glove.sample().cursorState,'grab');
  f.release();f.glove.setContext({mode:'rest'});assert.equal(f.glove.touch(f.event()),false);
});

test('malformed, expired and future confirmation events are not playable',()=>{
  for(const extra of [{source:'chat'},{capturedAt:null},{confirmedAt:null},{confirmedAt:9999},{confirmedAt:20000},{confirmedAt:8000},{capturedAt:5000}]){
    const f=fixture();f.begin();f.release();assert.equal(f.glove.touch(f.event('gesture-1','event-bad',extra)),false);
  }
});

test('cancelled gestures and unowned events cannot play or create a touch reward',()=>{
  const f=fixture();assert.equal(f.glove.touch(f.event()),false);
  f.begin();f.glove.releaseGesture('gesture-1',{reason:'escape'});
  assert.equal(f.glove.touch(f.event('gesture-1','event-after-cancel')),false);
  assert.equal(f.glove.sample().pokeCount,0);
});

test('artwork preloads and decodes all 26 density variants while retaining Image references',async()=>{
  const decoded=[];
  class ImageFixture{
    set src(value){this.url=value;queueMicrotask(()=>{this.naturalWidth=value.includes('@2x')?64:32;this.onload();});}
    async decode(){decoded.push(this.url);}
  }
  const preload=preloadGloveArtwork({ImageClass:ImageFixture});
  assert.equal(preload.images.length,26);
  assert.deepEqual(await preload.ready,{artReady:true,artError:null});
  assert.equal(decoded.length,26);assert.equal(new Set(decoded).size,26);
  assert.equal(preload.images.filter(image=>image.naturalWidth===64).length,13);
});

test('load and decode failures resolve diagnostics and never enable a partial cursor set',async()=>{
  class ImageFixture{
    set src(value){this.url=value;queueMicrotask(()=>{this.naturalWidth=32;if(value.includes('closed.png'))this.onerror();else this.onload();});}
    async decode(){if(this.url.includes('poke-04.png'))throw new Error('decode failed');}
  }
  const preload=preloadGloveArtwork({ImageClass:ImageFixture,highDpi:false});
  const status=await preload.ready;assert.equal(status.artReady,false);
  assert.match(status.artError,/closed\.png/);assert.match(status.artError,/poke-04\.png/);
  assert.equal(preload.images.length,13);
  const f=fixture();f.glove.setContext(status);assert.equal(f.glove.sample().cursorCss,'default');assert.equal(f.click(),false);
});

test('one 10s deadline covers hanging load and hanging decode; late completion cannot enable artwork or replay a poke',async()=>{
  const timers=new Map();let serial=0,finishLateDecode;
  class ImageFixture{
    set src(value){this.url=value;if(value.endsWith('/open.png'))return;queueMicrotask(()=>{this.naturalWidth=32;this.onload();});}
    decode(){return this.url.endsWith('/poke-04.png')?new Promise(resolve=>{finishLateDecode=resolve;}):Promise.resolve();}
  }
  const preload=preloadGloveArtwork({ImageClass:ImageFixture,highDpi:false,setTimer:(callback,ms)=>{
    assert.equal(ms,10000);const id=++serial;timers.set(id,callback);return id;
  },clearTimer:id=>timers.delete(id)});
  const f=fixture();f.glove.setContext({artReady:false});assert.equal(f.click(),false);
  for(let pass=0;pass<12;pass++)await Promise.resolve();
  assert.equal(typeof finishLateDecode,'function');
  assert.equal(timers.size,2,'load success must not clear a still-pending decode deadline');
  for(const callback of [...timers.values()])callback();
  const status=await preload.ready;f.glove.setContext(status);
  assert.equal(timers.size,0);assert.equal(status.artReady,false);
  assert.match(status.artError,/open\.png/);assert.match(status.artError,/poke-04\.png/);
  assert.equal(status.artError.split(', ').length,2);
  finishLateDecode();for(let pass=0;pass<5;pass++)await Promise.resolve();
  assert.strictEqual(await preload.ready,status);assert.equal(status.artReady,false);
  assert.equal(f.glove.sample().artReady,false);assert.equal(f.glove.sample().active,false);
  assert.equal(f.glove.touch(f.event()),false);assert.equal(f.glove.sample().pokeCount,0);
});

test('a click before artwork is ready is dropped, not replayed on decode completion',()=>{
  const f=fixture();f.glove.setContext({artReady:false});assert.equal(f.click(),false);
  f.glove.setContext({artReady:true,artError:null});assert.equal(f.glove.sample().active,false);
  assert.equal(f.glove.touch(f.event()),false);assert.equal(f.glove.sample().pokeCount,0);
  assert.equal(f.click('gesture-ready','event-ready'),true);assert.equal(f.glove.sample().pokeCount,1);
});

test('renderer is wired to confirmed touch events and keeps native-release capture cleanup safe',()=>{
  const source=readFileSync(new URL('../src/pet.mjs',import.meta.url),'utf8');
  assert.match(source,/value\.value\?\.source==='touch'\)\{updateGlove\(\);gloveState\.touch\(value\.value\)/);
  assert.match(source,/clearPointer\(value\.reason\?\?'cancelled',value\.gestureId\?\?gestureId\)/);
  assert.match(source,/lostpointercapture',[\s\S]*?if\(!down\)return;/);
  assert.doesNotMatch(source,/addEventListener\('click',[\s\S]{0,180}gloveState\.touch/);
  const main=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8');
  assert.match(main,/source:'touch',cycles:1,eventId:captured\.eventId,gestureId:captured\.gestureId,capturedAt:captured\.capturedAt,confirmedAt:Date\.now\(\)/);
});
