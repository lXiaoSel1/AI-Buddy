const fail=()=>{throw Object.assign(Error('Preview image is invalid or too large'),{code:'BILI_VISION_IMAGE_INVALID'});};
export function previewDimensions(bytes){
 const b=Buffer.from(bytes);let w,h;
 if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){w=b.readUInt32BE(16);h=b.readUInt32BE(20);}
 else if(b[0]===255&&b[1]===216){let p=2;while(p+4<b.length){if(b[p++]!==255)fail();while(b[p]===255)p++;const m=b[p++];if(m===217||m===218)break;if(m===1||m>=208&&m<=215)continue;if(p+2>b.length)fail();const n=b.readUInt16BE(p);if(n<2||p+n>b.length)fail();if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(m)){if(n<7)fail();h=b.readUInt16BE(p+3);w=b.readUInt16BE(p+5);break;}p+=n;}}
 else if(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
  const t=b.toString('ascii',12,16);if(t==='VP8X'){w=1+b.readUIntLE(24,3);h=1+b.readUIntLE(27,3);}else if(t==='VP8 '&&b.length>=30&&b[23]===157&&b[24]===1&&b[25]===42){w=b.readUInt16LE(26)&16383;h=b.readUInt16LE(28)&16383;}else if(t==='VP8L'&&b[20]===47){const n=b.readUInt32LE(21);w=(n&16383)+1;h=((n>>>14)&16383)+1;}
 }
 if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>16384||h>16384||w*h>16*1024*1024)fail();return {width:w,height:h};
}
const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
export function createBiliSheetRenderer(nativeImage){
 if(!nativeImage?.createFromBuffer||!nativeImage?.createFromBitmap)return null;
 return async({cells,width=1009,height=620})=>{
  if(!Array.isArray(cells)||cells.length<1||cells.length>16||width!==1009||height!==620)fail();
  const out=Buffer.alloc(width*height*4,255),cols=cells.length<=9?3:4,rows=Math.ceil(cells.length/cols),cw=Math.floor(width/cols),ch=Math.floor(height/rows),decoded=new Map();let pixels=0;
  const rect=(x,y,w,h,color)=>{for(let yy=Math.max(0,y);yy<Math.min(height,y+h);yy++)for(let xx=Math.max(0,x);xx<Math.min(width,x+w);xx++){const p=(yy*width+xx)*4;out[p]=out[p+1]=out[p+2]=color;out[p+3]=255;}};
  for(let i=0;i<cells.length;i++){
   const c=cells[i],bytes=Buffer.isBuffer(c.bytes)?c.bytes:Buffer.from(c.bytes??[]);if(bytes.length<8||bytes.length>8*1024*1024)fail();const size=previewDimensions(bytes),key=c.bytes;let image=decoded.get(key);if(!image){pixels+=size.width*size.height;if(pixels>32*1024*1024)fail();image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())fail();const real=image.getSize();if(real.width!==size.width||real.height!==size.height)fail();decoded.set(key,image);}
   const crop=c.crop??{x:0,y:0,...size};if(!['x','y','width','height'].every(k=>Number.isInteger(crop[k]))||crop.x<0||crop.y<0||crop.width<1||crop.height<1||crop.x+crop.width>size.width||crop.y+crop.height>size.height)fail();
   const scale=Math.min((cw-4)/crop.width,(ch-24)/crop.height),dw=Math.max(1,Math.floor(crop.width*scale)),dh=Math.max(1,Math.floor(crop.height*scale)),bitmap=image.crop(crop).resize({width:dw,height:dh,quality:'best'}).toBitmap(),x=i%cols*cw+Math.floor((cw-dw)/2),y=Math.floor(i/cols)*ch+Math.floor((ch-24-dh)/2);
   if(bitmap.length!==dw*dh*4)fail();for(let r=0;r<dh;r++)bitmap.copy(out,((y+r)*width+x)*4,r*dw*4,(r+1)*dw*4);
   const ox=i%cols*cw,oy=Math.floor(i/cols)*ch+ch-22;rect(ox+2,oy,cw-4,20,245);String(i+1).split('').forEach((n,j)=>{for(let k=0;k<15;k++)if(digits[Number(n)][k]==='1')rect(ox+8+j*10+k%3*2,oy+5+Math.floor(k/3)*2,2,2,30);});
  }
  return nativeImage.createFromBitmap(out,{width,height,scaleFactor:1}).toPNG();
 };
}
export function createBiliFrameAnalyzer(nativeImage){
 if(!nativeImage?.createFromBuffer)return null;
 return async({cells})=>{if(!Array.isArray(cells)||cells.length>32)fail();let pixels=0,previous=null;const decoded=new Map(),scores=[];
  for(const c of cells){const bytes=Buffer.isBuffer(c.bytes)?c.bytes:Buffer.from(c.bytes??[]);if(bytes.length<8||bytes.length>8*1024*1024)fail();let image=decoded.get(c.bytes);if(!image){const size=previewDimensions(bytes);pixels+=size.width*size.height;if(pixels>32*1024*1024)fail();image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())fail();const actual=image.getSize();if(actual.width!==size.width||actual.height!==size.height)fail();decoded.set(c.bytes,image);}const size=image.getSize(),r=c.crop;if(!r||!['x','y','width','height'].every(k=>Number.isInteger(r[k]))||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>size.width||r.y+r.height>size.height)fail();const b=image.crop(r).resize({width:16,height:9,quality:'good'}).toBitmap();if(b.length!==16*9*4)fail();const values=Array.from({length:144},(_,i)=>(b[i*4]+2*b[i*4+1]+b[i*4+2])/4);scores.push(previous?values.reduce((n,v,i)=>n+Math.abs(v-previous[i]),0)/144:0);previous=values;
  }return scores;
 };
}
