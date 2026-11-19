import React from 'react';
import dashboardCSS from '../../src/dashboard.css' with {type:'text'};
import appearanceCSS from '../../src/appearance.css' with {type:'text'};
import workspaceCSS from '../../src/workspace.css' with {type:'text'};
import voiceDesignCSS from '../../src/voice/voice-design.css' with {type:'text'};
import designChatCSS from '../../src/voice/design-chat.css' with {type:'text'};
import voiceCloudCSS from '../../src/voice/voice-ui-cloud.css' with {type:'text'};
import shellCSS from '../../src/voice/shell-design.css' with {type:'text'};
import {GalgameApp,GalgameCSS} from '../../src/adapted/galgame-client.ts';
import {CompanionManager,CompanionGroupDialogue} from '../../src/companion-ui.mjs';
import {GroupHeader} from '../../src/group-header.mjs';
import {setLocale} from '../../src/i18n.mjs';
import {applyAppearance} from '../../src/appearance.mjs';

const h=React.createElement,character={id:'deepseek',name:'DeepSeek',builtin:true,effective:{greeting:'Hi'}};
const group={id:'paper-group',name:'Fixture group',memberIds:[character.id],photos:[],personaId:'fixture-persona'};
const state={activeCharacterId:character.id,activeGroupId:group.id,activePersonaId:group.personaId,characters:[character],
 groups:[group],personas:[{id:group.personaId,name:'Fixture persona'}],messages:[],conversations:[],groupMessages:[],groupRuntime:{status:'idle'},settings:{}};
