import {createWorkResumeConfirmation} from './work-resume-confirmation.mjs';
import {createWorkSourceRegistry,sourceMutation} from './work-source-registry.mjs';
import {createWorkPluginGate} from './work-plugin-gate.mjs';
import {deliverRewardFacts} from './reward-fact-delivery.mjs';
import {closeMonitorWorker} from './monitor-worker-shutdown.mjs';
import {createMonitorProfileDiagnostic} from './monitor-profile-diagnostic.mjs';
import {createMainProfileDiagnostic} from './main-profile-diagnostic.mjs';
import {createPluginMaintenanceClient} from './plugin-maintenance-client.mjs';
import {pluginActionResult} from './plugin-ipc.mjs';
import {createPluginPlatform} from './plugin-platform.mjs';
import {createVoiceHost,trustedVoiceSender} from './voice/host.mjs';
import {createBiliSheetRenderer,createBiliFrameAnalyzer} from './bili-sheet-renderer.mjs';
import {createPluginEmbed,embedCapable,EMBED_CHANNEL,EMBED_EVENT,EMBED_TARGETS} from './plugin-embed.mjs';
import {pluginPageAppearance} from './plugin-page-appearance.mjs';
import {builtinFaces,builtinPortraits,createCustomFaceProcessor,readFaceFile} from './plugin-faces.mjs';
import {createPluginUsageRecorder} from './plugin-usage-recorder.mjs';
import {extensionComponentStatus,extensionOperationBusy} from './installation-components.mjs';
import {createInstalledResources} from './installed-resources.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {createAppUpdateBackend} from './update-backend-client.mjs';
import {createAppBootstrapBackend} from './update-bootstrap-backend.mjs';
import {createUpdateService} from './update-service.mjs';
import {createUpdateReservation,updateError} from './update-reservation.mjs';
import {startDesktopSample,stopDesktopSample,measureDesktopDiagnostic} from './desktop-diagnostics.mjs';
import {readPetFullscreenSnapshot} from './pet-fullscreen.mjs';
import {resolveInstallation,commitInstallation,markInstallationInitialized} from './installation-record.mjs';
import {createDataImportService,hasBusinessData} from './data-import.mjs';
import {deferredSaves} from './deferred-saves.mjs';
import {setLocale,t,localizedTitle} from './i18n.mjs';
import {chromeColor,chromeSymbolColor,windowBackground,resolvedTheme,themeVariables} from './appearance.mjs';
import {trayMenuTemplate,petContextTemplate} from './pet-menu.mjs';
import {CgThemePlanner} from './cg-theme.mjs';
import {createCharacterReferenceResolver} from './cg-reference-registry.mjs';
import {monitorView} from './monitor-view.mjs';
import { app,BrowserWindow,WebContentsView,Tray,Menu,ipcMain,nativeImage,screen,session,safeStorage,dialog,powerMonitor,protocol,shell } from 'electron';
import {pluginWindowOpenHandler} from './dsh-platform/client-host.mjs';
import {PetActivityClock,PetMotion} from './pet-interactions.mjs';
import {matchesInteractionReady} from './pet-interaction-view.mjs';
import {createPetButtonObserver} from './pet-buttons.mjs';
import {PetTouchExpressions} from './pet-touch.mjs';
import {frameSequence,CHARACTER_SEQUENCES} from './frame-sequence.mjs';
import { Worker } from 'node:worker_threads';
import { join,resolve,dirname } from 'node:path';
import { readFileSync,mkdirSync,appendFileSync,writeFileSync,existsSync,statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { MEDIA_SCHEME,MEDIA_MIME,mediaName,createMediaStore } from './media-store.mjs';
import { createSnapshotStorage,readJson } from './storage.mjs';
import { createGalgame } from './galgame-host.mjs';
import { CodexProvider } from './codex-provider.mjs';
import { ModelRouter } from './model-router.mjs';
import {createChatPreferences} from './chat-preferences.mjs';
import {QuotaService} from './quota-service.mjs';
import {CgService} from './cg-service.mjs';
import {createDailyCgScheduler} from './daily-cg-scheduler.mjs';
import {CodexImageProvider} from './codex-image-provider.mjs';
import {createCgCodec} from './cg-images.mjs';
import { clampToDisplays } from './window-position.mjs';
import { petBounds,petSize,petWindowOptions,positionPet,applyPetTopmost } from './pet-window.mjs';
import {createPetWindowDiagnostics} from './pet-window-diagnostics.mjs';
import {createPetFullscreenObserver,createPetFullscreenPolicy,petVisibility} from './pet-fullscreen.mjs';
import {PET_RENDERER_DIAGNOSTIC_SCRIPT} from './pet-renderer-diagnostics.mjs';
import {petCollisionInsets} from './pet-presentation.mjs';
import { createLocalControlServer,requestLocalControl } from './local-control.mjs';
import {claimControlPipe} from './startup-control-lock.mjs';
import { DEFAULT_PREFERENCES,normalizePreferences,validatePreferencesPatch } from './preferences.mjs';
import { PET_ACTIONS,PET_INTERACTION_ACTIONS,validatePetPlayback,getPetAction } from './pet-actions.mjs';
import { EMOTIONS,validEmotion,shortReply } from './emotions.mjs';
import { superviseWorker,pushBounded } from './worker-supervisor.mjs';
import {validPetCharacter,resolvePetCharacter,brandPetCharacter,PET_CHARACTERS} from './pet-characters.mjs';
import {connectionView} from './connection-view.mjs';
import {lockPageZoom} from './page-zoom.mjs';
import {TOOL_NAMES} from './token-sources.mjs';
import {resolveCodexBinary,codexHome} from './runtime-discovery.mjs';
import {detectWorkEngines,readPreferencesFile,OFFLINE_BUNDLE_EXTENSION} from './community/host-files.mjs';
import {APP_NAME,APP_ID,APP_ICON_ICO,APP_ICON_PNG} from './app-brand.mjs';
import {brandIcons,brandTooltip} from './brand-icons.mjs';

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
const localCardBuild=typeof __AI_BUDDY_LOCAL_CARD_BUNDLE_SHA256__==='string';
const cardRehearsal=localCardBuild&&arg('local-card-rehearsal')==='1';
let cardQuiet=localCardBuild&&arg('local-card-quiet')==='1';
const automaticWorkAllowed=()=>!cardQuiet&&!importBarrier&&!updateReservation.active()&&dataImport.automaticWorkAllowed();
function handoffCardVerification(){
 if(!cardQuiet||cardRehearsal||quitting||!game)return;
 cardQuiet=false;cg?.start();quotas?.start();audit({type:'local-card-handoff'});
}
const workspaceTitle=()=>localizedTitle()+(arg('candidate')==='1'?(settings.preferences?.language==='en'?' · Feature Preview':' · 八项功能候选'):'');
const previewQuery=arg('rig')==='working'?{query:{workingRig:'1'}}:arg('rig')==='all'?{query:{allActionRigs:'1'}}:arg('rig')==='source'?{query:{sourcePreview:'1'}}:{};
let installationResolution,bootFailure=null,recoveryDispatched=false;
try{installationResolution=resolveInstallation({root,build,explicitData:arg('data'),explicitPipe:arg('pipe'),verifyImportId:arg('data-import-verify')});}
catch(error){
 bootFailure=error;
 if(error.code==='DATA_IMPORT_RECOVERY_REQUIRED'){
  try{
   const record=JSON.parse(readFileSync(join(root,'local/installation.json'),'utf8')),manager=resolve(root,record.manager);
   if(!manager.startsWith(root+'\\')||!existsSync(manager))throw Error('导入恢复维护器缺失');
   const result=spawnSync(manager,['--headless','--action=data-import-recover','--root='+root,'--receipt='+join(root,'local/installer/data-import-startup-recovery.json')],{windowsHide:true,encoding:'utf8',timeout:180000});
   if(result.status!==0)throw Error('资料恢复失败，请查看 local/installer/data-import-startup-recovery.json');
   recoveryDispatched=true;
  }catch(failure){bootFailure=failure;}
 }
}
const resources=createInstalledResources({root,build,installation:installationResolution?.installation??null});
const dataRoot=installationResolution?.data??resolve(arg('data')||join(root,'local/data-v003'));
if(cardRehearsal&&(!cardQuiet||!arg('data')||!/^ai-buddy-cgu1-rehearsal-[a-z0-9-]+$/.test(arg('pipe')??'')||dataRoot===join(root,'local/data-v003')))throw Error('Card rehearsal requires an isolated profile and private pipe');
// B4: companion pictures are served as buddy-media://<sha256>.<ext> (see media-store.mjs).
protocol.registerSchemesAsPrivileged([{scheme:MEDIA_SCHEME,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
if(!resources.fallback())throw Error('没有完整角色资源，请运行安装器修复 / No complete character resources; run installer repair');
if(!bootFailure)mkdirSync(dataRoot,{recursive:true});
app.setPath('userData',bootFailure?join(app.getPath('temp'),'AI-Buddy-Recovery-'+process.pid):join(dataRoot,'chromium'));
app.setPath('crashDumps',bootFailure?join(app.getPath('temp'),'AI-Buddy-Recovery-'+process.pid,'crashes'):join(dataRoot,'crash-reports'));
if(!app.requestSingleInstanceLock())app.exit(0);
if(!bootFailure)try{commitInstallation(installationResolution);}catch(error){bootFailure=error;}
for(const flag of ['disable-background-networking','disable-component-update','disable-domain-reliability','disable-sync'])app.commandLine.appendSwitch(flag);
const auditPath=join(dataRoot,'runtime-audit.jsonl');
const audit=value=>appendFileSync(auditPath,JSON.stringify({timestamp:new Date().toISOString(),...value})+'\n');
deferredSaves.setAudit(audit);
const pipe=installationResolution?.pipe || '\\\\.\\pipe\\whale-companion-v001';
let dataImport=null,importBarrier=false,onboarding=false;
let buttonObserver=null,nativeButtons=0;
let fullscreenObserver=null,fullscreenHidden=false;
const fullscreenPolicy=createPetFullscreenPolicy({onChange:hidden=>{fullscreenHidden=hidden;applyPetVisibility(false);}});
let dailyCgScheduler;
let pet,panel,tray,worker,game,provider,snapshot={indexing:true,sessions:[],active:[],todayUsage:{codex:{total:0},claude:{total:0}},workTotal:0},settings={},drag=null,lastWork=null,quitting=false,gestureMode=false,lastPetHit=false,ignoringMouse=true,petAssetsReady=false;
const monitorProfile=createMonitorProfileDiagnostic({getWorker:()=>worker,isClosing:()=>quitting||shuttingDown,processId:process.pid,build});
// No user gesture: the probe must not unlock audio playback the user has not allowed yet.
const panelProbe=script=>panel&&!panel.isDestroyed()?panel.webContents.executeJavaScript(script,false):null;
const mainProfile=createMainProfileDiagnostic({isClosing:()=>quitting||shuttingDown,processId:process.pid,build,renderer:{start:()=>panelProbe('globalThis.__buddyVoiceProbe?.start()??false'),stop:()=>panelProbe('globalThis.__buddyVoiceProbe?.stop()??null')}});
const settingsStore=createSnapshotStorage(join(dataRoot,'settings.json'));
let cg,quotas,agents,plugins,petDiagnostics,pluginUsage,pluginEmbed,appUpdates,chatPreferences,voiceHost;
let cardVoiceMix={voice:1,muted:false};
const updateReservation=createUpdateReservation({external:()=>[
  ...(gameRequests||provider?.status().busy||activityClock.busy.size||game?.r95?.busy?.()?['chat']:[]),
  ...(cg?.status().busy?['cg']:[]),...(agents?.busy()?['work']:[]),...(voiceHost?.busy()?['voice']:[]),
  ...(plugins?.busy?.()||extensionOperationBusy(plugins?.snapshot())?['plugin']:[]),...(importBarrier?['data']:[]),
]});
const bootstrapUrl='https://github.com/lXiaoSel1/AI-Buddy/releases/latest';
const updateCommands=new Set(['status','check','download','apply','cancel','automatic','bootstrap','manual-help','later']);
const gameReads=new Set(['view','settings-get','companion-state','companion-memory-view','companion-life-list','cg-gallery','cg-data','cg-thumbnail','sprite-data','bg-data']);
const gameStops=new Set(['companion-chat-cancel','companion-group-stop','companion-group-auto-pause','companion-group-auto-stop','cg-cancel']);
function updateGuard(capability,run){return updateReservation.run(capability,run);}
const stateBefore=new Map();const rendererErrors=[];
// Set when startup could not bring up the companion features (or the app);
// the app keeps running in safe mode instead of exiting on every launch.
let startupFailure=null;
let rewardDrainPending=false,rewardTail=Promise.resolve();
function requestRewardDrain(){if(!worker||!game?.r95||quitting||rewardDrainPending)return;rewardDrainPending=true;worker.postMessage({type:'reward-drain'});}
function consumeRewardFacts(facts,sender){rewardTail=rewardTail.then(async()=>{let delivered=false;try{const result=await deliverRewardFacts({facts,isCurrent:()=>!quitting&&sender===worker&&!!game?.r95,ingest:(rows,options)=>game.r95.feeding.ingestUsageFacts(rows,options),recordUsage:value=>game.r95.origins.recordUsage(value),acknowledge:sequences=>sender.postMessage({type:'reward-ack',sequences})});delivered=result.acknowledged;}catch(error){audit({type:'reward-facts-error',message:error.message});}finally{if(sender===worker){rewardDrainPending=false;if(delivered&&facts.length>=200)requestRewardDrain();}}}).catch(error=>{if(sender===worker)rewardDrainPending=false;audit({type:'reward-drain-error',message:error.message});});}

function noteStartupFailure(scope,error){startupFailure={scope,message:String(error?.message??error).slice(0,2000),at:new Date().toISOString()};audit({type:'safe-mode',scope,message:error?.stack??String(error)});}
let feedbackSerial=0;
let reopenRequested=false;
let logRoots=[],settingsTail=Promise.resolve(),settingsWriteTail=Promise.resolve(),monitorAppliedInterval=1000;
let tokenSources=null,sourceRequest=0;const sourceRequests=new Map();
let workSourceRegistry;
function sourceRegistry(){return workSourceRegistry??=createWorkSourceRegistry({dataRoot,home:process.env.USERPROFILE,env:process.env,roots:arg('roots')?logRoots:undefined},projection=>worker?.postMessage({type:'apply-source-registry',projection}),audit);}
function tokenAction(action,args={}){if(sourceMutation(action))return sourceRegistry().edit(action,args);if(action==='reconcile-work-source')return agents?.reconcileUsageSource(args)??Promise.reject(Error('Core accounting reader is not ready'));return new Promise((done,fail)=>{if(!worker)return fail(Error('监控正在启动'));const id=++sourceRequest,timer=setTimeout(()=>{sourceRequests.delete(id);fail(Error('检测尚未完成，请稍后查看'));},120000);sourceRequests.set(id,{done,fail,timer});worker.postMessage({type:'source-action',id,action,args});});}
async function managedWorkSource(value){try{return await sourceRegistry().register(value);}catch(error){if(error.code?.startsWith('WORK_'))throw error;throw Object.assign(Error('工作用量登记未完成，成员尚未开始执行。'+String(error.code??'')),{code:'WORK_USAGE_REGISTRATION_FAILED',cause:error});}}
let petState={id:'idle',source:'monitor',manual:false,expiresAt:null},gameRequests=0;
const activityClock=new PetActivityClock({requireReady:true,resolveOrigin:id=>game?.r95?.origins.resolve(id),verifyActivitySummary:value=>game?.r95?.origins.verifySummary(value)});let petMotion=null,lastInteraction='',heldFollowCharacter=null,trajectoryWindow=null,trajectoryState=null;
function petInteraction(){const motion=petMotion?.state()??{mode:'rest'},area=petMotion?.area(),body=motion.collisionBounds,grounded=!!(area&&body&&Math.abs(body.y+body.height-area.y-area.height)<2);return {characterId:petState.characterId??effectivePetCharacter(),gestureId:drag?.gestureId??null,...activityClock.tick({defer:!!drag||['flying','charging','landing'].includes(petMotion?.mode)||petState.manual}),motion:{...motion,grounded,elapsedMs:motion.since===undefined?0:performance.now()-motion.since,preview:petMotion?.preview()??[],landing:petMotion?.landing?.()??null},at:Date.now()};}
function publishInteraction(force=false){const value=petInteraction(),key=JSON.stringify([value.characterId,value.gestureId,value.phase,value.animationEpoch,value.animationWaiting,value.motion.animationEpoch,value.motion.animationWaiting,value.motion.mode,value.motion.button,value.motion.walkDirection,value.motion.pull,value.motion.anchor,value.motion.grounded]);if(force||key!==lastInteraction){lastInteraction=key;petEvent({kind:'interaction',value});updateTrajectory(value);}return value;}
function trajectoryColors(){const v=themeVariables(resolvedTheme(settings.preferences,themeCharacter)),strength={gentle:'轻柔力度',standard:'标准力度',strong:'强力力度',exaggerated:'夸张力度'}[settings.preferences.throwStrength]??'标准力度';return {band:v['--buddy-a2'],path:v['--buddy-bar-end'],surface:v['--buddy-surface'],text:v['--buddy-text'],track:v['--buddy-border'],shadow:v['--buddy-shadow'],strengthLabel:t(strength,settings.preferences.language)};}
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
  if(!trajectoryWindow.isDestroyed()&&!trajectoryWindow.webContents.isLoading())trajectoryWindow.webContents.send('pet:action',{kind:'trajectory',value,origin:trajectoryWindow.getBounds(),colors:trajectoryColors()});
}
function cancelGesture(reason='cancel'){
  const id=drag?.gestureId??null;drag=null;buttonObserver?.stop();petMotion?.cancel();
  petEvent({kind:'gesture-reset',gestureId:id,reason});petEvent({kind:'drag',active:false});
  if(pet&&!pet.isDestroyed())setGestureMode(gestureMode);publishInteraction(true);
}
const gestureMatches=message=>!!drag&&(drag.gestureId===null?message?.gestureId==null:message?.gestureId===drag.gestureId);
const touchExpressions=new PetTouchExpressions();
const savePreference=patch=>{void setPreferences(patch).catch(e=>audit({type:'settings-error',message:e.message}));};
// Missed plugin bubbles can be found again from the pet menu (approved design C11).
const recentPluginActivity=[];
function openSocialPluginPage(pluginId){const record=plugins?.snapshot?.().dsh?.installed?.find(value=>value.pluginId===pluginId&&value.enabled&&['@ai-buddy/bilibili-companion','@ai-buddy/qq-connect'].includes(value.packageName));const target=record&&Object.keys(EMBED_TARGETS).find(key=>EMBED_TARGETS[key].packageName===record.packageName);if(target&&embedCapable(target,record.exactVersion)){openPanel('plugin-'+target);return;}if(record)void plugins.action({action:'dsh-open-client',packageKey:record.packageKey}).catch(()=>openPanel('plugins'));else openPanel('plugins');}
// 「扫码连接」 on a plugin page (C-4, B7): the main window comes forward and shows its scan dialog over the page it is on.
// With no main window yet, it opens on the Extension Center; a page still loading takes the waiting request on its first read.
function openSocialLogin({platform,requestId,at}={}){if(!panel||panel.isDestroyed()){openPanel('plugins');return;}if(!panel.webContents.isLoading())panel.webContents.send('plugins:social-login',{platform,requestId,at});if(panel.isMinimized())panel.restore();panel.show();panel.focus();}
// C-1: faces for plugin pages. Built-ins are read once; custom characters' avatars are re-read at most every 15 s, and
// a change re-dresses the open pages.
let builtinPluginFaces=null,builtinPluginPortraits=null,customPluginFaces={},customFacesAt=0,customFacesBusy=false;
const pluginFaceMedia=createMediaStore(dataRoot),customFaceProcessor=createCustomFaceProcessor({readMedia:(name,max)=>readFaceFile(pluginFaceMedia.file(name),max),sizeMedia:name=>statSync(pluginFaceMedia.file(name)).size,image:nativeImage});
function pluginFaces(){builtinPluginFaces??=builtinFaces(build);void refreshCustomFaces();return {...builtinPluginFaces,...customPluginFaces};}
async function refreshCustomFaces(){if(customFacesBusy||!game||Date.now()-customFacesAt<15000)return;customFacesBusy=true;customFacesAt=Date.now();try{const value=await game.action('companion-state');const next=customFaceProcessor.faces(value?.companion?.characters);if(JSON.stringify(next)!==JSON.stringify(customPluginFaces)){customPluginFaces=next;void plugins?.refreshAppearance?.().catch(()=>{});}}catch{}finally{customFacesBusy=false;}}
async function petContextMenu(){let feeding=null;try{const result=await game?.action('companion-r95',{action:'view',args:{}});feeding=result?.companion?.r95?.feeding??null;}catch{}
 const language=settings.preferences.language,foods=feeding?(feeding.catalog??[]).filter(food=>(feeding.inventory?.[food.id]??0)>0).map(food=>({id:food.id,label:t(food.name,language)+' ×'+feeding.inventory[food.id]})):undefined;
 Menu.buildFromTemplate(petContextTemplate({language,asleep:['sleep-enter','asleep'].includes(activityClock.phase),showStatusBadge:settings.preferences.showStatusBadge,open:page=>openPanel(page),foods,feedTarget:feeding?.characterName??PET_CHARACTERS.find(c=>c.id===feeding?.activeScope?.characterId)?.name,fullness:feeding?.hunger?.satiety,canFeed:!!feeding?.activeScope&&!feeding?.paused&&(feeding?.hunger?.satiety??0)<100,feed:foodId=>void game?.action('companion-r95',{action:'feeding-feed',args:{foodId,requestId:globalThis.crypto.randomUUID()}}).catch(()=>{}),recent:recentPluginActivity.slice(),openRecent:row=>openSocialPluginPage(row.pluginId),sleep:()=>{if(activityClock.sleepNow())publishInteraction(true);},wake:()=>{activityClock.wake('menu');publishInteraction(true);},setStatusBadge:value=>savePreference({showStatusBadge:value}),hidePet:()=>savePreference({petVisible:false})})).popup({window:pet});}
// Renderer coordinates are accepted only by explicitly isolated simulation runs.
// Normal operation has one position writer: the main process OS DIP sampler.
const gesturePoint=message=>arg('cursor')==='manual'&&Number.isFinite(message?.x)&&Number.isFinite(message?.y)?{x:message.x,y:message.y}:screen.getCursorScreenPoint();
function internalActivity({id,active,activityOriginId}){activityClock.request(id,active,{originId:activityOriginId});petEvent({kind:'dialog',active:activityClock.busy.size>0||gameRequests>0});publishInteraction();}
function interactionMediaReady(id=petState.characterId??effectivePetCharacter()){return PET_INTERACTION_ACTIONS.every(a=>!!frameSequence(a.id,id)?.video?.src);}
function configurePetInteractions(){const speed=settings.preferences.animationSpeed??.75,media=interactionMediaReady(),character=petState.characterId??effectivePetCharacter();if(drag&&(!settings.preferences.petPhysics||!media)&&['charging','dragging'].includes(petMotion?.mode))cancelGesture('physics-disabled');petMotion?.configure({enabled:settings.preferences.petPhysics&&media,strength:settings.preferences.throwStrength,landDurationMs:getPetAction('land-recover',petState.characterId).cycleMs,speed,collisionInsets:petCollisionInsets(character,settings.preferences.petScale,CHARACTER_SEQUENCES[character])});activityClock.configure({enabled:settings.preferences.autoSleep&&media,durations:{enter:getPetAction('sleep-enter',petState.characterId).cycleMs,wake:getPetAction('wake',petState.characterId).cycleMs},speed});if(!media)activityClock.resume();publishInteraction(true);}
function effectivePetCharacter(){const target=resolvePetCharacter(settings.preferences,themeCharacter);if(!validPetCharacter(themeCharacter)&&settings.preferences?.petCharacterMode!=='fixed')return heldFollowCharacter??petState.characterId??resources.fallback('deepseek');const resolved=resources.fallback(target);if(resolved)heldFollowCharacter=resolved;return resolved;}
const actionIds=new Set([...PET_ACTIONS,...PET_INTERACTION_ACTIONS].map(a=>a.id));
function petEvent(value){if(pet&&!pet.isDestroyed())pet.webContents.send('pet:action',value);}
function playPet(request){const value=validatePetPlayback({...request,characterId:request?.characterId??petState.characterId??resolvePetCharacter(settings.preferences,themeCharacter)});resources.require([value.characterId]);if(PET_INTERACTION_ACTIONS.some(a=>a.id===value.id)&&!frameSequence(value.id,value.characterId)?.video?.src)throw Error('该角色的新互动动作尚未完成审核');petEvent({kind:'play',...value});audit({type:'pet-manual-action',id:value.id,lookIndex:value.lookIndex,characterId:value.characterId});return {ok:true,...value};}
function petAuto(){petEvent({kind:'auto'});return {ok:true};}
function triggerPet(id,source='event',durationMs=null){petEvent({kind:'trigger',id,source,...(durationMs===null?{}:{durationMs})});}
function feedback(value){activityClock.wake('feedback',{originId:value.activityOriginId});publishInteraction();if(settings.preferences?.petVisible!==false)petEvent({kind:'feedback',value});}
function chatFeedback(value){if(!game?.hasCharacter?.(value.characterId)||!validEmotion(value.emotion))return;feedback({eventId:value.messageId,id:EMOTIONS[value.emotion]?.actionId??null,source:'dialog',origin:value.requestId?'chat':'story',provider:provider?.currentKind??'codex',sessionKey:'whale-companion-local',turnKey:value.requestId??value.messageId,characterId:value.characterId,role:'heroine',emotion:value.emotion,emotionSource:value.emotionSource??'story-label',sequence:value.sequence,text:shortReply(value.text),cycles:1});}
function chatCommitted(value){if(panel&&!panel.isDestroyed())panel.webContents.send('game:chat-committed',value);chatFeedback(value);}
app.on('second-instance',()=>{petDiagnostics?.reason('second-instance');petDiagnostics?.record('second-instance');audit({type:'second-instance'});reopenRequested=true;if(app.isReady()&&(game||startupFailure))openPanel(game?'overview':'safe-mode',false);});

// Life archives store pictures as PNG/JPEG/WebP. A GIF (first frame), SVG or other
// format is rasterized here: nativeImage first, otherwise Chromium in a hidden
// sandboxed window with an in-memory session and no node access.
async function rasterizeImage(dataUrl){
 const direct=nativeImage.createFromDataURL(dataUrl);if(!direct.isEmpty())return direct.toPNG();
 const view=new BrowserWindow({show:false,width:64,height:64,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'ai-buddy-rasterize',offscreen:true}});
 let timer;
 try{
  await view.loadURL('about:blank');
  const draw=view.webContents.executeJavaScript(`new Promise((done,fail)=>{const img=new Image();img.onload=()=>{const w=img.naturalWidth||1024,h=img.naturalHeight||1024,scale=Math.min(1,4096/Math.max(w,h)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(w*scale));c.height=Math.max(1,Math.round(h*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);done(c.toDataURL('image/png'));};img.onerror=()=>fail(new Error('decode'));img.src=${JSON.stringify(dataUrl)};})`,true);
  const png=await Promise.race([draw,new Promise((_,fail)=>{timer=setTimeout(()=>fail(Error('rasterize timeout')),30000);})]);
  return Buffer.from(String(png).split(',')[1]??'','base64');
 }finally{clearTimeout(timer);if(!view.isDestroyed())view.destroy();}
}
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
function serializeSettings(run){const result=settingsWriteTail.then(run);settingsWriteTail=result.catch(()=>{});return result;}
function saveSettings(){return serializeSettings(()=>settingsStore.writeText(JSON.stringify(settings)));}
function settingsView(){return {startupFailure,safeMode:!!startupFailure,interactionMedia:Object.fromEntries(resources.status().characters.map(c=>[c.id,interactionMediaReady(c.id)])),resources:resources.status(),effectivePetCharacter:effectivePetCharacter(),petResourceNotice:validPetCharacter(themeCharacter)?null:'当前角色没有桌宠资源，保留当前桌宠',preferences:{...settings.preferences},themeCharacter,petCharacterId:petState.characterId??resources.fallback('deepseek'),version:appVersion,build:build.split(/[\\/]/).at(-1),dataRoot,logRoots,tokenSources,defaultModel:provider?.defaultModel,modelConnections:provider?.state?connectionView(provider):null,cgConnections:cg?.state?connectionView(cg):null,systemTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,monitorAppliedInterval};}
// a stop the user asked for (companion-chat-cancel) is not a chat failure
const userStopped=message=>/用户停止回复$/.test(String(message??''));
function broadcastSettings(){const value=settingsView();for(const win of [pet,panel])if(win&&!win.isDestroyed())win.webContents.send('settings:update',value);void plugins?.refreshAppearance?.().catch(()=>{});return value;}
function saveConnection(service,draft){
  // An unusable edit must not overwrite the currently selected profile before
  // the subsequent activation can reject it. This check performs no request.
  if(draft?.useAfterSave===true&&draft.id===service.state.activeId)service.materialize(service.draftProfile(draft));
  return service.save(draft);
}
// Panel, taskbar and tray wear the current pet's round head; the pet window keeps the app icon.
function syncBrandIcons(){const id=brandPetCharacter({shown:!!pet&&!pet.isDestroyed()&&pet.isVisible(),reported:petState.characterId,target:effectivePetCharacter()}),icons=brandIcons(build,id);if(panel&&!panel.isDestroyed())panel.setIcon(icons?.window??appIcon);if(tray&&!tray.isDestroyed()&&arg('rig')!=='working'){tray.setImage(icons?.tray??appIcon.resize({width:32,height:32}));tray.setToolTip(brandTooltip(id,settings.preferences?.language));}}
function updateTray(){
  if(!tray)return;
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate({language:settings.preferences.language,petVisible:settings.preferences.petVisible,gestureMode,open:page=>openPanel(page),setPetVisible:value=>savePreference({petVisible:value}),setGestureMode:value=>{setGestureMode(value);updateTray();},quit:()=>{void shutdown();}})));
}
function petVisibilityState(){return petVisibility({userVisible:settings.preferences?.petVisible,assetsReady:petAssetsReady,fullscreen:fullscreenHidden,quitting});}
function applyPetVisibility(greet=true){
 if(!pet||pet.isDestroyed())return;
 const {visible,hiddenReasons}=petVisibilityState();
 if(visible===pet.isVisible())return;
 petDiagnostics?.reason(visible?'visibility-restore':hiddenReasons[0]);
 if(visible){pet.showInactive();if(greet)triggerPet('wave','show');void deliverKeptLine();}
 else{if(!fullscreenHidden)petAuto();pet.hide();}
}
function closePetFullscreen(){fullscreenObserver?.close();fullscreenObserver=null;fullscreenPolicy.reset();}
function syncPetFullscreenObserver(){
 if(process.platform!=='win32'||!settings.preferences?.petHideOnFullscreen){closePetFullscreen();return;}
 if(fullscreenObserver||!pet||pet.isDestroyed())return;
 const handle=petDiagnostics.snapshot().nativeHandle;
 if(!handle)return;
 fullscreenObserver=createPetFullscreenObserver({path:join(build,'pet-fullscreen.exe'),handle,onSample:fullscreenPolicy.observe,onError:()=>{fullscreenPolicy.reset();audit({type:'pet-fullscreen-observer-unavailable'});}});
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
  applyPetTopmost(pet,settings.preferences.alwaysOnTop);
  configurePetInteractions();
  syncPetFullscreenObserver();applyPetVisibility();
  setGestureMode(gestureMode);updateTray();
}
// Approved design C8: a line kept while neither the pet nor the main window could show it appears on the pet once
// the pet is back (it is still read only through speech-read; the Galgame shows the same stored line).
async function deliverKeptLine(){try{const result=await game?.action('companion-r95',{action:'view',args:{}}),view=result?.companion?.r95??result?.r95Result,line=(view?.lines??[]).find(row=>row?.status!=='read'&&typeof row.text==='string');if(line&&pet&&!pet.isDestroyed()&&pet.isVisible()&&petState.characterId===view.scope?.characterId)petEvent({kind:'social-line',value:{...line,scope:view.scope}});}catch{}}
async function syncPetVisibility(visible){return serializeSettings(async()=>{
  if(!settings.preferences)return;
  settings.preferences={...settings.preferences,petVisible:visible};
  applyPetPreferences();await settingsStore.writeText(JSON.stringify(settings));broadcastSettings();
});}
function setPreferences(patch,{allowUnavailable=false}={}){
  let valid;try{valid=validatePreferencesPatch(patch);}catch(error){return Promise.reject(error);}
  const chatChanged=Object.hasOwn(valid,'chatEnabled');
  if(chatChanged&&(quitting||shuttingDown))return Promise.reject(Error('正在退出，请稍后再修改联网聊天设置'));
  const run=settingsTail.then(async()=>{
    if(chatChanged)assertImportIdle();
    const next={...settings.preferences,...valid},resize=next.petScale!==settings.preferences.petScale;
    if(valid.petFixedCharacter)resources.require([valid.petFixedCharacter]);
    if(resize&&drag)throw new Error('请先松开桌宠，再调整大小');
    if(next.petVisible!==settings.preferences.petVisible)await game?.action('pet-set',{enabled:next.petVisible});
    const previousPet=effectivePetCharacter();
    if(chatChanged)await chatPreferences.save(valid,{allowUnavailable});else settings.preferences=next;
    if(effectivePetCharacter()!==previousPet){cancelGesture('character-change');activityClock.resume();}applyChrome();applyPetPreferences(resize);
    worker?.postMessage({type:'configure',refreshIntervalMs:next.monitorRefreshMs,statisticsTimeZone:next.statisticsTimeZone,autoPriceUpdates:next.autoPriceUpdates});
    if(!chatChanged)await saveSettings();audit({type:'settings-changed',keys:Object.keys(valid)});return broadcastSettings();
  });settingsTail=run.catch(()=>{});return run;
}
async function settingsAction(action){
  if(action==='defaults')return setPreferences({...DEFAULT_PREFERENCES},{allowUnavailable:true});
  if(action==='reset-position'){
    cancelGesture('reset-position');
    const area=screen.getPrimaryDisplay().workArea,size=petSize(settings.preferences.petScale);
    settings.petBounds=clamp(petBounds({x:area.x+area.width-size.width-20,y:area.y+area.height-size.height-20},settings.preferences.petScale));
    positionPet(pet,settings.petBounds,settings.preferences.petScale);petMotion?.recover(settings.petBounds);publishInteraction(true);await saveSettings();audit({type:'pet-position-reset',bounds:settings.petBounds});return broadcastSettings();
  }
  if(action==='refresh'){worker?.postMessage({type:'refresh'});return settingsView();}
  throw new Error('未知设置操作');
}
function applyChrome(character){if(character&&character!==themeCharacter){const previousPet=effectivePetCharacter();themeCharacter=character;if(effectivePetCharacter()!==previousPet)cancelGesture('character-change');if(settings.preferences?.petCharacterMode!=='fixed'){activityClock.resume();publishInteraction(true);}broadcastSettings();}setLocale(settings.preferences?.language);if(panel&&!panel.isDestroyed()){panel.setTitle(workspaceTitle());const theme=resolvedTheme(settings.preferences,themeCharacter);panel.setBackgroundColor(windowBackground(theme));if(process.platform==='win32')panel.setTitleBarOverlay({color:chromeColor(theme),symbolColor:chromeSymbolColor(theme),height:34});}syncBrandIcons();if(tray)updateTray();}
let themeCharacter=resources.fallback('deepseek');
function openPanel(page='overview',focus=true) {
  petDiagnostics?.reason('open-panel');petDiagnostics?.record('panel-open');
  if(page==='sessions')page='overview';
  if(!panel || panel.isDestroyed()) {
    panel=new BrowserWindow({width:1180,height:820,minWidth:900,minHeight:650,title:workspaceTitle(),icon:appIconPath,backgroundColor:windowBackground(resolvedTheme(settings.preferences,themeCharacter)),show:false,
      ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:chromeColor(resolvedTheme(settings.preferences,themeCharacter)),symbolColor:chromeSymbolColor(resolvedTheme(settings.preferences,themeCharacter)),height:34},accentColor:false}:{}),
      webPreferences:{preload:join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'whale-memory'}});
    brandWindow(panel);applyChrome();
    if(cardQuiet&&!cardRehearsal){
      panel.webContents.on('before-input-event',(_,input)=>{if(input.type==='keyDown')handoffCardVerification();});
      panel.webContents.on('before-mouse-event',(_,input)=>{if(input.type==='mouseDown')handoffCardVerification();});
    }
    lockPageZoom(panel,error=>audit({type:'zoom-policy-error',message:error.message}));
    panel.setMenuBarVisibility(false);syncBrandIcons();panel.loadFile(join(build,'index.html'),{hash:page,...previewQuery,query:{...previewQuery.query,theme:resolvedTheme(settings.preferences,themeCharacter),petCharacter:resources.fallback(resolvePetCharacter(settings.preferences,themeCharacter))}});
    panel.on('close',event=>{if(!quitting){event.preventDefault();if(onboarding){void shutdown();return;}void voiceHost?.action('stop').catch(error=>audit({type:'voice-panel-stop',code:error.code}));petAuto();panel.hide();}});
    // Lets the panel release heavy media (action gallery decoders, stills) while hidden.
    for(const [name,visible] of [['hide',false],['show',true]])panel.on(name,()=>{if(panel&&!panel.isDestroyed())panel.webContents.send('panel:visibility',{visible});});
    panel.on('hide',()=>pluginEmbed?.release());for(const name of ['minimize','restore'])panel.on(name,()=>pluginEmbed?.refresh());panel.on('show',()=>{try{assertImportIdle();pluginEmbed?.resume();}catch{}});
    panel.on('closed',()=>pluginEmbed?.release());panel.webContents.on('did-start-navigation',details=>{if(details?.isMainFrame&&!details.isSameDocument)pluginEmbed?.rendererReset();});
    panel.once('ready-to-show',()=>focus?panel.show():panel.showInactive());
    panel.webContents.setWindowOpenHandler(pluginWindowOpenHandler({openExternal:url=>shell.openExternal(url),isClosed:()=>!panel||panel.isDestroyed()}));
    panel.webContents.on('console-message',(event,...args)=>{if(event.level==='error'||args[0]===3)pushBounded(rendererErrors,event.message || args[1]);});
  } else {panel.webContents.send('panel:page',page);focus?panel.show():panel.showInactive();}
}
function publish(value) {
  if(quitting)return;
  snapshot=value;
  activityClock.observeExternal({...value,activitySummary:game?.r95?.origins.summary()});publishInteraction();
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
ipcMain.handle('settings:set',(_,patch)=>updateGuard('storage',()=>setPreferences(patch)));
ipcMain.handle('settings:action',(_,action)=>updateGuard('storage',()=>settingsAction(action)));
ipcMain.handle('updates:action',async(event,command,value)=>{
  if(event.sender!==panel?.webContents||event.senderFrame!==panel.webContents.mainFrame||!updateCommands.has(command))throw Error('Invalid update request');
  if(!appUpdates)return {__buddyError:true,code:'APP_UPDATE_UNAVAILABLE',message:'APP_UPDATE_UNAVAILABLE'};
  try{
    if(command==='manual-help'){await shell.openExternal(bootstrapUrl);return appUpdates.view();}
    return await appUpdates.action(command,value);
  }catch(error){const code=error.code??'APP_UPDATE_FAILED';return {__buddyError:true,code,message:code};}
});
ipcMain.handle('pet:play',(_,request)=>playPet(request));
ipcMain.handle('pet:auto',()=>petAuto());
ipcMain.handle('pet:state',()=>petState);
ipcMain.on('pet:state',(event,value)=>{if(event.sender!==pet?.webContents||!actionIds.has(value?.id))return;const previous=petState.characterId;petState={socialPresentation:value.socialPresentation===true,id:value.id,source:String(value.source||'monitor').slice(0,20),manual:value.manual===true,expiresAt:Number.isFinite(value.expiresAt)?value.expiresAt:null,characterId:validPetCharacter(value.characterId)?value.characterId:'deepseek'};if(panel&&!panel.isDestroyed())panel.webContents.send('pet:state',petState);if(previous!==petState.characterId){configurePetInteractions();broadcastSettings();syncBrandIcons();}});
async function manageResources(characterId){
  const manager=resources.manager();if(!manager)throw Error('请下载此版本的在线安装器进行管理 / Download this version’s installer to manage resources');
  const ids=(Array.isArray(characterId)?characterId:[characterId]).filter(Boolean);if(ids.some(id=>!validPetCharacter(id)))throw Error('Unknown character');
  const en=settings.preferences?.language==='en';
  const answer=await dialog.showMessageBox(panel??pet,{type:'question',title:'AI Buddy',message:en?'Open the resource manager? Downloads start only after you click Install.':'打开角色资源管理器？点击安装后才会下载。',buttons:en?['Open','Cancel']:['打开','取消'],defaultId:0,cancelId:1});
  if(answer.response!==0)return {cancelled:true};
  const child=spawn(manager,['--root='+root,...(ids.length?['--characters-add='+ids.join(',')]:[])],{detached:true,stdio:'ignore'});await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});child.unref();return {ok:true};
}
ipcMain.handle('resources:status',()=>resources.status(true));
ipcMain.handle('resources:manage',(_,id)=>updateGuard('storage',()=>manageResources(id)));
ipcMain.handle('data-import:state',()=>dataImport?.state()??{onboarding,phase:'idle',canCancel:false});
ipcMain.handle('data-import:choose',()=>dataImport.choose());
ipcMain.handle('data-import:preview',(_,args)=>dataImport.preview(args));
ipcMain.handle('data-import:start',(_,args)=>updateGuard('data',()=>dataImport.start(args)));
ipcMain.handle('data-import:cancel',async(_,args)=>{const value=await dataImport.cancel(args);if(onboarding&&!value.cancelling)setTimeout(()=>{void shutdown();},100);return value;});
ipcMain.handle('data-import:create-new',()=>updateGuard('data',()=>dataImport.createNew()));
ipcMain.handle('data-import:resume-work',()=>updateGuard('data',()=>dataImport.resumeWork()));
function assertImportIdle(){if(importBarrier)throw Error('正在导入资料，请先完成或取消导入');}
ipcMain.handle('agents:action',async(event,action,payload)=>{if(event.sender!==panel?.webContents)throw Error('Invalid workspace sender');assertImportIdle();if(!agents)throw Error('工作插件入口尚未就绪');try{return await updateGuard('work',()=>agents.legacyAction(action,payload??{}));}catch(error){return {__buddyError:true,message:error.message,code:error.code,details:error.details};}});
ipcMain.handle('agents:choose-workspace',async event=>{if(event.sender!==panel?.webContents)throw Error('Invalid workspace sender');assertImportIdle();if(!agents?.status().enabled)throw Object.assign(Error('请先安装并启用工作与协作插件'),{code:'WORK_PLUGIN_REQUIRED'});const result=await dialog.showOpenDialog(panel,{title:t('选择工作项目目录'),properties:['openDirectory']});return result.canceled?null:result.filePaths[0];});
ipcMain.handle('work:status',event=>{if(event.sender!==panel?.webContents)throw Error('Invalid workspace sender');return agents?.status()??{state:'not-ready',installed:false,enabled:false};});
ipcMain.handle('work:open',async event=>{if(event.sender!==panel?.webContents)throw Error('Invalid workspace sender');assertImportIdle();try{return await agents.open();}catch(error){return {__buddyError:true,message:error.message,code:error.code};}});
ipcMain.handle('voice:action',async(event,op,payload)=>{
 if(!trustedVoiceSender(event,panel))throw Error('Invalid voice sender');
 assertImportIdle();if(!voiceHost)return {__buddyError:true,code:'VOICE_HOST_UNAVAILABLE',message:'语音服务尚未就绪'};
 try{
  // Existing capture/audio must settle even after the updater reserves new work.
  const continuing=['state','profiles','cloud-status','cloud-prepare-preview','cloud-batch-preview','cloud-batch-reconcile','cloud-batch-cancel','assets-cancel','capture-feed','capture-finish','receipt','stop'].includes(op);
  const result=await (continuing?voiceHost.action(op,payload):updateGuard('voice',()=>voiceHost.action(op,payload)));
  return op==='state'?{...result,cardVoiceMix}:result;
 }catch(error){return {__buddyError:true,code:error.code??'VOICE_FAILED',message:String(error.message).slice(0,400)};}
});
ipcMain.handle('plugins:action',async(event,request)=>{if(event.sender!==panel?.webContents)throw Error('Invalid extension sender');assertImportIdle();return pluginActionResult(plugins,request);});
// Plugin pages inside the main window: only the main window's own page may place, cover or move them.
ipcMain.handle(EMBED_CHANNEL,async(event,request)=>{if(event.sender!==panel?.webContents||event.senderFrame!==panel.webContents.mainFrame)throw Error('Invalid embed sender');if(!pluginEmbed)return {__buddyError:true,code:'PLUGIN_EMBED_UNAVAILABLE',message:'插件页面还没准备好'};try{if(!['state','slot','cover','capture'].includes(request?.op))assertImportIdle();return await pluginEmbed.handle(request);}catch(error){return {__buddyError:true,code:error.code??'PLUGIN_EMBED_FAILED',message:error.message};}});
ipcMain.handle('plugins:choose',async event=>{if(event.sender!==panel?.webContents)throw Error('Invalid extension sender');assertImportIdle();if(!plugins)throw Error('扩展服务尚未就绪');const result=await dialog.showOpenDialog(panel,{title:t('选择签名离线扩展目录'),properties:['openDirectory']});return result.canceled?null:plugins.prepareOffline(result.filePaths[0]);});
// Extensions (B6, B1, B3): the signed plugin file, favourites files and the Work engine list. Paths only ever come from the host's own dialogs.
ipcMain.handle('plugins:choose-package',async event=>{if(event.sender!==panel?.webContents)throw Error('Invalid extension sender');assertImportIdle();if(!plugins)throw Error('扩展服务尚未就绪');const result=await dialog.showOpenDialog(panel,{title:t('选择插件包文件'),properties:['openFile'],filters:[{name:t('AI Buddy 插件包'),extensions:[OFFLINE_BUNDLE_EXTENSION,'tgz']}]});if(result.canceled)return {cancelled:true};return pluginActionResult({action:()=>plugins.prepareDshOffline(result.filePaths[0])},{});});
ipcMain.handle('plugins:preferences-file',async(event,mode)=>{if(event.sender!==panel?.webContents)throw Error('Invalid extension sender');assertImportIdle();if(!plugins)throw Error('扩展服务尚未就绪');if(mode==='export'){const value=await pluginActionResult(plugins,{action:'community-export-preferences'});if(value?.error)return value;const result=await dialog.showSaveDialog(panel,{title:t('导出收藏与关注'),defaultPath:'ai-buddy-favorites.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled)return {cancelled:true};writeFileSync(result.filePath,JSON.stringify(value,null,2),'utf8');return {saved:true};}if(mode!=='import')throw Error('Invalid favourites file mode');const result=await dialog.showOpenDialog(panel,{title:t('导入收藏与关注'),properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});if(result.canceled)return {cancelled:true};return pluginActionResult({action:async()=>plugins.action({action:'community-import-preferences',value:await readPreferencesFile(result.filePaths[0])})},{});});
ipcMain.handle('plugins:work-engines',event=>{if(event.sender!==panel?.webContents)throw Error('Invalid extension sender');return detectWorkEngines({root,connections:provider?.view?.().profiles??[]});});
ipcMain.handle('chat:status',()=>provider.status());
ipcMain.handle('chat:enabled',(_,enabled)=>updateGuard('storage',async()=>{assertImportIdle();await setPreferences({chatEnabled:enabled});audit({type:'chat-enabled',enabled:provider.enabled});return provider.status();}));
ipcMain.handle('models:get',()=>connectionView(provider));
ipcMain.handle('models:save',(_,draft)=>saveConnection(provider,draft));
ipcMain.handle('models:delete',(_,id)=>provider.remove(id));
ipcMain.handle('models:activate',(_,id)=>provider.activate(id));
// Listing belongs to the editor draft; Cancel must not replace a saved route's catalog.
ipcMain.handle('models:list',(_,draft)=>provider.fetchModels(draft));
ipcMain.handle('models:test',(_,draft)=>updateGuard('chat',()=>provider.test(draft)));
ipcMain.handle('cg:get',()=>connectionView(cg));
ipcMain.handle('cg:save',(_,draft)=>saveConnection(cg,draft));
ipcMain.handle('cg:delete',(_,id)=>cg.remove(id));
ipcMain.handle('cg:activate',(_,id)=>cg.activate(id));
ipcMain.handle('cg:enabled',(_,enabled)=>cg.setEnabled(enabled===true));
ipcMain.handle('cg:list',async(_,draft)=>{const models=await cg.fetchModels(draft);if(draft.id)await cg.saveModels(draft.id,models);return models;});
ipcMain.handle('cg:check',(_,draft)=>updateGuard('cg',()=>cg.test(draft)));
ipcMain.handle('cg:test-image',(_,draft)=>{assertImportIdle();return updateGuard('cg',()=>cg.testImage(draft));});
ipcMain.handle('cg:resume',async(_,id)=>{assertImportIdle();try{return {ok:true,job:await updateGuard('cg',()=>cg.resume(id))};}catch(error){return {ok:false,error:error.message};}});
ipcMain.handle('cg:image',(_,id)=>{const job=cg.assertReadableJob(id);if(!job?.assetRef)throw Error('CG 尚未完成');return {dataUrl:cg.readAsset(job.assetRef)};});
ipcMain.handle('game:action',async(event,action,args)=>{
  if(action==='companion-r95'&&args?.action==='owner-bind'&&event.sender!==panel?.webContents)throw Error('主人绑定只能由本体设置页确认');
  if(typeof action!=='string')throw new Error('Invalid action');
  if(importBarrier&&!gameReads.has(action))assertImportIdle();
  if(!game)return {ok:false,code:'COMPANION_SAFE_MODE',error:'陪伴功能启动失败，已进入安全模式：'+(startupFailure?.message??'尚未就绪')};
  const dialog=provider.enabled&&['chat','side-story','side-story-free-reply','companion-group-send','companion-group-continue'].includes(action);
  const release=gameReads.has(action)||gameStops.has(action)||action==='companion-r95'&&['auto-pause','auto-stop'].includes(args?.action)?null:updateReservation.enter(dialog?'chat':'storage');
  if(dialog){gameRequests++;petEvent({kind:'dialog',active:true});}
  // R13: per-action counts while a diagnostic sample runs (measureDesktopDiagnostic is a pass-through otherwise).
  // Use the count only: the time covers just the synchronous start of the async action.
  const counted='game-action:'+(/^[a-z0-9-]{1,48}$/.test(action)?action:'other')+(action==='companion-r95'&&/^[a-z0-9-]{1,32}$/.test(String(args?.action??''))?':'+args.action:'');
  try{const result=await measureDesktopDiagnostic('game-ipc-dispatch',()=>measureDesktopDiagnostic(counted,()=>game.action(action,args||{})));if(dialog&&result?.ok===false&&result.code!=='CHARACTER_NOT_INSTALLED'&&!userStopped(result.error?.message??result.message))feedback({id:'fail',source:'chat-error',text:'聊天暂时失败，请重试。',cycles:1});
    // A line read on the pet or in the main window closes it in the other place too (approved design C8).
    if(action==='companion-r95'&&args?.action==='speech-read'&&result?.ok!==false){petEvent({kind:'social-line-read',messageId:args.args?.messageId});if(panel&&!panel.isDestroyed())panel.webContents.send('game:output',{type:'social.updated'});}
    return result;}
  catch(error){if(dialog&&!userStopped(error?.message??error))feedback({id:'fail',source:'chat-error',text:'聊天暂时失败，请重试。',cycles:1});throw error;}
  finally{release?.();if(dialog){gameRequests--;petEvent({kind:'dialog',active:gameRequests>0||activityClock.busy.size>0});}}
});
ipcMain.handle('pet:story-feedback',(event,value)=>{if(event.sender!==panel?.webContents||!game?.hasCharacter?.(value?.characterId)||!validEmotion(value.emotion)||typeof value.text!=='string'||value.text.length>4000)return false;chatFeedback({...value,messageId:'story:'+String(value.messageId).slice(0,160)});return true;});
ipcMain.on('panel:open',(event,page)=>{
  if(typeof page==='string'&&page.startsWith('social-plugin:')){
    if(event.sender!==pet?.webContents)return;
    openSocialPluginPage(page.slice('social-plugin:'.length));
    return;
  }
  openPanel(page);
});
ipcMain.on('pet:hit',(_,hit)=>{lastPetHit=!!hit;if(!drag && pet && !pet.isDestroyed())setGestureMode(gestureMode);});
ipcMain.on('pet:drag-start',(event,message)=>{
 if(event.sender!==pet?.webContents||!petMotion||drag)return;
 const gestureId=typeof message?.gestureId==='string'?message.gestureId.slice(0,120):null,cursor=gesturePoint(message),bounds=pet.getContentBounds();
 // Preserve the point actually grabbed, even if the cursor has already moved
 // while pointer-down crosses IPC. This local offset never positions a window.
 const local=message?.local,point=Number.isFinite(local?.x)&&Number.isFinite(local?.y)&&local.x>=0&&local.x<=1&&local.y>=0&&local.y<=1?{x:bounds.x+local.x*bounds.width,y:bounds.y+local.y*bounds.height}:cursor;
 const button=message?.button??0;if(button!==0&&button!==2)return;
 // begin() publishes synchronously. Establish wake intent before that first
 // pressed snapshot, and keep it attached to this gesture until release.
 const wakeOnly=activityClock.wake('touch');
 petMotion.bounds={...bounds};const begin=petMotion.begin(point,{button});
 const capturedAt=Date.now();
 drag={gestureId,button,origin:point,moved:false,characterId:petState.characterId??effectivePetCharacter(),personaId:game?.context?.().personaId,eventId:'touch:'+process.pid+':'+capturedAt+':'+begin.serial,capturedAt,caught:begin.caught,wakeOnly};
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
 if(result.touch){activityClock.activity('touch');const playExpression=!captured.wakeOnly,id=playExpression?touchExpressions.next(captured.characterId):null;petEvent({kind:'feedback',value:{id,source:'touch',cycles:1,eventId:captured.eventId,gestureId:captured.gestureId,capturedAt:captured.capturedAt,confirmedAt:Date.now(),characterId:captured.characterId,playExpression}});const awarded=await game?.touch?.({characterId:captured.characterId,personaId:captured.personaId,eventId:captured.eventId});audit({type:'pet-touch',characterId:captured.characterId,personaId:captured.personaId,expression:id,playExpression,awarded:awarded?.awarded??false,reason:awarded?.reason});}
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
 if(!matchesInteractionReady(petInteraction(),value))return;
 const clock=value.scope==='motion'?petMotion:activityClock;if(!clock)return;
 if(value.failed){audit({type:'interaction-media-error',id:value.id,characterId:value.characterId});if(value.scope==='motion')petMotion.stop();else activityClock.resume();}
 else if(!clock.markReady(value.epoch))return;
 publishInteraction(true);
});

const control=createLocalControlServer({
  onSocketError:error=>audit({type:'control-client-error',code:error.code || 'UNKNOWN'}),
  onRequest:async request=>{
      let result;
      if(request.command==='snapshot')result={processId:process.pid,singleInstance:app.hasSingleInstanceLock(),snapshot,settings:settingsView(),petAction:petState,chat:{enabled:provider?.enabled || false,model:provider?.defaultModel},petBounds:pet?.getBounds(),petContentBounds:pet?.getContentBounds(),petVisible:pet?.isVisible(),petAssetsReady,petAlwaysOnTop:pet?.isAlwaysOnTop(),petInteraction:{gestureMode,lastPetHit,ignoringMouse,dragging:!!drag,...petInteraction()},displays:screen.getAllDisplays().map(d=>({workArea:d.workArea,scaleFactor:d.scaleFactor})),build,dataRoot};
      else if(request.command==='diagnostics-monitor-profile')result=await monitorProfile.handle(request);
      else if(request.command==='diagnostics-main-profile')result=await mainProfile.handle(request);
      else if(request.command==='installation-status'){
        const updateBusy=updateReservation.status(),reasons=updateBusy.reasons.filter(row=>row.capability!=='data');
        result={version:appVersion,root,build,dataRoot,processId:process.pid,ready:(!!game||!!startupFailure)&&petAssetsReady,onboarding,safeMode:!!startupFailure,startupFailure,
          busy:reasons.length>0,reasons,updateBusy,resources:resources.status(),components:{extensions:extensionComponentStatus(plugins?.snapshot())}};
      }
      else if(request.command==='local-card-status'&&localCardBuild){
        const installed=(plugins?.snapshot()?.dsh?.installed??[]).map(({packageKey,packageName,exactVersion,enabled,runtimeVerified,sourceId,sourceDigest,phase})=>({packageKey,packageName,exactVersion,enabled,runtimeVerified,sourceId,sourceDigest,phase}));
        const view=game?.viewState();
        result={quiet:cardQuiet,installed,embed:pluginEmbed?.snapshot(),counts:view&&{characters:view.characters.length,personas:view.personas.length,conversations:view.conversations.length,messages:view.conversations.reduce((n,row)=>n+row.messageCount,0),groups:view.groups.length,connections:provider.state.profiles.length,cg:cg.jobs.filter(row=>!row.deletedAt).length},sidebar:panel&&!panel.isDestroyed()?await panel.webContents.executeJavaScript(`Array.from(document.querySelectorAll('nav button')).some(b=>['一起玩牌','Card table'].includes(b.innerText.trim()))`):false};
      }
      else if(request.command==='data-import-state')result=dataImport?.state();
      else if(['installation-reserve','installation-release','installation-quit'].includes(request.command)){
        if(request.expectedBuild!==build)result={ok:false,error:'Different installation'};
        else if(request.command==='installation-release'){
          result={ok:request.expectedProcessId===process.pid&&updateReservation.release(request.reservationId)};
        }else if(request.command==='installation-reserve'||request.reservationId!==undefined){
          if(request.expectedProcessId!==process.pid||!appUpdates?.permitsReservation(request.reservationId)||quitting||shuttingDown)result={ok:false,error:'Invalid update owner'};
          else if(request.command==='installation-reserve')result=updateReservation.reserve(request.reservationId);
          else{
            result=updateReservation.commit(request.reservationId);
            if(result.ok)setTimeout(()=>{void shutdown(true);},100);
          }
        }else if(updateReservation.active()||updateReservation.status().reasons.some(row=>row.capability!=='data'))result={ok:false,busy:true};
        else{result={ok:true};setTimeout(()=>{void shutdown();},100);}
      }
      else if(request.command==='resources-status')result=resources.status(true);
      // One-time repairs: plan is read-only; apply needs the planId the user confirmed.
      else if(request.command==='maintenance-plan'){if(!game)throw Error('陪伴功能未启动');result=game.maintenance.plan(request.task);}
      else if(request.command==='maintenance-apply'){if(!game)throw Error('陪伴功能未启动');if(gameRequests||provider?.status().busy||cg?.status().busy||updateReservation.active())result={ok:false,busy:true};else result=await updateGuard('storage',()=>game.maintenance.apply(request.task,request.planId));}
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
      else if(request.command==='validation-pet-window'&&arg('validation')==='1')result={state:petDiagnostics?.snapshot(),recent:petDiagnostics?.recent()};
      else if(request.command==='validation-desktop-evidence'&&arg('validation')==='1'&&/^ub207r1-[a-z0-9-]+$/.test(arg('pipe')??'')&&arg('data')){
        if(request.op==='start'){
          startDesktopSample(request.phase);
          await panel?.webContents.executeJavaScript(`(()=>{window.buddyDesktopSample?.observer?.disconnect();const row={count:0,maxMs:0};if(PerformanceObserver.supportedEntryTypes.includes('longtask')){row.observer=new PerformanceObserver(list=>{for(const e of list.getEntries()){row.count++;row.maxMs=Math.max(row.maxMs,e.duration);}});row.observer.observe({type:'longtask'});}window.buddyDesktopSample=row;})()`).catch(()=>{});
          result={ok:true};
        }else if(request.op==='stop'){
          const main=stopDesktopSample();
          const renderer=await panel?.webContents.executeJavaScript(`(()=>{const row=window.buddyDesktopSample;if(!row)return null;row.observer?.disconnect();delete window.buddyDesktopSample;return {longTasks:row.count,maxMs:row.maxMs};})()`).catch(()=>null);
          result={main,renderer,processes:app.getAppMetrics().map(({type,cpu,memory})=>({type,cpuPercent:cpu.percentCPUUsage,workingSetKiB:memory.workingSetSize}))};
        }else if(request.op==='window'){
          const state=petDiagnostics?.snapshot();
          result={state,native:await readPetFullscreenSnapshot({path:join(build,'pet-fullscreen.exe'),handle:state?.nativeHandle}),recent:petDiagnostics?.recent().slice(-24)};
        }else throw Error('Invalid desktop evidence operation');
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
        const completed=request.kind==='completed';feedback({eventId:'validation:'+String(request.id??Date.now()),id:completed?'jump':'fail',source:request.kind,provider:'validation',text:TOOL_NAMES[request.tool]?TOOL_NAMES[request.tool]+(completed?'完成任务啦，辛苦了～':'日志记录了错误，点我查看。'):completed?'本地验证：任务完成':'本地验证：任务失败',cycles:completed?2:1});result={ok:true};
      }
      else if(request.command==='pet-play')result=playPet(request.action);
      else if(request.command==='pet-auto')result=petAuto();
      else if(request.command==='settings-get')result=settingsView();
      else if(request.command==='quota-action')result=await quotas.action(request.action,request.args);
      else if(request.command==='token-action')result=await tokenAction(request.action,request.args);
      else if(request.command==='settings-set')result=await updateGuard('storage',()=>setPreferences(request.patch));
      else if(request.command==='settings-action')result=await updateGuard('storage',()=>settingsAction(request.action));
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
        result={rendererErrors,pet:await pet.webContents.executeJavaScript(PET_RENDERER_DIAGNOSTIC_SCRIPT),panel:panel&&!panel.isDestroyed()?await panel.webContents.executeJavaScript('({title:document.title,scrollY:scrollY,bodyWidth:document.body.scrollWidth,viewportWidth:innerWidth,page:document.querySelector("nav .active")?.innerText,buttons:[...document.querySelectorAll("button")].map(b=>b.innerText).filter(Boolean).slice(0,35),inputs:[...document.querySelectorAll("input,textarea,select")].map(i=>({tag:i.tagName,type:i.type,placeholder:i.placeholder,setting:i.dataset.setting,value:i.type==="password"?"":i.value,checked:i.checked})),actionCards:[...document.querySelectorAll("[data-action-card]")].map(e=>e.dataset.actionCard),directionCount:document.querySelectorAll("[data-look-index]").length,contentText:document.querySelector(".content")?.innerText.slice(-500)})'):null};
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
  if(control.listening)audit({type:'control-error',message:error.message});
});

let shuttingDown=false;
async function shutdown(forUpdate=false) {
  if(quitting||shuttingDown)return;
  forUpdate ||= updateReservation.committed();
  shuttingDown=true;
  try{
  await deferredSaves.flushAll({scope:dataRoot});
  if(agents?.busy()){const choice=await dialog.showMessageBox(panel??pet,{type:'question',title:'工作与协作',message:'仍有工作任务正在运行。',buttons:['完成后退出','停止并保存后退出','返回'],defaultId:2,cancelId:2});if(choice.response===2)return;await agents.prepareExit(choice.response===0?'finish':'stop-save');}
  quitting=true;monitorProfile.cancel();mainProfile.cancel();closePetFullscreen();applyPetVisibility(false);
  await dailyCgScheduler?.stopAndDrain();await rewardTail;await agents?.close();pluginEmbed?.close();await plugins?.close();await voiceHost?.close();await pluginUsage?.close();petDiagnostics?.dispose();dataImport?.close();buttonObserver?.close();trajectoryWindow?.destroy();trajectoryWindow=null;quotas?.close();await settingsTail;await settingsWriteTail;provider?.close();await cg?.close();await game?.flushWorkLedger?.().catch(()=>{});await game?.close();
  await workSourceRegistry?.flush();
  if(worker)await closeMonitorWorker(worker,{onDiagnostic:value=>audit({type:'monitor-worker-close',...value})});
  appUpdates?.close({keepApply:forUpdate});control.close();deferredSaves.stop();app.exit(0);
  }catch(error){quitting=false;syncPetFullscreenObserver();applyPetVisibility(false);if(forUpdate)updateReservation.reopenAfterFailedShutdown();audit({type:'shutdown-blocked',code:error.code,message:error.message});await dialog.showMessageBox(panel??pet,{type:'error',title:'工作尚未停止',message:'退出未完成，已保留当前运行状态。',detail:String(error.message),buttons:['返回']});}
  finally{shuttingDown=false;}
}
app.on('before-quit',event=>{event.preventDefault();if(!quitting)void shutdown();});
function flushSessionEndSync(){try{deferredSaves.flushSyncAll({scope:dataRoot});}catch(error){audit({type:'session-end-save-error',code:error.code,message:error.message});}}
// Electron emits Windows session-end on BrowserWindow, including hidden windows.
app.on('browser-window-created',(_event,window)=>window.on('session-end',flushSessionEndSync));
app.on('session-end',flushSessionEndSync);
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  if(recoveryDispatched){app.exit(0);return;}
  if(bootFailure){await dialog.showMessageBox({type:'error',title:'AI Buddy · 存档恢复',message:bootFailure.message,detail:'没有创建新的业务存档。请恢复原存档目录或核对 local/installation-backups 中的记录后重试。',buttons:['关闭']});app.exit(1);return;}
  try{await claimControlPipe(control,pipe);}catch(error){
   await dialog.showMessageBox({type:'error',title:'AI Buddy · 资料维护',message:error.code==='EADDRINUSE'?'资料维护通道正在被占用，请等待维护结束后再启动。':'无法取得启动所需的本机控制通道。',detail:'尚未开始读取业务存档。'+String(error.message??error),buttons:['关闭']});
   app.exit(1);return;
  }
  deferredSaves.start();
  onboarding=arg('data')===undefined&&!await hasBusinessData(dataRoot);
  dataImport=createDataImportService({root,dataRoot,build,pipe,manager:resources.manager(),onboarding,
   chooseSource:async()=>{if(arg('validation')==='1'&&arg('validation-import-source'))return arg('validation-import-source');const result=await dialog.showOpenDialog(panel??undefined,{title:'选择旧程序或实际存档目录',properties:['openDirectory']});return result.canceled?null:result.filePaths[0];},
   onBarrier:value=>{importBarrier=value;},
   onCreateNew:async()=>{writeFileSync(join(dataRoot,'profile-initialized.json'),JSON.stringify({version:1,createdAt:new Date().toISOString()}),{flag:'wx'});setTimeout(()=>{app.relaunch({args:process.argv.slice(1).filter(a=>!a.startsWith('--data-import-verify='))});void shutdown();},150);},
  });
  if(onboarding){
   settings.preferences=normalizePreferences({language:app.getLocale().startsWith('zh')?'zh-CN':'en'});setLocale(settings.preferences.language);
   openPanel('data-import',false);return;
  }
  buttonObserver=createPetButtonObserver({path:join(build,'pet-buttons.exe'),enabled:process.platform==='win32'&&arg('cursor')!=='manual',onState:observePetButtons,onError:error=>{audit({type:'pet-input-helper-error',message:error.message});if(drag)cancelGesture('button-observer-error');}});
  settings=await readJson(settingsStore,{});
  const netSession=session.fromPartition('whale-memory');
  netSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{audit({type:'renderer-external-blocked',scheme:details.url.split(':')[0]});callback({cancel:true});});
  const allowMicrophone=(contents,permission,details)=>permission==='media'&&contents===panel?.webContents&&voiceHost?.microphoneAllowed()===true&&details?.mediaType!=='video'&&(details?.mediaTypes??['audio']).every(value=>value==='audio');
  netSession.setPermissionCheckHandler((contents,permission,_origin,details)=>!!allowMicrophone(contents,permission,details));
  netSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(!!allowMicrophone(contents,permission,details))); 
  // Read-only, by content name only: 64 hex characters and an image extension.
  netSession.protocol.handle(MEDIA_SCHEME,async request=>{
    const name=mediaName(request.url);if(!name)return new Response(null,{status:404});
    try{return new Response(await readFile(createMediaStore(dataRoot).file(name)),{headers:{'content-type':MEDIA_MIME[name.split('.').at(-1)],'cache-control':'max-age=31536000, immutable','access-control-allow-origin':'*'}});}
    catch{return new Response(null,{status:404});}
  });
  const home=process.env.USERPROFILE;
  let config='';try{config=readFileSync(join(codexHome(),'config.toml'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const model=config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || 'gpt-6.1-sol';
  const binary=options=>resolveCodexBinary({root,explicit:arg('codex'),requireSearchHost:options?.requireSearchHost===true});
  const codex=new CodexProvider({binary,defaultModel:model,dataRoot,onUsage:usage=>worker?.postMessage({type:'companion-usage',...usage}),audit});
  provider=new ModelRouter({codex,dataRoot,crypto:safeStorage,outputLimit:()=>settings.preferences?.maxOutputTokens??8192,searchPolicy:request=>game?.r95?.searchPolicy(request)??false,onNativeSearch:event=>game?.r95?.recordNativeSearch(event),legacy:existsSync(settingsStore.target+'.snapshots'),onActivity:internalActivity,onChange:()=>broadcastSettings(),onUsage:usage=>{appendFileSync(join(dataRoot,'api-usage.jsonl'),JSON.stringify(usage)+'\n');worker?.postMessage({type:'refresh'});},audit});
  await provider.ready;
  chatPreferences=createChatPreferences({provider,read:()=>settings.preferences,write:preferences=>settingsStore.writeText(JSON.stringify({...settings,preferences})),apply:preferences=>{settings.preferences=preferences;},serialize:serializeSettings,audit});
  const publishPlugins=value=>{const snapshot=plugins?.snapshot()??value;if(panel&&!panel.isDestroyed())panel.webContents.send('plugins:update',snapshot);if(Array.isArray(snapshot?.dsh?.installed))pluginEmbed?.recordsChanged(snapshot.dsh.installed);void voiceHost?.refreshPresetPackages();};
  const legacyPlugins=await createPluginMaintenanceClient({runnerPath:join(build,'plugin-maintenance.cjs'),root,dataRoot,appVersion,busy:async()=>!!agents?.busy(),onUpdate:publishPlugins});
  pluginUsage=createPluginUsageRecorder({dataRoot,onRecorded:()=>worker?.postMessage({type:'refresh'})});
  agents=createWorkPluginGate({dataRoot,build,verifyOwnerAuthority:(...args)=>{if(!game?.r95)throw Error('主人授权服务尚未就绪');return game.r95.owner.verifyProof(...args);},getPlatform:()=>plugins,getGame:()=>game,getProvider:()=>provider,binaryResolver:binary,audit,automaticWorkAllowed,
    confirmResumeApproval:createWorkResumeConfirmation({dialog,BrowserWindow,language:()=>settings.preferences.language}),
    chooseWorkspace:async(meta={})=>{const value=await dialog.showOpenDialog(meta.window instanceof BrowserWindow?meta.window:panel??undefined,{title:'选择工作项目目录',properties:['openDirectory']});return value.canceled?null:value.filePaths[0];},
    onActivity:internalActivity,onUsage:value=>pluginUsage.record(value),onNativeApiUsage:value=>pluginUsage.recordNativeApi(value),
    onRegisterUsageSource:async value=>{await managedWorkSource({id:value.id,tool:value.engine,path:value.path,name:'工作插件 · '+value.engine,format:'auto',enabled:true,mode:value.usageMode==='cumulative'?'cumulative':'request',workAttribution:value.workAttribution,...(value.nativeHistoryRange?{nativeHistoryRange:value.nativeHistoryRange}:{})});return {sourceId:value.id,registered:true};},
    onEvent:()=>{if(panel&&!panel.isDestroyed())panel.webContents.send('work:event',{type:'work-status-changed',busy:!!agents?.busy()});},
  });
  voiceHost=createVoiceHost({dataRoot,build,crypto:safeStorage,getGame:()=>game,getPlatform:()=>plugins,audit,
    send:value=>{if(panel&&!panel.isDestroyed())panel.webContents.send('voice:event',value);},
    chooseAssets:async kind=>{const result=await dialog.showOpenDialog(panel,{title:'选择匹配的语音组件目录 · '+kind,properties:['openDirectory']});return result.canceled?null:result.filePaths[0];},
    chooseReference:async()=>{const result=await dialog.showOpenDialog(panel,{title:'选择当前角色的平静参考音',properties:['openFile'],filters:[{name:'WAV',extensions:['wav']}]});return result.canceled?null:{file:result.filePaths[0]};},
  });
  plugins=await createPluginPlatform({voice:{quiesce:()=>voiceHost.quiesce(),snapshot:()=>voiceHost.snapshot(),audioSettings:value=>{cardVoiceMix={voice:value.voice,muted:value.muted};if(panel&&!panel.isDestroyed())panel.webContents.send('voice:event',{type:'card-volume',...cardVoiceMix});return cardVoiceMix;},cardEvent:request=>request?.type==='scope-update'?voiceHost.cardEvent(request):updateGuard('voice',()=>voiceHost.cardEvent(request)),cardPresentation:request=>voiceHost.cardPresentation(request)},pageAppearance:options=>pluginPageAppearance(settings.preferences,themeCharacter,{...options,faces:pluginFaces(),portraits:(builtinPluginPortraits??=builtinPortraits(build))}),root,build,dataRoot,crypto:safeStorage,legacyManager:legacyPlugins,getSocialHost:()=>game?.r95?.socialHost,getGame:()=>game,getProvider:()=>provider,BrowserWindow,session,ipcMain,pluginClientPreloadPath:join(build,'plugin-client-preload.cjs'),openSocialSetup:request=>openSocialLogin(request),renderBiliSheet:createBiliSheetRenderer(nativeImage),analyzeBiliFrames:createBiliFrameAnalyzer(nativeImage),onReadingOpen:async()=>{assertImportIdle();if(!pluginEmbed)throw Object.assign(Error('Plugin page is not ready'),{code:'PLUGIN_EMBED_UNAVAILABLE'});await pluginEmbed.handle({op:'open',target:'bilibili'});},
    hostServices:{'work.host':{capability:'work.host',handler:request=>agents.service(request)}},resolveToolScope:context=>agents.nativeToolScope(context),
    runtimeLockPath:arg('dsh-runtime-lock'),busy:()=>!!agents?.busy(),onUpdate:publishPlugins,audit,automaticWorkAllowed,maintenanceAdmission:()=>!updateReservation.active(),
    openExternal:async url=>{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error('外部页面地址无效');await shell.openExternal(parsed.href);},
    chooseComponentArchive:async()=>{const value=await dialog.showOpenDialog(panel??undefined,{title:'选择匹配的DSH运行组件',properties:['openFile'],filters:[{name:'DSH runtime component',extensions:['tgz']}]});return value.canceled?null:value.filePaths[0];},
    onUsage:value=>pluginUsage.record(value),
    onNotification:async value=>{audit({type:'plugin-notification',...value});if(value.kind==='social-activity'&&!value.clear&&value.title){const title=String(value.title).slice(0,80),seen=recentPluginActivity.findIndex(row=>row.pluginId===value.pluginId&&row.title===title);if(seen>=0)recentPluginActivity.splice(seen,1);recentPluginActivity.unshift({pluginId:value.pluginId,title,at:Date.now()});recentPluginActivity.splice(5);}if(value.kind==='social-activity'&&settings.preferences?.petVisible!==false)petEvent({kind:'social-activity',value});if(panel&&!panel.isDestroyed())panel.webContents.send('plugins:notification',value);},
  });
  plugins.setWorkClientOpener(()=>agents.open());
  void voiceHost.refreshPresetPackages();
  const embedRecord=target=>plugins.snapshot().dsh.installed.find(value=>value.packageName===EMBED_TARGETS[target].packageName);
  pluginEmbed=createPluginEmbed({WebContentsView,getPanel:()=>panel,recordFor:embedRecord,backgroundColor:()=>windowBackground(resolvedTheme(settings.preferences,themeCharacter)),
    onState:value=>{if(panel&&!panel.isDestroyed())panel.webContents.send(EMBED_EVENT,value);},
    admit:async target=>{if(target==='work')return;const record=embedRecord(target);if(!record?.enabled)throw Object.assign(Error('插件没有启用'),{code:'PLUGIN_EMBED_NOT_ENABLED'});if(!embedCapable(target,record.exactVersion))throw Object.assign(Error('这个版本的插件还不能放进主窗口'),{code:'PLUGIN_EMBED_UNSUPPORTED'});await plugins.activateInstalled(record.packageKey);},
    open:async(target,surface)=>{
      if(target==='work')return agents.open({surface});
      const record=embedRecord(target);if(!record?.enabled)throw Object.assign(Error('插件没有启用'),{code:'PLUGIN_EMBED_NOT_ENABLED'});if(!embedCapable(target,record.exactVersion))throw Object.assign(Error('这个版本的插件还不能放进主窗口'),{code:'PLUGIN_EMBED_UNSUPPORTED'});
      return plugins.openClientEmbedded({packageKey:record.packageKey,surface});},
    openWindow:async target=>{if(target==='work')return agents.open();const record=embedRecord(target);if(!record?.enabled)throw Object.assign(Error('插件没有启用'),{code:'PLUGIN_EMBED_NOT_ENABLED'});return plugins.action({action:'dsh-open-client',packageKey:record.packageKey});}});
  plugins.onClientState(value=>pluginEmbed?.hostState(value));pluginEmbed.announce();
  await agents.recoverUsage();
  quotas=new QuotaService({dataRoot,home,crypto:safeStorage,binary,onChange:value=>{if(panel&&!panel.isDestroyed())panel.webContents.send('quotas:update',value);}});await quotas.ready;if(!cardQuiet)quotas.start();
  const cgUsage=usage=>{appendFileSync(join(dataRoot,'cg-usage.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),...usage})+'\n');worker?.postMessage({type:'refresh'});};
  cg=new CgService({canViewDailyScope:scope=>!!game&&scope?.personaId===game.context().personaId&&game.assertDailyCgScope(scope)===true,validateDailyScope:scope=>!quitting&&game?.assertDailyCgScope(scope)===true,captureRewardScope:()=>game?.r95?.activeScope()??null,onRewardFact:fact=>{if(!game?.r95)return {accepted:false};game.r95.feeding.ingestUsageFact(fact,{trusted:true});if(fact.basis==='actual'&&Number.isSafeInteger(fact.totalTokens))game.r95.origins.recordUsage({requestKey:fact.canonicalRequestId,totalTokens:fact.totalTokens,live:fact.live===true&&!fact.baseline});return {accepted:true};},automaticWorkAllowed,resourceCheck:ids=>resources.require(ids.filter(validPetCharacter)),themePlanner:new CgThemePlanner(provider,()=>settings.preferences?.language|| (app.getLocale().startsWith('zh')?'zh-CN':'en')),codex:new CodexImageProvider({binary,defaultModel:model,dataRoot,onUsage:cgUsage,audit}),dataRoot,crypto:safeStorage,imageCodec:createCgCodec(nativeImage),onUsage:cgUsage,onActivity:internalActivity,onChange:()=>{broadcastSettings();if(panel&&!panel.isDestroyed())panel.webContents.send('cg:updated',{});},audit,referenceResolver:createCharacterReferenceResolver(build,ref=>cg.readAsset(ref))});
  await cg.ready;
  let legacyGameSettings={};
  try{
  game=await createGalgame({voice:voiceHost.controller,workBridge:agents.lifeBridge,r95Options:{tickAllowed:automaticWorkAllowed,getTimeZone:()=>settings.preferences?.statisticsTimeZone??'local',work:{ownerAction:(...args)=>agents.ownerAction(...args),getOwnerPlan:value=>agents.getOwnerPlan(value),ownerWorkOptions:value=>agents.ownerWorkOptions(value)},getRuntimeState:scope=>({sleepPhase:activityClock.phase,sleepIntentVersion:activityClock.sleepIntentVersion,waitingForReply:gameRequests>0,presenting:petState.socialPresentation===true,canPresent:(!!panel&&!panel.isDestroyed()&&panel.isVisible()&&!panel.webContents.isLoading())||(!!pet&&!pet.isDestroyed()&&pet.isVisible()&&petState.characterId===scope.characterId&&!petState.manual),activityAllowed:false}),onSpeech:value=>{const petShown=!!pet&&!pet.isDestroyed()&&pet.isVisible()&&petState.characterId===value.scope.characterId;if(petShown)petEvent({kind:'social-line',value});if(panel&&!panel.isDestroyed()&&(panel.isVisible()||petShown))panel.webContents.send('game:output',{type:'social.updated',...(petShown?{petMessageId:value.messageId}:{})});},onSleepIntent:value=>{if(value.kind==='temporary-feeding-start')activityClock.beginTemporaryWake(value.activityOriginId);else if(value.resumeOriginalSleep)activityClock.endTemporaryWake(value.activityOriginId);publishInteraction(true);}},dataRoot,provider,model,cg,resources,audit,imageConverter:rasterizeImage,onActivity:internalActivity,onPetVisibility:syncPetVisibility,onChatCommitted:chatCommitted,onOutput:event=>{if(panel&&!panel.isDestroyed())panel.webContents.send('game:output',event);},automaticWorkAllowed,getReplyStyle:()=>settings.preferences?.replyStyle??'natural',getLanguage:()=>settings.preferences?.language||(settings.preferences?'zh-CN':app.getLocale().startsWith('zh')?'zh-CN':'en'),onCharacter:id=>applyChrome(id),onCgUpdated:value=>{if(panel&&!panel.isDestroyed())panel.webContents.send('cg:updated',value?.kind==='daily'?{id:value.id,status:value.status}:value);}});
  await cg.drainRewardFacts();if(!cardQuiet)cg.start();
   dailyCgScheduler=createDailyCgScheduler({dataRoot,now:Date.now,getTimeZone:()=>settings.preferences?.statisticsTimeZone??'local',admission:()=>!!game&&!quitting&&cg.enabled&&cg.available()&&automaticWorkAllowed()&&activityClock.phase==='awake',capture:context=>{const captured=game.captureDailyCg(context);return {...captured,profile:structuredClone(cg.selected()),themeConnection:structuredClone(cg.themePlanner.capture(captured.modelBinding))};},enqueue:(snapshot,context)=>game.enqueueDailyCg({...snapshot,signal:context.signal}),onError:error=>audit({type:'daily-cg-failed',code:error.code??'DAILY_CG_FAILED',message:String(error.message).slice(0,300)})});
   await dailyCgScheduler.ready;dailyCgScheduler.start();
  legacyGameSettings=await game.action('settings-get');
  markInstallationInitialized(installationResolution,dataRoot);
  }catch(error){await dailyCgScheduler?.stopAndDrain();try{await game?.close();}catch{}game=null;noteStartupFailure('companion',error);}
  const firstPreferences=!settings.preferences||!Object.keys(settings.preferences).length;
  settings.preferences=normalizePreferences(settings.preferences,legacyGameSettings.petEnabled!==false);
  if(firstPreferences)settings.preferences.language=app.getLocale().startsWith('zh')?'zh-CN':'en';
  setLocale(settings.preferences.language);
  if(game&&settings.preferences.petVisible!==(legacyGameSettings.petEnabled!==false))await game.action('pet-set',{enabled:settings.preferences.petVisible});
  await saveSettings();
  if(!startupFailure)chatPreferences.restore();
  // Resolve the saved/manual or model-following character before the first
  // desktop greeting, even when the Galgame panel has not been opened.
  if(game)try{await game.action('view');}catch(error){audit({type:'startup-view-error',message:error.stack});}
  const area=screen.getPrimaryDisplay().workArea;
  const bounds=clamp(petBounds(settings.petBounds || {x:area.x+area.width-290,y:area.y+area.height-290},settings.preferences.petScale));
  pet=new BrowserWindow({...petWindowOptions(bounds,settings.preferences.petScale),title:APP_NAME,icon:appIconPath,webPreferences:{preload:join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'whale-memory'}});
  petDiagnostics=createPetWindowDiagnostics(()=>pet,audit,{getExpected:()=>({visible:petVisibilityState().visible,petVisible:settings.preferences.petVisible,alwaysOnTop:settings.preferences.alwaysOnTop,assetsReady:petAssetsReady,quitting}),getInteraction:()=>({gestureMode,ignoringMouse,dragging:!!drag,gestureId:drag?.gestureId,motion:petMotion?.mode})});
  for(const event of ['show','hide','minimize','restore','focus','blur','always-on-top-changed','closed'])pet.on(event,()=>petDiagnostics.record(event));
  pet.webContents.on('render-process-gone',(_,value)=>petDiagnostics.record('render-process-gone',{renderGone:value}));petDiagnostics.record('created');
  brandWindow(pet);
  lockPageZoom(pet,error=>audit({type:'zoom-policy-error',message:error.message}));
  positionPet(pet,bounds,settings.preferences.petScale);pet.on('will-resize',event=>event.preventDefault());
  for(const name of ['show','hide'])pet.on(name,()=>syncBrandIcons());
  petMotion=new PetMotion({bounds,requireReady:true,displays:()=>screen.getAllDisplays(),onPosition:value=>{if(pet&&!pet.isDestroyed())positionPet(pet,value,settings.preferences.petScale);},onState:()=>{publishInteraction(true);}});
  configurePetInteractions();activityClock.resume();
  applyPetTopmost(pet,settings.preferences.alwaysOnTop);setGestureMode(false);syncPetFullscreenObserver();
  pet.loadFile(join(build,'pet.html'),{...previewQuery,query:{...previewQuery.query,petCharacter:resources.fallback(resolvePetCharacter(settings.preferences,themeCharacter))}});pet.once('ready-to-show',async()=>{
    if(PET_ACTIONS.some(action=>action.sourceFrameCount))try{await pet.webContents.executeJavaScript('window.petCharacterReady.then(()=>window.frameSequenceInspection.renderer.ready).then(()=>true)');}catch(error){pushBounded(rendererErrors,error.message);audit({type:'pet-assets-error',message:error.message});return;}
    if(!pet.isDestroyed()){petAssetsReady=true;applyPetPreferences();if(!startupFailure)appUpdates?.start();}
  });
  pet.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  tray=new Tray(appIcon.resize({width:32,height:32}));tray.setToolTip(arg('rig')==='working'?APP_NAME+' · 工作动作小样（独立预览）':APP_NAME+' · 本地 AI 用量监控与桌面陪伴');syncBrandIcons();
  updateTray();tray.on('double-click',()=>openPanel());
  const recoverPet=()=>{if(!pet||pet.isDestroyed())return;cancelGesture('system-recovery');petMotion?.recover(clamp(petBounds(pet.getContentBounds(),settings.preferences.petScale)));publishInteraction(true);fullscreenObserver?.sample();};
  pet.on('hide',()=>cancelGesture('window-hidden'));pet.webContents.on('render-process-gone',()=>cancelGesture('renderer-lost'));
  pet.on('closed',closePetFullscreen);
  screen.on('display-removed',recoverPet);screen.on('display-metrics-changed',recoverPet);
  screen.on('display-added',()=>fullscreenObserver?.sample());
  powerMonitor.on('suspend',()=>{game?.r95?.feeding.pause('system-suspend');recoverPet();});powerMonitor.on('resume',()=>{game?.r95?.feeding.resume({sleeping:false});recoverPet();activityClock.resume();publishInteraction(true);});
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
  // The monitor worker is restarted with backoff if it exits unexpectedly.
  superviseWorker(()=>{
  worker=new Worker(join(build,'monitor-worker.cjs'),{name:'buddy-monitor',workerData:{hostOwnsRegistry:true,roots:arg('roots')?logRoots:undefined,home,env:process.env,dataRoot,refreshIntervalMs:settings.preferences.monitorRefreshMs,statisticsTimeZone:settings.preferences.statisticsTimeZone,autoPriceUpdates:settings.preferences.autoPriceUpdates}});
  worker.on('message',message=>{if(message.type==='sources'){tokenSources=message.value;if(panel&&!panel.isDestroyed())panel.webContents.send('tokens:update',message.value);}if(message.type==='source-result'){const pending=sourceRequests.get(message.id);if(pending){clearTimeout(pending.timer);sourceRequests.delete(message.id);message.error?pending.fail(Error(message.error)):pending.done(message.value);}}if(message.type==='snapshot'){publish(message.value);requestRewardDrain();}if(message.type==='configured'){monitorAppliedInterval=message.refreshIntervalMs;broadcastSettings();}if(message.type==='refreshed')broadcastSettings();if(message.type==='error')audit({type:'monitor-error',message:message.message});});
  const monitoredWorker=worker;worker.on('message',message=>{if(message.type==='reward-facts')consumeRewardFacts(message.value,monitoredWorker);});
  worker.on('message',message=>{if(message.type==='task-feedback'&&!quitting)feedback(message.value);if(message.type==='audit'&&message.value?.type)audit({...message.value,type:String(message.value.type)});});
  worker.on('error',error=>audit({type:'monitor-worker-error',message:error.stack}));
  return worker;
  },{shouldRestart:()=>!quitting,onExit:code=>{rewardDrainPending=false;if(!quitting)audit({type:'monitor-worker-exit',code});}});
  if(localCardBuild&&!startupFailure&&!plugins.bundledCardGamesStatus().installed)await plugins.installBundledCardGames();
  const updateStore=createSnapshotStorage(join(dataRoot,'app-update.json'));
  const updatePrefs=await readJson(updateStore,{}).catch(()=>({}));
  const updateBackend=createAppUpdateBackend({root,build,dataRoot,pipe,installation:installationResolution?.installation,version:appVersion});
  const bootstrapBackend=createAppBootstrapBackend({root,build,dataRoot,pipe,installation:installationResolution?.installation,version:appVersion});
  appUpdates=createUpdateService({version:appVersion,build:build.split(/[\\/]/).at(-1),supported:updateBackend.supported&&!startupFailure,run:updateBackend.run,
    recoveryRequired:!!startupFailure,bootstrapRun:startupFailure?undefined:bootstrapBackend.run,
    load:()=>updatePrefs,save:value=>updateGuard('storage',()=>updateStore.writeText(JSON.stringify(value))),
    onChange:value=>{if(panel&&!panel.isDestroyed())panel.webContents.send('updates:state',value);}});
  if(!startupFailure&&petAssetsReady)appUpdates.start();audit({type:'app-start',mode:'offline',version:appVersion,build});
  if(startupFailure)openPanel('safe-mode',false);
  else if(reopenRequested||['overview','galgame','settings','actions','agent-tasks','plugins','shop','backpack','social'].includes(arg('open')))openPanel(reopenRequested?'overview':arg('open'),false);
}).catch(error=>{audit({type:'startup-error',message:error.stack});console.error(error);enterSafeMode(error);});
// Startup failed outside the companion features: keep a way to see the error
// and quit instead of exiting silently on every launch.
function enterSafeMode(error){
  noteStartupFailure('app',error);
  try{
    if(!tray){tray=new Tray(appIcon.resize({width:32,height:32}));tray.setToolTip(APP_NAME+' · 安全模式');tray.setContextMenu(Menu.buildFromTemplate([{label:'查看错误',click:()=>{try{openPanel('safe-mode');}catch(error){audit({type:'safe-mode-panel-error',message:error.stack});}}},{label:'退出',click:()=>app.quit()}]));}
    try{openPanel('safe-mode');}catch(error){audit({type:'safe-mode-panel-error',message:error.stack});}
  }catch(fatal){audit({type:'safe-mode-error',message:fatal.stack});app.exit(1);}
}
