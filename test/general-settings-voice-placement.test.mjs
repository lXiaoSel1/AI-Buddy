import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GeneralSettings} from '../src/general-settings.mjs';
import {setLocale} from '../src/i18n.mjs';

test('voice settings follow the desktop pet before the two-column settings group',t=>{
 const previous=globalThis.window;globalThis.window={whale:{models:{},cg:{},updates:{},plugins:{}}};t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;});
 setLocale('zh-CN');
 const view={version:'2.0.8',build:'fixture',dataRoot:'fixture',logRoots:[],themeCharacter:'deepseek',preferences:{language:'zh-CN',theme:'deepseek',themeMode:'fixed',replyStyle:'natural',petCharacterMode:'follow'},resources:{characters:[]},modelConnections:{profiles:[]}};
 const html=renderToStaticMarkup(React.createElement(GeneralSettings,{view,onSaved(){},onPage(){}}));
 const pet=html.indexOf('settings-pet'),voice=html.indexOf('data-voice-general-settings'),columns=html.indexOf('class="ws-set2"');
 assert.ok(pet>=0&&voice>pet&&columns>voice,'expected desktop pet → voice → two-column settings');
 assert.equal((html.match(/data-voice-general-settings/g)??[]).length,1);
 assert.ok(html.indexOf('appearance-settings')<pet);
 assert.ok(columns<html.indexOf('settings-install'));
 assert.match(html,/去扩展中心安装语音插件/);
});
