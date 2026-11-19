import React from 'react';
import dashboardCSS from '../../src/dashboard.css' with {type:'text'};
import appearanceCSS from '../../src/appearance.css' with {type:'text'};
import workspaceCSS from '../../src/workspace.css' with {type:'text'};
import voiceDesignCSS from '../../src/voice/voice-design.css' with {type:'text'};
import designChatCSS from '../../src/voice/design-chat.css' with {type:'text'};
import voiceCloudCSS from '../../src/voice/voice-ui-cloud.css' with {type:'text'};
import shellCSS from '../../src/voice/shell-design.css' with {type:'text'};
import {GalgameApp,GalgameCSS} from '../../src/adapted/galgame-client.ts';
import {applyAppearance,THEMES} from '../../src/appearance.mjs';
import {setLocale} from '../../src/i18n.mjs';
import {CompanionGroupDialogue} from '../../src/companion-ui.mjs';
import {AutoChip} from '../../src/chat-r95-ui.mjs';
import {VoiceChip} from '../../src/voice/design-ui.mjs';
import {ensureVoiceSession} from '../../src/voice/client.mjs';

const h=React.createElement;
function assert(value,message){if(!value)throw Error(message);}
async function waitFor(check,description){
 for(let i=0;i<200;i++){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Galgame stage did not reach '+description);
}
const element=(selector,container=document)=>waitFor(()=>container.querySelector(selector),selector);
const buttonNamed=(container,label)=>waitFor(()=>[...container.querySelectorAll('button')].find(node=>node.textContent.trim()===label),label);
async function openMenu(){(await element('[data-galgame-menu]')).click();return element('.gx-redesign .menu');}
async function clickMenu(label){const menu=await openMenu();(await buttonNamed(menu,label)).click();}

export async function mount(root){
 applyAppearance({theme:'deepseek'});setLocale('zh-CN');
 const style=document.createElement('style');style.textContent=GalgameCSS+'\nbody{margin:0}#mount{width:1200px;height:760px}';document.head.append(style);
 root.render(h('div',{className:'galgame-page'},h(GalgameApp,{variant:'tab',useSessions:null,chat:{enabled:true}})));
 await element('#whg-panel');
}

export async function thinking(root){
 await mount(root);
 assert((await element('.say .nm')).textContent.includes('Fixture user'),'Existing user nameplate before reply');
 (await element('[data-galgame-input-toggle]')).click();
 const composer=await element('textarea.whg-input');
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(composer,'A synthetic waiting reply');
 composer.dispatchEvent(new Event('input',{bubbles:true}));
 const send=await buttonNamed(await element('.ibar'),'回复');
 await waitFor(()=>!send.disabled,'enabled send button');
 send.click();
 await element('.gx-typing');
 assert((await element('.say .nm')).textContent.includes('DeepSeek'),'Thinking plate should name DeepSeek');
}

export async function gallery(root,count){
 await mount(root);
 const menu=await openMenu();
 const galleryButton=await waitFor(()=>[...menu.querySelectorAll('button')].find(node=>node.textContent.includes('CG 图鉴')),'gallery menu item');
 const badge=galleryButton.querySelector('.r');
 assert(count===0?!badge:badge?.textContent.trim()===String(count),'Menu gallery count should match '+count);
}

function chooseFile(dialog,file){
 const input=dialog.querySelector('input[type=file]');
 const files=new DataTransfer();
 files.items.add(file);
 input.files=files.files;
 input.dispatchEvent(new Event('change',{bubbles:true}));
}
function imageFile(){
 const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
 const bytes=Uint8Array.from(atob(canvas.toDataURL().split(',')[1]),character=>character.charCodeAt(0));
 return new File([bytes],'preview.png',{type:'image/png'});
}

export async function background(root){
 await mount(root);
 await clickMenu('背景图');
 const dialog=await element('.gx-paper-picker-dialog[open]'),preview=await element('.whg-bg-preview',dialog);
 const layout=await element('.whg-bg-picker .gx-pop-b',dialog);
 const [left,right]=getComputedStyle(layout).gridTemplateColumns.split(' ').map(parseFloat);
 assert(Math.abs(left/right-1.3)<.02&&getComputedStyle(layout).columnGap==='18px','Background picker must use the approved columns');
 assert(preview.parentElement.textContent.includes('正在使用 · 角色背景'),'Current preview needs its stage label');
 assert(dialog.querySelectorAll('.whg-bg-builtin').length===2,'Expected two actual built-in backgrounds');
 const cg=dialog.querySelector('.whg-bg-override-note');
 assert(cg?.textContent.startsWith('特殊 CG 正在覆盖角色背景。')&&cg.getBoundingClientRect().left===preview.getBoundingClientRect().left,'CG override notice should be under the active preview');
 assert(dialog.querySelector('.gx-pop-f').textContent.includes('选择一张本地图片后在这里预览'),'Background footer is missing its preview note');
 const apply=await buttonNamed(dialog,'应用到背景'),original=preview.src,stage=document.querySelector('.whg-scene .whg-bg').src;
 assert(apply.disabled,'Background apply is disabled initially');
 chooseFile(dialog,imageFile());
 await waitFor(()=>!apply.disabled&&preview.src!==original,'background file preview');
 assert(document.querySelector('.whg-scene .whg-bg').src===stage,'Preview does not change the active stage');
 (await buttonNamed(dialog,'取消预览')).click();
 await waitFor(()=>preview.src===original&&apply.disabled,'cancel restores currently saved background preview');
}

export async function portrait(root){
 await mount(root);
 await clickMenu('角色立绘');
 const dialog=await element('.gx-paper-picker-dialog[open]'),preview=await element('.whg-sprite-preview-shell',dialog);
 const layout=await element('.whg-sprite-picker .gx-pop-b',dialog);
 assert(getComputedStyle(layout).gridTemplateColumns.startsWith('300px ')&&getComputedStyle(layout).columnGap==='20px','Portrait picker needs the 300px + flexible columns');
 assert(Math.round(preview.getBoundingClientRect().height)===430,'Portrait checker preview must be 430px tall');
 assert(dialog.textContent.includes('表情差分和小动作仍然生效，但图只有一张'),'Portrait behavior note is missing');
 const apply=await buttonNamed(dialog,'应用这张立绘');
 assert(apply.disabled,'Apply stays disabled before an image is selected');
 chooseFile(dialog,new File(['wrong'],'sample.txt',{type:'text/plain'}));
 const error=await element('.whg-bg-error[role=alert]',dialog);
 assert(error.textContent.includes('请选择 PNG、JPG、WebP 或 AVIF 图片。'),'Invalid portrait format remains rejected');
 chooseFile(dialog,imageFile());
 await waitFor(()=>!apply.disabled&&preview.querySelector('img')?.getAttribute('src').startsWith('data:image/png'),'local portrait preview');
 dialog.querySelector('header button').click();
 await waitFor(()=>!dialog.isConnected,'portrait cancelled');
 await clickMenu('角色立绘');
 const reopened=await element('.gx-paper-picker-dialog[open]');
 assert((await buttonNamed(reopened,'应用这张立绘')).disabled,'Cancelled portrait is not persisted');
}

function fullStageStyles(locale='zh-CN'){
 setLocale(locale);
 for(const source of [dashboardCSS,appearanceCSS,workspaceCSS,voiceDesignCSS,designChatCSS,voiceCloudCSS,shellCSS,GalgameCSS]){
  const css=document.createElement('style');css.textContent=source;document.head.append(css);
 }
 const fixture=document.createElement('style');fixture.textContent='#whg-tab-root.gx-redesign{height:720px}';document.head.append(fixture);
}
async function mountFullStage(root,{chat=true,theme='claude',locale='zh-CN'}={}){
 fullStageStyles(locale);applyAppearance({theme});
 root.render(h('div',{className:'galgame-page'},h(GalgameApp,{variant:'tab',useSessions:null,chat:{enabled:chat}})));
 await element('#whg-panel');
}
function hit(x,y,within){return within.contains(document.elementFromPoint(x,y));}
export async function composerChoices(root){
 await mountFullStage(root);
 const choices=await element('.choices');
 const closedBottom=choices.getBoundingClientRect().bottom;
 (await element('[data-galgame-input-toggle]')).click();
 const composer=await element('.dialogue-shell .ibar'),buttons=[...choices.querySelectorAll('button')];
 assert(buttons.length===3,'All three choices must remain available when the composer opens');
 const checkChoiceGeometry=()=>{
  const bar=composer.getBoundingClientRect(),row=choices.getBoundingClientRect(),say=document.querySelector('.say').getBoundingClientRect();
  const hitResults=buttons.map(button=>{
   const rect=button.getBoundingClientRect();
   return hit((rect.left+rect.right)/2,rect.bottom-4,button);
  });
  assert(say.bottom<=row.top&&row.bottom<=bar.top-5&&row.bottom<closedBottom&&hitResults.every(Boolean),
   'Opened composer covers choices: '+JSON.stringify({say:say.toJSON(),choices:row.toJSON(),composer:bar.toJSON(),hitResults}));
 };
 checkChoiceGeometry();
 const editor=composer.querySelector('textarea'),initialHeight=composer.offsetHeight;
 editor.style.fieldSizing='content';
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,'First line\nSecond line\nThird line\nFourth line');
 editor.dispatchEvent(new Event('input',{bubbles:true}));
 await waitFor(()=>composer.offsetHeight>initialHeight&&choices.getBoundingClientRect().bottom<=composer.getBoundingClientRect().top-5,'resized multiline composer and choices');
 assert(editor.value.split('\n').length===4,'Multiline draft stays editable');
 checkChoiceGeometry();
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,'');
 editor.dispatchEvent(new Event('input',{bubbles:true}));
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await element('[data-galgame-input-toggle]');
 assert(Math.abs((await element('.choices')).getBoundingClientRect().bottom-closedBottom)<1,'Closing composer restores collapsed choice position');
}
export async function groupComposer(root){
 await mountFullStage(root);
 const next=await element('[data-companion-group-dialogue] [data-companion-group-continue]');
 (await element('[data-galgame-input-toggle]')).click();
 const composer=await element('.dialogue-shell .ibar'),action=next.getBoundingClientRect();
 assert(action.bottom<composer.getBoundingClientRect().top&&hit((action.left+action.right)/2,action.bottom-3,next),
  'Group Continue should remain above and clickable with the composer open');
 assert(!document.querySelector('.dialogue-shell .choices'),'Group dialogue has its own Continue action');
}
export async function moodLayer(root){
 await mountFullStage(root);
 (await element('[data-galgame-input-toggle]')).click();
 const editor=await element('.dialogue-shell textarea');
 const mood=await element('[data-chat-mood] button');
 mood.click();
 const popup=await element('[data-chat-mood] .r95-pop'),stage=popup.closest('.gx-redesign');
 const popupBounds=popup.getBoundingClientRect(),bounds=stage.getBoundingClientRect();
 assert(popupBounds.top>=mood.getBoundingClientRect().bottom&&popupBounds.left>=bounds.left&&popupBounds.right<=bounds.right+1&&popupBounds.bottom<=bounds.bottom+1,
  'Mood details open downward within the stage: '+JSON.stringify([popupBounds.toJSON(),bounds.toJSON()]));
 assert(centerHits(popup),'Mood popup remains hit-testable above the stage');
 assert(centerHits(editor),'An open mood card leaves the composer accessible outside its bounds');
 mood.click();
 await waitFor(()=>!popup.isConnected,'close mood popover');
}

