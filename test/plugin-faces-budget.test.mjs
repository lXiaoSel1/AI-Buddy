import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {customFace,customFaces,createCustomFaceProcessor,readFaceFile,FACE_INPUT_BYTES,FACES_INPUT_BYTES,FACES_INPUT_ITEMS,FACE_INPUT_PIXELS,FACES_INPUT_PIXELS,FACE_CACHE_ENTRIES,FACE_CACHE_BYTES} from '../src/plugin-faces.mjs';

const png=(width=800,height=600,bytes=90000,tag=0)=>{const value=Buffer.alloc(bytes,tag);Buffer.from([137,80,78,71,13,10,26,10]).copy(value);value.write('IHDR',12);value.writeUInt32BE(width,16);value.writeUInt32BE(height,20);return value;};
const data=(bytes,mime='png')=>'data:image/'+mime+';base64,'+bytes.toString('base64');
function codec({width=800,height=600,outputBytes=900}={}){const counts={decode:0,resize:[],encode:0};return {counts,image:{createFromBuffer(){counts.decode++;return{isEmpty:()=>false,getSize:()=>({width,height}),resize(size){counts.resize.push(size);return this;},toJPEG(){counts.encode++;return Buffer.alloc(outputBytes);}};}}};}
function media(){const files=new Map(),counts={size:0,read:0};return{counts,files,add(bytes,mime='png'){const name=createHash('sha256').update(bytes).digest('hex')+'.'+mime;files.set(name,bytes);return'buddy-media://'+name;},sizeMedia:name=>{counts.size++;return files.get(name)?.length??null;},readMedia:name=>{counts.read++;return files.get(name)??null;}};}

test('oversized inline and stored avatars are refused before reading or decoding',()=>{
 const f=codec();let reads=0;
 assert.equal(customFace(data(Buffer.alloc(FACE_INPUT_BYTES+1)),{image:f.image}),null);
 assert.equal(customFace('buddy-media://'+'a'.repeat(64)+'.png',{sizeMedia:()=>FACE_INPUT_BYTES+1,readMedia:()=>{reads++;return png();},image:f.image}),null);
 assert.equal(customFace('buddy-media://'+'a'.repeat(64)+'.png',{readMedia:()=>{reads++;return png();},image:f.image}),null,'an unmeasured stored file must not be read');
 assert.equal(reads,0);assert.equal(f.counts.decode,0);
});

test('the batch input-byte budget is consumed before any stored read or decode',()=>{
 const m=media(),f=codec(),one=1024*1024;
 const rows=Array.from({length:20},(_,i)=>({id:'c'+i,avatar:m.add(png(800,600,one,i))}));
 const result=customFaces(rows,{...m,image:f.image});
 assert.equal(Object.keys(result).length,FACES_INPUT_BYTES/one);assert.equal(m.counts.read,FACES_INPUT_BYTES/one);assert.equal(f.counts.decode,FACES_INPUT_BYTES/one);
});

test('a refresh inspects at most the allowed number of custom avatars',()=>{
 const m=media(),f=codec(),rows=Array.from({length:100},(_,i)=>({id:'c'+i,avatar:m.add(png(800,600,90000,i))}));
 const result=customFaces(rows,{...m,image:f.image});
 assert.equal(Object.keys(result).length,FACES_INPUT_ITEMS);assert.equal(m.counts.size,FACES_INPUT_ITEMS);assert.equal(m.counts.read,FACES_INPUT_ITEMS);assert.equal(f.counts.decode,FACES_INPUT_ITEMS);
});

test('unchanged resource hashes share cached output across characters and refreshes',()=>{
 const m=media(),f=codec(),avatar=m.add(png()),processor=createCustomFaceProcessor({...m,image:f.image});
 const first=processor.faces([{id:'c1',avatar},{id:'c2',avatar}]),again=processor.faces([{id:'c1',avatar}]);
 assert.equal(first.c1,first.c2);assert.equal(first.c1,again.c1);assert.equal(m.counts.read,1);assert.equal(f.counts.decode,1);assert.equal(f.counts.encode,1);
 const changed=m.add(png(800,600,90000,1));processor.faces([{id:'c1',avatar:changed}]);assert.equal(m.counts.read,2);assert.equal(f.counts.decode,2);
});

test('unchanged inline content does not invoke the native image decoder twice',()=>{
 const f=codec(),processor=createCustomFaceProcessor({image:f.image}),avatar=data(png());
 processor.faces([{id:'c1',avatar}]);processor.faces([{id:'c1',avatar}]);
 assert.equal(f.counts.decode,1);assert.equal(f.counts.encode,1);
});

