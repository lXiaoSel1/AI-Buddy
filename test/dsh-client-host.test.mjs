import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createDshClientHost,trustedDshLocation} from '../src/dsh-platform/client-host.mjs';
// Unit/simulated Electron objects. These checks are not real native UI evidence.

test('native client origin rejects external, credentialed and non-literal-loopback addresses',()=>{
  assert.equal(trustedDshLocation('http://127.0.0.1:4567/?token=secret','http://127.0.0.1:4567').hostname,'127.0.0.1');
  for(const [url,origin] of [['https://example.com','http://127.0.0.1:4567'],['http://localhost:4567','http://localhost:4567'],['http://user:pass@127.0.0.1:4567','http://127.0.0.1:4567'],['file:///C:/secret','file:///C:/secret'],['http://127.0.0.1:4568','http://127.0.0.1:4567'],['http://127.1:4567','http://127.0.0.1:4567'],['http://2130706433:4567','http://127.0.0.1:4567'],['http://127.0.0.1:4567','http://127.0.0.1:4567/?token=secret']])assert.throws(()=>trustedDshLocation(url,origin));
});

test('unit/sim: external auth redirect is denied, runtime identity cannot silently reuse another profile',async()=>{
  const made=[];class Window extends EventEmitter{constructor(options){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};made.push(this);}async loadURL(){}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}}
  const host=createDshClientHost({BrowserWindow:Window,session:{fromPartition(){return Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){}});}}}),descriptor={runtimeId:'r',profileId:'p',webOrigin:'http://127.0.0.1:4567',authURL:'http://127.0.0.1:4567/auth?token=secret'};
  try{assert.equal((await host.open(descriptor)).state,'page-loaded');let denied=false;made[0].webContents.emit('will-redirect',{preventDefault(){denied=true;}},'https://evil.invalid/collect?token=secret');assert.equal(denied,true);await assert.rejects(host.open({...descriptor,profileId:'other'}),{code:'DSH_CLIENT_DENIED'});await assert.rejects(host.open({...descriptor,webOrigin:'http://127.0.0.1:4568',authURL:'http://127.0.0.1:4568/auth'}),{code:'DSH_CLIENT_DENIED'});assert.equal(made.length,1);}finally{await host.close();}
});

test('unit/sim: closing while auth page loads never reports a connected client or leaks launch token',async()=>{
  let complete,entered;const started=new Promise(r=>{entered=r;}),states=[];class Window extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}loadURL(){entered();return new Promise(resolve=>{complete=resolve;});}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}}
  const host=createDshClientHost({BrowserWindow:Window,session:{fromPartition(){return {setPermissionRequestHandler(){}};}},onState:value=>states.push(value)}),opening=host.open({runtimeId:'r',profileId:'p',webOrigin:'http://127.0.0.1:4567',authURL:'http://127.0.0.1:4567/auth?token=top-secret'}),rejected=assert.rejects(opening,{code:'DSH_CLIENT_CLOSED'});
  await started;await host.close();complete();await rejected;assert.ok(!states.some(s=>['connected','page-loaded'].includes(s.state)));assert.ok(!JSON.stringify(states).includes('top-secret'));
});

test('unit/sim: failed auth load errors never echo token-bearing URLs',async()=>{
  class Window extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}async loadURL(url){throw Error('load failed '+url);}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}}
  const host=createDshClientHost({BrowserWindow:Window,session:{fromPartition(){return {setPermissionRequestHandler(){}};}}});try{await assert.rejects(host.open({runtimeId:'r',profileId:'p',webOrigin:'http://127.0.0.1:4567',authURL:'http://127.0.0.1:4567/auth#token=secret-value'}),error=>error.code==='DSH_CLIENT_LOAD_FAILED'&&!error.message.includes('secret-value'));}finally{await host.close();}
});

test('a usable native document becomes visible while optional network resources still load',async()=>{
  let instance,complete;class Window extends EventEmitter{constructor(){super();instance=this;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}loadURL(){return new Promise(r=>{complete=r;});}isDestroyed(){return !!this.dead;}show(){this.visible=true;}destroy(){this.dead=true;this.emit('closed');}}
  const host=createDshClientHost({BrowserWindow:Window,session:{fromPartition(){return {setPermissionRequestHandler(){}};}}}),opening=host.open({runtimeId:'r',profileId:'p',webOrigin:'http://127.0.0.1:4567',authURL:'http://127.0.0.1:4567/auth'});
  await new Promise(r=>setImmediate(r));assert.equal(instance.visible,undefined);instance.webContents.emit('dom-ready');assert.equal(instance.visible,true);assert.equal(host.snapshot()[0].state,'loading');complete();assert.equal((await opening).state,'page-loaded');await host.close();
});

test('native host provides no preload or Node and closes only its own runtime pages',async()=>{
  const made=[],sessions=[];
  class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=handler=>this.newWindow=handler;made.push(this);}async loadURL(url){this.url=url;}isDestroyed(){return !!this.dead;}show(){}focus(){}destroy(){this.dead=true;this.emit('closed');}}
  const host=createDshClientHost({BrowserWindow:Window,session:{fromPartition(name){const s=new EventEmitter();s.name=name;s.setPermissionRequestHandler=handler=>s.request=handler;s.setPermissionCheckHandler=handler=>s.check=handler;sessions.push(s);return s;}}});
  const descriptor={runtimeId:'runtime-a',profileId:'buddy-community-v1',webOrigin:'http://127.0.0.1:4567',authURL:'http://127.0.0.1:4567/?token=secret'};
  await host.open(descriptor);await host.open(descriptor);assert.equal(made.length,1);
  const prefs=made[0].options.webPreferences;assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.equal(prefs.preload,undefined);assert.deepEqual(made[0].newWindow(),{action:'deny'});
  let prevented=false;made[0].webContents.emit('will-navigate',{preventDefault(){prevented=true;}},'https://example.com');assert.equal(prevented,true);
  let grant=true;sessions[0].request(null,'camera',value=>grant=value);assert.equal(grant,false);
  assert.equal(JSON.stringify(host.snapshot()).includes('secret'),false);await host.close();assert.equal(made[0].dead,true);assert.deepEqual(host.snapshot(),[]);await assert.rejects(host.open(descriptor),{code:'DSH_CLIENT_CLOSED'});
});
