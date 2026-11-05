import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createPluginEmbed,validEmbedRequest,validEmbedRect,embedCapable,EMBED_CHANNEL} from '../src/plugin-embed.mjs';
import {embedView} from '../src/plugin-embed-page.mjs';
import {pluginPageAppearance} from '../src/plugin-page-appearance.mjs';
import {createDshClientHost} from '../src/dsh-platform/client-host.mjs';
import {createWorkClientHost} from '../src/work-client-host.mjs';
// Unit/simulated Electron objects. These checks are not real native UI evidence.
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
let ids=0;
class Contents extends EventEmitter{
  constructor(){super();this.id=++ids;this.js=[];this.panel='';this.embedded=true;this.hang=false;this.focused=false;this.dead=false;this.answer=id=>id;this.mainFrame={url:'http://127.0.0.1:4567/',parent:null};}
  // answers like the real page: "<data-buddy-embedded>|<data-buddy-panel>"
  executeJavaScript(code){this.js.push(code);if(this.hang)return new Promise(()=>{});const m=/id=("[^"]+")/.exec(code);if(m&&this.answer)this.panel=this.answer(JSON.parse(m[1]))??this.panel;return Promise.resolve((this.embedded?'1':'')+'|'+this.panel);}
  isDestroyed(){return this.dead;}close(){if(this.dead)return;this.dead=true;this.emit('destroyed');}isFocused(){return this.focused;}focus(){this.focused=true;}
  async loadURL(){this.emit('did-finish-load');}reload(){this.reloaded=true;}setWindowOpenHandler(){}send(){}
  async capturePage(){return {isEmpty:()=>false,toJPEG:()=>Buffer.from('picture')};}
}
function rig({panelVisible=true,answer=id=>id,options={},gate=null,openClient=null}={}){
  const views=[];
  class View{constructor({webPreferences}){this.webPreferences=webPreferences;this.webContents=new Contents();this.webContents.answer=answer;this.visible=null;this.bounds=null;views.push(this);}setVisible(v){this.visible=v;}setBounds(b){this.bounds=b;}setBackgroundColor(c){this.color=c;}}
  const panel={dead:false,visible:panelVisible,minimized:false,focused:true,isDestroyed(){return this.dead;},isVisible(){return this.visible;},isMinimized(){return this.minimized;},isFocused(){return this.focused;},getContentSize:()=>[1180,820],
    contentView:{children:[],addChildView(view){this.children.push(view);},removeChildView(view){this.children=this.children.filter(v=>v!==view);}}};
  const states=[],windows=[],surfaces=[];
  // a stand-in for the plugin hosts: load the page in the surface it was handed
  const open=async(target,surface)=>{if(openClient)return openClient(target,surface);if(gate)await gate();const s=surface({webPreferences:{sandbox:true,contextIsolation:true}});surfaces.push(s);s.on('closed',()=>embed.hostState({kind:target==='work'?'work':'community',state:'closed',surface:'embedded'}));await s.loadURL('http://127.0.0.1:4567/');s.show();return {state:'page-loaded'};};
  const embed=createPluginEmbed({WebContentsView:View,getPanel:()=>panel,open,openWindow:async target=>{windows.push(target);},onState:value=>states.push(value),backgroundColor:()=>'#101010',sleep:()=>new Promise(r=>setImmediate(r)),pollMs:0,...options});
  return {embed,views,panel,states,windows,surfaces};
}
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};

test('only well-formed requests from known targets get through',()=>{
  assert.throws(()=>validEmbedRequest({op:'open',target:'bilibili',url:'x'}),/unknown fields/);
  assert.throws(()=>validEmbedRequest({op:'navigate',target:'bilibili'}),/Unsupported/);
  assert.throws(()=>validEmbedRequest({op:'open',target:'@evil/plugin'}),/Unknown embed target/);
  assert.throws(()=>validEmbedRequest({op:'cover',covered:'yes'}),/explicit/);
  assert.equal(validEmbedRequest({op:'state'}).op,'state');
  assert.deepEqual(validEmbedRect({x:200.4,y:86,width:980.6,height:734},{width:1180,height:820}),{x:200,y:86,width:981,height:734});
  for(const rect of [{x:NaN,y:0,width:1,height:1},{x:0,y:0,width:2000,height:10},{x:-5,y:0,width:10,height:10},{x:0,y:0,width:0,height:10},{x:0,y:0,width:10,height:10,z:1}])assert.throws(()=>validEmbedRect(rect,{width:1180,height:820}));
  assert.equal(validEmbedRect(null,{width:1,height:1}),null);
});