function cssColor(root,property){
 const probe=document.createElement('span');probe.style.color='var('+property+')';root.append(probe);
 const color=getComputedStyle(probe).color;probe.remove();return color;
}
export async function stageStatusContrast(root){
 await mountFullStage(root,{chat:false});
 const alert=await element('.dialogue-shell .gx-alert.info [class="grow"]');
 const voice=await element('.corner .vx-vst.idle'),auto=await element('.corner [data-r95-auto-menu] .r95-chip-st');
 const stage=await element('#whg-tab-root[data-stage-scheme="dark"]'),details=[];
 auto.closest('button').click();
 const popup=await element('.corner [data-r95-auto-menu] .r95-pop',stage);
 const heading=await element('.r95-pop-h',popup),help=await element('.r95-cap',popup);
 const fields=popup.querySelectorAll('.ws-fld>span');
 const radios=popup.querySelectorAll('.ui-seg [role=radio]');
 for(const [property,nodes] of [
  ['--dlg-text',[alert,heading,...fields,radios[0]]],
  ['--dlg-muted',[voice,auto,help,...[...radios].slice(1)]],
 ]){
  const expected=cssColor(stage,property);
  for(const node of nodes){
   const actual=getComputedStyle(node).color;
   if(actual!==expected)details.push({text:node.textContent,color:actual,expected});
  }
 }
 assert(!details.length,'Dark stage status text inherited workspace colors: '+JSON.stringify(details));
}

export async function stageErrorAndPaperContrast(root){
 fullStageStyles();
 const character={id:'deepseek',name:'DeepSeek',builtin:true,effective:{}},group={id:'contrast-group',name:'Contrast group',personaId:'self',memberIds:[character.id]};
 const state={activeGroupId:group.id,groups:[group],characters:[character],groupRuntime:{status:'failed',canRetry:true,error:'Synthetic failed turn',queue:[character.id]}};
 const chips=(stage=false)=>h('div',{className:stage?'corner br':undefined},h(VoiceChip,{}),h(AutoChip,{view:{},onAction(){}}));
 const color=(selector,host)=>getComputedStyle(host.querySelector(selector)).color;
 for(const [theme,scheme,classic] of [['claude','dark',true],['deepseek','light',false]]){
  applyAppearance({theme});
  root.render(h(React.Fragment,null,
   h('div',{className:'gx-redesign','data-stage-scheme':scheme,key:theme},chips(true),
    h(CompanionGroupDialogue,{state,request:async()=>({}),classic,stageUi:{}}),
    h('div',{className:classic?'gx-classic-content':'dialogue-shell'},
     h('div',{className:classic?undefined:'say'},
      h('div',{className:'gx-paper-dialog'},chips(),h('div',{className:'gx-alert',role:'alert'},h('span',{className:'grow'},'Paper alert')))))),
   h('div',{className:'contrast-workspace'},chips(),h('div',{className:'gx-alert',role:'alert'},h('span',{className:'grow'},'Workspace alert')))));
  const stage=await waitFor(()=>document.querySelector('.gx-redesign[data-stage-scheme="'+scheme+'"]'),scheme+' stage');
  const error=await element('.gx-alert[data-group-error] .grow',stage);
  assert(color('.gx-alert[data-group-error] .grow',stage)===cssColor(stage,'--dlg-text')&&getComputedStyle(error.querySelector('b')).color===cssColor(stage,'--dlg-text'),
   'Stage error summary must use dialogue ink in '+scheme+' '+classic);
  for(const sample of [stage.querySelector('.gx-paper-dialog'),document.querySelector('.contrast-workspace')]){
   assert(color('.gx-alert .grow',sample)===cssColor(sample,'--buddy-dlg-text'),'Paper and workspace alert keep theme ink');
   assert(color('.vx-vst',sample)===cssColor(sample,'--buddy-dlg-muted'),'Paper and workspace voice status keep theme ink');
   assert(color('.r95-chip-st',sample)===cssColor(sample,'--buddy-muted'),'Paper and workspace Auto status keep theme ink');
  }
 }
}

async function verifyGroupStageInk(root,targets,{openInput=false}={}){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root[data-stage-scheme="dark"]');
 if(openInput){
  (await element('[data-galgame-input-toggle]',stage)).click();
  await element('.dialogue-shell textarea',stage);
 }
 const details=[];
 for(const [selector,property] of targets){
  const node=await element(selector,stage);
  const actual=getComputedStyle(node).color,expected=cssColor(stage,property);
  if(actual!==expected)details.push({selector,text:node.textContent,actual,expected});
 }
 assert(!details.length,'Group stage text should follow its dialog colors: '+JSON.stringify(details));
}
export const groupHintInk=root=>verifyGroupStageInk(root,[['.buddy-group-hint','--dlg-muted']],{openInput:true});
export const activeAutoInk=root=>verifyGroupStageInk(root,[
 ['.corner.br [data-r95-auto-menu] .r95-chip.on .r95-chip-st','--dlg-text'],
 ['.gx-round-actions [data-auto-strip] .r95-auto-detail','--dlg-muted'],
]);

