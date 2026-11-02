import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {PET_RENDERER_DIAGNOSTIC_SCRIPT} from '../src/pet-renderer-diagnostics.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const rect={x:1,y:2,width:3,height:4},sprite={style:{transform:'scale(1.25)',backgroundPosition:'-192px 0px'},getBoundingClientRect:()=>({toJSON:()=>rect})},badge={hidden:false,getBoundingClientRect:()=>({toJSON:()=>rect})};
 const renderer={backend:'webm-alpha',draws:123,inspect:()=>({backend:'webm-alpha',targets:1,decoders:2,playing:1,errors:['SECRET_PATH'],videos:[{resource:'https://private.invalid'}]})};
 const canvases=Array.from({length:6},(_,index)=>({width:index?576:0,height:index?624:0,clientWidth:192,clientHeight:208}));
 const context={innerWidth:270,innerHeight:300,Date:{now:()=>456},getComputedStyle:node=>node.style??{transform:'scale(1.25)'},setTimeout:()=>assert.fail('no timer'),requestAnimationFrame:()=>assert.fail('no animation loop'),show:()=>assert.fail('no show'),focus:()=>assert.fail('no focus')};
 context.window={petInputDiagnostic:{down:1,up:0},petActionDiagnostic:{clockMs:100,draws:99,canvasSize:[576,624]},frameSequenceInspection:{renderer}};
 context.document={body:{style:{transform:'scale(1.25)'}},hidden:false,visibilityState:'visible',hasFocus:()=>true,querySelector:selector=>selector==='.sprite'?sprite:selector==='.badge'?badge:null,querySelectorAll:selector=>selector==='canvas'?canvases:[]};
 return {context,renderer,canvases,sprite,badge,query:()=>plain(vm.runInNewContext(PET_RENDERER_DIAGNOSTIC_SCRIPT,context))};
}

test('page-info pet keeps its complete legacy field shape and appends bounded live data',()=>{
 const f=fixture(),value=f.query();
 assert.deepEqual(Object.keys(value),['width','height','scale','badgeHidden','sprite','spriteRect','badgeRect','input','action','live']);
 assert.equal(value.width,270);assert.equal(value.height,300);assert.equal(value.scale,'scale(1.25)');assert.equal(value.badgeHidden,false);assert.equal(value.sprite,'-192px 0px');assert.deepEqual(value.input,f.context.window.petInputDiagnostic);assert.deepEqual(value.action,f.context.window.petActionDiagnostic);
 assert.deepEqual(value.live,{queriedAt:456,documentHidden:false,visibilityState:'visible',hasFocus:true,canvases:f.canvases.slice(0,4),renderer:{backend:'webm-alpha',targets:1,decoders:2,playing:1,draws:123},errors:[]});
 assert.ok(!JSON.stringify(value.live).includes('SECRET_PATH'));assert.ok(!JSON.stringify(value.live).includes('private.invalid'));
});

test('live query observes current visibility, canvas pixels and renderer count even when action is stale',()=>{
 const f=fixture(),first=f.query();f.context.Date.now=()=>999;f.context.document.hidden=true;f.context.document.visibilityState='hidden';f.canvases[0].width=576;f.canvases[0].height=624;f.renderer.draws=200;
 const second=f.query();assert.equal(first.live.canvases[0].width,0);assert.equal(second.live.canvases[0].width,576);assert.equal(second.live.queriedAt,999);assert.equal(second.live.documentHidden,true);assert.equal(second.live.visibilityState,'hidden');assert.equal(second.live.renderer.draws,200);assert.deepEqual(second.action,first.action);
});

test('queriedAt accepts a current millisecond Unix timestamp without truncating it',()=>{
 const f=fixture();f.context.Date.now=()=>1792815243617;assert.equal(f.query().live.queriedAt,1792815243617);
});

test('failed getters and inspect do not break page-info or disclose their messages',()=>{
 const f=fixture();f.renderer.inspect=()=>{throw Error('SECRET_INSPECT_URL');};Object.defineProperty(f.context.document,'hidden',{get(){throw Error('SECRET_VISIBILITY');}});Object.defineProperty(f.canvases[0],'width',{get(){throw Error('SECRET_CANVAS');}});
 const value=f.query();assert.equal(value.action.clockMs,100);assert.equal(value.live.documentHidden,null);assert.equal(value.live.renderer.backend,'webm-alpha');assert.equal(value.live.renderer.targets,null);assert.equal(value.live.renderer.draws,123);assert.equal(value.live.canvases[0].width,null);
 assert.deepEqual(value.live.errors,['documentHidden','canvases.width','renderer.inspect']);assert.ok(!JSON.stringify(value).includes('SECRET'));
});

test('optional inspection and missing DOM are contained without invoking renderer lifecycle',()=>{
 const f=fixture();delete f.context.window.frameSequenceInspection;f.context.document.querySelector=()=>null;f.context.document.querySelectorAll=()=>[];
 const value=f.query();assert.equal(value.badgeHidden,null);assert.equal(value.sprite,null);assert.equal(value.spriteRect,null);assert.equal(value.badgeRect,null);assert.deepEqual(value.live.renderer,{backend:null,targets:null,decoders:null,playing:null,draws:null});assert.deepEqual(value.live.canvases,[]);
});

test('renderer inspect DTO rejects unbounded counts and never copies raw diagnostics',()=>{
 const f=fixture();f.renderer.backend='https://private.invalid';f.renderer.draws=Infinity;f.renderer.inspect=()=>({backend:'https://secret.invalid',targets:-1,decoders:Infinity,playing:1e16,errors:[{message:'SECRET_ERROR',stack:'PRIVATE_STACK'}],url:'PRIVATE_URL'});
 const value=f.query();assert.deepEqual(value.live.renderer,{backend:null,targets:null,decoders:null,playing:null,draws:null});assert.ok(!JSON.stringify(value.live).includes('PRIVATE'));assert.ok(!JSON.stringify(value.live).includes('SECRET'));assert.ok(!JSON.stringify(value.live).includes('invalid'));
});

test('malicious legacy diagnostic getter is isolated while other legacy fields and live data survive',()=>{
 const f=fixture();Object.defineProperty(f.context.window,'petActionDiagnostic',{get(){throw Error('SECRET_DIAGNOSTIC');}});
 const value=f.query();assert.equal(value.action,null);assert.equal(value.width,270);assert.equal(value.live.renderer.draws,123);assert.deepEqual(value.live.errors,['action']);assert.ok(!JSON.stringify(value).includes('SECRET'));
});

test('inspection facade and canvas list getter failures are independently contained',()=>{
 const f=fixture();Object.defineProperty(f.context.window,'frameSequenceInspection',{get(){throw Error('SECRET_FACADE');}});f.context.document.querySelectorAll=()=>({get length(){throw Error('SECRET_NODE_LIST');}});
 const value=f.query();assert.equal(value.width,270);assert.deepEqual(value.live.canvases,[]);assert.equal(value.live.renderer.draws,null);assert.deepEqual(value.live.errors,['canvases','renderer']);assert.ok(!JSON.stringify(value).includes('SECRET'));
});

test('existing action payload is returned without invoking any action or renderer methods',()=>{
 const f=fixture(),before=JSON.stringify(f.context.window.petActionDiagnostic);for(const name of ['render','draw','release','dispose','preload','setVisible','invalidate'])f.renderer[name]=()=>assert.fail('query must not call '+name);
 const value=f.query();assert.equal(JSON.stringify(f.context.window.petActionDiagnostic),before);assert.equal(value.live.renderer.draws,123);assert.equal(value.action.draws,99);
});