test('Bilibili and QQ embed from 2.0.1; work embeds as it is',()=>{
  assert.equal(embedCapable('work','2.0.0'),true);
  for(const [v,ok] of [['2.0.0',false],['2.0.1',true],['2.0.1-rc.1',false],['2.1.0',true],['3.0.0',true],['1.9.9',false],['x',false],[undefined,false]])assert.equal(embedCapable('bilibili',v),ok,v);
  assert.equal(embedCapable('@other/plugin','9.9.9'),false);
  // the page's own view of the same rules
  assert.equal(embedView('qq',null,null),'none');assert.equal(embedView('qq',{enabled:false,exactVersion:'2.0.1'},null),'off');
  assert.equal(embedView('qq',{enabled:true,exactVersion:'2.0.0'},null),'unsupported');assert.equal(embedView('qq',{enabled:true,exactVersion:'2.0.1'},{state:'run',target:'bilibili'}),'start');
  assert.equal(embedView('qq',{enabled:true,exactVersion:'2.0.1'},{state:'run',target:'qq'}),'run');assert.equal(embedView('qq',{enabled:true,exactVersion:'2.0.1'},{state:'popped',target:'qq'}),'popped');
});

test('the shared community page stays hidden until the plugin says its panel is showing',async()=>{
  let ready=false;const {embed,views,states}=rig({answer:id=>ready?id:''});
  await embed.handle({op:'slot',target:'bilibili',rect:{x:200,y:86,width:980,height:734}});
  await embed.handle({op:'open',target:'bilibili'});await settle();
  // the plugin has not answered yet: DSH's own conversation panel must not flash
  const view=views[0];assert.ok(view,'a view was created');assert.equal(view.webPreferences.sandbox,true);
  assert.equal(states.at(-1).state,'start');assert.equal(view.visible,false);
  assert.ok(view.webContents.js.some(code=>code.includes('"@ai-buddy/bilibili-companion"')&&code.includes("ai-buddy:open-plugin-page")));
  ready=true;await settle();
  assert.equal(states.at(-1).state,'run');assert.equal(view.visible,true);assert.deepEqual(view.bounds,{x:200,y:86,width:980,height:734});
  const answered=true;
  // leaving the page hides it without closing it
  await embed.handle({op:'slot',target:'bilibili',rect:null});assert.equal(view.visible,false);assert.equal(view.webContents.dead,false);
  // QQ uses the same page: the host asks again, nothing new is created
  await embed.handle({op:'slot',target:'qq',rect:{x:200,y:86,width:980,height:734}});await embed.handle({op:'open',target:'qq'});await settle();
  assert.equal(views.length,1);assert.ok(view.webContents.js.some(code=>code.includes('"@ai-buddy/qq-connect"')));assert.equal(view.visible,true);
  assert.ok(answered);
});

test('a plugin that never answers ends on the not-loading screen',async()=>{
  let t=0;const {embed,views,states}=rig({answer:null,options:{firstLoadTimeoutMs:5,now:()=>(t+=3)}});
  await embed.handle({op:'slot',target:'qq',rect:{x:200,y:86,width:980,height:734}});await embed.handle({op:'open',target:'qq'});await settle();
  // first timeout: the page is loaded once more; the second one ends on the error screen
  assert.equal(views[0].webContents.reloaded,true);assert.equal(states.at(-1).state,'start');
  views[0].webContents.emit('did-finish-load');await settle();
  assert.equal(states.at(-1).state,'err');assert.equal(states.at(-1).code,'PLUGIN_EMBED_PANEL_TIMEOUT');assert.equal(views[0].visible,false);
});

