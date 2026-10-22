import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {inflateRawSync,deflateRawSync} from 'node:zlib';
import {archiveHash,createLifeArchiveRepository} from '../src/companion-life-archive.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=','base64');
const image='data:image/png;base64,'+PNG.toString('base64');
const codec=bytes=>{if(!bytes.equals(PNG))throw Error('test image decoder rejected bytes');return {width:1,height:1};};
function setup(t,imageCodec=codec){const root=mkdtempSync(join(tmpdir(),'ai-buddy-life-codec-'));t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'ai-buddy-life-codec-'));rmSync(root,{recursive:true,force:true});});return {root,repo:createLifeArchiveRepository({dataRoot:root,imageCodec})};}
function snapshot(){return {format:'ai-buddy-life-state',version:1,characterId:'claude',savedAt:55,card:{id:'claude',name:'Claude',fields:{sprite:{mode:'custom',value:image}},avatar:image,modelBinding:{enabled:true,connectionId:'profile-1'}},life:{id:'life-1',operationId:'op-old',mode:'seed',memory:{events:{}},growth:{}},relationships:{mode:'independent',byPersona:{a:{level:8,affection:24},b:{level:1,affection:4}}},personas:{a:{id:'a',name:'A'},b:{id:'b',name:'B'}},conversations:[],groupEvidence:[],content:{cgs:[]},dependencies:[{type:'builtin-character-resources',version:'1.8.0',characterId:'claude'}]};}
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes){let value=0xffffffff;for(const byte of bytes)value=table[(value^byte)&255]^(value>>>8);return(value^0xffffffff)>>>0;}
function pack(rows,{compress=false}={}){const local=[],central=[];let offset=0;for(const [name,raw]of rows){const key=Buffer.from(name),body=compress?deflateRawSync(raw):raw,method=compress?8:0,h=Buffer.alloc(30),c=Buffer.alloc(46),checksum=crc(raw);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(method,8);h.writeUInt32LE(checksum,14);h.writeUInt32LE(body.length,18);h.writeUInt32LE(raw.length,22);h.writeUInt16LE(key.length,26);local.push(h,key,body);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(method,10);c.writeUInt32LE(checksum,16);c.writeUInt32LE(body.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(key.length,28);c.writeUInt32LE(offset,42);central.push(c,key);offset+=30+key.length+body.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(rows.length,8);end.writeUInt16LE(rows.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);}
function unpack(bytes){let pos=bytes.readUInt32LE(bytes.length-6),count=bytes.readUInt16LE(bytes.length-12),rows=[];for(let n=0;n<count;n++){const length=bytes.readUInt32LE(pos+20),nameLength=bytes.readUInt16LE(pos+28),name=bytes.subarray(pos+46,pos+46+nameLength).toString(),local=bytes.readUInt32LE(pos+42),start=local+30+bytes.readUInt16LE(local+26),body=bytes.subarray(start,start+length);rows.push([name,bytes.readUInt16LE(pos+10)===8?inflateRawSync(body):Buffer.from(body)]);pos+=46+nameLength;}return rows;}
function changedArchive(bytes,change,{reindex=false}={}){const rows=unpack(bytes),files=new Map(rows),state=JSON.parse(files.get('text/state.json'));change(files,state);files.set('text/state.json',Buffer.from(JSON.stringify(state)));if(reindex){const manifest=JSON.parse(files.get('manifest.json'));manifest.files=[...files].filter(([path])=>path!=='manifest.json').map(([path,raw])=>({path,bytes:raw.length,sha256:archiveHash(raw)}));files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));}return pack([...files]);}

