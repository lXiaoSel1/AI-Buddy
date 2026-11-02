// The sole decoder/compositor for a complete-reading part. No Electron/UI work runs here.
import {parentPort,workerData} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {deflateSync} from 'node:zlib';

const fail=code=>Object.assign(Error(code),{code});
const {executable,url,duration,config,sheets,stopAfterSheets}=workerData;
let proc,aborted=false,previewDone=false,sequence=0,emitted=0;const acknowledgements=new Map();
parentPort.on('message',msg=>{if(msg.type==='ack'){acknowledgements.get(msg.sequence)?.();acknowledgements.delete(msg.sequence);}if(msg.type==='abort'){aborted=true;proc?.kill();for(const done of acknowledgements.values())done();acknowledgements.clear();}});
const crcTable=Uint32Array.from({length:256},(_,i)=>{let n=i;for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=b=>{let n=0xffffffff;for(const x of b)n=crcTable[(n^x)&255]^(n>>>8);return (n^0xffffffff)>>>0;};
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([t,data])),out.length-4);return out;}
function png(bitmap,width,height){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;const rows=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)bitmap.copy(rows,y*(width*4+1)+1,y*width*4,(y+1)*width*4);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows,{level:3})),chunk('IEND',Buffer.alloc(0))]);}
const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
function compose(cells){const width=1009,height=620,cw=252,ch=206,out=Buffer.alloc(width*height*4,255),dw=248,dh=140;
 for(let i=0;i<cells.length;i++){const frame=cells[i],left=i%4*cw+2,top=Math.floor(i/4)*ch+18;
  for(let y=0;y<dh;y++)for(let x=0;x<dw;x++){const src=(Math.floor(y*216/dh)*384+Math.floor(x*384/dw))*4,dst=((top+y)*width+left+x)*4;out[dst]=frame.bytes[src+2];out[dst+1]=frame.bytes[src+1];out[dst+2]=frame.bytes[src];out[dst+3]=255;}
  // Always a 4x3 grid. Empty tail slots stay white and have no invented frame number.
  const label=String(i+1)+' '+frame.time.toFixed(3);let ox=left+4;const oy=Math.floor(i/4)*ch+178;
  for(const c of label){if(/\d/.test(c)){for(let k=0;k<15;k++)if(digits[Number(c)][k]==='1')for(let yy=0;yy<2;yy++)for(let xx=0;xx<2;xx++){const p=((oy+Math.floor(k/3)*2+yy)*width+ox+k%3*2+xx)*4;out[p]=out[p+1]=out[p+2]=30;}ox+=9;}else ox+=5;}
 }return png(out,width,height);
}
async function main(){
 const args=['-hide_banner','-nostdin','-loglevel','info','-protocol_whitelist','http,tcp','-threads','2','-filter_threads','1','-i',url,'-an','-sn','-vf',`select='isnan(prev_selected_t)+gt(floor(t/${config.sampleSeconds}),floor(prev_selected_t/${config.sampleSeconds}))',showinfo,scale=384:216:force_original_aspect_ratio=decrease,pad=384:216:(ow-iw)/2:(oh-ih)/2,format=bgra`,'-fps_mode','passthrough','-threads','1','-f','rawvideo','pipe:1'];
 proc=spawn(executable,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let ended=false,stderr='',toolError=null,pts=[],ptsWaiters=[],sheetAt=0,frameAt=0,cells=[],previous=null,lastPTS=-1;
 const exit=new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',code=>{ended=true;for(const done of ptsWaiters)done();ptsWaiters=[];resolve(code);});});
 proc.stderr.on('data',b=>{stderr+=b.toString();let at;while((at=stderr.indexOf('\n'))>=0){const line=stderr.slice(0,at);stderr=stderr.slice(at+1);if(line.includes('showinfo')){const m=/\bpts_time:([\d.e+-]+)/.exec(line);if(m){const value=Number(m[1]);if(Number.isFinite(value)&&value>=0){pts.push(value);for(const done of ptsWaiters)done();ptsWaiters=[];if(pts.length>256){toolError=fail('BILI_FULL_DECODER_BACKPRESSURE');proc.kill();}}}}}if(stderr.length>65536)stderr=stderr.slice(-4096);});
 async function timestamp(){while(!pts.length){if(ended||proc.exitCode!==null||aborted)throw fail('BILI_FULL_DECODE_INCOMPLETE');await new Promise(resolve=>ptsWaiters.push(resolve));}return pts.shift();}
 async function add(bytes,time,decodedPTS){if(aborted)throw fail('BILI_FULL_PAUSED');const sheet=sheets[sheetAt],frame=sheet.frames[frameAt];cells.push({...frame,time,decodedPTS,bytes});frameAt++;
  if(frameAt===sheet.frames.length){const data=Uint8Array.from(compose(cells)),n=++sequence;const ack=new Promise(resolve=>acknowledgements.set(n,resolve));parentPort.postMessage({type:'sheet',sequence:n,sheet:{...sheet,frames:cells.map(({bytes,...f})=>f),png:data.buffer}},[data.buffer]);await ack;cells=[];frameAt=0;sheetAt++;emitted++;if(stopAfterSheets&&emitted>=stopAfterSheets){previewDone=true;proc.kill();}}
 }
 async function decoded(bytes,p){if(p<lastPTS)throw fail('BILI_FULL_PTS_INVALID');lastPTS=p;
  while(sheetAt<sheets.length&&!previewDone){const frame=sheets[sheetAt].frames[frameAt];if(frame.time>p+1e-6)break;
   const sameBucket=Math.floor((p+1e-6)/config.sampleSeconds)===frame.sampleIndex,source=sameBucket||!previous?{bytes,pts:p}:previous;await add(source.bytes,frame.time,source.pts);}
  previous={bytes,pts:p};
 }
 const frameBytes=384*216*4;let pending=Buffer.alloc(0);
 try{for await(const incoming of proc.stdout){if(aborted)throw fail('BILI_FULL_PAUSED');pending=pending.length?Buffer.concat([pending,incoming]):incoming;while(pending.length>=frameBytes&&!previewDone){const bytes=Buffer.from(pending.subarray(0,frameBytes));pending=pending.subarray(frameBytes);await decoded(bytes,await timestamp());}if(previewDone)break;}
  const code=await exit;if(toolError)throw toolError;if(aborted)throw fail('BILI_FULL_PAUSED');if(code!==0&&!previewDone)throw fail('BILI_FULL_ORIGINAL_UNAVAILABLE');if(!previous)throw fail('BILI_FULL_DECODE_INCOMPLETE');
  if(!previewDone)while(sheetAt<sheets.length){const frame=sheets[sheetAt].frames[frameAt];await add(previous.bytes,frame.time,previous.pts);}
  parentPort.postMessage({type:'done',emitted,duration});
 }finally{proc.kill();parentPort.close();}
}
main().catch(error=>{proc?.kill();parentPort.postMessage({type:'error',code:error.code??'BILI_FULL_DECODE_INCOMPLETE'});parentPort.close();});
