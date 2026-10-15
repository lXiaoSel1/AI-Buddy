const {app}=require('electron'),fs=require('node:fs'),{join,resolve}=require('node:path'),{connect}=require('node:net'),assert=require('node:assert/strict');
const root=resolve(__dirname,'..'),arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3),build=arg('build')||JSON.parse(fs.readFileSync(join(root,'local/candidate-build.json'),'utf8')).path;
const baseline=process.argv.includes('--expect-flicker'),directory=join(root,'local/buddy-180','cost-refresh-'+Date.now()),data=join(directory,'profile'),home=join(directory,'home'),pipe='\\\\.\\pipe\\ai-cost-'+process.pid;
fs.mkdirSync(data,{recursive:true});fs.writeFileSync(join(directory,'roots.json'),'[]');process.env.USERPROFILE=home;process.env.CODEX_HOME=join(home,'.codex');process.env.CLAUDE_CONFIG_DIR=join(home,'.claude');for(const k of ['DSH_HOME','KIMI_HOME','KIMI_CODE_HOME','GEMINI_CLI_HOME','OPENCODE_DB','XDG_DATA_HOME'])delete process.env[k];
app.setPath('userData',join(data,'chromium'));process.argv.push('--data='+data,'--roots='+join(directory,'roots.json'),'--pipe='+pipe,'--cursor=manual');
let panel;app.on('browser-window-created',(_,w)=>{w.setOpacity(0);w.setSkipTaskbar(true);w.webContents.on('did-finish-load',()=>{if(w.webContents.getURL().includes('index.html'))panel=w;});});
const pause=ms=>new Promise(r=>setTimeout(r,ms)),evaluate=js=>panel.webContents.executeJavaScript(js);
function q(command,args={}){return new Promise((done,fail)=>{const socket=connect(pipe),timer=setTimeout(()=>{socket.destroy();fail(Error('Control timeout'));},30000);let raw='';socket.on('connect',()=>socket.write(JSON.stringify({command,...args})+'\n'));socket.on('data',b=>raw+=b);socket.on('end',()=>{clearTimeout(timer);try{const result=JSON.parse(raw);result.error?fail(Error(result.error)):done(result);}catch(e){fail(e);}});socket.on('error',e=>{clearTimeout(timer);fail(e);});});}
async function until(fn,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn().catch(()=>null);if(result)return result;await pause(80);}throw Error('Cost UI timeout');}
let statsDelay=0,failNext=false,activeCalls=0,maxActiveCalls=0;
const {ipcMain}=require('electron'),register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>register(channel,channel==='tokens:action'?async(event,action,args)=>{if(action!=='statistics')return listener(event,action,args);const delay=statsDelay,fail=failNext;failNext=false;activeCalls++;maxActiveCalls=Math.max(maxActiveCalls,activeCalls);try{if(delay)await pause(delay);if(fail)throw Error('测试读取失败');return await listener(event,action,args);}finally{activeCalls--;}}:listener);
const report={build,directory,baseline,modelCalls:0};require(join(build,'main.cjs'));ipcMain.handle=register;
app.whenReady().then(async()=>{try{
 await until(async()=>{const s=await q('snapshot');return s.petAssetsReady&&!s.snapshot.indexing;});
 const file=join(directory,'usage.jsonl'),row=i=>({id:'r'+i,session:'s',timestamp:new Date().toISOString(),model:'gpt-6.1-sol',usage:{input:1000000,output:100000,cacheRead:500000,cacheWrite:0,total:1600000}});
 fs.writeFileSync(file,JSON.stringify(row(0))+'\n');await q('token-action',{action:'save',args:{tool:'custom',path:file,name:'费用刷新样本',format:'jsonl',cacheIncluded:false,mapping:{id:'id',sessionId:'session',timestamp:'timestamp',model:'model',input:'usage.input',output:'usage.output',cacheRead:'usage.cacheRead',cacheWrite:'usage.cacheWrite',total:'usage.total'}}});
 await q('show',{page:'overview'});await until(async()=>panel&&await evaluate('!!document.querySelector(".stats-big-card")'));
 await evaluate('document.querySelector("[data-analytics-tab=cost]").click();true');await until(async()=>await evaluate('(/费用覆盖率|Token 估算覆盖率/.test(document.querySelector(".stats-large-grid")?.textContent))&&!document.querySelector(".stats-status")'));
 await evaluate(`window.costSamples=[];window.costCard=document.querySelector('.stats-big-card');window.costSampling=true;(function sample(){if(!window.costSampling)return;const card=document.querySelector('.stats-big-card');window.costSamples.push({y:card?.getBoundingClientRect().y,status:!!document.querySelector('.stats-status'),same:card===window.costCard});requestAnimationFrame(sample)})()`);
 for(let i=1;i<=10;i++){fs.appendFileSync(file,JSON.stringify(row(i))+'\n');await pause(650);}
 await until(async()=>{const s=await q('token-action',{action:'statistics',args:{preset:'today'}});return s.totals.requests===11;});await pause(700);
 const samples=await evaluate('window.costSampling=false;window.costSamples'),ys=samples.map(r=>r.y).filter(Number.isFinite);report.refresh={samples:samples.length,positionRange:Math.max(...ys)-Math.min(...ys),loadingSamples:samples.filter(r=>r.status).length,replacedCards:samples.filter(r=>!r.same).length};
 const stats=await q('token-action',{action:'statistics',args:{preset:'today'}});report.cost=stats.cost;assert.equal(stats.totals.requests,11);report.capture=await q('capture');
 if(baseline){assert.ok(report.refresh.positionRange>5);assert.ok(report.refresh.loadingSamples>0);assert.equal(stats.cost.coverage,0);}else{assert.ok(report.refresh.positionRange<1);assert.equal(report.refresh.loadingSamples,0);assert.equal(report.refresh.replacedCards,0);assert.equal(stats.cost.coverage,1);assert.ok(stats.cost.amounts.USD>0);assert.ok(stats.cost.basis.includes('非实际账单'));}
 if(!baseline){
  statsDelay=1500;maxActiveCalls=0;for(let i=11;i<=16;i++){fs.appendFileSync(file,JSON.stringify(row(i))+'\n');await pause(400);}
  await until(async()=>await evaluate('[...document.querySelectorAll(".stats-big-card small")].some(n=>n.title.replaceAll(",", "").includes("27200000 / 27200000"))'));assert.equal(maxActiveCalls,1,'One query at a time during slow background refresh');
  const refresh=async()=>{await evaluate('[...document.querySelectorAll(".stats-operations button")].find(b=>b.textContent==="更多").click();true');await until(async()=>await evaluate('!!document.querySelector(".stats-menu")'));await evaluate('[...document.querySelectorAll(".stats-menu button")].find(b=>b.textContent==="刷新").click();true');};
  statsDelay=0;failNext=true;await refresh();await until(async()=>await evaluate('!!document.querySelector(".settings-error")'));assert.ok(await evaluate('document.querySelector(".stats-big-card")===window.costCard'));
  await refresh();await until(async()=>!await evaluate('!!document.querySelector(".settings-error")'));
  statsDelay=1200;await refresh();await until(async()=>activeCalls>0);statsDelay=0;
  const prefs=(await q('snapshot')).settings.preferences.statisticsViews;await q('settings-set',{patch:{statisticsViews:{...prefs,overview:{...prefs.overview,preset:'custom',from:'1999-01-01',to:'1999-01-01'}}}});
  await until(async()=>await evaluate('[...document.querySelectorAll(".stats-big-card small")].some(n=>n.title.includes("0 / 0"))'));await pause(1500);assert.ok(await evaluate('[...document.querySelectorAll(".stats-big-card small")].some(n=>n.title.includes("0 / 0"))'));
  report.slowRefreshSingleFlight=true;report.errorKeepsCards=true;report.retryRecovery=true;report.staleResponseIgnored=true;
 }
 report.ok=true;report.completedAt=new Date().toISOString();fs.writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,report:join(directory,'result.json'),refresh:report.refresh}));await q('quit');
 }catch(e){report.ok=false;report.error=e.stack;fs.writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));console.error(e.stack);app.exit(1);}});
