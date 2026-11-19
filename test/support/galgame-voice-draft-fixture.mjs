import React from 'react';
import {applyAppearance} from '../../src/appearance.mjs';
import {CompanionGroupDialogue} from '../../src/companion-ui.mjs';
import {GalgameCSS} from '../../src/adapted/galgame-client.ts';
import {setLocale,t} from '../../src/i18n.mjs';

const h=React.createElement;
const group={id:'fixture-voice',name:'Voice fixture',memberIds:['deepseek']};
const state={activeGroupId:group.id,groups:[group],groupMessages:[],groupRuntime:{status:'idle'},characters:[{id:'deepseek',name:'DeepSeek'}]};
async function waitFor(predicate){
 for(let i=0;i<200;i++){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Voice draft did not render');
}
function visible(node){return node&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden';}

export async function run(root){
 const style=document.createElement('style');style.textContent=GalgameCSS;document.head.append(style);
 for(const locale of ['zh-CN','en'])for(const theme of ['deepseek','claude','kimi']){
  setLocale(locale);
  applyAppearance({theme});
  root.render(h('div',{key:locale+theme,'data-fixture-case':locale+theme,className:'gx-redesign grp','data-stage-scheme':document.documentElement.dataset.scheme,style:{position:'relative',width:1100,height:700}},
   h(CompanionGroupDialogue,{state,request:async()=>({}),stageUi:{inputOpen:true},classic:false}),
  ));
  const editor=await waitFor(()=>document.querySelector('[data-fixture-case='+locale+theme+'] .dialogue-shell textarea'));
  window.dispatchEvent(new CustomEvent('ai-buddy:voice-draft',{detail:{text:'可编辑夹具录音',scope:{conversationId:group.id}}}));
  await waitFor(()=>editor.value==='可编辑夹具录音');
  const status=[...document.querySelectorAll('.dialogue-shell small')].find(node=>node.textContent===t('来自录音')+' · '+t('可以先改再发'));
  if(!visible(status))throw Error('Recorded draft source is hidden in '+locale+' '+theme);
  if(status.getBoundingClientRect().left<editor.getBoundingClientRect().right)throw Error('Recorded draft source should sit beside the editor at the right');
  const keyboard=[...document.querySelectorAll('.dialogue-shell span,.dialogue-shell small')]
   .filter(node=>node.textContent===t('Enter 发送 · Shift+Enter 换行')&&visible(node));
  if(keyboard.length!==1)throw Error('Expected one visible keyboard hint, got '+keyboard.length);
  const hint=keyboard[0],bar=editor.closest('.ibar'),hintRect=hint.getBoundingClientRect();
  if(editor.getAttribute('aria-describedby')!==hint.id||hintRect.top<bar.getBoundingClientRect().bottom||hintRect.bottom>bar.closest('.gx-redesign').getBoundingClientRect().bottom+1)
   throw Error('Keyboard hint must describe the editor and sit below the composer in '+locale+' '+theme);
 }
}

