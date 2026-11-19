import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {deflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {buildSync} from 'esbuild';
import {createLifeImageValidator} from '../src/companion-life-image-validator.mjs';
import {makeCard,openCompanionStore} from '../src/companion-store.mjs';
import {ensureLives,lifeToken} from '../src/companion-life.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {createLifeArchiveRepository} from '../src/companion-life-archive.mjs';
import {runCompanionStorageWorker} from '../src/companion-storage-worker-client.mjs';

const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let b=0;b<8;b++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function chunk(name,bytes){
 const out=Buffer.alloc(12+bytes.length);out.writeUInt32BE(bytes.length);out.write(name,4,'ascii');bytes.copy(out,8);
 let crc=0xffffffff;
 for(const byte of out.subarray(4,-4))crc=crcTable[(crc^byte)&255]^(crc>>>8);
 out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
}
function tallPng(width,height){
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const stride=1+width*3,pixels=Buffer.alloc(stride*height);let value=0x52dce729;
 for(let row=0;row<height;row++)for(let i=1;i<stride;i++){value^=value<<13;value^=value>>>17;value^=value<<5;pixels[row*stride+i]=value&255;}
 return Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(pixels,{level:1})),chunk('IEND',Buffer.alloc(0))]);
}

function imageBridge(t,{width,height,png,source,canvas,wrongOffset=false,foreignReply=false}={}){
 const {outputFiles:[bundle]}=buildSync({
  entryPoints:[fileURLToPath(new URL('../src/companion-life-image-preload.mjs',import.meta.url))],
  bundle:true,write:false,platform:'node',format:'cjs',external:['electron']
 });
 const ipcMain=new EventEmitter(),replyChunkSizes=[],requestChunkSizes=[],resizes=[],sessionHandlers={};
 const image={
  isEmpty:()=>false,getSize:()=>({width,height}),toDataURL:()=>'data:image/png;base64,'+png.toString('base64'),
  resize(value){resizes.push(value);return this;}
 };
 class FakeWindow extends EventEmitter{
  constructor(){
   super();
   const ipcRenderer=new EventEmitter();
   const contents=this.webContents=new EventEmitter();
   contents.mainFrame={};contents.setWindowOpenHandler=()=>{};
   contents.session={
    setPermissionRequestHandler(handler){sessionHandlers.permissionRequest=handler;},
    setPermissionCheckHandler(handler){sessionHandlers.permissionCheck=handler;},
    webRequest:{onBeforeRequest(handler){sessionHandlers.beforeRequest=handler;}}
   };
   contents.send=(name,...args)=>queueMicrotask(()=>{
    if(args[3] instanceof Uint8Array)requestChunkSizes.push(args[3].byteLength);
    ipcRenderer.emit(name,{},...args);
   });
   ipcRenderer.send=(name,...args)=>queueMicrotask(()=>{
    if(args[1]==='chunk'){
     replyChunkSizes.push(args[2].bytes.byteLength);
     if(foreignReply)ipcMain.emit(name,{sender:contents,senderFrame:{}},args[0],'done');
     if(wrongOffset)args[2]={...args[2],offset:args[2].offset+1};
    }
    ipcMain.emit(name,{sender:contents,senderFrame:contents.mainFrame},...args);
   });
   runInNewContext(bundle.text,{
    require(name){assert.equal(name,'electron');return {ipcRenderer,nativeImage:{createFromBuffer(bytes){assert.deepEqual(bytes,png);return image;},createFromDataURL(value){assert.equal(value,source);return {isEmpty:()=>true};}}};},
    Buffer,Uint8Array,Number,document:{createElement(tag){assert.equal(tag,'canvas');return canvas;}},
    Image:class{set src(value){assert.equal(value,source);this.naturalWidth=width;this.naturalHeight=height;queueMicrotask(()=>this.onload());}}
   });
  }
  loadURL(){return Promise.resolve();}
  isDestroyed(){return this.destroyed;}
  destroy(){this.destroyed=true;this.emit('closed');}
 }
 const validator=createLifeImageValidator({BrowserWindow:FakeWindow,ipcMain,preload:'fixture-preload.cjs'});
 t.after(()=>validator.close());
 return {validator,resizes,replyChunkSizes,requestChunkSizes,sessionHandlers};
}

