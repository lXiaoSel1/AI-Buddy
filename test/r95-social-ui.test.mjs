import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MoodCard,SocialSettings,AutoControls} from '../src/social-core-ui.mjs';
test('R95 core social controls render functional Chinese and English entry points',()=>{
 for(const language of ['zh-CN','en']){const base={language},mood=renderToStaticMarkup(React.createElement(MoodCard,{view:{...base,mood:{overall:{label:'平静'}}}})),settings=renderToStaticMarkup(React.createElement(SocialSettings,{view:{...base,settings:{proactive:false,selfTalk:false,auto:false},availability:{}}})),auto=renderToStaticMarkup(React.createElement(AutoControls,{view:{...base,groupId:'g',enabled:true,members:['a','b']}}));assert.match(mood,/data-r95-mood/);assert.match(settings,/data-r95-social-settings/);assert.equal((settings.match(/type="checkbox"/g)??[]).length,4);assert.match(auto,/data-r95-auto="g"/);assert.match(auto,language==='en'?/Authorize members and start/:/确认成员并启动/);}
});
