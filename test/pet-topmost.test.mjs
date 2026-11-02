import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/pet-window.mjs';

function nativeWindow() {
  const calls=[];
  return {calls,topmost:false,behindTaskbar:false,destroyed:false,
    isDestroyed(){return this.destroyed;},
    setAlwaysOnTop(enabled,level){calls.push({enabled,level});this.topmost=enabled;this.behindTaskbar=enabled&&level==='floating';},
    activateWithOrdinaryTaskbar(){if(this.behindTaskbar)this.topmost=false;},
    show(){assert.fail('policy must not show the window');},focus(){assert.fail('policy must not steal focus');},restore(){assert.fail('policy must not restore the window');},
  };
}

test('Windows topmost policy avoids activation demotion behind an ordinary taskbar',()=>{
  const legacy=nativeWindow();legacy.setAlwaysOnTop(true,'floating');legacy.activateWithOrdinaryTaskbar();assert.equal(legacy.topmost,false,'positive control matches captured Windows/Electron ordering');
  const fixed=nativeWindow();policy.applyPetTopmost(fixed,true,'win32');fixed.activateWithOrdinaryTaskbar();
  assert.equal(fixed.topmost,true);assert.deepEqual(fixed.calls,[{enabled:true,level:'pop-up-menu'}]);
});

test('turning topmost off remains off and repeated preference application does not focus or show',()=>{
  const win=nativeWindow();policy.applyPetTopmost(win,true,'win32');policy.applyPetTopmost(win,false,'win32');win.activateWithOrdinaryTaskbar();assert.equal(win.topmost,false);
  policy.applyPetTopmost(win,true,'win32');policy.applyPetTopmost(win,true,'win32');win.activateWithOrdinaryTaskbar();assert.equal(win.topmost,true);assert.equal(win.calls.length,4);
});

test('other platforms preserve the previous floating policy and destroyed windows are untouched',()=>{
  for(const platform of ['darwin','linux']){const win=nativeWindow();policy.applyPetTopmost(win,true,platform);policy.applyPetTopmost(win,false,platform);assert.deepEqual(win.calls,[{enabled:true,level:'floating'},{enabled:false,level:'floating'}]);}
  const win=nativeWindow();win.destroyed=true;assert.equal(policy.applyPetTopmost(win,true,'win32'),false);assert.deepEqual(win.calls,[]);assert.equal(policy.applyPetTopmost(null,true,'win32'),false);
});
