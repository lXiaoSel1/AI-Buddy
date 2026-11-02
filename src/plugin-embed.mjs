// Plugin pages inside the main window (approved design G). DSH still serves each page; the main window shows it
// in a WebContentsView placed over a placeholder the renderer reports. The page keeps the exact security of its
// own-window form because the plugin hosts (client-host.mjs, work-client-host.mjs) build it: separate partition,
// all permissions denied, navigation/new-window/download blocked, no Buddy preload (work: only its scoped one).
// This module owns only where and when the view shows. Bilibili and QQ share one DSH page ("community"), so the
// host asks the page to switch panel and waits for the plugin's data-buddy-panel answer before revealing it.
import {EventEmitter} from 'node:events';
import {EMBED_TARGETS,embedCapable,embedTargetFor,panelScript,PANEL_CHECK} from './plugin-embed-targets.mjs';

export const EMBED_CHANNEL='plugins:embed';
export const EMBED_EVENT='plugins:embed-state';
export {EMBED_TARGETS,embedCapable,embedTargetFor};
const KINDS=['community','work'],OPS=new Set(['open','slot','capture','cover','popout','dock','reload','state']);
const fail=(message,code='PLUGIN_EMBED_DENIED')=>Object.assign(Error(message),{code});
/** A placeholder rect in window content coordinates (the panel's page zoom is locked to 1). */
export function validEmbedRect(rect,bounds){
  if(rect===null)return null;
  if(!rect||typeof rect!=='object'||Object.keys(rect).some(key=>!['x','y','width','height'].includes(key)))throw fail('Embed area shape is invalid');
  const out={};for(const key of ['x','y','width','height']){const value=rect[key];if(typeof value!=='number'||!Number.isFinite(value))throw fail('Embed area must use finite numbers');out[key]=Math.round(value);}
  if(out.x<0||out.y<0||out.width<1||out.height<1||out.x+out.width>bounds.width+1||out.y+out.height>bounds.height+1)throw fail('Embed area is outside the window');
  return out;
}
export function validEmbedRequest(request){
  if(!request||typeof request!=='object'||Array.isArray(request))throw fail('Embed request shape is invalid');
  if(Object.keys(request).some(key=>!['op','target','rect','covered'].includes(key)))throw fail('Embed request has unknown fields');
  if(!OPS.has(request.op))throw fail('Unsupported embed operation');
  if(!['capture','cover','state'].includes(request.op)&&!Object.hasOwn(EMBED_TARGETS,request.target))throw fail('Unknown embed target');
  if(request.op==='cover'&&typeof request.covered!=='boolean')throw fail('Cover needs an explicit state');
  return request;
}
// Answers "<data-buddy-embedded>|<data-buddy-panel>": dressed for the main window, and which plugin is showing.
const PANEL_SCRIPT=panelScript;

/**
 * open(target, surface) / openWindow(target): host callbacks that ask the plugin hosts to show the page in the
 * given surface or in its own window. getPanel() returns the main window. onState(value) publishes to the renderer.
 */
