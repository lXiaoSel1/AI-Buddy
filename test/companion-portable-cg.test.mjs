import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,renameSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGalgame} from '../src/galgame-host.mjs';
import {CgService} from '../src/cg-service.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const until=async fn=>{for(let i=0;i<300;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture timeout');};
async function fixture(root){
 let draws=0;
 const cg=new CgService({dataRoot:root,crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},codex:{defaultModel:'fixture',close(){}},
  imageCodec:b=>({png:b,thumbnail:b,width:1,height:1}),referenceResolver:async()=>[],
  fetchImpl:async()=>{draws++;return Response.json({data:[{b64_json:png.toString('base64')}]});}});
 await cg.ready;
 await cg.activate((await cg.save({kind:'custom',name:'mock',protocol:'openai-images',baseUrl:'http://127.0.0.1:3',model:'fixture',options:{references:false}})).id);cg.start();
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(){yield{type:'text-delta',text:'{"text":"一起看星星","emotion":"cheerful","affection":0}'};}};
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',cg});
 return {game,cg,draws:()=>draws,async close(){game.close();await cg.close();}};
}
async function withPhoto(root){
 const f=await fixture(root);
 const group=(await f.game.action('companion-group-save',{name:'带图片的群聊',memberIds:['deepseek','claude'],mode:'list'})).group;
 await f.game.action('companion-group-select',{id:group.id});await f.game.action('companion-group-send',{text:'看看星空'});
 for(let i=0;i<2;i++){const message=await until(async()=>(await f.game.action('companion-state')).companion.groupRuntime.pendingMessage);await f.game.action('companion-group-present',{requestId:message.id});if(!i)await f.game.action('companion-group-continue');}
 const photo=(await f.game.action('companion-group-photo')).photo;
 await until(async()=>(await f.game.action('cg-data',{id:photo.cgId})).ok);
 return {...f,group,photo};
}
test('Group export carries actual CG bytes and restores with the original root unavailable, without new requests',async()=>{
 const base=mkdtempSync(join(tmpdir(),'buddy-portable-')),sourceRoot=join(base,'source'),f=await withPhoto(sourceRoot);
 const original=(await f.game.action('cg-data',{id:f.photo.cgId})).dataUrl;
 const data=(await f.game.action('companion-group-export',{id:f.group.id})).data;
 await f.close();renameSync(sourceRoot,join(base,'source-unavailable'));assert.equal(existsSync(sourceRoot),false);
 const targetRoot=join(base,'另一台电脑 with space'),g=await fixture(targetRoot);
 try{
  await g.game.action('companion-conversation-import',{data});
  const state=(await g.game.action('companion-state')).companion,group=state.groups.find(x=>x.id===f.group.id||x.importedFrom===f.group.id),id=group.photos[0].cgId;
  const restored=await g.game.action('cg-data',{id});assert.equal(restored.ok,true,restored.error);assert.equal(restored.dataUrl,original);
  for(const characterId of ['deepseek','claude'])assert.ok((await g.game.action('cg-gallery',{characterId})).items.some(x=>x.id===id));
  assert.equal(g.draws(),0);
  await g.game.action('cg-trash',{id});await g.game.action('companion-conversation-import',{data});
  assert.equal((await g.game.action('cg-gallery',{characterId:'deepseek'})).items.some(x=>x.id===id),false,'Repeated import must not resurrect a deleted photo');
  assert.equal((await g.game.action('companion-state')).companion.groups.length,state.groups.length);
  await g.game.action('cg-restore',{id});assert.equal((await g.game.action('cg-data',{id})).dataUrl,original);
 }finally{await g.close();}
 const reopened=await fixture(targetRoot);try{const group=(await reopened.game.action('companion-state')).companion.groups.find(x=>x.id===f.group.id||x.importedFrom===f.group.id);assert.equal((await reopened.game.action('cg-data',{id:group.photos[0].cgId})).dataUrl,original);assert.equal(reopened.draws(),0);}finally{await reopened.close();}
});
test('Tampered media or invalid conversation rejects the entire import before changing chat history',async()=>{
 const base=mkdtempSync(join(tmpdir(),'buddy-portable-invalid-')),f=await withPhoto(join(base,'source')),g=await fixture(join(base,'target'));
 try{
  const data=(await f.game.action('companion-group-export',{id:f.group.id})).data;
  assert.ok(data.media?.cgs?.length,'Export must include portable CG records');
  const before=(await g.game.action('companion-state')).companion.groups;
  const broken=structuredClone(data);broken.media.files[0].sha256='0'.repeat(64);
  await assert.rejects(()=>g.game.action('companion-conversation-import',{data:broken}),/校验|hash/i);
  assert.deepEqual((await g.game.action('companion-state')).companion.groups,before);
  const invalid=structuredClone(data);invalid.groups[0].seq=-1;
  await assert.rejects(()=>g.game.action('companion-conversation-import',{data:invalid}),/序号/);
  assert.equal((await g.game.action('cg-gallery',{characterId:'deepseek'})).items.length,0);
  const escape=structuredClone(data);escape.media.files[0].key='../../outside.png';
  await assert.rejects(()=>g.game.action('companion-conversation-import',{data:escape}),/文件|key|hash|校验/i);
 }finally{await f.close();await g.close();}
});

test('Legacy JPEG bytes survive restore and re-export without a misleading PNG MIME type',async()=>{
 const base=mkdtempSync(join(tmpdir(),'buddy-portable-jpeg-')),f=await withPhoto(join(base,'source')),g=await fixture(join(base,'target'));
 try{
  const data=(await f.game.action('companion-group-export',{id:f.group.id})).data;
  // The fixture codec is intentionally identity; native codec coverage lives
  // in the separate Electron test with a complete JPEG image.
  const bytes=Buffer.from([255,216,255,224,1,2,3,255,217]),hash=createHash('sha256').update(bytes).digest('hex');
  data.media.files=[{key:hash,sha256:hash,bytes:bytes.length,dataUrl:'data:image/jpeg;base64,'+bytes.toString('base64')}];
  data.media.cgs[0].image=hash;
  await g.game.action('companion-conversation-import',{data});
  const restored=(await g.game.action('companion-group-export',{id:f.group.id})).data;
  assert.equal(restored.media.files[0].dataUrl,data.media.files[0].dataUrl);
  assert.equal(restored.media.files[0].sha256,hash);
 }finally{await f.close();await g.close();}
});

test('An undecodable but correctly hashed image is rejected before importing cards or history',async()=>{
 const base=mkdtempSync(join(tmpdir(),'buddy-portable-decode-')),f=await withPhoto(join(base,'source')),g=await fixture(join(base,'target'));
 try{
  const data=(await f.game.action('companion-group-export',{id:f.group.id})).data;
  const before=(await g.game.action('companion-state')).companion;
  g.cg.imageCodec=()=>{throw Error('CG 图片无法解码');};
  await assert.rejects(()=>g.game.action('companion-conversation-import',{data}),/无法解码/);
  assert.deepEqual((await g.game.action('companion-state')).companion,before);
  assert.equal(existsSync(join(base,'target','cg-assets')),false);
 }finally{await f.close();await g.close();}
});