test('an AI Buddy dialog gets a picture of the page; the page comes back when it closes',async()=>{
  const {embed,views}=rig();
  assert.deepEqual(await embed.handle({op:'capture'}),{image:null});
  await embed.handle({op:'slot',target:'bilibili',rect:{x:200,y:86,width:980,height:734}});await embed.handle({op:'open',target:'bilibili'});await settle();
  const shot=await embed.handle({op:'capture'});assert.match(shot.image,/^data:image\/jpeg;base64,/);
  await embed.handle({op:'cover',covered:true});assert.equal(views[0].visible,false);
  await embed.handle({op:'cover',covered:false});assert.equal(views[0].visible,true);
});

test('hidden to the tray: pages go away and reopen on the next visit; a separate window can come back',async()=>{
  const {embed,views,states,windows,panel}=rig();
  await embed.handle({op:'slot',target:'bilibili',rect:{x:200,y:86,width:980,height:734}});await embed.handle({op:'open',target:'bilibili'});await settle();
  panel.visible=false;embed.release();assert.equal(views[0].webContents.dead,true);assert.equal(states.at(-1).state,'idle');
  // the page left mounted behind the hidden window must not start it again
  assert.equal((await embed.handle({op:'open',target:'bilibili'})).state,'idle');assert.equal(views.length,1);panel.visible=true;
  await embed.handle({op:'open',target:'bilibili'});await settle();assert.equal(views.length,2);assert.equal(states.at(-1).state,'run');
  // a page that closes itself is not reopened by itself
  views[1].webContents.close();assert.equal(states.at(-1).state,'err');
  await embed.handle({op:'popout',target:'qq'});assert.deepEqual(windows,['qq']);assert.equal(states.at(-1).state,'popped');
  // while popped out, opening here only reports it
  assert.equal((await embed.handle({op:'open',target:'qq'})).state,'popped');
  embed.hostState({kind:'community',state:'closed',surface:'window'});assert.equal(states.at(-1).state,'idle');
});

test('the work page counts as visible only when it is on screen, the window is up and both have focus',async()=>{
  const {embed,surfaces,panel,views}=rig();
  await embed.handle({op:'slot',target:'work',rect:{x:200,y:86,width:980,height:734}});await embed.handle({op:'open',target:'work'});await settle();
  const page=surfaces[0];assert.equal(page.isVisible(),true);assert.equal(page.isFocused(),false,'the page itself must have focus');
  views[0].webContents.focus();assert.equal(page.isFocused(),true);
  panel.focused=false;assert.equal(page.isFocused(),false);panel.focused=true;
  await embed.handle({op:'slot',target:'work',rect:null});assert.equal(page.isVisible(),false);
  panel.minimized=true;assert.equal(page.isMinimized(),true);
  // a work page may refuse to close; release() asks rather than destroys
  let asked=0;page.on('close',event=>{asked++;event.preventDefault();});embed.release();assert.equal(asked,1);assert.equal(page.isDestroyed(),false);
});

