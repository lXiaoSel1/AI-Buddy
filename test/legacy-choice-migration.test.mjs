import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}]};
test('Initial legacy migration keeps reply choices only in the original default conversation and never resurrects consumed choices',async()=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-legacy-choices-'));let g=await createGalgame({dataRoot,provider,model:'fixture'});g.close();
 const old=createSnapshotStorage(join(dataRoot,'galgame/storages/dsh-whale-galgame/global.json')),companion=createSnapshotStorage(join(dataRoot,'galgame/companion.json'));
 const legacy=await readJson(old),state=await readJson(companion);const choices=[{id:'legacy-positive',text:'继续旧约定',effect:1},{id:'legacy-neutral',text:'稍等一下',effect:0}];
 legacy.current='deepseek';legacy.characters.deepseek.choices=choices;legacy.characters.deepseek.chatLines=[{who:'heroine',text:'旧回复'}];
 await old.writeText(JSON.stringify(legacy));await companion.writeText(JSON.stringify({...state,migrated:false,activeCharacterId:'deepseek',activeConversationId:null,conversations:{}}));
 try{
  g=await createGalgame({dataRoot,provider,model:'fixture'});await g.action('companion-character-select',{id:'deepseek'});
  assert.deepEqual((await g.action('view')).choices,choices);
  const b=(await g.action('companion-persona-save',{name:'另一身份'})).persona;await g.action('companion-persona-select',{id:b.id});assert.deepEqual((await g.action('view')).choices,[]);
  await g.action('companion-persona-select',{id:'default'});assert.deepEqual((await g.action('view')).choices,choices);g.close();
  const consumed=await readJson(createSnapshotStorage(join(dataRoot,'galgame/companion.json')));consumed.conversations[consumed.activeConversationId].choices=[];await createSnapshotStorage(join(dataRoot,'galgame/companion.json')).writeText(JSON.stringify(consumed));
  g=await createGalgame({dataRoot,provider,model:'fixture'});assert.deepEqual((await g.action('view')).choices,[]);
 }finally{g.close();}
});
