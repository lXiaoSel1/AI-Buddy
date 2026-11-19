import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {tmpDir} from './audit-harness.mjs';

const require=createRequire(import.meta.url);
const fixtureMain=String.raw`
const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
if(process.argv.includes('--fixture-reduced-motion'))app.commandLine.appendSwitch('force-prefers-reduced-motion');
const scenario=process.argv.find(arg=>arg.startsWith('--fixture-scenario='))?.split('=')[1];
const longWindow=()=>scenario?.endsWith('-long')||scenario?.includes('layout')||scenario?.includes('-r2-')||scenario==='stage-group-ended'||scenario==='stage-private-classic';
const paperWidth=Number(process.argv.find(arg=>arg.startsWith('--fixture-paper-width='))?.split('=')[1]??1280);
const paperGallery=scenario==='paper-gallery'?JSON.parse(fs.readFileSync(path.join(__dirname,'paper-gallery.json'),'utf8')):[];
const positive=Number(process.argv.find(arg=>arg.startsWith('--fixture-gallery-count='))?.split('=')[1]??0);
let r2SpeechRead=false,r2FontScale=1,r2Committed=null,r2GroupStream=null,r2Feedback=false;
function view(){
 const character={id:'deepseek',name:'DeepSeek',builtin:true,effective:{greeting:'Hello'}};
 const user={id:'latest-user',role:'user',who:'user',text:'Latest user turn',personaSnapshot:{nickname:'Fixture user'}};
 const dense=scenario==='stage-private-dense-long',compactAuto=scenario==='stage-group-auto-compact-layout',portraits=scenario==='stage-group-portrait-layout'||compactAuto||scenario==='stage-group-r2-layout';
 const long=scenario?.endsWith('-long')||scenario==='stage-private-classic',ended=scenario?.startsWith('stage-group-ended');
 const synthetic=Array.from({length:8},()=> '海风拂过夜晚的窗台，远处灯火在水面映出倒影。'.repeat(5)).join('\n\n');
 const characters=[character,...(portraits?['claude','chatgpt','hunyuan'].map(id=>({id,name:id,builtin:true,effective:{greeting:'Hello'}})):[])];
 const withChoices=scenario==='stage-overlap'||scenario==='stage-private-layout'||dense,withGroup=scenario?.startsWith('stage-group-');
 const ink=compactAuto||scenario==='stage-group-hint'||scenario==='stage-group-auto'||scenario==='stage-group-auto-layout'||ended,activeAuto=compactAuto||scenario==='stage-group-auto'||scenario==='stage-group-auto-layout'||ended;
 const group={id:'fixture-group',name:ended?'Fixture group with a deliberately long translated name for the header geometry':'Fixture group',memberIds:characters.map(row=>row.id),personaId:'fixture-persona',photos:[],background:scenario==='stage-group-ended-light-long'?'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC':ink||scenario==='stage-group-offline'?'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC':''};
 const reply={id:'fixture-group-reply',role:'assistant',characterId:character.id,seq:1,status:'presented',text:long?synthetic:'Fixture group reply'};
 const auto={id:'fixture-auto',status:ended?'ended':'active',endedReason:ended?'stopped':undefined,mode:'rounds',members:group.memberIds,roundLimit:6,roundIndex:ended?1:0,...(compactAuto?{pending:{characterId:'deepseek',status:'running'}}:{})};
 const idleGroup={status:compactAuto?'running':'idle',...(activeAuto?{mode:'auto',currentMessage:reply}:{})};
 const waitingGroup=r2Feedback
  ?{status:'awaiting-presentation',queue:[character.id],currentMessage:reply,pendingMessage:{id:'fixture-pending'}}
  :{status:'awaiting-continue',canContinue:true,queue:[character.id],currentMessage:reply};
 const speech={messageId:'fixture-proactive',text:synthetic,status:'presented',kind:'proactive',scope:{channel:'app-private',characterId:character.id,personaId:'fixture-persona',conversationId:'fixture-conversation'}};
 const groupState=withGroup?{activeGroupId:group.id,groups:[group],groupMessages:!ink||activeAuto?[reply]:[],groupRuntime:scenario?.startsWith('stage-group-r2-')&&scenario!=='stage-group-r2-layout'?{status:r2GroupStream?'generating':r2Committed?'idle':'generating',currentMessage:r2Committed,streaming:r2GroupStream}:ink||ended?idleGroup:waitingGroup,
  ...(activeAuto?{r95:{mood:{label:ended?'很长的心情标签会在舞台上省略并且保留完整的悬停标题':'平静'},settings:{auto:true},groupId:group.id,auto}}:{})}:{};
 return {enabled:true,current:character.id,name:character.name,sprite:'maid-left',spriteVisibility:'auto',bg:scenario==='cg'?'cg':'palace-night',
  backgroundMode:scenario==='cg'?'cg':'builtin',builtinBackgroundOptions:[{key:'palace-night',label:'深海宫殿',default:true,current:true},{key:'bg-deepseek-seaside-study',label:'海边书房'}],
  history:r2Committed?[r2Committed]:long&&!withGroup?[{id:'private-long',who:'assistant',role:'assistant',text:synthetic}]:[user],level:2,affection:10,cap:30,choices:dense?['在海边散步，顺便看海浪和晚霞','聊过明天的计划再读一本书','今天整理房间，晚上回来接着聊']:scenario==='stage-private-layout'?['明天沿着海边散步，顺便买一本新书','要不要再聊聊今晚的故事','我先去整理房间，等会儿再回来']:withChoices?['说说明天吧','再聊一会儿吧','我先忙一下']:[],galleryCount:positive,
  companion:{activeCharacterId:character.id,activePersonaId:'fixture-persona',activeConversationId:'fixture-conversation',messages:r2Committed?[r2Committed]:dense?[{...user,status:'failed',requestId:'fixture-stop'}]:long&&!withGroup?[{id:'private-long',who:'assistant',role:'assistant',text:synthetic}]:[user],...(dense?{interruptedReply:{requestId:'fixture-stop',text:synthetic,status:'incomplete',error:'用户停止回复'}}:{}),settings:scenario==='stage-private-r2-font-long'?{galgamePresentation:{deepseek:{fontScale:r2FontScale,expressionMode:'reply'}}}:scenario?.includes('r2-stream')?{galgamePresentation:{[withGroup?'group:fixture-group':'deepseek']:{expressionMode:'reply'}}}:(scenario==='stage-private-classic'||scenario==='stage-voice-classic')?{galgamePresentation:{deepseek:{dialogueStyle:'classic'}}}:{},characters,
   personas:[{id:'fixture-persona',name:'Fixture persona',nickname:'Fixture user'}],groups:[],r95:{mood:{label:'平静'},...(scenario?.endsWith('-proactive')&&!r2SpeechRead?{lines:[speech]}:{})},...groupState},
 };
}
if(scenario==='stage-group-recording'||scenario==='stage-private-recording-layout'||scenario==='stage-group-recording-layout'){
 const id='ai-buddy.voice-breeze';
 let capture=null;
 const voice=()=>({settings:{enabled:true,packages:{[id]:{ttsProvider:'local'}}},selectedPackageId:id,
  scope:{channel:scenario.includes('group')?'app-group':'app-private',characterId:'deepseek',personaId:'fixture-persona',conversationId:scenario.includes('group')?'fixture-group':'fixture-conversation'},
  preparation:{state:'ready',target:'speech'},packages:[{id,installed:true,usable:true,enabled:true,trusted:true}],capture});
 ipcMain.handle('voice:action',(_event,action,args)=>{
  if(action==='state')return voice();
  if(action==='capture-start')return capture={id:'fixture-capture',mode:args.mode};
  if(action==='stop')capture=null;
  return {accepted:true};
 });
}
if(scenario?.includes('r2-narration')){
 const id='ai-buddy.voice-breeze',group=scenario.includes('group');
 ipcMain.handle('voice:action',(_event,action)=>{
  if(action==='state')return {
   scope:{channel:group?'app-group':'app-private',characterId:'deepseek',personaId:'fixture-persona',conversationId:group?'fixture-group':'fixture-conversation'},
   settings:{enabled:true,packages:{[id]:{ttsProvider:'local'}}},selectedPackageId:id,
   preparation:{state:'ready',target:'speech'},packages:[{id,installed:true,usable:true,enabled:true,trusted:true}],
  };
  return {accepted:true};
 });
}
if(scenario==='stage-private-dense-long'){
 const id='ai-buddy.voice-breeze';
 const state={settings:{enabled:true,packages:{[id]:{ttsProvider:'local'}}},selectedPackageId:id,scope:{channel:'app-private',characterId:'deepseek',personaId:'fixture-persona',conversationId:'fixture-conversation'},preparation:{state:'ready',target:'speech'},packages:[{id,installed:true,usable:true,enabled:true,trusted:true}]};
 ipcMain.handle('voice:action',(event,action)=>{
  if(action==='state')return state;
  if(action==='fixture-dub-failed')event.sender.send('voice:event',{type:'segment',state:'failed',envelope:{...state.scope,requestId:'fixture-stop',segmentId:'fixture-stop:0',index:0},message:'配音失败，回复文字已保留'});
  return {accepted:true};
 });
}
if(scenario?.startsWith('stage-voice-')){
 const id='ai-buddy.voice-breeze';
 let enabled=true,preparation={state:'idle'},release;
 const voice=()=>({settings:{enabled,packages:{[id]:{ttsProvider:'local'}}},selectedPackageId:id,
  scope:{channel:'app-private',characterId:'deepseek',personaId:'fixture-persona',conversationId:'fixture-conversation'},
  preparation,packages:[{id,installed:true,usable:true,enabled:true,trusted:true}],assets:{asr:{state:'ready'},tts:{state:'ready'}}});
 ipcMain.handle('voice:action',async(event,action,args)=>{
  if(action==='state')return voice();
  if(action==='prepare'&&enabled&&args.target==='speech'){
   preparation={state:'verifying',target:'speech'};
   event.sender.send('voice:event',{type:'preparation',preparation});
   await new Promise(resolve=>release=resolve);
   preparation={state:'ready',target:'speech'};
   event.sender.send('voice:event',{type:'state',state:voice()});
   return voice();
  }
  if(action==='fixture-release'){release();return {accepted:true};}
  if(action==='configure'&&args.enabled===false){
   enabled=false;preparation={state:'idle'};
   event.sender.send('voice:event',{type:'state',state:voice()});
   return {enabled};
  }
  return {accepted:true};
 });
}
let migrationPolls=0,compactPauseAttempts=0;
ipcMain.handle('game:action',(event,action,args)=>{
 if(scenario?.includes('-r2-')){
  if(action==='fixture-proactive-rearm'){
   r2SpeechRead=false;
   event.sender.send('game:output',{type:'social.updated'});
   return {ok:true};
  }
  if(action==='fixture-group-feedback'){
   r2Feedback=true;
   event.sender.send('game:chat-committed');
   return {ok:true};
  }
  if(action==='companion-group-present'&&r2Feedback)return {ok:false,error:'Synthetic group feedback used to verify the stage rows.'};
  if(action==='fixture-narration'){
   event.sender.send('voice:event',args);
   return {ok:true};
  }
  if(action==='fixture-stream'){
   if(scenario.startsWith('stage-group')){
    if(args.finish){
     r2GroupStream=null;
     r2Committed={id:args.requestId,requestId:args.requestId,characterId:'deepseek',role:'assistant',text:args.text,status:'presented'};
     event.sender.send('game:chat-committed');
    }else{
     r2GroupStream={requestId:args.requestId,characterId:'deepseek',text:args.text};
     event.sender.send('game:output',{type:'group.text',groupId:'fixture-group',payload:r2GroupStream});
    }
   }else {
    const scope={conversationId:'fixture-conversation',personaId:'fixture-persona',characterId:'deepseek',requestId:args.requestId};
    if(args.finish){r2Committed={id:args.requestId,requestId:args.requestId,who:'heroine',role:'assistant',text:args.text};event.sender.send('game:output',{...scope,type:'request.phase',payload:{phase:'committed'}});}
    else event.sender.send('game:output',{...scope,type:'message.snapshot',payload:{text:args.text}});
   }
   return {ok:true};
  }
  if(action==='companion-settings'){
   r2FontScale=args.fontScale;
   return view();
  }
  if(action==='companion-r95'&&args?.action==='speech-read'){
   r2SpeechRead=true;
   return view();
  }
 }

 if(scenario==='paper-gallery'){
  if(action==='cg-gallery')return {items:paperGallery.map(({dataUrl,...card})=>card)};
  if(action==='cg-data')return paperGallery.find(item=>item.id===args.id);
 }
 if(scenario==='migration'){
  if(action==='companion-storage-status'){
   migrationPolls++;
   return migrationPolls<3?{migrating:true,phase:'copying',count:36,total:60}:{migrating:false,phase:'ready'};
  }
  if(action==='view'&&migrationPolls<3)return {ok:false,code:'COMPANION_STORAGE_MIGRATING',error:'正在整理聊天记录…',storage:{migrating:true,phase:'copying',count:12,total:60}};
 }
 if(scenario){
  if(scenario==='stage-group-auto-compact-layout'&&action==='companion-r95'&&args?.action==='auto-pause'&&compactPauseAttempts++===0)return {ok:false,error:'The operation could not be completed because another group session owns the active request. Retry after the current turn has finished.'};
  if(action==='chat')return new Promise(()=>{});
  if(action==='view')return view();
  if(action==='settings-get')return {enabled:true};
  if(action==='bg-data')return {dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0rcAAAAASUVORK5CYII='};
  if(action==='cg-gallery')return {items:[]};
  return {ok:true};
 }
 throw Error(action==='companion-group-photo-preview'?'本次没有新的对话可以合影':'只能重新开始当前角色的私聊关系');
});
if(scenario==='paper-gallery')ipcMain.handle('fixture:paper-activate',async event=>{
 const debuggerClient=event.sender.debugger;
 const key={key:'Enter',code:'Enter',windowsVirtualKeyCode:13};
 debuggerClient.attach();
 try{
  await debuggerClient.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',text:'\r',...key});
  await debuggerClient.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...key});
 }finally{debuggerClient.detach();}
});
ipcMain.handle('fixture:wheel',async(event,x,y,deltaY)=>{
 const debuggerClient=event.sender.debugger;
 debuggerClient.attach('1.3');
 try{
  await debuggerClient.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaY,deltaX:0});
 }finally{debuggerClient.detach();}
});
ipcMain.handle('fixture:resize',(event,width,height)=>BrowserWindow.fromWebContents(event.sender).setContentSize(width,height));
ipcMain.once('fixture:result',(_event,value)=>{
 fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(value));
 app.quit();
});
app.whenReady().then(()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!['file:','data:'].includes(new URL(details.url).protocol)}));
 const window=new BrowserWindow({show:false,width:longWindow()?1500:paperWidth,height:800,useContentSize:scenario==='paper-gallery',webPreferences:{
  preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false,
 }});
 window.loadFile(path.join(__dirname,'index.html'));
});
const timer=setTimeout(()=>app.exit(2),longWindow()?45000:18000);
app.on('will-quit',()=>clearTimeout(timer));
`;
const fixtureRenderer=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {__FIXTURE_ENTRY__ as run} from '__FIXTURE_FILE__';
const root=createRoot(document.querySelector('#mount'));
try{ const diagnostic=await run(root,__FIXTURE_COUNT__); window.finishFixture({ok:true,diagnostic}); }
catch(error){window.finishFixture({error:error.stack});}
finally{root.unmount();}
`;

export async function runGalgameDom(t,fixtureFile,{reducedMotion=false,scenario,galleryCount=0,entry='run',paperWidth=1280,paperGallery}={}){
 const directory=tmpDir('galgame-r14-dom',{t});
 const env={...process.env};
 delete env.ELECTRON_RUN_AS_NODE;
 const executable=env.HOST_TEST_R14_ELECTRON??require('electron');
 const renderer=fixtureRenderer.replace('__FIXTURE_FILE__',fixtureFile).replace('__FIXTURE_ENTRY__',entry).replace('__FIXTURE_COUNT__',String(galleryCount));
 await build({stdin:{contents:renderer,resolveDir:import.meta.dirname},outfile:join(directory,'renderer.mjs'),bundle:true,format:'esm',platform:'browser',target:'chrome144',loader:{'.css':'text'},logLevel:'silent'});
 await build({
  stdin:{contents:"import '../../src/preload.mjs';import {contextBridge,ipcRenderer} from 'electron';contextBridge.exposeInMainWorld('finishFixture',value=>ipcRenderer.send('fixture:result',value));contextBridge.exposeInMainWorld('activatePaperControl',()=>ipcRenderer.invoke('fixture:paper-activate'));contextBridge.exposeInMainWorld('wheelFixture',(x,y,deltaY)=>ipcRenderer.invoke('fixture:wheel',x,y,deltaY));contextBridge.exposeInMainWorld('resizeFixture',(width,height)=>ipcRenderer.invoke('fixture:resize',width,height));",resolveDir:import.meta.dirname},
  outfile:join(directory,'preload.cjs'),bundle:true,format:'cjs',platform:'node',external:['electron'],logLevel:'silent',
 });
 await writeFile(join(directory,'index.html'),'<!DOCTYPE html><meta charset=utf-8><div id="mount"></div><script type="module" src="renderer.mjs"></script>');
 await writeFile(join(directory,'main.cjs'),fixtureMain);
 if(paperGallery)await writeFile(join(directory,'paper-gallery.json'),JSON.stringify(paperGallery));
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(executable,[join(directory,'main.cjs'),'--allow-file-access-from-files','--fixture-paper-width='+paperWidth,...(reducedMotion?['--fixture-reduced-motion']:[]),...(scenario?['--fixture-scenario='+scenario,'--fixture-gallery-count='+galleryCount]:[])],{windowsHide:true,env,stdio:'ignore'});
  child.once('error',reject);child.once('exit',resolve);
 });
 if(code!==0)throw Error('Galgame component fixture exited with '+code);
 const result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));
 if(result.error)throw Error(result.error);
 if(typeof result.diagnostic==='string')t.diagnostic(result.diagnostic);
}
