import React from 'react';
import {GalgameApp} from '../../src/adapted/galgame-client.ts';
import {CompanionGroupDialogue} from '../../src/companion-ui.mjs';
import {GalgameSettings} from '../../src/galgame-redesign.mjs';
import {galgamePresentationSettings} from '../../src/galgame-expressions.mjs';
import {setLocale} from '../../src/i18n.mjs';

const h=React.createElement;
function assert(value,message){if(!value)throw Error(message);}
async function waitFor(selector){
 for(let i=0;i<200;i++){const node=document.querySelector(selector);if(node)return node;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Missing fixture element: '+selector);
}

export async function run(root){
 const cause='本次没有新的对话可以合影';
 const group={id:'fixture-group',name:'Fixture group',memberIds:['deepseek'],photos:[]};
 const state={activeGroupId:group.id,groups:[group],groupRuntime:{status:'idle'},groupMessages:[],characters:[{id:'deepseek',name:'DeepSeek'}]};
 root.render(h(CompanionGroupDialogue,{
  state,request:window.whale.game,stageUi:{inputOpen:false},classic:false,photoRequest:{groupId:group.id,nonce:1},
 }));
 const photoError=await waitFor('.buddy-group-photo [role=alert]');
 assert(photoError.textContent===cause,'Group photo exposed internal IPC wrapper: '+photoError.textContent);
 setLocale('en');
 root.render(h(GalgameSettings,{name:'DeepSeek',settings:galgamePresentationSettings({},'deepseek'),
  onPatch:()=>window.whale.game('companion-settings'),onClose(){},
 }));
 const patch=await waitFor('button[data-galgame-setting]');
 patch.click();
 const settingsError=await waitFor('.gx-settings-dialog [role=alert]');
 assert(settingsError.textContent==='You can only restart the relationship in the current character’s private chat.',
  'Settings did not translate provider error: '+settingsError.textContent);
 setLocale('zh-CN');
 root.render(h(GalgameApp,{variant:'tab',useSessions:null}));
 const notReady=await waitFor('[data-galgame-screen="not-ready"] .sub');
 assert(notReady.textContent==='只能重新开始当前角色的私聊关系','Not-ready card repeated its heading or IPC wrapper: '+notReady.textContent);
}


export async function runSavedGroupPhoto(root){
 const id='fixture-saved-photo',group={id:'fixture-group',name:'Fixture group',memberIds:['deepseek','claude']};
 const state={activeGroupId:group.id,groups:[group],groupRuntime:{status:'idle'},groupMessages:[],characters:[{id:'deepseek',name:'DeepSeek'},{id:'claude',name:'Claude'}]};
 const saved={cgId:id,range:{start:1,end:3},characterIds:['deepseek','claude']},opened=[],submissions=[];
 const request=async(action,args)=>{
  if(action==='companion-group-photo-preview')return {ok:true,photo:{
   range:saved.range,messageCount:3,characterIds:args.characterIds??saved.characterIds,
   existingPhoto:!args.characterIds||args.characterIds.length===2?saved:null,
   planner:{enabled:true,options:[],binding:{enabled:false}}
  }};
  if(action==='companion-group-photo'){submissions.push(args);return {ok:true,photo:{cgId:'fixture-regenerated'}};}
  return {ok:true};
 };
 const render=nonce=>root.render(h(CompanionGroupDialogue,{state,request,stageUi:{inputOpen:false},classic:false,galgame:true,photoRequest:{groupId:group.id,nonce},onPhoto:value=>opened.push(value)}));
 const button=async text=>{
  for(let index=0;index<200;index++){
   const node=[...document.querySelectorAll('.buddy-group-photo footer button')].find(item=>item.textContent.trim()===text);
   if(node&&!node.disabled)return node;await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Expected action: '+text);
 };
 const observed=async value=>{
  for(let index=0;index<200;index++){if(opened.at(-1)===value)return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('Expected photo gallery selection: '+value);
 };
 render(1);
 await button('重新生成一张');
 const view=await button('查看已有合影');
 view.click();
 await observed(id);
 assert(submissions.length===0,'Viewing the saved photo sent a drawing request');
 render(2);
 await button('查看已有合影');
 const cast=[...document.querySelectorAll('.buddy-photo-parts button')];
 cast.at(-1).click();
 await button('生成合影');
 assert(![...document.querySelectorAll('.buddy-group-photo footer button')].some(node=>node.textContent==='查看已有合影'),'A different cast reused the original photo');
 cast.at(-1).click();
 (await button('重新生成一张')).click();
 await observed('fixture-regenerated');
 assert(submissions.length===1&&submissions[0].regenerate===true&&submissions[0].characterIds.length===2,'Regenerate did not send exactly one request for the matching cast');
}
