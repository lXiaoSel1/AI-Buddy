import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
import test from 'node:test';
import {createGalgame} from '../src/galgame-host.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {makeCard} from '../src/companion-store.mjs';

test('portable life ZIP can be transferred in bounded chunks and still imports byte-for-byte',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ai-buddy-r17-life-transfer-'));
 const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'})};
 const createdAt=1730000000000,characterId='deepseek',personaId='default',chatId='transfer-chat';
 const source={schema:1,activeCharacterId:characterId,activePersonaId:personaId,activeConversationId:chatId,
  cards:{[characterId]:makeCard({id:characterId,name:'Transfer fixture'})},personas:{[personaId]:{id:personaId,name:'Default'}},
  groups:{},relationships:{},draftCards:{},events:{},touchQuotas:{},settings:{},conversations:{[chatId]:{id:chatId,characterId,personaId,messages:Array.from({length:120},(_,i)=>({
   id:'transfer-message-'+i,role:i%2?'assistant':'user',status:'presented',text:randomBytes(4700).toString('base64'),createdAt:createdAt+i}))}}};
 ensureLives(source,createdAt);
 await mkdir(join(root,'galgame'));await writeFile(join(root,'galgame','companion.json'),JSON.stringify(source));
 const game=await createGalgame({dataRoot:root,provider,model:'fixture'});
 t.after(async()=>{await game.close();await rm(root,{recursive:true,force:true});});
 const action=(suffix,args)=>game.action('companion-life-'+suffix,args);
 const saved=await action('save',{characterId:'deepseek'});
 assert.equal(saved.ok,true,saved.error);
 const id=saved.archive.id,legacy=await action('export',{id});
 assert.equal(legacy.ok,true,legacy.error);
 const opened=await action('export',{id,transfer:true});
 assert.equal(opened.ok,true,opened.error);
 const {transfer}=opened;
 assert.ok(transfer?.id,'portable ZIP must open an export capability');
 assert.ok(transfer.bytes>transfer.chunkBytes,'fixture must require multiple chunks');
 assert.equal(opened.archive,undefined);
 const chunks=[];
 for(let offset=0;offset<transfer.bytes;){
  const part=await action('export-chunk',{id:transfer.id,offset});
  assert.equal(part.ok,true,part.error);
  assert.ok(part.data.length>0&&part.data.length<=transfer.chunkBytes);
  chunks.push(Buffer.from(part.data));offset+=part.data.length;
 }
 assert.equal(Buffer.concat(chunks).toString('base64'),legacy.archive.base64);
 assert.equal((await action('transfer-abort',{id:transfer.id})).ok,true);
 await assert.rejects(action('export-chunk',{id:transfer.id,offset:0}),/人生存档不存在/);
 const incoming=await action('import-begin',{bytes:transfer.bytes});
 assert.equal(incoming.ok,true,incoming.error);
 let offset=0;
 for(const data of chunks){
  const part=await action('import-chunk',{id:incoming.transfer.id,offset,data});
  assert.equal(part.ok,true,part.error);offset+=data.length;
 }
 const imported=await action('import-finish',{id:incoming.transfer.id});
 assert.equal(imported.ok,true,imported.error);
 assert.notEqual(imported.archive.id,id);
 assert.equal(imported.archive.sha256,saved.archive.sha256);
 assert.deepEqual(await readdir(join(root,'galgame','.life-archive-transfers')),[]);
});

test('a persona switch while an archive preview is being verified cannot expose the old scoped preview',{timeout:8000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'ai-buddy-r17-life-preview-scope-'));
 const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'})};
 const reached=Promise.withResolvers(),release=Promise.withResolvers();
 let pause=false;
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',imageValidator:async()=>{
  if(pause){reached.resolve();await release.promise;}
  return true;
 }});
 t.after(async()=>{release.resolve();await game.close();await rm(root,{recursive:true,force:true});});
 const avatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLmQAAAAASUVORK5CYII=';
 const card=(await game.action('companion-character-save',{name:'Archive avatar fixture',avatar})).card;
 const persona=(await game.action('companion-persona-save',{name:'Preview visitor'})).persona;
 await game.action('companion-persona-select',{id:'default'});
 const saved=(await game.action('companion-life-save',{characterId:card.id})).archive;
 pause=true;
 const preview=game.action('companion-life-preview',{id:saved.id});
 const rejected=assert.rejects(preview,{code:'LIFE_ARCHIVE_PREVIEW_STALE'});
 let selection;
 try{
  await reached.promise;
  selection=game.action('companion-persona-select',{id:persona.id});
  for(let attempt=0;attempt<100&&game.context().personaId!==persona.id;attempt++)await delay(5);
  assert.equal(game.context().personaId,persona.id);
 }finally{release.resolve();}
 await selection;
 await rejected;
});
