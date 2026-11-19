import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GalgameSettings} from '../src/galgame-redesign.mjs';
import {galgamePresentationSettings} from '../src/galgame-expressions.mjs';
import {setLocale} from '../src/i18n.mjs';

function settingsMarkup(props){
 return renderToStaticMarkup(React.createElement(GalgameSettings,{
  settings:galgamePresentationSettings({},'fixture'),onPatch(){},onClose(){},...props,
 }));
}

test('group settings describe their scope in both languages and omit relationship restart',()=>{
 try{
  for(const [language,label] of [['zh-CN','只对这个群聊生效'],['en','Applies to this group chat only']]){
   setLocale(language);
   const output=settingsMarkup({name:'Afternoon tea',group:true});
   assert.match(output,new RegExp('Afternoon tea · '+label));
   assert.doesNotMatch(output,/重新开始|Restart/);
  }
  setLocale('zh-CN');
  const privateOutput=settingsMarkup({name:'Claude',onReset(){}});
  assert.match(privateOutput,/Claude · 只对当前角色生效/);
  assert.match(privateOutput,/<button[^>]*>重新开始…<\/button>/);
 }finally{setLocale('zh-CN');}
});
