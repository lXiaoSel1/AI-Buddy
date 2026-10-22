import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {createLifeArchiveRepository,runArchiveTask} from '../src/companion-life-archive.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {CgService} from '../src/cg-service.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {tmpDir} from './support/audit-harness.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=','base64');
const JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0,0xff,0xd9]);
const GIF=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const url=(mime,bytes)=>'data:image/'+mime+';base64,'+bytes.toString('base64');
const codec=bytes=>{if(!bytes.equals(PNG)&&!bytes.equals(JPEG))throw Error('test codec rejected bytes');return {};};
const snapshot=(extra={})=>({format:'ai-buddy-life-state',version:1,characterId:'claude',savedAt:1,card:{id:'claude',name:'Claude',avatar:url('png',PNG)},life:{id:'life-1',mode:'normal'},relationships:{mode:'independent',byPersona:{}},personas:{},conversations:[],groupEvidence:[],content:{cgs:[]},dependencies:[],...extra});
const repository=(t,options={})=>{const root=tmpDir('d2-life',{t});return {root,repo:createLifeArchiveRepository({dataRoot:root,imageCodec:codec,...options})};};
// ZIP entries with the CRC stored in the central directory.
function entries(bytes){
 const rows=new Map(),count=bytes.readUInt16LE(bytes.length-12);let pos=bytes.readUInt32LE(bytes.length-6);
 for(let n=0;n<count;n++){const method=bytes.readUInt16LE(pos+10),crc=bytes.readUInt32LE(pos+16),packed=bytes.readUInt32LE(pos+20),names=bytes.readUInt16LE(pos+28),name=bytes.subarray(pos+46,pos+46+names).toString(),local=bytes.readUInt32LE(pos+42),start=local+30+bytes.readUInt16LE(local+26),body=bytes.subarray(start,start+packed);rows.set(name,{crc,raw:method===8?inflateRawSync(body):Buffer.from(body)});pos+=46+names;}
 return rows;
}
// The table CRC the archive used before zlib.crc32.
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const tableCrc=bytes=>{let value=0xffffffff;for(const byte of bytes)value=table[(value^byte)&255]^(value>>>8);return(value^0xffffffff)>>>0;};

test('D2-1: a key field survives unless it sits on a connection-like object',t=>{
 const {repo}=repository(t),raw=snapshot({content:{cgs:[{id:'photo',scene:{key:'beach-sunset',label:'海边'}}],connection:{baseUrl:'https://fixture.invalid/v1',key:'sk-secret',model:'m'},themeConnection:{key:'secret'}}});
 const restored=repo.decode(repo.prepare(raw)).snapshot;
 assert.equal(restored.content.cgs[0].scene.key,'beach-sunset');
 assert.equal(restored.content.connection.key,undefined);assert.equal(restored.content.connection.baseUrl,'https://fixture.invalid/v1');
 assert.equal(restored.content.themeConnection,undefined);
});

test('D2-2: chat text that looks like an image stays text; picture fields accept any MIME case',t=>{
 const {repo}=repository(t),texts=['data:image/gif;base64,R0lGODlh','data:image/png;base64,bm90IGFuIGltYWdl','data:image/svg+xml,<svg/>'];
 const raw=snapshot({conversations:[{id:'c',messages:texts.map((text,i)=>({id:'m'+i,role:'user',text}))}]});raw.card.avatar='data:image/PNG;base64,'+PNG.toString('base64');
 const restored=repo.decode(repo.prepare(raw)).snapshot;
 assert.deepEqual(restored.conversations[0].messages.map(m=>m.text),texts);
 assert.equal(restored.card.avatar,url('png',PNG));
});

test('D2-2: GIF and SVG pictures are stored as PNG and listed in the manifest; without a converter the error names the format',async t=>{
 const seen=[],{repo}=repository(t,{imageConverter:async dataUrl=>{seen.push(dataUrl.slice(0,20));return PNG;}});
 const raw=snapshot();raw.card.avatar=url('gif',GIF);raw.card.fields={sprite:{mode:'custom',value:'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'}};
 const saved=await repo.save(raw),{manifest,snapshot:restored}=repo.read(saved.id,saved.sha256);
 assert.equal(seen.length,2);assert.equal(restored.card.avatar,url('png',PNG));assert.equal(restored.card.fields.sprite.value,url('png',PNG));
 assert.deepEqual(manifest.convertedImages.map(row=>row.field+':'+row.from).sort(),['avatar:gif','sprite:svg+xml']);
 const plain=repository(t).repo,gif=snapshot();gif.card.avatar=url('gif',GIF);
 await assert.rejects(plain.save(gif),/格式不支持：gif（avatar）/);
});

test('D2-3: missing CG files are reported together, nothing is written, and saving works once they are gone',async t=>{
 const {root,repo}=repository(t);mkdirSync(join(root,'cg-assets','kept'),{recursive:true});writeFileSync(join(root,'cg-assets','kept','image.png'),PNG);
 const raw=snapshot();raw.content.cgs=[{id:'gone-1',label:'海边',at:100,level:3,assetRef:'cg-assets/gone-1/image.png',thumbnailRef:'cg-assets/gone-1/thumbnail.png'},{id:'kept',assetRef:'cg-assets/kept/image.png'}];
 raw.content.sharedCgs=[{id:'gone-2',kind:'group',groupId:'g1',at:200,assetRef:'cg-assets/gone-2/image.png'}];
 const error=await repo.save(raw).then(()=>null,value=>value);
 assert.equal(error.code,'LIFE_ARCHIVE_MISSING_CG');
 assert.deepEqual(error.missing.map(row=>[row.cgId,row.label,row.at,row.groupId]),[['gone-1','海边',100,null],['gone-2',null,200,'g1']]);
 assert.deepEqual(readdirSync(join(root,'galgame','life-archives')),[]);
 raw.content.cgs=raw.content.cgs.filter(cg=>cg.id==='kept');raw.content.sharedCgs=[];
 const saved=await repo.save(raw);assert.ok(repo.read(saved.id,saved.sha256).snapshot.content.cgs[0].assetRef.$assetImage);
});

