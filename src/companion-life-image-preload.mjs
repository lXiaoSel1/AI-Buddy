import {ipcRenderer,nativeImage} from 'electron';
import {decodeCgImage} from './cg-images.mjs';
import {lifeImageAck,lifeImageChunkBytes,lifeImageReply,lifeImageRequest,maxLifeImageBytes,maxLifeThumbnailBytes} from './companion-life-image-wire.mjs';

const pngPrefix='data:image/png;base64,',chunkChars=Math.floor(lifeImageChunkBytes/3)*4;
let job,reply,converting=false;
function reject(id){
 job=null;reply=null;converting=false;ipcRenderer.send(lifeImageReply,id,'error');
}
function emitChunk(){
 const {id,png,total,offset,position}=reply;
 if(offset===total){reply=null;ipcRenderer.send(lifeImageReply,id,'done');return;}
 const data=Uint8Array.from(Buffer.from(png.slice(position,position+chunkChars),'base64'));
 if(!data.length||offset+data.length>total)throw Error('Invalid PNG bytes');
 reply.position+=chunkChars;reply.offset+=data.length;
 ipcRenderer.send(lifeImageReply,id,'chunk',{offset,total,bytes:data});
}
function replyPng(id,png,sizeLimit){
 if(!png.startsWith(pngPrefix))throw Error('Invalid PNG output');
 const encodedLength=png.length-pngPrefix.length;
 const padding=png.endsWith('==')?2:png.endsWith('=')?1:0,bytes=encodedLength/4*3-padding;
 if(encodedLength%4||bytes<24||bytes>sizeLimit)throw Error('Invalid PNG output length');
 reply={id,png,total:bytes,offset:0,position:pngPrefix.length};emitChunk();
}
async function rasterize(dataUrl){
 if(!/^data:image\//i.test(dataUrl))throw Error('Invalid image data URL');
 const direct=nativeImage.createFromDataURL(dataUrl);
 if(!direct.isEmpty())return direct.toDataURL();
 return new Promise((resolve,reject)=>{
  const img=new Image();
  img.onload=()=>{
   try{
    const w=img.naturalWidth||1024,h=img.naturalHeight||1024,scale=Math.min(1,4096/Math.max(w,h));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    resolve(canvas.toDataURL('image/png'));
   }catch(error){reject(error);}
  };
  img.onerror=()=>reject(Error('Invalid image data URL'));
  img.src=dataUrl;
 });
}
ipcRenderer.on(lifeImageAck,(_event,id,offset)=>{
 if(!reply||reply.id!==id)return;
 try{
  if(reply.offset!==offset)throw Error('Invalid thumbnail acknowledgement');
  emitChunk();
 }catch{reject(id);}
});
ipcRenderer.on(lifeImageRequest,(_event,id,offset,total,data,operation)=>{
 if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))return;
 try{
  // The dedicated host supplies actual bounded chunks; conversion has no
  // additional image source limit after the host's string capacity check.
  if(!Number.isSafeInteger(total)||total<1||operation!=='convert'&&total>maxLifeImageBytes||!Number.isSafeInteger(offset)||
    !(data instanceof Uint8Array)||!data.byteLength||data.byteLength>lifeImageChunkBytes||
    offset<0||offset+data.byteLength>total||!['validate','thumbnail','convert'].includes(operation)||reply||converting)
   throw Error('Invalid image chunk');
  if(offset===0)job={id,offset:0,bytes:Buffer.allocUnsafe(total),operation};
  if(!job||job.id!==id||job.bytes.length!==total||job.offset!==offset||job.operation!==operation)throw Error('Unexpected image chunk');
  job.bytes.set(data,offset);job.offset+=data.byteLength;
  if(job.offset===total){
   const {bytes}=job;job=null;
   if(operation==='convert'){
    converting=true;
    void rasterize(bytes.toString('utf8')).then(png=>{
     converting=false;replyPng(id,png,maxLifeImageBytes);
    }).catch(()=>reject(id));
    return;
   }
   const {image,width}=decodeCgImage(nativeImage,bytes);
   // Sandboxed nativeImage cannot allocate a Node Buffer for toPNG().
   // toDataURL runs the same native PNG encoder and returns an isolated string.
   if(!image.toDataURL().startsWith(pngPrefix))throw Error('Invalid PNG');
   if(operation==='validate'){ipcRenderer.send(lifeImageReply,id,'done');return;}
   replyPng(id,image.resize({width:Math.min(640,width)}).toDataURL(),maxLifeThumbnailBytes);
  }
 }catch{reject(id);}
});