test('the life image session denies permissions and requests outside its data page',async t=>{
 const width=32,height=32,png=tallPng(width,height);
 const {validator,sessionHandlers}=imageBridge(t,{width,height,png});
 assert.equal(await validator.validate(png),true);
 const {permissionRequest,permissionCheck,beforeRequest}=sessionHandlers;
 assert.equal(typeof permissionRequest,'function');
 assert.equal(typeof permissionCheck,'function');
 assert.equal(typeof beforeRequest,'function');
 for(const permission of ['media','geolocation','notifications']){
  let answer;
  permissionRequest(null,permission,value=>{answer=value;});
  assert.equal(answer,false);
  assert.equal(permissionCheck(null,permission,'https://fixture.invalid'),false);
 }
 for(const [url,cancel] of [['data:text/html,',false],['data:image/png;base64,',false],['https://fixture.invalid/file',true],['wss://fixture.invalid/socket',true],['file:///fixture.txt',true],['blob:https://fixture.invalid/id',true]]){
  let answer;
  beforeRequest({url},value=>{answer=value;});
  assert.equal(answer.cancel,cancel,url);
 }
});

test('tall width-limited archive thumbnails preserve the legacy PNG through bounded reply messages',async t=>{
 const width=640,height=2000,png=tallPng(width,height);
 assert.ok(png.length>2*1024*1024&&png.length<32*1024*1024&&width*height<16777216);
 const {validator,resizes,replyChunkSizes}=imageBridge(t,{width,height,png,foreignReply:true});
 const received=[];
 const result=await validator.validate(png,{thumbnail:true,onThumbnailChunk(frame){received.push({offset:frame.offset,total:frame.total,bytes:Buffer.from(frame.bytes)});}});
 assert.deepEqual(JSON.parse(JSON.stringify(resizes)),[{width:640}]);
 assert.ok(received.length>1&&replyChunkSizes.length>1);
 assert.ok(replyChunkSizes.every(length=>length<=256*1024));
 let expected=0;const hash=createHash('sha256');
 for(const frame of received){assert.equal(frame.offset,expected);assert.equal(frame.total,png.length);hash.update(frame.bytes);expected+=frame.bytes.length;}
 const pngHash=createHash('sha256').update(png).digest('hex');
 assert.equal(expected,png.length);assert.equal(hash.digest('hex'),pngHash);
 assert.deepEqual(result,{thumbnailBytes:png.length,thumbnailSha256:pngHash});
});


test('supported SVG rasterization retains canvas output using bounded request and reply frames',async t=>{
 const width=6000,height=3000,png=tallPng(640,900),raster='data:image/png;base64,'+png.toString('base64');
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="3000"><image href="'+raster+'"/></svg>';
 const source='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
 const draws=[],canvas={getContext(type){assert.equal(type,'2d');return {drawImage(image,x,y,w,h){draws.push([x,y,w,h]);}};},
  toDataURL(type){assert.equal(type,'image/png');return raster;}};
 const {validator,replyChunkSizes,requestChunkSizes}=imageBridge(t,{width,height,png,source,canvas});
 const hash=createHash('sha256');let count=0;
 const result=await validator.convert(Buffer.from(source),{onChunk({offset,total,bytes}){
  assert.equal(offset,count);assert.equal(total,png.length);hash.update(bytes);count+=bytes.byteLength;
 }});
 assert.deepEqual(draws,[[0,0,4096,2048]]);
 assert.ok(replyChunkSizes.length>1&&requestChunkSizes.length>1);
 assert.ok([...replyChunkSizes,...requestChunkSizes].every(length=>length<=256*1024));
 assert.equal(count,png.length);
 const digest=createHash('sha256').update(png).digest('hex');
 assert.equal(hash.digest('hex'),digest);assert.deepEqual(result,{bytes:png.length,sha256:digest});
});