test('pixel and dimension budgets reject decompression-bomb headers before native decode',()=>{
 const f=codec();assert.ok(5000*5000>FACE_INPUT_PIXELS);
 for(const bytes of [png(5000,5000,30),png(9000,1,30),png(0,2,30),Buffer.alloc(100000)])assert.equal(customFace(data(bytes),{image:f.image}),null);
 assert.equal(f.counts.decode,0);
});

test('a batch also caps the sum of decoded pixels before native codec work',()=>{
 const m=media(),f=codec({width:4096,height:4096}),rows=Array.from({length:10},(_,i)=>({id:'c'+i,avatar:m.add(png(4096,4096,1000,i))}));
 const result=customFaces(rows,{...m,image:f.image});
 assert.equal(f.counts.decode,FACES_INPUT_PIXELS/(4096*4096));assert.equal(Object.keys(result).length,2);
});

test('resize uses the longest side so very wide valid avatars stay small',()=>{
 const f=codec({width:8000,height:100}),value=customFace(data(png(8000,100)),{image:f.image});
 assert.match(value,/^data:image\/jpeg;base64,/);assert.equal(f.counts.resize.length,1);
 assert.equal(f.counts.resize[0].width,96);assert.equal(f.counts.resize[0].height,1);
});

test('JPEG dimensions are checked before decoding and truncated JPEG is refused',()=>{
 const bytes=Buffer.alloc(90000);Buffer.from([255,216,255,192,0,8,8,2,88,3,32,1]).copy(bytes);
 const f=codec();assert.match(customFace(data(bytes,'jpeg'),{image:f.image}),/^data:image\/jpeg;base64,/);
 const bad=codec();assert.equal(customFace(data(Buffer.from([255,216,255,192,0,8]),'jpeg'),{image:bad.image}),null);assert.equal(bad.counts.decode,0);
});

test('the decoded dimensions must agree with the bounded header',()=>{
 const f=codec({width:9000,height:9000});assert.equal(customFace(data(png()),{image:f.image}),null);assert.equal(f.counts.resize.length,0);assert.equal(f.counts.encode,0);
});

test('the LRU cache stays bounded and an evicted resource is re-read',()=>{
 const m=media(),processor=createCustomFaceProcessor(m);let first;
 for(let i=0;i<FACE_CACHE_ENTRIES+1;i++){const avatar=m.add(Buffer.alloc(100,i),'webp');first??=avatar;processor.faces([{id:'c1',avatar}]);}
 assert.equal(processor.snapshot().entries,FACE_CACHE_ENTRIES);assert.ok(processor.snapshot().bytes<=FACE_CACHE_BYTES);
 const before=m.counts.read;processor.faces([{id:'c1',avatar:first}]);assert.equal(m.counts.read,before+1);
});

test('cached output has a byte bound as well as an entry bound',()=>{
 const m=media(),processor=createCustomFaceProcessor(m);
 for(let i=0;i<100;i++)processor.faces([{id:'c1',avatar:m.add(Buffer.alloc(45000,i),'webp')}]);
 assert.ok(processor.snapshot().entries<FACE_CACHE_ENTRIES);assert.ok(processor.snapshot().bytes<=FACE_CACHE_BYTES);
});

test('a temporary stored-read failure does not permanently poison the resource hash',()=>{
 const m=media(),f=codec(),avatar=m.add(png());let failing=true;
 const processor=createCustomFaceProcessor({...m,image:f.image,readMedia:name=>failing?null:m.readMedia(name)});
 assert.deepEqual(processor.faces([{id:'c1',avatar}]),{});failing=false;
 assert.ok(processor.faces([{id:'c1',avatar}]).c1);assert.equal(f.counts.decode,1);
});

test('the real file reader never reads beyond its measured input budget',t=>{
 const parent=resolve(process.env.TEMP??tmpdir());mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,'face-budget-'));
 t.after(()=>{assert.ok(resolve(dir).startsWith(parent+sep));rmSync(dir,{recursive:true,force:true});});
 const file=join(dir,'face.webp');writeFileSync(file,Buffer.alloc(FACE_INPUT_BYTES+1));assert.equal(readFaceFile(file),null);
 writeFileSync(file,Buffer.from('bounded'));assert.equal(readFaceFile(file,4),null);assert.equal(readFaceFile(file).toString(),'bounded');
});