export async function activeAutoStopHit(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp');
 stage.style.width='1280px';document.body.style.margin='0';
 const auto=await element('.corner.br [data-r95-auto-menu] button',stage),toolbar=auto.closest('.corner');
 const strip=await element('[data-auto-strip]',stage),stop=await element('button.danger',strip);
 const toggle=await element('[data-galgame-input-toggle]',stage);
 const collapsed=stop.getBoundingClientRect();
 assert(hit(collapsed.x+collapsed.width/2,collapsed.y+collapsed.height/2,stop),'Stop remains reachable with the composer closed');
 toggle.click();
 const composer=await element('.dialogue-shell .ibar',stage),editor=await element('textarea',composer);
 const measure=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 function probe(width,lines){
  const controls=[stop,auto,editor].map(node=>{
   const rect=node.getBoundingClientRect();
   const points=[.2,.5,.8].map(part=>{
    const top=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height*part);
    return {hit:node.contains(top),coveredBy:node.contains(top)?null:top?.closest('.corner')?.className??top?.tagName};
   });
   return {rect:rect.toJSON(),points};
  });
  const tools=toolbar.getBoundingClientRect(),round=strip.getBoundingClientRect(),bar=composer.getBoundingClientRect();
  assert(tools.bottom<=round.top&&round.bottom<=bar.top&&controls.every(row=>row.points.every(point=>point.hit)),
   'The toolbar, active Auto strip and composer must be vertically ordered and reachable at '+width+'px with '+lines+' draft lines: '+JSON.stringify({controls,toolbar:tools.toJSON(),autoStrip:round.toJSON(),composer:bar.toJSON()}));
 }
 await measure();probe(1280,1);
 const previous=composer.offsetHeight;
 stage.style.width='1100px';editor.style.fieldSizing='content';editor.style.minHeight='58px';editor.style.maxHeight='200px';
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,'One\nTwo\nThree\nFour\nFive');
 editor.dispatchEvent(new Event('input',{bubbles:true}));
 await waitFor(()=>composer.offsetHeight>previous,'five-line active Auto composer');
 await measure();probe(1100,5);
}

export async function groupAutoHit(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp'),diagnostics=[];
 const auto=await element('.corner.br [data-r95-auto-menu] button',stage);
 const corner=auto.closest('.corner'),toggle=await element('[data-galgame-input-toggle]',stage);
 toggle.click();
 const wrapper=await element('.dialogue-shell .ibar',stage),editor=await element('textarea',wrapper);
 function probe(width,lines){
  const button=auto.getBoundingClientRect(),composer=wrapper.getBoundingClientRect(),tools=corner.getBoundingClientRect(),editorBounds=editor.getBoundingClientRect();
  const line=stage.querySelector('.dialogue-shell .tx .whg-line-now'),label=document.createRange();
  label.selectNodeContents(line);
  const text=label.getBoundingClientRect(),glyphOverlap=text.left<tools.right&&text.right>tools.left&&text.top<tools.bottom&&text.bottom>tools.top;
  const points=[.2,.5,.8].map(part=>{
   const top=document.elementFromPoint(button.x+button.width/2,button.y+button.height*part);
   return {part,hit:auto.contains(top),tag:top?.tagName,classes:top?.getAttribute('class')};
  });
  const editorHit=hit(editorBounds.x+editorBounds.width/2,editorBounds.y+editorBounds.height/2,editor);
  if(points.some(point=>!point.hit)||composer.top<tools.bottom||!editorHit||glyphOverlap){
   diagnostics.push({width,lines,button:button.toJSON(),composer:composer.toJSON(),tools:tools.toJSON(),text:text.toJSON(),glyphOverlap,points,editorHit});
  }
 }
 const setValue=value=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,value);
  editor.dispatchEvent(new Event('input',{bubbles:true}));
 };
 const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 for(const width of [1280,1100]){
  stage.style.width=width+'px';
  setValue('');
  await settle();
  probe(width,1);
  const previous=wrapper.offsetHeight;
  editor.style.fieldSizing='content';
  editor.style.minHeight='58px';
  editor.style.maxHeight='200px';
  setValue('One line\nTwo lines\nThree lines\nFour lines\nFive lines');
  await waitFor(()=>wrapper.offsetHeight>previous,'group multiline composer resize');
  await settle();
  probe(width,5);
 }
 assert(!diagnostics.length,'Group Auto hit or composer separation failed: '+JSON.stringify(diagnostics));
 auto.click();
 const popup=await element('[data-r95-auto-menu] .r95-pop',stage);
 assert(getComputedStyle(corner).zIndex==='5','Opened Auto popover keeps its existing stacking layer');
 const popupBounds=popup.getBoundingClientRect();
 assert(hit(popupBounds.x+popupBounds.width/2,popupBounds.y+14,popup),'Opened Auto popover remains clickable');
}

function mockRecordingCapture(){
 const track={stop(){}},connect=()=>({connect(){},disconnect(){}});
 const context={...connect(),state:'running',sampleRate:16000,destination:{},resume:async()=>{},close:async()=>{},
  audioWorklet:{addModule:async()=>{}},createMediaStreamSource:connect,createGain:()=>({...connect(),gain:{value:0}})};
 ensureVoiceSession(globalThis.whale.voice,{createContext:({sampleRate})=>({...context,sampleRate}),captureOptions:{
  workletURL:'fixture',getMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]}),makeContext:()=>context,
  makeNode:()=>({...connect(),port:{onmessage:null,postMessage(){}}})
 }});
}
export async function groupRecordingHit(root){
 mockRecordingCapture();
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp');
 (await element('[data-galgame-input-toggle]',stage)).click();
 const mic=await waitFor(()=>stage.querySelector('.vx-mic:not(:disabled)'),'ready local recording control');
 mic.click();
 const recording=await element('[data-voice-recording]',stage),auto=await element('[data-r95-auto-menu] button',stage);
 await waitFor(()=>recording.getBoundingClientRect().top-auto.closest('.corner').getBoundingClientRect().bottom>=5,'recording row has independent toolbar space');
 const box=auto.getBoundingClientRect();
 for(const y of [.2,.5,.8])assert(hit(box.x+box.width/2,box.y+box.height*y,auto),'Auto remains clickable above group recording');
 const cancel=await element('[data-voice-recording] .ui-btn.ghost',stage),target=cancel.getBoundingClientRect();
 assert(hit(target.x+target.width/2,target.y+target.height/2,cancel),'Recording Cancel remains clickable below group toolbar');
 cancel.click();
 await waitFor(()=>!recording.isConnected,'stop fixture recording');
}

