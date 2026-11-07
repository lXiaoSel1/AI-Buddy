import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,readdirSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createBiliFullReadingStore,fullReadingUnits} from './bili-full-reading-store.mjs';
import {parseModelResponseObject} from './model-response-object.mjs';

const fail=code=>Object.assign(Error(code),{code});
const ensure=(v,code)=>{if(!v)throw fail(code);};
export const fullReadingHash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const copy=v=>JSON.parse(JSON.stringify(v));
const scopeKeys=['pluginId','packageName','accountBindingId','bindingGeneration','accountRef','accountId','generation','characterId','personaId','lifeId','operationId'];
const scopeHash=s=>fullReadingHash(Object.fromEntries(scopeKeys.filter(k=>s?.[k]!==undefined).map(k=>[k,s[k]])));
const ticks=v=>Math.round(v*1000000);
export function fullReadingConfig(value={}){
 const c={sampleSeconds:value.sampleSeconds??.5,windowSeconds:value.windowSeconds??6};
 ensure(Object.keys(value).every(k=>['sampleSeconds','windowSeconds'].includes(k)),'BILI_FULL_CONFIG_INVALID');
 ensure(Number.isFinite(c.sampleSeconds)&&c.sampleSeconds>=.1&&c.sampleSeconds<=60&&Number.isFinite(c.windowSeconds)&&c.windowSeconds>=.1&&c.windowSeconds<=3600,'BILI_FULL_CONFIG_INVALID');
 ensure(Math.abs(ticks(c.sampleSeconds)/1000000-c.sampleSeconds)<1e-9&&Math.abs(ticks(c.windowSeconds)/1000000-c.windowSeconds)<1e-9,'BILI_FULL_CONFIG_INVALID');return c;
}
export function fullReadingSheets(part,config={}){
 const c=fullReadingConfig(config),duration=ticks(part.duration),sample=ticks(c.sampleSeconds),window=ticks(c.windowSeconds);
 ensure(Number.isSafeInteger(part.cid)&&part.cid>0&&duration>0&&duration<=86400*1000000,'BILI_FULL_PART_INVALID');
 const count=Math.ceil(duration/sample);ensure(count<=864000,'BILI_FULL_PLAN_CAPACITY');
 const sheets=[];let last;
 for(let i=0;i<count;i++){
  const time=i*sample,win=Math.floor(time/window);
  if(!last||last.windowIndex!==win||last.frames.length===12){last={id:`p${part.cid}-sheet-${sheets.length}`,cid:part.cid,part:part.page??1,windowIndex:win,from:win*window/1000000,to:Math.min(duration,(win+1)*window)/1000000,frames:[],slots:12};sheets.push(last);}
  last.frames.push({id:`p${part.cid}-frame-${i}`,index:last.frames.length+1,sampleIndex:i,time:time/1000000});
 }
 return sheets;
}
export function fullReadingCues(tracks,parts){
 ensure(Array.isArray(tracks)&&tracks.length<=parts.length,'BILI_FULL_CUES_INVALID');const all=[],usedTracks=new Set(),seen=new Set();
 for(const track of tracks){const part=parts.find(p=>p.cid===track.cid);ensure(part&&!usedTracks.has(track.cid)&&Array.isArray(track.items)&&track.items.length<=200000,'BILI_FULL_CUES_INVALID');usedTracks.add(track.cid);
  for(const item of track.items){const key=`p${track.cid}:${item.id}`;ensure(typeof item.id==='string'&&item.id.length>0&&item.id.length<=300&&!seen.has(key)&&typeof item.text==='string'&&item.text.length>0&&item.text.length<=16*1024*1024&&Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.start>=0&&item.end>=item.start&&item.end<=part.duration+1,'BILI_FULL_CUES_INVALID');seen.add(key);all.push({cueId:key,originalId:item.id,cid:track.cid,language:String(track.language??'unknown').slice(0,100),start:item.start,end:item.end,text:item.text,textSha256:fullReadingHash(item.text),source:item.source==='local-asr'?'local-asr':'platform-subtitles'});}
 }ensure(all.reduce((n,c)=>n+c.text.length,0)<=64*1024*1024,'BILI_FULL_TEXT_CAPACITY');return all;
}
export function fullReadingCuePages(cues,budget=12000){
 ensure(Number.isInteger(budget)&&budget>=256,'BILI_FULL_MODEL_CAPACITY');const pages=[];
 for(const cue of cues)for(let at=0;at<cue.text.length;){let end=Math.min(cue.text.length,at+budget);if(end<cue.text.length&&/[\uD800-\uDBFF]/.test(cue.text[end-1]))end--;const text=cue.text.slice(at,end),id=`${cue.cueId}@${at}-${end}`;pages.push({id,cueId:cue.cueId,cid:cue.cid,start:cue.start,end:cue.end,charStart:at,charEnd:end,text,textSha256:cue.textSha256,spanSha256:fullReadingHash(text),source:cue.source});at=end;}
 return pages;
}
const completedSet=row=>new Set(row.completedUnitIds??row.batches.filter(b=>b.status==='completed'&&b.processed!==false).flatMap(b=>b.unitIds??[]));
export function fullReadingCoverage(row){
 const done=completedSet(row),byCue=new Map();for(const u of row.units)if(u.kind==='text'&&done.has(u.id)){if(!byCue.has(u.item.cueId))byCue.set(u.item.cueId,[]);byCue.get(u.item.cueId).push([u.item.charStart,u.item.charEnd]);}const missingImages=row.sheets.filter(s=>!done.has(s.id)).map(s=>s.id),missingCues=[];
 for(const cue of row.cues){const spans=(byCue.get(cue.cueId)??[]).sort((a,b)=>a[0]-b[0]);let at=0;for(const [from,to]of spans){if(from>at)break;at=Math.max(at,to);}if(at!==cue.text.length)missingCues.push({cueId:cue.cueId,covered:at,total:cue.text.length,textSha256:cue.textSha256});}
 return {images:{completed:row.sheets.length-missingImages.length,total:row.sheets.length,missing:missingImages},cues:{completed:row.cues.length-missingCues.length,total:row.cues.length,missing:missingCues},complete:!missingImages.length&&!missingCues.length};
}
function modelBudget(raw={}){
 ensure(typeof raw.connectionRef==='string'&&raw.connectionRef,'BILI_VISION_MODEL_REQUIRED');
 const positive=(v,f)=>Number.isSafeInteger(v)&&v>0?v:f;
 const contextTokens=positive(raw.contextTokens,16000),imageTokens=positive(raw.imageTokens,2400),maxImages=Math.max(1,Math.min(8,positive(raw.maxImages,1))),maxImagePixels=positive(raw.maxImagePixels,16*1024*1024);
 ensure(maxImagePixels>=1009*620,'BILI_FULL_MODEL_CAPACITY');
 const maxTextChars=Math.min(positive(raw.maxTextChars,12000),Math.floor((contextTokens-4096-imageTokens)*1.5));ensure(maxTextChars>=512,'BILI_FULL_MODEL_CAPACITY');
 return {connectionRef:raw.connectionRef,modelFingerprint:String(raw.modelFingerprint??''),modelId:String(raw.modelId??raw.model??''),protocol:String(raw.protocol??''),label:String(raw.label??raw.connectionRef).slice(0,500),contextTokens,imageTokens,maxImages,maxTextChars,maxImagePixels,maxInputBytes:positive(raw.maxInputBytes,12*1024*1024)};
}
const pngHeader=Buffer.from([137,80,78,71,13,10,26,10]);
export function parseFullReadingUnderstanding(result){
 if(result?.understanding!=null)return result.understanding;if(typeof result?.text!=='string')return;
 return parseModelResponseObject(result.text)??undefined;
}
export function validFullReadingUnderstanding(value,ids){
 const keys=['summary','notes','evidenceRefs','completedMaterial','shareWorthy','shareText','interestTags','commentWorthy'];
 return !!(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k))&&typeof value.summary==='string'&&value.summary.length<=10000&&typeof value.notes==='string'&&value.notes.length<=100000&&typeof value.shareText==='string'&&value.shareText.length<=3000&&['completedMaterial','shareWorthy','commentWorthy'].every(k=>typeof value[k]==='boolean')&&Array.isArray(value.evidenceRefs)&&value.evidenceRefs.length>0&&value.evidenceRefs.length<=ids.size&&value.evidenceRefs.every(id=>typeof id==='string'&&ids.has(id))&&Array.isArray(value.interestTags)&&value.interestTags.length<=5&&value.interestTags.every(tag=>typeof tag==='string'&&tag.length<=100));
}
export function createBiliFullReading({directory,acquireMedia,now=Date.now,storageBytes=2*1024*1024*1024,onStorageWrite=()=>{}}={}){
 ensure(isAbsolute(directory??''),'BILI_FULL_DIRECTORY_REQUIRED');const root=join(directory,'full-v1'),records=join(root,'readings'),images=join(root,'images');mkdirSync(records,{recursive:true});mkdirSync(images,{recursive:true});
 let closed=false;const jobs=new Map(),revisions=new Map();let storedBytes=readdirSync(images).filter(n=>/^[a-f0-9]{64}\.png$/.test(n)).reduce((n,name)=>{const stat=lstatSync(join(images,name));ensure(stat.isFile()&&!stat.isSymbolicLink(),'BILI_VISION_CACHE_INVALID');return n+stat.size;},0);
 const checkOpen=()=>ensure(!closed,'BILI_VISION_CLOSED');
 const budget={limit:storageBytes,used:storedBytes},disk=createBiliFullReadingStore({directory:root,onWrite:onStorageWrite,budget}),path=disk.file;
 const load=id=>{checkOpen();return disk.load(id);};
 const owned=(id,scope)=>{const r=load(id);ensure(r.scopeHash===scopeHash(scope),'BILI_VISION_SCOPE_DENIED');return r;};
 const account=args=>{const r=load(args.readingId);ensure(r.owner.pluginId===args.pluginId&&r.owner.accountRef===args.accountRef&&r.owner.accountBindingId===args.accountBindingId,'BILI_VISION_SCOPE_DENIED');return r;};
 const save=r=>{checkOpen();r.revision=Math.max(r.revision??0,revisions.get(r.readingId)??0)+1;revisions.set(r.readingId,r.revision);disk.save(r);};
 const notify=id=>{const j=jobs.get(id),waiting=j?.waiters.splice(0)??[];for(const done of waiting)done();};
 function waitJob(job,signal){signal?.throwIfAborted();return new Promise((resolve,reject)=>{const cleanup=()=>{signal?.removeEventListener('abort',abort);const at=job.waiters.indexOf(wake);if(at>=0)job.waiters.splice(at,1);},wake=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(signal.reason??fail('BILI_FULL_PAUSED'));};job.waiters.push(wake);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});}
 const pause=(id,code='BILI_FULL_PAUSED')=>{const j=jobs.get(id);if(j){j.controller.abort(fail(code));notify(id);}};
 const frameRows=asset=>asset?.frameMapRef?disk.get('frame-map',asset.frameMapRef).frames:[];
 const noteText=node=>disk.get('note',node.textRef).text;
 const noteNode=(text,metadata)=>({...metadata,textRef:disk.put('note',{text}),characters:text.length});
 const dto=r=>{const coverage=fullReadingCoverage(r),first=r.sheets.find(s=>r.assets[s.id]),last=r.lastBatch?.visualMaterialRefs?.[0],sheet=(last?r.sheets.find(s=>r.assets[s.id]?.ref===last):null)??first,currentFrames=sheet?frameRows(r.assets[sheet.id]):[];return {readingMode:'full-v1',readingId:r.readingId,revision:r.revision??0,finalBatchId:r.finalBatchId??null,finalProcessed:!!r.batches.find(b=>b.batchId===r.finalBatchId&&b.status==='completed'&&b.processed===true),finalProviderRequestId:r.finalBatchId?r.batches.find(b=>b.batchId===r.finalBatchId)?.providerRequestId??null:null,videoId:r.video.videoId,currentCid:r.video.cid,phase:r.phase,planHash:r.planHash,config:r.config,parts:r.parts,availableParts:r.availableParts??r.parts,model:r.model,frameCount:r.sheets.reduce((n,s)=>n+s.frames.length,0),sheetCount:r.sheets.length,windowCount:r.parts.reduce((n,p)=>n+Math.ceil(ticks(p.duration)/ticks(r.config.windowSeconds)),0),cueCount:r.cues.length,textCharacters:r.cues.reduce((n,c)=>n+c.text.length,0),estimatedCalls:r.estimatedCalls,confirmed:r.confirmed===true,progress:{completed:coverage.images.completed+coverage.cues.completed,total:coverage.images.total+coverage.cues.total},coverage,sheetRef:sheet?(r.assets[sheet.id]?.ref??null):null,cells:sheet?sheet.frames.map(f=>({index:f.index,start:f.time,end:Math.min(sheet.to,f.time+r.config.sampleSeconds),decodedPTS:currentFrames.find(x=>x.id===f.id)?.decodedPTS})):[],sheets:r.sheets.filter(s=>r.assets[s.id]).map(s=>({sheetRef:r.assets[s.id].ref,cid:s.cid,from:s.from,to:s.to,cells:s.frames.map(f=>({index:f.index,start:f.time,end:Math.min(s.to,f.time+r.config.sampleSeconds)})),slots:12,emptySlots:12-s.frames.length,source:'original-video',kind:'full-window'})),materialMissing:r.materialMissing??[],modelReason:r.modelReason??null,needsReview:r.batches.some(b=>['submitted','unknown'].includes(b.status)),calls:r.batches.map(({batchId,status,stepKind,providerRequestId,processed})=>({stepId:batchId,status,stepKind,providerRequestId,processed:processed===true})),source:'original-video',media:r.media??null};};
 async function guard(signal,check){checkOpen();signal?.throwIfAborted();await check?.();checkOpen();signal?.throwIfAborted();}
 function storeSheet(id,sheet){const r=load(id),planned=r.sheets.find(s=>s.id===sheet.id);ensure(planned&&sheet.frames.length===planned.frames.length&&sheet.frames.every((f,i)=>f.id===planned.frames[i].id&&f.time===planned.frames[i].time&&Number.isFinite(f.decodedPTS)),'BILI_FULL_FRAME_MISMATCH');const bytes=Buffer.from(sheet.png);ensure(bytes.length>=24&&bytes.length<=4*1024*1024&&bytes.subarray(0,8).equals(pngHeader),'BILI_VISION_IMAGE_INVALID');const sha256=fullReadingHash(bytes),dest=join(images,sha256+'.png');if(!existsSync(dest)){ensure(budget.used+bytes.length<=budget.limit,'BILI_FULL_STORAGE_PAUSED');writeFileSync(dest,bytes,{flag:'wx'});budget.used+=bytes.length;r.imageBytes=(r.imageBytes??0)+bytes.length;}r.assets[sheet.id]={ref:'full:'+r.readingId+':'+sheet.id,sha256,bytes:bytes.length,frameMapRef:disk.put('frame-map',{sheetId:sheet.id,frames:sheet.frames})};save(r);notify(id);}
 function sourceArgs(r,part,signal,check,onSheet){return {scope:r.scope,video:{...r.video,...part,videoId:r.video.videoId},config:r.config,sheets:r.sheets.filter(s=>s.cid===part.cid),hasSubtitles:r.cues.some(c=>c.cid===part.cid),signal,check,onSheet};}
 async function produce(r,signal,check,{preview=false}={}){
  ensure(typeof acquireMedia?.fullSampling==='function','BILI_FULL_ORIGINAL_UNAVAILABLE');
  for(const part of r.parts){await guard(signal,check);const result=await acquireMedia.fullSampling({...sourceArgs(r,part,signal,check,async sheet=>{await guard(signal,check);storeSheet(r.readingId,sheet);if(!preview){for(;;){const latest=load(r.readingId),done=completedSet(latest),ahead=Object.keys(latest.assets).filter(id=>!done.has(id)).length;if(ahead<=16)break;const job=jobs.get(r.readingId);if(job)await waitJob(job,signal);await guard(signal,check);}}}),...(preview?{stopAfterSheets:1}:{})});
   const latest=load(r.readingId);latest.media={visual:'original-video',audio:latest.cues.length?'platform-subtitles':result?.audio??'unavailable'};
   ensure(!result?.transcript?.length,'BILI_FULL_ASR_NOT_IN_PLAN');
   save(latest);if(preview)break;
  }
 }
 function startProducer(r,check,activitySignal){
  if(jobs.has(r.readingId))return jobs.get(r.readingId);const controller=new AbortController(),signal=AbortSignal.any([controller.signal,activitySignal].filter(Boolean)),job={controller,scopeHash:r.scopeHash,readingId:r.readingId,waiters:[],done:false,error:null,promise:null};jobs.set(r.readingId,job);
  job.promise=Promise.resolve().then(()=>produce(r,signal,check)).catch(error=>{job.error=error;try{const latest=load(r.readingId);if(!['cancelled','completed'].includes(latest.phase)&&!(latest.phase==='paused'&&latest.modelReason)){latest.phase='paused';latest.modelReason=error.code??'BILI_FULL_ORIGINAL_UNAVAILABLE';save(latest);}}catch{}}).finally(()=>{job.done=true;notify(r.readingId);if(jobs.get(r.readingId)===job)jobs.delete(r.readingId);});return job;
 }
 async function cancelScope(scope){const exact=scopeHash(scope),selected=[...jobs.values()].filter(job=>job.scopeHash===exact&&!job.done);for(const job of selected){job.controller.abort(fail('BILI_FULL_PAUSED'));notify(job.readingId);}await Promise.allSettled(selected.map(job=>job.promise));return {cancelled:selected.length};}

 function summaryLimits(r){r.summaryTextBudget??=Math.max(512,Math.floor(r.model.maxTextChars*.6));return {input:r.summaryTextBudget,node:Math.floor(r.summaryTextBudget/2)};}
 function sourceNotes(r,batchId,value){const limit=summaryLimits(r).node,nodes=[];for(const [field,text]of [['summary',value.summary],['notes',value.notes]])for(let at=0;at<text.length;){let end=Math.min(text.length,at+limit);const encode=()=>JSON.stringify({batchId,field,text:text.slice(at,end),charStart:at,charEnd:end});while(end>at&&encode().length>limit)end--;if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;ensure(end>at,'BILI_FULL_SUMMARY_CAPACITY');nodes.push(noteNode(encode(),{level:0,id:'note:'+batchId+':'+field+':'+at,batchId}));at=end;}return nodes;}
 function upgradeSummary(r){summaryLimits(r);if(r.summaryGraphVersion===2)return;const next=[];for(const batch of r.batches.filter(b=>b.stepKind==='segment'&&b.status==='completed'&&b.processed===true)){const receipt=disk.get('receipt',batch.receiptHash),value=parseFullReadingUnderstanding(receipt.result);ensure(value&&typeof value.summary==='string'&&typeof value.notes==='string','BILI_FULL_SOURCE_MISMATCH');next.push(...sourceNotes(r,batch.batchId,value));}r.priorSummaryGraph??={version:r.summaryGraphVersion??1,nodes:copy(r.summaryNodes??[]),preparedBatch:copy(r.lastBatch??null),upgradedAt:now()};r.lastBatch=null;delete r.nextSummaryFinal;r.summaryNodes=next;r.summaryGraphVersion=2;save(r);}
 const batchInput=b=>fullReadingHash({batchId:b.batchId,stepKind:b.stepKind,material:b.material,visualMaterialRefs:b.visualMaterialRefs,unitIds:b.unitIds});
 function buildBatch(r,{shrink=false}={}){
  const unknown=r.batches.find(b=>['submitted','unknown'].includes(b.status));ensure(!unknown,'BILI_VISION_UNCERTAIN');
  const done=completedSet(r);let units=r.units.slice(r.unitCursor??0).filter(u=>!done.has(u.id));
  let stepKind='segment',summaryNodes=null;
  if(!units.length){stepKind='summary';summaryNodes=r.summaryNodes??[];ensure(summaryNodes.length,'BILI_FULL_NOTES_MISSING');
   const capacity=summaryLimits(r).input,selected=[];let chars=0;for(const node of summaryNodes){if(chars+node.characters>capacity&&selected.length)break;ensure(node.characters<=capacity,'BILI_FULL_SUMMARY_CAPACITY');selected.push(node);chars+=node.characters;}
   const final=selected.length===summaryNodes.length;ensure(final||selected.length>=2,'BILI_FULL_SUMMARY_CAPACITY');units=selected.map(n=>({id:n.id,kind:'note',item:{id:n.id,text:noteText(n),source:'derived-reading-notes',sourceBatchId:n.batchId}}));r.nextSummaryFinal=final;
  }
  const chosen=[],refs=[],items=[];let chars=0,imageCost=0,bytes=0;const maxImages=Math.max(1,Math.min(r.model.maxImages,r.batchImageLimit??8)),textBudget=stepKind==='summary'?summaryLimits(r).input:r.textBudget;
  for(const unit of units){if(unit.kind==='image'){
    if(refs.length>=maxImages||chars+(imageCost+r.model.imageTokens)*1.5>(r.model.contextTokens-4096)*1.5&&chosen.length)break;
    const asset=r.assets[unit.id],sheet=r.sheets.find(s=>s.id===unit.id);if(asset&&bytes+asset.bytes>r.model.maxInputBytes&&chosen.length)break;
    ensure(!asset||asset.bytes<=r.model.maxInputBytes,'BILI_FULL_MODEL_CAPACITY');imageCost+=r.model.imageTokens;bytes+=asset?.bytes??0;refs.push(asset?.ref??'pending:'+unit.id);items.push({id:unit.id,imageRef:asset?.ref??'pending:'+unit.id,cid:sheet.cid,start:sheet.from,end:sheet.to,frameIds:sheet.frames.map(f=>f.id),source:'original-video'});
   }else{const size=unit.item.text.length;if((chars+size>textBudget||chars+size+imageCost*1.5>(r.model.contextTokens-4096)*1.5)&&chosen.length)break;ensure(size<=textBudget,'BILI_FULL_MODEL_CAPACITY');chars+=size;items.push(unit.item);}
   chosen.push(unit);if(stepKind==='summary'&&chosen.length>=units.length)break;
  }
  ensure(chosen.length,'BILI_FULL_MODEL_CAPACITY');const batchId=`${stepKind}-${r.batches.length}-${fullReadingHash(chosen.map(u=>u.id)).slice(0,16)}`;
  const b={batchId,stepKind,...(stepKind==='summary'?{summaryGraphVersion:r.summaryGraphVersion,summaryOutputChars:r.nextSummaryFinal?summaryLimits(r).input:summaryLimits(r).node}:{}),unitIds:chosen.map(u=>u.id),summaryNodeIds:summaryNodes?chosen.map(u=>u.id):[],finalSummary:stepKind==='summary'&&r.nextSummaryFinal===true&&chosen.length===summaryNodes.length,visualMaterialRefs:refs,material:{videoId:r.video.videoId,coverage:'frames',complete:false,sourceRefs:[r.video.url??`https://www.bilibili.com/video/${r.video.videoId}`],items,readRange:{scope:'full-reading-v1',selectedCids:r.parts.map(p=>p.cid),planHash:r.planHash},coverageNotes:stepKind==='summary'?'Derived notes from completed, source-preserved batches. These notes create no new real-world fact.':'Every planned sample and subtitle character is tracked separately. Image transmission does not guarantee semantic accuracy.'},status:'prepared'};b.inputHash=batchInput(b);return b;
 }
 function finishBatch({scope,readingId,batchId,status,providerRequestId,result,inputHash},{reconcile=false}={}){
    const r=owned(readingId,scope),batch=r.batches.find(b=>b.batchId===batchId);ensure(batch&&['completed','unknown'].includes(status),'BILI_FULL_BATCH_MISMATCH');let request,localReprocess=false;
    if(reconcile){ensure(status==='completed'&&r.phase!=='cancelled'&&typeof inputHash==='string'&&inputHash===batch.inputHash,'BILI_FULL_BATCH_MISMATCH');if(batch.status==='completed'){
     const prior=disk.get('receipt',batch.receiptHash);ensure(batch.providerRequestId===providerRequestId&&fullReadingHash(prior.result)===fullReadingHash(result),'BILI_VISION_STEP_CONFLICT');if(batch.processed!==false||batch.localReprocess)return dto(r);
     ensure(prior.readingId===readingId&&prior.batchId===batchId&&prior.requestHash===batch.requestHash&&prior.providerRequestId===batch.providerRequestId&&prior.finishedAt===batch.finishedAt,'BILI_FULL_SOURCE_MISMATCH');request=disk.get('request',batch.requestHash);const original=request.batch;
     ensure(request.readingId===readingId&&original?.batchId===batchId&&original.inputHash===batch.inputHash&&original.inputHash===batchInput(original)&&original.material?.videoId===r.video.videoId&&original.material.readRange?.scope==='full-reading-v1'&&original.material.readRange.planHash===r.planHash&&Array.isArray(original.material.readRange.selectedCids)&&fullReadingHash(original.material.readRange.selectedCids)===fullReadingHash(r.parts.map(p=>p.cid))&&Array.isArray(original.material.items)&&['stepKind','unitIds','summaryNodeIds','finalSummary','visualMaterialRefs','summaryGraphVersion','summaryOutputChars'].every(k=>fullReadingHash(original[k]??null)===fullReadingHash(batch[k]??null)),'BILI_FULL_SOURCE_MISMATCH');
     localReprocess=true;result=prior.result;
    }else ensure(['submitted','unknown'].includes(batch.status),'BILI_VISION_STEP_CONFLICT');}else if(batch.status!=='submitted'){ensure(batch.status===status,'BILI_VISION_STEP_CONFLICT');return dto(r);}if(status==='completed')ensure(typeof providerRequestId==='string'&&providerRequestId,'BILI_MODEL_RECEIPT_REQUIRED');const cancelled=r.phase==='cancelled',explicitPause=localReprocess&&r.phase==='paused'&&r.modelReason==='BILI_FULL_PAUSED';if(reconcile&&batch.status==='unknown'){batch.priorUnknown={status:batch.status,finishedAt:batch.finishedAt,providerRequestId:batch.providerRequestId};batch.reconciledAt=now();}
    if(localReprocess)batch.localReprocess={attemptedAt:now(),priorProcessed:false,priorPhase:r.phase,priorModelReason:r.modelReason??null};else{batch.status=status;batch.providerRequestId=providerRequestId??null;batch.finishedAt=now();
     if(status==='unknown'){if(!cancelled){r.phase='paused';r.modelReason='BILI_VISION_UNCERTAIN';}save(r);pause(readingId);return dto(r);}
     // Persist the known paid response before validation. Invalid schema is a
     // known response, never a reason to replay the same provider submission.
     batch.receiptHash=disk.put('receipt',{readingId,batchId,requestHash:batch.requestHash,providerRequestId,result:copy(result??{}),finishedAt:batch.finishedAt});try{request=disk.get('request',batch.requestHash);ensure(request.readingId===readingId&&request.batch.batchId===batchId&&request.batch.inputHash===batch.inputHash,'BILI_FULL_BATCH_MISMATCH');}catch{batch.processed=false;if(!cancelled)r.phase='paused';r.modelReason='BILI_FULL_SOURCE_MISMATCH';r.lastBatch=null;save(r);pause(readingId);return dto(r);}
    }const value=parseFullReadingUnderstanding(result);
    batch.processed=validFullReadingUnderstanding(value,new Set(request.batch.material.items.map(item=>item.id)))&&value.completedMaterial===true;
    if(!batch.processed){if(!cancelled)r.phase='paused';if(!explicitPause)r.modelReason='BILI_FULL_MATERIAL_NOT_COMPLETED';r.lastBatch=null;save(r);pause(readingId);return dto(r);}
        const note=JSON.stringify({batchId,summary:value.summary,factsAndUncertainties:value.notes,evidenceRefs:value.evidenceRefs}),limit=summaryLimits(r),consumed=r.summaryNodes.filter(n=>batch.summaryNodeIds?.includes(n.id));
     if(batch.stepKind==='summary'&&(batch.summaryGraphVersion!==r.summaryGraphVersion||consumed.length!==batch.summaryNodeIds.length||batch.finalSummary&&consumed.length!==r.summaryNodes.length)){batch.aggregationAccepted=false;if(!cancelled)r.phase='paused';if(!explicitPause)r.modelReason='BILI_FULL_SUMMARY_GRAPH_CHANGED';r.lastBatch=null;save(r);pause(readingId);return dto(r);}
     if(batch.stepKind==='summary'&&(note.length>(batch.finalSummary?limit.input:limit.node)||!batch.finalSummary&&(consumed.length<2||note.length>=consumed.reduce((n,x)=>n+x.characters,0)))){batch.aggregationAccepted=false;if(!cancelled)r.phase='paused';if(!explicitPause)r.modelReason='BILI_FULL_SUMMARY_NO_PROGRESS';r.lastBatch=null;save(r);pause(readingId);return dto(r);}
     if(batch.stepKind==='segment'){const done=completedSet(r);for(const id of batch.unitIds)done.add(id);r.completedUnitIds=[...done];while(r.unitCursor<r.units.length&&done.has(r.units[r.unitCursor].id))r.unitCursor++;r.summaryNodes.push(...sourceNotes(r,batchId,value));}
     else{const level=Math.max(0,...consumed.map(n=>n.level??0))+1;r.summaryNodes=r.summaryNodes.filter(n=>!batch.summaryNodeIds.includes(n.id));r.summaryNodes.push(noteNode(note,{level,id:'note:'+batchId,batchId}));r.summaryDepth=Math.max(r.summaryDepth??0,level);batch.aggregationAccepted=true;}r.lastBatch=null;
 if(!cancelled&&batch.finalSummary&&fullReadingCoverage(r).complete&&!r.materialMissing.length){r.phase='completed';r.completedAt=now();r.finalBatchId=batchId;r.modelReason=null;}if(reconcile&&['BILI_VISION_UNCERTAIN','BILI_FULL_MATERIAL_NOT_COMPLETED'].includes(r.modelReason))r.modelReason=null;save(r);notify(readingId);return dto(r);
  }

 return {
  get available(){return !closed&&typeof acquireMedia?.fullSampling==='function';},
  async prepare({scope,video,parts,selectedCids,config,subtitleTracks=[],model,readingId=randomUUID(),signal,check}){
   await guard(signal,check);if(existsSync(path(readingId))){const r=owned(readingId,scope);ensure(r.video.videoId===video.videoId,'BILI_VISION_VIDEO_MISMATCH');return dto(r);}
   const sampling=fullReadingConfig(config);ensure(/^BV[0-9A-Za-z]{6,30}$/.test(video?.videoId??'')&&Array.isArray(parts)&&parts.length>0&&parts.length<=10000,'BILI_FULL_PART_INVALID');
   const selected=selectedCids??[video.cid];ensure(Array.isArray(selected)&&selected.length>0&&new Set(selected).size===selected.length&&selected.every(cid=>parts.some(p=>p.cid===cid)),'BILI_FULL_PART_INVALID');
   const picked=parts.filter(p=>selected.includes(p.cid)).map(p=>({cid:p.cid,page:p.page??1,title:String(p.title??p.part??'').slice(0,1000),duration:p.duration})),budget=modelBudget(model);ensure(picked.reduce((n,p)=>n+Math.ceil(ticks(p.duration)/ticks(sampling.sampleSeconds)),0)<=864000,'BILI_FULL_PLAN_CAPACITY');const sheets=picked.flatMap(p=>fullReadingSheets(p,sampling)),cues=fullReadingCues(subtitleTracks,picked),textBudget=Math.max(256,Math.floor(budget.maxTextChars*.6)),pages=fullReadingCuePages(cues,textBudget),units=[];
   const added=new Set(),byWindow=new Map(),byPart=new Map();for(const page of pages){const key=page.cid+':'+Math.floor(ticks(page.start)/ticks(sampling.windowSeconds));if(!byWindow.has(key))byWindow.set(key,[]);byWindow.get(key).push(page);if(!byPart.has(page.cid))byPart.set(page.cid,[]);byPart.get(page.cid).push(page);}for(const part of picked){for(const sheet of sheets.filter(s=>s.cid===part.cid)){units.push({id:sheet.id,kind:'image',cid:part.cid});for(const page of byWindow.get(part.cid+':'+sheet.windowIndex)??[])if(!added.has(page.id)){added.add(page.id);units.push({id:page.id,kind:'text',cid:part.cid,item:page});}}for(const page of byPart.get(part.cid)??[])if(!added.has(page.id)){added.add(page.id);units.push({id:page.id,kind:'text',cid:part.cid,item:page});}}
   const frozen={scopeHash:scopeHash(scope),video,parts:picked,config:sampling,model:budget,cues:cues.map(({text,...rest})=>rest),sheets},r={schemaVersion:1,readingMode:'full-v1',readingId,scope:copy(scope),scopeHash:frozen.scopeHash,owner:{pluginId:scope.pluginId,accountRef:scope.accountRef,accountBindingId:scope.accountBindingId},video:copy(video),parts:picked,availableParts:copy(parts),config:sampling,model:budget,textBudget,summaryTextBudget:textBudget,summaryGraphVersion:2,sheets,cues,units,assets:{},batches:[],completedUnitIds:[],unitCursor:0,pageBudgets:[],summaryNodes:[],materialMissing:[],phase:'preparing',createdAt:now(),confirmed:false,planHash:fullReadingHash(frozen),estimatedCalls:Math.ceil(sheets.length/Math.max(1,Math.min(budget.maxImages,Math.floor((budget.contextTokens-4096)/budget.imageTokens))))+Math.ceil(cues.reduce((n,c)=>n+c.text.length,0)/textBudget)+1};save(r);
   try{await produce(r,signal,check,{preview:true});await guard(signal,check);const latest=load(readingId);latest.phase='awaiting-confirmation';save(latest);return dto(latest);}catch(e){const latest=load(readingId);latest.phase='paused';latest.modelReason=e.code??'BILI_FULL_ORIGINAL_UNAVAILABLE';save(latest);throw e;}
  },
  get({scope,readingId}){return dto(owned(readingId,scope));},
  getForAccount(args){return dto(account(args));},
  confirmForAccount(args){const r=account(args);ensure(args.confirmed===true&&args.planHash===r.planHash,'BILI_FULL_PLAN_CONFIRMATION_REQUIRED');ensure(r.phase!=='cancelled'&&Object.keys(r.assets).length>0,'BILI_FULL_ORIGINAL_UNAVAILABLE');r.confirmed=true;r.confirmedAt??=now();r.phase='reading';r.modelReason=null;save(r);return dto(r);},
  async read({scope,readingId,shrink=false,signal,check}){
   await guard(signal,check);let r=owned(readingId,scope);ensure(r.confirmed,'BILI_FULL_PLAN_CONFIRMATION_REQUIRED');ensure(r.phase!=='cancelled','BILI_VISION_STOPPED');ensure(r.phase!=='completed','BILI_FULL_ALREADY_COMPLETED');ensure(!r.batches.some(b=>['submitted','unknown'].includes(b.status)),'BILI_VISION_UNCERTAIN');ensure(!r.batches.some(b=>b.status==='completed'&&b.processed===false),'BILI_FULL_MATERIAL_NOT_COMPLETED');
   ensure(!r.batches.some(b=>b.aggregationAccepted===false),'BILI_FULL_SUMMARY_NO_PROGRESS');upgradeSummary(r);
    if(shrink){ensure(!r.batches.some(b=>['submitted','unknown'].includes(b.status)),'BILI_VISION_UNCERTAIN');r.batchImageLimit=Math.max(1,Math.floor((r.batchImageLimit??r.model.maxImages)/2));r.lastBatch=null;const done=completedSet(r);r.textBudget=Math.max(256,Math.floor(r.textBudget/2));r.pageBudgets=[...(r.pageBudgets??[]),r.textBudget];r.units=fullReadingUnits(r,{completedUnitIds:r.completedUnitIds,pageBudgets:[r.textBudget]});save(r);}
   if(r.lastBatch&&r.batches.some(b=>b.batchId===r.lastBatch.batchId&&b.status==='completed'))r.lastBatch=null;
   let b=r.lastBatch??buildBatch(r,{shrink});
   if(b.visualMaterialRefs.some(x=>x.startsWith('pending:'))){let job=jobs.get(readingId);if(job?.done){jobs.delete(readingId);job=null;}job??=startProducer(r,check,signal);
    for(;;){r=owned(readingId,scope);await guard(signal,check);const ready=b.unitIds.filter(id=>r.sheets.some(s=>s.id===id)).every(id=>r.assets[id]);if(ready)break;if(job.error)throw job.error;ensure(!job.done,'BILI_FULL_FRAMES_MISSING');await waitJob(job,signal);}
    b=buildBatch(r,{shrink});
   }
   r=owned(readingId,scope);r.lastBatch=b;r.phase='reading';r.modelReason=null;save(r);return {...copy(b),readingId,readingMode:'full-v1',coverage:fullReadingCoverage(r)};
  },
  verifyMaterial({scope,readingId,batchId,material,visualMaterialRefs}){const r=owned(readingId,scope),b=r.lastBatch;ensure(b?.batchId===batchId&&b.inputHash===batchInput(b)&&fullReadingHash(material)===fullReadingHash(b.material)&&fullReadingHash(visualMaterialRefs)===fullReadingHash(b.visualMaterialRefs),'SOCIAL_UNOBSERVED_MATERIAL');return {inputHash:b.inputHash,stepKind:b.stepKind,finalSummary:b.finalSummary};},
  verifyRecoveryMaterial({scope,readingId,batchId,material,visualMaterialRefs}){const r=owned(readingId,scope),entry=r.batches.find(b=>b.batchId===batchId);ensure(entry?.requestHash,'SOCIAL_UNOBSERVED_MATERIAL');const request=disk.get('request',entry.requestHash),b=request.batch;ensure(request.readingId===readingId&&b?.batchId===batchId&&b.inputHash===entry.inputHash&&b.inputHash===batchInput(b)&&fullReadingHash(material)===fullReadingHash(b.material)&&fullReadingHash(visualMaterialRefs)===fullReadingHash(b.visualMaterialRefs),'SOCIAL_UNOBSERVED_MATERIAL');return {inputHash:b.inputHash,stepKind:b.stepKind,finalSummary:b.finalSummary};},
  resolve({scope,readingId,visualMaterialRefs}){const r=owned(readingId,scope);ensure(Array.isArray(visualMaterialRefs)&&visualMaterialRefs.length<=8,'BILI_VISION_REFERENCE_INVALID');return visualMaterialRefs.map(ref=>{const id=Object.keys(r.assets).find(id=>r.assets[id].ref===ref),a=r.assets[id],sheet=r.sheets.find(s=>s.id===id);ensure(a&&sheet,'BILI_VISION_REFERENCE_DENIED');const p=join(images,a.sha256+'.png');ensure(existsSync(p)&&lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink(),'BILI_VISION_CACHE_MISSING');const bytes=readFileSync(p);ensure(fullReadingHash(bytes)===a.sha256,'BILI_VISION_CACHE_MISMATCH');return {ref,mimeType:'image/png',bytes,sha256:a.sha256,from:sheet.from,to:sheet.to};});},
  claim({scope,readingId,batchId,inputHash}){const r=owned(readingId,scope),prior=r.batches.find(b=>b.batchId===batchId);if(prior?.status==='not-sent'){ensure(r.confirmed&&r.phase!=='cancelled'&&prior.inputHash===inputHash&&r.lastBatch?.inputHash===inputHash&&!prior.receiptHash,'BILI_FULL_BATCH_MISMATCH');prior.status='submitted';prior.submittedAt=now();save(r);return {claimed:true};}if(prior)return {claimed:false,status:prior.status};ensure(r.confirmed&&r.phase!=='cancelled'&&r.lastBatch?.batchId===batchId&&r.lastBatch.inputHash===inputHash,'BILI_FULL_BATCH_MISMATCH');ensure(!r.lastBatch.visualMaterialRefs.some(x=>x.startsWith('pending:')),'BILI_FULL_FRAMES_MISSING');const requestHash=disk.put('request',{readingId,batch:copy(r.lastBatch)}),{material,...entry}=copy(r.lastBatch);r.batches.push({...entry,requestHash,status:'submitted',submittedAt:now()});save(r);return {claimed:true};},
  releaseUnsent({scope,readingId,batchId,inputHash}){const r=owned(readingId,scope),batch=r.batches.find(b=>b.batchId===batchId);ensure(batch?.status==='submitted'&&batch.inputHash===inputHash&&!batch.receiptHash&&!batch.providerRequestId,'BILI_FULL_BATCH_MISMATCH');batch.notSentAttempts=[...(batch.notSentAttempts??[]),{submittedAt:batch.submittedAt,releasedAt:now(),requestHash:batch.requestHash}];batch.status='not-sent';if(!['cancelled','completed'].includes(r.phase)){r.phase='paused';r.modelReason='SOCIAL_MODEL_NOT_SUBMITTED';}save(r);return dto(r);},
  finish:args=>finishBatch(args),
  reconcile:args=>finishBatch({...args,status:'completed'},{reconcile:true}),
  readImageForAccount(args){const r=account(args),id=Object.keys(r.assets).find(id=>r.assets[id].ref===args.ref);ensure(id,'BILI_VISION_REFERENCE_DENIED');const a=r.assets[id],bytes=readFileSync(join(images,a.sha256+'.png'));ensure(fullReadingHash(bytes)===a.sha256,'BILI_VISION_CACHE_MISMATCH');return {mimeType:'image/png',dataUrl:'data:image/png;base64,'+bytes.toString('base64')};},
  pauseForAccount(args){const r=account(args);pause(r.readingId);if(!['completed','cancelled'].includes(r.phase)){r.phase='paused';r.modelReason='BILI_FULL_PAUSED';save(r);}return dto(r);},
  stopForAccount(args){const r=account(args);if(args.onlyIfUnconfirmed===true){ensure(r.confirmed!==true,'BILI_FULL_PLAN_FROZEN');ensure(typeof args.planHash==='string'&&args.planHash===r.planHash&&Number.isSafeInteger(args.revision)&&args.revision===r.revision&&['awaiting-confirmation','paused'].includes(r.phase)&&r.batches.length===0,'BILI_CONTROL_STALE');}if(r.phase==='completed'||r.phase==='cancelled')return dto(r);pause(r.readingId,'BILI_VISION_STOPPED');r.phase='cancelled';save(r);return dto(r);},
  cancelScope,
  async close(){if(closed)return;for(const id of jobs.keys())pause(id,'BILI_VISION_CLOSED');await Promise.allSettled([...jobs.values()].map(j=>j.promise));closed=true;}
 };
}
