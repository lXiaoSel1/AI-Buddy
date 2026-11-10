import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,rename,readdir,stat,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {createQqComponent} from '../src/qq-component.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createSocialLogin} from '../src/social-login.mjs';
import {createQqLoginRuntime} from '../src/qq-login-runtime.mjs';
import {SocialLoginDialog} from '../src/social-login-ui.mjs';
import {setLocale} from '../src/i18n.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'round2-qq-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const name=Buffer.from('component.exe'),data=Buffer.from('synthetic component bytes'),packed=deflateRawSync(data),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  const body=Buffer.concat([local,name,packed]),index=Buffer.concat([central,name]);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(body.length,16);
  const bytes=Buffer.concat([body,index,end]),descriptor={version:'4.18.41',bytes:bytes.length,expandedBytes:data.length,sha256:hash(bytes),url:'https://github.com/fixture/component.zip',files:[{path:'component.exe',bytes:data.length,sha256:hash(data)}]};
  return {directory,bytes,data,descriptor};
}
const windows={skip:process.platform!=='win32'||process.arch!=='x64'};
test('Q1 real ensure retries two transient filesystem EPERM failures without downloading or extracting twice',windows,async t=>{
  const f=await fixture(t);let attempts=0,downloads=0,clock=0;const paths=[],waits=[];
  const component=createQqComponent({...f,fetchDownload:async()=>{downloads++;return new Response(f.bytes);},renameOptions:{now:()=>clock,sleepImpl:async ms=>{waits.push(ms);clock+=ms;},renameImpl:async(source,target)=>{paths.push([source,target]);if(++attempts<3)throw Object.assign(Error('synthetic file system denial'),{code:'EPERM',syscall:'rename',path:source,dest:target});await rename(source,target);}}});
  const target=await component.ensure();assert.equal(attempts,3);assert.equal(downloads,1);assert.deepEqual(paths[0],paths[1]);assert.deepEqual(paths[1],paths[2]);assert.deepEqual(waits,[50,100]);assert.equal(await readFile(join(target,'component.exe'),'utf8'),f.data.toString());
  assert.deepEqual(await readdir(f.directory),['napcat-4.18.41']);
});
for(const code of ['EPERM','EACCES','EBUSY'])test('Q1 exhausted '+code+' is bounded, diagnosed and retains the verified part for the next ensure',windows,async t=>{
  const f=await fixture(t);let attempts=0,downloads=0,clock=0;
  const component=createQqComponent({...f,fetchDownload:async()=>{downloads++;return new Response(f.bytes);},renameOptions:{now:()=>clock,sleepImpl:async ms=>{clock+=ms;},renameImpl:async(source,target)=>{attempts++;throw Object.assign(Error('synthetic private absolute path '+f.directory),{code,syscall:'rename',path:source,dest:target});}}});
  await assert.rejects(component.ensure(),error=>{
    assert.equal(error.code,'QQ_COMPONENT_COMMIT_RENAME');assert.equal(error.systemCode,code);assert.equal(error.syscall,'rename');assert.match(error.source,/^stage-[a-f0-9-]{36}$/);assert.equal(error.target,'napcat-4.18.41');assert.doesNotMatch(error.message,/round2-qq-/);return true;
  });assert.equal(attempts,13);assert(clock<10000);assert.equal(downloads,1);
  assert.deepEqual(await readFile(join(f.directory,'napcat-4.18.41.part')),f.bytes);assert.equal(JSON.parse(await readFile(join(f.directory,'.buddy-prepare.json'),'utf8')).phase,'interrupted');
  assert.equal((await readdir(f.directory)).filter(name=>name.startsWith('stage-')).length,0);
  const ready=await createQqComponent({...f,fetchDownload:async()=>assert.fail('verified part must be reused')}).ensure();assert.equal(await readFile(join(ready,'component.exe'),'utf8'),f.data.toString());await assert.rejects(stat(join(f.directory,'napcat-4.18.41.part')),{code:'ENOENT'});
});
test('Q1 cancellation during the rename wait prevents another filesystem attempt',windows,async t=>{
  const f=await fixture(t),controller=new AbortController();let attempts=0;
  const component=createQqComponent({...f,fetchDownload:async()=>new Response(f.bytes),renameOptions:{sleepImpl:async()=>controller.abort(),renameImpl:async()=>{attempts++;throw Object.assign(Error('synthetic lock'),{code:'EPERM'});}}});
  await assert.rejects(component.ensure({signal:controller.signal}),{name:'AbortError'});assert.equal(attempts,1);assert.deepEqual(await readFile(join(f.directory,'napcat-4.18.41.part')),f.bytes);
});
test('Q1 a target created during a rename wait is preserved and never overwritten',windows,async t=>{
  const f=await fixture(t),target=join(f.directory,'napcat-4.18.41');let attempts=0;
  const component=createQqComponent({...f,fetchDownload:async()=>new Response(f.bytes),renameOptions:{sleepImpl:async()=>{await mkdir(target);await writeFile(join(target,'owner.txt'),'preserve');},renameImpl:async()=>{attempts++;throw Object.assign(Error('synthetic lock'),{code:'EBUSY'});}}});
  await assert.rejects(component.ensure(),{code:'QQ_COMPONENT_REPAIR_REQUIRED'});assert.equal(attempts,1);assert.equal(await readFile(join(target,'owner.txt'),'utf8'),'preserve');
});
test('Q1 exhausted real preparation reaches the scan dialog with safe rename diagnostics and exact bilingual recovery guidance',windows,async t=>{
  const f=await fixture(t);let clock=0;
  const component=createQqComponent({...f,fetchDownload:async()=>new Response(f.bytes),renameOptions:{now:()=>clock,sleepImpl:async ms=>{clock+=ms;},renameImpl:async()=>{throw Object.assign(Error('private path '+f.directory),{code:'EPERM'});}}});
  const accounts={list:()=>[],commitLogin:()=>assert.fail('failed preparation cannot commit account')},driver=createQqLoginRuntime({dataRoot:f.directory,build:f.directory,accounts,component}),service=createSocialLogin({accounts,drivers:{qq:driver}});
  t.after(async()=>{setLocale('zh-CN');await service.close();});service.start('qq');
  for(let i=0;i<200&&service.status('qq').phase!=='failed';i++)await new Promise(resolve=>setTimeout(resolve,5));
  const state=service.status('qq');assert.equal(state.phase,'failed');assert.equal(state.errorCode,'QQ_COMPONENT_COMMIT_RENAME');
  assert.equal(state.errorDiagnostic.syscall,'rename');assert.equal(state.errorDiagnostic.systemCode,'EPERM');assert.match(state.errorDiagnostic.source,/^stage-[a-f0-9-]{36}$/);assert.equal(state.errorDiagnostic.target,'napcat-4.18.41');assert.equal(JSON.stringify(state).includes(f.directory),false);
  for(const [language,text] of [['zh-CN','连接组件解压好了，但暂时被系统占用。等几秒再点「重新扫码」，不用重新下载。'],['en','The connection component was extracted but is still in use by the system. Wait a few seconds and click Scan again; nothing will be downloaded again.']]){
    setLocale(language);const html=renderToStaticMarkup(React.createElement(SocialLoginDialog,{platform:'qq',login:{stateOf:()=>state,snapshot:{states:[state]},act(){},busy:false},onClose(){},autoStart:false}));assert.ok(html.includes(text));assert.match(html,/rename/);assert.match(html,/EPERM/);assert.ok(html.includes(state.errorDiagnostic.source));assert.ok(html.includes('napcat-4.18.41'));
  }
});