test('portable archive roundtrip separates and deduplicates images; preserves independent relations',t=>{
 const {repo}=setup(t),raw=snapshot(),bytes=repo.prepare(raw),{manifest,snapshot:restored}=repo.decode(bytes);
 assert.equal(manifest.files.filter(row=>row.path.startsWith('images/')).length,1);assert.deepEqual(restored,raw);assert.equal(manifest.files.find(row=>row.path==='text/state.json').bytes<bytes.length*10,true);
 const portable=JSON.parse(new Map(unpack(bytes)).get('text/state.json'));assert.deepEqual(portable.card.avatar,portable.card.fields.sprite.value);assert.equal(JSON.stringify(portable).includes('data:image/'),false);
});
test('save, hash-checked read and duplicate import create independent immutable ZIP identities',async t=>{
 const {root,repo}=setup(t),saved=await repo.save(snapshot()),read=repo.read(saved.id,saved.sha256),one=await repo.import(read.bytes),two=await repo.import(read.bytes);
 assert.notEqual(saved.id,one.id);assert.notEqual(one.id,two.id);assert.equal(one.sha256,saved.sha256);assert.equal(two.sha256,saved.sha256);assert.ok(existsSync(join(root,'galgame','life-archives',saved.fileName)));assert.throws(()=>repo.read(saved.id,'0'.repeat(64)),/哈希不匹配/);
});
test('CG images are embedded so another machine can restore without the original asset directory',t=>{
 const {root,repo}=setup(t);mkdirSync(join(root,'cg-assets'));writeFileSync(join(root,'cg-assets','one.png'),PNG);const raw=snapshot();raw.content.cgs=[{id:'cg-1',assetRef:'cg-assets/one.png',thumbnailRef:'cg-assets/one.png'}];const bytes=repo.prepare(raw);
 rmSync(join(root,'cg-assets','one.png'));const other=setup(t).repo,{snapshot:restored}=other.decode(bytes);assert.deepEqual(restored.content.cgs[0].assetRef,{$assetImage:image});assert.deepEqual(restored.content.cgs[0].thumbnailRef,{$assetImage:image});assert.equal(other.decode(bytes).manifest.files.filter(row=>row.path.startsWith('images/')).length,1);
});
test('portable archives strip credentials while retaining connection references and raw text',t=>{
 const {repo}=setup(t),raw=snapshot();raw.card.apiKey='secret';raw.life.cookie='cookie';raw.content={keyCiphertext:'encrypted',authorization:'Bearer token',accessToken:'token',themeConnection:{key:'secret'},text:'The literal words apiKey and Cookie in original dialogue remain.'};const decoded=repo.decode(repo.prepare(raw)).snapshot;
 for(const key of ['apiKey','cookie','keyCiphertext','authorization','accessToken','themeConnection'])assert.equal(JSON.stringify(decoded).includes('"'+key+'":'),false);assert.equal(decoded.card.modelBinding.connectionId,'profile-1');assert.equal(decoded.content.text,raw.content.text);
});
test('missing local CG assets fail backup before an archive is committed',t=>{
 const {root,repo}=setup(t),raw=snapshot();raw.content.cgs=[{assetRef:'cg-assets/missing.png'}];assert.throws(()=>repo.prepare(raw),error=>error.code==='LIFE_ARCHIVE_MISSING_CG');assert.equal(existsSync(join(root,'cg-assets','missing.png')),false);
});
test('invalid/undecodable images fail prepare and import, not silently become valid archives',t=>{
 const {repo}=setup(t),raw=snapshot();raw.card.avatar='data:image/png;base64,'+Buffer.from('invalid').toString('base64');assert.throws(()=>repo.prepare(raw),/decoder rejected/);
 const good=repo.prepare(snapshot()),rejecting=setup(t,()=>false).repo;assert.throws(()=>rejecting.decode(good),/无法解码/);assert.throws(()=>setup(t,null).repo.decode(good),/解码器/);
});
test('CRC, SHA-256 and whole-file hash corruption are separate checked failures',async t=>{
 const {repo}=setup(t),bytes=repo.prepare(snapshot()),rows=unpack(bytes),stored=pack(rows),bad=Buffer.from(stored);bad[30+Buffer.byteLength(rows[0][0])+2]^=1;assert.throws(()=>repo.decode(bad),/内容校验/);
 const hashBad=changedArchive(bytes,(_files,state)=>{state.card.name='a changed name';});assert.throws(()=>repo.decode(hashBad),/哈希不匹配/);
 const saved=await repo.save(snapshot()),path=join(setup(t).root,'unrelated');assert.equal(existsSync(path),false);assert.throws(()=>repo.read(saved.id,'f'.repeat(64)),/本地人生存档哈希/);
});
test('ZIP traversal, drive paths, absolute paths, duplicate names and symlink attributes are rejected',t=>{
 const {repo}=setup(t),rows=unpack(repo.prepare(snapshot()));for(const name of ['../outside','C:/outside','/outside','images/../outside','text\\state.json'])assert.throws(()=>repo.decode(pack([...rows,[name,Buffer.from('x')]])),/路径/);
 assert.throws(()=>repo.decode(pack([...rows,rows[0]])),/重复/);
 const link=pack(rows),central=link.readUInt32LE(link.length-6);link.writeUInt32LE(0xa1ff0000,central+38);assert.throws(()=>repo.decode(link),/链接/);
});
test('ZIP local/index disagreement, unsupported/encrypted flags, truncation and hidden trailing data fail',t=>{
 const {repo}=setup(t),bytes=pack(unpack(repo.prepare(snapshot())));const disagree=Buffer.from(bytes);disagree.writeUInt32LE(123,22);assert.throws(()=>repo.decode(disagree),/不一致/);
 const encrypted=Buffer.from(bytes);encrypted.writeUInt16LE(0x801,6);encrypted.writeUInt16LE(0x801,encrypted.readUInt32LE(encrypted.length-6)+8);assert.throws(()=>repo.decode(encrypted),/不允许/);
 assert.throws(()=>repo.decode(bytes.subarray(0,-3)),/ZIP/);assert.throws(()=>repo.decode(Buffer.concat([bytes,Buffer.from('hidden')])),/ZIP/);
});
test('declared expansion is bounded before inflate and a false short size cannot expand freely',t=>{
 const {repo}=setup(t),bytes=pack(unpack(repo.prepare(snapshot()))),large=Buffer.from(bytes),central=large.readUInt32LE(large.length-6);large.writeUInt32LE(65*1024*1024,22);large.writeUInt32LE(65*1024*1024,central+24);assert.throws(()=>repo.decode(large),/安全大小/);
 const zipped=pack([['text/state.json',Buffer.alloc(1024*1024,65)]],{compress:true}),at=zipped.readUInt32LE(zipped.length-6);zipped.writeUInt32LE(1,22);zipped.writeUInt32LE(1,at+24);assert.throws(()=>repo.decode(zipped));
});
test('manifest rejects undeclared, missing, unsupported version, conflicting image references and unsafe object keys',t=>{
 const {repo}=setup(t),good=repo.prepare(snapshot());
 const extra=unpack(good);extra.push(['images/'+'0'.repeat(64)+'.png',PNG]);assert.throws(()=>repo.decode(pack(extra)),/未声明/);
 const missing=unpack(good).filter(([name])=>!name.startsWith('images/'));assert.throws(()=>repo.decode(pack(missing)),/哈希不匹配/);
 const version=unpack(good).map(([name,raw])=>[name,name==='manifest.json'?Buffer.from(JSON.stringify({...JSON.parse(raw),version:2})):raw]);assert.throws(()=>repo.decode(pack(version)),/不支持/);
 assert.throws(()=>repo.decode(changedArchive(good,(_files,state)=>{state.card.avatar={$image:'images/'+'0'.repeat(64)+'.png'};},{reindex:true})),/图片引用缺失/);
 assert.throws(()=>repo.decode(changedArchive(good,(_files,state)=>{state.card.avatar={$image:Object.values(state.card.fields)[0].value.$image,extra:'payload'};},{reindex:true})),/图片引用缺失/);
 assert.throws(()=>repo.decode(changedArchive(good,(_files,state)=>{state.card.fields.constructor={value:'bad'};},{reindex:true})),/对象键/);
});
test('portable JSON cannot bypass decoder/reference checks using raw embedded image data or local file paths',t=>{
 const {repo}=setup(t),good=repo.prepare(snapshot());for(const change of [state=>{state.card.avatar='data:image/png;base64,aW52YWxpZA==';},state=>{state.content.cgs=[{assetRef:'cg-assets/exists-only-on-source-machine.png'}];}])assert.throws(()=>repo.decode(changedArchive(good,(_files,state)=>change(state),{reindex:true})),/包内引用/);
});
test('invalid archive IDs and character identifiers do not write outside repository',t=>{
 const {repo}=setup(t);for(const id of ['../outside','archive-../outside','constructor'])assert.throws(()=>repo.read(id),/ID 无效/);
 const good=repo.prepare(snapshot());const rows=unpack(changedArchive(good,(_files,state)=>{state.characterId='__proto__';state.card.id='__proto__';},{reindex:true}));const changed=rows.map(([name,raw])=>[name,name==='manifest.json'?Buffer.from(JSON.stringify({...JSON.parse(raw),characterId:'__proto__'})):raw]);assert.throws(()=>repo.decode(pack(changed)),/不完整/);
});
