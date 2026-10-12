import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCharacterReferenceResolver} from '../src/cg-reference-registry.mjs';

test('DeepSeek CG uses its Galgame portrait even when the legacy desktop pet reference exists',async()=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-portrait-reference-'));
 try{
  mkdirSync(join(root,'assets/cg-references'),{recursive:true});writeFileSync(join(root,'assets/cg-references/maid-left.png'),'galgame-portrait');writeFileSync(join(root,'assets/cg-references/deepseek.png'),'wrong-desktop-pet');
  const resolve=createCharacterReferenceResolver(root),[ref]=await resolve([{id:'deepseek',name:'DeepSeek',spriteKey:'maid-left'}]);
  assert.equal(readFileSync(ref.path,'utf8'),'galgame-portrait');assert.equal(ref.role,'character');assert.equal(ref.characterId,'deepseek');
  const custom=Buffer.from('user-custom-portrait'),[override]=await resolve([{id:'deepseek',spriteKey:'maid-left',dataUrl:'data:image/png;base64,'+custom.toString('base64')}]);assert.deepEqual(override.buffer,custom);assert.equal(override.path,undefined);
  // Missing portrait must fail, never silently recover by substituting the pet.
  rmSync(join(root,'assets/cg-references/maid-left.png'));await assert.rejects(()=>resolve([{id:'deepseek',spriteKey:'maid-left'}]),/参考图不存在/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
