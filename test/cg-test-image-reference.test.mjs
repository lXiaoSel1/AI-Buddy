import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {CgService} from '../src/cg-service.mjs';
import {createCharacterReferenceResolver} from '../src/cg-reference-registry.mjs';
import {CHARACTER_CATALOG} from '../src/character-catalog.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
test('all eleven ID-only built-ins resolve registered Galgame portraits; unknown/custom roles never borrow a pet',async()=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-reference-ids-')),rows=[['deepseek','assets/cg-references/maid-left.png'],...Object.values(CHARACTER_CATALOG).map(c=>[c.id,c.assets.portrait])];
 for(const [id,path] of rows){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),id);}
 const resolve=createCharacterReferenceResolver(root);for(const [id,path]of rows){const [r]=await resolve([{id}]);assert.equal(r.path,join(root,path));assert.equal(readFileSync(r.path,'utf8'),id);}
 await assert.rejects(()=>resolve([{id:'unknown'}]),/未知|unknown/);await assert.rejects(()=>resolve([{id:'deepseek',customCharacter:true}]),/缺少/);await assert.rejects(()=>resolve([{id:'deepseek',spriteKey:'missing'}]),/不存在/);
});
test('the actual Generate test image service sends the DeepSeek portrait in Ark image JSON and reports missing assets before HTTP',async()=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-ark-test-ref-')),build=join(root,'build'),path=join(build,'assets/cg-references/maid-left.png');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,png);writeFileSync(join(dirname(path),'deepseek.png'),'wrong-pet');const calls=[];
 const service=new CgService({codex:{...stubCodex(),close(){}},dataRoot:root,crypto:fakeCrypto,referenceResolver:createCharacterReferenceResolver(build),imageCodec:bytes=>({png:bytes,thumbnail:bytes,width:1,height:1}),fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}),{headers:{'content-type':'application/json'}});}});
 const draft={kind:'ark',protocol:'ark-images',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'doubao-seedream-4-0-20260415',key:'fixture-only',options:{references:true}};
 try{await service.ready;service.start();const job=await service.testImage(draft);for(let i=0;i<100&&!['ready','failed'].includes(service.job(job.id).status);i++)await new Promise(r=>setTimeout(r,10));assert.equal(service.job(job.id).status,'ready');assert.equal(calls.length,1);assert.equal(calls[0].url,draft.baseUrl+'/images/generations');assert.equal(calls[0].body.image,'data:image/png;base64,'+png.toString('base64'));assert.equal(service.job(job.id).referenceMode,'character-reference');rmSync(path);await assert.rejects(()=>service.testImage(draft),/参考图不存在/);assert.equal(calls.length,1);
 }finally{await service.close();}
});
