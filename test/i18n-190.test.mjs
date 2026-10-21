import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const en=JSON.parse(read('src/locales/en.json'));

test('en.json only grows: the 1.9.0 release entries keep their order and wording',()=>{
 // sha256 of JSON.stringify(Object.entries(en.json)) at codex/release-1.9.0 39eee92 (1344 entries)
 const entries=Object.entries(en);
 assert.ok(entries.length>=1344);
 assert.equal(createHash('sha256').update(JSON.stringify(entries.slice(0,1344))).digest('hex'),'7889197e71cb1ade11e124e87898343b54b0289ac47a9461808656791c62b9ca');
 // older entries may be deliberately blank, e.g. 上传本地角色立绘 is " ": the tail of a title built from pieces
 for(const [zh,english] of entries.slice(1344))assert.ok(typeof english==='string'&&english.trim(),zh);
});

test('every Chinese t() literal has an English entry',()=>{
 const files=[...readdirSync(new URL('../src/',import.meta.url)).filter(name=>name.endsWith('.mjs')).map(name=>'src/'+name),'src/adapted/galgame-client.ts'];
 const missing=[];
 for(const path of files)for(const match of read(path).matchAll(/\bt\((['"])((?:(?!\1).)*?[一-鿿](?:(?!\1).)*?)\1\s*[,)]/g)){
  const key=match[2];if(key.includes('\\'))continue;
  if(!(key in en)&&!(key.replaceAll('AI 酱','AI娘') in en))missing.push(path+': '+key);
 }
 assert.deepEqual(missing,[]);
});
