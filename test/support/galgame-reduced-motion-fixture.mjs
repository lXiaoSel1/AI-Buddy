import React from 'react';
import {GALGAME_REDESIGN_STYLE} from '../../src/galgame-redesign-style.mjs';
import {applyAppearance} from '../../src/appearance.mjs';

const h=React.createElement;
export async function run(root){
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches)throw Error('Browser did not enter reduced-motion mode');
 applyAppearance({theme:'deepseek'});
 const style=document.createElement('style');style.textContent=GALGAME_REDESIGN_STYLE;document.head.append(style);
 root.render(h('div',{className:'gx-redesign','data-stage-scheme':'dark',style:{width:1000,height:700}},
  h('button',null,h('i',{className:'dot busy'}),'Busy'),
  h('div',{className:'thinking'},h('i'),h('i'),h('i'),'Thinking'),
  h('div',{className:'ibar'},h('i',{className:'recdot'}),'Recording'),
 ));
 for(let i=0;i<200&&!document.querySelector('.gx-redesign');i++)await new Promise(resolve=>setTimeout(resolve,10));
 const stage=document.querySelector('.gx-redesign');
 if(!stage)throw Error('Stage did not render');
 const animated=[...stage.querySelectorAll('.dot.busy,.thinking i,.recdot')].map(node=>getComputedStyle(node).animationName).filter(name=>name!=='none');
 if(animated.length)throw Error('CSS animations still configured: '+animated.join(', '));
 const names=stage.getAnimations({subtree:true}).map(animation=>animation.animationName);
 if(names.length)throw Error('Animations still active: '+names.join(', '));
 for(const node of stage.querySelectorAll('.dot.busy,.thinking i,.recdot'))
  if(getComputedStyle(node).backgroundColor==='rgba(0, 0, 0, 0)')throw Error('A static state indicator is invisible');
}

