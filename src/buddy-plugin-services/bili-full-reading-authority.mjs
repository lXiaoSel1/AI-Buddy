import {createHash} from 'node:crypto';
const fail=code=>Object.assign(Error(code),{code});
const need=(value,code='SOCIAL_UNOBSERVED_MATERIAL')=>{if(!value)throw fail(code);};
const parse=o=>{try{return {row:o,url:new URL(o.url),value:JSON.parse(o.body)};}catch{return null;}};
const subtitleUrl=value=>{try{const u=new URL(String(value).startsWith('//')?'https:'+value:value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/(^|\.)(hdslb\.com|bilibili\.com)$/.test(u.hostname)?u.href:null;}catch{return null;}};
export function fullReadingAuthority(payload,observations){
 const rows=observations.map(parse).filter(Boolean),view=rows.find(o=>o.url.hostname==='api.bilibili.com'&&o.url.pathname==='/x/web-interface/view'&&o.value.code===0&&o.value.data?.bvid===payload.video?.videoId)?.value.data;
 need(view&&Number.isSafeInteger(view.cid));const pages=view.pages??[{cid:view.cid,duration:view.duration,page:1,part:view.title}];
 need(Array.isArray(pages)&&pages.length>0&&pages.every(p=>Number.isSafeInteger(p.cid)&&p.cid>0&&Number.isFinite(p.duration)&&p.duration>0)&&new Set(pages.map(p=>p.cid)).size===pages.length);
 const currentCid=payload.video?.cid??view.cid;need(pages.some(p=>p.cid===currentCid));
 const selected=payload.selectedCids??[currentCid];need(Array.isArray(selected)&&selected.length>0&&new Set(selected).size===selected.length&&selected.every(cid=>pages.some(p=>p.cid===cid)));
 const tracks=payload.subtitleTracks??[];need(Array.isArray(tracks)&&tracks.length<=selected.length);
 const verified=[];
 for(const cid of selected){
  const player=rows.find(o=>o.url.hostname==='api.bilibili.com'&&['/x/player/v2','/x/player/wbi/v2'].includes(o.url.pathname)&&o.url.searchParams.get('cid')===String(cid)&&o.url.searchParams.get('bvid')===view.bvid&&o.value.code===0);
  need(player);const offered=player.value.data?.subtitle?.subtitles??[],track=tracks.filter(t=>t.cid===cid);need(track.length<=1);
  if(!offered.length){need(!track.length);continue;}need(track.length===1);const requested=track[0];need(requested.items===undefined||Array.isArray(requested.items)&&requested.items.length>0);
  let source=null;const complete=offered.find(o=>{if(requested.language!=='unknown'&&requested.language!==o.lan)return false;const u=subtitleUrl(o.subtitle_url);if(!u)return false;const found=rows.find(r=>r.url.href===u&&Array.isArray(r.value.body)&&r.value.body.length>0);if(!found)return false;const body=found.value.body;if(requested.items&&(body.length!==requested.items.length||!body.every((cue,i)=>cue.content===requested.items[i].text&&cue.from===requested.items[i].start&&cue.to===requested.items[i].end)))return false;source=body;return true;});
  need(complete&&source.every(c=>typeof c.content==='string'&&c.content.length>0&&Number.isFinite(c.from)&&Number.isFinite(c.to)&&c.from>=0&&c.to>=c.from));verified.push({cid,language:complete.lan??'unknown',items:source.map((cue,i)=>({id:requested.items?.[i]?.id??'subtitle:'+(i+1),start:cue.from,end:cue.to,text:cue.content}))});
 }
 need(tracks.every(t=>selected.includes(t.cid)));
 return {video:{videoId:view.bvid,cid:currentCid,title:view.title,duration:pages.find(p=>p.cid===currentCid).duration},parts:pages.map((p,i)=>({cid:p.cid,page:p.page??i+1,title:p.part??p.title??'',duration:p.duration})),selectedCids:[...selected],subtitleTracks:verified};
}
export const fullReadingModelFingerprint=profile=>createHash('sha256').update(JSON.stringify(profile)).digest('hex');
export function fullReadingModel(profile){
 need(profile?.id,'BILI_VISION_MODEL_REQUIRED');const m=profile.models?.find(m=>m.id===profile.model||m.model===profile.model)??{};
 const positive=(v,f)=>Number.isSafeInteger(v)&&v>0?v:f;
 return {connectionRef:profile.id,model:profile.model,protocol:profile.protocol??profile.kind,modelFingerprint:fullReadingModelFingerprint(profile),label:profile.name??profile.model,maxImages:Math.min(8,positive(m.maxInputImages,1)),contextTokens:positive(m.contextTokens,positive(profile.contextTokens,16000)),maxInputBytes:9*1024*1024,maxImagePixels:16*1024*1024};
}
export function assertFullReadingModel(reading,profile){need(reading.model.connectionRef===profile?.id&&reading.model.modelFingerprint===fullReadingModelFingerprint(profile),'BILI_VISION_MODEL_CHANGED_RESTART_REQUIRED');}