export function createPluginEmbed({WebContentsView,getPanel,open,openWindow,admit=()=>{},onState=()=>{},backgroundColor=()=>null,firstLoadTimeoutMs=20000,openTimeoutMs=180000,markTimeoutMs=3000,callTimeoutMs=3000,pollMs=150,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>Date.now()}={}){
  if(typeof WebContentsView!=='function'||typeof getPanel!=='function'||typeof open!=='function'||typeof openWindow!=='function'||typeof admit!=='function')throw TypeError('Plugin embed host dependencies are required');
  // token: one readiness check at a time; epoch: one open at a time (release() moves both on, so late results are dropped);
  // quiet: the host's reports about a page this module is closing on purpose are not failures.
  const slots=Object.fromEntries(KINDS.map(kind=>[kind,{kind,target:null,state:'idle',code:null,surface:null,view:null,loaded:false,ready:false,rect:null,showing:null,visible:false,token:0,epoch:0,intent:0,admitting:false,quiet:0,opening:null,openingWindow:false,reloadedFor:null,pending:false}]));
  let covered=false,closed=false;
  const panelOf=()=>{const panel=getPanel();return panel&&!panel.isDestroyed?.()?panel:null;};
  const panelShown=()=>{const panel=panelOf();return !!panel&&panel.isVisible?.()!==false&&panel.isMinimized?.()!==true;};
  const describe=slot=>({kind:slot.kind,target:slot.target,state:slot.state,code:slot.code,visible:slot.visible});
  const publish=slot=>{try{onState(describe(slot));}catch{}};
  const setState=(slot,state,code=null)=>{if(slot.state===state&&slot.code===code)return;slot.state=state;slot.code=code;publish(slot);};
  const codeOf=error=>typeof error?.code==='string'?error.code.slice(0,80):'PLUGIN_EMBED_FAILED';
  // a page that is busy or hung must not hold the check (or the user) forever
  const within=(promise,ms)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(undefined),ms);timer.unref?.();Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);resolve(undefined);});});
  const later=(ms,fn)=>{const timer=setTimeout(fn,ms);timer.unref?.();};
  const deadline=(promise,ms)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(fail('The plugin page did not open in time','PLUGIN_EMBED_OPEN_TIMEOUT')),ms);timer.unref?.();promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  // stop whatever open or check is running for this slot; its late results are dropped
  const cancel=slot=>{slot.token++;slot.epoch++;slot.intent++;slot.admitting=false;slot.opening=null;};
  const retire=(slot,surface,how='destroy')=>{if(!surface||surface.isDestroyed())return;slot.quiet++;try{surface[how]();}finally{slot.quiet--;}};
  function apply(){
    const shown=panelShown();
    for(const slot of Object.values(slots)){
      if(!slot.view)continue;
      const visible=shown&&!covered&&slot.state==='run'&&slot.loaded&&slot.ready&&!!slot.rect&&slot.showing===slot.target;
      try{if(visible)slot.view.setBounds(slot.rect);slot.view.setVisible(visible);}catch{}
      if(slot.visible!==visible){slot.visible=visible;publish(slot);}
    }
  }
  function surfaceFor(slot,epoch,made){
    return ({webPreferences})=>{
      if(closed||slot.epoch!==epoch)throw fail('The page was given back before it opened','PLUGIN_EMBED_CANCELLED');
      const panel=panelOf();if(!panel?.contentView)throw fail('The main window is not open','PLUGIN_EMBED_NO_WINDOW');
      retire(slot,slot.surface);
      const view=new WebContentsView({webPreferences}),events=new EventEmitter();let dead=false;
      const color=backgroundColor();if(color)try{view.setBackgroundColor(color);}catch{}
      view.setVisible(false);panel.contentView.addChildView(view);
      const surface={
        webContents:view.webContents,
        getParentWindow:()=>!dead&&slot.surface===surface?panelOf():null,
        on(name,listener){events.on(name,listener);return surface;},once(name,listener){events.once(name,listener);return surface;},removeListener(name,listener){events.removeListener(name,listener);return surface;},
        // The hosts call show() once the document is usable; whether it is on screen is decided here.
        show(){if(dead||slot.surface!==surface)return;slot.loaded=true;if(slot.kind==='work'&&!slot.ready)void settle(slot);apply();},
        focus(){if(!dead&&slot.visible)try{view.webContents.focus();}catch{}},
        isDestroyed:()=>dead||view.webContents.isDestroyed?.()===true,
        // Work approvals need a page the user can see and act on: shown here, window up and focused, page focused.
        isVisible:()=>!dead&&slot.surface===surface&&slot.visible,
        isMinimized:()=>panelOf()?.isMinimized?.()===true,
        isFocused:()=>!dead&&panelOf()?.isFocused?.()===true&&view.webContents.isFocused?.()===true,
        loadURL:address=>view.webContents.loadURL(address),
        close(){if(dead)return;const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};events.emit('close',event);if(!event.defaultPrevented)surface.destroy();},
        destroy(){
          if(dead)return;dead=true;
          try{panelOf()?.contentView?.removeChildView(view);}catch{}
          try{if(view.webContents.isDestroyed?.()!==true)view.webContents.close?.();}catch{}
          if(slot.surface===surface){const was=slot.visible;slot.surface=null;slot.view=null;slot.loaded=false;slot.ready=false;slot.visible=false;slot.token++;if(was)publish(slot);}
          events.emit('closed');
        },
      };
      view.webContents.once?.('destroyed',()=>surface.destroy());
      // every document of the shared community page must be told which plugin to show
      if(slot.kind==='community')view.webContents.on('did-finish-load',()=>{if(slot.surface===surface&&slot.target)void settle(slot);});
      slot.surface=surface;slot.view=view;slot.loaded=false;slot.ready=false;made?.(surface);
      return surface;
    };
  }
  /**
   * Hide the page until it is dressed for the main window (data-buddy-embedded) and, for the shared community page,
   * until the requested plugin says its panel is showing (data-buddy-panel). DSH's own conversation panel, its frame
   * or the previous plugin never show under this plugin's bar.
   */
  async function settle(slot){
    const surface=slot.surface,target=slot.target;if(!surface||!target||slot.state==='popped'||slot.admitting)return;
    const token=++slot.token,pluginId=EMBED_TARGETS[target].packageName,community=slot.kind==='community',deadline=now()+(community?firstLoadTimeoutMs:markTimeoutMs);
    slot.ready=false;setState(slot,'start');apply();
    for(let round=0;;round++){
      if(slot.token!==token||slot.surface!==surface||surface.isDestroyed())return;
      const value=String(await within(Promise.resolve().then(()=>surface.webContents.executeJavaScript(community&&round%10===0?PANEL_SCRIPT(pluginId):PANEL_CHECK,false)),callTimeoutMs)??'');
      if(slot.token!==token||slot.surface!==surface||slot.state==='popped')return;
      const [mark,panel]=value.split('|');
      if(mark==='1'&&(!community||panel===pluginId)){slot.reloadedFor=null;slot.ready=true;setState(slot,'run');apply();return;}
      if(now()>deadline){
        // the work page is usable even if its dress never arrived
        if(!community){slot.ready=true;setState(slot,'run');apply();return;}
        // the plugin's code may not be in this document (enabled after it loaded): load it once more
        if(slot.reloadedFor!==target){slot.reloadedFor=target;const watch=++slot.token;try{surface.webContents.reload();}catch{}later(firstLoadTimeoutMs,()=>{if(slot.token===watch&&slot.surface===surface){setState(slot,'err','PLUGIN_EMBED_PAGE_TIMEOUT');apply();}});return;}
        setState(slot,'err','PLUGIN_EMBED_PANEL_TIMEOUT');apply();return;
      }
      await sleep(pollMs);
    }
  }
  async function start(slot,target,{window=false}={}){
    if(closed)return;
    if(slot.admitting)cancel(slot);
    // the same kind of open already running: join it; the other kind: cancel it rather than wait behind it
    if(slot.opening){if(slot.openingWindow===window)return slot.opening;cancel(slot);}
    const epoch=slot.epoch;let mine=null;
    slot.pending=false;slot.reloadedFor=null;setState(slot,window?'popped':'start');apply();
    const run=(async()=>{
      try{
        // a fresh page every time: retry and reload must not reuse a page that may point at a stopped backend
        slot.token++;retire(slot,slot.surface);
        if(window){await deadline(openWindow(target),openTimeoutMs);return;}
        const result=await deadline(open(target,surfaceFor(slot,epoch,surface=>{mine=surface;})),openTimeoutMs);
        if(slot.epoch!==epoch){retire(slot,mine);return;}
        apply();return result;
      }catch(error){
        if(slot.epoch!==epoch||closed)return;
        // a timed-out open keeps running in the host; cancel it so its late page can't replace or close another one
        if(codeOf(error)==='PLUGIN_EMBED_OPEN_TIMEOUT')cancel(slot);
        retire(slot,mine);
        // disabled or too old for the main window: the page's own screen (G5) says so, not an error
        const code=codeOf(error);setState(slot,['PLUGIN_EMBED_NOT_ENABLED','PLUGIN_EMBED_UNSUPPORTED'].includes(code)?'idle':'err',['PLUGIN_EMBED_NOT_ENABLED','PLUGIN_EMBED_UNSUPPORTED'].includes(code)?null:code);apply();
      }
    })();
    slot.opening=run;slot.openingWindow=window;
    try{return await run;}finally{if(slot.opening===run)slot.opening=null;}
  }
  async function openTarget(slot,target){
    const changed=slot.target!==target;slot.target=target;
    if(slot.state==='popped')return describe(slot);
    if(slot.kind==='community'){
      const epoch=slot.epoch,intent=++slot.intent,surface=slot.surface,current=()=>!closed&&slot.epoch===epoch&&slot.intent===intent&&slot.target===target;
      slot.admitting=true;slot.token++;slot.ready=false;setState(slot,'start');apply();
      try{await deadline(Promise.resolve().then(()=>admit(target)),openTimeoutMs);}catch(error){if(!current())return describe(slot);cancel(slot);retire(slot,slot.surface);const code=codeOf(error),idle=['PLUGIN_EMBED_NOT_ENABLED','PLUGIN_EMBED_UNSUPPORTED'].includes(code);setState(slot,idle?'idle':'err',idle?null:code);apply();return describe(slot);}
      if(!current())return describe(slot);slot.admitting=false;
      if(slot.state==='popped'||surface&&(slot.surface!==surface||surface.isDestroyed()))return describe(slot);
    }
    if(slot.surface&&!slot.surface.isDestroyed()){if(slot.kind==='community'&&(changed||!slot.ready)&&slot.loaded)void settle(slot);apply();return describe(slot);}
    await start(slot,target);return describe(slot);
  }
  async function handle(request){
    if(closed)throw fail('Plugin embedding has stopped','PLUGIN_EMBED_CLOSED');
    const {op,target,rect,covered:cover}=validEmbedRequest(request),slot=target?slots[EMBED_TARGETS[target].kind]:null;
    if(op==='state')return KINDS.map(kind=>describe(slots[kind]));
    // nothing starts behind a hidden window (release() gave the pages back); resume() picks it up when shown
    if(op==='open'){if(!panelShown()){if(slot.target!==target&&slot.surface)slot.ready=false;slot.target=target;slot.pending=true;return describe(slot);}return openTarget(slot,target);}
    if(op==='slot'){
      const panel=panelOf();if(!panel)return describe(slot);
      const [width,height]=panel.getContentSize?.()??[Infinity,Infinity];
      const value=validEmbedRect(rect??null,{width,height});
      if(value){slot.rect=value;slot.showing=target;}else if(slot.showing===target)slot.showing=null;
      apply();return describe(slot);
    }
    if(op==='capture'){
      // only the page on screen is captured; the picture goes straight back to the main window and is not kept
      const live=Object.values(slots).find(value=>value.visible&&value.view);if(!live)return {image:null};
      try{const image=await within(live.view.webContents.capturePage(),callTimeoutMs);if(!image||image.isEmpty?.())return {image:null};return {image:'data:image/jpeg;base64,'+image.toJPEG(85).toString('base64'),rect:live.rect};}catch{return {image:null};}
    }
    if(op==='cover'){covered=cover;apply();return {covered};}
    if(op==='popout'){slot.target=target;await start(slot,target,{window:true});return describe(slot);}
    if(op==='dock'||op==='reload'){slot.target=target;await start(slot,target);return describe(slot);}
  }
  /** The plugin hosts report their own pages: a separate window opening or closing, a page failing or closing by itself. */
  function hostState({kind,state,surface}){
    const slot=slots[kind];if(!slot||slot.quiet)return;
    if(surface==='window'){
      if(state==='closed'&&slot.state==='popped'){setState(slot,'idle');apply();}
      // the page moved to its own window some other way (e.g. a 2.0.0 plugin sharing the community page)
      else if(['page-loaded','document-ready'].includes(state)&&slot.state!=='popped'&&!(slot.opening&&!slot.openingWindow)){setState(slot,'popped');apply();}
      return;
    }
    if(['idle','popped'].includes(slot.state))return;
    if(state==='client-failed'){setState(slot,'err','PLUGIN_EMBED_PAGE_GONE');apply();}
    // a page that closes itself is not reopened by itself (no reopen loop); the user can retry
    else if(state==='closed'&&!slot.surface&&['run','start'].includes(slot.state)){setState(slot,'err','PLUGIN_EMBED_PAGE_CLOSED');apply();}
  }
  /** Main window hidden to the tray: give the pages (and an idle work runtime) back; resume() reopens what was showing. */
  function release(){
    for(const slot of Object.values(slots)){
      cancel(slot);slot.pending=false;
      retire(slot,slot.surface,'close');
      if(!slot.surface&&slot.state!=='popped')setState(slot,'idle');
    }
    apply();
  }
  // only opens the page asked for while the window was hidden; a page given back by release() is asked for again by
  // the main window itself when it becomes visible, so a stale placement never starts a page nobody is looking at
  function resume(){if(closed)return;for(const slot of Object.values(slots))if(slot.pending&&slot.target&&slot.state==='idle')void start(slot,slot.target);apply();}
  /** A plugin that is disabled or uninstalled loses its page here; its own screen (G5) takes over. */
  function recordsChanged(installed=[]){
    for(const slot of Object.values(slots)){
      if(!slot.target)continue;const record=installed.find(value=>value?.packageName===EMBED_TARGETS[slot.target].packageName);
      if(record?.enabled===true)continue;
      cancel(slot);retire(slot,slot.surface,'close');
      if(!slot.surface&&slot.state!=='popped')setState(slot,'idle');
    }
    apply();
  }
  function rendererReset(){for(const slot of Object.values(slots))slot.showing=null;covered=false;apply();}
  function close(){if(closed)return;closed=true;for(const slot of Object.values(slots)){cancel(slot);retire(slot,slot.surface);}}
  return {handle,hostState,release,resume,recordsChanged,rendererReset,announce:()=>{for(const kind of KINDS)publish(slots[kind]);},refresh:apply,close,snapshot:()=>KINDS.map(kind=>describe(slots[kind]))};
}
