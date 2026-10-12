export function createCgCodec(nativeImage){
 return (bytes,{reference=false}={})=>{
  if(!Buffer.isBuffer(bytes)||bytes.length>32*1024*1024)throw Error('CG 图片大小无效');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216,webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!png&&!jpeg&&!webp)throw Error('CG 返回的内容不是 PNG、JPEG 或 WebP 图片');
  let image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw Error('CG 图片无法解码');let {width,height}=image.getSize();if(width*height>16777216)throw Error('CG 图片尺寸过大');
  if(reference){
   if(Math.max(width,height)>2048){image=image.resize(width>=height?{width:2048}:{height:2048});({width,height}=image.getSize());}
   // NativeImage uses premultiplied BGRA. Composite a temporary reference onto white.
   const pixels=image.toBitmap();for(let index=0;index<pixels.length;index+=4){const white=255-pixels[index+3];pixels[index]=Math.min(255,pixels[index]+white);pixels[index+1]=Math.min(255,pixels[index+1]+white);pixels[index+2]=Math.min(255,pixels[index+2]+white);pixels[index+3]=255;}
   image=nativeImage.createFromBitmap(pixels,{width,height});
  }
  const normalized=image.toPNG();if(reference&&normalized.length>10*1024*1024)throw Error('角色参考图过大，请更换参考图');
  return {png:normalized,thumbnail:reference?null:image.resize({width:Math.min(640,width)}).toPNG(),width,height,extension:png?'png':jpeg?'jpg':'webp'};
 };
}
