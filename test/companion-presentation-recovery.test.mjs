import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGalgame} from '../src/galgame-host.mjs';
import {visibleInterruptedText} from '../src/companion-presentation.mjs';
const label='[2026-10-31; character-statement; persona:default]';
test('a private interrupted journal reopens with its raw evidence intact and its empty safe presentation respected',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-display-recovery-'));let game;
 t.after(async()=>{await game?.close();await rm(root,{recursive:true,force:true});});
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(){yield{type:'text-delta',text:label};throw Error('synthetic interrupted transport');}};
 game=await createGalgame({dataRoot:root,provider,model:'fixture'});await assert.rejects(game.action('chat',{text:'你好'}),/synthetic interrupted transport/);await game.close();game=null;
 game=await createGalgame({dataRoot:root,provider,model:'fixture'});const result=await game.action('view'),state=result.companion??result,journal=state.interruptedReply;
 assert.ok(journal,'the kept interrupted request is available after reopening');assert.equal(journal.text,label);assert.equal(journal.visibleText,'');assert.equal(visibleInterruptedText(journal),'');assert.equal(journal.text,label,'the display projection never changes the original model evidence');
});
