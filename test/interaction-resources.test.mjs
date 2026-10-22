import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readInteractionResources,INTERACTION_IDS} from '../scripts/interaction-resources.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'buddy-interaction-fixture-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const index={complete:true,edition:'30fps',characters:{},files:[]};
 for(const characterId of ['deepseek','claude','chatgpt']){
  const actions={};index.characters[characterId]={actions};
  for(const actionId of INTERACTION_IDS){
   const path=`assets/interaction-samples/${characterId}/${actionId}/motion.webm`,source=`${characterId}-${actionId}.webm`,bytes=Buffer.from(characterId+actionId),sha256=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(root,source),bytes);index.files.push({path,source,bytes:bytes.length,sha256});
   actions[actionId]={characterId,actionId,backend:'webm-alpha',canvas:{width:576,height:624},cycleMs:1000,frames:[{timestampMs:0}],staticFrames:{0:{src:'./'+path,sha256}},video:{src:'./'+path,sha256,codec:'vp9-alpha',durationMs:1000,fps:30}};
  }
 }
 const save=()=>writeFileSync(join(root,'runtime-manifest.json'),JSON.stringify(index));save();
 return {root,index,save,load:()=>readInteractionResources(root,{edition:'30fps',characterIds:['deepseek','claude','chatgpt']})};
}
test('interaction batches retain per-character resource ownership including internal GPT id',t=>{
 const f=fixture(t),r=f.load();assert.deepEqual(Object.keys(r.characters),['deepseek','claude','chatgpt']);assert.equal(r.files.filter(x=>x.characterId==='claude').length,6);
 const legacy={...f.index,characterId:'deepseek',actions:f.index.characters.deepseek.actions,files:f.index.files.filter(x=>x.path.includes('/deepseek/'))};delete legacy.characters;
 for(const clip of Object.values(legacy.actions)){delete clip.video.fps;clip.derivation={targetFps:30};}
 writeFileSync(join(f.root,'runtime-manifest.json'),JSON.stringify(legacy));assert.equal(Object.keys(f.load().characters).join(),'deepseek');
});
test('interaction batch rejects incomplete sets, mixed frame rates, and mismatched character references',t=>{
 const f=fixture(t);delete f.index.characters.claude.actions.wake;f.save();assert.throws(f.load,/Missing/);
 const g=fixture(t);g.index.characters.claude.actions.wake.video.fps=60;g.save();assert.throws(g.load,/Invalid character/);
 const h=fixture(t);h.index.characters.claude.actions.wake.video=h.index.characters.deepseek.actions.wake.video;h.save();assert.throws(h.load,/different character/);
});
test('interaction batch rejects bad hashes, escaping paths and duplicate destinations',t=>{
 const f=fixture(t);writeFileSync(join(f.root,f.index.files[0].source),'wrong');assert.throws(f.load,/hash\/length/);
 const g=fixture(t);g.index.files[0].source='../escape.webm';g.save();assert.throws(g.load,/Invalid interaction source/);
 const h=fixture(t);h.index.files.push(h.index.files[0]);h.save();assert.throws(h.load,/duplicate/);
 const i=fixture(t);i.index.files[0].path='assets/interaction-samples/deepseek/../../escape';i.save();assert.throws(i.load,/destination/);
});
