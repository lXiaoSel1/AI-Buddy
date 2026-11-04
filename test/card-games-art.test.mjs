import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCardGamesArt} from '../src/card-games-art.mjs';
import {embedCapable,embedTargetFor,pluginPageEntries} from '../src/plugin-embed-targets.mjs';
import {CONTRACT_HASH,CONTRACT_VERSION} from '../src/voice-games/contract.mjs';
import {createNativeVoiceGamesFacade} from '../src/voice-games/native-facade.mjs';

const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aASsAAAAASUVORK5CYII=','base64');
const data=(mime,buffer)=>'data:image/'+mime+';base64,'+buffer.toString('base64');

test('approved card games target is embedded in the ordered plugins group',()=>{
 const record=packageName=>({packageName,enabled:true});
 assert.equal(embedTargetFor('@ai-buddy/card-games'),'card-games');
 assert.equal(embedCapable('card-games','0.1.0-dev.1'),true);
 assert.deepEqual(pluginPageEntries(['card-games','qq-connect','bilibili-companion'].map(name=>record('@ai-buddy/'+name))).map(([id])=>id),['plugin-bilibili','plugin-qq','plugin-card-games']);
});

test('artwork is read by fixed slot and registered sprite identity, never arbitrary paths',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cg-art-'));t.after(()=>rm(dir,{force:true,recursive:true}));
 const build=join(dir,'build'),dataRoot=join(dir,'profile');
 const filename=join(build,'assets','card-games','b','deepseek-cheerful.webp'),media=join(dataRoot,'galgame','media');
 const digest=createHash('sha256').update(png).digest('hex'),name=digest+'.png';
 await mkdir(join(build,'assets','card-games','b'),{recursive:true});
 await mkdir(media,{recursive:true});
 await writeFile(filename,webp);
 await writeFile(join(media,name),png);
 const art=createCardGamesArt({build,dataRoot,getGame:()=>({cardGamesPortrait:id=>id==='custom-test'?'buddy-media://'+name:id==='untrusted'?'file:///private.png':null})});
 assert.deepEqual(await art({kind:'b',id:'deepseek',emotion:'cheerful'}),{url:data('webp',webp)});
 assert.deepEqual(await art({kind:'b',id:'deepseek',emotion:'starry'}),{url:null});
 assert.deepEqual(await art({kind:'p',id:'custom-test'}),{url:data('png',png)});
 assert.deepEqual(await art({kind:'p',id:'untrusted'}),{url:null});
 await assert.rejects(art({kind:'p',id:'../private'}),{code:'GAME_ART_INVALID'});
 await assert.rejects(art({kind:'bg',id:'deepseek',path:filename}),{code:'GAME_ART_INVALID'});
 await assert.rejects(art({kind:'b',id:'deepseek',emotion:'constructor'}),{code:'GAME_ART_INVALID'});
 await writeFile(join(media,name),Buffer.from('unregistered content'));
 assert.deepEqual(await art({kind:'p',id:'custom-test'}),{url:null});
 const outside=join(dir,'unapproved'),bg=join(build,'assets','card-games','bg');
 await mkdir(outside);
 await writeFile(join(outside,'deepseek.webp'),webp);
 await symlink(outside,bg,process.platform==='win32'?'junction':'dir');
 assert.deepEqual(await art({kind:'bg',id:'deepseek'}),{url:null});
});

test('artwork requires a grant and matching UI principal before and after an asynchronous read',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'cg-grant-'));t.after(()=>rm(dataRoot,{force:true,recursive:true}));
 const origin={runtimeId:'test',profileId:'isolated',pid:11},identity={packageName:'@ai-buddy/card-games',pluginId:'dsh.card-fixture',exactVersion:'0.1.0-dev.1',sourceDigest:'a'.repeat(64)};
 let allowed=false,resolveArt,begin;const started=new Promise(resolve=>{begin=resolve;});
 const facade=createNativeVoiceGamesFacade({dataRoot,resolveGrant:()=>({...identity,enabled:true,generation:1,declaredCapabilities:['games.table'],granted:allowed?['games.table']:[]}),authorizeUI:async()=>true,games:{describe:()=>({}),principalScope:()=>({personaId:'fixture'}),close:async()=>{},pauseAll:async()=>{}},art:async()=>{begin();return new Promise(resolve=>{resolveArt=resolve;});}});
 t.after(()=>facade.close());
 const {sessionToken}=await facade.open({identity,origin,contractHash:CONTRACT_HASH,contractVersion:CONTRACT_VERSION});
 const run=(method,payload)=>facade.dispatch({sessionToken,method,payload},origin);
 const auth={request:{method:'POST'},action:'games.table.art'};
 await assert.rejects(run('ui.authorize',auth),{code:'VOICE_GAMES_CAPABILITY_DENIED'});
 allowed=true;
 await assert.rejects(run('games.table.art',{kind:'bg',id:'deepseek'}),{code:'VOICE_GAMES_PRINCIPAL_REQUIRED'});
 const principal=await run('ui.authorize',auth);
 const pending=run('games.table.art',{kind:'bg',id:'deepseek',principal});
 await started;
 allowed=false;
 resolveArt({url:'asset'});
 await assert.rejects(pending,{code:'VOICE_GAMES_CAPABILITY_DENIED'});
});
