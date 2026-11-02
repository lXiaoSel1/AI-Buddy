import {createHash} from 'node:crypto';
import {applyPluginPageAppearance} from '../plugin-page-appearance.mjs';
import {panelScript,PANEL_CHECK,PANEL_PLUGIN} from '../plugin-embed-targets.mjs';
import {safeSearchUrl} from '../native-search.mjs';

const fail=(message,code='DSH_CLIENT_DENIED')=>Object.assign(Error(message),{code});
export function trustedDshLocation(value,expectedOrigin){
  let url,origin;
  const literal=value=>typeof value==='string'&&/^http:\/\/127\.0\.0\.1:[0-9]{1,5}(?:[/?#]|$)/.test(value);
  if(!literal(value)||!literal(expectedOrigin))throw fail('Native client requires a literal loopback address');
  try{url=new URL(value);origin=new URL(expectedOrigin);}catch{throw fail('Invalid native client address');}
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||!origin.port||Number(origin.port)<1||origin.pathname!=='/'||origin.search||origin.hash||url.origin!==origin.origin||url.username||url.password)throw fail('Native client must use its authenticated managed loopback origin');
  return url;
}
/** C-5: a plugin page's new-window link goes to the system browser only for a public http(s) address with no
 * credentials, private or loopback host, or secret-looking query; everything else is denied. */
export function publicLinkUrl(value){const checked=safeSearchUrl(value);if(!checked)return null;try{const url=new URL(checked);url.hash=new URL(value).hash;return url.href;}catch{return null;}}
// Page throttling and a shared rolling budget both apply to community and work pages.
export const LINK_INTERVAL_MS=1000,LINK_BUDGET_LIMIT=10,LINK_BUDGET_MS=60000;
export function createExternalLinkBudget({limit=LINK_BUDGET_LIMIT,windowMs=LINK_BUDGET_MS,now=()=>performance.now()}={}){
  const stamps=[];let warned=false;
  return {limit,windowMs,take(){const at=now();while(stamps.length&&stamps[0]<=at-windowMs)stamps.shift();if(stamps.length>=limit){const audit=!warned;warned=true;return {allowed:false,audit};}warned=false;stamps.push(at);return {allowed:true,audit:false};}};
}
const sharedLinkBudget=createExternalLinkBudget();
/** Every link a plugin page asks to open in a new window: never a new Electron window. */
export function pluginWindowOpenHandler({openExternal,isClosed=()=>false,now=Date.now,budget=sharedLinkBudget,audit=()=>{}}){
  let last=-Infinity;
  return details=>{const url=publicLinkUrl(details?.url);if(url&&!details.postBody&&!isClosed()){const at=now();if(at-last>=LINK_INTERVAL_MS){const allowed=budget.take();if(!allowed.allowed){if(allowed.audit)try{audit({type:'plugin-external-link-denied',code:'PLUGIN_EXTERNAL_LINK_RATE_LIMIT',limit:budget.limit,windowMs:budget.windowMs});}catch{}return {action:'deny'};}last=at;void Promise.resolve().then(()=>{if(!isClosed())return openExternal(url);}).catch(()=>{});}}return {action:'deny'};};
}
// Only fixed events and a bounded activity identity cross into plugin pages.
export const PAGE_EVENTS=Object.freeze(['ai-buddy:social-accounts-changed','ai-buddy:bili-reading-open']);
export const pageEventScript=(name,detail)=>{if(!PAGE_EVENTS.includes(name))throw TypeError('Unknown page event');if(name==='ai-buddy:bili-reading-open'){if(!detail||typeof detail.activityId!=='string'||! /^[a-zA-Z0-9:_-]{1,160}$/.test(detail.activityId))throw TypeError('Invalid reading identity');return `document.documentElement.dataset.buddyReadingActivity=${JSON.stringify(detail.activityId)};window.dispatchEvent(new CustomEvent(${JSON.stringify(name)},{detail:${JSON.stringify({activityId:detail.activityId})}}))`;}if(detail!==undefined)throw TypeError('Unexpected event payload');return `window.dispatchEvent(new CustomEvent(${JSON.stringify(name)}))`;};

/** Only the main process sees the launch token. Native pages receive no Buddy preload.
 * open(descriptor,{surface}) shows the page in a host-supplied surface (an embedded view in the main window,
 * see plugin-embed.mjs) instead of its own window. Partition, permission, navigation and download rules are
 * the same for both; a runtime has one page at a time, so switching surface closes the other one first.
 * open(descriptor,{panel}) names the plugin a separate window shows: after every load the window is asked to
 * switch to that plugin's panel (the shared community page opens on DSH's own one). */
export function createDshClientHost({BrowserWindow,session,openExternal=async()=>{},audit=()=>{},onState=()=>{},appearance=()=>null,sleep=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.();}),panelPollMs=500,panelRounds=40,now=Date.now}){
  if(typeof BrowserWindow!=='function'||!session?.fromPartition)throw TypeError('Electron client host dependencies are required');
  const windows=new Map(),identities=new Map(),cleanups=new Map(),styles=new Map(),embedded=new WeakSet(),panels=new WeakMap(),choosing=new WeakMap();let closed=false;
  // Each loaded document gets the current theme and language; settings changes re-apply to open pages.
  const queues=new WeakMap(),dress=window=>{const run=(queues.get(window)??Promise.resolve()).then(async()=>{if(window.isDestroyed())return;const key=await applyPluginPageAppearance(window.webContents,appearance({embedded:embedded.has(window)}),styles.get(window)??null);if(!window.isDestroyed())styles.set(window,key);}).catch(()=>{});queues.set(window,run);return run;};
  const publish=(key,state,surface)=>{try{onState({runtimeId:key,state,surface});}catch{}};
  const within=(promise,ms)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(undefined),ms);timer.unref?.();Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);resolve(undefined);});});
  // a separate window: ask for the plugin's panel until it answers (its code may load after the document)
  async function choose(window){
    const pluginId=panels.get(window);if(!pluginId)return;const token={};choosing.set(window,token);
    for(let round=0;round<panelRounds;round++){
      if(closed||window.isDestroyed()||choosing.get(window)!==token)return;
      const value=String(await within(Promise.resolve().then(()=>window.webContents.executeJavaScript(round%5===0?panelScript(pluginId):PANEL_CHECK,false)),3000)??'');
      if(value.split('|')[1]===pluginId)return;
      await sleep(panelPollMs);
    }
  }
  async function open(descriptor,{surface=null,panel=null}={}){
    if(surface!==null&&typeof surface!=='function')throw fail('Native client surface must be host supplied');
    if(panel!==null&&(typeof panel!=='string'||!PANEL_PLUGIN.test(panel)))throw fail('Native client panel must be a plugin package name');
    const mode=surface?'embedded':'window';
    if(closed)throw fail('Native client host is closed','DSH_CLIENT_CLOSED');
    const {runtimeId,profileId,webOrigin,authURL,url}=descriptor??{};
    if(typeof runtimeId!=='string'||!runtimeId||typeof profileId!=='string'||!profileId)throw fail('Native runtime identity missing');
    const target=trustedDshLocation(authURL??url,webOrigin);
    const existing=windows.get(runtimeId);
    if(existing&&!existing.isDestroyed()){const actual=identities.get(runtimeId);if(actual?.profileId!==profileId||actual.origin!==target.origin)throw fail('Runtime identity is already bound to another profile or origin');if(actual.surface===mode){if(mode==='window'&&panel){panels.set(existing,panel);void choose(existing);}existing.show();existing.focus();return {runtimeId,profileId,state:actual.state,surface:mode};}await closeRuntime(runtimeId);if(closed)throw fail('Native client host is closed','DSH_CLIENT_CLOSED');}
    await cleanups.get(runtimeId);if(closed)throw fail('Native client host is closed','DSH_CLIENT_CLOSED');if(windows.has(runtimeId))return open(descriptor,{surface,panel});
    const partition='buddy-dsh-'+createHash('sha256').update([runtimeId,profileId,target.origin].join('\0')).digest('hex').slice(0,24);
    const browserSession=session.fromPartition(partition,{cache:false});
    browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    browserSession.setPermissionCheckHandler?.(()=>false);
    const webPreferences={session:browserSession,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,devTools:false};
    const window=surface?surface({webPreferences}):new BrowserWindow({width:1100,height:780,minWidth:720,minHeight:480,show:false,title:'AI Buddy · DSH',webPreferences});
    if(surface)embedded.add(window);else if(panel)panels.set(window,panel);
    windows.set(runtimeId,window);identities.set(runtimeId,{profileId,origin:target.origin,state:'loading',surface:mode});
    // A native client may keep an optional provider/login resource pending.
    // Its first usable document must not stay hidden until that network ends.
    const reveal=()=>{if(!closed&&!window.isDestroyed()&&windows.get(runtimeId)===window)window.show();};
    window.once?.('ready-to-show',reveal);window.webContents.once('dom-ready',reveal);
    window.webContents.on('dom-ready',()=>{styles.delete(window);void dress(window);});
    // the embedded view is told by plugin-embed.mjs; a separate window by this host, after every document
    if(!surface)window.webContents.on('did-finish-load',()=>{if(!closed&&windows.get(runtimeId)===window)void choose(window);});
    const allowed=address=>{try{trustedDshLocation(address,webOrigin);return true;}catch{return false;}};
    window.webContents.on('will-navigate',(event,address)=>{if(!allowed(address))event.preventDefault();});
    window.webContents.on('will-redirect',(event,address)=>{if(!allowed(address))event.preventDefault();});
    window.webContents.setWindowOpenHandler(pluginWindowOpenHandler({openExternal,audit,isClosed:()=>closed||window.isDestroyed(),now}));
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    const denyDownload=event=>event.preventDefault();browserSession.on?.('will-download',denyDownload);
    window.on('closed',()=>{styles.delete(window);choosing.delete(window);if(windows.get(runtimeId)===window){windows.delete(runtimeId);identities.delete(runtimeId);}browserSession.removeListener?.('will-download',denyDownload);const cleanup=Promise.resolve().then(()=>browserSession.clearStorageData?.()).catch(()=>{});cleanups.set(runtimeId,cleanup);cleanup.then(()=>{if(cleanups.get(runtimeId)===cleanup)cleanups.delete(runtimeId);});publish(runtimeId,'closed',mode);});
    window.webContents.on('render-process-gone',()=>{if(!window.isDestroyed())window.destroy();publish(runtimeId,'client-failed',mode);});
    try{await window.loadURL(target.href);if(closed||window.isDestroyed()||windows.get(runtimeId)!==window)throw fail('Native client closed before loading completed','DSH_CLIENT_CLOSED');identities.get(runtimeId).state='page-loaded';window.show();publish(runtimeId,'page-loaded',mode);return {runtimeId,profileId,state:'page-loaded',surface:mode};}
    catch(error){const stale=windows.get(runtimeId)!==window;if(!window.isDestroyed())window.destroy();if(error.code==='DSH_CLIENT_CLOSED'||stale)throw fail('Native client closed before loading completed','DSH_CLIENT_CLOSED');publish(runtimeId,'client-failed',mode);throw fail('Native client failed to load','DSH_CLIENT_LOAD_FAILED');}
  }
  async function external(descriptor){
    if(closed)throw fail('Native client host is closed','DSH_CLIENT_CLOSED');
    const target=trustedDshLocation(descriptor?.authURL??descriptor?.url,descriptor?.webOrigin);
    // Explicit user action only; never expose this authenticated URL through snapshots.
    await openExternal(target.href);return {runtimeId:descriptor.runtimeId,state:'external-open-requested'};
  }
  async function closeRuntime(runtimeId){const window=windows.get(runtimeId);if(window&&!window.isDestroyed())window.destroy();windows.delete(runtimeId);identities.delete(runtimeId);await cleanups.get(runtimeId);}
  async function close(){if(closed)return;closed=true;for(const id of [...windows.keys()])await closeRuntime(id);}
  async function refreshAppearance(){await Promise.all([...windows.values()].map(window=>dress(window)));}
  // C-4: tell every open page (main window and separate windows) that something it reads has changed
  async function notify(name,detail){const code=pageEventScript(name,detail);await Promise.allSettled([...windows.values()].filter(window=>!window.isDestroyed()).map(window=>within(Promise.resolve().then(()=>window.webContents.executeJavaScript(code,false)),3000)));}
  return {open,external,closeRuntime,close,refreshAppearance,notify,snapshot:()=>[...windows.keys()].map(runtimeId=>({runtimeId,profileId:identities.get(runtimeId)?.profileId,state:identities.get(runtimeId)?.state??'loading',surface:identities.get(runtimeId)?.surface??'window'}))};
}