test('the plugin hosts build an embedded page with the same webPreferences and one page per runtime',async()=>{
  const made=[];class Window extends EventEmitter{constructor(o){super();this.options=o;this.webContents=Object.assign(new Contents(),{});made.push(this);}async loadURL(){this.webContents.emit('dom-ready');}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}}
  const session={fromPartition(){return Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){},clearStorageData:async()=>{}});}};
  const asked=[];const host=createDshClientHost({BrowserWindow:Window,session,appearance:options=>{asked.push(options);return null;}});
  const surfaced=[];const surface=({webPreferences})=>{const s=new Window({webPreferences});surfaced.push(s);return s;};
  const descriptor={runtimeId:'r',profileId:'buddy-community-v1',webOrigin:'http://127.0.0.1:4567',url:'http://127.0.0.1:4567/'};
  assert.equal((await host.open(descriptor,{surface})).surface,'embedded');
  const prefs=surfaced[0].options.webPreferences;assert.deepEqual([prefs.sandbox,prefs.contextIsolation,prefs.nodeIntegration,prefs.devTools,prefs.preload],[true,true,false,false,undefined]);
  await new Promise(r=>setImmediate(r));assert.deepEqual(asked.at(-1),{embedded:true});
  // opening the same runtime in its own window closes the embedded page first
  assert.equal((await host.open(descriptor)).surface,'window');assert.equal(surfaced[0].dead,true);assert.equal(host.snapshot()[0].surface,'window');
  await assert.rejects(host.open(descriptor,{surface:'not-a-function'}),/host supplied/);
  await host.close();
  const work=createWorkClientHost({BrowserWindow:Window,session,ipcMain:{handle(){},removeHandler(){}},preloadPath:'C:/build/plugin-client-preload.cjs'});
  const record={packageName:'@ai-buddy/work-collaboration',packageKey:'k',pluginId:'p',generation:1,enabled:true};
  const handlers={assertCurrent:async()=>{}};
  const opened=await work.open({record,descriptor:{...descriptor,profileId:'buddy-work-ui-1'},handlers,surface});
  assert.equal(opened.surface,'embedded');assert.equal(surfaced.at(-1).options.webPreferences.preload,'C:/build/plugin-client-preload.cjs');
  await work.open({record,descriptor:{...descriptor,profileId:'buddy-work-ui-1'},handlers});assert.equal(surfaced.at(-1).dead,true);assert.equal(work.snapshot()[0].surface,'window');
  await work.close();
});

