import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openCompanionStore,makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {createLifeArchiveRepository} from '../src/companion-life-archive.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const snapshot=text=>({format:'ai-buddy-life-state',version:1,characterId:'deepseek',savedAt:1700000000000,card:{id:'deepseek',name:'Encoded archive fixture',revision:1,fields:{}},life:{id:'life-encoded-fixture',operationId:'operation-encoded-fixture',mode:'normal',groupIntervals:{},workExperiences:[]},relationships:{mode:'independent',byPersona:{default:{level:1,affection:0}}},personas:{default:{id:'default',name:'Default',relationships:{}}},conversations:[],groupEvidence:[],content:{fixtureText:text},dependencies:[]});
async function fixture(t){
 const parent=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??resolve(import.meta.dirname,'../local/test-fixtures'),"");await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'life-base64-regression-')),store=await openCompanionStore(root);
 await store.mutate(state=>{state.cards={deepseek:makeCard({id:'deepseek',name:'Current life must stay'})};state.personas={default:{id:'default',name:'Current persona',relationships:{}}};state.activeCharacterId='deepseek';state.activePersonaId='default';state.conversations={};state.groups={};state.relationships={};state.accountLedger={sentinel:77};ensureLives(state,1700000000001);});
 let validations=0;
 const lives=await createCompanionLives({store,dataRoot:root,call:async(action,args)=>{assert.equal(action,'companion-life-validate');assert.equal(args.characterId,'deepseek');validations++;return{ok:true};}});
 const repository=createLifeArchiveRepository({dataRoot:root}),current=()=>JSON.stringify({cards:store.state.cards,lives:store.state.lives,personas:store.state.personas,relationships:store.state.relationships,conversations:store.state.conversations,groups:store.state.groups,accountLedger:store.state.accountLedger,activeCharacterId:store.state.activeCharacterId,activePersonaId:store.state.activePersonaId});
 t.after(async()=>{await store.flush?.();});return{root,store,lives,repository,current,validations:()=>validations};
}

test('multi-MiB canonical archive imports and exports intact without changing the current life',async t=>{
 const f=await fixture(t),before=f.current();
 // Public synthetic data protects this regression in source distributions.
 // The private real 3,001,019-byte/13-task ZIP is tested separately outside Source.
 const bytes=f.repository.prepare(snapshot(randomBytes(3*1024*1024).toString('base64'))),base64=bytes.toString('base64');assert.ok(base64.length>4000000);
 const archive=await f.lives.import(base64);assert.equal(archive.sha256,digest(bytes));assert.equal(archive.bytes,bytes.length);assert.equal(f.current(),before);assert.equal(f.validations(),1);assert.equal(f.lives.list('deepseek').length,1);
 const exported=f.lives.export(archive.id);assert.equal(exported.base64,base64);assert.equal(exported.sha256,digest(bytes));assert.equal(f.current(),before);
 await f.store.flush();
 const reopened=await openCompanionStore(f.root);assert.equal(reopened.state.lifeArchives[archive.id].sha256,archive.sha256);assert.deepEqual(reopened.state.accountLedger,{sentinel:77});
});

test('strict Base64 alphabet, shape and canonical padding reject before validation or persistence',async t=>{
 const f=await fixture(t),before=f.current();
 for(const value of [undefined,1,{},'A','AAA','AA=A','A===','AAAA\n','AA_A','AA-A','AA中A','AB==','AAB='])await assert.rejects(f.lives.import(value),/人生 ZIP 编码或大小无效/);
 assert.equal(f.validations(),0);assert.equal(f.current(),before);assert.equal(f.lives.list('deepseek').length,0);assert.deepEqual(await readdir(join(f.root,'galgame/life-archives')),[]);
});

test('canonical Base64 cannot bypass unchanged ZIP integrity checks',async t=>{
 const f=await fixture(t),before=f.current(),bytes=Buffer.from(f.repository.prepare(snapshot('integrity fixture'))),central=bytes.readUInt32LE(bytes.length-6),local=bytes.readUInt32LE(central+42),wrong=(bytes.readUInt32LE(local+14)^1)>>>0;
 bytes.writeUInt32LE(wrong,local+14);bytes.writeUInt32LE(wrong,central+16);
 await assert.rejects(f.lives.import(bytes.toString('base64')),/ZIP 内容校验失败/);assert.equal(f.validations(),0);assert.equal(f.current(),before);assert.equal(f.lives.list('deepseek').length,0);assert.deepEqual(await readdir(join(f.root,'galgame/life-archives')),[]);
});
