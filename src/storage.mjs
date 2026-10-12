import { mkdirSync, readdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// Snapshot publication is additive. Completed snapshots are committed in an
// append-only journal; interrupted writes remain on disk and are never cleaned.
export function createSnapshotStorage(logicalPath) {
  const root = resolve(dirname(logicalPath), basename(logicalPath) + '.snapshots');
  const journal = join(root, 'commits.jsonl');
  let cached = null, loaded = false, tail = Promise.resolve();
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const lines = readFileSync(journal, 'utf8').split('\n');
      for (let n = lines.length - 1; n >= 0; n--) {
        try {
          const commit = JSON.parse(lines[n]);
          if (basename(commit.file) !== commit.file) continue;
          const content = readFileSync(join(root, commit.file), 'utf8');
          if (createHash('sha256').update(content).digest('hex') !== commit.sha256) continue;
          cached = { content, version: commit.file, size: statSync(join(root,commit.file)).size }; break;
        } catch { /* Ignore unfinished journal entries; preserve them. */ }
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async function stat() { load(); return cached ? { type: 'file', version: cached.version, size: cached.size } : undefined; }
  async function readText() {
    load();
    if (!cached) { const e = new Error('No committed snapshot'); e.code = 'ENOENT'; throw e; }
    return cached.content;
  }
  async function publish(content, expected) {
    load();
    if (expected?.kind === 'createIfAbsent' && cached) { const e = new Error('Snapshot already exists'); e.code = 'FS_NOT_OBSERVED'; throw e; }
    if (expected?.kind === 'replaceIfVersion' && cached?.version !== expected.version) { const e = new Error('Snapshot version changed'); e.code = 'FS_STALE_VERSION'; throw e; }
    if (cached?.content === content) return { operation:'unchanged', version:cached.version, after:content, before:content };
    mkdirSync(root, { recursive:true });
    const file = new Date().toISOString().replaceAll(':','-') + '-' + randomUUID() + '.json';
    const fd = openSync(join(root,file),'wx');
    try { writeSync(fd,content,null,'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    const record = { file, sha256:createHash('sha256').update(content).digest('hex'), timestamp:new Date().toISOString() };
    const log = openSync(journal,'a');
    try { writeSync(log,'\n' + JSON.stringify(record) + '\n',null,'utf8'); fsyncSync(log); } finally { closeSync(log); }
    const previous = cached?.content ?? null;
    cached = { content, version:file, size:statSync(join(root,file)).size };
    return { operation:previous === null ? 'create':'update', version:file, before:previous, after:content };
  }
  return { target:logicalPath, stat, readText, writeText(content,expected) {
    const run = tail.then(()=>publish(content,expected),()=>publish(content,expected));
    tail = run.catch(()=>{}); return run;
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
