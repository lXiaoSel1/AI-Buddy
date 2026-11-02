import {createHash} from 'node:crypto';
import descriptor from '../../release/bili-ffmpeg-upstream.json' with {type:'json'};
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export const FFMPEG_COMPONENT_DESCRIPTOR=freeze(descriptor);
export const FFMPEG_COMPONENT_DESCRIPTOR_SHA256=createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
export const descriptorDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
