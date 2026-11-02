import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createBiliFullMedia} from './bili-full-media.mjs';

const MiB=1024*1024, agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const failure=code=>Object.assign(Error(code),{code});
export function mediaUrl(raw){
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||(!/(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com)$/.test(u.hostname)&&u.hostname!=='upos-hz-mirrorakam.akamaized.net'))throw failure('BILI_MEDIA_ORIGIN');
  return u.href;
}
async function streamTo(url,dest,limit,signal){
  const r=await fetch(mediaUrl(url),{headers:{range:'bytes=0-',referer:'https://www.bilibili.com/','user-agent':agent},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(65000)])});
  const range=/^bytes 0-(\d+)\/(\d+)$/.exec(r.headers.get('content-range')??''),length=Number(r.headers.get('content-length'));
  if(!r.ok||!r.body||length>limit||(r.status===206&&(!range||Number(range[1])+1!==Number(range[2])||Number(range[2])>limit))){await r.body?.cancel();throw failure('BILI_MEDIA_DOWNLOAD');}
  let total=0;await pipeline(Readable.fromWeb(r.body),new Transform({transform(chunk,enc,cb){total+=chunk.length;cb(total>limit?failure('BILI_MEDIA_SIZE'):null,chunk);}}),createWriteStream(dest,{flags:'wx'}),{signal});if(!total||range&&total!==Number(range[2])||length>0&&total!==length)throw failure('BILI_MEDIA_DOWNLOAD');
}
export function runMediaTool(exe,args,{signal,limit=4*MiB,timeout=120000}={}){
  signal?.throwIfAborted();return new Promise((resolve,reject)=>{
    const ctl=AbortSignal.timeout(timeout),active=AbortSignal.any([ctl,signal].filter(Boolean));
    const proc=spawn(exe,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','ignore']});
    let bytes=0,error=null;const chunks=[];
    const stop=()=>{error??=active.reason;proc.kill();};active.addEventListener('abort',stop,{once:true});if(active.aborted)stop();
    proc.stdout.on('data',b=>{bytes+=b.length;if(bytes>limit){error=failure('BILI_MEDIA_OUTPUT_LIMIT');proc.kill();}else chunks.push(b);});
    proc.once('error',e=>{error=e;});proc.once('close',code=>{active.removeEventListener('abort',stop);if(error||code!==0)reject(error??failure('BILI_MEDIA_DECODE'));else resolve(Buffer.concat(chunks));});
  });
}
const localInput=['-hide_banner','-nostdin','-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2','-threads','2'];
export function sceneTimes(text,duration){
 const result=[];let time;
 for(const line of text.split(/\r?\n/)){const at=/pts_time:([\d.]+)/.exec(line);if(at)time=Number(at[1]);
  const s=/^lavfi\.scene_score=([\d.]+)/.exec(line);if(s&&Number.isFinite(time)&&time>=0&&time<duration&&(!result.length||time>result.at(-1).time))result.push({time,score:Number(s[1])});}
 return result;
}
export function representativeFrames(points,from,to,count=12){
 const p=points.filter(x=>x.time>=from&&x.time<to);if(p.length<=count)return p;
 const used=new Set();for(let i=0;i<6;i++)used.add(Math.round((p.length-1)*i/5));
 for(const x of p.map((v,i)=>({...v,i})).sort((a,b)=>b.score-a.score||a.i-b.i)){if(used.size>=count)break;if([...used].every(i=>Math.abs(p[i].time-x.time)>=Math.min(0.75,(to-from)/count)))used.add(x.i);}
 return [...used].sort((a,b)=>a-b).map(i=>p[i]);
}
export function transcriptRows(result,duration){
 const rows=(result.transcription??[]).flatMap((r,i)=>{const start=r.offsets?.from/1000,end=Math.min(duration,r.offsets?.to/1000),text=String(r.text??'').trim();return Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&text&&!/^\s*[\[(].*[\])]\s*$/.test(text)?[{id:'speech:'+i,start,end,text}]:[];});
 if(rows.length>200000)throw failure('BILI_MEDIA_TRANSCRIPT_CAPACITY');return rows;
}
async function retireExitedJobs(root){
 for(const item of await readdir(root,{withFileTypes:true})){
  const owner=/^reading-(\d+)-[a-zA-Z0-9]{6}$/.exec(item.name);
  if(!owner||!item.isDirectory()||item.isSymbolicLink())continue;
  try{process.kill(Number(owner[1]),0);continue;}catch(e){if(e.code!=='ESRCH')continue;}
  const folder=join(root,item.name),files=await readdir(folder,{withFileTypes:true});
  if(files.every(f=>f.isFile()&&!f.isSymbolicLink()&&['audio.m4a','video.mp4','speech.wav','speech.json'].includes(f.name)))await rm(folder,{recursive:true,force:true,maxRetries:2});
 }
}
export function createBiliMedia({tools,tempRoot,playback,download=streamTo,workerPath,resolveVerifiedExecutable}){
 let busy=false;
 const acquire=async function acquire({scope,video,windows,hasSubtitles,signal:incoming,check,renderSheet}){
  if(busy)throw failure('BILI_MEDIA_BUSY');
  if(video.duration>1800)throw failure('BILI_MEDIA_DURATION_LIMIT');
  busy=true;let temp;const signal=AbortSignal.any([incoming,AbortSignal.timeout(12*60000)].filter(Boolean));
  const guard=async()=>{signal.throwIfAborted();await check?.();};
  try{
   await guard();const verified=resolveVerifiedExecutable?await resolveVerifiedExecutable({signal}):{executable:join(tools,'ffmpeg.exe'),tools,localSpeechRecognition:true};await guard();await mkdir(tempRoot,{recursive:true});await retireExitedJobs(tempRoot);temp=await mkdtemp(join(tempRoot,'reading-'+process.pid+'-'));
   const d=await playback({scope,video,signal});if(!d||d.is_preview||!(d.timelength>0)||Math.abs(d.timelength/1000-video.duration)>4)throw failure('BILI_MEDIA_PLAYBACK_UNAVAILABLE');
   const choose=(list,key)=>[...(list??[])].filter(t=>t.baseUrl||t.base_url).sort((a,b)=>a[key]-b[key])[0];
   const v=choose(d.dash?.video,'bandwidth'),a=choose(d.dash?.audio,'bandwidth');
   const mux=d.durl?.length===1&&/mp4/i.test(d.format??'')?d.durl[0].url:null;
   const vf=join(temp,'video.mp4'),af=join(temp,'audio.m4a'),wav=join(temp,'speech.wav'),prefix=join(temp,'speech');
   async function downloadTrack(track,muxUrl,dest,limit){
     let last=failure('BILI_MEDIA_ORIGIN');
     for(const candidate of [...new Set([track?.baseUrl??track?.base_url??muxUrl,...(track?.backupUrl??track?.backup_url??[])])].slice(0,3)){
       await guard();try{await download(mediaUrl(candidate),dest,limit,signal);return;}catch(e){last=e;await rm(dest,{force:true});}
     }throw last;
   }
   const ff=async(args,options={})=>{await guard();const current=resolveVerifiedExecutable?await resolveVerifiedExecutable({signal}):verified;await guard();if(current.executable!==verified.executable)throw failure('FFMPEG_COMPONENT_CHANGED');return runMediaTool(current.executable,args,{signal,...options});};
   const result={...(verified.localSpeechRecognition===false?{localSpeechRecognition:false}:{}),sheets:[],transcript:[],audio:hasSubtitles?'platform-subtitles':'unavailable',visual:'preview',candidateCount:0};
   let videoReady=false;
   try{
    if(!v&&!mux)throw failure('BILI_MEDIA_VIDEO_MISSING');
    await downloadTrack(v,mux,vf,192*MiB);videoReady=true;await guard();
    const raw=await ff([...localInput,'-i',vf,'-an','-sn','-vf',"scale=64:36,select='isnan(prev_selected_t)+gte(t-prev_selected_t,0.5)+gt(scene,0.22)',metadata=mode=print:key=lavfi.scene_score:file=-",'-f','null','-'],{limit:12*MiB});
    const points=sceneTimes(raw.toString(),video.duration);if(!points.length)throw failure('BILI_MEDIA_NO_FRAMES');
    result.candidateCount=points.length;
    for(const win of windows){await guard();const selected=representativeFrames(points,win.from,win.to);if(!selected.length)continue;
      const cells=[];for(const [i,p] of selected.entries()){
       const args=[...localInput,'-ss',String(p.time),'-i',vf,'-an','-sn','-frames:v','1','-vf','scale=384:216:force_original_aspect_ratio=decrease,pad=384:216:(ow-iw)/2:(oh-ih)/2','-threads','1','-f','image2pipe','-c:v','png','pipe:1'];
       const bytes=await ff(args,{limit:MiB,timeout:15000});if(!bytes.length)continue;cells.push({index:i+1,start:p.time,end:selected[i+1]?.time??win.to,bytes,crop:{x:0,y:0,width:384,height:216}});
      }
      if(cells.length)result.sheets.push({...win,cells:cells.map(({start,end},i)=>({index:i+1,start,end})),png:await renderSheet({cells,width:1009,height:620})});
    }
    if(result.sheets.length)result.visual='video-scenes';
   }catch(e){await guard();if(e.code?.startsWith('FFMPEG_COMPONENT_'))throw e;result.videoIssue=e.code?.startsWith('BILI_')?e.code:'BILI_MEDIA_DECODE';}
   if(!hasSubtitles&&verified.localSpeechRecognition!==false)try{
    let input=vf;if(a){await downloadTrack(a,null,af,48*MiB);input=af;}else if(!(mux&&videoReady&&!v))throw failure('BILI_MEDIA_AUDIO_MISSING');
    await guard();await ff([...localInput,'-i',input,'-vn','-sn','-t',String(video.duration),'-ac','1','-ar','16000','-c:a','pcm_s16le',wav]);
    await runMediaTool(join(tools,'whisper-cli.exe'),['-m',join(tools,'ggml-base.bin'),'-f',wav,'-l','auto','-t','4','-ng','-oj','-of',prefix],{signal,timeout:9*60000});
    result.transcript=transcriptRows(JSON.parse(await readFile(prefix+'.json','utf8')),video.duration);result.audio=result.transcript.length?'local-asr':'no-speech';
   }catch(e){await guard();result.audioIssue=e.code?.startsWith('BILI_')?e.code:'BILI_MEDIA_ASR_UNAVAILABLE';}
   await guard();return result;
  }finally{try{if(temp)await rm(temp,{recursive:true,force:true,maxRetries:3});}finally{busy=false;}}
 };
 acquire.fullSampling=createBiliFullMedia({tools,playback,validateUrl:mediaUrl,workerPath,resolveVerifiedExecutable});return acquire;
}
export async function biliPlayback({scope,video,signal},accounts){
 const account=accounts.get(scope.accountRef);if(!account?.enabled||account.platform!=='bilibili'||account.generation!==scope.generation||account.accountId!==scope.accountId)throw failure('BILI_MEDIA_ACCOUNT_CHANGED');
 const url=new URL('https://api.bilibili.com/x/player/playurl');url.search=new URLSearchParams({bvid:video.videoId,cid:String(video.cid),qn:'16',fnver:'0',fnval:'16',fourk:'0'});
 const res=await fetch(url,{redirect:'error',headers:{referer:'https://www.bilibili.com/',cookie:accounts.secret(scope.accountRef).cookie??'','user-agent':agent},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!res.ok||!res.body){await res.body?.cancel();throw failure('BILI_MEDIA_PLAYBACK_UNAVAILABLE');}
 let bytes=0;const chunks=[];for await(const b of res.body){bytes+=b.length;if(bytes>2*MiB)throw failure('BILI_MEDIA_PLAYBACK_UNAVAILABLE');chunks.push(b);}
 const json=JSON.parse(Buffer.concat(chunks).toString());if(json.code!==0)throw failure('BILI_MEDIA_PLAYBACK_UNAVAILABLE');return json.data;
}
