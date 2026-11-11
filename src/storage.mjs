import { mkdirSync, readdirSync, readFileSync, readSync, openSync, writeSync, fsyncSync, closeSync, lstatSync, statSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { readFile, readdir, unlink, open, stat as statAsync } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {measureDesktopDiagnostic} from './desktop-diagnostics.mjs';

// Snapshot publication: completed snapshots are committed in a journal. A
// retention pass keeps the newest commits plus one per local day; snapshots
// that existed before retention was introduced (the backlog) stay untouched
// until the offline archive tool marks the store as archived.
export const RETENTION=Object.freeze({recent:50,days:90,every:25,orphanAgeMs:3600000});
const BASELINE='retention-baseline.json',ARCHIVED='retention-archived.json';
const localDay=t=>{const d=new Date(t);return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();};
export function selectRetained(commits,now=Date.now(),{recent=RETENTION.recent,days=RETENTION.days}={}){
  const keep=new Set(),seen=new Set(),cutoff=now-days*86400000;
  for(let n=Math.max(0,commits.length-recent);n<commits.length;n++)keep.add(commits[n].file);
  for(let n=commits.length-1;n>=0;n--){const t=Date.parse(commits[n].timestamp);if(!(t>cutoff))continue;const day=localDay(t);if(!seen.has(day)){seen.add(day);keep.add(commits[n].file);}}
  return keep;
}
export function parseCommits(text){
  const commits=[];let torn=0;
  for(const line of text.split('\n')){if(!line.trim())continue;try{const c=JSON.parse(line);if(typeof c.file==='string'&&basename(c.file)===c.file&&typeof c.sha256==='string'){commits.push(c);continue;}}catch{}torn++;}
  return {commits,torn};
}
export function isSnapshotCommit(value){
  const file=value?.file;
  return typeof file==='string'&&!!file&&file!=='.'&&file!=='..'&&!/[\\/:\0]/.test(file)&&basename(file)===file&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256);
}
export function hasSnapshotHistory(entries){
  return entries.some(entry=>{const name=entry.toLowerCase();return name.endsWith('.json')||name==='commits.jsonl'||name.startsWith('commits.jsonl.');});
}
export function retentionState(root){
  if(existsSync(join(root,ARCHIVED))){
    try{const marker=JSON.parse(readFileSync(join(root,ARCHIVED),'utf8')),protectedFiles=Array.isArray(marker.protectedFiles)?marker.protectedFiles.filter(file=>typeof file==='string'&&file.length>0&&file!=='.'&&file!=='..'&&basename(file)===file&&!file.includes('\\')&&!file.includes('/')):[];if(protectedFiles.length)return {archived:true,protectedFiles};}catch{}
    return {archived:true};
  }
  try{const b=JSON.parse(readFileSync(join(root,BASELINE),'utf8'));if(Number.isFinite(b.backlogUntil)&&Number.isSafeInteger(b.journalBytes))return {archived:false,...b};}catch{}
  return null;
}
async function yieldEvery(n){if(n%100===0)await new Promise(r=>setImmediate(r));}
// Snapshot file names start with the ISO time they were written (":" replaced by "-").
const nameTime=name=>Date.parse(name.slice(0,24).replace(/T(\d\d)-(\d\d)-/,'T$1:$2:'));

