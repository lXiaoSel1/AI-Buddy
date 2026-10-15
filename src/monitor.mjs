import {UsageRepository} from './usage-repository.mjs';
import {migrateLegacy} from './usage-migrate.mjs';
import { readdir, stat, open, mkdir } from 'node:fs/promises';
import { join, basename, resolve, sep } from 'node:path';
import { watch,createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { UsageLedger } from './ledger.mjs';
import { createSnapshotStorage, readJson } from './storage.mjs';
import { MONITOR_INTERVALS } from './preferences.mjs';
import { replayMonitorDelta, orphanMonitorDeltas } from './monitor-cache.mjs';

export class LocalMonitor {
  constructor({roots,dataRoot,onUpdate=()=>{},refreshIntervalMs=1000,persistentHistory=false}) {
    this.roots=roots; this.dataRoot=dataRoot; this.onUpdate=onUpdate;
    this.repository=persistentHistory?new UsageRepository(join(dataRoot,"usage-ledger-v2","legacy.sqlite")):null;
    this.files=new Map(); this.ledger=new UsageLedger({},this.repository); this.errors=new Map(); this.watchers=[]; this.closed=false; this.busy=false; this.indexing=true;
    this.startedAt=Date.now();this.ledger.workStartedAt=this.startedAt;
    this.cache=createSnapshotStorage(join(dataRoot,'monitor-index-v005.json'),{retainText:false,compactReceipt:true});
    this.progress={scanned:0,total:0}; this.lastSave=0; this.saveRevision=-1;
    this.dirtyFiles=new Set();this.hasCache=false;this.persisting=null;this.deltaFile='monitor-deltas-'+Date.now()+'.jsonl';
    this.pendingPaths=new Map();this.lastDiscovery=0;
    this.startup={mode:'cold',restoreMs:0,scanMs:0,totalMs:0,recoveredDeltaFiles:0,logBytesRead:0,logFilesRead:0,unchangedFiles:0};this.deltaBytes=0;
    this.setRefreshInterval(refreshIntervalMs);
  }
  start() {return this.starting??=this.initialize();}
  async initialize() {
    const started=performance.now();
    if(this.repository){
      const restored=await migrateLegacy(this.repository,this.dataRoot);
      this.ledger.sessions=restored.sessions;this.files=restored.files;this.hasCache=true;this.startup.mode=restored.mode;
      if(restored.invalid)this.errors.set('index-cache','索引末尾不完整，正在核对原日志');
      this.ledger.rebuildRequestIndex();
    }else{
    let current=await readJson(this.cache,null),saved=current?.version===1?current:await readJson(createSnapshotStorage(join(this.dataRoot,'monitor-index-v004.json'),{retainText:false,compactReceipt:true}),null);
    if(saved?.version===1) {
      for(const kind of ['sessions','codex','claude'])this.ledger[kind]=new Map(saved.ledger?.[kind]||[]);
      this.files=new Map(saved.files || []);this.hasCache=current?.version===1;this.deltaFile=saved.deltaFile || this.deltaFile;
      const replay=await replayMonitorDelta(this.dataRoot,this.deltaFile,this.ledger,this.files);this.deltaBytes=replay.bytes;
      if(replay.invalid)this.errors.set('index-cache','索引末尾不完整，正在核对原日志');
      this.startup.mode=this.hasCache?'cached':'migration';
    }
    // Release the obsolete v004 arrays before loading large migration deltas.
    // Canonicalize their request keys first so v005 updates replace old rows
    // instead of retaining a second full history until the final reindex.
    current=null;saved=null;
    if(!this.hasCache){
      this.ledger.rebuildRequestIndex();this.ledger.requestGroups.clear();this.ledger.dirtyRequestSessions.clear();
      this.files.clear();
      for(const file of await orphanMonitorDeltas(this.dataRoot)){
        const replay=await replayMonitorDelta(this.dataRoot,file,this.ledger,this.files);
        if(replay.rows)this.startup.recoveredDeltaFiles++;
        if(replay.invalid)this.errors.set(file,'索引记录不完整，保留已确认部分并核对原日志');
      }
      if(this.startup.recoveredDeltaFiles)this.startup.mode='recovered';
      this.deltaFile='monitor-deltas-v005-'+Date.now()+'-'+randomUUID()+'.jsonl';this.deltaBytes=0;
    }
    this.ledger.rebuildRequestIndex();
    }
    try{
      const reader=createInterface({input:createReadStream(join(this.dataRoot,'companion-usage.jsonl')),crlfDelay:Infinity});
      for await(const line of reader){let row;try{row=JSON.parse(line);}catch{continue;}if(row.sessionId && row.usage)this.ingestCompanion(row);}
    }catch(e){if(e.code!=='ENOENT')this.errors.set('companion-usage',e.message);}
    // Commit the migrated base even if no new request arrives, and before the
    // expensive scan. Subsequent checkpoints also retain partial scan progress.
    if(!this.hasCache)await this.persist();
    this.startup.restoreMs=performance.now()-started;
    this.emit();
    if(this.closed)return this;
    for(const root of this.roots) {
      try { this.watchers.push(watch(root.path,{recursive:true},(_,name)=>{if(String(name).endsWith('.jsonl')) {this.pendingPaths.set(join(root.path,String(name)),root.provider);this.schedule();}})); }
      catch(e) { if(e.code!=='ENOENT') this.errors.set(root.path,e.message); }
    }
    this.timer=setInterval(()=>this.schedule(),this.refreshIntervalMs);
    this.persistTimer=setInterval(()=>{void this.persist().catch(e=>this.errors.set('index-cache',e.message));},15000);
    const scanStart=performance.now();await this.scan(true);this.startup.scanMs=performance.now()-scanStart;this.startup.totalMs=performance.now()-started; this.indexing=false; this.emit(); return this;
  }
  schedule() { if(this.closed) return; clearTimeout(this.debounce); this.debounce=setTimeout(()=>{void this.scan(false);},120); }
  setRefreshInterval(ms){
    if(!MONITOR_INTERVALS.includes(ms))throw new Error('Invalid monitor interval');
    this.refreshIntervalMs=ms;
    if(this.timer&&!this.closed){clearInterval(this.timer);this.timer=setInterval(()=>this.schedule(),ms);}
  }
  async discover(root,folder=root.path,found=[]) {
    try {
      for(const entry of await readdir(folder,{withFileTypes:true})) {
        const path=join(folder,entry.name);
        if(entry.isDirectory()) await this.discover(root,path,found);
        else if(entry.isFile() && entry.name.endsWith('.jsonl')) found.push({path,provider:root.provider});
      }
    } catch(e) { if(e.code!=='ENOENT') this.errors.set(folder,e.message); }
    return found;
  }
  watches(path,provider){
    const canonical=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value),file=canonical(path);
    return this.roots.some(root=>root.provider===provider&&(file===canonical(root.path)||file.startsWith(canonical(root.path)+sep)));
  }
  async scan(full=false) {
    if(this.busy || this.closed) return;
    this.busy=true;
    try {
      const all=[];
      if(full || Date.now()-this.lastDiscovery>30000){for(const root of this.roots)all.push(...await this.discover(root));this.lastDiscovery=Date.now();}
      else {
        const paths=new Map(this.pendingPaths);this.pendingPaths.clear();
        for(const [path,f] of [...this.files].filter(([path,f])=>this.watches(path,f.provider)).sort((a,b)=>b[1].mtime-a[1].mtime).slice(0,25))paths.set(path,f.provider);
        for(const [path,provider] of paths)all.push({path,provider});
      }
      if(full){await Promise.all(all.map(async item=>{try{item.mtime=(await stat(item.path)).mtimeMs;}catch{item.mtime=0;}}));all.sort((a,b)=>b.mtime-a.mtime);}
      this.progress={scanned:0,total:all.length};
      let lastEmit=Date.now();
      for(const item of all) {
        if(this.closed) break;
        try { await this.readFile(item); this.errors.delete(item.path); }
        catch(e) { this.errors.set(item.path,e.message); }
        this.progress.scanned++;
        if(Date.now()-lastEmit>1500) { this.emit(); lastEmit=Date.now(); await new Promise(r=>setImmediate(r)); }
      }
      this.progress.scanned=all.length;
      this.emit(); if(full) await this.persist();
    } finally { this.busy=false; }
  }
  async readFile({path,provider}) {
    const info=await stat(path);
    const old=this.files.get(path);
    if(old && old.size===info.size && old.mtime===info.mtimeMs){if(this.indexing)this.startup.unchangedFiles++;return;}
    let offset=old?.offset || 0;
    if(!old || info.size<offset || (info.size===old.size && info.mtimeMs!==old.mtime)) offset=0;
    let id=old?.sessionId || (provider==='codex' ? basename(path,'.jsonl').match(/[a-f0-9]{8}-[a-f0-9-]{27}$/i)?.[0] : basename(path,'.jsonl')) || basename(path,'.jsonl');
    const handle=await open(path,'r');
    const fingerprint=async(position,length)=>{const bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,position);return createHash('sha256').update(bytes.subarray(0,read.bytesRead)).digest('hex');};
    // Verify both the saved head and read boundary. A rewritten longer file
    // must be replayed instead of being mistaken for an ordinary append.
    if(offset && old?.anchor && (await fingerprint(Math.max(0,offset-4096),Math.min(offset,4096))!==old.anchor || await fingerprint(0,old.headLength)!==old.head))offset=0;
    let pending=Buffer.alloc(0), position=offset, committed=offset,skipping=false;
    if(this.indexing)this.startup.logFilesRead++;
    const relevant=prefix=>{
      if(provider!=='codex')return true;
      const kind=prefix.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
      if(kind==='session_meta'||kind==='turn_context')return true;
      if(kind!=='event_msg')return false;
      return /"payload"\s*:\s*\{\s*"type"\s*:\s*"(token_count|task_started|task_complete|agent_turn_complete|turn_aborted|task_aborted|interrupted|error|task_error|approval_requested|permission_requested|request_user_input)"/.test(prefix);
    };
    try {
      const chunk=Buffer.alloc(256*1024);
      while(position<info.size) {
        if(this.closed)break;
        const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,info.size-position),position); if(!bytesRead) break;
        if(this.indexing)this.startup.logBytesRead+=bytesRead;
        position+=bytesRead;
        let incoming=chunk.subarray(0,bytesRead);
        if(skipping){const end=incoming.indexOf(10);if(end<0){committed+=bytesRead;continue;}committed+=end+1;incoming=incoming.subarray(end+1);skipping=false;}
        pending=Buffer.concat([pending,incoming]);
        let newline;
        while((newline=pending.indexOf(10))>=0) {
          const buffer=pending.subarray(0,newline);pending=pending.subarray(newline+1);committed+=newline+1;
          if(!relevant(buffer.subarray(0,700).toString('utf8')))continue;
          const line=buffer.toString('utf8');if(!line.trim())continue;
          let record; try {record=JSON.parse(line);} catch {continue;}
          id=provider==='codex'?this.ledger.ingestCodex(record,id,path):this.ledger.ingestClaude(record,id,path);
        }
        if(pending.length>700 && !relevant(pending.subarray(0,700).toString('utf8'))){committed+=pending.length;pending=Buffer.alloc(0);skipping=true;}
        await new Promise(r=>setImmediate(r));
      }
      const headLength=Math.min(committed,4096),head=await fingerprint(0,headLength),anchor=await fingerprint(Math.max(0,committed-4096),Math.min(committed,4096));
      this.files.set(path,{provider,size:info.size,mtime:info.mtimeMs,offset:committed,sessionId:id,headLength,head,anchor});
    } finally {await handle.close();}
    this.dirtyFiles.add(path);
  }
  snapshot() { return {...this.ledger.snapshot(),indexing:this.indexing,indexPhase:this.indexing?(this.startup.mode==='cold'||this.startup.mode==='migration'?'building':'checking'):'ready',startup:{...this.startup},progress:this.progress,files:this.files.size,errors:[...this.errors].map(([path,message])=>({path,message}))}; }
  ingestCompanion(row){this.ledger.session('codex',row.sessionId,{purpose:row.purpose,connectionIdentity:row.connectionIdentity,workspace:row.purpose==='cg-theme'?'AI娘 CG 主题设计':'鲸鱼娘陪伴聊天',model:row.model,companion:true,createdAt:row.timestamp});this.ledger.ingestCodex({type:'event_msg',timestamp:row.timestamp,payload:{type:'token_count',info:{total_token_usage:row.usage}}},row.sessionId,'companion');}
  emit() { this.onUpdate(this.snapshot()); }
  async persist() {
    if(this.repository){
    if(this.hasCache&&this.saveRevision===this.ledger.revision&&!this.dirtyFiles.size)return;
    for(const key of this.ledger.dirtySessions)this.repository.put('sessions',key,this.ledger.sessions.get(key));
    for(const key of this.dirtyFiles)this.repository.put('files',key,this.files.get(key));
    this.repository.publish({ready:true},this.ledger.dirtyRequestSessions);
    this.saveRevision=this.ledger.revision;this.hasCache=true;this.ledger.clearDirty();this.dirtyFiles.clear();
  return;
    }

    if(this.persisting)return this.persisting;
    if(this.hasCache&&this.saveRevision===this.ledger.revision && !this.dirtyFiles.size)return;
    this.persisting=(async()=>{
      await mkdir(this.dataRoot,{recursive:true});
      const revision=this.ledger.revision,ledger=this.ledger.delta(),files=[...this.dirtyFiles].map(k=>[k,this.files.get(k)]);
      this.ledger.clearDirty();this.dirtyFiles.clear();
      try{
        if(!this.hasCache||this.deltaBytes>64*1024*1024){
          const next='monitor-deltas-v005-'+Date.now()+'-'+randomUUID()+'.jsonl';
          await this.cache.writeText(JSON.stringify({version:1,ledger:this.ledger.serialize(),files:[...this.files],deltaFile:next}));
          this.deltaFile=next;this.deltaBytes=0;this.hasCache=true;
        }else{
          const text='\n'+JSON.stringify({version:1,ledger,files})+'\n';
          const handle=await open(join(this.dataRoot,this.deltaFile),'a');
          try{await handle.writeFile(text);await handle.sync();this.deltaBytes=(await handle.stat()).size;}finally{await handle.close();}
        }
        this.saveRevision=revision;
      }catch(error){
        for(const [kind,dirty] of [['sessions','dirtySessions'],['codex','dirtyCodex'],['claude','dirtyClaude']])for(const [key] of ledger[kind])this.ledger[dirty].add(key);
        for(const [key] of files)this.dirtyFiles.add(key);throw error;
      }
    })();
    try{await this.persisting;}finally{this.persisting=null;}
  }
  async close() { this.closed=true; clearInterval(this.timer); clearInterval(this.persistTimer); clearTimeout(this.debounce); for(const w of this.watchers) w.close(); await this.starting;while(this.busy)await new Promise(r=>setTimeout(r,10));await this.persisting;await this.persist();this.repository?.close(); }
}