const settleStage=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
function setStageDraft(editor,value){
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,value);
 editor.dispatchEvent(new Event('input',{bubbles:true}));
}
export async function longDialogue(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root'),say=await element('.dialogue-shell .say');
 const words=await element('.tx',say);
 assert(words.textContent.length>=780,'Expected the supplied long reply, rendered through the stage');
 for(const width of [1100,1280,1411]){
  stage.style.width=width+'px';
  await settleStage();
  const height=say.getBoundingClientRect().height;
  assert(height<=stage.clientHeight*.3+2,'Long frameless reply extends past 30%: '+JSON.stringify({width,height,stage:stage.clientHeight}));
  assert(words.scrollHeight>words.clientHeight,'Long reply must scroll inside the dialogue');
  const full=await element('[data-view-full-message]',say);
  const box=full.getBoundingClientRect();
  assert(hit(box.x+box.width/2,box.y+box.height/2,full),'Full message control remains reachable');
 }
}
const stageWidths=[1100,1280,1411];
const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
const controlSelector='button:not(:disabled),textarea:not(:disabled),a,summary';
const hasArea=rect=>rect.width>0&&rect.height>0;
const centerHits=control=>{
 const rect=control.getBoundingClientRect();
 return hasArea(rect)&&hit(rect.x+rect.width/2,rect.y+rect.height/2,control);
};
function isShownControl(control){
 if(control.closest('[hidden]'))return false;
 const closed=control.closest('details:not([open])');
 return !closed||closed.querySelector(':scope > summary')?.contains(control);
}
function probeBottom(stage,width,mode,{phase,choices=false,auto=false}){
 const selectors=['.say','.corner.br','.corner.tr','.corner.tr > .glass:nth-child(2)'];
 if(stage.querySelector('.grail'))selectors.push('.grail');
 if(choices)selectors.push('.choices');
 if(phase==='closed')selectors.push('.iline');
 if(phase==='draft')selectors.push('.ibar');
 if(phase==='recording')selectors.push('[data-voice-recording]');
 if(auto)selectors.push('[data-auto-strip],[data-auto-ended]');
 const failures=[];
 const regions=[];
 for(const selector of selectors){
  const node=stage.querySelector(selector);
  if(!node){failures.push(selector+' missing');continue;}
  const rect=node.getBoundingClientRect();
  if(!hasArea(rect))failures.push(selector+' has no visible area');
  regions.push({selector,node,rect});
 }
 for(const [index,{selector,node,rect}] of regions.entries()){
  for(const other of regions.slice(index+1)){
   const ownAutoStrip=node.matches('.say')&&other.node.matches('[data-auto-strip],[data-auto-ended]')&&node.contains(other.node);
   if(!ownAutoStrip&&overlaps(rect,other.rect))failures.push(selector+' / '+other.selector);
  }
 }
 const controls=new Set(regions.flatMap(({node})=>[
  ...node.querySelectorAll(controlSelector),
  ...(node.matches(controlSelector)?[node]:[]),
 ]));
 for(const control of controls){
  if(isShownControl(control)&&!centerHits(control))failures.push('Unreachable control '+(control.getAttribute('aria-label')||control.textContent.trim()||control.tagName));
 }
 const composer=stage.querySelector('.ibar,[data-voice-recording]'),toolbar=stage.querySelector('.corner.br');
 if(composer&&toolbar&&toolbar.getBoundingClientRect().bottom>composer.getBoundingClientRect().top-5)failures.push('toolbar must clear composer');
 const status=stage.querySelector('[data-auto-strip],[data-auto-ended]'),say=stage.querySelector('.say');
 if(status&&say){
  const area=say.getBoundingClientRect(),box=status.getBoundingClientRect();
  if(box.left<area.left-1||box.right>area.right+1||box.top<area.top-1||box.bottom>area.bottom+1)failures.push('Auto status escapes dialogue');
  for(const node of say.querySelectorAll('.nm,.tx,[data-view-full-message],.vx-saying')){
   if(overlaps(box,node.getBoundingClientRect()))failures.push('Auto status overlaps '+node.className);
  }
 }
 assert(!failures.length,'Bottom controls compete at '+width+'px '+mode+': '+failures.join(', '));
}
async function exercisePrivateDrafts(stage,width,choices){
 (await element('[data-galgame-input-toggle]',stage)).click();
 const editor=await element('.ibar textarea',stage);
 const state={phase:'draft',choices};
 setStageDraft(editor,'One');
 await settleStage();probeBottom(stage,width,'one line',state);
 assert(editor.value==='One','One-line draft stays editable');
 const draft=['One','Two','Three','Four','Five'].join('\n');
 setStageDraft(editor,draft);
 await settleStage();probeBottom(stage,width,'five native draft lines',state);
 assert(editor.value===draft,'Multiline draft stays editable');
 setStageDraft(editor,'');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await element('[data-galgame-input-toggle]',stage);
}
export async function privateLayout(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root');
 const choices=await element('.choices',stage);
 for(const width of stageWidths){
  stage.style.width=width+'px';
  await settleStage();probeBottom(stage,width,'collapsed with choices',{phase:'closed',choices:true});
  const row=choices.getBoundingClientRect();
  const say=stage.querySelector('.say').getBoundingClientRect();
  assert(Math.abs(row.top-say.bottom-14)<=1,'Collapsed choice clearance follows its actual height');
  await exercisePrivateDrafts(stage,width,true);
 }
}

export async function groupBottomLayout(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp');
 const status=await element('[data-auto-strip],[data-auto-ended]',stage);
 for(const width of stageWidths){
  stage.style.width=width+'px';
  await settleStage();probeBottom(stage,width,'Auto collapsed',{phase:'closed',auto:true});
  (await element('[data-galgame-input-toggle]',stage)).click();
  const editor=await element('.ibar textarea',stage);
  setStageDraft(editor,'One');
  await settleStage();probeBottom(stage,width,'Auto one-line draft',{phase:'draft',auto:true});
  setStageDraft(editor,'One\nTwo\nThree\nFour\nFive');
  await settleStage();probeBottom(stage,width,'Auto five-line draft',{phase:'draft',auto:true});
  assert(status.isConnected,'Auto state persists through composer changes');
  setStageDraft(editor,'');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await element('[data-galgame-input-toggle]',stage);
 }
}

export async function recordingLayout(root){
 mockRecordingCapture();
 await mountFullStage(root);
 const stage=await element('#whg-tab-root');
 (await element('[data-galgame-input-toggle]',stage)).click();
 const mic=await waitFor(()=>stage.querySelector('.vx-mic:not(:disabled)'),'ready local recording control');
 mic.click();
 const recording=await element('[data-voice-recording]',stage);
 for(const width of stageWidths){
  stage.style.width=width+'px';
  await settleStage();probeBottom(stage,width,'recording',{phase:'recording'});
 }
 (await element('.ui-btn.ghost',recording)).click();
 await waitFor(()=>!recording.isConnected,'exit fixture recording');
}

export async function shortAndClassic(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root');
 await settleStage();
 if(stage.classList.contains('classic')){
  const panel=await element('#whg-panel.gx-classic-content',stage),line=await element('.whg-line-now',panel);
  assert(panel.getBoundingClientRect().height<=stage.clientHeight*.4+2,'Classic panel keeps its 40% height limit');
  assert(line.scrollHeight>line.clientHeight,'Classic long text still scrolls');
  const full=await element('[data-view-full-message]',panel);
  assert(centerHits(full),'Classic full-message control remains reachable');
  full.click();
  await element('dialog.buddy-full-message[open]');
 }else{
  const say=await element('#whg-panel.dialogue-shell .say',stage),words=await element('.tx',say);
  assert(words.clientHeight===words.scrollHeight&&say.offsetHeight<stage.clientHeight*.3,'Short reply fits naturally');
  assert(!say.querySelector('[data-view-full-message]'),'Short reply does not get a full-message button');
  for(const width of stageWidths){
   stage.style.width=width+'px';
   assert(!stage.querySelector('.choices'),'Short private fixture has no choices');
   await settleStage();probeBottom(stage,width,'collapsed without choices',{phase:'closed'});
   await exercisePrivateDrafts(stage,width,false);
  }
 }
}

export async function endedStageContrast(root,inverse){
 const scheme=inverse?'light':'dark',theme=inverse?'deepseek':'claude';
 await mountFullStage(root,{theme});
 const stage=await element('#whg-tab-root[data-stage-scheme="'+scheme+'"]');
 assert(document.documentElement.dataset.scheme!==scheme,'Fixture must exercise a stage scheme opposite the theme');
 const ended=await element('[data-auto-ended]',stage),full=await element('[data-view-full-message]',stage);
 const canvas=document.createElement('canvas'),paint=canvas.getContext('2d',{willReadFrequently:true});
 function luminance(colors){
  paint.clearRect(0,0,1,1);
  for(const color of colors){paint.fillStyle=color;paint.fillRect(0,0,1,1);}
  const [r,g,b]=Array.from(paint.getImageData(0,0,1,1).data).map(value=>{
   const unit=value/255;
   return unit<=.04045?unit/12.92:((unit+.055)/1.055)**2.4;
  });
  return .2126*r+.7152*g+.0722*b;
 }
 const endedFill=getComputedStyle(ended).backgroundColor;
 const fullFill=getComputedStyle(full).backgroundColor;
 const backdrop=cssColor(stage,'--dlg-bg');
 const values=[
  ['ended title',ended.querySelector(':scope > span'),[backdrop,endedFill]],
  ['ended summary',ended.querySelector(':scope > small'),[backdrop,endedFill]],
  ['full message',full,[backdrop,fullFill]],
 ].map(([label,node,fill])=>{
  const bg=luminance(fill),fg=luminance([...fill,getComputedStyle(node).color]);
  return {label,ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};
 });
 assert(values.every(({ratio})=>ratio>=4.5),'Group stage actions require 4.5:1 over their fill in '+scheme+': '+JSON.stringify(values));
}

