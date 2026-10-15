// Runs the actual app with an isolated save and synthetic events, no model calls.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),{join,resolve}=require('node:path'),{pathToFileURL}=require('node:url'),assert=require('node:assert/strict');
const root=resolve(__dirname,'..'),pointer=JSON.parse(fs.readFileSync(join(root,'local/candidate-build.json'))),build=process.argv.find(x=>x.startsWith('--build='))?.slice(8)||pointer.path,partial=process.argv.includes('--partial'),dir=join(root,'local/buddy-180/native-'+Date.now()),pipe='\\\\.\\pipe\\buddy-pets-179-'+process.pid;
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(join(dir,'roots.json'),'[]');process.argv.push('--data='+join(dir,'profile'),'--roots='+join(dir,'roots.json'),'--pipe='+pipe,'--cursor=manual');app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.on('browser-window-created',(_,w)=>{w.setOpacity(0);w.setSkipTaskbar(true);});
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(70)}throw Error('Timed out: '+label)}
require(join(build,'main.cjs'));
app.whenReady().then(async()=>{let q;const report={build,partial,modelCalls:0,cases:[],screenshots:[]};try{
 const {requestLocalControl}=await import(pathToFileURL(join(root,'src/local-control.mjs')));q=(command,extra={})=>requestLocalControl(pipe,{command,...extra},{timeoutMs:20000});
 await until(async()=>{const s=await q('snapshot').catch(()=>null);return s?.petAssetsReady},'startup');
 assert.equal((await q('snapshot')).settings.preferences.petScale,1.25);report.defaultScale=1.25;await q('show',{page:'actions'});
 const pet=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('pet.html')),'pet');const panel=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html')),'panel');
 const ev=s=>pet.webContents.executeJavaScript(s),ui=s=>panel.webContents.executeJavaScript(s),state=()=>ev('window.petActionDiagnostic');
 await q('settings-set',{patch:{followCursor:false,animationSpeed:1,petCharacterMode:'fixed',petFixedCharacter:'claude'}});
 await until(async()=>(await state())?.characterId==='claude','fixed Claude');
 await until(()=>ui('!!document.querySelector("[data-gallery-character]")'),'gallery');
 await ui(`(()=>{const s=document.querySelector('[data-gallery-character]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'claude');s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await until(()=>ui('document.querySelectorAll("[data-action-card]").length===18'),'18 cards');
 await pause(1000);report.cases.push({name:'fixed and 18 gallery cards',state:await state()});
 for(const width of [900,1180,1600,1920]){panel.setContentSize(width,950);await pause(200);assert(await ui('document.documentElement.scrollWidth<=innerWidth+1'));const file=join(dir,'gallery-'+width+'.png');fs.writeFileSync(file,(await panel.webContents.capturePage()).toPNG());report.screenshots.push(file)}
 await q('pet-play',{action:{id:'wave',characterId:'deepseek',durationMs:700}});
 await until(async()=>{const s=await state();return s.characterId==='deepseek'&&s.manual},'temporary DeepSeek');
 await until(async()=>{const s=await state();return s.characterId==='claude'&&!s.manual},'restore fixed Claude');report.cases.push({name:'temporary demonstration restores fixed selection'});
 // A task already on screen must finish on the same pet and retain its text.
 pet.webContents.send('pet:action',{kind:'feedback',value:{id:'jump',eventId:'178-finish',source:'completed',provider:'codex',text:'测试完成',cycles:2}});
 await until(async()=>(await state()).feedback?.eventId==='178-finish','completion starts');const started=await state();
 await q('settings-set',{patch:{petFixedCharacter:'deepseek'}});await pause(600);assert.equal((await state()).characterId,'claude');assert.equal((await state()).feedback.text,'测试完成');
 assert.ok(Math.abs(started.feedback.duration-2*started.cycleMs)<1);await until(async()=>(await state()).characterId==='deepseek','completion then switch');report.cases.push({name:'two cycles and feedback-safe switch',duration:started.feedback.duration});
 // Drag blocks both a role switch and queued feedback; release runs the latest pet.
 pet.webContents.send('pet:action',{kind:'drag',active:true,direction:-1});await pause(100);
 await q('settings-set',{patch:{petFixedCharacter:'claude'}});pet.webContents.send('pet:action',{kind:'feedback',value:{id:'fail',eventId:'178-drag-fail',source:'failed',text:'测试错误',cycles:1}});await pause(500);assert.equal((await state()).characterId,'deepseek');
 pet.webContents.send('pet:action',{kind:'drag',active:false});await until(async()=>(await state()).characterId==='claude','switch after drag');await until(async()=>(await state()).feedback?.eventId==='178-drag-fail','queued error');report.cases.push({name:'drag retains pending feedback'});
 await until(async()=>(await state()).feedback?.eventId!=='178-drag-fail','error ends');
 await ui(`window.whale.storyFeedback({characterId:'qwen',emotion:'cheerful',messageId:'178-qwen',text:'这是原回复，没有角色前缀。'})`);
 await until(async()=>(await state()).feedback?.eventId==='story:178-qwen','cross-character emotion');const chat=await state();assert.equal(chat.characterId,'claude');assert.equal(chat.id,'emotion-cheerful');assert.equal(chat.feedback.text,'这是原回复，没有角色前缀。');report.cases.push({name:'fixed Claude responds to Qwen without name prefix'});
 await until(async()=>(await state()).feedback?.eventId!=='story:178-qwen','chat ends');
 await ui(`window.whale.game('settings-set',{characterMode:'manual',characterId:'deepseek'})`);assert.equal((await state()).characterId,'claude');
 await q('settings-set',{patch:{petCharacterMode:'follow'}});await until(async()=>(await state()).characterId==='deepseek','follow DeepSeek');
 await ui(`window.whale.game('settings-set',{characterMode:'manual',characterId:'claude'})`);await until(async()=>(await state()).characterId==='claude','follow Claude');report.cases.push({name:'follow uses final Galgame selection'});
 const available=Object.keys(JSON.parse(fs.readFileSync(join(build,'assets/character-sequence-manifest.json'))));if(partial)assert(available.length>=2&&available.length<11);else assert.equal(available.length,11);
 report.available=available;
 // Switch via the actual Galgame selection, in the middle of a normal cycle.
 report.switches=[];report.calibration=[];
 await q('pet-auto');await q('settings-set',{patch:{petCharacterMode:'follow',followCursor:false,showStatusBadge:false}});
 await until(async()=>!(await state()).feedback,'feedback settled');
 await pet.webContents.debugger.attach('1.3');
 await pet.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 for(const id of available){
  const start=Date.now();await ui(`window.whale.game('settings-set',{characterMode:'manual',characterId:${JSON.stringify(id)}})`);
  await until(async()=>{const s=await state();return s.characterId===id&&s.displayedActionId==='idle'},'immediate selection '+id,5000);
  const elapsedMs=Date.now()-start;assert(elapsedMs<1500,`${id} switch took ${elapsedMs}ms`);report.switches.push({id,elapsedMs});
  for(const scale of [.75,1,1.25,1.5]){
   await q('settings-set',{patch:{petScale:scale}});await pause(120);
   const measure=await ev(`(()=>{const el=document.querySelector('.sprite'),c=el.querySelector('canvas'),r=el.getBoundingClientRect(),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let left=c.width,top=c.height,right=0,bottom=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){if(a[(y*c.width+x)*4+3]>64){left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1)}}return {bounds:[r.left+left/c.width*r.width,r.top+top/c.height*r.height,r.left+right/c.width*r.width,r.top+bottom/c.height*r.height],window:[innerWidth,innerHeight],canvas:[c.width,c.height],presentation:window.petActionDiagnostic.presentation}})()`);
   const [l,t,r,b]=measure.bounds;assert(l>=0&&t>=0&&r<=measure.window[0]&&b<=measure.window[1],id+' clipped');
   assert(Math.abs((b-t)/scale-541*.86/3)<2.2,`${id} height ${(b-t)/scale}`);
   report.calibration.push({id,scale,...measure});
   if(scale===1){const file=join(dir,`pet-${id}.png`);fs.writeFileSync(file,(await pet.webContents.capturePage()).toPNG());report.screenshots.push(file)}
  }
 }
 await pet.webContents.debugger.detach();
 await q('settings-set',{patch:{petScale:1,petCharacterMode:'fixed',petFixedCharacter:'claude'}});await until(async()=>(await state()).characterId==='claude','fixed returns');
 await ui(`window.whale.game('settings-set',{characterMode:'manual',characterId:'qwen'})`);await pause(180);assert.equal((await state()).characterId,'claude');
 report.cases.push({name:'eleven immediate Galgame selections and four desktop scales',ok:true});
 report.rendererErrors=(await q('page-info')).rendererErrors;assert.deepEqual(report.rendererErrors,[]);report.final=await q('snapshot');report.ok=true;
 }catch(e){report.ok=false;report.error=e.stack;}finally{fs.writeFileSync(join(dir,'result.json'),JSON.stringify(report,null,2));fs.writeFileSync(join(root,'local/buddy-180/native-latest.json'),JSON.stringify({path:join(dir,'result.json')}));console.log(JSON.stringify({ok:report.ok,path:join(dir,'result.json'),error:report.error}));await q?.('quit').catch(()=>{});app.exit(report.ok?0:1)}});
