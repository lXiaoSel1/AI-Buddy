import React,{useState} from 'react';
import {GroupMentionInput} from '../../src/group-mention-input.mjs';
import {GroupHeader} from '../../src/group-header.mjs';
import {CompanionGroupStage} from '../../src/group-stage-ui.mjs';
import {GALGAME_REDESIGN_STYLE} from '../../src/galgame-redesign-style.mjs';
import {applyAppearance} from '../../src/appearance.mjs';

const h=React.createElement;
const group={id:'roster-fixture',name:'Roster fixture',memberIds:['deepseek','claude','kimi','chatgpt','custom-paper'],mutedIds:['kimi']};
const avatar='buddy-media://'+'a'.repeat(64)+'.webp',builtinAvatar='buddy-media://'+'b'.repeat(64)+'.webp';
const state={activeGroupId:group.id,groups:[group],groupMessages:[],groupRuntime:{status:'generating',queue:['deepseek']},
 characters:group.memberIds.map((id,index)=>({id,name:['DeepSeek','Claude','Kimi','Custom card','Mira'][index],builtin:index<3,avatar:id==='chatgpt'?avatar:id==='kimi'?builtinAvatar:''}))};
const request=async()=>({});
function assert(value,message){if(!value)throw Error(message);}
async function waitFor(predicate,description){
 for(let i=0;i<200;i++){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Members UI did not reach: '+description);
}
function Stage({width,classic=true,cloudVoiceCharacters}){
 const [panelRequest,setPanelRequest]=useState(null),[draft,setDraft]=useState(''),[menu,setMenu]=useState(false);
 return h('div',{className:'gx-redesign grp','data-stage-scheme':'dark',style:{position:'relative',width,height:650}},
  h(CompanionGroupStage,{state,classic,cloudVoiceCharacters,onMembers:event=>setPanelRequest({groupId:group.id,panel:'members',trigger:event.currentTarget})}),
  h(GroupHeader,{state,request,panelRequest,onBrowse(){},stageUi:{menu,toggleMenu:()=>setMenu(value=>!value),closeMenu:()=>setMenu(false)}}),
  h(GroupMentionInput,{value:draft,bindings:[],onChange:setDraft,members:state.characters,onSubmit(){}}),
 );
}
export async function run(root){
 applyAppearance({theme:'deepseek'});
 const style=document.createElement('style');style.textContent=GALGAME_REDESIGN_STYLE;document.head.append(style);
 const avatarFailures=[];
 const cloudVoiceCharacters=[{characterId:'deepseek',voiceId:'fixture',state:'ready'}];
 root.render(h(Stage,{width:860,classic:true,cloudVoiceCharacters,key:'classic-cloud'}));
 await waitFor(()=>document.querySelector('.gx-redesign')?.clientWidth===860,'narrow classic cloud stage');
 await new Promise(resolve=>setTimeout(resolve,70));
 assert(!document.querySelector('[data-galgame-roster]'),'Narrow classic cloud must keep the original roster threshold');
 root.render(h(Stage,{width:860,classic:false,cloudVoiceCharacters,key:'modern-cloud'}));
 await waitFor(()=>document.querySelector('.bc-small-rail .bc-rail-indicator'),'narrow modern cloud roster and unbound markers');

 for(const width of [1000,860,620]){
  root.render(h(Stage,{width,key:width}));
  const stage=await waitFor(()=>document.querySelector('.gx-redesign')?.clientWidth===width&&document.querySelector('.gx-redesign'),'stage width '+width);
  const launcher=await waitFor(()=>stage.querySelector(width>860?'[data-galgame-roster]':'[data-group-members]'),'launcher at '+width);
  launcher.click();
  const popup=await waitFor(()=>stage.querySelector(':is([role=dialog],dialog)[aria-label="在场角色"]'),'popover at '+width);
  const search=popup.querySelector('input[type=search]');
  assert(search?.placeholder==='搜索成员','Present members control needs a search input');
  assert(popup.tagName!=='DIALOG','Present members is a nonmodal popover');
  assert(popup.querySelectorAll('[data-group-member-view]').length===5,'All five group members initially visible');
  if(width===1000){
   const faces=stage.querySelectorAll('.grail-faces img');
   assert(faces.length===4,'Missing custom image uses a placeholder in the roster');
   verifyAvatars(faces,'Roster');
   verifyAvatars(popup.querySelectorAll('.gx-members-list .row .hd img'),'Member panel');
  }
  const {left,right,top,bottom}=popup.getBoundingClientRect(),bounds=stage.getBoundingClientRect(),anchor=launcher.getBoundingClientRect();
  assert(left>=bounds.left&&right<=bounds.right&&top>=bounds.top&&bottom<=bounds.bottom,'Popover must stay inside the '+width+'px stage');
  if(width>860)assert(right<=anchor.left,'Desktop member popover opens to the left of the roster');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(search,'cL');
  search.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor(()=>popup.querySelectorAll('[data-group-member-view]').length===1,'one matched member');
  assert(popup.querySelector('[data-group-member-view="claude"]'),'Case-insensitive display-name search should show only Claude');
  setter.call(search,'unknown');
  search.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor(()=>popup.textContent.includes('没有找到这个成员'),'empty search result');
  search.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await waitFor(()=>!stage.querySelector('input[type=search]'),'popover closed by Escape at '+width);
  assert(document.activeElement===launcher,'Escape restores the opening control focus');
  launcher.click();
  await waitFor(()=>stage.querySelector('input[type=search]'),'popover reopened');
  stage.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
  await waitFor(()=>!stage.querySelector('input[type=search]'),'popover closed by outside pointer at '+width);
  if(width===1000){
   const input=stage.querySelector('[role=combobox]');
   input.focus();
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'@');
   input.setSelectionRange(1,1);
   input.dispatchEvent(new Event('input',{bubbles:true}));
   const list=await waitFor(()=>document.querySelector('[role=listbox]'),'mention list');
   verifyAvatars(list.querySelectorAll('[role=option] img'),'Mention list');
   assert(list.querySelector('.buddy-mention-initial')?.textContent==='M','Custom member without an avatar shows her initial');
   stage.querySelector('[data-galgame-menu]').click();
   (await waitFor(()=>stage.querySelector('[data-group-connections]'),'Connections menu item')).click();
   const connections=await waitFor(()=>document.querySelector('dialog[open][data-group-dialog=connections]'),'Connections panel');
   verifyAvatars(connections.querySelectorAll('[data-group-api-member] img'),'Connections panel');
   connections.querySelector('header button').click();
   await waitFor(()=>!document.querySelector('dialog[open][data-group-dialog=connections]'),'Connections closed');
  }
 }
 assert(!avatarFailures.length,avatarFailures.join('\n'));

 function verifyAvatars(images,surface){
  const paths=[...images].map(node=>node.getAttribute('src').replace(/^\.\//,''));
  if(paths.includes(builtinAvatar))avatarFailures.push(surface+' must use the theme head for a built-in card');
  for(const expected of ['assets/theme/deepseek/head.webp','assets/theme/claude/head.webp','assets/theme/kimi/head.webp',avatar]){
   if(!paths.includes(expected))avatarFailures.push(surface+' missing '+expected+'; rendered '+paths.join(', '));
  }
 }
}

