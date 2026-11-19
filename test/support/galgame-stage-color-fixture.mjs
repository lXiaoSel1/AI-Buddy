import React from 'react';
import appearanceCSS from '../../src/appearance.css' with {type:'text'};
import voiceDesignCSS from '../../src/voice/voice-design.css' with {type:'text'};
import designChatCSS from '../../src/voice/design-chat.css' with {type:'text'};
import {VoiceButton,VoiceRecordingRow} from '../../src/voice/design-ui.mjs';
import {applyAppearance} from '../../src/appearance.mjs';
import {GALGAME_REDESIGN_STYLE} from '../../src/galgame-redesign-style.mjs';
import {GalgameSettings,useGalgameStageScheme} from '../../src/galgame-redesign.mjs';
import {galgamePresentationSettings} from '../../src/galgame-expressions.mjs';

const h=React.createElement;
function check(condition,message){if(!condition)throw Error(message);}
async function waitFor(predicate){
 for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Fixture renderer timeout');
}
function swatch(rgb){
 const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
 const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,64,18);
 ctx.fillStyle=rgb;ctx.fillRect(0,18,64,18);
 return canvas.toDataURL();
}
function Stage({background}){
 const scheme=useGalgameStageScheme(background);
 return h('div',{className:'gx-redesign','data-stage-scheme':scheme,style:{position:'relative',width:1000,height:700}},
  h('div',{className:'shade'}),
  h('div',{className:'ibar'},h('button',{className:'ib'},'Cancel')),
  h('button',{className:'iline'},'Say something'),
  h('button',{className:'ch'},'Choice'),
  h(GalgameSettings,{name:'Fixture',settings:galgamePresentationSettings({},'fixture'),onPatch(){},onClose(){}}),
  h('div',{className:'gx-paper'},'Gallery'),
  h('div',{className:'gx-paper-dialog'},'History'),
 );
}
export async function run(root){
 const style=document.createElement('style');style.textContent=GALGAME_REDESIGN_STYLE;document.head.append(style);
 const dark=swatch('#1d1d1d'),light=swatch('#ebebeb');
 for(const [theme,background,scheme,overridden] of [
  ['claude',dark,'dark',true],['claude',light,'light',false],
  ['deepseek',light,'light',true],['deepseek',dark,'dark',false],
 ]){
  applyAppearance({theme});
  root.render(h(Stage,{background}));
  await waitFor(()=>document.querySelector('.gx-redesign')?.dataset.stageScheme===scheme);
  const stage=document.querySelector('.gx-redesign');
  const val=(element,name)=>getComputedStyle(element).getPropertyValue(name).trim();
  const themeText=val(document.documentElement,'--buddy-dlg-text');
  const stageText=val(stage,'--dlg-text');
  check(overridden?stageText!==themeText:stageText===themeText,'stage color should preserve matching theme only: '+theme+' '+scheme);
  for(const selector of ['.gx-settings-dialog','.gx-paper','.gx-paper-dialog']){
   check(val(stage.querySelector(selector),'--dlg-text')===themeText,selector+' should keep its theme in '+theme+' '+scheme);
  }
  if(scheme==='light'){
   check(val(stage,'--glass').includes('95%'),'light glass opacity');
   check(val(stage,'--veil').includes('92%'),'light veil opacity');
   check(val(stage,'--shade').includes('95%'),'light shade opacity');
   check(getComputedStyle(stage.querySelector('.iline')).borderRadius==='999px','collapsed input capsule');
  }
 }
}


function paint(color){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
 const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
 return Array.from(ctx.getImageData(0,0,1,1).data);
}
function luminance(pixel){
 const srgb=pixel.slice(0,3).map(value=>value/255);
 const linear=srgb.map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
 return .2126*linear[0]+.7152*linear[1]+.0722*linear[2];
}
function contrast(first,second){
 const a=luminance(first),b=luminance(second);
 return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}
function RecordingStage({scheme,classic}){
 const cancel=()=>h(VoiceButton,{kind:'ghost'},'取消');
 return h('div',{className:'gx-redesign','data-stage-scheme':scheme},
  h('section',{className:classic?'gx-classic-content':'dialogue-shell'},
   h('div',{className:'bottom'},h(VoiceRecordingRow,{onCancel(){},onFinish(){}}))),
  h('div',{className:'vx-popat'},cancel()),
  h('div',{className:'gx-paper-dialog'},cancel()),
 );
}
export async function recordingContrast(root){
 for(const source of [appearanceCSS,voiceDesignCSS,designChatCSS,GALGAME_REDESIGN_STYLE]){
  const style=document.createElement('style');style.textContent=source;document.head.append(style);
 }
 const diagnostics=[];
 for(const [theme,scheme,classic] of [
  ['claude','dark',false],['qwen','dark',true],['claude','light',false],['deepseek','light',true],
 ]){
  applyAppearance({theme});
  root.render(h(RecordingStage,{key:theme+scheme,scheme,classic}));
  await waitFor(()=>document.querySelector('.gx-redesign')?.dataset.stageScheme===scheme&&Boolean(document.querySelector('.gx-classic-content'))===classic);
  const stage=document.querySelector('.gx-redesign'),button=stage.querySelector('[data-voice-recording]>.ui-btn.ghost');
  const foreground=paint(getComputedStyle(button).color),background=paint(getComputedStyle(button).backgroundColor);
  const panel=document.createElement('span');panel.style.color='var(--dlg-text)';stage.append(panel);
  const expectedText=getComputedStyle(panel).color;panel.remove();
  const hostAccent=paint(getComputedStyle(document.documentElement).getPropertyValue('--buddy-accent-text').trim());
  for(const selector of ['.vx-popat','.gx-paper-dialog']){
   const outside=stage.querySelector(selector+' .ui-btn.ghost');
   check(paint(getComputedStyle(outside).color).join()===hostAccent.join(),selector+' must keep the host ghost text color');
   check(paint(getComputedStyle(outside).backgroundColor)[3]===0,selector+' must keep the host ghost background');
  }
  if(getComputedStyle(button).color!==expectedText||background[3]!==255||contrast(foreground,background)<4.5){
   diagnostics.push({theme,scheme,classic,foreground,background,expectedText,contrast:contrast(foreground,background)});
  }
 }
 check(!diagnostics.length,'Recording Cancel must use stage text on a solid background with contrast at least 4.5: '+JSON.stringify(diagnostics));
}
