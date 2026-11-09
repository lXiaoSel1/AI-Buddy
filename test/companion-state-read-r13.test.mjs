import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createGalgame} from '../src/galgame-host.mjs';

// R13: the Galgame page polls companion-state every 900 ms while a group is busy (Auto, voice
// presentation). Each read used to clone the whole companion archive once per character plus once
// more, about 160 ms on the main thread with a 3.6 MB archive, which the desktop pet's forwarded
// mouse hook turns into a stalled cursor. A read with nothing to absorb must not copy the archive.
const isArchive=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&'cards' in value&&'conversations' in value&&'relationships' in value;

async function fixture(t){
 const parent=resolve(process.env.R13_TEST_ROOT??tmpdir());await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(parent,'companion-read-r13-'));
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'m'}),listModels:()=>[{id:'m'}],listProviders:()=>[{id:'fixture'}],runTurn:fn=>fn(),async *stream(){yield {type:'finish',reason:{kind:'stop'}};}};
 const game=await createGalgame({dataRoot:root,provider,model:'m',automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false}});
 t.after(async()=>{await game.close();assert.equal(dirname(root),parent);await rm(root,{recursive:true,force:true});});
 return game;
}
async function archiveClones(run){
 const original=globalThis.structuredClone;let clones=0;
 globalThis.structuredClone=(value,options)=>{if(isArchive(value))clones++;return original(value,options);};
 try{const result=await run();return {result,clones};}finally{globalThis.structuredClone=original;}
}

test('a companion-state read with nothing to absorb does not copy the companion archive',async t=>{
 const game=await fixture(t);
 await game.action('companion-state',{});
 const {result,clones}=await archiveClones(()=>game.action('companion-state',{}));
 assert.equal(result.ok,true);
 assert.equal(clones,0,'companion-state copied the whole archive '+clones+' time(s)');
});

test('the read still reports the active character relationship of a new save',async t=>{
 const game=await fixture(t);
 const {view}=await game.action('companion-state',{});
 assert.equal(view.level,1);
 assert.equal(view.affection,0);
 assert.equal(view.cap,30);
});
