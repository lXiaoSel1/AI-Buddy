import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {GALGAME_EMOTIONS} from '../src/galgame-expressions.mjs';
import {CHARACTER_EXPRESSIONS} from '../src/character-expressions.generated.mjs';
import {tmpDir} from './support/audit-harness.mjs';

test('the portrait generator accepts a separately pinned approved manifest and emits the canonical inventory',t=>{
 const dir=tmpDir('galgame-expression-approval',{t});
 const approved='2042-04-06';
 const characters={};
 for(const role of Object.keys(CHARACTER_EXPRESSIONS)){
  mkdirSync(join(dir,'x2',role),{recursive:true});
  characters[role]={};
  for(const emotion of GALGAME_EMOTIONS){
   const file=role+'/'+emotion+'.webp';
   const bytes=Buffer.alloc(30);
   bytes.write('RIFF',0,'ascii');bytes.writeUInt32LE(22,4);
   bytes.write('WEBPVP8X',8,'ascii');bytes.writeUInt32LE(10,16);
   bytes[20]=0x10;bytes.writeUIntLE(1799,24,3);bytes.writeUIntLE(1799,27,3);
   writeFileSync(join(dir,'x2',file),bytes);
   characters[role][emotion]={source:'test',x1:{file:'x1/'+file,size:[900,900]},x2:{file:'x2/'+file,size:[1800,1800],bytes:bytes.length}};
  }
 }
 const manifest=JSON.stringify({approved,characters});
 writeFileSync(join(dir,'manifest.json'),manifest);
 const sha=createHash('sha256').update(manifest).digest('hex');
 const output=join(dir,'expressions.mjs');
 const generate=(hash)=>spawnSync(process.execPath,['scripts/galgame-expression-resources.mjs',dir,output,'--manifest-sha256='+hash],{encoding:'utf8'});
 const rejected=generate('f'.repeat(64));
 assert.notEqual(rejected.status,0);
 assert.match(rejected.stderr,/approved source manifest SHA-256 differs/);
 const result=generate(sha);
 assert.equal(result.status,0,result.stderr);
 const generated=readFileSync(output,'utf8');
 assert.match(generated,new RegExp(approved+'-x2'));
 assert.match(generated,new RegExp('export const CHARACTER_EXPRESSION_IDS='+JSON.stringify(GALGAME_EMOTIONS).replace(/[.*+?^$(){}|[\]\\]/g,'\\$&')+';'));
});
