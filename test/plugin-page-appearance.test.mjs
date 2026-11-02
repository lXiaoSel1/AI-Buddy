import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {pluginPageAppearance,pluginPageAppearanceScript,applyPluginPageAppearance,PAGE_UI_FONT,DSW_THEME_CSS,EMBEDDED_FRAME_CSS,WINDOW_PAGE_CSS} from '../src/plugin-page-appearance.mjs';
import {createDshClientHost} from '../src/dsh-platform/client-host.mjs';
import {themeVariables} from '../src/appearance.mjs';
// Unit/simulated Electron objects. These checks are not real native UI evidence.
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('a plugin page gets the current theme as --buddy-* properties and the Buddy language',()=>{
 const dark=pluginPageAppearance({theme:'deepseek',themeMode:'fixed',language:'en'},'claude');
 assert.deepEqual([dark.theme,dark.scheme,dark.lang],['deepseek','dark','en']);
 assert.ok(dark.css.startsWith(':root{')&&dark.css.endsWith('}'));
 assert.ok(dark.css.includes('--buddy-accent:'+themeVariables('deepseek')['--buddy-accent']));
 // theme values live in the first rule only; DSH's own tokens follow as fixed text
 const first=dark.css.slice(0,dark.css.indexOf('}')+1);
 assert.match(first,/--buddy-panel:var\(--buddy-surface\);color-scheme:dark\}$/);
 assert.equal(dark.css.slice(first.length),DSW_THEME_CSS+WINDOW_PAGE_CSS);
 // the theme can follow the character, and anything but English is Chinese
 const light=pluginPageAppearance({themeMode:'character',language:'fr'},'claude');
 assert.deepEqual([light.theme,light.scheme,light.lang],['claude','light','zh-CN']);
 // a theme value can't close its rule early
 assert.equal((first.match(/[{}]/g)??[]).length,2);
 // the UI font is the one appearance.css defines, so heading fonts that fall back to it resolve
 assert.ok(dark.css.startsWith(':root{--buddy-f-ui:'+PAGE_UI_FONT+';'));
 const script=pluginPageAppearanceScript(dark);
 assert.match(script,/r\.dataset\.buddyLang=d\.lang;if\(d\.embedded\)r\.dataset\.buddyEmbedded='1';else delete r\.dataset\.buddyEmbedded;r\.lang=d\.lang;window\.dispatchEvent\(new CustomEvent\('ai-buddy:appearance'/);
 assert.ok(script.includes(JSON.stringify({theme:'deepseek',scheme:'dark',lang:'en',embedded:false})));
});

test('DSH tokens follow the theme; only an embedded page drops the DSH frame',()=>{
 // ":root body" outranks DSH's "body" and "body[data-ds-dark-theme]" rules
 assert.ok(DSW_THEME_CSS.startsWith(':root body,:root body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--buddy-bg);'));
 for(const value of DSW_THEME_CSS.match(/var\(--buddy-[a-z0-9-]+\)/g))assert.ok(value==='var(--buddy-f-ui)'||Object.hasOwn(themeVariables('deepseek'),value.slice(4,-1)),value);
 const page=pluginPageAppearance({theme:'claude',themeMode:'fixed'}),inMain=pluginPageAppearance({theme:'claude',themeMode:'fixed'},'deepseek',{embedded:true});
 assert.equal(page.embedded,false);assert.ok(!page.css.includes(EMBEDDED_FRAME_CSS));assert.ok(!/html\[data-buddy-embedded\]/.test(page.css));
 assert.equal(inMain.embedded,true);assert.ok(inMain.css.endsWith(EMBEDDED_FRAME_CSS));
 // every frame rule is scoped to the embedded marker and to the frame's own children
 for(const rule of EMBEDDED_FRAME_CSS.split('}').filter(Boolean))for(const selector of rule.split('{')[0].split(','))assert.match(selector,/^html\[data-buddy-embedded\] :has\(>\[data-rightbar-col\]\)/);
 assert.ok(!/\[data-side\]\{|,\[data-side\]/.test(EMBEDDED_FRAME_CSS),'popovers also use data-side');
 assert.match(pluginPageAppearanceScript(inMain),/"embedded":true/);
});

test('the page UI font matches appearance.css',async()=>{
 assert.match(await read('src/appearance.css'),new RegExp('--buddy-f-ui:'+PAGE_UI_FONT.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[;}\\r\\n]'));
});

test('each loaded document is dressed, a settings change re-dresses open pages and drops the old sheet',async()=>{
 const calls=[];let theme='deepseek';
 class Window extends EventEmitter{constructor(){super();let n=0;this.webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},isDestroyed:()=>!!this.dead,
  insertCSS:async css=>{calls.push(['css',css.slice(0,40)]);return 'k'+(++n);},removeInsertedCSS:async key=>{calls.push(['remove',key]);},executeJavaScript:async code=>{calls.push(['js',/buddy/.test(code)]);}});}
  async loadURL(){this.webContents.emit('dom-ready');}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}}
 const host=createDshClientHost({BrowserWindow:Window,session:{fromPartition(){return Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){}});}},appearance:()=>pluginPageAppearance({theme,themeMode:'fixed'})});
 await host.open({runtimeId:'r',profileId:'p',webOrigin:'http://127.0.0.1:4567',url:'http://127.0.0.1:4567/'});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls,[['css',':root{'+calls[0][1].slice(6)],['js',true]]);
 calls.length=0;theme='claude';await host.refreshAppearance();
 assert.deepEqual(calls.map(c=>c[0]),['css','remove','js']);assert.equal(calls[1][1],'k1');
 await host.close();
});