export function createSnapshotStorage(logicalPath, {retainText=true, compactReceipt=false, retention=true, deferWrites=false, protectExisting=false, onAudit}={}) {
  const root = resolve(dirname(logicalPath), basename(logicalPath) + '.snapshots');
  const journal = join(root, 'commits.jsonl');
  let cached = null, pending = null, loaded = false, tail = Promise.resolve(), preexisting = false, newestAtLoad = 0, bytesAtLoad = 0, published = 0, journalGeneration = 0;
  let observedAbsent=false, creationConflict;
  function fileHash(path) {
    const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(256*1024),hash=createHash('sha256');
    try {let n;while((n=readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{closeSync(fd);}
  }
  function recovery(reason) {
    return Object.assign(Error('现有存档无法校验，原文件已保留。请从有效存档副本恢复。'),{code:'SNAPSHOT_RECOVERY_REQUIRED',reason});
  }
  function readPayload(path) {
    if(!retainText)return {sha256:fileHash(path),size:statSync(path).size};
    const bytes=readFileSync(path);
    return {content:bytes.toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
  }
  function existingInfo(path) {
    try {return lstatSync(path);} catch(error) {if(error.code==='ENOENT')return null;throw error;}
  }
  function readLegacy() {
    if(existingInfo(root)){
      let entries;
      try {entries=readdirSync(root);} catch(error) {if(error.code==='ENOENT')throw recovery('snapshot-directory-unavailable');throw error;}
      if(hasSnapshotHistory(entries))throw recovery('journal-missing');
    }
    const info=existingInfo(logicalPath);
    if(!info)return null;
    if(!info.isFile())throw recovery('legacy-not-a-file');
    let payload;
    try {payload=readPayload(logicalPath);} catch(error) {if(error.code==='ENOENT')throw recovery('legacy-disappeared');throw error;}
    return {...payload,version:'legacy-'+payload.sha256,path:logicalPath};
  }
  function load() {
    if(creationConflict)throw creationConflict;
    if (loaded) return;
    let text;
    try {text=readFileSync(journal,'utf8');} catch(error) {
      if(error.code!=='ENOENT')throw error;
      if(protectExisting){cached=readLegacy();if(!cached)observedAbsent=true;}
      loaded=true;
      return;
    }
    const lines=text.split('\n');
    let latestTime=0, skipped=0, selected=null, recoveredAt;
    for(let n=lines.length-1;n>=0;n--){
      if(!lines[n].trim())continue;
      let commit;
      try {commit=JSON.parse(lines[n]);} catch {skipped++;continue;}
      if(!isSnapshotCommit(commit)){skipped++;continue;}
      const {file}=commit;
      const timestamp=typeof commit.timestamp==='string'?Date.parse(commit.timestamp):NaN;
      latestTime ||= timestamp||0;
      const path=join(root,file);
      try {
        const payload=readPayload(path);
        if(payload.sha256!==commit.sha256){skipped++;continue;}
        selected={...payload,version:file,path};
        if(Number.isFinite(timestamp))recoveredAt=commit.timestamp;
        break;
      } catch(error) {
        // Only a missing payload or a failed checksum proves that a newer
        // commit is unavailable for recovery. An I/O error can be temporary.
        if(protectExisting&&error.code!=='ENOENT')throw error;
        skipped++;
      }
    }
    if(protectExisting&&!selected)throw recovery('no-valid-commit');
    cached=selected;
    preexisting=true;newestAtLoad=latestTime||Date.now();bytesAtLoad=Buffer.byteLength(text,'utf8');
    loaded=true;
    if(protectExisting&&skipped){
      try {onAudit?.({type:'snapshot-fallback',target:logicalPath,skipped,version:selected.version,recoveredAt});} catch {}
    }
  }
  async function stat() { load(); const current=pending||cached;return current ? { type: 'file', version: current.version, size: current.size } : undefined; }
  async function readText() {
    load();
    if (pending) return pending.content;
    if (!cached) { const e = new Error('No committed snapshot'); e.code = 'ENOENT'; throw e; }
    return retainText?cached.content:readFileSync(cached.path,'utf8');
  }
  function publish(content, expected) {
    // A staged first save may outlive the observation that the directory was
    // empty. Never append that default state over history that reappeared.
    if(observedAbsent)loaded=false;
    try {load();} catch(error) {
      if(observedAbsent&&error.code==='SNAPSHOT_RECOVERY_REQUIRED')creationConflict=error;
      throw error;
    }
    if(observedAbsent&&cached){creationConflict=recovery('existing-save-appeared');throw creationConflict;}
    if (expected?.kind === 'createIfAbsent' && cached) { const e = new Error('Snapshot already exists'); e.code = 'FS_NOT_OBSERVED'; throw e; }
    if (expected?.kind === 'replaceIfVersion' && cached?.version !== expected.version) { const e = new Error('Snapshot version changed'); e.code = 'FS_STALE_VERSION'; throw e; }
    const digest=createHash('sha256').update(content).digest('hex'),size=Buffer.byteLength(content,'utf8');
    if (cached?.sha256 === digest && cached.size===size) return compactReceipt?{operation:'unchanged',version:cached.version}:{ operation:'unchanged', version:cached.version, after:content, before:content };
    mkdirSync(root, { recursive:true });
    const file = new Date().toISOString().replaceAll(':','-') + '-' + randomUUID() + '.json';
    const fd = openSync(join(root,file),'wx');
    try { measureDesktopDiagnostic('snapshot-write',()=>{writeSync(fd,content,null,'utf8');fsyncSync(fd);}); } finally { closeSync(fd); }
    const record = { file, sha256:digest, timestamp:new Date().toISOString() };
    const log = openSync(journal,'a');
    journalGeneration++;
    try { measureDesktopDiagnostic('snapshot-journal',()=>{writeSync(log,'\n' + JSON.stringify(record) + '\n',null,'utf8');fsyncSync(log);}); } finally { closeSync(log); }
    const operation=cached?'update':'create',previous=compactReceipt?undefined:currentText(cached);
    cached = { content:retainText?content:undefined, sha256:digest, version:file, size, path:join(root,file) };
    observedAbsent=false;
    return compactReceipt?{operation,version:file}:{ operation, version:file, before:previous, after:content };
  }
  function currentText(current) { return current?(current===pending||retainText?current.content:readFileSync(current.path,'utf8')):null; }
  function deferredReceipt(operation,current,before,after) {
    // A receipt retained by a caller follows its accepted version when that
    // version is published; superseded pending versions remain stale.
    return compactReceipt?{operation,get version(){return current?.version;}}:{operation,get version(){return current?.version;},before,after};
  }
  function accept(content,expected) {
    load();const current=pending||cached;
    if (expected?.kind==='createIfAbsent'&&current) {const e=new Error('Snapshot already exists');e.code='FS_NOT_OBSERVED';throw e;}
    if (expected?.kind==='replaceIfVersion'&&current?.version!==expected.version&&!current?.aliases?.has(expected.version)) {const e=new Error('Snapshot version changed');e.code='FS_STALE_VERSION';throw e;}
    const digest=createHash('sha256').update(content).digest('hex'),size=Buffer.byteLength(content,'utf8');
    if (current?.sha256===digest&&current.size===size)return deferredReceipt('unchanged',current,content,content);
    const before=compactReceipt?undefined:currentText(current);
    pending={content,sha256:digest,size,version:'pending-'+randomUUID()};
    return deferredReceipt(current?'update':'create',pending,before,content);
  }
  function publishPending(synchronous) {
    load();
    if (!pending) {const content=compactReceipt?undefined:currentText(cached);return deferredReceipt('unchanged',cached,content,content);}
    const accepted=pending;
    try {
      const receipt=publish(accepted.content),version=accepted.version;
      accepted.version=receipt.version;
      cached.aliases=new Set([version,receipt.version]);pending=null;
      return receipt;
    } catch(error) {
      try {onAudit?.({type:'snapshot-flush-failed',target:logicalPath,code:error.code||'SNAPSHOT_FLUSH_FAILED',message:error.message,synchronous});}catch{}
      throw error;
    }
  }
  function maintainRetention(receipt) {
    if(retention&&receipt.operation!=='unchanged'&&++published>=RETENTION.every){published=0;return prune().catch(()=>undefined);}
  }
  function queue(run) {
    const result=tail.then(run,run);
    tail=result.then(maintainRetention,()=>undefined).then(()=>undefined);return result;
  }
  function flushSync() {
    const receipt=publishPending(true);
    if(retention&&receipt.operation!=='unchanged'&&++published>=RETENTION.every){published=0;const run=tail.then(()=>prune(),()=>prune());tail=run.catch(()=>undefined);}
    return receipt;
  }
  // The caller must pause/drain all users before replacing storage offline.
  // Reload intentionally discards pending state so it cannot undo an import.
  function reload() {
    journalGeneration++;
    cached=null;pending=null;loaded=false;preexisting=false;newestAtLoad=0;bytesAtLoad=0;observedAbsent=false;creationConflict=undefined;
    load();return cached?{type:'file',version:cached.version,size:cached.size}:undefined;
  }
  // First retention pass on a store that already had commits records where the
  // backlog ends; a store created by this code is managed in full from the start.
  function ensureRetentionState() {
    const existing=retentionState(root);if(existing)return existing;
    if(!preexisting)writeFileSync(join(root,ARCHIVED),JSON.stringify({reason:'created-with-retention',at:new Date().toISOString()}));
    else writeFileSync(join(root,BASELINE),JSON.stringify({backlogUntil:newestAtLoad,journalBytes:bytesAtLoad,at:new Date().toISOString(),note:'Commits up to backlogUntil stay until the archive tool writes '+ARCHIVED}));
    return retentionState(root);
  }
  async function prune(now=Date.now()) {
    load();
    if (!existsSync(journal)) return {dropped:0,orphans:0,rewritten:false};
    const state=ensureRetentionState();
    let generation=journalGeneration,droppedCount=0,orphans=0,rewritten=false;
    const interrupted=()=>({dropped:droppedCount,orphans,rewritten,archived:state.archived,interrupted:true});
    let text;
    if (state.archived) text=await readFile(journal,'utf8');
    else { const handle=await open(journal,'r');try{const size=(await handle.stat()).size,length=Math.max(0,size-state.journalBytes),buffer=Buffer.alloc(length);await handle.read(buffer,0,length,state.journalBytes);text=buffer.toString('utf8');}finally{await handle.close();} }
    // session-end can synchronously publish while any filesystem await above
    // is pending. Never replace its newer journal with this older view.
    if(generation!==journalGeneration)return interrupted();
    const {commits,torn}=parseCommits(text),keep=selectRetained(commits,now);
    const protectedFiles=new Set(state.protectedFiles||[]);for(const file of protectedFiles)keep.add(file);
    if (cached) keep.add(cached.version);
    const dropped=commits.filter(c=>!keep.has(c.file)&&(state.archived||Date.parse(c.timestamp)>state.backlogUntil));
    if (state.archived && (dropped.length || torn)) {
      const temp=journal+'.tmp',body=commits.filter(c=>!dropped.includes(c)).map(c=>'\n'+JSON.stringify(c)+'\n').join('');
      const fd=openSync(temp,'w');try{writeSync(fd,body,null,'utf8');fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temp,journal);generation=++journalGeneration;rewritten=true;
    }
    let n=0;
    for (const c of dropped) { if(generation!==journalGeneration)return interrupted();await unlink(join(root,c.file)).catch(e=>{if(e.code!=='ENOENT')throw e;});droppedCount++;await yieldEvery(++n); }
    // Orphans: snapshot files that never reached the journal (interrupted writes).
    // Before archiving, only files written after the backlog are considered.
    const referenced=new Set(commits.map(c=>c.file));
    for (const name of await readdir(root)) {
      if(generation!==journalGeneration)return interrupted();
      if (!name.endsWith('.json') || name===BASELINE || name===ARCHIVED || referenced.has(name) || protectedFiles.has(name)) continue;
      if (!state.archived && !(nameTime(name) > state.backlogUntil)) continue;
      const info=await statAsync(join(root,name)).catch(()=>null);
      if(generation!==journalGeneration)return interrupted();
      if (!info || now-info.mtimeMs < RETENTION.orphanAgeMs) continue;
      await unlink(join(root,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});orphans++;await yieldEvery(++n);
    }
    return {dropped:droppedCount,orphans,rewritten,archived:state.archived};
  }
  return { target:logicalPath, stat, readText, drain:()=>tail, flush:()=>queue(()=>publishPending(false)), flushSync, reload, prune:now=>{const run=tail.then(()=>prune(now),()=>prune(now));tail=run.then(()=>undefined,()=>undefined);return run;}, writeText(content,expected) {
    if(deferWrites){try{return Promise.resolve(accept(content,expected));}catch(error){return Promise.reject(error);}}
    return queue(()=>publish(content,expected));
  } };
}

export async function readJson(storage,fallback) {
  try { return JSON.parse(await storage.readText()); } catch(e) { if(e.code==='ENOENT') return fallback; throw e; }
}

export function restrictedFileService(root) {
  const stores = new Map();
  function safe(path) { const p=resolve(path); if(p !== resolve(root) && !p.startsWith(resolve(root)+'\\') && !p.startsWith(resolve(root)+'/')) throw new Error('Companion storage boundary'); return p; }
  function store(p) { p=safe(p); if(!stores.has(p)) stores.set(p,createSnapshotStorage(p)); return stores.get(p); }
  return {
    workspaceRoot:root,
    resolve:async (path,options)=>safe(resolve(options?.cwd || root,path)),
    stat:async path=>store(path).stat(),
    readText:async path=>store(path).readText(),
    writeText:async (path,content,expected)=>store(path).writeText(content,expected),
  };
}
