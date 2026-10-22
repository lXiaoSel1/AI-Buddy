import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createCompanionService} from '../src/companion-service.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {tmpDir,memoryStore,syntheticEngine,companionFixture} from './support/audit-harness.mjs';

const HISTORY={claude:[{who:'user',text:'旧消息一'},{who:'heroine',text:'旧回复一'},{who:'narrator',text:'（分别了太久……好感度下降了 1 点。）'}]};
const count=(state,text,id='claude')=>Object.values(state.conversations).filter(c=>c.characterId===id).reduce((n,c)=>n+c.messages.filter(m=>m.text===text).length,0);
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),runTurn:async fn=>fn(),resolveContextCapacity:()=>({tokens:8192,source:'fixture',verified:true})};

test('B12: legacy lines are imported once; new or archived conversations and restarts add no copies',async t=>{
 const root=tmpDir('b12-synthetic',{t}),store=memoryStore(await companionFixture()),{engine}=syntheticEngine({getStore:()=>store,history:HISTORY}),copies=[];
 const start=async()=>{const service=await createCompanionService({store,engine,provider,dataRoot:root,now:Date.now});copies.push(count(store.state,'旧消息一'));return service;};
 let s=await start();s.close();
 assert.equal(Object.keys(store.state.legacyImports.claude).length,3);
 s=await start();await s.action('companion-conversation-new',{characterId:'claude'});s.close();
 s=await start();s.close();
 s=await start();for(const c of Object.values(store.state.conversations).filter(c=>c.characterId==='claude'))await s.action('companion-conversation-update',{id:c.id,archived:true});s.close();
 s=await start();s.close();
 assert.deepEqual(copies,[1,1,1,1,1]);
});

test('B12: an existing copy in any conversation, archived included, is matched instead of copied again',async t=>{
 const state=await companionFixture();state.lives.claude.legacyImportEnabled=true;
 const at=state.conversations.conversation.createdAt;
 state.conversations.old={id:'old',characterId:'claude',personaId:'default',lifeId:state.lives.claude.id,title:'old',archived:true,createdAt:at,updatedAt:at,draft:'',choices:[],messages:HISTORY.claude.map((m,i)=>({id:'old-'+i,role:m.who==='user'?'user':m.who==='heroine'?'assistant':'narrator',text:m.text,legacy:true,createdAt:0,revisions:[]}))};
 state.conversations.fresh={id:'fresh',characterId:'claude',personaId:'default',lifeId:state.lives.claude.id,title:'new',archived:false,createdAt:at+1,updatedAt:Date.now(),draft:'',choices:[],messages:[]};
 const root=tmpDir('b12-existing',{t}),store=memoryStore(state),{engine}=syntheticEngine({getStore:()=>store,history:HISTORY});
 (await createCompanionService({store,engine,provider,dataRoot:root,now:Date.now})).close();
 for(const line of HISTORY.claude)assert.equal(count(store.state,line.text),1,line.text);
});

test('B12: a line the engine adds later arrives once; a deleted copy does not come back',async t=>{
 const root=tmpDir('b12-later',{t}),history={claude:[...HISTORY.claude]},store=memoryStore(await companionFixture()),{engine}=syntheticEngine({getStore:()=>store,history});
 const start=async()=>(await createCompanionService({store,engine,provider,dataRoot:root,now:Date.now})).close();
 await start();history.claude.push({who:'narrator',text:'（分别了太久……好感度下降了 1 点。）'});await start();await start();
 assert.equal(count(store.state,'（分别了太久……好感度下降了 1 点。）'),2,'the same text written twice by the engine is two lines');
 await store.mutate(s=>{for(const c of Object.values(s.conversations))c.messages=c.messages.filter(m=>m.text!=='旧回复一');});await start();
 assert.equal(count(store.state,'旧回复一'),0);
});

test('B12: real engine — restarts and new conversations keep one copy, and pre-life CGs stay visible',async t=>{
 const dataRoot=tmpDir('b12-real',{t}),p={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}]};
 const companion=async()=>readJson(createSnapshotStorage(join(dataRoot,'galgame','companion.json')),null);
 let g=await createGalgame({dataRoot,provider:p,model:'fixture'});const current=(await g.action('view')).current;g.close();
 const legacyStore=createSnapshotStorage(join(dataRoot,'galgame','storages','dsh-whale-galgame','global.json')),legacy=await readJson(legacyStore,null);
 legacy.characters[current].chatLines=[...(legacy.characters[current].chatLines??[]),{who:'user',text:'旧版本里的一句话'},{who:'heroine',text:'旧版本里的回答'}];
 legacy.characters[current].cgs=[{id:'legacy-cg',status:'ready',at:1,level:2,dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII='}];
 await legacyStore.writeText(JSON.stringify(legacy));
 // A store written by 1.9.0 still has the flag on: the next start imports, then turns it off.
 const store=createSnapshotStorage(join(dataRoot,'galgame','companion.json')),before=await companion();before.lives[current].legacyImportEnabled=true;await store.writeText(JSON.stringify(before));
 const copies=async()=>{const s=await companion();return Object.values(s.conversations).filter(c=>c.characterId===current).reduce((n,c)=>n+c.messages.filter(m=>m.text==='旧版本里的一句话').length,0);};
 const rows=[];
 g=await createGalgame({dataRoot,provider:p,model:'fixture'});await g.action('companion-state');assert.ok((await g.action('cg-gallery',{characterId:current})).items.some(cg=>cg.id==='legacy-cg'));g.close();rows.push(await copies());
 g=await createGalgame({dataRoot,provider:p,model:'fixture'});await g.action('companion-conversation-new',{characterId:current});g.close();rows.push(await copies());
 g=await createGalgame({dataRoot,provider:p,model:'fixture'});await g.action('companion-state');assert.ok((await g.action('cg-gallery',{characterId:current})).items.some(cg=>cg.id==='legacy-cg'));g.close();rows.push(await copies());
 assert.deepEqual(rows,[1,1,1]);
 assert.ok(Object.keys((await companion()).legacyImports[current]).length>=2,'the ledger survives restarts');
});
