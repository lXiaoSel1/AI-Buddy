import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPluginEmbed} from '../src/plugin-embed.mjs';
import {createNativeSocialFacade} from '../src/buddy-plugin-services/native-social-facade.mjs';
const settle=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t,{gate=async()=>{}}={}){
 const root=await mkdtemp(join(tmpdir(),'embed-admission-')),records=new Map(),opened=[],admitted=[];
 const identities=Object.fromEntries(['bilibili','qq'].map((id,i)=>[id,{pluginId:'dsh.'+id,packageName:'@ai-buddy/'+(id==='bilibili'?'bilibili-companion':'qq-connect'),sourceDigest:String(i+1).repeat(64),exactVersion:'2.0.2'}]));
 const facade=createNativeSocialFacade({dataRoot:root,contract:{hash:'h',methods:['social.context.read']},handlers:{'social.context.read':async()=>({})},contextProvider:async()=>({}),authorizeUI:async()=>true,resolveGrant:async identity=>records.get(identity.pluginId)}),origin={runtimeId:'private-runtime',profileId:'community',pid:123},sessions={};
 for(const [id,identity]of Object.entries(identities)){records.set(identity.pluginId,{...identity,enabled:false,granted:['social.context.read']});sessions[id]=await facade.open({identity,origin,contractHash:'h'});}
 const authorize=id=>facade.dispatch({sessionToken:sessions[id].sessionToken,method:'authorize',payload:{action:'status',request:{method:'POST'}}},origin),activate=target=>records.set(identities[target].pluginId,{...identities[target],enabled:true,granted:['social.context.read']});
 class Contents extends EventEmitter{constructor(){super();this.panel='';this.dead=false;}executeJavaScript(code){const m=/id=("[^"]+")/.exec(code);if(m)this.panel=JSON.parse(m[1]);return Promise.resolve('1|'+this.panel);}loadURL(){}isDestroyed(){return this.dead;}close(){this.dead=true;this.emit('destroyed');}focus(){}reload(){}}
 class View{constructor(){this.webContents=new Contents();}setVisible(v){this.visible=v;}setBounds(){}}
 const panel={isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,isFocused:()=>true,getContentSize:()=>[1000,800],contentView:{addChildView(){},removeChildView(){}}};
 const embed=createPluginEmbed({WebContentsView:View,getPanel:()=>panel,admit:async target=>{admitted.push(target);await gate(target);activate(target);},open:async(target,surface)=>{opened.push(target);activate(target);const s=surface({webPreferences:{}});s.webContents.emit('did-finish-load');s.show();},openWindow:async()=>{},sleep:()=>new Promise(resolve=>setImmediate(resolve)),pollMs:0});
 t.after(async()=>{embed.close();await facade.close();await rm(root,{recursive:true,force:true});});
 return{embed,authorize,opened,admitted,snapshot:()=>embed.snapshot().find(row=>row.kind==='community'),open:async target=>{await embed.handle({op:'slot',target,rect:{x:0,y:0,width:1000,height:800}});await embed.handle({op:'open',target});await settle();}};
}
test('reused shared page admits each target after restart without recreating the surface',async t=>{
 const f=await fixture(t);await f.open('bilibili');await f.authorize('bilibili');await f.open('qq');assert.equal(f.snapshot().state,'run');assert.equal(f.snapshot().target,'qq');await assert.doesNotReject(f.authorize('qq'));assert.deepEqual(f.admitted,['bilibili','qq']);assert.deepEqual(f.opened,['bilibili']);
});
test('native facade still refuses an inactive grant and accepts the ordinary fresh host open',async t=>{
 const f=await fixture(t);await assert.rejects(f.authorize('qq'),{code:'BUDDY_CAPABILITY_DENIED'});await f.open('qq');await assert.doesNotReject(f.authorize('qq'));
});
test('a denied target cannot expose its shared panel or borrow the other plugin grant',async t=>{
 const f=await fixture(t,{gate:async target=>{if(target==='qq')throw Object.assign(Error('disabled'),{code:'PLUGIN_EMBED_NOT_ENABLED'});}});await f.open('bilibili');await f.open('qq');assert.equal(f.snapshot().state,'idle');assert.equal(f.snapshot().visible,false);await assert.rejects(f.authorize('qq'),{code:'BUDDY_CAPABILITY_DENIED'});
});
test('late admission cannot replace a newer target',async t=>{
 const hold=deferred(),f=await fixture(t,{gate:target=>target==='qq'?hold.promise:Promise.resolve()});await f.open('bilibili');const pending=f.open('qq');await settle();assert.equal(f.snapshot().visible,false);await f.open('bilibili');hold.resolve();await pending;assert.equal(f.snapshot().target,'bilibili');assert.equal(f.snapshot().state,'run');assert.deepEqual(f.opened,['bilibili']);
});
test('release cancels pending admission without recreating a closed shared surface',async t=>{
 const hold=deferred(),f=await fixture(t,{gate:target=>target==='qq'?hold.promise:Promise.resolve()});await f.open('bilibili');const pending=f.open('qq');await settle();f.embed.release();hold.resolve();await pending;assert.equal(f.snapshot().state,'idle');assert.equal(f.snapshot().visible,false);assert.deepEqual(f.opened,['bilibili']);
});
test('the main host wires target admission to installed-package activation',async()=>{
 const source=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8'),start=source.indexOf('admit:async target=>'),end=source.indexOf('open:async(target,surface)=>',start);assert.ok(start>=0&&end>start);assert.match(source.slice(start,end),/plugins\.activateInstalled\(record\.packageKey\)/);
});
