import {resolve,sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {WORK_USAGE_PROJECTION_POLICY_VERSION} from './work-usage-attribution.mjs';

const pathKey=value=>value?(process.platform==='win32'?resolve(value).toLowerCase():resolve(value)):null;
export function usageProjection(sources,attribution,workUsage,signature){
 return {version:1,policy:WORK_USAGE_PROJECTION_POLICY_VERSION,signature,attribution:attribution.revision,
  sources:sources.map(s=>Object.fromEntries(['id','tool','path','overlapGroup','primary','aliasProvider'].map(k=>[k,s[k]??null]))),
  workKey:workUsage.key,activeClaims:[...(workUsage.activeHistoryClaims??[])].sort(),work:[...(workUsage.records?.values()??[])].map(r=>({...structuredClone(r),activeClaims:(r.nativeHistoryRanges??[]).filter(v=>workUsage.activeHistoryClaims?.has(v.claimId)).map(v=>v.claimId)}))};
}
export function usageInvalidation(previous,next,committedSignature){
 if(!previous||previous.version!==1||previous.signature!==committedSignature||previous.policy!==next.policy||previous.attribution!==next.attribution)return {all:true};
 const roots=[],exact=[],sourceIds=new Set(),old=new Map(previous.sources.map(s=>[s.id,s])),fresh=new Map(next.sources.map(s=>[s.id,s]));
 for(const id of new Set([...old.keys(),...fresh.keys()])){
  const a=old.get(id),b=fresh.get(id);
  if(isDeepStrictEqual(a,b)&&previous.sources.findIndex(s=>s.id===id)===next.sources.findIndex(s=>s.id===id))continue;
  sourceIds.add(id);for(const r of [a,b])if(r?.path)roots.push({tool:r.tool,path:pathKey(r.path)});
 }
 const workOld=new Map(previous.work.map(r=>[r.sourceId,r])),workNew=new Map(next.work.map(r=>[r.sourceId,r]));
 for(const id of new Set([...workOld.keys(),...workNew.keys()])){
  const a=workOld.get(id),b=workNew.get(id);if(isDeepStrictEqual(a,b))continue;
  for(const r of [a,b])if(r?.path)exact.push({tool:r.tool,path:pathKey(r.path)});
 }
 // Unknown projection implementations keep the conservative rebuild fallback.
 if(previous.workKey!==next.workKey&&!exact.length&&isDeepStrictEqual(previous.activeClaims,next.activeClaims))return {all:true};
 const matches=(tool,file)=>{const key=pathKey(file);return !!key&&(exact.some(r=>r.tool===tool&&r.path===key)||roots.some(r=>r.tool===tool&&(r.path===key||key.startsWith(r.path.endsWith(sep)?r.path:r.path+sep))));};
 return {all:false,changed:!!(roots.length||exact.length||sourceIds.size),legacy:s=>matches(s.provider??s.tool,s.path??s.sourcePath),generic:r=>sourceIds.has(r.sourceId)||matches(r.tool,r.location?.file??fresh.get(r.sourceId)?.path??old.get(r.sourceId)?.path)};
}