const request=async()=>({items:[],photo:{characterIds:[character.id]}});
function check(ok,message){if(!ok)throw Error(message);}
async function waitFor(predicate,what){
 for(let i=0;i<200;i++){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Paper fixture timed out: '+what+'; open '+[...document.querySelectorAll('dialog[open]')].map(node=>[node.className,[...node.querySelectorAll('button')].map(btn=>btn.textContent.trim())]).map(row=>JSON.stringify(row)).join(','));
}
const active=()=>[...document.querySelectorAll('dialog[open]')].at(-1);
async function frame(subtitle,size){
 const node=await waitFor(active,'open '+subtitle);
 check(node.classList.contains('gx-paper-dialog'),'Missing Galgame paper frame for '+subtitle);
 check(node.querySelector('header .sub')?.textContent===subtitle,'Wrong paper subtitle for '+subtitle);
 check(node.querySelector('header button')?.textContent.includes('返回 Esc'),'Missing paper close control for '+subtitle);
 const paper=node.querySelector(':scope>.sheet')??node;
 check(getComputedStyle(node.querySelector('header .sub')).fontStyle==='italic','Expected italic paper subtitle for '+subtitle);
 const rect=paper.getBoundingClientRect();
 check(Math.round(rect.width)===size,'Expected '+size+'px wide '+subtitle+', rendered '+rect.width+', CSS '+getComputedStyle(paper).width);
 if(size===998)check(Math.round(rect.height)===605,'Expected 605px tall '+subtitle+', rendered '+rect.height);
 else{
  if(subtitle==='Group photo')await waitFor(()=>paper.querySelector('.buddy-photo-parts'),'load photo options');
  const name=subtitle==='Title'?'.stats-modal-body':'.buddy-group-modal-body';
  const body=paper.querySelector(name),details=getComputedStyle(paper),typed=paper.computedStyleMap().get('height');
  const dimensions=()=>JSON.stringify({height:paper.offsetHeight,maxHeight:details.maxHeight,
   heightDeclaration:String(typed),position:details.position,top:details.top,bottom:details.bottom,body:body?.offsetHeight,content:body?.scrollHeight});
  check(paper.offsetHeight<500,'Expected '+subtitle+' to fit its content; '+dimensions());
  if(body){
   const last=body.lastElementChild;
   if(last)check(body.getBoundingClientRect().bottom-last.getBoundingClientRect().bottom<48,'Unexpected vacant body in '+subtitle+'; '+dimensions());
  }
  const footer=paper.querySelector('footer');
  if(footer){
   const gap=paper.getBoundingClientRect().bottom-footer.getBoundingClientRect().bottom;
   check(gap>=0&&gap<16,'Expected footer at the bottom of '+subtitle+'; '+dimensions());
  }
  if(subtitle==='Group photo'){
   const extra=document.createElement('div');
   extra.style.flex='0 0 900px';
   body.append(extra);
   try{
    check(paper.offsetHeight===Math.min(605,innerHeight-36)&&body.scrollHeight>body.clientHeight,'Tall photo content must use the existing height cap and body scroll; '+dimensions());
    const gap=paper.getBoundingClientRect().bottom-footer.getBoundingClientRect().bottom;
    check(gap>=0&&gap<16,'Tall photo content must keep the footer visible; '+dimensions());
   }finally{extra.remove();}
  }
 }
 node.querySelector('header button').click();
 if(subtitle==='Restart'){await waitFor(()=>node.querySelector('header .sub')?.textContent==='Config','return from restart');node.querySelector('header button').click();}
 await waitFor(()=>active()!==node,'close '+subtitle);
}
function style(){
 applyAppearance({theme:'deepseek'});
 for(const source of [dashboardCSS,appearanceCSS,workspaceCSS,voiceDesignCSS,designChatCSS,voiceCloudCSS,shellCSS,GalgameCSS]){
  const css=document.createElement('style');
  css.textContent=source;
  document.head.append(css);
 }
}
async function menu(label){
 if(!document.querySelector('.gx-redesign .menu'))(await waitFor(()=>document.querySelector('[data-galgame-menu]'),'menu trigger')).click();
 (await waitFor(()=>[...document.querySelectorAll('.gx-redesign .menu button')].find(node=>node.textContent.trim()===label),label)).click();
}

export async function privateFrames(root){
 style();
 root.render(h('div',{className:'galgame-page'},h(GalgameApp,{variant:'tab',useSessions:null,chat:{enabled:true}})));
 await waitFor(()=>document.querySelector('#whg-panel'));
 for(const [label,subtitle] of [['背景图','Background'],['角色立绘','Portrait'],['我的身份','Identity'],['管理角色','Characters'],['群聊','Group']]){
  await menu(label);
  await frame(subtitle,998);
 }
 (await waitFor(()=>document.querySelector('[data-galgame-menu]'))).click();
 (await waitFor(()=>document.querySelector('.menu .buddy-title-edit'))).click();
 await frame('Title',520);
 await menu('设置');
 (await waitFor(()=>[...(active()?.querySelectorAll('button')??[])].find(node=>node.textContent?.trim().startsWith('重新开始')),'restart button')).click();
 await frame('Restart',520);
}

function Group({panel,photo}){
 return h('div',{className:'gx-redesign grp','data-stage-scheme':'dark',style:{position:'relative',width:1100,height:700}},
  h(GroupHeader,{state,request,loadCg:request,galgame:true,panelRequest:{groupId:group.id,panel}}),
  h(CompanionGroupDialogue,{state,request,galgame:true,photoRequest:photo?{groupId:group.id,nonce:1}:null}),
 );
}
export async function groupFrames(root){
 style();
 root.render(h(Group,{key:'rename',panel:'rename'}));
 await frame('Group name',520);
 for(const [panel,subtitle] of [['settings','Group'],['connections','Connections'],['background','Group background'],['gallery','Group gallery'],['history','Backlog']]){
  root.render(h(Group,{key:panel,panel}));
  await frame(subtitle,998);
 }
 root.render(h(CompanionManager,{state,request,panel:'characters',onClose(){}}));
 const host=await waitFor(active,'host manager');
 check(!host.classList.contains('gx-paper-dialog'),'Workspace management keeps its host frame');
}


export async function mediumFrame(root){
 style();
 root.render(h(Group,{photo:true}));
 await frame('Group photo',640);
}

export async function managerSidebars(root){
 style();
 const characters=Array.from({length:13},(_,i)=>i===0?character:{id:'paper-member-'+i,name:'Member '+i,effective:{}});
 const personas=characters.map((_,i)=>({id:'paper-identity-'+i,name:'Identity '+i}));
 const groups=characters.map((row,i)=>({id:'paper-group-'+i,name:'Group '+i,personaId:personas[0].id,memberIds:[row.id]}));
 const conversations=characters.map((row,i)=>({id:'paper-conversation-'+i,title:'Conversation '+i,personaId:personas[0].id,characterId:row.id}));
 const managerState={...state,characters,personas,groups,conversations,activeGroupId:groups[0].id,
  activeConversationId:conversations[0].id,activePersonaId:personas[0].id};
 const managerRequest=async action=>action==='companion-conversation-list'?{conversations}:{messages:[],items:[],archives:[]};
 root.render(h(CompanionManager,{state:managerState,request:managerRequest,galgame:true,onClose(){}}));
 const dialog=await waitFor(active,'manager');
 const failures=[];
 for(const tab of dialog.querySelectorAll('[role=tab]')){
  tab.click();
  const page=await waitFor(()=>dialog.querySelector('#'+tab.getAttribute('aria-controls')),'manager '+tab.textContent);
  const list=await waitFor(()=>page.querySelectorAll('.buddy-sidebar-list > button').length===13&&page.querySelector('.buddy-sidebar-list'),'13 rows '+tab.textContent);
  await new Promise(requestAnimationFrame);
  const sidebar=list.parentElement,right=sidebar.nextElementSibling;
  const before=[page.scrollTop,right.getBoundingClientRect().top,right.scrollTop,...[...sidebar.children].filter(node=>node!==list).map(node=>node.getBoundingClientRect().top)];
  list.scrollTop=list.scrollHeight;
  const last=list.lastElementChild.getBoundingClientRect(),bounds=list.getBoundingClientRect(),body=page.getBoundingClientRect();
  const after=[page.scrollTop,right.getBoundingClientRect().top,right.scrollTop,...[...sidebar.children].filter(node=>node!==list).map(node=>node.getBoundingClientRect().top)];
  if(!(list.scrollTop>0&&last.bottom<=bounds.bottom+1&&last.top>=bounds.top-1&&last.bottom<=body.bottom+1&&JSON.stringify(before)===JSON.stringify(after))){
   failures.push(tab.textContent+' list scrollTop/client/scrollHeight '+[list.scrollTop,list.clientHeight,list.scrollHeight].join('/')+'; last/list/body bottom '+[last.bottom,bounds.bottom,body.bottom].join('/')+'; page, right and fixed controls '+JSON.stringify([before,after]));
  }
 }
 check(!failures.length,failures.join('\n'));
}

export async function galleryDetails(root){
 style();
 setLocale('en');
 const dimensions=document.createElement('style');
 dimensions.textContent='body{margin:0}#whg-tab-root.gx-redesign{width:min(100vw,1131px);height:720px}';
 document.head.append(dimensions);
 root.render(h('div',{className:'galgame-page'},h(GalgameApp,{variant:'tab',useSessions:null,chat:{enabled:true}})));
 (await waitFor(()=>document.querySelector('.gx-redesign button[aria-label="CG gallery"]'),'gallery launcher')).click();
 const drawer=await waitFor(()=>document.querySelector('.gx-drawer[role=dialog]'),'gallery drawer');
 await waitFor(()=>drawer.querySelectorAll('[data-cg-id]').length===8,'eight CG cards');
 const failures=[],headerMeasurements=[];
 const auditHeader=state=>{
  const heading=drawer.querySelector('.gx-dh');
  const title=heading.querySelector('h3').getBoundingClientRect(),counter=heading.querySelector('.kick');
  const count=counter.getBoundingClientRect(),control=heading.querySelector('button'),button=control.getBoundingClientRect();
  const frame=drawer.getBoundingClientRect(),gap=button.left-count.right;
  const hit=document.elementFromPoint(button.left+button.width/2,button.top+button.height/2);
  const measurement={state,count:counter.textContent,stageWidth:document.querySelector('#whg-tab-root').clientWidth,drawerWidth:frame.width,
   countRight:count.right,buttonLeft:button.left,buttonWidth:button.width,gap,hittable:!!hit&&control.contains(hit)};
  headerMeasurements.push(measurement);
  if(!(title.left<count.left&&gap>=8&&button.left>=frame.left&&button.right<=frame.right&&button.top>=frame.top&&button.bottom<=frame.bottom&&measurement.hittable)){
   failures.push('Gallery header elements collide or the button is clipped: '+JSON.stringify(measurement));
  }
 };
 auditHeader('English list');
 const open=async i=>{
  drawer.querySelector('[data-cg-id="paper-cg-'+i+'"]').click();
  return waitFor(()=>drawer.querySelector('.gx-cg-detail-image .buddy-cg-open'),'loaded detail '+i);
 };
 const back=async()=>{
  drawer.querySelector('.gx-dh button').click();
  await waitFor(()=>drawer.querySelectorAll('[data-cg-id]').length===8,'return to eight cards');
 };
 const image=await open(0),body=drawer.querySelector('.whg-archive-body');
 const outside=document.querySelector('#whg-tab-root').getBoundingClientRect(),inside=drawer.getBoundingClientRect(),top=inside.top-outside.top,bottom=outside.bottom-inside.bottom;
 if(!(top>=0&&bottom>=0&&Math.abs(top-bottom)<=2&&inside.left>=outside.left&&inside.right<=outside.right)){
  failures.push('Drawer not fully centered, upper/lower gap '+[top,bottom].join('/'));
 }
 const description=()=>drawer.querySelector('.gx-cg-detail-description');
 if(description().textContent.includes('"fallbackReason"'))failures.push('Generated group theme still repeats the raw fallback reason in the scene');
 if(!description().textContent.includes('The sign reads 主题服务暂不可用.'))failures.push('User-authored text with the same words was changed');
 const fold=drawer.querySelector('.gx-cg-detail-copy details');
 if(!fold||fold.open)failures.push('Managed composition rules are not in closed native details');
 check(image.querySelector('.buddy-cg-zoom').getBoundingClientRect().top>=image.querySelector('img').getBoundingClientRect().bottom,'Zoom entry belongs below the image');
 const picture=image.querySelector('img');
 await picture.decode();
 check(picture.naturalWidth>0,'The synthetic image decodes at a positive width');
 await new Promise(requestAnimationFrame);
 image.click();
 const lightbox=await waitFor(()=>document.querySelector('.buddy-cg-lightbox[open]'),'large image viewer');
 [...lightbox.querySelectorAll('button')].find(button=>button.textContent==='Close full-size image').click();
 await waitFor(()=>!document.querySelector('.buddy-cg-lightbox[open]'),'large image viewer closed');
 body.scrollTop=body.scrollHeight;
 check(body.scrollTop>0,'Long gallery detail can scroll internally');
 const summary=fold.querySelector('summary');
 check(summary.textContent==='Show fixed composition requirements','English disclosure summary');
 check(description().textContent.includes('"scene":"Synthetic lantern-lit reading room"')&&!description().textContent.includes('【CG 固定构图要求'),'Scene metadata remains visible while fixed rules are collapsed');
 summary.focus();
 check(document.activeElement===summary,'Native disclosure can receive keyboard focus');
 await window.activatePaperControl();
 await waitFor(()=>fold.open,'Enter opens native details');
 check(fold.textContent.includes('【CG 固定构图要求 v2】')&&fold.textContent.includes('【再次确认】'),'Opening reveals both managed parts');
 await window.activatePaperControl();
 await waitFor(()=>!fold.open,'Enter closes native details');
 const reasons=['Theme service was unavailable','Daily theme service was unavailable','The model theme was incomplete, used the wrong perspective, or repeated a recent theme',
  'The daily theme format or source references were invalid','Online chat was disabled','Online chat was disabled'];
 for(let i=0;i<8;i++){
  if(i){await back();await open(i);}
  if(i<6)check(drawer.querySelector('.gx-cg-detail-meta').textContent.includes('Local theme ('+reasons[i]+')'),'English theme reason for row '+i);
  if(i===0)check(description().textContent.includes('No character references were used'),'English text-only notice');
  if(i===1){
   check(description().textContent.includes('All character references were retained. The environment used text cues only.'),'English environment notice');
   const scene=description().querySelector('p:last-child').textContent;
   if(scene!=='Fog over the river.\r\n【再次确认】This line belongs to the scene.\r\nThe fog lifts.'){
    failures.push('CRLF scene text changed: '+JSON.stringify(scene));
   }
   const future=drawer.querySelector('details');
   check(future&&!future.open&&future.textContent.includes('v17】')&&future.textContent.includes('【再次确认】男性'),'Future managed version collapses both managed parts');
  }
  if(i===2){
   auditHeader('English detail');
   if(description().textContent!=='Original legacy scene.')failures.push('Nested legacy policy leaked into the scene');
   const legacy=drawer.querySelector('details');
   const components=['【CG 固定构图要求 v2】','【CG 固定构图要求 v1】','【再次确认】内层历史说明','【再次确认】外层历史说明'];
   const positions=components.map(part=>legacy.textContent.indexOf(part));
   if(legacy.open||positions[0]<0||positions.some((position,index)=>index>0&&position<=positions[index-1])){
    failures.push('Nested legacy policy pieces were not preserved in order inside the closed disclosure');
   }
  }
  if(i===6)check(!drawer.querySelector('details')&&description().textContent==='  Untouched archive.\n【CG 固定构图要求 v2】 in prose.\n\n  Last line.  ','Unmarked prompt remains verbatim');
  if(i===7)check(!drawer.querySelector('details')&&description().textContent.includes('【日常 CG 构图要求 v1】'),'Daily envelope remains whole');
 }
 setLocale('zh-CN');
 await back();
 auditHeader('Chinese list');
 await open(2);
 auditHeader('Chinese detail');
 check(drawer.querySelector('details summary')?.textContent==='展开固定构图要求','Chinese disclosure summary');
 check(!failures.length,failures.join('\n'));
 return JSON.stringify(headerMeasurements);
}
