import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openCompanionStore,makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {createLifeArchiveRepository,workEvidenceHash} from '../src/companion-life-archive.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const snapshot=text=>({format:'ai-buddy-life-state',version:1,characterId:'deepseek',savedAt:1700000000000,card:{id:'deepseek',name:'Encoded archive fixture',revision:1,fields:{}},life:{id:'life-encoded-fixture',operationId:'operation-encoded-fixture',mode:'normal',groupIntervals:{},workExperiences:[]},relationships:{mode:'independent',byPersona:{default:{level:1,affection:0}}},personas:{default:{id:'default',name:'Default',relationships:{}}},conversations:[],groupEvidence:[],content:{fixtureText:text},dependencies:[]});
async function fixture(t,{imageCodec,workBridge}={}){
 const parent=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??resolve(import.meta.dirname,'../local/test-fixtures'),"");await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'life-base64-regression-')),store=await openCompanionStore(root);
 await store.mutate(state=>{state.cards={deepseek:makeCard({id:'deepseek',name:'Current life must stay'})};state.personas={default:{id:'default',name:'Current persona',relationships:{}}};state.activeCharacterId='deepseek';state.activePersonaId='default';state.conversations={};state.groups={};state.relationships={};state.accountLedger={sentinel:77};ensureLives(state,1700000000001);});
 let validations=0;
 const lives=await createCompanionLives({store,dataRoot:root,imageCodec,workBridge,call:async(action,args)=>{assert.equal(action,'companion-life-validate');assert.equal(args.characterId,'deepseek');validations++;return{ok:true};}});
 const repository=createLifeArchiveRepository({dataRoot:root,imageCodec}),current=()=>JSON.stringify({cards:store.state.cards,lives:store.state.lives,personas:store.state.personas,relationships:store.state.relationships,conversations:store.state.conversations,groups:store.state.groups,accountLedger:store.state.accountLedger,activeCharacterId:store.state.activeCharacterId,activePersonaId:store.state.activePersonaId});
 t.after(async()=>{await store.close();});return{root,store,lives,repository,current,validations:()=>validations};
}

test('multi-MiB canonical archive imports and exports intact without changing the current life',async t=>{
 const f=await fixture(t),before=f.current();
 // Public synthetic data protects this regression in source distributions.
 // The private real 3,001,019-byte/13-task ZIP is tested separately outside Source.
 const bytes=f.repository.prepare(snapshot(randomBytes(3*1024*1024).toString('base64'))),base64=bytes.toString('base64');assert.ok(base64.length>4000000);
 const archive=await f.lives.import(base64);assert.equal(archive.sha256,digest(bytes));assert.equal(archive.bytes,bytes.length);assert.equal(f.current(),before);assert.equal(f.validations(),1);assert.equal((await f.lives.list('deepseek')).length,1);
 const exported=await f.lives.export(archive.id);assert.equal(exported.base64,base64);assert.equal(exported.sha256,digest(bytes));assert.equal(f.current(),before);
 await f.store.flush();
 const reopened=await openCompanionStore(f.root);try{assert.equal(reopened.records.get('root.lifeArchives','',archive.id).sha256,archive.sha256);assert.deepEqual(reopened.state.accountLedger,{sentinel:77});}finally{await reopened.close();}
});

test('strict Base64 alphabet, shape and canonical padding reject before validation or persistence',async t=>{
 const f=await fixture(t),before=f.current();
 for(const value of [undefined,1,{},'A','AAA','AA=A','A===','AAAA\n','AA_A','AA-A','AA中A','AB==','AAB='])await assert.rejects(f.lives.import(value),/人生 ZIP 编码或大小无效/);
 assert.equal(f.validations(),0);assert.equal(f.current(),before);assert.equal((await f.lives.list('deepseek')).length,0);assert.deepEqual(await readdir(join(f.root,'galgame/life-archives')),[]);
});