test('out-of-order conversion output aborts the archive before publishing',async t=>{
 const parent=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??join(import.meta.dirname,'../local/test-fixtures'));
 await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'life-image-order-')),store=await openCompanionStore(root);
 t.after(()=>store.close());
 const width=64,height=64,png=tallPng(width,height),source='data:image/svg+xml;base64,PHN2Zy8+';
 const canvas={getContext:()=>({drawImage(){}}),toDataURL:()=>'data:image/png;base64,'+png.toString('base64')};
 const {validator}=imageBridge(t,{width,height,png,source,canvas,wrongOffset:true});
 await store.mutate(state=>{
  state.cards={deepseek:makeCard({id:'deepseek',name:'Synthetic'})};
  state.personas={default:{id:'default',name:'Synthetic persona',avatar:source}};
  state.activeCharacterId='deepseek';state.activePersonaId='default';
  state.conversations={};state.groups={};state.relationships={deepseek:{mode:'independent',byPersona:{default:{level:1,affection:0}}}};
  ensureLives(state,1700000000000);
 });
 const revision=store.state.revision;
 await assert.rejects(store.snapshotLifeArchive({
  characterId:'deepseek',token:lifeToken(store.state,'deepseek'),kind:'save',metadata:{},savedAt:1700000000001,content:{},
  hasImageCodec:true,streamImageConversion:true
 },{onImage:(bytes,options)=>options.convert?validator.convert(bytes,{onChunk:options.onThumbnailChunk}):validator.validate(bytes,options)}),/存档图片格式不支持/);
 assert.deepEqual(await readdir(join(root,'galgame','life-archives')),[]);
 assert.equal(store.state.revision,revision);
});


