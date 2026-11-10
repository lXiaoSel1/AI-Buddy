import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {installedPluginRows,pluginActivation} from '../src/plugin-center-helpers.mjs';
import {UpdateCard,CommunityInstallationStatus,installedSituation} from '../src/community-center.mjs';
import {VoicePackageRow,voicePackagePresentation} from '../src/voice/shell-design.mjs';
const compatibility={compatible:false,reasons:['app-version'],requiredAppRange:'>=9.0.0',currentAppVersion:'2.0.13'};
const manifest={id:'ai-buddy.voice-breeze',version:'1.0.0',kind:'plugin',name:'Fixture voice',appRange:'>=9.0.0'};
const activation={supported:true,usable:false,state:'incompatible',...compatibility};
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
test('A5: legacy installed projection preserves host incompatibility instead of replacing it with compatible=true',()=>{
 const row=installedPluginRows({installed:{[manifest.id]:{current:'1.0.0',enabled:true,compatible:false,compatibility,activation,versions:{'1.0.0':{manifest}}}}})[0];
 assert.equal(row.compatible,false);assert.deepEqual(row.compatibility,compatibility);assert.equal(pluginActivation({...row,activation:{supported:true,usable:true,state:'ready'}}).state,'incompatible');
});
for(const language of ['zh-CN','en']){
 const expected=language==='en'?'This version requires AI Buddy >=9.0.0; the current version is 2.0.13.':'这个版本需要 AI 酱 >=9.0.0，现在是 2.0.13。';
 test(language+': A5 maintenance with no compatible release stays visible and cannot update to null',()=>{setLocale(language);const update={packageKey:'buddy-v1:official:'+manifest.id,from:'1.0.0',to:null,state:'incompatible',installedIncompatible:true,compatibility};const element=UpdateCard({update,onReview(){},busy:false}),html=renderToStaticMarkup(element);assert.ok(html.includes(language==='en'?'Incompatible':'不兼容'));assert.ok(html.replaceAll('&gt;','>').includes(expected));assert.ok(html.includes(language==='en'?'Wait for a plugin update before continuing':'等插件更新后才能继续用'));const button=React.Children.toArray(element.props.children).find(row=>row.type==='button');assert.equal(button,undefined,'no compatible release has no duplicate disabled action');assert.equal(html.split(language==='en'?'Wait for a plugin update before continuing':'等插件更新后才能继续用').length-1,1);assert.ok(!html.includes('→ null'));});
 test(language+': A5 compatible replacement names its exact update action',()=>{setLocale(language);const update={packageKey:'buddy-v1:official:'+manifest.id,from:'1.0.0',to:'2.0.16',state:'available',installedIncompatible:true,requiresCompatibilityUpdate:true,compatibility};const element=UpdateCard({update,onReview(){},busy:false}),html=renderToStaticMarkup(element);assert.ok(html.includes(language==='en'?'Update to 2.0.16':'更新到 2.0.16'));assert.ok(html.replaceAll('&gt;','>').includes(expected));});
 test(language+': A5 voice and DSH installed rows show warn incompatibility and preserve disabled start',()=>{
  setLocale(language);const row={manifest,installed:true,current:true,enabled:true,compatible:false,compatibility,activation};const snapshot={state:{settings:{enabled:true},selectedPackageId:manifest.id,preparation:{state:'ready'},packages:[{id:manifest.id,enabled:true,usable:false,compatible:false,activation,compatibility}]}};
  assert.equal(voicePackagePresentation(snapshot,manifest.id).status,'incompatible');const html=render(VoicePackageRow,{row,record:snapshot.state.packages[0],snapshot,session:{configure(){}},call(){},onOpen(){}});assert.ok(html.includes(language==='en'?'Incompatible':'不兼容'));assert.ok(html.replaceAll('&gt;','>').includes(expected));assert.match(html,/<button[^>]*disabled[^>]*data-voice-start/);
  const record={enabled:true,runtimeVerified:true,compatible:false,compatibility};assert.ok(render(CommunityInstallationStatus,{record}).includes(language==='en'?'Incompatible':'不兼容'));assert.equal(installedSituation(record),expected);
 });
}
