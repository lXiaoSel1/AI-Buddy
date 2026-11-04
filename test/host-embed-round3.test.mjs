import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createDshClientHost,publicLinkUrl,pluginWindowOpenHandler,pageEventScript,LINK_INTERVAL_MS} from '../src/dsh-platform/client-host.mjs';
import {createWorkClientHost} from '../src/work-client-host.mjs';
import {panelScript,PANEL_CHECK,pluginPageEntries,EMBED_TARGETS} from '../src/plugin-embed-targets.mjs';
import {pluginPageAppearance,pluginFaceCss,validFace,EMBEDDED_FRAME_CSS,WINDOW_PAGE_CSS,DSH_NAG_GUARD,DSH_WORKSPACE_NAG,FACE_MAX_BYTES,FACES_MAX_BYTES} from '../src/plugin-page-appearance.mjs';
import {builtinFaces,customFace,customFaces} from '../src/plugin-faces.mjs';
import {loginAutoStarts,qrSecondsLeft,qrExpiryText,SocialLoginDialog,QR_LIFETIME_MS} from '../src/social-login-ui.mjs';
import {accountUsage} from '../src/social-accounts-ui.mjs';
import {PageBoundary,PageErrorCard} from '../src/page-boundary.mjs';
import {EmbedArea} from '../src/plugin-embed-page.mjs';
import {revealInstalledRecord} from '../src/community-center.mjs';
import {setLocale} from '../src/i18n.mjs';
// Unit/simulated Electron objects and server-side rendering. These checks are not real native UI evidence.
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const settle=async(n=20)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const session={fromPartition(){return Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){},clearStorageData:async()=>{}});}};
// a separate DSH window whose plugin answers once its code has loaded (like the real shared community page)
function windowClass(made,{loadsAfter=2}={}){
 return class Window extends EventEmitter{constructor(o){super();this.options=o;made.push(this);const self=this;this.scripts=[];this.dataset={};this.calls=0;
  this.webContents=Object.assign(new EventEmitter(),{isDestroyed:()=>!!self.dead,setWindowOpenHandler(fn){self.openHandler=fn;},
   executeJavaScript:async code=>{self.scripts.push(code);self.calls++;const m=/id=("[^"]+")/.exec(code);if(m)self.dataset.buddyOpenPlugin=JSON.parse(m[1]);if(code.includes('ai-buddy:social-accounts-changed'))self.events=(self.events??0)+1;
    // the plugin selects its panel only after its code arrived and the host has named it
    if(self.calls>loadsAfter&&self.dataset.buddyOpenPlugin)self.dataset.buddyPanel=self.dataset.buddyOpenPlugin;return '|'+(self.dataset.buddyPanel??'');}});}
  async loadURL(){this.webContents.emit('dom-ready');this.webContents.emit('did-finish-load');}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}};
}
const descriptor={runtimeId:'r',profileId:'buddy-community-v1',webOrigin:'http://127.0.0.1:4567',url:'http://127.0.0.1:4567/'};

test('甲3: a separate window opens on the plugin it was opened for, after every load, and can switch plugin',async()=>{
 const made=[];const host=createDshClientHost({BrowserWindow:windowClass(made),session,sleep:()=>Promise.resolve(),panelPollMs:0});
 await host.open(descriptor,{panel:'@ai-buddy/bilibili-companion'});await settle();
 const w=made[0];assert.equal(w.dataset.buddyPanel,'@ai-buddy/bilibili-companion','the plugin selected its own panel');
 assert.ok(w.scripts.some(code=>code.includes("ai-buddy:open-plugin-page")&&code.includes('"@ai-buddy/bilibili-companion"')));
 // it stops asking once the plugin answered
 const asked=w.calls;await settle();assert.equal(w.calls,asked);
 // a reload of the document asks again
 w.dataset.buddyPanel='';w.calls=0;w.webContents.emit('did-finish-load');await settle();assert.equal(w.dataset.buddyPanel,'@ai-buddy/bilibili-companion');
 // the same page asked for QQ switches to QQ instead of opening a second window
 await host.open(descriptor,{panel:'@ai-buddy/qq-connect'});await settle();assert.equal(made.length,1);assert.equal(w.dataset.buddyOpenPlugin,'@ai-buddy/qq-connect');assert.equal(w.dataset.buddyPanel,'@ai-buddy/qq-connect');
 await assert.rejects(host.open(descriptor,{panel:'"><script>'}),/package name/);
 assert.throws(()=>panelScript('not a package'));assert.match(PANEL_CHECK,/buddyPanel/);
 await host.close();
 // a page that never answers is not asked forever
 const quiet=[];const host2=createDshClientHost({BrowserWindow:windowClass(quiet,{loadsAfter:Infinity}),session,sleep:()=>Promise.resolve(),panelPollMs:0,panelRounds:6});
 await host2.open(descriptor,{panel:'@ai-buddy/qq-connect'});await settle(40);assert.equal(quiet[0].calls,6);await host2.close();
});

