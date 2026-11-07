import test from 'node:test';
import assert from 'node:assert/strict';
import {createPetFullscreenPolicy,petVisibility} from '../src/pet-fullscreen.mjs';
import {normalizePreferences,validatePreferencesPatch} from '../src/preferences.mjs';

const display={x:-1920,y:0,width:1920,height:1080};
const foreground={handle:'12',pid:2,monitor:'1',visible:true,minimized:false,cloaked:false,maximized:false,system:false,bounds:display,client:display};
const sample={foreground,pet:{monitor:'1'},monitor:display};

test('fullscreen is opt-in and temporary reasons preserve the user visibility preference',()=>{
 assert.equal(normalizePreferences({petVisible:true}).petHideOnFullscreen,false);
 assert.deepEqual(validatePreferencesPatch({petHideOnFullscreen:true}),{petHideOnFullscreen:true});
 assert.equal(normalizePreferences({petVisible:false,petHideOnFullscreen:true}).petHideOnFullscreen,true);
 assert.deepEqual(petVisibility({userVisible:true,assetsReady:true,fullscreen:true}),{visible:false,hiddenReasons:['fullscreen']});
 assert.deepEqual(petVisibility({userVisible:false,assetsReady:true,fullscreen:false}),{visible:false,hiddenReasons:['user']});
 assert.deepEqual(petVisibility({userVisible:true,assetsReady:false,fullscreen:true,quitting:true}),{visible:false,hiddenReasons:['assets-not-ready','fullscreen','quitting']});
 assert.deepEqual(petVisibility({userVisible:true,assetsReady:true}),{visible:true,hiddenReasons:[]});
});

test('only a stable, foreground fullscreen on the pet monitor hides and restores the pet',()=>{
 let now=0;const states=[];const policy=createPetFullscreenPolicy({ownerPid:3,now:()=>now,onChange:hidden=>states.push(hidden)});
 const observe=(value,t)=>{now=t;policy.observe(value);};
 const otherMonitor={...sample,pet:{monitor:'2'}};
 observe(sample,0);observe(otherMonitor,100);observe(sample,150);observe(sample,350);
 assert.deepEqual(states,[]);observe(sample,550);assert.deepEqual(states,[true]);
 // Focusing the taskbar or losing focus briefly does not flash the pet.
 observe(otherMonitor,600);observe(sample,700);observe(sample,950);assert.deepEqual(states,[true]);
 observe(otherMonitor,1000);observe(otherMonitor,1400);assert.deepEqual(states,[true,false]);
 for(const patch of [{pid:3},{minimized:true},{cloaked:true},{maximized:true},{system:true},{visible:false},{client:{...display,height:1030}}]){
  const value={...sample,foreground:{...foreground,...patch}};
  observe(value,now+500);observe(value,now+400);
 }
 assert.deepEqual(states,[true,false]);
 observe(sample,now+500);observe(sample,now+400);policy.reset();assert.deepEqual(states,[true,false,true,false]);
});

test('F11 entered from a maximized Chromium window may retain the maximized bit',()=>{
 let now=0;const states=[],policy=createPetFullscreenPolicy({ownerPid:3,now:()=>now,onChange:hidden=>states.push(hidden)});
 const observe=(framed,t)=>{now=t;policy.observe({...sample,foreground:{...foreground,maximized:true,framed}});};
 observe(true,0);observe(true,400);assert.deepEqual(states,[],'maximization with the taskbar hidden does not hide the pet');
 observe(false,500);observe(false,900);assert.deepEqual(states,[true],'the frameless client fills the display after F11');
});
