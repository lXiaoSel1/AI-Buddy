import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {FFMPEG_COMPONENT_DESCRIPTOR as descriptor,FFMPEG_COMPONENT_DESCRIPTOR_SHA256} from '../src/media-components/ffmpeg-descriptor.mjs';

export function upstreamMediaMode(args){
 const enabled=args.includes('--bili-ffmpeg-upstream');
 if(args.some(value=>value.startsWith('--bili-ffmpeg-upstream=')))throw Error('Upstream media mode does not accept an override');
 if(enabled&&args.some(value=>['--bili-media-tools=','--bili-ffmpeg=','--bili-ffmpeg-license='].some(prefix=>value.startsWith(prefix))))throw Error('Choose upstream preparation or a private bundled media kit');
 return enabled;
}
export const upstreamMediaMarker=()=>({schemaVersion:1,mode:'upstream-component',descriptorSha256:FFMPEG_COMPONENT_DESCRIPTOR_SHA256,localSpeechRecognition:false});
function noticeRows(){return descriptor.files.filter(row=>row.path!==descriptor.executable);}
function notice(repo,row){const file=path.join(repo,'licenses','ffmpeg-8.1.2',row.path),bytes=fs.readFileSync(file);if(bytes.length!==row.bytes||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('Fixed upstream notice changed: '+row.path);return bytes;}
export function stageUpstreamMediaBuild(repo,out){
 const target=path.join(out,'media-notices','ffmpeg');fs.mkdirSync(target,{recursive:true});
 for(const row of noticeRows())fs.writeFileSync(path.join(target,row.path),notice(repo,row),{flag:'wx'});
 fs.writeFileSync(path.join(out,'bili-ffmpeg-upstream.json'),JSON.stringify(descriptor,null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(path.join(out,'bili-media-mode.json'),JSON.stringify(upstreamMediaMarker())+'\n',{flag:'wx'});
}
export function validateUpstreamMediaBuild(repo,root){
 const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
 if(JSON.stringify(read('bili-media-mode.json'))!==JSON.stringify(upstreamMediaMarker())||JSON.stringify(read('bili-ffmpeg-upstream.json'))!==JSON.stringify(descriptor))throw Error('Public build must use the fixed upstream media descriptor');
 if(!fs.statSync(path.join(root,'ffmpeg-component-worker.mjs')).isFile())throw Error('Public FFmpeg worker is missing');
 for(const row of noticeRows()){const bytes=fs.readFileSync(path.join(root,'media-notices','ffmpeg',row.path));if(!bytes.equals(notice(repo,row)))throw Error('Public upstream notice changed: '+row.path);}
 return upstreamMediaMarker();
}
