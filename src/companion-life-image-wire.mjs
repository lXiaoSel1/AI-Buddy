export const lifeImageRequest='life-image-validation:request',lifeImageReply='life-image-validation:reply',lifeImageAck='life-image-validation:ack';
export const maxLifeImageBytes=32*1024*1024,lifeImageChunkBytes=256*1024;
// Legacy converter inputs are data URLs; their packed PNG remains limited to 32 MiB.
export const lifeImageConversionDeadlineMs=30000;
// At most 16 megapixels, four encoded channels and a filter byte per row.
// Leave room for lossless compression and PNG framing without preallocating it.
export const maxLifeThumbnailBytes=96*1024*1024;
export const lifeImageGate=Object.freeze({STATUS:0,TOTAL:1,OFFSET:2,LENGTH:3,WAITING:0,CHUNK:1,DONE:2,FAILED:-1});
