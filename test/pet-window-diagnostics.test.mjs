import test from 'node:test';
import assert from 'node:assert/strict';
import {createPetWindowDiagnostics} from '../src/pet-window-diagnostics.mjs';
import {petWindowOptions} from '../src/pet-window.mjs';

function windowFixture(){return {id:7,isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,isFocused:()=>false,isFocusable:()=>true,isMinimizable:()=>false,isAlwaysOnTop:()=>false,getBounds:()=>({x:15,y:20,width:270,height:280}),getContentBounds:()=>({x:15,y:20,width:270,height:280}),show(){assert.fail('diagnostics must not show');},focus(){assert.fail('diagnostics must not focus');},restore(){assert.fail('diagnostics must not restore');},setAlwaysOnTop(){assert.fail('diagnostics must not change z-order');}};}

test('pet cannot be minimized through its normal capability while focus and top policy remain unchanged',()=>{
 for(const scale of [.75,1,1.25,1.5]){const value=petWindowOptions({x:10,y:20},scale);assert.equal(value.minimizable,false);assert.equal(value.focusable,true);assert.equal(value.alwaysOnTop,true);assert.equal(value.skipTaskbar,true);assert.equal(value.transparent,true);assert.equal(value.show,false);}
});

test('diagnostics records expected/native mismatch and never changes the window',()=>{
 const rows=[],pet=windowFixture(),diagnostic=createPetWindowDiagnostics(()=>pet,row=>rows.push(row),{now:()=>123,getExpected:()=>({visible:true,alwaysOnTop:true,assetsReady:true}),getInteraction:()=>({ignoringMouse:true,dragging:false})});diagnostic.reason('preferences-applied');const row=diagnostic.record('always-on-top-changed');assert.equal(row.expected.alwaysOnTop,true);assert.equal(row.native.alwaysOnTop,false);assert.equal(row.reason,'preferences-applied');assert.equal(row.at,123);assert.equal(row.native.focused,false);assert.deepEqual(diagnostic.snapshot().expected,row.expected);assert.equal(rows.length,1);
});

test('event log and audit contribution are bounded without retaining arbitrary content',()=>{
 const rows=[],diagnostic=createPetWindowDiagnostics(()=>windowFixture(),row=>rows.push(row),{limit:3,auditLimit:4});for(let index=0;index<1000;index++)diagnostic.record('blur',{reason:'body-click',title:'SECRET_TITLE',url:'https://private.invalid',chat:'secret words',apiKey:'sensitive',renderer:{hidden:true,visibilityState:'hidden',hasFocus:false,draws:index,renderAt:1000,url:'never store'},renderGone:{reason:'crashed',exitCode:2,stack:'private traceback'}});
 assert.equal(diagnostic.recent().length,3);assert.equal(rows.length,4);assert.equal(diagnostic.snapshot().suppressed,996);assert.equal(diagnostic.recent()[2].sequence,1000);for(const word of ['SECRET_TITLE','private.invalid','secret words','sensitive','private traceback','never store'])assert.ok(!JSON.stringify(diagnostic.recent()).includes(word));assert.deepEqual(diagnostic.recent()[2].renderGone,{reason:'crashed',exitCode:2});
});

test('destroyed or absent windows do not access unsafe native getters',()=>{
 const destroyed={id:1,isDestroyed:()=>true,isVisible:()=>assert.fail('destroyed getter')},diagnostic=createPetWindowDiagnostics(()=>destroyed);assert.equal(diagnostic.snapshot().destroyed,true);assert.equal(diagnostic.record('closed').native.visible,undefined);assert.equal(createPetWindowDiagnostics(()=>null).snapshot().exists,false);assert.equal(createPetWindowDiagnostics(()=>{throw Error('secret');}).snapshot().exists,false);
});