test('canonical Base64 cannot bypass unchanged ZIP integrity checks',async t=>{
 const f=await fixture(t),before=f.current(),bytes=Buffer.from(f.repository.prepare(snapshot('integrity fixture'))),central=bytes.readUInt32LE(bytes.length-6),local=bytes.readUInt32LE(central+42),wrong=(bytes.readUInt32LE(local+14)^1)>>>0;
 bytes.writeUInt32LE(wrong,local+14);bytes.writeUInt32LE(wrong,central+16);
 await assert.rejects(f.lives.import(bytes.toString('base64')),/ZIP 内容校验失败/);assert.equal(f.validations(),0);assert.equal(f.current(),before);assert.equal((await f.lives.list('deepseek')).length,0);assert.deepEqual(await readdir(join(f.root,'galgame/life-archives')),[]);
});

test('life ZIP validates each message before publishing and retains repeated Unicode IDs',async t=>{
 const f=await fixture(t),before=f.current(),target=snapshot('message validation fixture');
 const owner={id:'archive-conversation',characterId:'deepseek',personaId:'default',lifeId:target.life.id};
 const archiveWith=messages=>f.repository.prepare({...target,conversations:[{...owner,messages}]}).toString('base64');
 for(const invalid of [null,[],{},'message',{id:7},{id:''}]){
  await assert.rejects(f.lives.import(archiveWith([invalid])),/人生会话归属或消息无效/);
 }
 assert.equal(f.validations(),0);
 assert.equal(f.current(),before);
 assert.deepEqual(await f.lives.list('deepseek'),[]);
 assert.deepEqual(await readdir(join(f.root,'galgame/life-archives')),[]);
 const repeated='原文-\ud800',messages=[
  {id:repeated,role:'user',text:'first',createdAt:1700000000000},
  {id:repeated,role:'user',text:'second',createdAt:1700000000001}
 ];
 const bytes=archiveWith(messages),saved=await f.lives.import(bytes);
 assert.equal(f.validations(),1);
 const exported=await f.lives.export(saved.id);
 assert.equal(exported.base64,bytes);
 assert.deepEqual(f.repository.decode(Buffer.from(exported.base64,'base64')).snapshot.conversations[0].messages,messages);
});

const workPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=';
function workSnapshot(event){
 const raw=snapshot('work evidence fixture');
 raw.version=2;raw.requiredCapabilities=['work-task-evidence-v1'];
 const work={version:1,characterId:raw.characterId,lifeId:raw.life.id,tasks:[{
  id:'fixture-task',scope:{characterId:raw.characterId,lifeId:raw.life.id,personaId:'default'},
  workspace:{id:'fixture-workspace',path:'synthetic'},events:[event]
 }]};
 work.sha256=workEvidenceHash(work);raw.workEvidence=work;return raw;
}
const imageCodec=()=>({width:1,height:1}),workBridge={restore(){throw Error('Import/preview must not restore work');}};
test('work event images preserve their complete hash through worker preview and export',async t=>{
 const f=await fixture(t,{imageCodec,workBridge}),raw=workSnapshot({avatar:workPng,unknownField:'as saved'});
 const bytes=f.repository.prepare(raw),uploaded=await f.lives.import(bytes.toString('base64'));
 const preview=await f.lives.preview(uploaded.id);
 assert.equal(preview.workTaskCount,1);assert.equal(preview.workEvidence,undefined);
 const exported=await f.lives.export(uploaded.id);
 assert.deepEqual(Buffer.from(exported.base64,'base64'),bytes);
 assert.deepEqual(f.repository.decode(bytes).snapshot.workEvidence,raw.workEvidence);
});

test('portable worker import returns only the bounded work bridge requirement',async t=>{
 const f=await fixture(t,{workBridge}),bytes=f.repository.prepare(workSnapshot({text:'long event '.repeat(1000)}));
 const original=f.store.prepareLifeImport;let received;
 t.mock.method(f.store,'prepareLifeImport',async(...args)=>{const result=await original(...args);received=result.target;return result;});
 assert.ok(await f.lives.import(bytes.toString('base64')));
 assert.equal(received.requiresWorkBridge,true);
 assert.equal(Object.hasOwn(received,'workEvidence'),false);
 const denied=await createCompanionLives({store:f.store,dataRoot:f.root,call:()=>{throw Error('Unsupported work must fail before engine validate');}});
 await assert.rejects(denied.import(bytes.toString('base64')),/工作证据/);
});