test('a page without the Electron methods, or one that refuses the script, keeps working',async()=>{
 assert.equal(await applyPluginPageAppearance(Object.assign(new EventEmitter(),{isDestroyed:()=>false}),pluginPageAppearance({}),'old'),'old');
 const contents={isDestroyed:()=>false,insertCSS:async()=>'k2',removeInsertedCSS:async()=>{},executeJavaScript:async()=>{throw Error('blocked');}};
 assert.equal(await applyPluginPageAppearance(contents,pluginPageAppearance({}),'k1'),'k2');
 assert.equal(await applyPluginPageAppearance(contents,null,'k1'),'k1');
});

test('the work page host and main wire the same appearance; the bridge protocol is untouched',async()=>{
 const work=await read('src/work-client-host.mjs'),platform=await read('src/plugin-platform.mjs'),main=await read('src/main.mjs');
 assert.match(work,/window\.webContents\.on\('dom-ready', \(\) => \{ row\.styleKey = null; void dress\(row\); \}\);/);
 assert.match(work,/return \{open, closePackage, close, refreshAppearance, notify, snapshot:/);
 assert.ok(platform.includes("createDshClientHost({BrowserWindow,session,openExternal,audit,onState:event=>{audit({type:'plugin-client',...event});clientEvents.emit('state',{kind:'community',...event});},appearance:pageAppearance})"));
 assert.ok(platform.includes("createWorkClientHost({BrowserWindow,session,ipcMain,preloadPath,openExternal,audit,onState:event=>{audit({type:'work-client',...event});clientEvents.emit('state',{kind:'work',state:event.state,surface:event.surface});},appearance:pageAppearance})"));
 // C-1: both hosts get the same appearance, faces included
 assert.match(main,/pageAppearance:options=>pluginPageAppearance\(settings\.preferences,themeCharacter,\{\.\.\.options,faces:pluginFaces\(\),portraits:\(builtinPluginPortraits\?\?=builtinPortraits\(build\)\)\}\)/);
 assert.match(main,/function broadcastSettings\(\)\{[^\n]*plugins\?\.refreshAppearance\?\.\(\)/);
 // page-level only: the scoped client channel and its event name stay as they were
 assert.match(work,/export const PLUGIN_CLIENT_CHANNEL = 'buddy-plugin-client:invoke';/);
});

test('a page load and a settings change at the same moment end with the newest theme on top',async()=>{
 const order=[];let theme='deepseek',n=0;
 class Window extends EventEmitter{constructor(){super();this.webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},isDestroyed:()=>!!this.dead,
  insertCSS:async css=>{const key='k'+(++n);await new Promise(r=>setTimeout(r,css.includes(themeVariables('deepseek')['--buddy-bg'])?30:1));order.push(['css',key,css.includes(themeVariables('claude')['--buddy-bg'])?'claude':'deepseek']);return key;},removeInsertedCSS:async key=>{order.push(['remove',key]);},executeJavaScript:async()=>{}});}
  async loadURL(){}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}}
 const host=createDshClientHost({BrowserWindow:Window,session:{fromPartition(){return Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){}});}},appearance:()=>pluginPageAppearance({theme,themeMode:'fixed'})});
 await host.open({runtimeId:'r',profileId:'p',webOrigin:'http://127.0.0.1:4567',url:'http://127.0.0.1:4567/'});
 // the slow deepseek insert starts first, the claude change arrives while it is still running
 const loaded=host.refreshAppearance();theme='claude';const changed=host.refreshAppearance();await Promise.all([loaded,changed]);
 const inserted=order.filter(row=>row[0]==='css');assert.equal(inserted.at(-1)[2],'claude');
 assert.deepEqual(order.filter(row=>row[0]==='remove').map(row=>row[1]),[inserted[0][1]]);
 await host.close();
});