const approvedSizes=[[944,708,1180],[941,591,1177],[1280,720,1600],[1416,1062,1770],[600,480,900]];
export async function approvedStageGeometry(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root'),say=await element('.say',stage),line=await element('.tx',say);
 const group=stage.classList.contains('grp'),failures=[],diagnostics=[];
 (await element('[data-galgame-input-toggle]',stage)).click();
 const composer=await element('.ibar',stage);
 for(const [width,height,viewport] of approvedSizes){
  await window.resizeFixture(viewport,height+120);
  await waitFor(()=>Math.abs(window.innerWidth-viewport)<=2,'fixture viewport '+viewport+' (actual '+window.innerWidth+')');
  Object.assign(stage.style,{width:width+'px',height:height+'px'});
  await settleStage();await settleStage();
  const bounds=stage.getBoundingClientRect(),speech=say.getBoundingClientRect(),input=composer.getBoundingClientRect();
  const center=bounds.left+(width-(group&&stage.querySelector('.grail')?90:0))/2;
  const details=JSON.stringify({width,height,viewport:window.innerWidth,speech:speech.toJSON(),input:input.toJSON(),lineHeight:line.clientHeight,scrollHeight:line.scrollHeight,children:[...say.children].map(node=>[node.className,node.offsetHeight]),active:[...stage.querySelectorAll('.corner.tr,.corner.br,.corner.tr > .glass:nth-child(2),.grail')].map(node=>[node.className,node.getBoundingClientRect().toJSON()])});
  diagnostics.push(details);
  const history=stage.querySelector('.corner.tr > .glass:nth-child(2)'),tools=stage.querySelector('.corner.br');
  const toolbar=tools.getBoundingClientRect(),record=history.getBoundingClientRect();
  if(Math.abs((toolbar.top+toolbar.bottom-record.top-record.bottom)/2)>2||toolbar.right+2>record.left)failures.push('history alignment '+details);
  const rail=stage.querySelector('.grail');
  if(rail&&rail.getBoundingClientRect().top<Math.max(record.bottom,toolbar.bottom)+8)failures.push('roster alignment '+details);
  probeBottom(stage,width,'approved dimensions',{phase:'draft'});
  const actualFont=parseFloat(getComputedStyle(line).fontSize),expectedFont=Math.max(15,Math.min(20,window.innerWidth*.015));
  if(Math.abs(actualFont-expectedFont)>.05)failures.push('body font size '+details);
  if(Math.abs(bounds.width-width)>1||Math.abs(bounds.height-height)>1)failures.push('test stage size '+details);
  for(const box of [speech,input]){
   if(Math.abs(box.width-width*.68)>1||Math.abs((box.left+box.right)/2-center)>1)failures.push('width or center '+details);
  }
  if(speech.height>height*.22+1||line.clientHeight>3*parseFloat(getComputedStyle(line).lineHeight)+1)failures.push('dialogue height '+details);
  if(speech.height+input.height>height*.4+1)failures.push('bottom height '+details);
  if(Math.abs(input.height-44)>1)failures.push('composer height '+details);
 }
 assert(!failures.length,failures.join('\n'));
 return diagnostics.join('\n');
}

export async function voiceStartStates(root){
 mockRecordingCapture();
 await mountFullStage(root);
 const stage=await element('#whg-tab-root'),chip=await element('.vx-vchip',stage);
 const status=()=>chip.querySelector('.vx-vst');
 await waitFor(()=>status().textContent==='未启动','voice enabled before start');
 const dot=status().querySelector('.vx-vdot');
 assert(status().classList.contains('warn')&&getComputedStyle(dot).backgroundColor===cssColor(dot,'--buddy-warn'),'Cold dot uses the stage warning color');
 chip.click();
 const popup=await element('.vx-pop',stage),toggle=await element('button[role=switch]',popup);
 assert(toggle.getAttribute('aria-checked')==='true','Cold switch stays checked');
 (await buttonNamed(popup,'启动声音')).click();
 await waitFor(()=>status().textContent==='启动中'&&popup.querySelector('.vx-steps .now'),'explicit speech preparation');
 await window.whale.voice.action('fixture-release');
 await waitFor(()=>status().textContent==='Breeze 就绪','speech ready after explicit start');
 toggle.click();
 await waitFor(()=>status().textContent==='语音 关'&&toggle.getAttribute('aria-checked')==='false','switch disables speech');
}

async function stagePortraitRects(stage){
 const group=stage.classList.contains('grp');
 await element(group?'.gf.spk':'.spr',stage);
 const box=stage.getBoundingClientRect();
 return [...stage.querySelectorAll(group?'.gf':'.spr')].map(node=>{
  const {left,top,width,height}=node.getBoundingClientRect();
  return {id:node.dataset.characterId??'private',x:left-box.left,y:top-box.top,width,height};
 });
}

// Centers and outer box widths measured in hidden Electron on da8e1e9.
const baselineGroupCenters={944:[231,623,85,427],941:[230,621,85,426],1280:[321,869,119,595],1416:[358,968,133,663],600:[144,300]};
const baselinePortraitWidths={private:480.28125,claude:388.66669,chatgpt:394.41669,hunyuan:405.91669,deepseek:489.17709};
export async function approvedPortraitGeometry(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root'),rows=[];
 for(const [width,height,viewport] of approvedSizes){
  await window.resizeFixture(viewport,height+120);
  await waitFor(()=>Math.abs(window.innerWidth-viewport)<=2,'fixture portrait viewport');
  Object.assign(stage.style,{width:width+'px',height:height+'px'});
  await settleStage();await settleStage();
  const group=stage.classList.contains('grp'),portraits=await stagePortraitRects(stage);
  const ids=group?(width===600?['claude','deepseek']:['claude','chatgpt','hunyuan','deepseek']):['private'];
  const centers=group?baselineGroupCenters[width]:[width/2];
  assert(portraits.length===ids.length,'Prior stage portrait count at '+width+'px');
  for(const [index,portrait] of portraits.entries()){
   const id=ids[index],top=id==='private'?36:id==='deepseek'?30:122,portraitHeight=id==='private'?864:id==='deepseek'?880:600;
   assert(portrait.id===id&&Math.abs(portrait.x+portrait.width/2-centers[index])<=.05&&Math.abs(portrait.width-baselinePortraitWidths[id])<=.05&&portrait.y===top&&portrait.height===portraitHeight,
    'Prior stage portrait geometry at '+width+'px: '+JSON.stringify(portrait));
  }
  rows.push({width,height,portraits});
 }
 return rows.map(row=>JSON.stringify(row)).join('\n');
}

