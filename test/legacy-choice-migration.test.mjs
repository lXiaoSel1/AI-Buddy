import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {tmpDir} from './support/audit-harness.mjs';
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}]};
test('Initial legacy migration keeps reply choices only in the original default conversation and never resurrects consumed choices',async t=>{
 let g;const dataRoot=tmpDir('legacy-choices',{t,beforeRemove:()=>g?.close()}),sourceRoot=tmpDir('choice-bootstrap',{t});
 g=await createGalgame({dataRoot:sourceRoot,provider,model:'fixture'});await g.close();
 const legacyPath='galgame/storages/dsh-whale-galgame/global.json',legacy=await readJson(createSnapshotStorage(join(sourceRoot,legacyPath)));
 const choices=[{id:'legacy-positive',text:'继续旧约定',effect:1},{id:'legacy-neutral',text:'稍等一下',effect:0}];
 legacy.current='deepseek';legacy.characters.deepseek.choices=choices;legacy.characters.deepseek.chatLines=[{who:'heroine',text:'旧回复'}];
 await createSnapshotStorage(join(dataRoot,legacyPath)).writeText(JSON.stringify(legacy));
 const online={...provider,enabled:true,async *stream(options){
  if(/选项生成器/.test(options.system))return;
  yield {type:'text-delta',text:options.purpose==='mood'?'{"changed":false}':'我们继续吧。'};
  yield {type:'finish',reason:{kind:'stop'}};
 }};
 g=await createGalgame({dataRoot,provider:online,model:'fixture'});await g.action('companion-character-select',{id:'deepseek'});
 assert.deepEqual((await g.action('view')).choices,choices);
 const b=(await g.action('companion-persona-save',{name:'另一身份'})).persona;await g.action('companion-persona-select',{id:b.id});assert.deepEqual((await g.action('view')).choices,[]);
 await g.action('companion-persona-select',{id:'default'});assert.deepEqual((await g.action('view')).choices,choices);
 const consumed=await g.action('chat',{choiceId:choices[0].id,text:choices[0].text});assert.deepEqual(consumed.choices,[]);assert.equal(consumed.history.at(-2).text,choices[0].text);
 await g.close();g=await createGalgame({dataRoot,provider,model:'fixture'});assert.deepEqual((await g.action('view')).choices,[]);
});