test('native getter and audit failures remain contained and disclose field names only',()=>{
 const pet=windowFixture();pet.isVisible=()=>{throw Error('SECRET_ERROR');};const diagnostic=createPetWindowDiagnostics(()=>pet,()=>{throw Error('private disk path');});const row=diagnostic.record('show');assert.equal(row.native.visible,null);assert.deepEqual(row.native.readErrors,['visible']);assert.equal(diagnostic.snapshot().auditFailures,1);assert.ok(!JSON.stringify(diagnostic.snapshot()).includes('SECRET_ERROR'));assert.ok(!JSON.stringify(diagnostic.snapshot()).includes('private disk path'));
});

test('dispose stops observation and returned rows cannot mutate retained state',()=>{
 const diagnostic=createPetWindowDiagnostics(()=>windowFixture());const row=diagnostic.record('minimize');row.native.visible=false;const recent=diagnostic.recent();assert.equal(recent[0].native.visible,true);recent[0].expected.alwaysOnTop='changed';assert.equal(diagnostic.recent()[0].expected.alwaysOnTop,undefined);diagnostic.dispose();assert.equal(diagnostic.record('show'),null);assert.equal(diagnostic.recent().length,1);assert.equal(diagnostic.snapshot().disposed,true);
});

test('native identity is a safe main PID, exact pointer string and renderer PID',()=>{
 const pet=windowFixture(),handle=Buffer.alloc(8);handle.writeBigUInt64LE(9007199254740993n);
 pet.getNativeWindowHandle=()=>handle;pet.webContents={getOSProcessId:()=>2233};
 const diagnostic=createPetWindowDiagnostics(()=>pet,()=>{},{getMainPID:()=>1122,getExpected:()=>({alwaysOnTop:true})});
 const snapshot=diagnostic.snapshot(),row=diagnostic.record('focus');
 assert.equal(snapshot.mainPID,1122);assert.equal(snapshot.nativeHandle,'9007199254740993');assert.equal(snapshot.rendererPID,2233);
 assert.equal(row.native.mainPID,1122);assert.equal(row.native.nativeHandle,snapshot.nativeHandle);assert.equal(row.native.rendererPID,2233);
 assert.equal(row.expected.alwaysOnTop,true);assert.equal(row.native.alwaysOnTop,false);assert.deepEqual(row.native.readErrors,[]);
});

test('optional identities are absent-safe and destroyed windows never read their native handle',()=>{
 const pet=windowFixture(),diagnostic=createPetWindowDiagnostics(()=>pet);
 assert.equal(diagnostic.snapshot().mainPID,process.pid);assert.equal(diagnostic.snapshot().nativeHandle,null);assert.equal(diagnostic.snapshot().rendererPID,null);assert.deepEqual(diagnostic.snapshot().readErrors,[]);
 pet.isDestroyed=()=>true;pet.getNativeWindowHandle=()=>assert.fail('destroyed native handle');pet.webContents={getOSProcessId:()=>assert.fail('destroyed renderer PID')};
 assert.equal(diagnostic.snapshot().destroyed,true);
});

test('identity getter failures expose only stable field names, never exception data',()=>{
 const pet=windowFixture();pet.getNativeWindowHandle=()=>{throw Error('SECRET_HANDLE_PATH');};Object.defineProperty(pet,'webContents',{get(){throw Error('SECRET_RENDERER_URL');}});
 const diagnostic=createPetWindowDiagnostics(()=>pet,()=>{},{getMainPID:()=>{throw Error('SECRET_MAIN');}}),snapshot=diagnostic.snapshot();
 assert.equal(snapshot.mainPID,null);assert.equal(snapshot.nativeHandle,null);assert.equal(snapshot.rendererPID,null);
 assert.deepEqual(snapshot.readErrors,['mainPID','nativeHandle','rendererPID']);assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
});

test('invalid identity values are excluded instead of stringifying arbitrary objects',()=>{
 const pet=windowFixture();pet.getNativeWindowHandle=()=>({toString(){throw Error('must not serialize');}});pet.webContents={getOSProcessId:()=>-2};
 const snapshot=createPetWindowDiagnostics(()=>pet,()=>{},{getMainPID:()=>Infinity}).snapshot();
 assert.equal(snapshot.mainPID,null);assert.equal(snapshot.nativeHandle,null);assert.equal(snapshot.rendererPID,null);
});