test('D2-10b: a JPEG CG file is stored and restored as JPEG',t=>{
 const {root,repo}=repository(t);mkdirSync(join(root,'cg-assets','j'),{recursive:true});writeFileSync(join(root,'cg-assets','j','image.png'),JPEG);
 const raw=snapshot();raw.content.cgs=[{id:'j',assetRef:'cg-assets/j/image.png'}];
 const bytes=repo.prepare(raw);
 assert.ok([...entries(bytes).keys()].some(name=>name.startsWith('images/')&&name.endsWith('.jpeg')));
 assert.match(repo.decode(bytes).snapshot.content.cgs[0].assetRef.$assetImage,/^data:image\/jpeg;base64,/);
});

test('D2-9: zlib CRC equals the old table CRC; the worker and the inline fallback write the same archive',async t=>{
 const {root,repo}=repository(t),raw=snapshot({content:{cgs:[],notes:'人生'.repeat(50000)}});
 for(const [name,row]of entries(repo.prepare(raw)))assert.equal(row.crc,tableCrc(row.raw),name);
 const task=name=>({entries:[['text/state.json',Buffer.from('{"a":1}')]],meta:{createdAt:1,characterId:'c',lifeId:'l',dependencies:[]},target:join(root,name),temp:join(root,name+'.partial')});
 const viaWorker=await runArchiveTask(task('w.zip')),inline=await runArchiveTask(task('i.zip'),{worker:false});
 assert.equal(viaWorker.via,'worker');assert.equal(inline.via,'inline');assert.equal(viaWorker.sha256,inline.sha256);
 const fallback=createLifeArchiveRepository({dataRoot:root,imageCodec:codec,worker:false}),saved=await fallback.save(raw);
 assert.equal(fallback.read(saved.id,saved.sha256).snapshot.content.notes,raw.content.notes);
 assert.deepEqual(readdirSync(join(root,'galgame','life-archives')).filter(name=>!name.endsWith('.zip')),[],'no temporary files are left behind');
});

test('D2-3 end to end: save answers with the missing list; cleanup drops only records whose files are gone',async t=>{
 const dataRoot=tmpDir('d2-e2e',{t}),provider={enabled:false,listProviders:()=>[],listModels:()=>[],async *stream(){throw Error('No network in tests');}};
 const cg=new CgService({dataRoot,crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},codex:{defaultModel:'fixture',close(){}},imageCodec:b=>({png:b,thumbnail:b,width:1,height:1}),referenceResolver:async()=>[],fetchImpl:async()=>{throw Error('No network in tests');}});
 await cg.ready;let game=await createGalgame({dataRoot,provider,model:'fixture',cg});game.close();
 const global=createSnapshotStorage(join(dataRoot,'galgame/storages/dsh-whale-galgame/global.json')),state=await readJson(global);
 mkdirSync(join(dataRoot,'cg-assets','kept'),{recursive:true});writeFileSync(join(dataRoot,'cg-assets','kept','image.png'),PNG);
 state.characters.claude.cgs=[{id:'gone',status:'ready',at:5,level:2,label:'丢失的图',assetRef:'cg-assets/gone/image.png'},{id:'kept',status:'ready',at:6,level:2,assetRef:'cg-assets/kept/image.png',thumbnailRef:'cg-assets/kept/thumbnail.png'}];
 await global.writeText(JSON.stringify(state));
 game=await createGalgame({dataRoot,provider,model:'fixture',cg});let open=true;t.after(async()=>{if(open)game.close();await cg.close();});
 const failed=await game.action('companion-life-save',{characterId:'claude'});
 assert.equal(failed.ok,false);assert.equal(failed.code,'LIFE_ARCHIVE_MISSING_CG');assert.deepEqual(failed.missing.map(row=>[row.cgId,row.label]),[['gone','丢失的图']]);
 const cleaned=await game.action('companion-life-clean-missing-cg',{characterId:'claude',cgIds:['gone','kept']});
 assert.deepEqual(cleaned.removed,['gone']);
 const saved=await game.action('companion-life-save',{characterId:'claude'});
 assert.equal(saved.ok,true);assert.ok(saved.archive.id);
 assert.deepEqual((await game.action('companion-life-list',{characterId:'claude'})).archives.find(row=>row.id===saved.archive.id).unlocks.map(row=>row.id),['kept']);
 game.close();open=false;
 assert.deepEqual((await readJson(createSnapshotStorage(join(dataRoot,'galgame/storages/dsh-whale-galgame/global.json')))).characters.claude.cgs.map(cg=>cg.id),['kept']);
});

test('D2-3: a CG whose thumbnail alone is lost is saved with its full image',async t=>{
 const {root,repo}=repository(t);mkdirSync(join(root,'cg-assets','kept'),{recursive:true});writeFileSync(join(root,'cg-assets','kept','image.png'),PNG);
 const raw=snapshot();raw.content.cgs=[{id:'kept',assetRef:'cg-assets/kept/image.png',thumbnailRef:'cg-assets/kept/thumbnail.png'}];
 const saved=await repo.save(raw),cg=repo.read(saved.id,saved.sha256).snapshot.content.cgs[0];
 assert.deepEqual(cg.thumbnailRef,cg.assetRef);
});
