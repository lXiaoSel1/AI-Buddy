import {createInstalledResources} from './installed-resources.mjs';
import {spawn} from 'node:child_process';
import {setLocale,t,localizedTitle} from './i18n.mjs';
import {chromeColor,resolvedTheme} from './appearance.mjs';
import {CgThemePlanner} from './cg-theme.mjs';
import {createCharacterReferenceResolver} from './cg-reference-registry.mjs';
import {monitorView} from './monitor-view.mjs';
import { app,BrowserWindow,Tray,Menu,ipcMain,nativeImage,screen,session,safeStorage,dialog,powerMonitor } from 'electron';
import {PetActivityClock,PetMotion} from './pet-interactions.mjs';
import {createPetButtonObserver} from './pet-buttons.mjs';
import {PetTouchExpressions} from './pet-touch.mjs';
import {frameSequence,CHARACTER_SEQUENCES} from './frame-sequence.mjs';
import { Worker } from 'node:worker_threads';
import { join,resolve,dirname } from 'node:path';
import { readFileSync,mkdirSync,appendFileSync,writeFileSync,existsSync } from 'node:fs';
import { createSnapshotStorage,readJson } from './storage.mjs';
import { createGalgame } from './galgame-host.mjs';
import { CodexProvider } from './codex-provider.mjs';
import { ModelRouter } from './model-router.mjs';
import {QuotaService} from './quota-service.mjs';
import {CgService} from './cg-service.mjs';
import {CodexImageProvider} from './codex-image-provider.mjs';
import {createCgCodec} from './cg-images.mjs';
import { clampToDisplays } from './window-position.mjs';
import { petBounds,petSize,petWindowOptions,positionPet } from './pet-window.mjs';
import {petCollisionInsets} from './pet-presentation.mjs';
import { createLocalControlServer,requestLocalControl } from './local-control.mjs';
import { DEFAULT_PREFERENCES,normalizePreferences,validatePreferencesPatch } from './preferences.mjs';
import { PET_ACTIONS,PET_INTERACTION_ACTIONS,validatePetPlayback,getPetAction } from './pet-actions.mjs';
import { EMOTIONS,validEmotion,shortReply } from './emotions.mjs';
import {validPetCharacter,resolvePetCharacter} from './pet-characters.mjs';
import {connectionView} from './connection-view.mjs';
import {lockPageZoom} from './page-zoom.mjs';
import {TOOL_NAMES} from './token-sources.mjs';
import {resolveCodexBinary,codexHome} from './runtime-discovery.mjs';
import {APP_NAME,APP_ID,APP_ICON_ICO,APP_ICON_PNG} from './app-brand.mjs';