export async function approvedDenseGeometry(root,english=false){
 await mountFullStage(root,{locale:english?'en':'zh-CN'});
 const stage=await element('#whg-tab-root'),say=await element('.say',stage),line=await element('.tx',say);
 const group=stage.classList.contains('grp'),measures=[];
 if(!group){
  await waitFor(()=>ensureVoiceSession().snapshot().state?.preparation?.state==='ready','ready test voice state');
  await window.whale.voice.action('fixture-dub-failed');
  await element('.st .gx-dub-failure',say);
  await element('.st .stopped',say);
 }
 const full=await element('.st [data-view-full-message]',say);
 (await element('[data-galgame-input-toggle]',stage)).click();
 const composer=await element('.ibar',stage),editor=await element('textarea',composer);
 const draft='Line one\nLine two\nLine three\nLine four\nLine five';
 setStageDraft(editor,draft);
 for(const [width,height,viewport] of approvedSizes){
  await window.resizeFixture(viewport,height+120);
  await waitFor(()=>Math.abs(window.innerWidth-viewport)<=2,'dense fixture viewport');
  Object.assign(stage.style,{width:width+'px',height:height+'px'});
  await settleStage();await settleStage();
  const choices=stage.querySelector('.choices'),foot=say.querySelector('.st'),speech=say.getBoundingClientRect(),input=composer.getBoundingClientRect();
  const row=choices?.getBoundingClientRect(), envelope=input.bottom-speech.top;
  const sum=speech.height+input.height+(row?.height??0),visualLines=line.clientHeight/parseFloat(getComputedStyle(line).lineHeight);
  const measure={width,height,viewport:window.innerWidth,sum,envelope,say:speech.height,tx:line.clientHeight,foot:foot.offsetHeight,choice:row?.height??0,bar:input.height,visibleInput:editor.clientHeight,inputScroll:editor.scrollHeight};
  measures.push(measure);
  assert(speech.height<=height*.22+1&&visualLines>=1.95&&visualLines<=3.05,'Dense dialogue exceeds 22% or body range '+JSON.stringify(measure));
  assert(sum<=height*.4+1,'Dense furniture exceeds 40% '+JSON.stringify(measure));
  if(row){
   assert(Math.abs(row.top-speech.bottom-14)<=1&&Math.abs(input.top-row.bottom-10)<=1,'Dense gaps do not follow measured positions '+JSON.stringify(measure));
   if(width===600)assert(new Set([...choices.children].map(node=>node.offsetTop)).size>=2,'Choices wrap in the minimum stage');
  }
  assert(editor.value===draft&&input.height>=44,'Five-line draft is retained within the growing composer');
  assert(line.hasAttribute('data-scroll-more'),'Long line fades while more text can scroll into view');
  line.scrollTop=line.scrollHeight;line.dispatchEvent(new Event('scroll'));
  assert(!line.hasAttribute('data-scroll-more'),'No fade at the end of a scroll');
  line.scrollTop=0;line.dispatchEvent(new Event('scroll'));
  const hint=stage.querySelector('.ihelp'),hintBox=hint.getBoundingClientRect(),stageBox=stage.getBoundingClientRect();
  assert(hintBox.height>0&&hintBox.top>=input.bottom&&hintBox.bottom<=stageBox.bottom+1&&editor.getAttribute('aria-describedby')===hint.id&&hint.id,'Visible keyboard hint sits below the composer inside the stage');
  probeBottom(stage,width,'dense five-line draft',{phase:'draft',choices:!!choices,auto:group});
  assert(centerHits(full),'Full-message action remains reachable');
  if(english){
   const settings=await element('.gx-dub-failure button',foot);
   assert(settings.textContent==='Open voice settings'&&centerHits(settings),'Wrapped English voice settings link remains reachable');
  }
  if(group){
   const mood=await element('[data-chat-mood] button',stage),moodText=mood.lastElementChild;
   const title=await element('.gx-group-title',stage);
   assert(getComputedStyle(moodText).textOverflow==='ellipsis'&&moodText.scrollWidth>moodText.clientWidth&&mood.title.includes(moodText.textContent),'Mood label ellipsizes and retains its full title');
   assert(getComputedStyle(title).textOverflow==='ellipsis'&&title.parentElement.title===title.textContent,'Group name retains its full title');
   const auto=await element('[data-r95-auto-menu] button',stage);
   auto.click();
   const popup=await element('[data-r95-auto-menu] .r95-pop',stage),box=popup.getBoundingClientRect(),bounds=stage.getBoundingClientRect();
   assert(box.top>=auto.getBoundingClientRect().bottom&&box.left>=bounds.left&&box.right<=bounds.right+1&&box.bottom<=bounds.bottom+1,'Auto menu opens downward within the stage: '+JSON.stringify(box.toJSON()));
   auto.click();
   await waitFor(()=>!popup.isConnected,'closed Auto menu');
  }
 }
 for(const theme of Object.keys(THEMES)){
  applyAppearance({theme});
  const combo=say.offsetHeight+composer.offsetHeight+(stage.querySelector('.choices')?.offsetHeight??0);
  assert(combo<=193&&centerHits(full),'Dense minimum stage remains usable in theme '+theme+' ('+combo+'px)');
 }
 return measures.map(row=>JSON.stringify(row)).join('\n');
}

export async function compactGroupOverlays(root,kind){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp');
 await window.resizeFixture(900,600);
 await waitFor(()=>Math.abs(window.innerWidth-900)<=2,'compact group viewport');
 Object.assign(stage.style,{width:'600px',height:'480px'});
 await settleStage();await settleStage();
 const say=await element('.say',stage),strip=await element('[data-auto-strip]',say);
 if(!kind){
  const actions=[...strip.querySelectorAll(':scope > button, :scope > details > summary')];
  const check=()=>assert(say.getBoundingClientRect().height<=480*.22+1&&actions.length===3&&actions.every(centerHits),
   'Active Auto fits and keeps pause, stop and progress reachable: '+JSON.stringify({say:say.offsetHeight,strip:strip.offsetHeight,actions:actions.map(node=>[node.textContent,centerHits(node)])}));
  check();
  const closed={say:say.getBoundingClientRect().height,strip:strip.getBoundingClientRect().height};
  const summary=actions.find(node=>node.matches('summary'));
  summary.click();await settleStage();
  check();
  const body=await element('.buddy-progress-body',strip);
  assert(centerHits(body),'Expanded Auto progress remains above stage content');
  return JSON.stringify({closed,open:{say:say.getBoundingClientRect().height,strip:strip.getBoundingClientRect().height},controls:actions.length});
 }
 const roster=await element('[data-group-members]',stage),tools=await element('.corner.br',stage);
 roster.click();
 const popup=await element('.gx-members-pop',stage);
 await settleStage();
 const bounds=popup.getBoundingClientRect(),edge=stage.getBoundingClientRect();
 const members=[...popup.querySelectorAll('[data-group-member-view]')],done=[...popup.querySelectorAll('button')].find(node=>node.textContent==='完成');
 assert(bounds.top>=tools.getBoundingClientRect().bottom&&bounds.bottom<=edge.bottom-1,
  'Roster must fit below the toolbar: '+JSON.stringify({roster:bounds.toJSON(),tools:tools.getBoundingClientRect().toJSON()}));
 assert([...tools.querySelectorAll('button:not(:disabled)'),popup.querySelector('input'),done,...members].every(centerHits)&&members.length===4,
  'Toolbar, search, four View controls and Done remain reachable');
 done.click();
 await waitFor(()=>!popup.isConnected,'member popup closed');
 const progress=await element('details > summary',strip);
 assert(centerHits(progress),'Auto progress is reachable again after closing the member popup');
 return JSON.stringify({panelTop:bounds.top,panelBottom:bounds.bottom,toolbarBottom:tools.getBoundingClientRect().bottom,memberControls:members.length,progressRestored:true});
}

export async function compactAutoError(root,english){
 await mountFullStage(root,{locale:english?'en':'zh-CN'});
 const stage=await element('#whg-tab-root.grp');
 await window.resizeFixture(900,600);
 await waitFor(()=>Math.abs(window.innerWidth-900)<=2,'Auto failure viewport');
 Object.assign(stage.style,{width:'600px',height:'480px'});
 await settleStage();await settleStage();
 const say=await element('.say',stage),strip=await element('[data-auto-strip]',say);
 const pause=strip.querySelector(':scope > button'),stop=strip.querySelector('button.danger'),progress=await element('details > summary',strip);
 const cases=[];
 const probe=state=>{
  const box=strip.getBoundingClientRect(),caption=say.getBoundingClientRect();
  cases.push({state,width:box.width,captionWidth:caption.width,right:box.right,stageRight:stage.getBoundingClientRect().right,height:caption.height,
   fits:box.left>=caption.left-1&&box.right<=caption.right+1&&caption.height<=480*.22+1,
   hits:[pause,stop,progress].map(centerHits)});
 };
 probe('initial');
 pause.click();
 const error=await element('.r95-err',strip);
 probe('rejected');
 const errorAccess=error.title===error.textContent&&error.tabIndex===0&&centerHits(error);
 progress.click();await settleStage();
 probe('progress');
 const detailsHit=centerHits(await element('.buddy-progress-body',strip));
 pause.click();
 await waitFor(()=>!error.isConnected&&!pause.disabled,'cleared Auto error after retry');
 probe('error cleared');
 assert(cases.every(row=>row.fits&&row.hits.every(Boolean))&&errorAccess&&detailsHit,
  'Compact Auto fits and preserves direct actions, full error and progress: '+JSON.stringify({cases,errorAccess,detailsHit}));
 return JSON.stringify(cases);
}

