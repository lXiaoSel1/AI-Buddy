import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexBinary,resolveCodexBinary,codexHome} from '../src/runtime-discovery.mjs';
import {CodexProvider} from '../src/codex-provider.mjs';
import {CodexImageProvider} from '../src/codex-image-provider.mjs';
import {codexQuota} from '../src/quota-adapters.mjs';
const temp=()=>mkdtempSync(join(tmpdir(),'buddy-codex-'));
const fixture=()=>{const root=temp();return {root,env:{USERPROFILE:root,LOCALAPPDATA:join(root,'Local'),APPDATA:join(root,'Roaming'),PATH:'',ProgramFiles:join(root,'Programs')}};};
const file=path=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'fixture executable');return path;};
test('Desktop-only installation works with empty PATH, no npm, no developer receipt',async()=>{
 const o=fixture(),expected=file(join(o.env.LOCALAPPDATA,'OpenAI/Codex/bin/hash/codex.exe'));
 file(join(o.env.LOCALAPPDATA,'OpenAI/Codex/bin/newer-node/node.exe'));
 assert.equal(await resolveCodexBinary({...o,discoverRegistered:()=>{throw Error('No PowerShell should run for the fast path');}}),expected);
});
test('MSIX registration fallback supports spaces and non-default installation drive',async()=>{
 const o=fixture(),installed=join(o.root,'Other Drive','Windows Apps','OpenAI.Codex_1'),expected=file(join(installed,'app/resources/codex.exe'));
 assert.equal(await resolveCodexBinary({...o,discoverRegistered:async()=>[installed]}),expected);
});
test('New desktop runtime replaces stale cached selection on next attempt',async()=>{
 const o=fixture(),old=file(join(o.env.LOCALAPPDATA,'OpenAI/Codex/bin/old/codex.exe'));
 assert.equal(codexBinary(o),old);unlinkSync(old);
 const next=file(join(o.env.LOCALAPPDATA,'OpenAI/Codex/bin/new/codex.exe'));assert.equal(codexBinary(o),next);
});
test('Missing install and stale explicit paths never fall back to bare codex',async()=>{
 const o=fixture();assert.equal(codexBinary(o),null);
 await assert.rejects(resolveCodexBinary({...o,discoverRegistered:async()=>[]}),error=>error.code==='CODEX_NOT_FOUND'&&!/spawn codex/.test(error.message));
 file(join(o.env.LOCALAPPDATA,'OpenAI/Codex/bin/good/codex.exe'));
 await assert.rejects(resolveCodexBinary({...o,explicit:join(o.root,'missing.exe')}),{code:'CODEX_NOT_FOUND'});
});
test('npm native layouts and quoted PATH are recognized without spawning cmd wrappers',()=>{
 for(const suffix of ['bin','codex']){const o=fixture(),expected=file(join(o.env.APPDATA,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc',suffix,'codex.exe'));assert.equal(codexBinary({...o,arch:'x64'}),expected);}
 const o=fixture(),directory=join(o.root,'Path With Spaces'),expected=file(join(directory,'codex.exe'));assert.equal(codexBinary({...o,env:{...o.env,PATH:'"'+directory+'"'}}),expected);
});
test('Explicit native runtime and CODEX_HOME are independent of npm location',()=>{
 const o=fixture(),expected=file(join(o.root,'custom native/codex.exe'));assert.equal(codexBinary({...o,env:{...o.env,AI_BUDDY_CODEX_PATH:expected}}),expected);assert.equal(codexHome({...o.env,CODEX_HOME:join(o.root,'custom home')}),join(o.root,'custom home'));
});
function server({spawnError=false,loggedIn=true,unsupported=false,capability=true}={}){
 const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.killed=true;}});
 const requests=[];child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){const m=JSON.parse(line);requests.push(m);if(m.id==null)continue;let result={};if(m.method==='account/read')result={account:loggedIn?{type:'chatgpt'}:null,requiresOpenaiAuth:true};if(m.method==='modelProvider/capabilities/read')result={imageGeneration:capability};queueMicrotask(()=>child.stdout.write(JSON.stringify({id:m.id,...(unsupported&&m.method==='modelProvider/capabilities/read'?{error:{code:-32601,message:'Method not found'}}:{result})})+'\n'));}});
 queueMicrotask(()=>spawnError?child.emit('error',Object.assign(Error('spawn codex ENOENT'),{code:'ENOENT'})):child.emit('spawn'));
 return {child,requests};
}
function options(extra={}){const f=fixture();return {binary:join(f.root,'codex.exe'),defaultModel:'fixture',dataRoot:join(f.root,'data'),env:{...f.env,CODEX_HOME:join(f.root,'no-config')},...extra};}
test('Missing optional config still initializes; default stdio does not require --stdio',async()=>{
 let observed,peer;const p=new CodexProvider(options({spawnImpl:(binary,args,spawnOptions)=>{observed={binary,args,spawnOptions};peer=server();return peer.child;}}));p.setEnabled(true);
 try{await p.start();assert.equal(observed.args[0],'app-server');assert.ok(!observed.args.includes('--stdio'));assert.equal(peer.requests.filter(x=>x.method==='initialize').length,1);assert.ok(!peer.requests.some(x=>x.method==='turn/start'));}finally{p.close();}
});
test('Spawn ENOENT clears failed child, retries rediscover, no unhandled stdin error',async()=>{
 let n=0,resolutions=0;const p=new CodexProvider(options({binary:async()=>{resolutions++;return 'fixture.exe';},spawnImpl:()=>server({spawnError:n++===0}).child}));p.setEnabled(true);
 await assert.rejects(p.start(),{code:'ENOENT'});assert.equal(p.child,null);assert.equal(p.starting,null);assert.equal(p.pending.size,0);
 try{await p.start();assert.equal(resolutions,2);assert.ok(p.child);}finally{p.close();}
});
test('Unauthenticated handshake cleans up and retry can use refreshed login',async()=>{
 let n=0;const p=new CodexProvider(options({spawnImpl:()=>server({loggedIn:n++>0}).child}));p.setEnabled(true);
 await assert.rejects(p.start(),/登录/);assert.equal(p.child,null);try{await p.start();assert.ok(p.child);}finally{p.close();}
});
test('Image check separates unsupported protocol and unavailable capability, submits no turn',async()=>{
 for(const mode of [{unsupported:true},{capability:false},{}]){let peer;const p=new CodexImageProvider(options({spawnImpl:()=>{peer=server(mode);return peer.child;}}));try{if(mode.unsupported)await assert.rejects(p.check(),/更新 Codex/);else if(mode.capability===false)await assert.rejects(p.check(),/不支持内置图像/);else assert.equal((await p.check()).imageGeneration,true);assert.ok(!peer.requests.some(x=>x.method==='turn/start'));}finally{p.close();}}
});
test('Quota discovery errors are classified without spawning a missing command',async()=>{
 await assert.rejects(codexQuota({binary:async()=>{throw Error('Codex missing');},folder:temp()}),error=>error.code==='unsupported'&&error.message==='Codex missing');
});