test('main accepts embed requests only from the main window page, and wires the hosts to the embed state',async()=>{
  const main=await read('src/main.mjs'),preload=await read('src/preload.mjs');
  assert.equal(EMBED_CHANNEL,'plugins:embed');
  assert.match(main,/ipcMain\.handle\(EMBED_CHANNEL,async\(event,request\)=>\{if\(event\.sender!==panel\?\.webContents\|\|event\.senderFrame!==panel\.webContents\.mainFrame\)throw Error\('Invalid embed sender'\);/);
  assert.match(main,/plugins\.onClientState\(value=>pluginEmbed\?\.hostState\(value\)\);/);
  assert.match(main,/panel\.on\('hide',\(\)=>pluginEmbed\?\.release\(\)\);/);
  assert.match(preload,/embed:request=>modelRequest\('plugins:embed',request\)/);
  // review round 1: page moves wait for a data import; the folder picker keeps a real window as its parent
  assert.match(main,/if\(!\['state','slot','cover','capture'\]\.includes\(request\?\.op\)\)assertImportIdle\(\);return await pluginEmbed\.handle\(request\);/);
  assert.match(main,/dialog\.showOpenDialog\(meta\.window instanceof BrowserWindow\?meta\.window:panel\?\?undefined,/);
  assert.match(main,/panel\.on\('show',\(\)=>\{try\{assertImportIdle\(\);pluginEmbed\?\.resume\(\);\}catch\{\}\}\);/);
  assert.match(main,/if\(Array\.isArray\(snapshot\?\.dsh\?\.installed\)\)pluginEmbed\?\.recordsChanged\(snapshot\.dsh\.installed\);/);
});

// Review round 1 (findings 1, 3, 4, 6, 7, 8, 11): each scenario below failed before the fix.
const RECT={x:200,y:86,width:980,height:734};
for(const sequence of [['bilibili','card-games','qq','card-games','bilibili'],['card-games','bilibili','qq']]){
 test('a reused community runtime shows the selected panel: '+sequence.join(' → '),async()=>{
  const session={fromPartition:()=>Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},async clearStorageData(){}})};
  const host=createDshClientHost({BrowserWindow:class {},session});
  const descriptor={runtimeId:'r',profileId:'buddy-community-v1',webOrigin:'http://127.0.0.1:4567',url:'http://127.0.0.1:4567/'};
  const {embed,views}=rig({openClient:(_target,surface)=>host.open(descriptor,{surface})});
  const packages={bilibili:'@ai-buddy/bilibili-companion',qq:'@ai-buddy/qq-connect','card-games':'@ai-buddy/card-games'};
  try{
   for(const [index,target] of sequence.entries()){
    if(index)await embed.handle({op:'slot',target:sequence[index-1],rect:null});
    await embed.handle({op:'slot',target,rect:RECT});
    await embed.handle({op:'open',target});
    await settle();
    assert.equal(embed.snapshot().find(row=>row.target===target)?.state,'run',target);
    assert.equal(views.length,1);
    assert.equal(views[0].webContents.panel,packages[target]);
    assert.equal(views[0].visible,true);
    assert.equal(host.snapshot().length,1);
   }
  }finally{embed.close();await host.close();}
 });
}
test('bundled cards retain their own embedded slot alongside community panels',async()=>{
 const {embed,views}=rig({options:{recordFor:target=>target==='card-games'?{localBundled:true}:null}});
 try{
  await embed.handle({op:'slot',target:'bilibili',rect:RECT});
  await embed.handle({op:'open',target:'bilibili'});
  await settle();
  await embed.handle({op:'slot',target:'bilibili',rect:null});
  await embed.handle({op:'slot',target:'card-games',rect:RECT});
  await embed.handle({op:'open',target:'card-games'});
  await settle();
  assert.deepEqual(embed.snapshot().filter(row=>row.state==='run').map(row=>[row.kind,row.target]),[['community','bilibili'],['card','card-games']]);
  assert.equal(views.length,2);
  assert.equal(views[0].visible,false);
  assert.equal(views[1].visible,true);
 }finally{embed.close();}
});
test('a popped-out card page does not appear as a popped-out Bilibili page',async()=>{
 const {embed,views}=rig();
 try{
  const popped=await embed.handle({op:'popout',target:'card-games'});
  assert.equal(popped.state,'popped');
  assert.equal(embedView('bilibili',{enabled:true,exactVersion:'2.0.11'},popped),'start');
  await embed.handle({op:'slot',target:'bilibili',rect:RECT});
  await embed.handle({op:'open',target:'bilibili'});
  await settle();
  assert.equal(views[0].webContents.panel,'@ai-buddy/bilibili-companion');
  assert.equal(views[0].visible,true);
 }finally{embed.close();}
});
test('a resolved open without its surface reports an error instead of waiting indefinitely',async()=>{
 const {embed}=rig({openClient:async()=>({state:'page-loaded',surface:'embedded'})});
 try{
  const state=await embed.handle({op:'open',target:'card-games'});
  assert.equal(state.state,'err');
  assert.equal(state.code,'PLUGIN_EMBED_SURFACE_MISSING');
 }finally{embed.close();}
});
test('the actual reading-open host callback preserves the embedded surface and explicit popout remains available',async()=>{
 const main=await read('src/main.mjs'),callback=main.match(/onReadingOpen:(async\(\)=>\{[\s\S]*?\}),\r?\n    hostServices:/)?.[1];assert.ok(callback,'the native reading-open callback must be wired');const {embed,views,windows}=rig();await embed.handle({op:'slot',target:'bilibili',rect:RECT});await embed.handle({op:'open',target:'bilibili'});await settle();const original=views[0],open=runInNewContext('('+callback+')',{assertImportIdle(){},pluginEmbed:embed});await open();await settle();assert.equal(windows.length,0,'opening a reading must not pop out');assert.equal(views.length,1);assert.equal(original.webContents.dead,false);assert.equal(original.visible,true);await embed.handle({op:'popout',target:'bilibili'});assert.deepEqual(windows,['bilibili']);
});
test('back from the tray, the page that was showing comes back without a new placement report',async()=>{
  const {embed,views,panel}=rig();
  await embed.handle({op:'slot',target:'bilibili',rect:RECT});await embed.handle({op:'open',target:'bilibili'});await settle();
  panel.visible=false;embed.release();panel.visible=true;embed.resume();await settle();
  assert.equal(views.length,1,'resume() alone starts nothing that was given back');
  // the main window asks again when it becomes visible; the placement it reported before is still known
  await embed.handle({op:'open',target:'bilibili'});await settle();
  assert.equal(views.length,2);assert.equal(views[1].visible,true,'same page and size, no new ResizeObserver report');
});
test('an open asked for while the window was still hidden starts when it is shown',async()=>{
  const {embed,views,panel}=rig({panelVisible:false});
  await embed.handle({op:'slot',target:'qq',rect:RECT});assert.equal((await embed.handle({op:'open',target:'qq'})).state,'idle');assert.equal(views.length,0);
  panel.visible=true;embed.resume();await settle();assert.equal(views.length,1);assert.equal(views[0].visible,true);
});
test('popping out while a page is still opening cancels that open instead of waiting behind it',async()=>{
  const {embed,views,states,windows}=rig({gate:()=>new Promise(()=>{})});
  await embed.handle({op:'slot',target:'work',rect:RECT});void embed.handle({op:'open',target:'work'});await settle();
  await embed.handle({op:'popout',target:'work'});assert.deepEqual(windows,['work']);assert.equal(states.at(-1).state,'popped');assert.equal(views.length,0);
});
test('the injected selectors are valid Chromium selectors: no :has() inside :has()',()=>{
  const css=pluginPageAppearance({},'deepseek',{embedded:true}).css;
  for(let i=css.indexOf(':has(');i>=0;i=css.indexOf(':has(',i+1)){let depth=0,j=i+4;for(;j<css.length;j++){if(css[j]==='(')depth++;else if(css[j]===')'&&--depth===0)break;}assert.ok(!css.slice(i+5,j).includes(':has('),'nested :has() at '+i);}
});
test('a page given back while it was still opening does not turn into an error or a hidden view',async()=>{
  let release;const pending=new Promise(r=>{release=r;});
  const {embed,views,states,panel}=rig({gate:()=>pending});
  await embed.handle({op:'slot',target:'work',rect:RECT});const opening=embed.handle({op:'open',target:'work'});await settle();
  panel.visible=false;embed.release();release();await opening;await settle();
  assert.equal(views.length,0,'no view is built behind the hidden window');assert.equal(states.at(-1).state,'idle');
});
test('switching Bilibili to QQ hides the page until QQ answers; a missing plugin gets one reload, then an error',async()=>{
  let qqReady=false;const {embed,views,states}=rig({answer:id=>id.endsWith('qq-connect')&&!qqReady?'':id,options:{firstLoadTimeoutMs:50}});
  await embed.handle({op:'slot',target:'bilibili',rect:RECT});await embed.handle({op:'open',target:'bilibili'});await settle();
  assert.equal(views[0].visible,true);
  await embed.handle({op:'slot',target:'qq',rect:RECT});await embed.handle({op:'open',target:'qq'});await settle();
  assert.equal(views[0].visible,false,'Bilibili never shows under the QQ bar');assert.equal(states.at(-1).state,'start');
  qqReady=true;await settle();assert.equal(views[0].visible,true);assert.equal(states.at(-1).target,'qq');
  // a plugin whose code is not in the page: one reload, then the not-loading screen
  const r=rig({answer:()=>'' ,options:{firstLoadTimeoutMs:5,now:(()=>{let t=0;return()=>(t+=3);})()}});
  await r.embed.handle({op:'slot',target:'qq',rect:RECT});await r.embed.handle({op:'open',target:'qq'});await settle();
  assert.equal(r.views[0].webContents.reloaded,true);r.views[0].webContents.emit('did-finish-load');await settle();
  assert.equal(r.states.at(-1).state,'err');assert.equal(r.states.at(-1).code,'PLUGIN_EMBED_PANEL_TIMEOUT');
});
test('retry builds a fresh page instead of reloading a dead one, without reporting the old page as a failure',async()=>{
  const {embed,views,states}=rig();
  await embed.handle({op:'slot',target:'bilibili',rect:RECT});await embed.handle({op:'open',target:'bilibili'});await settle();
  const seen=[];const off=states.length;await embed.handle({op:'reload',target:'bilibili'});await settle();
  for(const s of states.slice(off))seen.push(s.state);
  assert.equal(views.length,2);assert.equal(views[0].webContents.dead,true);assert.ok(!seen.includes('err'),seen.join(','));assert.equal(states.at(-1).state,'run');
});
test('a hung page script cannot hold the check forever',async()=>{
  let t=0;const {embed,views,states}=rig({options:{firstLoadTimeoutMs:5,callTimeoutMs:1,now:()=>(t+=3)}});
  views.length=0;await embed.handle({op:'slot',target:'qq',rect:RECT});
  const opening=embed.handle({op:'open',target:'qq'});await settle();views[0].webContents.hang=true;await opening;
  for(let i=0;i<20&&states.at(-1).state==='start';i++)await new Promise(r=>setTimeout(r,5));
  assert.notEqual(states.at(-1).state,'start');
});
test('disabling the plugin takes its page away; a 2.0.0 plugin opening its own window counts as popped out',async()=>{
  const {embed,views,states}=rig();
  await embed.handle({op:'slot',target:'bilibili',rect:RECT});await embed.handle({op:'open',target:'bilibili'});await settle();
  embed.recordsChanged([{packageName:'@ai-buddy/bilibili-companion',enabled:false}]);
  assert.equal(views[0].webContents.dead,true);assert.equal(states.at(-1).state,'idle');
  embed.recordsChanged([{packageName:'@ai-buddy/bilibili-companion',enabled:true}]);
  await embed.handle({op:'open',target:'bilibili'});await settle();
  embed.hostState({kind:'community',state:'page-loaded',surface:'window'});assert.equal(states.at(-1).state,'popped');
});
test('a host does not report a failure for a page it already replaced (late load errors)',async()=>{
  const states=[];let fail;
  class Window extends EventEmitter{constructor(o){super();this.options=o;this.webContents=new Contents();}loadURL(){return this.options.slow?new Promise((_,reject)=>{fail=reject;}):Promise.resolve();}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){if(this.dead)return;this.dead=true;this.emit('closed');}}
  const session={fromPartition(){return Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){},clearStorageData:async()=>{}});}};
  const host=createDshClientHost({BrowserWindow:Window,session,onState:value=>states.push(value)});
  const descriptor={runtimeId:'r',profileId:'buddy-community-v1',webOrigin:'http://127.0.0.1:4567',url:'http://127.0.0.1:4567/'};
  const slowPage=host.open(descriptor,{surface:({webPreferences})=>new Window({webPreferences,slow:true})});await new Promise(r=>setImmediate(r));
  await host.open(descriptor);fail(Object.assign(Error('ERR_FAILED'),{code:'ERR_FAILED'}));
  await assert.rejects(slowPage,{code:'DSH_CLIENT_CLOSED'});
  assert.ok(!states.some(s=>s.state==='client-failed'),JSON.stringify(states));
  await host.close();
});
test('an open that runs past its deadline is cancelled: its late page is never built',async()=>{
  let release;const pending=new Promise(r=>{release=r;});
  const {embed,views,states}=rig({gate:()=>pending,options:{openTimeoutMs:5}});
  await embed.handle({op:'slot',target:'work',rect:RECT});await embed.handle({op:'open',target:'work'});
  assert.equal(states.at(-1).state,'err');assert.equal(states.at(-1).code,'PLUGIN_EMBED_OPEN_TIMEOUT');
  release();await settle();assert.equal(views.length,0,'the late open is refused');assert.equal(states.at(-1).code,'PLUGIN_EMBED_OPEN_TIMEOUT');
  // Retry starts a fresh open that can finish
  const r=rig({options:{openTimeoutMs:5000}});await r.embed.handle({op:'slot',target:'work',rect:RECT});await r.embed.handle({op:'reload',target:'work'});await settle();assert.equal(r.states.at(-1).state,'run');
});