export async function topStagePopovers(root,width){
 mockRecordingCapture();
 await mountFullStage(root);
 const stage=await element('#whg-tab-root'),height=width===600?480:708,viewport=width===600?900:1180;
 await window.resizeFixture(viewport,height+120);
 await waitFor(()=>Math.abs(window.innerWidth-viewport)<=2,'toolbar fixture viewport');
 Object.assign(stage.style,{width:width+'px',height:height+'px'});
 await settleStage();await settleStage();
 const records=[];
 const readHit=node=>{
  const box=node.getBoundingClientRect();
  return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
 };
 const note=(type,pop,controls)=>{
  const bounds=stage.getBoundingClientRect(),box=pop.getBoundingClientRect();
  records.push({type,fit:box.left>=bounds.left-1&&box.right<=bounds.right+1&&box.top>=bounds.top-1&&box.bottom<=bounds.bottom+1,box:box.toJSON(),hits:controls.map(node=>{
   const target=readHit(node);
   return {reachable:node.contains(target),element:target?.closest('.corner')?.className??target?.tagName};
  })});
 };
 const close=async pop=>{
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await waitFor(()=>!pop.isConnected,'Escape closes top popover');
 };
 const voice=await element('.tr .vx-vchip',stage);
 await waitFor(()=>voice.textContent.includes('未启动'),'cold voice chip');
 voice.click();
 const voicePop=await element('.tr .vx-pop',stage),toggle=await element('button[role=switch]',voicePop);
 note('voice',voicePop,[toggle,await buttonNamed(voicePop,'启动声音')]);
 const target=readHit(toggle);
 if(toggle.contains(target)){
  target.click();
  await waitFor(()=>toggle.getAttribute('aria-checked')==='false'&&voice.textContent.includes('语音 关'),'pointer-hit voice switch disables speech');
 }
 const disabled=toggle.getAttribute('aria-checked')==='false';
 await close(voicePop);
 (await element('.tr [data-galgame-net] > button',stage)).click();
 const netPop=await element('.tr .r95-net-pop > .r95-pop',stage);
 note('network',netPop,[...netPop.querySelectorAll('[role=switch]')]);
 await close(netPop);
 (await element('[data-galgame-menu]',stage)).click();
 const menu=await element('.menu',stage);
 note('menu',menu,[menu.querySelector('button.mi')]);
 await close(menu);
 assert(disabled&&records.every(row=>row.fit&&row.hits.length&&row.hits.every(hit=>hit.reachable)),
  'First-row popovers fit the stage and their controls take the pointer: '+JSON.stringify({width,disabled,records}));
 return JSON.stringify({width,disabled,records});
}


async function r2Size(stage,[width,height,viewport]){
 await window.resizeFixture(viewport,height+120);
 await waitFor(()=>Math.abs(window.innerWidth-viewport)<=2,'R2 fixture viewport');
 Object.assign(stage.style,{width:width+'px',height:height+'px'});
 await settleStage();await settleStage();
}
const boxOf=node=>node.getBoundingClientRect().toJSON();
const pointTarget=node=>{
 const {left,top,width,height}=node.getBoundingClientRect();
 return document.elementFromPoint(left+width/2,top+height/2);
};

export async function r2Proactive(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root'),tx=await element('.say > .tx',stage),details=[];
 for(const size of [approvedSizes[0],approvedSizes.at(-1)]){
  await r2Size(stage,size);
  const actions=[...stage.querySelectorAll('[data-speech-option]')],bounds=stage.getBoundingClientRect();
  details.push({width:size[0],inside:actions.some(node=>tx.contains(node)),actions:actions.map(node=>[
   node.dataset.speechOption,centerHits(node),boxOf(node),
  ]),fit:actions.every(node=>{
   const b=node.getBoundingClientRect();
   return b.width>0&&b.height>0&&b.top>=bounds.top&&b.bottom<=bounds.bottom&&b.left>=bounds.left&&b.right<=bounds.right;
  })});
  if(actions.length!==2||!actions.every(centerHits))continue;
  pointTarget(actions[0]).click();
  const editor=await element('textarea.whg-input',stage);
  await waitFor(()=>document.activeElement===editor,'reply option focuses the draft');
  if(size[0]===600)editor.dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}));
  else pointTarget(actions[1]).click();
  await waitFor(()=>!stage.querySelector('[data-speech-option=read]'),'dismiss the proactive line');
  if(size[0]===944){
   await window.whale.game('fixture-proactive-rearm');
   await element('[data-speech-option=read]',stage);
  }
 }
 assert(details.every(row=>!row.inside&&row.fit&&row.actions.length===2&&row.actions.every(a=>a[1])),JSON.stringify(details));
 return JSON.stringify(details);
}

function lastTextRect(container){
 const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
 let last;
 for(let node=walker.nextNode();node;node=walker.nextNode())if(node.textContent.trim())last=node;
 const range=document.createRange();
 range.setStart(last,last.length-1);range.setEnd(last,last.length);
 return range.getBoundingClientRect();
}
function tailVisible(tx){
 const tail=lastTextRect(tx),box=tx.getBoundingClientRect();
 return tail.height>0&&tail.bottom<=box.bottom+1&&tail.top>=box.top-1;
}
const r2Text='Synthetic dialogue to exercise the real line wrapping and scroll container. '.repeat(40);

export async function r2Stream(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root');
 await r2Size(stage,approvedSizes[0]);
 const tx=await element('.say > .tx',stage),send=async(requestId,text,finish=false)=>{
  await window.whale.game('fixture-stream',{requestId,text,finish});
  await waitFor(()=>tx.textContent.trim()===text.trim()&&(!finish||!tx.querySelector('[data-streaming-reply]')&&(!stage.classList.contains('grp')||tx.querySelector('[data-group-message-id]'))),'synthetic reply paint');
  await settleStage();
 };
 const results=[];
 await send('first',r2Text+'A');
 results.push({phase:'stream',top:tx.scrollTop,visible:tailVisible(tx)});
 const body=tx.getBoundingClientRect(),beforeWheel=tx.scrollTop;
 if(beforeWheel>0){
  await window.wheelFixture(Math.round(body.x+body.width/2),Math.round(body.y+body.height/2),-250);
  await waitFor(()=>tx.scrollTop<beforeWheel,'upward wheel scrolls the dialogue');
 }
 tx.scrollTop=33;
 await settleStage();
 await send('first',r2Text+'Updated tail B');
 results.push({phase:'opt-out',top:tx.scrollTop});
 tx.scrollTop=tx.scrollHeight;
 await settleStage();
 const previousBottom=tx.scrollTop;
 await send('first',r2Text+r2Text+'Updated tail C');
 results.push({phase:'opt-out after returning to the bottom',top:tx.scrollTop,previousBottom});
 tx.scrollTop=52;
 await settleStage();
 await send('first',r2Text+r2Text+'Updated tail C',true);
 results.push({phase:'saved',top:tx.scrollTop});
 await send('second',r2Text+'Next reply');
 results.push({phase:'next reply',top:tx.scrollTop,visible:tailVisible(tx)});
 assert(results[0].visible&&Math.abs(results[1].top-33)<=1&&Math.abs(results[2].top-previousBottom)<=1&&Math.abs(results[3].top-52)<=1&&results[4].visible,JSON.stringify(results));
 return JSON.stringify(results);
}

export async function r2Font(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root');
 await r2Size(stage,approvedSizes[0]);
 await clickMenu('设置');
 const settings=await element('[data-galgame-settings][open]');
 const tx=await element('.say>.tx',stage),rows=[];
 for(const scale of [.85,1,1.15]){
  const button=settings.querySelector('[data-galgame-setting=fontScale][data-value="'+scale+'"]');
  button.click();
  await waitFor(()=>button.getAttribute('aria-pressed')==='true'&&!button.disabled,'font setting '+scale);
  await settleStage();
  const size=parseFloat(getComputedStyle(tx).fontSize),lh=parseFloat(getComputedStyle(tx).lineHeight);
  rows.push({scale,size,lh,tx:tx.clientHeight,say:tx.parentElement.offsetHeight});
 }
 assert(rows.every(row=>Math.abs(row.size-17.7*row.scale)<.1&&Math.abs(row.lh-1.55*row.size)<.1&&row.tx<=row.lh*3+1&&row.say<=708*.22+1),JSON.stringify(rows));
 return JSON.stringify(rows);
}