for(const holder of ['persona','card'])test('save and reset retain the large legacy avatar of a '+holder,async t=>{
 const parent=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??join(import.meta.dirname,'../local/test-fixtures'));
 await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'life-image-delta-'));
 let dropAck=false,lostArchiveId;
 const store=await openCompanionStore(root,{runLifeArchiveMetadata:async(...args)=>{
  const receipt=await runCompanionStorageWorker(...args);
  if(dropAck&&args[0].archiveArtwork?.length){
   dropAck=false;lostArchiveId=args[0].archiveArtwork[0].archiveId;throw Error('Synthetic acknowledgement lost after the real COMMIT');
  }
  return receipt;
 }});
 t.after(()=>store.close());
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><!--'+'a'.repeat(1100000)+'--></svg>';
 const avatar='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'),png=tallPng(32,32);
 await store.mutate(state=>{
  state.cards={deepseek:{...makeCard({id:'deepseek',name:'Synthetic'}),...(holder==='card'?{avatar}:{}),unknownCard:{keep:[3,2,1]}}};
  state.personas={default:{id:'default',name:'Synthetic persona',...(holder==='persona'?{avatar}:{}),unknownValue:{keep:[1,2,3]},relationships:{deepseek:{address:'keep'}}}};
  state.activeCharacterId='deepseek';state.activePersonaId='default';
  state.conversations={};state.groups={};state.relationships={deepseek:{mode:'independent',byPersona:{default:{level:1,affection:0}}}};
  ensureLives(state,1700000000000);
 });
 const before=store.state.personas.default,beforeAvatar=store.state.cards.deepseek.avatar,oldLife=lifeToken(store.state,'deepseek').lifeId;
 const workerStarts=[],diagnostic=channel('ai-buddy.companion.worker-start'),listen=value=>workerStarts.push(value);
 diagnostic.subscribe(listen);t.after(()=>diagnostic.unsubscribe(listen));
 let staleNext=false;
 const lives=await createCompanionLives({store,dataRoot:root,imageCodec:()=>true,imageConverter:async value=>{
  assert.equal(value,avatar);
  if(staleNext){staleNext=false;await store.mutate(state=>{state.cards.deepseek.revision++;});}
  return png;
 },call:async()=>({ok:true}),syncCard:async()=>{},projectPersona:async()=>{}});
 const writer=new DatabaseSync(join(root,'galgame','companion.sqlite'));
 try{
  writer.exec('BEGIN IMMEDIATE');
  await assert.rejects(lives.save('deepseek'),/locked|busy/i);
  assert.deepEqual(await lives.list('deepseek'),[]);
  assert.equal(store.state.personas.default,before);
 }finally{writer.exec('ROLLBACK');writer.close();}
 if(holder==='card'){
  staleNext=true;
  await assert.rejects(lives.save('deepseek'),{code:'LIFE_ARCHIVE_CARD_ARTWORK_STALE'});
  assert.deepEqual(await lives.list('deepseek'),[]);
 }
 workerStarts.length=0;
 const archive=await lives.save('deepseek');
 if(holder==='card'){
  const seed=await store.snapshotLifeArchive({
   characterId:'deepseek',token:lifeToken(store.state,'deepseek'),kind:'reset',metadata:{},savedAt:1700000000001,content:{},
   hasImageCodec:true,hasImageConverter:true,compactArchiveArtwork:true,keepResetArtwork:false
  },{onImage:()=>true,onModel:()=>png});
  assert.equal(Object.hasOwn(seed.resetBase.card,'avatar'),false,'explicit reset never returns unused old artwork bytes');
  assert.equal(seed.resetCardArtwork,null,'explicit artwork is not reconstructed from the old card');
 }
 assert.ok(workerStarts.includes('write-life-archive-metadata'),'records-only save still changes the large SQLite row revision');
 const archives=await lives.list('deepseek');
 assert.deepEqual(archives.map(row=>row.id),[archive.id]);
 if(holder==='card'){assert.equal(archive.avatar,avatar);assert.equal(archives[0].avatar,avatar);}
 await lives.reset('deepseek',{mode:'normal'});
 assert.ok(workerStarts.filter(op=>op==='write-life-archive-metadata').length>=2);
 assert.notEqual(store.state.lives.deepseek.id,oldLife);
 assert.deepEqual(store.state.personas.default,before);
 assert.equal(store.state.cards.deepseek.avatar,beforeAvatar);
 assert.deepEqual(store.state.cards.deepseek.unknownCard,{keep:[3,2,1]});
 const saved=createLifeArchiveRepository({dataRoot:root,imageCodec:()=>true}).read(archive.id,archive.sha256);
 assert.deepEqual(saved.snapshot.personas.default.unknownValue,{keep:[1,2,3]});
 assert.deepEqual(saved.manifest.convertedImages,[{field:'avatar',from:'svg+xml',to:'png'}]);
 assert.equal(holder==='card'?saved.snapshot.card.avatar:saved.snapshot.personas.default.avatar,'data:image/png;base64,'+png.toString('base64'));
 if(holder==='card'){
  dropAck=true;
  const oldRevision=store.state.revision;
  await assert.rejects(lives.save('deepseek'),{code:'COMPANION_STORE_REOPEN_REQUIRED'});
  assert.ok(lostArchiveId);
  assert.equal(store.state.revision,oldRevision,'no unacknowledged RAM publication');
  await assert.rejects(store.mutate(state=>{state.settings.notAllowed=true;}),{code:'COMPANION_STORE_REOPEN_REQUIRED'});
 }
 await store.close();
 const reopened=await openCompanionStore(root);
 try{
  assert.deepEqual(reopened.state.personas.default,before);
  assert.equal(reopened.state.cards.deepseek.avatar,beforeAvatar);
  if(holder==='card'){
   assert.equal(reopened.records.get('root.lifeArchives','',archive.id).avatar,avatar);
   assert.equal(reopened.records.get('root.lifeArchives','',lostArchiveId).avatar,avatar);
   assert.equal(reopened.records.count('root.lifeArchives',''),3,'lost acknowledgement committed one archive');
   const cgs=Array.from({length:3500},(_,i)=>({id:'synthetic-cg-proof-'+String(i).padStart(8,'0')+'x'.repeat(53),status:'ready',level:2}));
   const large=await createCompanionLives({store:reopened,dataRoot:root,imageCodec:()=>true,imageConverter:()=>png,
    call:async action=>action==='companion-life-content'?{ok:true,content:{cgs}}:{ok:true},syncCard:async()=>{},projectPersona:async()=>{}});
   const largeArchive=await large.save('deepseek');
   const savedLarge=reopened.records.get('root.lifeArchives','',largeArchive.id);
   assert.equal(savedLarge.avatar,avatar);
   assert.deepEqual(savedLarge.unlocks,cgs);
   const reset=await createCompanionLives({store:reopened,dataRoot:root,imageCodec:()=>true,imageConverter:()=>png,
    call:async()=>({ok:true}),syncCard:async()=>{},projectPersona:async()=>{}});
   const newAvatar='data:image/png;base64,'+png.toString('base64');
   await reset.reset('deepseek',{mode:'normal',card:{...reopened.state.cards.deepseek,avatar:newAvatar}});
   assert.equal(reopened.state.cards.deepseek.avatar,newAvatar);

  }
 }
 finally{await reopened.close();}
});
