import { mkdirSync, readdirSync, readFileSync, readSync, openSync, writeSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// Snapshot publication is additive. Completed snapshots are committed in an
// append-only journal; interrupted writes remain on disk and are never cleaned.
export function createSnapshotStorage(logicalPath, {retainText=true, compactReceipt=false}={}) {
  const root = resolve(dirname(logicalPath), basename(logicalPath) + '.snapshots');
  const journal = join(root, 'commits.jsonl');
  let cached = null, loaded = false, tail = Promise.resolve();
  function fileHash(path) {
    const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(256*1024),hash=createHash('sha256');
    try {let n;while((n=readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{closeSync(fd);}
  }
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const lines = readFileSync(journal, 'utf8').split('\n');
      for (let n = lines.length - 1; n >= 0; n--) {
        try {
          const commit = JSON.parse(lines[n]);
          if (basename(commit.file) !== commit.file) continue;
          const path=join(root,commit.file),content=retainText?readFileSync(path,'utf8'):undefined;
          if ((retainText?createHash('sha256').update(content).digest('hex'):fileHash(path)) !== commit.sha256) continue;
          cached = { content, sha256:commit.sha256, version: commit.file, size: statSync(path).size }; break;
        } catch { /* Ignore unfinished journal entries; preserve them. */ }
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async function stat() { load(); return cached ? { type: 'file', version: cached.version, size: cached.size } : undefined; }
  async function readText() {
    load();
    if (!cached) { const e = new Error('No committed snapshot'); e.code = 'ENOENT'; throw e; }
    return retainText?cached.content:readFileSync(join(root,cached.version),'utf8');
  }
  async function publish(content, expected) {
    load();
    if (expected?.kind === 'createIfAbsent' && cached) { const e = new Error('Snapshot already exists'); e.code = 'FS_NOT_OBSERVED'; throw e; }
    if (expected?.kind === 'replaceIfVersion' && cached?.version !== expected.version) { const e = new Error('Snapshot version changed'); e.code = 'FS_STALE_VERSION'; throw e; }
    const digest=createHash('sha256').update(content).digest('hex'),size=Buffer.byteLength(content,'utf8');
    if (cached?.sha256 === digest && cached.size===size) return compactReceipt?{operation:'unchanged',version:cached.version}:{ operation:'unchanged', version:cached.version, after:content, before:content };
    mkdirSync(root, { recursive:true });
    const file = new Date().toISOString().replaceAll(':','-') + '-' + randomUUID() + '.json';
    const fd = openSync(join(root,file),'wx');
    try { writeSync(fd,content,null,'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    const record = { file, sha256:digest, timestamp:new Date().toISOString() };
    const log = openSync(journal,'a');
    try { writeSync(log,'\n' + JSON.stringify(record) + '\n',null,'utf8'); fsyncSync(log); } finally { closeSync(log); }
    const operation=cached?'update':'create',previous=compactReceipt?undefined:cached?(retainText?cached.content:readFileSync(join(root,cached.version),'utf8')):null;
    cached = { content:retainText?content:undefined, sha256:digest, version:file, size };
    return compactReceipt?{operation,version:file}:{ operation, version:file, before:previous, after:content };
  }
  return { target:logicalPath, stat, readText, writeText(content,expected) {
    const run = tail.then(()=>publish(content,expected),()=>publish(content,expected));
    tail = run.then(()=>undefined,()=>undefined); return run;
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