async function enterR2Viewing(stage){
 pointTarget(await element('[data-group-members]',stage)).click();
 const panel=await element('.gx-members-pop',stage);
 const buttons=[...panel.querySelectorAll('[data-group-member-view]')];
 const next=buttons.find(node=>node.getAttribute('data-group-member-view')==='claude')??buttons.at(-1);
 pointTarget(next).click();
 const view=await element('.gx-group-stage-controls .buddy-viewing',stage);
 await settleStage();
 return view.parentElement;
}

export async function r2Group(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp'),rows=[];
 // The hidden window exercises normal stage behavior while retaining the app's visibility guard.
 Object.defineProperty(document,'hidden',{value:false,configurable:true});
 await window.whale.game('fixture-group-feedback');
 const feedback=await element('.gx-group-feedback',stage);
 for(const size of approvedSizes){
  await r2Size(stage,size);
  const view=await enterR2Viewing(stage),back=view.querySelector('button');
  const controls=['.corner.tl','.corner.tr > .glass:first-child','.corner.tr > .glass:nth-child(2)','.corner.br','.grail'].map(s=>stage.querySelector(s)).filter(n=>n?.getBoundingClientRect().width);
  const bounds=boxOf(view);
  const feedbackBounds=boxOf(feedback);
  const visibleControls=[...stage.querySelectorAll('.corner button:not(:disabled),button.grail,.gx-group-stage-controls button')].filter(node=>isShownControl(node)&&hasArea(node.getBoundingClientRect()));
  const row={width:size[0],bounds,feedback:feedbackBounds,
   collides:controls.filter(n=>overlaps(bounds,boxOf(n))||overlaps(feedbackBounds,boxOf(n))).map(n=>n.className),
   hit:centerHits(back)&&visibleControls.every(centerHits),
   missed:visibleControls.filter(node=>!centerHits(node)).map(node=>node.getAttribute('aria-label')||node.className),
   separated:feedbackBounds.top>=bounds.bottom&&Math.abs(bounds.left-stage.getBoundingClientRect().left-23)<1,
   title:!!view.querySelector('.buddy-viewing').title,
  };
  if(row.hit)pointTarget(back).click();else back.click();
  await waitFor(()=>!stage.querySelector('.gx-group-stage-controls .buddy-viewing'),'return to speaker');
  rows.push(row);
 }
 assert(rows.every(row=>row.hit&&!row.collides.length&&row.separated&&row.title),JSON.stringify(rows));
 return JSON.stringify(rows);
}
export async function r2Compact(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp');
 await r2Size(stage,[550,480,900]);
 const history=boxOf(await element('.corner.tr > .glass:nth-child(2)',stage)),status=boxOf(await element('.corner.br',stage));
 const gap=history.left-status.right,delta=(history.top+history.bottom-status.top-status.bottom)/2;
 assert(Math.abs(delta)<=1&&Math.abs(gap-9)<=1,JSON.stringify({gap,delta,history,status}));
 return JSON.stringify({gap,delta});
}
export async function r2CompactLive(root){
 mockRecordingCapture();
 await mountFullStage(root);
 const stage=await element('#whg-tab-root');
 await r2Size(stage,[550,480,900]);
 (await element('[data-galgame-input-toggle]',stage)).click();
 (await element('[data-voice-live]:not(:disabled)',stage)).click();
 await element('[data-galgame-live] [data-voice-live-phase]',stage);
 await settleStage();
 const frame=boxOf(stage),primary=boxOf(await element('.corner.tr > .glass:first-child',stage));
 const history=boxOf(await element('.corner.tr > .glass:nth-child(2)',stage)),status=boxOf(await element('.corner.br',stage));
 const values={right:frame.right-primary.right,top:primary.top-frame.top,gap:history.left-status.right,delta:(history.top+history.bottom-status.top-status.bottom)/2};
 assert(Math.abs(values.right-10)<=1&&Math.abs(values.top-12)<=1&&Math.abs(values.gap-9)<=1&&Math.abs(values.delta)<=1,JSON.stringify(values));
 return JSON.stringify(values);
}
export async function r2Mood(root){
 await mountFullStage(root);
 const stage=await element('#whg-tab-root.grp');
 await r2Size(stage,approvedSizes.at(-1));
 // The hidden window exercises normal stage behavior while retaining the app's visibility guard.
 Object.defineProperty(document,'hidden',{value:false,configurable:true});
 await window.whale.game('fixture-group-feedback');
 const feedback=await element('.gx-group-feedback',stage);
 const mood=await element('[data-chat-mood] button',stage);
 mood.focus();
 pointTarget(mood).click();
 const popup=await element('[data-chat-mood] .r95-pop',stage);
 const z=Number(getComputedStyle(mood.closest('.br')).zIndex),feedbackZ=Number(getComputedStyle(feedback.closest('.gx-group-stage-notices')??feedback).zIndex);
 const target=popup.querySelector('[data-open-social=mood]');
 assert(z>feedbackZ&&popup.getBoundingClientRect().top>=mood.getBoundingClientRect().bottom&&centerHits(target),'Mood stacking level '+z+' above feedback '+feedbackZ);
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await waitFor(()=>!popup.isConnected&&document.activeElement===mood,'Escape closes mood and restores focus');
 return JSON.stringify({z,feedbackZ});
}


export async function r2Narration(root,proactive){
 const clock={time:0};
 const connect=()=>({connect(){},disconnect(){}});
 const voice=ensureVoiceSession(window.whale.voice,{createContext:({sampleRate})=>({
  sampleRate,state:'running',get currentTime(){return clock.time;},destination:{},resume:async()=>{},close:async()=>{},
  createGain:()=>({...connect(),gain:{value:1}}),
  createBuffer:(_,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),
  createBufferSource:()=>({...connect(),start(){},stop(){}}),
 })});
 const release=voice.retain();
 try{
  await mountFullStage(root);
  const stage=await element('#whg-tab-root');
  await r2Size(stage,approvedSizes[0]);
  const tx=await element('.say>.tx',stage),group=stage.classList.contains('grp'),requestId=proactive?'social-voice:fixture-proactive':'fixture-narration';
  const emit=event=>window.whale.game('fixture-narration',event);
  const options=()=>[...stage.querySelectorAll('[data-speech-option]')];
  if(proactive)await element('[data-r95-speech-text=fixture-proactive]',tx);
  else{
   await window.whale.game('fixture-stream',{requestId,text:r2Text});
   await waitFor(()=>tx.textContent.trim()===r2Text.trim(),'reply before narration');
  }
  const rows=[];
  const envelopeFor=index=>({requestId,segmentId:requestId+':'+index,index,characterId:'deepseek',personaId:'fixture-persona',conversationId:group?'fixture-group':'fixture-conversation',channel:group?'app-group':'app-private'});
  for(let index=0;index<2;index++){
   const envelope=envelopeFor(index);
   const text=r2Text.slice(0,520)+'Narration tail '+index;
   await emit({type:'segment',state:'queued',envelope,text,speech_text:text});
   await emit({type:'audio',phase:'pcm',envelope,sampleRate:24000,pcm:new Uint8Array(48000)});
   await emit({type:'audio',phase:'end',envelope});
   clock.time=1+index;
   await waitFor(()=>tx.querySelector('[data-voice-subtitle=true]')&&tx.textContent.endsWith('Narration tail '+index),'current narration segment '+index);
   await settleStage();
   rows.push({index,top:tx.scrollTop,visible:tailVisible(tx),foot:proactive?options().length===2&&options().every(node=>!tx.contains(node)&&centerHits(node)):!!stage.querySelector('.st [data-stream-paragraph], .vx-saying')});
  }
  assert(rows.every(row=>row.visible&&row.foot),JSON.stringify(rows));
  await emit({type:'segment',state:'failed',envelope:envelopeFor(2),message:'Fixture narration failed'});
  await element('.st .gx-dub-failure',stage);
  await window.whale.game('fixture-stream',{requestId:'fixture-text-only',text:'Text-only reply'});
  await waitFor(()=>tx.textContent==='Text-only reply'&&!stage.querySelector('.st .gx-dub-failure'),'next text-only reply clears the old narration warning');
  return JSON.stringify({rows,nextTextOnlyClearedFailure:true});
 }finally{await release();}
}
