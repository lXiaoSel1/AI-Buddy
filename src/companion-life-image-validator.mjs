import {constants as bufferLimits} from 'node:buffer';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as yieldTimer} from 'node:timers/promises';
import {lifeImageAck,lifeImageChunkBytes,lifeImageConversionDeadlineMs,lifeImageReply,lifeImageRequest,maxLifeImageBytes,maxLifeThumbnailBytes} from './companion-life-image-wire.mjs';

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const emptyPage='data:text/html;charset=utf-8,'+encodeURIComponent(
 '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; img-src data:">');

function invalidImage(){return Error('存档图片无法解码');}

// Only this window's preload sees archive image bytes. Its page has no API
// exposed to it and cannot send a response that is accepted for another job.
export function createLifeImageValidator({BrowserWindow,ipcMain,preload,deadlineMs=9000}){
 let view=null,ready=null,pending=null,tail=Promise.resolve(),closed=false;
 function fail(owner,error){
  if(pending?.owner===owner)pending.finish(error);
  if(view===owner){view=null;ready=null;}
  if(!owner.isDestroyed())owner.destroy();
 }
 function initialize(){
  if(view)return ready;
  const owner=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:64,height:64,webPreferences:{
   preload,partition:'ai-buddy-life-image-validation',sandbox:true,contextIsolation:true,nodeIntegration:false,
   webSecurity:true,backgroundThrottling:false
  }});
  view=owner;
  const {session}=owner.webContents;
  session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.setPermissionCheckHandler(()=>false);
  session.webRequest.onBeforeRequest(({url},callback)=>callback({cancel:!url.startsWith('data:')}));
  owner.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  owner.webContents.on('will-navigate',event=>event.preventDefault());
  owner.webContents.once('render-process-gone',()=>fail(owner,invalidImage()));
  owner.once('closed',()=>fail(owner,invalidImage()));
  ready=owner.loadURL(emptyPage).then(()=>owner);
  return ready;
 }
 function one(bytes,operation,onChunk){
  const outputLimit=operation==='convert'?maxLifeImageBytes:operation==='thumbnail'?maxLifeThumbnailBytes:0;
  if(outputLimit&&typeof onChunk!=='function')return Promise.reject(invalidImage());
  return new Promise((resolve,reject)=>{
   const id=randomUUID(),sha=outputLimit?createHash('sha256'):null;
   let owner,done=false,busy=false,received=0,total=0;
   const finish=(error,value)=>{
    if(done)return;done=true;clearTimeout(timer);
    ipcMain.removeListener(lifeImageReply,receive);
    if(pending?.finish===finish)pending=null;
    if(error)reject(error);else resolve(value);
   };
   const refuse=error=>{finish(error);if(owner)fail(owner,error);};
   const receive=(event,key,type,frame)=>{
    if(done||!owner||owner.isDestroyed()||event.sender!==owner.webContents||event.senderFrame!==owner.webContents.mainFrame||key!==id)return;
    if(type==='done'&&!busy){
     if(!outputLimit){finish(null,true);return;}
     if(total>0&&received===total){finish(null,{bytes:total,sha256:sha.digest('hex')});return;}
    }
    if(type!=='chunk'||!outputLimit||busy){refuse(invalidImage());return;}
    const {offset,bytes:data,total:declared}=frame??{};
    if(!Number.isSafeInteger(declared)||declared<24||declared>outputLimit||
      typeof offset!=='number'||offset!==received||total&&total!==declared||
      !(data instanceof Uint8Array)||!data.byteLength||data.byteLength>lifeImageChunkBytes||
      offset+data.byteLength>declared||
      offset===0&&(data.byteLength<24||!Buffer.from(data.buffer,data.byteOffset,8).equals(pngSignature))){
     refuse(invalidImage());return;
    }
    total=declared;busy=true;sha.update(data);
    Promise.resolve().then(()=>onChunk({offset,total,bytes:data})).then(()=>{
     if(done||owner.isDestroyed())return;
     received+=data.byteLength;busy=false;
     owner.webContents.send(lifeImageAck,id,received);
    }).catch(refuse);
   };
   const timer=setTimeout(()=>refuse(invalidImage()),operation==='convert'?lifeImageConversionDeadlineMs:deadlineMs);
   ipcMain.on(lifeImageReply,receive);
   try{
    const loading=initialize();owner=view;
    pending={owner,finish};
    void loading.then(async window=>{
     for(let offset=0;offset<bytes.length;offset+=lifeImageChunkBytes){
      if(done||closed||window.isDestroyed()){finish(invalidImage());return;}
      // A slice sharing the full input buffer could serialize the whole
      // backing store. Give each IPC message its own bounded backing store.
      const data=Uint8Array.from(bytes.subarray(offset,offset+lifeImageChunkBytes));
      window.webContents.send(lifeImageRequest,id,offset,bytes.length,data,operation);
      if(offset+data.length<bytes.length&&(offset/lifeImageChunkBytes+1)%8===0)await yieldTimer(1);
     }
    }).catch(refuse);
   }catch(error){refuse(error);}
  });
 }
 function enqueue(bytes,operation,onChunk){
  // A previously valid data URL may be a legacy string beyond the card UI cap.
  const inputLimit=operation==='convert'?bufferLimits.MAX_STRING_LENGTH*3:maxLifeImageBytes;
  if(closed||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>inputLimit)return Promise.reject(invalidImage());
  const task=tail.then(()=>{if(closed)throw invalidImage();return one(bytes,operation,onChunk);});
  tail=task.catch(()=>{});
  return task;
 }
 return {
  validate(bytes,{thumbnail=false,onThumbnailChunk}={}){
   const task=enqueue(bytes,thumbnail?'thumbnail':'validate',onThumbnailChunk);
   return thumbnail?task.then(({bytes,sha256})=>({thumbnailBytes:bytes,thumbnailSha256:sha256})):task;
  },
  convert(bytes,{onChunk}={}){return enqueue(bytes,'convert',onChunk);},
  close(){closed=true;if(view)fail(view,invalidImage());}
 };
}
