import {createReadStream,existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,statSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve,join,dirname,basename,relative,sep,parse} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requestLocalControl} from '../src/local-control.mjs';
import {normalizedPipe,registeredDataPath} from '../src/installation-record.mjs';

// This tool never constructs a snapshot storage or invokes retention. Its
// default operation reads only a bounded set of metadata and snapshot hashes.
const BASELINE='retention-baseline.json',ARCHIVED='retention-archived.json';
const FIXED=['galgame/companion.json.snapshots','galgame/storages/dsh-whale-galgame/global.json.snapshots'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeName=name=>typeof name==='string'&&/^[^/\\:\0]+\.json$/.test(name)&&![BASELINE,ARCHIVED].includes(name);
const same=(a,b)=>resolve(a).toLowerCase()===resolve(b).toLowerCase();
const inside=(root,path)=>{const r=relative(resolve(root),resolve(path));return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!parse(r).root;};
function fail(message,code='ARCHIVE_UNSAFE'){const e=Error(message);e.code=code;return e;}
function noLinks(path){for(let p=resolve(path);;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw fail('Linked paths are not allowed: '+p);if(dirname(p)===p)break;}return path;}
const day=t=>{const d=new Date(t);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const nameTime=name=>/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-/.test(name)?Date.parse(name.slice(0,24).replace(/T(\d\d)-(\d\d)-/,'T$1:$2:')):NaN;
async function fileHash(path){const h=createHash('sha256');for await(const b of createReadStream(noLinks(path)))h.update(b);return h.digest('hex');}
function journalRows(text){
 const rows=[],uncertainFiles=new Set();let offset=0,torn=0;
 for(const line of text.split(/(?<=\n)/)){const end=offset+Buffer.byteLength(line);if(line.trim())try{const c=JSON.parse(line);if(!safeName(c.file)||!(/^[a-f0-9]{64}$/i.test(c.sha256)))throw Error();rows.push({...c,_start:offset,_end:end});}catch{torn++;for(const m of line.matchAll(/"file"\s*:\s*("(?:[^"\\]|\\.)*")/g))try{const name=JSON.parse(m[1]);if(safeName(name))uncertainFiles.add(name);}catch{}}offset=end;}
 return {rows,torn,uncertainFiles};
}
const plainRecord=c=>Object.fromEntries(Object.entries(c).filter(([k])=>!k.startsWith('_')));
const counts=entries=>({files:entries.length,bytes:entries.reduce((n,c)=>n+c.bytes,0),entries});
function reportOutputPath(path,{dataRoot,archiveRoot,installationRoot}){
 const full=resolve(path),parts=full.split(/[\\/]/),name=basename(full);
 const protectedDirectory=/^(?:\.codex|\.ssh|\.gnupg|\.aws|\.azure|credentials|ep|plugin-runtimes|plugin-platform)$/i;
 const protectedFile=/^(?:auth\.json|credentials(?:\.json)?|installation\.json|current-build\.json|portable-defaults\.json|id_rsa|id_ed25519|\.env(?:\..*)?)$/i;
 if(parts.slice(0,-1).some(p=>protectedDirectory.test(p))||protectedFile.test(name))throw fail('Report output targets a protected directory or file');
 for(const root of [dataRoot,archiveRoot,installationRoot].filter(Boolean))if(same(root,full)||inside(root,full)||inside(full,root))throw fail('Report output must be outside installation, data, archive roots and their ancestors');
 return noLinks(full);
}
function atomic(path,body){noLinks(dirname(path));const temp=join(dirname(path),'.r14-'+randomUUID()+'.tmp');const fd=openSync(temp,'wx');try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);}
function discover(dataRoot){
 const found=new Set(FIXED),excluded=[];
 for(const entry of readdirSync(dataRoot,{withFileTypes:true}))if(entry.name.endsWith('.snapshots')&&(entry.isDirectory()||entry.isSymbolicLink())){
  if(/^(?:auth|credentials?|secrets?|private[-_]?keys?|ep)(?:[.-]|$)/i.test(entry.name)){excluded.push({relativePath:entry.name,reason:'protected-authentication-store-not-inspected'});continue;}
  found.add(entry.name);
 }
 return {stores:[...found].filter(p=>existsSync(join(dataRoot,p,BASELINE))).sort(),excluded};
}
async function inspectStore(dataRoot,rel){
 const root=noLinks(join(dataRoot,rel));if(!inside(dataRoot,root))throw fail('Store escaped data root');
 const journal=readFileSync(noLinks(join(root,'commits.jsonl')),'utf8'),baselineBytes=readFileSync(noLinks(join(root,BASELINE))),b=JSON.parse(baselineBytes);
 const alreadyArchived=existsSync(join(root,ARCHIVED));
 if(!Number.isFinite(b.backlogUntil)||!Number.isSafeInteger(b.journalBytes)||b.journalBytes<0||(!alreadyArchived&&b.journalBytes>Buffer.byteLength(journal)))throw fail('Invalid baseline: '+rel);
 const {rows,torn,uncertainFiles}=journalRows(journal),files=new Map(),reasons=new Map(),protectedFiles=new Set(),move=new Set();
 const note=(name,reason)=>{protectedFiles.add(name);const list=reasons.get(name)||[];if(!list.includes(reason))list.push(reason);reasons.set(name,list);};
 for(const entry of readdirSync(root,{withFileTypes:true})){
  if(entry.name===BASELINE||entry.name===ARCHIVED||!entry.name.endsWith('.json'))continue;
  if(entry.isSymbolicLink())throw fail('Linked snapshot: '+rel+'/'+entry.name);
  if(!entry.isFile())continue;const info=lstatSync(join(root,entry.name));files.set(entry.name,{file:entry.name,bytes:info.size,mtimeMs:info.mtimeMs});
 }
 for(const name of uncertainFiles)note(name,'uncertain-journal-reference');
 let latest=null;
 for(let n=rows.length-1;n>=0;n--){const c=rows[n];if(!files.has(c.file))continue;try{if(await fileHash(join(root,c.file))===c.sha256){latest=c;break;}}catch{}note(c.file,'invalid-latest-candidate');}
 if(!latest)throw fail('No valid latest commit: '+rel);
 note(latest.file,'latest-valid-commit');
 const groups=new Map(),referenced=new Set(rows.map(c=>c.file));
 for(const c of rows){
  const t=Date.parse(c.timestamp);
  if(c._end>b.journalBytes||t>b.backlogUntil){note(c.file,'after-baseline');continue;}
  if(!Number.isFinite(t)){note(c.file,'uncertain-commit-time');continue;}
  if(!files.has(c.file))continue;
  const key=day(t),group=groups.get(key)||[];group.push(c);groups.set(key,group);move.add(c.file);
 }
 const daily=[];
 for(const [date,group] of groups){
  group.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)||b._start-a._start);
  for(const c of group){if(await fileHash(join(root,c.file))===c.sha256){note(c.file,'daily-backlog:'+date);daily.push({date,file:c.file});break;}note(c.file,'uncertain-backlog-hash');}
 }
 for(const name of files.keys())if(!referenced.has(name)){
  const t=nameTime(name);if(torn)note(name,'orphan-journal-uncertain');else if(Number.isFinite(t)&&t<=b.backlogUntil)move.add(name);
  else note(name,Number.isFinite(t)?'orphan-after-baseline':'orphan-time-uncertain');
 }
 for(const name of protectedFiles)move.delete(name);
 if(alreadyArchived){for(const name of files.keys())note(name,'already-archived');move.clear();}
 const moving=[...move].sort().map(n=>files.get(n)),keeping=[...files].filter(([n])=>!move.has(n)).map(([,x])=>({...x,reasons:reasons.get(x.file)||['retained-conservatively']}));
 const journalAfter=rows.filter(c=>!move.has(c.file)).map(c=>JSON.stringify(plainRecord(c))+'\n').join('');
 return {relativePath:rel,status:alreadyArchived?'already-archived':'planned',baseline:b,tornJournalLines:torn,
  latest:{file:latest.file,sha256Before:latest.sha256,sha256After:null},daily,move:counts(moving),keep:counts(keeping),protectedFiles:[...protectedFiles].filter(n=>files.has(n)).sort(),sourceChangedDuringScan:readFileSync(join(root,'commits.jsonl'),'utf8')!==journal,
  _journal:journal,_journalAfter:journalAfter,_baseline:baselineBytes.toString('utf8')};
}

async function runtimeState(installationRoot,dataRoot){
 const path=noLinks(join(installationRoot,'local/installation.json'));
 let bytes,record;
 try{bytes=readFileSync(path);record=JSON.parse(bytes);if(record.schemaVersion!==1||!same(registeredDataPath(installationRoot,record.dataPath),dataRoot))throw Error('registered data root differs');}
 catch(e){return {state:'unverified',reason:'Installation identity unavailable: '+e.message};}
 const pipe=normalizedPipe(record.pipe),identitySha256=digest(bytes);
 let protocol=null,capabilityReason=null,packagePath=null,packageSha256=null,pointerSha256=null;
 try{
  if(typeof record.build!=='string'||!record.build||!inside(installationRoot,resolve(installationRoot,record.build)))throw Error('registered build path is outside installation');
  const pointerBytes=readFileSync(noLinks(join(installationRoot,'local/current-build.json'))),pointer=JSON.parse(pointerBytes);pointerSha256=digest(pointerBytes);
  if(typeof pointer.path!=='string'||!same(resolve(installationRoot,pointer.path),resolve(installationRoot,record.build)))throw Error('registered build and current pointer differ');
  packagePath=noLinks(join(installationRoot,record.build,'package.json'));const packageBytes=readFileSync(packagePath),pkg=JSON.parse(packageBytes);packageSha256=digest(packageBytes);
  protocol=pkg.offlineSnapshotArchiveProtocol??null;if(protocol!==1)throw Error('installed build must declare offlineSnapshotArchiveProtocol:1');
 }catch(e){capabilityReason='Offline archive capability unavailable: '+e.message;}
 const result={state:'stopped',pipe,identitySha256,version:record.version??null,processIds:[],offlineSnapshotArchiveProtocol:protocol,capabilityReason,packagePath,packageSha256,pointerSha256};
 if(existsSync(join(dataRoot,'runtime-instance.lock')))return {...result,state:'blocked',reason:'runtime-instance.lock exists; do not infer that a stale lock is safe'};
 try{
  const status=await requestLocalControl(pipe,{command:'installation-status'},{timeoutMs:1200});
  return {...result,state:'running',reason:same(status?.dataRoot??'',dataRoot)?'Registered application is running':'Runtime pipe is occupied or reports another identity',processIds:Number.isSafeInteger(status?.processId)?[status.processId]:[]};
 }catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))return {...result,state:'unverified',reason:'Runtime pipe state is uncertain: '+e.message};}
 if(process.platform==='win32'){
  // One process inventory, no WMI and no polling. The pipe can be unavailable
  // while Electron is starting, so absence of a pipe alone is insufficient.
  try{
   const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($env:AI_BUDDY_ARCHIVE_INSTALL_ROOT + '\\',[System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress"],{windowsHide:true,timeout:10000,env:{...process.env,AI_BUDDY_ARCHIVE_INSTALL_ROOT:installationRoot}});
   const ids=stdout.trim()?JSON.parse(stdout):[];result.processIds=Array.isArray(ids)?ids:[ids];
   if(result.processIds.length)return {...result,state:'running',reason:'An installed application process is still present'};
  }catch(e){return {...result,state:'unverified',reason:'Process identity could not be checked: '+e.message};}
 }
 return result;
}
async function offlineLease(runtime,installationRoot,dataRoot){
 if(runtime.state!=='stopped')throw fail('Apply blocked: '+(runtime.reason??runtime.state),'ARCHIVE_APP_NOT_STOPPED');
 if(runtime.offlineSnapshotArchiveProtocol!==1||runtime.capabilityReason)throw fail('Apply blocked: '+(runtime.capabilityReason??'installed build requires offlineSnapshotArchiveProtocol:1'),'ARCHIVE_PROTOCOL_REQUIRED');
 const server=createServer(socket=>socket.destroy());
 try{await new Promise((yes,no)=>{server.once('error',no);server.listen(runtime.pipe,yes);});}catch(e){server.close();throw fail('Runtime pipe could not be reserved: '+e.message,'ARCHIVE_APP_NOT_STOPPED');}
 const check=()=>{
  if(existsSync(join(dataRoot,'runtime-instance.lock'))||digest(readFileSync(noLinks(join(installationRoot,'local/installation.json'))))!==runtime.identitySha256||digest(readFileSync(noLinks(join(installationRoot,'local/current-build.json'))))!==runtime.pointerSha256||digest(readFileSync(noLinks(runtime.packagePath)))!==runtime.packageSha256)throw fail('Runtime, installation identity, or offline archive capability changed','ARCHIVE_APP_NOT_STOPPED');
 };
 return {check,close:()=>new Promise(r=>server.close(r))};
}
function transactionPath(archiveRoot,rel){return join(archiveRoot,rel,'.r14-transaction.json');}
async function applyStore(dataRoot,archiveRoot,rel,lease,{checkpoint=()=>{}}={}){
 const root=noLinks(join(dataRoot,rel)),destination=noLinks(join(archiveRoot,rel)),txPath=transactionPath(archiveRoot,rel);let tx;
 if(existsSync(txPath)){
  tx=JSON.parse(readFileSync(noLinks(txPath),'utf8'));
  if(tx.schemaVersion!==1||!same(tx.dataRoot,dataRoot)||!same(tx.archiveRoot,archiveRoot)||tx.relativePath!==rel||!Array.isArray(tx.store?.move?.entries)||tx.store.move.entries.some(c=>!safeName(c.file))||!Array.isArray(tx.store?.protectedFiles)||tx.store.protectedFiles.some(n=>!safeName(n))||tx.planSha256!==digest(JSON.stringify(tx.store)))throw fail('Invalid archive recovery transaction');
  if(tx.phase==='complete'){const result=await inspectStore(dataRoot,rel);result.status='already-archived';return result;}
 }else{
  const store=await inspectStore(dataRoot,rel);if(store.status!=='planned')return store;if(store.sourceChangedDuringScan)throw fail('Journal changed while planning');
  lease.check();
  for(const item of store.move.entries)if(existsSync(join(destination,item.file)))throw fail('Archive destination already exists: '+item.file);
  mkdirSync(destination,{recursive:true});noLinks(destination);
  tx={schemaVersion:1,id:randomUUID(),phase:'prepared',dataRoot,archiveRoot,relativePath:rel,store,planSha256:digest(JSON.stringify(store))};
  atomic(txPath,JSON.stringify(tx));
 }
 lease.check();
 const store=tx.store,journalPath=join(root,'commits.jsonl'),current=readFileSync(noLinks(journalPath),'utf8');
 if(readFileSync(noLinks(join(root,BASELINE)),'utf8')!==store._baseline)throw fail('Baseline changed since archive planning');
 if(current!==store._journal&&current!==store._journalAfter)throw fail('Journal changed since the archive plan; retain files and investigate the saved transaction');
 if(await fileHash(join(root,store.latest.file))!==store.latest.sha256Before)throw fail('Latest snapshot changed before archive');
 for(const item of store.move.entries){
  const source=noLinks(join(root,item.file)),target=noLinks(join(destination,item.file));
  if(existsSync(source)){const s=lstatSync(source);if(!s.isFile()||s.size!==item.bytes||s.mtimeMs!==item.mtimeMs)throw fail('Snapshot changed since archive plan: '+item.file);if(existsSync(target))throw fail('Both archive and source exist: '+item.file);}
  else if(!existsSync(target)||lstatSync(target).size!==item.bytes)throw fail('Archive recovery file is missing: '+item.file);
 }
 // Publish and fsync protection before shortening the journal. Otherwise the
 // old baseline byte offset could hide retained commits from a resumed prune,
 // which would then mistake their aged snapshot files for unprotected orphans.
 const marker={schemaVersion:1,id:tx.id,at:new Date().toISOString(),latest:{file:store.latest.file,sha256:store.latest.sha256Before},protectedFiles:[...new Set([...store.protectedFiles,...store.move.entries.map(c=>c.file)])],archivePending:true,archiveRoot:destination};
 lease.check();atomic(join(root,ARCHIVED),JSON.stringify(marker));tx.phase='protected';atomic(txPath,JSON.stringify(tx));checkpoint('protected-marker-published');
 // Readers stop referencing files before any rename, while the pending marker
 // protects both the retained set and every archive rename still outstanding.
 lease.check();if(current!==store._journalAfter)atomic(journalPath,store._journalAfter);
 tx.phase='moving';atomic(txPath,JSON.stringify(tx));checkpoint('journal-published');
 for(const item of store.move.entries){lease.check();const source=join(root,item.file),target=join(destination,item.file);if(existsSync(source))renameSync(source,target);checkpoint('file-moved');}
 const after=await fileHash(join(root,store.latest.file));if(after!==store.latest.sha256Before)throw fail('Latest snapshot changed after archive');
 marker.protectedFiles=store.protectedFiles;marker.archivePending=false;atomic(join(root,ARCHIVED),JSON.stringify(marker));
 tx.phase='complete';store.latest.sha256After=after;store.status='archived';tx.planSha256=digest(JSON.stringify(store));atomic(txPath,JSON.stringify(tx));return store;
}

async function deltaReference(path){
 const handle=await open(noLinks(path),'r');try{
  const info=await handle.stat(),length=Math.min(info.size,65536),buffer=Buffer.alloc(length);await handle.read(buffer,0,length,info.size-length);
  const text=buffer.toString('utf8'),match=text.match(/"deltaFile"\s*:\s*("(?:[^"\\]|\\.)*")\s*}\s*$/);
  if(!match)return {name:null,uncertain:!text.trimEnd().endsWith('}')};
  const name=JSON.parse(match[1]);if(typeof name!=='string'||!/^monitor-deltas[^/\\:\0]*\.jsonl$/.test(name))return {name:null,uncertain:true};
  return {name,uncertain:false};
 }finally{await handle.close();}
}
async function inspectUsage(dataRoot){
 const retained=[],candidates=[],references=new Set(),uncertain=[];let latest=null;
 for(const version of ['v003','v004','v005']){
  const rel=`monitor-index-${version}.json.snapshots`,root=join(dataRoot,rel);if(!existsSync(root))continue;noLinks(root);
  let files=0,bytes=0;
  const names=readdirSync(root);for(const name of names){const path=noLinks(join(root,name)),s=lstatSync(path);if(s.isFile()){files++;bytes+=s.size;}}
  retained.push({relativePath:rel,files,bytes,reason:version==='v004'?'migration-and-downgrade-fallback':version==='v003'?'old-downgrade-dependency-not-proven-unused':'current-and-historical-v005-indexes'});
  if(version==='v003')continue;
  for(const name of names){if(!safeName(name))continue;const path=join(root,name);if(!lstatSync(path).isFile())continue;
   const ref=await deltaReference(path);if(ref.name)references.add(ref.name);if(ref.uncertain)uncertain.push(rel+'/'+name);
  }
  if(version==='v005'){
   let text;try{text=readFileSync(noLinks(join(root,'commits.jsonl')),'utf8');}catch(e){uncertain.push(rel+'/commits.jsonl');continue;}
   for(const c of journalRows(text).rows.reverse()){const path=join(root,c.file);if(!existsSync(path))continue;
    if(await fileHash(path)!==c.sha256)continue;const ref=await deltaReference(path);if(!ref.name)uncertain.push(rel+'/'+c.file+':missing-delta-reference');
    latest={file:c.file,sha256:c.sha256,deltaFile:ref.name};break;
   }
  }
 }
 for(const entry of readdirSync(dataRoot,{withFileTypes:true})){
  if(!/^monitor-deltas[^/\\:\0]*\.jsonl$/.test(entry.name))continue;
  const path=noLinks(join(dataRoot,entry.name)),s=lstatSync(path);if(!s.isFile())throw fail('Monitor delta is not a regular file');
  const item={relativePath:entry.name,files:1,bytes:s.size};let reason;
  if(references.has(entry.name))reason='referenced-by-retained-index';
  else if(/^monitor-deltas-v005-\d+\.jsonl$/.test(entry.name))reason='fallback-orphan-recovery';
  else if(!/^monitor-deltas-v005-\d+-[a-f0-9-]{36}\.jsonl$/i.test(entry.name))reason='older-downgrade-format';
  else if(!latest||uncertain.length)reason='index-reference-uncertain';
  if(reason)retained.push({...item,reason});else candidates.push({...item,reason:'not-referenced-and-not-consumed-by-fallback-recovery'});
 }
 return {status:latest&&!uncertain.length?'planned':'conservative-retain',latest,uncertainReferences:uncertain,retained,candidates,
  candidateBytes:candidates.reduce((n,x)=>n+x.bytes,0),note:'B2 is report-only. Current migration reads v005, falls back to v004, and can recover numeric v005 orphan deltas; rollback export recreates v005 from SQLite. v003 and v004 remain for unverified older downgrade readers. No delta body or SQLite database was opened.'};
}

export async function archiveSnapshotBacklog({dataRoot,archiveRoot,installationRoot,apply=false,confirmStopped=false,includeUsage=true,checkpoint}={}){
 if(!dataRoot||!archiveRoot||!installationRoot)throw fail('dataRoot, archiveRoot and installationRoot are required');
 dataRoot=noLinks(resolve(dataRoot));archiveRoot=noLinks(resolve(archiveRoot));installationRoot=noLinks(resolve(installationRoot));
 if(same(dataRoot,archiveRoot)||inside(dataRoot,archiveRoot)||inside(archiveRoot,dataRoot))throw fail('Archive and data must be disjoint');
 if(parse(dataRoot).root.toLowerCase()!==parse(archiveRoot).root.toLowerCase())throw fail('Archive must be on the same volume');
 let archiveParent=archiveRoot;while(!existsSync(archiveParent)&&dirname(archiveParent)!==archiveParent)archiveParent=dirname(archiveParent);
 if(statSync(dataRoot).dev!==statSync(archiveParent).dev)throw fail('Archive must be on the same filesystem');
 if(basename(archiveRoot)!=='disk-r14-20261108'||basename(dirname(archiveRoot))!=='delete')throw fail('Archive root must be an explicit delete/disk-r14-20261108 directory');
 const runtime=await runtimeState(installationRoot,dataRoot);if(apply&&!confirmStopped)throw fail('Apply requires --confirm-stopped after a normal application exit');
 const lease=apply?await offlineLease(runtime,installationRoot,dataRoot):null;
 let discovered;const stores=[];try{discovered=discover(dataRoot);for(const rel of discovered.stores){try{stores.push(apply?await applyStore(dataRoot,archiveRoot,rel,lease,{checkpoint}):await inspectStore(dataRoot,rel));}catch(e){if(apply)throw e;stores.push({relativePath:rel,status:'blocked',reason:e.message,move:{files:0,bytes:0},keep:{files:null,bytes:null}});}}}finally{await lease?.close();}
 const usage=includeUsage?await inspectUsage(dataRoot):null;
 const report={schemaVersion:1,mode:apply?'apply':'dry-run',at:new Date().toISOString(),dataRoot,archiveRoot,installationRoot,localTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,runtime,applyAllowed:runtime.state==='stopped'&&runtime.offlineSnapshotArchiveProtocol===1&&!runtime.capabilityReason&&!stores.some(s=>s.status==='blocked'||s.sourceChangedDuringScan),stores,excludedStores:discovered.excluded,usage};
 for(const s of stores)for(const k of Object.keys(s))if(k.startsWith('_'))delete s[k];
 return report;
}

export function renderArchiveReport(report){
 const n=x=>typeof x==='number'?x.toLocaleString('en-US'):'unknown';
 const lines=[`# R14 snapshot archive ${report.mode}`,'',`- Mode: ${report.mode}; generated: ${report.at}; local day zone: ${report.localTimeZone}.`,`- Data root: \`${report.dataRoot}\`.`,`- Destination: \`${report.archiveRoot}\`.`,`- Runtime: ${report.runtime.state}. Apply ${report.applyAllowed?'eligible only after a fresh offline check and --confirm-stopped':'BLOCKED'}${report.runtime.reason?': '+report.runtime.reason:'.'}`,report.mode==='dry-run'?'- Dry-run never creates locks, snapshots, retention markers, journals, or destination data. Production was not moved or deleted.':'- Apply moves only the listed B1 files. Review the transaction and latest before/after hashes below.','- A same-volume move does not free disk space. User deletion of the reviewed archive is a separate action.','', '| Store | State | Move files | Move bytes | Keep files | Keep bytes |','|---|---|---:|---:|---:|---:|'];
 for(const s of report.stores){lines.push(`| ${s.relativePath} | ${s.status} | ${n(s.move.files)} | ${n(s.move.bytes)} | ${n(s.keep.files)} | ${n(s.keep.bytes)} |`);}
 lines.push('',`- Installed offlineSnapshotArchiveProtocol: ${report.runtime.offlineSnapshotArchiveProtocol??'not declared'}.`);if(report.runtime.capabilityReason)lines.push('- Apply capability gate: '+report.runtime.capabilityReason);
 for(const excluded of report.excludedStores??[])lines.push(`- Excluded without opening contents: \`${excluded.relativePath}\` (${excluded.reason}).`);
 for(const s of report.stores){lines.push('',`## ${s.relativePath}`,'');if(s.reason){lines.push('Retained: '+s.reason);continue;}if(s.latest){lines.push(`- Latest valid commit: \`${s.latest.file}\`.`,`- SHA256 before: \`${s.latest.sha256Before}\`.`,`- SHA256 after: ${s.latest.sha256After?'`'+s.latest.sha256After+'`':'not applicable; dry-run performed no mutation'}.`);}
  if(s.sourceChangedDuringScan)lines.push('- Journal changed during live inventory. This report is not an executable plan; re-run offline before apply.');
  if(s.daily.length)lines.push('- Daily backlog files retained: '+s.daily.length+'.');
  const uncertain=(s.keep.entries??[]).filter(x=>x.reasons.some(r=>/uncertain|invalid/.test(r)));for(const item of uncertain)lines.push(`- Retained uncertain file: \`${item.file}\` (${item.reasons.join(', ')}).`);
 }
 if(report.usage){const u=report.usage;lines.push('','## B2 usage monitoring','',u.note,'',`State: ${u.status}; candidate bytes: ${n(u.candidateBytes)}. B2 remains report-only, including when B1 apply is requested.`,'','| Path | Decision | Bytes | Reason |','|---|---|---:|---|');for(const [items,decision] of [[u.retained,'retain'],[u.candidates,'candidate']])for(const x of items)lines.push(`| ${x.relativePath} | ${decision} | ${n(x.bytes)} | ${x.reason} |`);for(const x of u.uncertainReferences)lines.push('- Uncertain reference; retained conservatively: '+x);}
 lines.push('','## Offline apply and recovery','', '- Run only after user approval and normal application exit, with `--apply --confirm-stopped`. A registered identity mismatch, existing runtime lock, occupied or uncertain pipe, installed process, or installed build without offlineSnapshotArchiveProtocol:1 blocks apply. Do not launch an old build concurrently.','- The tool reserves the application pipe, seals a recovery transaction in the archive, and first fsyncs a pending marker protecting all retained and to-be-moved files. Only then does it atomically shorten the journal and rename archive files. The final marker narrows protection to the permanent retained set.','- If interrupted, the latest valid commit remains readable even after runtime prune. Re-run the same approved command offline to resume the sealed transaction; a changed journal or damaged transaction stops recovery without moving more files.','- The original journal and plan remain in `.r14-transaction.json` under the archive store. No overwrite or disk reclamation is performed.','');return lines.join('\n');
}
async function cli(){
 const args=process.argv.slice(2),options={},output={};
 for(let i=0;i<args.length;i++){
  const flag=args[i];if(flag==='--help'){console.log('Usage: node tools/archive-snapshot-backlog.mjs --data-root PATH --archive-root PATH --installation-root PATH [--report-json PATH] [--report-md PATH] [--apply --confirm-stopped] [--no-usage]');return;}
  if(flag==='--apply'){options.apply=true;continue;}if(flag==='--confirm-stopped'){options.confirmStopped=true;continue;}if(flag==='--no-usage'){options.includeUsage=false;continue;}
  const key={'--data-root':'dataRoot','--archive-root':'archiveRoot','--installation-root':'installationRoot','--report-json':'json','--report-md':'md'}[flag];
  if(!key||!args[i+1]||args[i+1].startsWith('--'))throw fail('Unknown option or missing value: '+flag);
  (['json','md'].includes(key)?output:options)[key]=args[++i];
 }
 for(const path of Object.values(output))reportOutputPath(path,options);
 const report=await archiveSnapshotBacklog(options);
 for(const [type,path] of Object.entries(output)){
  const full=reportOutputPath(path,report);
  mkdirSync(dirname(full),{recursive:true});atomic(full,(type==='json'?JSON.stringify(report,null,2)+'\n':renderArchiveReport(report)).replace(/\r?\n/g,'\r\n'));
 }
 console.log(JSON.stringify({mode:report.mode,runtime:report.runtime.state,offlineSnapshotArchiveProtocol:report.runtime.offlineSnapshotArchiveProtocol,applyAllowed:report.applyAllowed,stores:report.stores.map(s=>({path:s.relativePath,status:s.status,moveFiles:s.move.files,moveBytes:s.move.bytes,keepFiles:s.keep.files})),usageCandidateBytes:report.usage?.candidateBytes??0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli().catch(e=>{console.error(e.code+': '+e.message);process.exitCode=1;});
