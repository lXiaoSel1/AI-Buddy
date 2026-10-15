import {spawn} from 'node:child_process';
import {realpathSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {requestLocalControl} from '../src/local-control.mjs';
const root=resolve(import.meta.dirname,'..'),pkg=realpathSync.native(resolve(process.argv[2])),entry=join(pkg,'AI Buddy.exe'),directory=join(root,'local/buddy-180/portable-startup-'+Date.now()),data=join(directory,'独立测试 数据'),pipe='\\\\.\\pipe\\buddy-178-portable-'+process.pid;
mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'roots.json'),'[]');
const manifest=JSON.parse(readFileSync(join(pkg,'local/current-build.json'))),build=resolve(pkg,manifest.path),groups=JSON.parse(readFileSync(join(build,'assets/character-sequence-manifest.json')));
const args=['--data='+data,'--roots='+join(directory,'roots.json'),'--pipe='+pipe,'--cursor=manual'],env={...process.env,PATH:join(process.env.SystemRoot,'System32')};
for(const key of Object.keys(env))if(/^(?:NODE_|PYTHON|CODEX_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_API|DSH_HOME)/.test(key))delete env[key];
const q=(command,extra={})=>requestLocalControl(pipe,{command,...extra},{timeoutMs:3000}),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+90000;while(Date.now()<end){const v=await fn().catch(()=>null);if(v)return v;await pause(100);}throw Error('Portable validation timeout');}
const launch=()=>new Promise((yes,no)=>{const p=spawn(entry,args,{cwd:process.env.TEMP,windowsHide:true,stdio:'ignore',env});p.on('error',no);p.on('exit',code=>code===0?yes():no(Error('Launcher exited '+code)));});
const report={package:pkg,entry,build,data,modelCalls:0,noExternalNodeOrPython:true,roles:[]};
try{
 assert.equal(Object.keys(groups).length,11);assert.equal(Object.values(groups).reduce((n,c)=>n+Object.keys(c).length,0),198);
 await launch();const s=await until(async()=>{const v=await q('snapshot');return v.petAssetsReady&&!v.snapshot.indexing?v:null;});assert.equal(s.settings.version,'1.8.0');assert.equal(s.dataRoot,data);assert.equal(resolve(s.build),build);assert.equal(s.chat.enabled,false);assert.equal(s.settings.preferences.petScale,1.25);report.defaultScale=1.25;report.startup=true;
 await launch();await pause(1000);assert.equal((await q('snapshot')).processId,s.processId);report.singleInstance=true;
 await q('settings-set',{patch:{followCursor:false,animationSpeed:1,petCharacterMode:'fixed'}});
 for(const id of Object.keys(groups)){
  await q('pet-auto');await q('settings-set',{patch:{petFixedCharacter:id}});await q('pet-play',{action:{id:'emotion-cheerful',characterId:id,durationMs:6000}});
  const a=await until(async()=>{const p=(await q('page-info')).pet.action;return p?.characterId===id&&p.displayedActionId==='emotion-cheerful'&&Number.isInteger(p.sequenceFrame)?p:null;});
  await until(async()=>{const p=(await q('page-info')).pet.action;return p.characterId===id&&p.sequenceFrame!==a.sequenceFrame;});report.roles.push({id,frames:a.sourceFrameCount});
 }
 await q('pet-auto');await q('show',{page:'actions'});await until(async()=>(await q('page-info')).panel?.actionCards?.length===18);assert.deepEqual((await q('page-info')).rendererErrors,[]);report.brand=await q('brand-info');assert.equal(report.brand.appName,'AI Buddy');report.capture=await q('capture');report.ok=true;
}catch(e){report.ok=false;report.error=e.stack;process.exitCode=1;}finally{await q('quit').catch(()=>{});writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,path:join(directory,'result.json'),error:report.error}));}