test('甲3: the platform opens a community plugin\'s own window with its panel; embedded views keep their own handshake',async()=>{
 const platform=await read('src/plugin-platform.mjs'),host=await read('src/dsh-platform/client-host.mjs'),embed=await read('src/plugin-embed.mjs');
 assert.match(platform,/clientHost\.open\(descriptor,\{surface:embedScope\.getStore\(\)\?\.surface\?\?null,panel:embedScope\.getStore\(\)\?\.panel\?\?null\}\)/);
 assert.match(platform,/operation==='dsh-open-client'&&request\.external!==true&&!embedScope\.getStore\(\)\)\{const record=[^\n]*record\.packageName!=='@ai-buddy\/work-collaboration'[^\n]*embedScope\.run\(\{surface:null,panel:record\.packageName\}/);
 // only separate windows are chosen by the host; the embedded view is settled by plugin-embed.mjs
 assert.match(host,/if\(!surface\)window\.webContents\.on\('did-finish-load'/);
 assert.match(embed,/const PANEL_SCRIPT=panelScript;/);
});

test('甲4 / C-5: public http(s) links go to the system browser; everything else is denied; no new Electron window',async()=>{
 for(const url of ['https://www.bilibili.com/video/BV1xx411c7mD?t=30#reply','http://example.com/a'])assert.equal(publicLinkUrl(url),new URL(url).href);
 for(const url of ['javascript:alert(1)','file:///C:/x','http://127.0.0.1:4567/','http://localhost/','http://192.168.1.2/','http://[::1]/','https://user:pw@example.com/','https://example.com/?access_token=x','http://intranet/','ftp://example.com/','',null,'https://example.com/\u0000'])assert.equal(publicLinkUrl(url),null,String(url));
 const opened=[];let now=0;const handler=pluginWindowOpenHandler({openExternal:async url=>{opened.push(url);},now:()=>now});
 assert.deepEqual(handler({url:'https://www.bilibili.com/video/BV1'}),{action:'deny'});
 assert.deepEqual(handler({url:'https://www.bilibili.com/video/BV2'}),{action:'deny'},'a second link in the same instant is dropped');
 now+=LINK_INTERVAL_MS;handler({url:'http://127.0.0.1:9/'});handler({url:'https://example.com/form',postBody:{data:[]}});handler({url:'https://www.bilibili.com/video/BV3'});
 await settle();assert.deepEqual(opened,['https://www.bilibili.com/video/BV1','https://www.bilibili.com/video/BV3']);
 // both hosts, embedded view and separate window alike
 const made=[],links=[];const host=createDshClientHost({BrowserWindow:windowClass(made),session,openExternal:async url=>links.push(url),sleep:()=>Promise.resolve()});
 await host.open(descriptor,{surface:({webPreferences})=>new (windowClass(made))({webPreferences})});made[0].openHandler({url:'https://www.bilibili.com/'});await settle();
 await host.open(descriptor);made[1].openHandler({url:'https://space.bilibili.com/1'});await settle();assert.deepEqual(links,['https://www.bilibili.com/','https://space.bilibili.com/1']);await host.close();
 const work=createWorkClientHost({BrowserWindow:windowClass(made),session,ipcMain:{handle(){},removeHandler(){}},preloadPath:'C:/build/plugin-client-preload.cjs',openExternal:async url=>links.push(url)});
 await work.open({record:{packageName:'@ai-buddy/work-collaboration',packageKey:'k',pluginId:'p',generation:1,enabled:true},descriptor:{...descriptor,profileId:'buddy-work-ui-1'},handlers:{assertCurrent:async()=>{}}});
 assert.deepEqual(made.at(-1).openHandler({url:'https://github.com/x'}),{action:'deny'});made.at(-1).openHandler({url:'http://127.0.0.1:1/'});await settle();assert.equal(links.at(-1),'https://github.com/x');await work.close();
});

test('C-4: the host fires only its fixed page events into every open page',async()=>{
 assert.throws(()=>pageEventScript('ai-buddy:anything'));assert.match(pageEventScript('ai-buddy:social-accounts-changed'),/^window\.dispatchEvent\(new CustomEvent\("ai-buddy:social-accounts-changed"\)\)$/);
 const made=[];const host=createDshClientHost({BrowserWindow:windowClass(made),session,sleep:()=>Promise.resolve()});await host.open(descriptor);
 await host.notify('ai-buddy:social-accounts-changed');assert.equal(made[0].events,1);await assert.rejects(host.notify('x'));await host.close();
 const platform=await read('src/plugin-platform.mjs');
 assert.match(platform,/socialAccounts\.subscribe\(\(\)=>\{[^\n]*clientHost\.notify\('ai-buddy:social-accounts-changed'\)[^\n]*workClientHost\?\.notify\('ai-buddy:social-accounts-changed'\)/);
});

test('甲8 / C-3: the scrolling stop-gap is valid Chromium CSS and scoped (verified in real Chrome, see report)',()=>{
 const nested=css=>{for(let i=css.indexOf(':has(');i>=0;i=css.indexOf(':has(',i+1)){let depth=0,j=i+4;for(;j<css.length;j++){if(css[j]==='(')depth++;else if(css[j]===')'&&--depth===0)break;}if(css.slice(i+5,j).includes(':has('))return true;}return false;};
 assert.equal(nested(EMBEDDED_FRAME_CSS),false);assert.equal(nested(WINDOW_PAGE_CSS),false);
 assert.match(EMBEDDED_FRAME_CSS,/html\[data-buddy-embedded\] [^{]*>:has\(>\[data-slot="main"\]\)\{overflow-y:auto!important/);
 // in a separate window only a Bilibili, QQ or card-games root makes the column scroll; DSH's own panels and the work page keep theirs
 for(const rule of WINDOW_PAGE_CSS.split('}').filter(Boolean))assert.match(rule,/^html:not\(\[data-buddy-embedded\]\) .*:is\(\.bili,\.qq,\[data-card-games\]\)/);
 assert.ok(pluginPageAppearance({},'deepseek').css.includes(WINDOW_PAGE_CSS));assert.ok(!pluginPageAppearance({},'deepseek',{embedded:true}).css.includes(WINDOW_PAGE_CSS));
});

test('甲9 / C-1: faces are checked apart from theme values, and the injected rule stays bounded',()=>{
 const ok='data:image/webp;base64,UklGRg==';
 assert.equal(validFace('deepseek',ok),true);
 for(const [id,data] of [['Deep',ok],['-x',ok],['a'.repeat(41),ok],['x;y',ok],['x','data:image/svg+xml;base64,PHN2Zz4='],['x','data:image/webp;base64,AA")}body{x:y'],['x','data:image/webp;base64,A=A='],['x','url(x)'],['x','data:image/webp;base64,'+'A'.repeat(FACE_MAX_BYTES)]])assert.equal(validFace(id,data),false,id+' '+String(data).slice(0,40));
 const css=pluginFaceCss({claude:ok,deepseek:ok,'Bad Id':ok,evil:'data:image/png;base64,AAAA");}*{x:y'});
 assert.equal(css,':root{--buddy-face-claude:url("'+ok+'");--buddy-face-deepseek:url("'+ok+'")}');
 assert.equal(pluginFaceCss(null),'');assert.equal(pluginFaceCss({}),'');
 // many large faces stop at the size bound instead of growing the page's stylesheet without limit
 const big='data:image/webp;base64,'+'A'.repeat(60000),many=Object.fromEntries(Array.from({length:40},(_,i)=>['c'+i,big]));
 const bounded=pluginFaceCss(many);assert.ok(bounded.length<=FACES_MAX_BYTES+16);assert.ok((bounded.match(/--buddy-face-/g)??[]).length<40);
 // faces go after the fixed rules, in both page kinds
 const page=pluginPageAppearance({},'deepseek',{embedded:true,faces:{kimi:ok}});assert.ok(page.css.endsWith(':root{--buddy-face-kimi:url("'+ok+'")}'));assert.ok(page.css.includes(EMBEDDED_FRAME_CSS));
});

test('甲9: built-in heads come from the theme assets; custom avatars are shrunk or left out',()=>{
 const faces=builtinFaces(new URL('..',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
 assert.ok(Object.keys(faces).length>=10);for(const [id,data] of Object.entries(faces))assert.equal(validFace(id,data),true,id);
 const small='data:image/webp;base64,'+Buffer.alloc(300).toString('base64'),large='data:image/webp;base64,'+Buffer.alloc(70000).toString('base64');
 assert.equal(customFace(small),small);assert.equal(customFace(large),null,'an image that cannot be shrunk here and is too big is left out');
 assert.equal(customFace('assets/x.png'),null);assert.equal(customFace('https://example.com/a.png'),null);
 const media='buddy-media://'+'a'.repeat(64)+'.webp';assert.equal(customFace(media,{sizeMedia:()=>100,readMedia:name=>name.endsWith('.webp')?Buffer.alloc(100):null}),'data:image/webp;base64,'+Buffer.alloc(100).toString('base64'));
 // png/jpeg are decoded and made small
 const image={createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:800,height:600}),resize(o){this.size=o;return this;},toJPEG:()=>Buffer.alloc(900)})};
 const png=Buffer.alloc(90000);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(800,16);png.writeUInt32BE(600,20);
 const shrunk=customFace('data:image/png;base64,'+png.toString('base64'),{image});assert.match(shrunk,/^data:image\/jpeg;base64,/);assert.ok(shrunk.length<4000);
 const all=customFaces([{id:'custom-1',avatar:small},{id:'deepseek',avatar:small},{id:'custom-'+'x'.repeat(40),avatar:small},{id:'b',builtin:true,avatar:small},{id:'c'}]);
 assert.deepEqual(Object.keys(all),['custom-1']);
});

test('DSH\'s own default-workspace toast is hidden on plugin pages; other toasts and plugin alerts stay',()=>{
 const node=(text,{style='--dsh-toast-hold:3000ms',role='alert'}={})=>({nodeType:1,textContent:text,style:{set:null,setProperty(k,v){this.set=k+':'+v;}},getAttribute:name=>name==='role'?role:name==='style'?style:null});
 const nag=node(DSH_WORKSPACE_NAG[0]),other=node('会话 ID 已复制'),plugin=node(DSH_WORKSPACE_NAG[1],{style:''}),later=node(' '+DSH_WORKSPACE_NAG[1]+' ');
 let observe;const body={children:[nag,other,plugin]},window={};
 new Function('document','window','MutationObserver',DSH_NAG_GUARD)({body},window,class{constructor(fn){observe=fn;}observe(){}});
 assert.equal(nag.style.set,'display:none');assert.equal(other.style.set,null);assert.equal(plugin.style.set,null,'not a DSH toast');
 observe([{addedNodes:[later]}]);assert.equal(later.style.set,'display:none');
 // installed once per document
 const before=observe;new Function('document','window','MutationObserver',DSH_NAG_GUARD)({body},window,class{constructor(fn){observe=fn;}observe(){}});assert.equal(observe,before);
});

test('DSH\'s first-run preview notice is answered for the community page only',async()=>{
 const backend=await read('src/dsh-platform/backend.mjs');
 assert.match(backend,/dshUiBootstrap\(\{stateDir,workClientMode,profileId\}\)/);
 const {dshUiBootstrap}=await import('../src/dsh-platform/ui-bootstrap.mjs');
 assert.match(dshUiBootstrap({stateDir:'E:/fixture',workClientMode:false,profileId:'buddy-community-v1'}),/welcomeNoticeVersion: "2026-09-28\.1"/);
 for(const options of [{workClientMode:true,profileId:'buddy-community-v1'},{workClientMode:false,profileId:'other'},{workClientMode:true,profileId:'buddy-work-ui'}])assert.doesNotMatch(dshUiBootstrap({stateDir:'E:/fixture',...options}),/welcomeNoticeVersion/);
 // the same version DSH writes itself, which the host UI policy also lets the user write
 assert.match(await read('src/dsh-platform/native-bridge-host.mjs'),/op\.value==='2026-09-28\.1'/);
});

test('甲7 / B7: the scan starts when the dialog opens, the code shows its expiry, error codes go to the details',()=>{
 for(const phase of ['not-connected','connected','failed','cancelled','needs-login'])assert.equal(loginAutoStarts(phase),true,phase);
 for(const phase of ['preparing','waiting-qr','waiting-confirmation','verifying','cleaning-up'])assert.equal(loginAutoStarts(phase),false,phase);
 assert.equal(qrSecondsLeft(1000,1000),QR_LIFETIME_MS/1000);assert.equal(qrSecondsLeft(0,20001),100);assert.equal(qrSecondsLeft(0,QR_LIFETIME_MS+5),0);assert.equal(qrSecondsLeft(null),null);
 assert.equal(qrExpiryText(100,true),'Expires in 1:40');assert.equal(qrExpiryText(100,false),'1 分 40 秒后过期');assert.equal(qrExpiryText(9,false),'9 秒后过期');assert.match(qrExpiryText(0,true),/expired/);
 const login=state=>({snapshot:{states:[state]},stateOf:()=>state,busy:false,error:'',errorCode:'',act(){},component:null});
 setLocale('en');
 const qr=renderToStaticMarkup(React.createElement(SocialLoginDialog,{platform:'qq',login:login({platform:'qq',phase:'waiting-qr',qr:'data:image/png;base64,AAAA'}),onClose(){}}));
 assert.match(qr,/data-qr-expiry="120"/);assert.match(qr,/Expires in 2:00/);
 const prep=renderToStaticMarkup(React.createElement(SocialLoginDialog,{platform:'qq',login:{...login({platform:'qq',phase:'preparing'}),error:'Could not complete the action. Please try again.',errorCode:'QQ_COMPONENT_FAILED'},onClose(){}}));
 assert.match(prep,/Scanning does not send messages/,'the safety line shows from the first step');assert.match(prep,/<summary>Technical details<\/summary><code>QQ_COMPONENT_FAILED<\/code>/);assert.doesNotMatch(prep,/Error code: QQ/);
 setLocale('zh-CN');
});

test('甲7 / C-4: a plugin page\'s scan request is shown over the current page once, then never again',async()=>{
 const platform=await read('src/plugin-platform.mjs'),main=await read('src/main.mjs'),preload=await read('src/preload.mjs'),dashboard=await read('src/dashboard.mjs'),accounts=await read('src/social-accounts-ui.mjs');
 assert.match(platform,/if\(action==='open'\)\{loginRequest=\{platform:platformName,requestId:randomUUID\(\),at:Date\.now\(\)\};[^\n]*openSocialSetup\(\{platform:platformName,requestId:loginRequest\.requestId,at:loginRequest\.at\}\)/);
 assert.match(platform,/Date\.now\(\)-loginRequest\.at<120000/);assert.match(platform,/operation==='social-login-ack'\)\{[^\n]*if\(loginRequest\?\.requestId===request\.requestId\)loginRequest=null;/);
 assert.doesNotMatch(platform,/socialLogin\.request\(/);
 assert.match(main,/openSocialSetup:request=>openSocialLogin\(request\),/);
 assert.match(main,/function openSocialLogin\(\{platform,requestId,at\}=\{\}\)\{if\(!panel\|\|panel\.isDestroyed\(\)\)\{openPanel\('plugins'\);return;\}if\(!panel\.webContents\.isLoading\(\)\)panel\.webContents\.send\('plugins:social-login',\{platform,requestId,at\}\);if\(panel\.isMinimized\(\)\)panel\.restore\(\);panel\.show\(\);panel\.focus\(\);\}/);
 assert.match(preload,/onSocialLogin:callback=>\{const listener=\(_,value\)=>callback\(value\);ipcRenderer\.on\('plugins:social-login',listener\)/);
 assert.match(dashboard,/createSocialLoginRequests/);assert.match(dashboard,/ack:requestId=>api\.action\(\{action:'social-login-ack',requestId\}\)/);assert.match(dashboard,/key:loginFor\.requestId/);assert.match(dashboard,/loginFor&&h\(SocialLoginRequest,/);
 assert.match(dashboard,/if\(pulled&&page==='plugins'\)setCommunityIntent\(\{tab:'accounts'/);
 // 「去设置」 returns to the plugin's page and loads it again
 assert.match(dashboard,/setPage\(EMBED_TARGETS\[target\]\.page\);setChosen\(null\);void window\.whale\.plugins\.embed\(\{op:'reload',target\}\)/);
 // the 账号连接 tab no longer re-opens a request on every visit
 assert.doesNotMatch(accounts,/login\.requested/);
 // a login started from the main window's dialog does not open a second dialog from this tab
 assert.match(accounts,/if\(!dialog&&!globalThis\.document\?\.querySelector\?\.\('dialog\[data-social-login\]\[open\]'\)\)for/);
});

test('B7: account cards say which plugin uses the account and how the last check went',()=>{
 const account={pluginId:'@ai-buddy/qq-connect',enabled:true,ref:'r'},at=new Date();at.setHours(19,30,0,0);
 assert.equal(accountUsage(account,{enabled:true},{at:at.getTime(),ok:true},false),'QQ连接正在使用 · 上次检查 19:30 通过');
 assert.equal(accountUsage(account,{enabled:true},{at:at.getTime(),ok:true},true),'In use by QQ Connect · checked 19:30');
 assert.equal(accountUsage(account,{enabled:false},null,false),'QQ连接已停用，暂时不用 · 还没检查过');
 assert.equal(accountUsage({...account,pluginId:'@ai-buddy/bilibili-companion'},null,{at:at.getTime(),ok:false},true),'Bilibili Companion is not installed · check failed at 19:30');
 assert.match(accountUsage({...account,enabled:false},{enabled:true},null,false),/^这个连接已停用/);
});

test('G1: the 插件 group comes from installed plugins with a page, Bilibili and QQ first',()=>{
 const rows=pluginPageEntries([{packageName:'@x/zz',packageKey:'dsh:s:@x/zz',enabled:true,declaredCapabilities:['ui.registerPage']},{packageName:'@x/aa',packageKey:'dsh:s:@x/aa',enabled:true,declaredCapabilities:['ui.registerPage']},{packageName:'@x/no-page',enabled:true,declaredCapabilities:[]},{packageName:'@ai-buddy/qq-connect',enabled:true},{packageName:'@ai-buddy/bilibili-companion',enabled:true},{packageName:'@ai-buddy/work-collaboration',enabled:true,declaredCapabilities:['ui.registerPage']},{packageName:'@x/off',enabled:false,declaredCapabilities:['ui.registerPage']},{packageName:'@x/legacy',backend:'legacy',enabled:true,declaredCapabilities:['ui.registerPage']}]);
 assert.deepEqual(rows.map(([id,icon])=>id+' '+icon),['plugin-bilibili tv','plugin-qq chats','ext:dsh:s:@x/aa nav-plugins','ext:dsh:s:@x/zz nav-plugins']);
 assert.deepEqual(pluginPageEntries([{packageName:'@ai-buddy/qq-connect',enabled:true}]).map(row=>row[0]),[EMBED_TARGETS.qq.page]);
});

test('A1 / A2 / G1: short English sidebar names, one name for Extensions, footer full text on hover',async()=>{
 const dashboard=await read('src/dashboard.mjs'),en=JSON.parse(await read('src/locales/en.json'));
 for(const pair of ["nav('商店与背包','Shop & backpack')","nav('动作展示','Actions')","nav('扩展中心','Extensions')","nav('API 配置','API')","nav('Token 检测','Token check')","nav('通用设置','Settings')","nav('插件','Plugins')"])assert.ok(dashboard.includes(pair),pair);
 assert.equal(en['扩展中心'],'Extensions');assert.ok(!Object.values(en).some(value=>/Extension center/i.test(value)));
 assert.match(dashboard,/title:line\+'\\n'\+sub,onClick/);assert.match(dashboard,/className:'side-status-row',key,title:label\+' · '\+value/);
 assert.match(dashboard,/pluginPageEntries\(pluginRecords,pluginDisplayName\)/);assert.match(dashboard,/if\(id\.startsWith\('ext:'\)\)/);
 // A2: social rows say connection and activity, not only whether the runtime loaded
 assert.match(dashboard,/pluginStatusRow\(record,\{accounts,activity,work:status\.work\}\)/);assert.match(dashboard,/action:'social-accounts-list'/);
 for(const key of ['已连接 · 只回复允许的人','已连接 · 还没完成设置','还没连接账号','已连接 · 可以发评论','不用账号 · 只看不评论','加载中','没有进行中的任务','最近：{title}','在扩展中心看设置和权限','技术详情：错误代码和日志位置','错误代码：{code}','日志：{path}','这一页出错了，没能显示'])assert.ok(en[key],key);
});

test('G2: 「在扩展中心看设置和权限」 brings that plugin\'s own row into view',async()=>{
 const page=await read('src/plugin-embed-page.mjs');assert.match(page,/onCommunity\?\.\(\{tab:'installed',packageName:EMBED_TARGETS\[target\]\.packageName\}\)/);
 const attrs={},row={dataset:{dshRecord:'dsh:official:@ai-buddy/qq-connect'},scrollIntoView(){this.scrolled=true;},focus(){this.focused=true;},hasAttribute:name=>Object.hasOwn(attrs,name),setAttribute(name,value){attrs[name]=value;},removeAttribute(name){delete attrs[name];}};
 const root={querySelectorAll:()=>[{dataset:{dshRecord:'dsh:official:@ai-buddy/bilibili-companion'}},row]};
 assert.equal(revealInstalledRecord('@ai-buddy/qq-connect',root),true);assert.ok(row.scrolled&&row.focused);assert.equal(attrs['data-reveal'],'');assert.equal(attrs.tabindex,'-1');
 assert.equal(revealInstalledRecord('@x/none',root),false);
});

test('G5: the not-loading screen has Retry, its own window, and the error code with the log location',()=>{
 setLocale('zh-CN');
 const html=renderToStaticMarkup(React.createElement(EmbedArea,{target:'bilibili',record:{enabled:true,exactVersion:'2.0.1',packageKey:'k'},view:'err',state:{kind:'community',state:'err',code:'PLUGIN_EMBED_PANEL_TIMEOUT',target:'bilibili'},logPath:'D:\\AI Buddy\\data\\runtime-audit.jsonl'}));
 assert.match(html,/插件页打不开/);assert.match(html,/重试/);assert.match(html,/在单独窗口打开/);
 assert.match(html,/<summary>技术详情：错误代码和日志位置<\/summary><code>错误代码：PLUGIN_EMBED_PANEL_TIMEOUT<\/code><code>日志：D:\\AI Buddy\\data\\runtime-audit\.jsonl<\/code>/);
});

test('one page that throws shows an error card with Retry; the window and other pages stay',()=>{
 const boundary=new PageBoundary({page:'r95-inventory',children:'page'});
 assert.deepEqual(PageBoundary.getDerivedStateFromError(Error('Invalid time zone specified: local')),{error:Error('Invalid time zone specified: local')});
 boundary.state={...boundary.state,...PageBoundary.getDerivedStateFromError(Error('Invalid time zone specified: local'))};
 const html=renderToStaticMarkup(boundary.render());assert.match(html,/role="alert"/);assert.match(html,/重试/);assert.match(html,/Invalid time zone specified: local/);
 // a different page starts clean; the same page keeps the card until Retry
 assert.deepEqual(PageBoundary.getDerivedStateFromProps({page:'overview'},{error:Error('x'),page:'r95-inventory'}),{error:null,page:'overview'});
 assert.equal(PageBoundary.getDerivedStateFromProps({page:'r95-inventory'},{error:Error('x'),page:'r95-inventory'}),null);
 assert.equal(new PageBoundary({page:'a',children:'ok'}).render(),'ok');
 assert.match(renderToStaticMarkup(React.createElement(PageErrorCard,{error:'boom',onRetry(){}})),/boom/);
});