const build=__dirname;
const appVersion=JSON.parse(readFileSync(join(build,'package.json'),'utf8')).version;
const root=resolve(build,'../..');
app.setName('AI Buddy');
if(process.platform==='win32')app.setAppUserModelId(APP_ID);
const appIconPath=existsSync(join(root,APP_ICON_ICO))?join(root,APP_ICON_ICO):join(build,APP_ICON_ICO);
const appIcon=nativeImage.createFromPath(join(build,APP_ICON_PNG));
if(appIcon.isEmpty())throw Error('AI 酱图标资源缺失');
function brandWindow(window){
  window.setIcon(appIconPath);
  if(process.platform==='win32')window.setAppDetails({appId:APP_ID,appIconPath,appIconIndex:0,relaunchCommand:'"'+join(process.env.SystemRoot??'C:/Windows','System32/wscript.exe')+'" "'+join(root,'AI Buddy.vbs')+'"',relaunchDisplayName:'AI Buddy'});
}
const arg=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const workspaceTitle=()=>localizedTitle()+(arg('candidate')==='1'?(settings.preferences?.language==='en'?' · Feature Preview':' · 八项功能候选'):'');
const previewQuery=arg('rig')==='working'?{query:{workingRig:'1'}}:arg('rig')==='all'?{query:{allActionRigs:'1'}}:arg('rig')==='source'?{query:{sourcePreview:'1'}}:{};
const resources=createInstalledResources({root,build});
const dataRoot=resolve(arg('data') || resources.installation?.dataPath || join(root,'local/data-v003'));
if(!resources.fallback())throw Error('没有完整角色资源，请运行安装器修复 / No complete character resources; run installer repair');
mkdirSync(dataRoot,{recursive:true});
app.setPath('userData',join(dataRoot,'chromium'));
app.setPath('crashDumps',join(dataRoot,'crash-reports'));
if(!app.requestSingleInstanceLock())app.exit(0);
for(const flag of ['disable-background-networking','disable-component-update','disable-domain-reliability','disable-sync'])app.commandLine.appendSwitch(flag);
const auditPath=join(dataRoot,'runtime-audit.jsonl');
const audit=value=>appendFileSync(auditPath,JSON.stringify({timestamp:new Date().toISOString(),...value})+'\n');
const pipe=arg('pipe') || (resources.installation?.pipe?'\\\\.\\pipe\\'+resources.installation.pipe:null) || '\\\\.\\pipe\\whale-companion-v001';
let buttonObserver=null,nativeButtons=0;
let pet,panel,tray,worker,game,provider,snapshot={indexing:true,sessions:[],active:[],todayUsage:{codex:{total:0},claude:{total:0}},workTotal:0},settings={},drag=null,lastWork=null,quitting=false,gestureMode=false,lastPetHit=false,ignoringMouse=true,petAssetsReady=false;
const settingsStore=createSnapshotStorage(join(dataRoot,'settings.json'));
let cg,quotas;
const stateBefore=new Map();const rendererErrors=[];
let feedbackSerial=0;
let reopenRequested=false;
let logRoots=[],settingsTail=Promise.resolve(),monitorAppliedInterval=1000;
let tokenSources=null,sourceRequest=0;const sourceRequests=new Map();
function tokenAction(action,args={}){return new Promise((done,fail)=>{if(!worker)return fail(Error('监控正在启动'));const id=++sourceRequest,timer=setTimeout(()=>{sourceRequests.delete(id);fail(Error('检测尚未完成，请稍后查看'));},120000);sourceRequests.set(id,{done,fail,timer});worker.postMessage({type:'source-action',id,action,args});});}
let petState={id:'idle',source:'monitor',manual:false,expiresAt:null},gameRequests=0;
const activityClock=new PetActivityClock({requireReady:true});let petMotion=null,lastInteraction='',heldFollowCharacter=null,trajectoryWindow=null,trajectoryState=null;
function petInteraction(){const motion=petMotion?.state()??{mode:'rest'},area=petMotion?.area(),body=motion.collisionBounds,grounded=!!(area&&body&&Math.abs(body.y+body.height-area.y-area.height)<2);return {characterId:petState.characterId??effectivePetCharacter(),gestureId:drag?.gestureId??null,...activityClock.tick({defer:!!drag||['flying','charging','landing'].includes(petMotion?.mode)||petState.manual}),motion:{...motion,grounded,elapsedMs:motion.since===undefined?0:performance.now()-motion.since,preview:petMotion?.preview()??[]},at:Date.now()};}
function publishInteraction(force=false){const value=petInteraction(),key=JSON.stringify([value.characterId,value.gestureId,value.phase,value.animationEpoch,value.animationWaiting,value.motion.animationEpoch,value.motion.animationWaiting,value.motion.mode,value.motion.button,value.motion.walkDirection,value.motion.pull,value.motion.anchor,value.motion.grounded]);if(force||key!==lastInteraction){lastInteraction=key;petEvent({kind:'interaction',value});updateTrajectory(value);}return value;}
function updateTrajectory(value){
  trajectoryState=value;
  if(value.motion.mode!=='charging'||!pet?.isVisible()){
    const old=trajectoryWindow;trajectoryWindow=null;old?.destroy();return;
  }
  if(!trajectoryWindow){
    const areas=screen.getAllDisplays().map(d=>d.bounds),x=Math.min(...areas.map(a=>a.x)),y=Math.min(...areas.map(a=>a.y));
    const bounds={x,y,width:Math.max(...areas.map(a=>a.x+a.width))-x,height:Math.max(...areas.map(a=>a.y+a.height))-y};
    const overlay=new BrowserWindow({...bounds,frame:false,transparent:true,show:false,focusable:false,skipTaskbar:true,resizable:false,hasShadow:false,webPreferences:{preload:join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    trajectoryWindow=overlay;overlay.setIgnoreMouseEvents(true,{forward:true});overlay.setAlwaysOnTop(true,'screen-saver');
    overlay.loadFile(join(build,'pet-trajectory.html')).then(()=>{if(trajectoryWindow!==overlay||overlay.isDestroyed())return;overlay.showInactive();updateTrajectory(trajectoryState);}).catch(error=>audit({type:'trajectory-error',message:error.message}));
  }
  if(!trajectoryWindow.isDestroyed()&&!trajectoryWindow.webContents.isLoading())trajectoryWindow.webContents.send('pet:action',{kind:'trajectory',value,origin:trajectoryWindow.getBounds()});
}
function cancelGesture(reason='cancel'){
  const id=drag?.gestureId??null;drag=null;buttonObserver?.stop();petMotion?.cancel();
  petEvent({kind:'gesture-reset',gestureId:id,reason});petEvent({kind:'drag',active:false});
  if(pet&&!pet.isDestroyed())setGestureMode(gestureMode);publishInteraction(true);
}
const gestureMatches=message=>!!drag&&(drag.gestureId===null?message?.gestureId==null:message?.gestureId===drag.gestureId);
const touchExpressions=new PetTouchExpressions();
function petContextMenu(){Menu.buildFromTemplate([{label:settings.preferences.language==='en'?'Open workspace':'打开工作空间',click:()=>openPanel('overview')}]).popup({window:pet});}
// Renderer coordinates are accepted only by explicitly isolated simulation runs.
// Normal operation has one position writer: the main process OS DIP sampler.
const gesturePoint=message=>arg('cursor')==='manual'&&Number.isFinite(message?.x)&&Number.isFinite(message?.y)?{x:message.x,y:message.y}:screen.getCursorScreenPoint();
function internalActivity({id,active}){activityClock.request(id,active);petEvent({kind:'dialog',active:activityClock.busy.size>0||gameRequests>0});publishInteraction();}
function interactionMediaReady(id=petState.characterId??effectivePetCharacter()){return PET_INTERACTION_ACTIONS.every(a=>!!frameSequence(a.id,id)?.video?.src);}
function configurePetInteractions(){const speed=settings.preferences.animationSpeed??.75,media=interactionMediaReady(),character=petState.characterId??effectivePetCharacter();if(drag&&(!settings.preferences.petPhysics||!media)&&['charging','dragging'].includes(petMotion?.mode))cancelGesture('physics-disabled');petMotion?.configure({enabled:settings.preferences.petPhysics&&media,strength:settings.preferences.throwStrength,landDurationMs:getPetAction('land-recover',petState.characterId).cycleMs,speed,collisionInsets:petCollisionInsets(character,settings.preferences.petScale,CHARACTER_SEQUENCES[character])});activityClock.configure({enabled:settings.preferences.autoSleep&&media,durations:{enter:getPetAction('sleep-enter',petState.characterId).cycleMs,wake:getPetAction('wake',petState.characterId).cycleMs},speed});if(!media)activityClock.resume();publishInteraction(true);}
function effectivePetCharacter(){const target=resolvePetCharacter(settings.preferences,themeCharacter);if(!validPetCharacter(themeCharacter)&&settings.preferences?.petCharacterMode!=='fixed')return heldFollowCharacter??petState.characterId??resources.fallback('deepseek');const resolved=resources.fallback(target);if(resolved)heldFollowCharacter=resolved;return resolved;}
const actionIds=new Set([...PET_ACTIONS,...PET_INTERACTION_ACTIONS].map(a=>a.id));
function petEvent(value){if(pet&&!pet.isDestroyed())pet.webContents.send('pet:action',value);}
function playPet(request){const value=validatePetPlayback({...request,characterId:request?.characterId??petState.characterId??resolvePetCharacter(settings.preferences,themeCharacter)});resources.require([value.characterId]);if(PET_INTERACTION_ACTIONS.some(a=>a.id===value.id)&&!frameSequence(value.id,value.characterId)?.video?.src)throw Error('该角色的新互动动作尚未完成审核');petEvent({kind:'play',...value});audit({type:'pet-manual-action',id:value.id,lookIndex:value.lookIndex,characterId:value.characterId});return {ok:true,...value};}
function petAuto(){petEvent({kind:'auto'});return {ok:true};}
function triggerPet(id,source='event',durationMs=null){petEvent({kind:'trigger',id,source,...(durationMs===null?{}:{durationMs})});}
function feedback(value){activityClock.wake('feedback');publishInteraction();if(settings.preferences?.petVisible!==false)petEvent({kind:'feedback',value});}
function chatFeedback(value){if(!game?.hasCharacter?.(value.characterId)||!validEmotion(value.emotion))return;feedback({eventId:value.messageId,id:EMOTIONS[value.emotion]?.actionId??null,source:'dialog',origin:value.requestId?'chat':'story',provider:provider?.currentKind??'codex',sessionKey:'whale-companion-local',turnKey:value.requestId??value.messageId,characterId:value.characterId,role:'heroine',emotion:value.emotion,emotionSource:value.emotionSource??'story-label',sequence:value.sequence,text:shortReply(value.text),cycles:1});}
function chatCommitted(value){if(panel&&!panel.isDestroyed())panel.webContents.send('game:chat-committed',value);chatFeedback(value);}
app.on('second-instance',()=>{audit({type:'second-instance'});reopenRequested=true;if(app.isReady()&&game)openPanel('overview',false);});

function clamp(bounds) {
  if(settings.preferences?.petPhysics&&interactionMediaReady()){
    const character=petState.characterId??effectivePetCharacter(),probe=new PetMotion({bounds,collisionInsets:petCollisionInsets(character,settings.preferences.petScale,CHARACTER_SEQUENCES[character]),displays:()=>screen.getAllDisplays()});probe.contain();
    return {...probe.bounds,x:Math.round(probe.bounds.x),y:Math.round(probe.bounds.y)};
  }
  return clampToDisplays(bounds,screen.getAllDisplays(),screen.getPrimaryDisplay());
}
function setGestureMode(value){gestureMode=!!value;ignoringMouse=settings.preferences?.clickThrough!==false&&!gestureMode&&!lastPetHit;pet?.setIgnoreMouseEvents(ignoringMouse,{forward:true});}
function moveDrag(point){
  if(!drag || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))return;
  petMotion.move(point);drag.moved=petMotion.moved;
  if(drag.moved)petEvent({kind:'drag',active:true,direction:petMotion.walkDirection});publishInteraction();
}
async function saveSettings() {await settingsStore.writeText(JSON.stringify(settings));}
function settingsView(){return {interactionMedia:Object.fromEntries(resources.status().characters.map(c=>[c.id,interactionMediaReady(c.id)])),resources:resources.status(),effectivePetCharacter:effectivePetCharacter(),petResourceNotice:validPetCharacter(themeCharacter)?null:'当前角色没有桌宠资源，保留当前桌宠',preferences:{...settings.preferences},themeCharacter,petCharacterId:petState.characterId??resources.fallback('deepseek'),version:appVersion,build:build.split(/[\\/]/).at(-1),dataRoot,logRoots,tokenSources,defaultModel:provider?.defaultModel,modelConnections:provider?.state?connectionView(provider):null,cgConnections:cg?.state?connectionView(cg):null,systemTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,monitorAppliedInterval};}
function broadcastSettings(){const value=settingsView();for(const win of [pet,panel])if(win&&!win.isDestroyed())win.webContents.send('settings:update',value);return value;}
function saveConnection(service,draft){
  // An unusable edit must not overwrite the currently selected profile before
  // the subsequent activation can reject it. This check performs no request.
  if(draft?.useAfterSave===true&&draft.id===service.state.activeId)service.materialize(service.draftProfile(draft));
  return service.save(draft);
}
function updateTray(){
  if(!tray)return;
  tray.setContextMenu(Menu.buildFromTemplate([{label:t('工作概览'),click:()=>openPanel('overview')},{label:t('通用设置'),click:()=>openPanel('settings')},{label:t('动作展示'),click:()=>openPanel('actions')},{label:settings.preferences.language==='en'?'Open Galgame':'打开 Galgame',click:()=>openPanel('galgame')},{label:t('显示桌宠'),type:'checkbox',checked:settings.preferences.petVisible,click:item=>{void setPreferences({petVisible:item.checked}).catch(e=>audit({type:'settings-error',message:e.message}));}},{label:settings.preferences.language==='en'?'Drag mode (whole pet window)':'拖动模式（整个窗口可拖动）',type:'checkbox',checked:gestureMode,click:item=>{setGestureMode(item.checked);updateTray();}},{type:'separator'},{label:settings.preferences.language==='en'?'Quit':'退出',click:()=>{void shutdown();}}]));
}
function applyPetPreferences(resize=false){
  if(!pet||pet.isDestroyed())return;
  if(resize){
    const size=petSize(settings.preferences.petScale);
    pet.setMinimumSize(1,1);pet.setMaximumSize(10000,10000);
    pet.setMinimumSize(size.width,size.height);pet.setMaximumSize(size.width,size.height);
    settings.petBounds=clamp(petBounds(pet.getContentBounds(),settings.preferences.petScale));
    positionPet(pet,settings.petBounds,settings.preferences.petScale);
    petMotion?.recover(settings.petBounds);
  }
  pet.setAlwaysOnTop(settings.preferences.alwaysOnTop,'floating');
  configurePetInteractions();
  if(settings.preferences.petVisible&&petAssetsReady){const wasVisible=pet.isVisible();pet.showInactive();if(!wasVisible)triggerPet('wave','show');}else{cancelGesture('hidden');petAuto();pet.hide();}
  setGestureMode(gestureMode);updateTray();
}
async function syncPetVisibility(visible){
  if(!settings.preferences)return;
  settings.preferences={...settings.preferences,petVisible:visible};
  applyPetPreferences();await saveSettings();broadcastSettings();
}
function setPreferences(patch){
  let valid;try{valid=validatePreferencesPatch(patch);}catch(error){return Promise.reject(error);}
  const run=settingsTail.then(async()=>{
    const next={...settings.preferences,...valid},resize=next.petScale!==settings.preferences.petScale;
    if(valid.petFixedCharacter)resources.require([valid.petFixedCharacter]);
    if(resize&&drag)throw new Error('请先松开桌宠，再调整大小');
    if(next.petVisible!==settings.preferences.petVisible)await game.action('pet-set',{enabled:next.petVisible});
    const previousPet=effectivePetCharacter();settings.preferences=next;if(effectivePetCharacter()!==previousPet){cancelGesture('character-change');activityClock.resume();}applyChrome();applyPetPreferences(resize);
    worker?.postMessage({type:'configure',refreshIntervalMs:next.monitorRefreshMs,statisticsTimeZone:next.statisticsTimeZone,autoPriceUpdates:next.autoPriceUpdates});
    await saveSettings();audit({type:'settings-changed',keys:Object.keys(valid)});return broadcastSettings();
  });settingsTail=run.catch(()=>{});return run;
}
async function settingsAction(action){
  if(action==='defaults')return setPreferences({...DEFAULT_PREFERENCES});
  if(action==='reset-position'){
    cancelGesture('reset-position');
    const area=screen.getPrimaryDisplay().workArea,size=petSize(settings.preferences.petScale);
    settings.petBounds=clamp(petBounds({x:area.x+area.width-size.width-20,y:area.y+area.height-size.height-20},settings.preferences.petScale));
    positionPet(pet,settings.petBounds,settings.preferences.petScale);petMotion?.recover(settings.petBounds);publishInteraction(true);await saveSettings();audit({type:'pet-position-reset',bounds:settings.petBounds});return broadcastSettings();
  }
  if(action==='refresh'){worker?.postMessage({type:'refresh'});return settingsView();}
  throw new Error('未知设置操作');
}
function applyChrome(character){if(character&&character!==themeCharacter){const previousPet=effectivePetCharacter();themeCharacter=character;if(effectivePetCharacter()!==previousPet)cancelGesture('character-change');if(settings.preferences?.petCharacterMode!=='fixed'){activityClock.resume();publishInteraction(true);}broadcastSettings();}setLocale(settings.preferences?.language);if(panel&&!panel.isDestroyed()){panel.setTitle(workspaceTitle());if(process.platform==='win32')panel.setTitleBarOverlay({color:chromeColor(resolvedTheme(settings.preferences,themeCharacter)),symbolColor:'#e5edf5',height:34});}if(tray){tray.setToolTip(settings.preferences?.language==='en'?'AI Buddy':'AI 酱');updateTray();}}
let themeCharacter=resources.fallback('deepseek');
function openPanel(page='overview',focus=true) {
  if(page==='sessions')page='overview';
  if(!panel || panel.isDestroyed()) {
    panel=new BrowserWindow({width:1180,height:820,minWidth:900,minHeight:650,title:workspaceTitle(),icon:appIconPath,backgroundColor:chromeColor(resolvedTheme(settings.preferences,themeCharacter)),show:false,
      ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#0b1628',symbolColor:'#c8deef',height:34},accentColor:false}:{}),
      webPreferences:{preload:join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'whale-memory'}});
    brandWindow(panel);applyChrome();
    lockPageZoom(panel,error=>audit({type:'zoom-policy-error',message:error.message}));
    panel.setMenuBarVisibility(false);panel.loadFile(join(build,'index.html'),{hash:page,...previewQuery,query:{...previewQuery.query,petCharacter:resources.fallback(resolvePetCharacter(settings.preferences,themeCharacter))}});
    panel.on('close',event=>{if(!quitting){event.preventDefault();petAuto();panel.hide();}});
    panel.once('ready-to-show',()=>focus?panel.show():panel.showInactive());
    panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    panel.webContents.on('console-message',(event,...args)=>{if(event.level==='error'||args[0]===3)rendererErrors.push(event.message || args[1]);});
  } else {panel.webContents.send('panel:page',page);focus?panel.show():panel.showInactive();}
}
function publish(value) {
  if(quitting)return;
  snapshot=value;
  activityClock.observeExternal(value);publishInteraction();
  if(!value.indexing) {
    const work=value.workSinceStart || 0;
    const delta=work-(lastWork || 0);if(delta>0)game?.workTokens(delta);lastWork=Math.max(lastWork || 0,work);
    for(const s of value.sessions) {
      if(s.companion||s.tool==='dsh')continue;
      const old=stateBefore.get(s.key);
      if(old&&old!==s.status&&s.status==='completed'&&s.feedbackEligible!==false){
        feedback({eventId:s.key+':completed:'+ (++feedbackSerial),id:'jump',source:'completed',provider:s.provider,sessionKey:s.key,turnKey:s.turnId,cycles:2,text:(TOOL_NAMES[s.provider]||s.provider)+'完成任务啦，辛苦了～'});
      }
      if(old&&old!==s.status&&s.status==='failed'&&s.feedbackEligible!==false){
        feedback({eventId:s.key+':failed:'+ (++feedbackSerial),id:'fail',source:'failed',provider:s.provider,sessionKey:s.key,turnKey:s.turnId,cycles:1,text:(TOOL_NAMES[s.provider]||s.provider)+'日志记录了错误，点我查看。'});
      }
      stateBefore.set(s.key,s.status);
    }
  }
  if(pet&&!pet.isDestroyed())pet.webContents.send('monitor:update',monitorView(value,'pet'));if(panel && !panel.isDestroyed())panel.webContents.send('monitor:update',monitorView(value));
}
ipcMain.handle('monitor:snapshot',()=>snapshot);
ipcMain.handle('monitor:status',event=>monitorView(snapshot,pet&&!pet.isDestroyed()&&event.sender===pet.webContents?'pet':'panel'));
ipcMain.handle('tokens:action',(_,action,args)=>tokenAction(action,args));
ipcMain.handle('tokens:choose',async(_,kind)=>{const result=await dialog.showOpenDialog(panel,{properties:kind==='directory'?['openDirectory']:['openFile']});return result.canceled?null:result.filePaths[0];});
ipcMain.handle('tokens:export',async()=>{const value=await tokenAction('export');const result=await dialog.showSaveDialog(panel,{defaultPath:'token-sources-template.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled)return false;writeFileSync(result.filePath,JSON.stringify(value,null,2));return true;});
ipcMain.handle('tokens:import',async()=>{const result=await dialog.showOpenDialog(panel,{properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});if(result.canceled)return null;const file=result.filePaths[0];if(readFileSync(file).length>1048576)throw Error('模板过大');return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));});
ipcMain.handle('quotas:action',(_,action,args)=>quotas.action(action,args));
ipcMain.handle('statistics:export',async(_,args)=>{const format=args?.format==='csv'?'csv':'json';const text=await tokenAction('statistics-export',{...args,format});const result=await dialog.showSaveDialog(panel,{defaultPath:'AI 酱-统计.'+format,filters:[{name:format.toUpperCase(),extensions:[format]}]});if(result.canceled)return false;writeFileSync(result.filePath,text,'utf8');return true;});
ipcMain.handle('settings:get',()=>settingsView());
ipcMain.handle('settings:set',(_,patch)=>setPreferences(patch));
ipcMain.handle('settings:action',(_,action)=>settingsAction(action));
ipcMain.handle('pet:play',(_,request)=>playPet(request));
ipcMain.handle('pet:auto',()=>petAuto());
ipcMain.handle('pet:state',()=>petState);
ipcMain.on('pet:state',(event,value)=>{if(event.sender!==pet?.webContents||!actionIds.has(value?.id))return;const previous=petState.characterId;petState={id:value.id,source:String(value.source||'monitor').slice(0,20),manual:value.manual===true,expiresAt:Number.isFinite(value.expiresAt)?value.expiresAt:null,characterId:validPetCharacter(value.characterId)?value.characterId:'deepseek'};if(panel&&!panel.isDestroyed())panel.webContents.send('pet:state',petState);if(previous!==petState.characterId){configurePetInteractions();broadcastSettings();}});
async function manageResources(characterId){
  const manager=resources.manager();if(!manager)throw Error('请下载此版本的在线安装器进行管理 / Download this version’s installer to manage resources');
  const ids=(Array.isArray(characterId)?characterId:[characterId]).filter(Boolean);if(ids.some(id=>!validPetCharacter(id)))throw Error('Unknown character');
  const en=settings.preferences?.language==='en';
  const answer=await dialog.showMessageBox(panel??pet,{type:'question',title:'AI Buddy',message:en?'Open the resource manager? Downloads start only after you click Install.':'打开角色资源管理器？点击安装后才会下载。',buttons:en?['Open','Cancel']:['打开','取消'],defaultId:0,cancelId:1});
  if(answer.response!==0)return {cancelled:true};
  const child=spawn(manager,['--root='+root,...(ids.length?['--characters-add='+ids.join(',')]:[])],{detached:true,stdio:'ignore'});await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});child.unref();return {ok:true};
}
ipcMain.handle('resources:status',()=>resources.status(true));
ipcMain.handle('resources:manage',(_,id)=>manageResources(id));
ipcMain.handle('chat:status',()=>provider.status());
ipcMain.handle('chat:enabled',(_,enabled)=>{provider.setEnabled(enabled);audit({type:'chat-enabled',enabled:provider.enabled});return provider.status();});
ipcMain.handle('models:get',()=>connectionView(provider));
ipcMain.handle('models:save',(_,draft)=>saveConnection(provider,draft));
ipcMain.handle('models:delete',(_,id)=>provider.remove(id));
ipcMain.handle('models:activate',(_,id)=>provider.activate(id));
// Listing belongs to the editor draft; Cancel must not replace a saved route's catalog.
ipcMain.handle('models:list',(_,draft)=>provider.fetchModels(draft));
ipcMain.handle('models:test',(_,draft)=>provider.test(draft));
ipcMain.handle('cg:get',()=>connectionView(cg));
ipcMain.handle('cg:save',(_,draft)=>saveConnection(cg,draft));
ipcMain.handle('cg:delete',(_,id)=>cg.remove(id));
ipcMain.handle('cg:activate',(_,id)=>cg.activate(id));
ipcMain.handle('cg:enabled',(_,enabled)=>cg.setEnabled(enabled===true));
ipcMain.handle('cg:list',async(_,draft)=>{const models=await cg.fetchModels(draft);if(draft.id)await cg.saveModels(draft.id,models);return models;});
ipcMain.handle('cg:check',(_,draft)=>cg.test(draft));
ipcMain.handle('cg:test-image',(_,draft)=>cg.testImage(draft));
ipcMain.handle('cg:image',(_,id)=>{const job=cg.job(id);if(!job?.assetRef)throw Error('CG 尚未完成');return {dataUrl:cg.readAsset(job.assetRef)};});
ipcMain.handle('game:action',async(_,action,args)=>{
  if(typeof action!=='string')throw new Error('Invalid action');
  const dialog=provider.enabled&&['chat','side-story','side-story-free-reply','companion-group-send','companion-group-continue'].includes(action);
  if(dialog){gameRequests++;petEvent({kind:'dialog',active:true});}
  try{const result=await game.action(action,args||{});if(dialog&&result?.ok===false&&result.code!=='CHARACTER_NOT_INSTALLED')feedback({id:'fail',source:'chat-error',text:'聊天暂时失败，请重试。',cycles:1});return result;}
  catch(error){if(dialog)feedback({id:'fail',source:'chat-error',text:'聊天暂时失败，请重试。',cycles:1});throw error;}
  finally{if(dialog){gameRequests--;petEvent({kind:'dialog',active:gameRequests>0||activityClock.busy.size>0});}}
});
ipcMain.handle('pet:story-feedback',(event,value)=>{if(event.sender!==panel?.webContents||!game?.hasCharacter?.(value?.characterId)||!validEmotion(value.emotion)||typeof value.text!=='string'||value.text.length>4000)return false;chatFeedback({...value,messageId:'story:'+String(value.messageId).slice(0,160)});return true;});
ipcMain.on('panel:open',(_,page)=>openPanel(page));
ipcMain.on('pet:hit',(_,hit)=>{lastPetHit=!!hit;if(!drag && pet && !pet.isDestroyed())setGestureMode(gestureMode);});
ipcMain.on('pet:drag-start',(event,message)=>{
 if(event.sender!==pet?.webContents||!petMotion||drag)return;
 const gestureId=typeof message?.gestureId==='string'?message.gestureId.slice(0,120):null,cursor=gesturePoint(message),bounds=pet.getContentBounds();
 // Preserve the point actually grabbed, even if the cursor has already moved
 // while pointer-down crosses IPC. This local offset never positions a window.
 const local=message?.local,point=Number.isFinite(local?.x)&&Number.isFinite(local?.y)&&local.x>=0&&local.x<=1&&local.y>=0&&local.y<=1?{x:bounds.x+local.x*bounds.width,y:bounds.y+local.y*bounds.height}:cursor;
 const button=message?.button??0;if(button!==0&&button!==2)return;
 petMotion.bounds={...bounds};const begin=petMotion.begin(point,{button});
 const wakeOnly=activityClock.wake('touch');
 drag={gestureId,button,origin:point,moved:false,characterId:petState.characterId??effectivePetCharacter(),personaId:game.context?.().personaId,eventId:'touch:'+process.pid+':'+Date.now()+':'+begin.serial,caught:begin.caught,wakeOnly};
 nativeButtons=button===2?2:1;buttonObserver?.start(gestureId);ignoringMouse=false;pet.setIgnoreMouseEvents(false);moveDrag(cursor);publishInteraction(true);audit({type:'pet-pointer-down',gestureId,button,point,cursor,bounds});
});
ipcMain.on('pet:drag-move',(event,message)=>{if(event.sender===pet?.webContents&&gestureMatches(message))moveDrag(gesturePoint(message));});
async function finishPetGesture(message){
 if(!gestureMatches(message))return {ignored:true};
 if(message?.button!==undefined&&message.button!==(petMotion.releaseButton??drag.button))return {ignored:true};
 // A very quick drag can finish between timer ticks. Observe its final OS
 // position for placement/tap classification, without adding a velocity sample.
 if(arg('cursor')!=='manual')petMotion.move(screen.getCursorScreenPoint(),{sample:false});
 const captured=drag,result=petMotion.release(null,{button:message?.button??petMotion.releaseButton??drag.button});if(result.ignored)return result;drag=null;buttonObserver?.stop();petEvent({kind:'gesture-reset',gestureId:captured.gestureId,reason:'released',buttons:nativeButtons});petEvent({kind:'drag',active:false});publishInteraction(true);setGestureMode(gestureMode);
 if(result.touch){activityClock.activity('touch');const id=touchExpressions.next(captured.characterId);petEvent({kind:'feedback',value:{id,source:'touch',cycles:1,eventId:captured.eventId,characterId:captured.characterId}});const awarded=await game.touch?.({characterId:captured.characterId,personaId:captured.personaId,eventId:captured.eventId});audit({type:'pet-touch',characterId:captured.characterId,personaId:captured.personaId,expression:id,awarded:awarded?.awarded??false,reason:awarded?.reason});}
 if(captured.wakeOnly){result.wakeOnly=true;result.context=false;}
 else if(result.context)petContextMenu();
 settings.petBounds=petBounds(pet.getContentBounds(),settings.preferences.petScale);audit({type:'pet-pointer-up',gestureId:captured.gestureId,...result,bounds:settings.petBounds});await saveSettings();return result;
}
ipcMain.handle('pet:drag-end',(event,message)=>event.sender===pet?.webContents?finishPetGesture(message):{ignored:true});
function observePetButtons(value){
 if(!gestureMatches(value))return;const previous=nativeButtons;nativeButtons=value.buttons;
 if(value.escape){cancelGesture('escape-native');return;}
 if(drag.button===2&&(value.buttons&1)&&!(previous&1)){moveDrag(screen.getCursorScreenPoint());petMotion.right(screen.getCursorScreenPoint());publishInteraction(true);}
 const releaseButton=petMotion.releaseButton??drag.button;
 if(!(value.buttons&(releaseButton===2?2:1)))void finishPetGesture({gestureId:value.gestureId,button:releaseButton}).catch(error=>{audit({type:'pet-input-error',message:error.message});cancelGesture('release-error');});
}
ipcMain.handle('pet:gesture-cancel',(event,message)=>{if(event.sender!==pet?.webContents||!gestureMatches(message))return false;cancelGesture(message?.reason??'renderer-cancel');return true;});
ipcMain.handle('pet:context',(event,message)=>{
 if(event.sender!==pet?.webContents||!pet)return false;
 if(drag){if(!gestureMatches(message)||drag.button!==2||message?.button!==0)return {ignored:true};moveDrag(gesturePoint(message));const charging=petMotion?.right(gesturePoint(message));publishInteraction(true);return {consumed:true,charging:petMotion?.mode==='charging',changed:charging};}
 if(message?.gestureId)return {ignored:true};
 petContextMenu();return {menu:true};
});
ipcMain.on('pet:animation-ready',(event,value)=>{
 if(event.sender!==pet?.webContents||value?.characterId!==petState.characterId)return;
 const clock=value.scope==='motion'?petMotion:activityClock;if(!clock||value.epoch!==clock.animationEpoch)return;
 if(value.failed){audit({type:'interaction-media-error',id:value.id,characterId:value.characterId});if(value.scope==='motion')petMotion.stop();else activityClock.resume();}
 else clock.markReady(value.epoch);
 publishInteraction(true);
});

const control=createLocalControlServer({
  onSocketError:error=>audit({type:'control-client-error',code:error.code || 'UNKNOWN'}),
  onRequest:async request=>{
      let result;
      if(request.command==='snapshot')result={processId:process.pid,singleInstance:app.hasSingleInstanceLock(),snapshot,settings:settingsView(),petAction:petState,chat:{enabled:provider?.enabled || false,model:provider?.defaultModel},petBounds:pet?.getBounds(),petContentBounds:pet?.getContentBounds(),petVisible:pet?.isVisible(),petAssetsReady,petAlwaysOnTop:pet?.isAlwaysOnTop(),petInteraction:{gestureMode,lastPetHit,ignoringMouse,dragging:!!drag,...petInteraction()},displays:screen.getAllDisplays().map(d=>({workArea:d.workArea,scaleFactor:d.scaleFactor})),build,dataRoot};
      else if(request.command==='installation-status')result={version:appVersion,build,dataRoot,processId:process.pid,ready:!!game&&petAssetsReady,busy:!!(gameRequests||provider?.status().busy||cg?.status().busy),resources:resources.status()};
      else if(request.command==='installation-quit'){if(request.expectedBuild!==build)result={ok:false,error:'Different installation'};else if(gameRequests||provider?.status().busy||cg?.status().busy)result={ok:false,busy:true};else{result={ok:true};setTimeout(()=>{void shutdown();},100);}}
      else if(request.command==='resources-status')result=resources.status(true);
      else if(request.command==='validation-window'&&arg('validation')==='1'){
        if(!panel||panel.isDestroyed())openPanel('galgame',false);
        if(![900,1180,1600,1920].includes(request.width))throw Error('Validation width outside test matrix');
        panel.setBounds({width:request.width,height:Math.max(650,Math.min(1100,Number(request.height)||820))});result={bounds:panel.getBounds(),scaleFactor:screen.getDisplayMatching(panel.getBounds()).scaleFactor};
      }
      else if(request.command==='validation-system'&&arg('validation')==='1'){
        if(['suspend','resume'].includes(request.event))powerMonitor.emit(request.event);
        else if(['display-removed','display-metrics-changed'].includes(request.event))screen.emit(request.event,{},screen.getPrimaryDisplay(),['workArea','scaleFactor']);
        else throw Error('Invalid validation system event');
        result={simulated:true,event:request.event,interaction:petInteraction(),bounds:pet?.getContentBounds()};
      }
      else if(request.command==='validation-position'&&arg('validation')==='1'){
        if(!Number.isFinite(request.x)||!Number.isFinite(request.y)||Math.abs(request.x)>20000||Math.abs(request.y)>20000)throw Error('Invalid validation position');
        cancelGesture('validation-position');positionPet(pet,{x:request.x,y:request.y},settings.preferences.petScale);
        result={bounds:pet.getContentBounds()};
      }
      else if(request.command==='validation-metrics'&&arg('validation')==='1'){
        result={processes:app.getAppMetrics(),gpuFeatures:app.getGPUFeatureStatus(),displays:screen.getAllDisplays().map(d=>({id:d.id,bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor})),trajectoryVisible:!!trajectoryWindow&&!trajectoryWindow.isDestroyed(),rendererErrors:[...rendererErrors]};
      }
      else if(request.command==='validation-input'&&arg('validation')==='1'){
        const target=request.target==='panel'?panel:pet;if(!target||target.isDestroyed())throw Error('Validation window not ready');
        if(!['mouseMove','mouseDown','mouseUp','keyDown','keyUp'].includes(request.input?.type))throw Error('Invalid validation input');target.webContents.sendInputEvent(request.input);result={ok:true};
      }
      else if(request.command==='validation-activity'&&arg('validation')==='1'){
        if(request.kind==='reset')activityClock.resume();
        else if(request.kind==='age'){if(![299000,300000,301000].includes(request.ms))throw Error('Invalid timing boundary');activityClock.lastActivity=performance.now()-request.ms;activityClock.awakeUntil=activityClock.lastActivity+300000;}
        else if(request.kind==='token')activityClock.activity('token');
        else throw Error('Invalid validation activity');result=publishInteraction(true);
      }
      else if(request.command==='validation-feedback'&&arg('validation')==='1'){
        if(!['completed','failed'].includes(request.kind))throw Error('Invalid validation feedback');
        const completed=request.kind==='completed';feedback({eventId:'validation:'+String(request.id??Date.now()),id:completed?'jump':'fail',source:request.kind,provider:'validation',text:completed?'本地验证：任务完成':'本地验证：任务失败',cycles:completed?2:1});result={ok:true};
      }
      else if(request.command==='pet-play')result=playPet(request.action);
      else if(request.command==='pet-auto')result=petAuto();
      else if(request.command==='settings-get')result=settingsView();
      else if(request.command==='quota-action')result=await quotas.action(request.action,request.args);
      else if(request.command==='token-action')result=await tokenAction(request.action,request.args);
      else if(request.command==='settings-set')result=await setPreferences(request.patch);
      else if(request.command==='settings-action')result=await settingsAction(request.action);
      else if(request.command==='show'){openPanel(request.page || 'overview',false);result={ok:true};}
      else if(request.command==='hide'){petAuto();panel?.hide();result={ok:true};}
      else if(request.command==='pet-hide'){await setPreferences({petVisible:false});result={ok:true};}
      else if(request.command==='pet-show'){await setPreferences({petVisible:true});result={ok:true};}
      else if(request.command==='pet-gesture'){setGestureMode(request.enabled===true);result={ok:true,gestureMode};}
      else if(request.command==='brand-info'){
        result={appName:app.getName(),appId:APP_ID,iconPath:appIconPath,iconSize:appIcon.getSize(),windows:Object.fromEntries([['pet',pet],['panel',panel]].filter(([,window])=>window&&!window.isDestroyed()).map(([name,window])=>[name,{title:window.getTitle(),handle:window.getNativeWindowHandle().readBigUInt64LE().toString()}]))};
      }
      else if(request.command==='capture'){
        const directory=join(dataRoot,'captures');mkdirSync(directory,{recursive:true});
        const stamp=Date.now();const captured={};
        for(const [name,window] of [['pet',pet],['panel',panel]])if(window && !window.isDestroyed()){const image=await window.webContents.capturePage();const file=join(directory,name+'-'+stamp+'.png');writeFileSync(file,image.toPNG(),{flag:'wx'});captured[name]=file;}result=captured;
      }
      else if(request.command==='page-info'){
        result={rendererErrors,pet:await pet.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,scale:getComputedStyle(document.body).transform,badgeHidden:document.querySelector(".badge").hidden,sprite:getComputedStyle(document.querySelector(".sprite")).backgroundPosition,spriteRect:document.querySelector(".sprite").getBoundingClientRect().toJSON(),badgeRect:document.querySelector(".badge").getBoundingClientRect().toJSON(),input:window.petInputDiagnostic,action:window.petActionDiagnostic})'),panel:panel&&!panel.isDestroyed()?await panel.webContents.executeJavaScript('({title:document.title,scrollY:scrollY,bodyWidth:document.body.scrollWidth,viewportWidth:innerWidth,page:document.querySelector("nav .active")?.innerText,buttons:[...document.querySelectorAll("button")].map(b=>b.innerText).filter(Boolean).slice(0,35),inputs:[...document.querySelectorAll("input,textarea,select")].map(i=>({tag:i.tagName,type:i.type,placeholder:i.placeholder,setting:i.dataset.setting,value:i.type==="password"?"":i.value,checked:i.checked})),actionCards:[...document.querySelectorAll("[data-action-card]")].map(e=>e.dataset.actionCard),directionCount:document.querySelectorAll("[data-look-index]").length,contentText:document.querySelector(".content")?.innerText.slice(-500)})'):null};
      }
      else if(request.command==='gallery-state'){
        result=panel&&!panel.isDestroyed()?await panel.webContents.executeJavaScript(`(()=>{const r=window.galleryPreviewInspection?.renderer;return {hidden:document.hidden,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,control:document.querySelector('[data-action=pause-previews]')?.innerText,renderer:r?.backend,cache:r?.inspect(),cards:[...document.querySelectorAll('[data-preview]')].filter(e=>e.dataset.animating==='true').map(e=>({id:e.dataset.preview,phase:e.previewPhase,frame:r?.displayedSample(e.querySelector('canvas'))?.displayedSequenceFrame,draws:r?.targetDraws(e.querySelector('canvas'))}))};})()`):null;
      }
      else if(request.command==='quit'){result={ok:true};setTimeout(()=>{void shutdown();},100);}
      else result={error:'Unsupported local command'};
      return result;
  }
});
control.on('error',error=>{
  if(error.code==='EADDRINUSE') {void requestLocalControl(pipe,{command:'show'}).catch(()=>{}).finally(()=>app.exit(0));}
  else {audit({type:'control-error',message:error.message});}
});

async function shutdown() {
  if(quitting)return;quitting=true;buttonObserver?.close();trajectoryWindow?.destroy();trajectoryWindow=null;quotas?.close();provider?.close();await cg?.close();game?.close();
  if(worker){worker.postMessage({type:'close'});await Promise.race([new Promise(r=>{worker.once('exit',r);worker.on('message',m=>{if(m.type==='closed')r();});}),new Promise(r=>setTimeout(r,5000))]);}
  control.close();app.exit(0);
}
app.on('before-quit',event=>{if(!quitting){event.preventDefault();void shutdown();}});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  buttonObserver=createPetButtonObserver({path:join(build,'pet-buttons.exe'),enabled:process.platform==='win32'&&arg('cursor')!=='manual',onState:observePetButtons,onError:error=>{audit({type:'pet-input-helper-error',message:error.message});if(drag)cancelGesture('button-observer-error');}});
  settings=await readJson(settingsStore,{});
  const netSession=session.fromPartition('whale-memory');
  netSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{audit({type:'renderer-external-blocked',scheme:details.url.split(':')[0]});callback({cancel:true});});
  netSession.setPermissionRequestHandler((_,__,callback)=>callback(false));
  const home=process.env.USERPROFILE;
  let config='';try{config=readFileSync(join(codexHome(),'config.toml'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const model=config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || 'gpt-6.1-sol';
  const binary=()=>resolveCodexBinary({root,explicit:arg('codex')});
  const codex=new CodexProvider({binary,defaultModel:model,dataRoot,onUsage:usage=>worker?.postMessage({type:'companion-usage',...usage}),audit});
  provider=new ModelRouter({codex,dataRoot,crypto:safeStorage,legacy:existsSync(settingsStore.target+'.snapshots'),onActivity:internalActivity,onChange:()=>broadcastSettings(),onUsage:usage=>{appendFileSync(join(dataRoot,'api-usage.jsonl'),JSON.stringify(usage)+'\n');worker?.postMessage({type:'refresh'});},audit});
  await provider.ready;
  quotas=new QuotaService({dataRoot,home,crypto:safeStorage,binary,onChange:value=>{if(panel&&!panel.isDestroyed())panel.webContents.send('quotas:update',value);}});await quotas.ready;quotas.start();
  const cgUsage=usage=>{appendFileSync(join(dataRoot,'cg-usage.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),...usage})+'\n');worker?.postMessage({type:'refresh'});};
  cg=new CgService({resourceCheck:ids=>resources.require(ids.filter(validPetCharacter)),themePlanner:new CgThemePlanner(provider,()=>settings.preferences?.language|| (app.getLocale().startsWith('zh')?'zh-CN':'en')),codex:new CodexImageProvider({binary,defaultModel:model,dataRoot,onUsage:cgUsage,audit}),dataRoot,crypto:safeStorage,imageCodec:createCgCodec(nativeImage),onUsage:cgUsage,onActivity:internalActivity,onChange:()=>{broadcastSettings();if(panel&&!panel.isDestroyed())panel.webContents.send('cg:updated',{});},audit,referenceResolver:createCharacterReferenceResolver(build,ref=>cg.readAsset(ref))});
  await cg.ready;
  game=await createGalgame({dataRoot,provider,model,cg,resources,onActivity:internalActivity,onPetVisibility:syncPetVisibility,onChatCommitted:chatCommitted,getLanguage:()=>settings.preferences?.language||(settings.preferences?'zh-CN':app.getLocale().startsWith('zh')?'zh-CN':'en'),onCharacter:id=>applyChrome(id),onCgUpdated:value=>{if(panel&&!panel.isDestroyed())panel.webContents.send('cg:updated',value);}});
  cg.start();
  const legacyGameSettings=await game.action('settings-get');
  const firstPreferences=!settings.preferences||!Object.keys(settings.preferences).length;
  settings.preferences=normalizePreferences(settings.preferences,legacyGameSettings.petEnabled!==false);
  if(firstPreferences)settings.preferences.language=app.getLocale().startsWith('zh')?'zh-CN':'en';
  setLocale(settings.preferences.language);
  if(settings.preferences.petVisible!==(legacyGameSettings.petEnabled!==false))await game.action('pet-set',{enabled:settings.preferences.petVisible});
  await saveSettings();
  // Resolve the saved/manual or model-following character before the first
  // desktop greeting, even when the Galgame panel has not been opened.
  await game.action('view');
  const area=screen.getPrimaryDisplay().workArea;
  const bounds=clamp(petBounds(settings.petBounds || {x:area.x+area.width-290,y:area.y+area.height-290},settings.preferences.petScale));
  pet=new BrowserWindow({...petWindowOptions(bounds,settings.preferences.petScale),title:APP_NAME,icon:appIconPath,webPreferences:{preload:join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'whale-memory'}});
  brandWindow(pet);
  lockPageZoom(pet,error=>audit({type:'zoom-policy-error',message:error.message}));
  positionPet(pet,bounds,settings.preferences.petScale);pet.on('will-resize',event=>event.preventDefault());
  petMotion=new PetMotion({bounds,requireReady:true,displays:()=>screen.getAllDisplays(),onPosition:value=>{if(pet&&!pet.isDestroyed())positionPet(pet,value,settings.preferences.petScale);},onState:()=>{publishInteraction(true);}});
  configurePetInteractions();activityClock.resume();
  pet.setAlwaysOnTop(settings.preferences.alwaysOnTop,'floating');setGestureMode(false);
  pet.loadFile(join(build,'pet.html'),{...previewQuery,query:{...previewQuery.query,petCharacter:resources.fallback(resolvePetCharacter(settings.preferences,themeCharacter))}});pet.once('ready-to-show',async()=>{
    if(PET_ACTIONS.some(action=>action.sourceFrameCount))try{await pet.webContents.executeJavaScript('window.petCharacterReady.then(()=>window.frameSequenceInspection.renderer.ready).then(()=>true)');}catch(error){rendererErrors.push(error.message);audit({type:'pet-assets-error',message:error.message});return;}
    if(!pet.isDestroyed()){petAssetsReady=true;applyPetPreferences();}
  });
  pet.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  tray=new Tray(appIcon.resize({width:32,height:32}));tray.setToolTip(arg('rig')==='working'?APP_NAME+' · 工作动作小样（独立预览）':APP_NAME+' · 本地 AI 用量监控与桌面陪伴');
  updateTray();tray.on('double-click',()=>openPanel());
  const recoverPet=()=>{if(!pet||pet.isDestroyed())return;cancelGesture('system-recovery');petMotion?.recover(clamp(petBounds(pet.getContentBounds(),settings.preferences.petScale)));publishInteraction(true);};
  pet.on('hide',()=>cancelGesture('window-hidden'));pet.webContents.on('render-process-gone',()=>cancelGesture('renderer-lost'));
  screen.on('display-removed',recoverPet);screen.on('display-metrics-changed',recoverPet);
  powerMonitor.on('suspend',recoverPet);powerMonitor.on('resume',()=>{recoverPet();activityClock.resume();publishInteraction(true);});
  let lastCursorPoint=null;
  setInterval(()=>{
    if(pet&&!pet.isDestroyed()&&pet.isVisible()){const before=petMotion.mode;petMotion.tick();if(before!==petMotion.mode&&petMotion.mode==='rest'){settings.petBounds=petBounds(pet.getContentBounds(),settings.preferences.petScale);void saveSettings();}publishInteraction();}
    if(!pet || pet.isDestroyed() || !pet.isVisible()){lastCursorPoint=null;return;}
    // Private validation can drive the same input handlers without live OS cursor interference.
    if(arg('cursor')==='manual')return;
    const cursor=screen.getCursorScreenPoint();
    if(drag)moveDrag(cursor);
    const b=pet.getContentBounds(),point={x:cursor.x-b.x,y:cursor.y-b.y,dragging:!!drag?.moved};
    if(!lastCursorPoint||point.x!==lastCursorPoint.x||point.y!==lastCursorPoint.y||point.dragging!==lastCursorPoint.dragging){lastCursorPoint=point;pet.webContents.send('pet:cursor',point);}
  },16);
  logRoots=arg('roots')?JSON.parse(readFileSync(arg('roots'),'utf8')):[{provider:'codex',path:join(home,'.codex/sessions')},{provider:'codex',path:join(home,'.codex/archived_sessions')},{provider:'claude',path:join(home,'.claude/projects')}];
  monitorAppliedInterval=settings.preferences.monitorRefreshMs;
  worker=new Worker(join(build,'monitor-worker.cjs'),{workerData:{roots:arg('roots')?logRoots:undefined,home,env:process.env,dataRoot,refreshIntervalMs:settings.preferences.monitorRefreshMs,statisticsTimeZone:settings.preferences.statisticsTimeZone,autoPriceUpdates:settings.preferences.autoPriceUpdates}});
  worker.on('message',message=>{if(message.type==='sources'){tokenSources=message.value;if(panel&&!panel.isDestroyed())panel.webContents.send('tokens:update',message.value);}if(message.type==='source-result'){const pending=sourceRequests.get(message.id);if(pending){clearTimeout(pending.timer);sourceRequests.delete(message.id);message.error?pending.fail(Error(message.error)):pending.done(message.value);}}if(message.type==='snapshot')publish(message.value);if(message.type==='configured'){monitorAppliedInterval=message.refreshIntervalMs;broadcastSettings();}if(message.type==='refreshed')broadcastSettings();if(message.type==='error')audit({type:'monitor-error',message:message.message});});
  worker.on('message',message=>{if(message.type==='task-feedback'&&!quitting)feedback(message.value);});
  worker.on('error',error=>audit({type:'monitor-worker-error',message:error.stack}));
  control.listen(pipe);audit({type:'app-start',mode:'offline',version:appVersion,build});
  if(reopenRequested||['overview','galgame','settings','actions'].includes(arg('open')))openPanel(reopenRequested?'overview':arg('open'),false);
}).catch(error=>{audit({type:'startup-error',message:error.stack});console.error(error);app.exit(1);});
