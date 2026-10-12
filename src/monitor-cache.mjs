import {createReadStream} from 'node:fs';
import {readdir,stat} from 'node:fs/promises';
import {basename,join} from 'node:path';

// A checkpoint and its file offsets are one transaction. Reject an incomplete
// delta before applying either half; a damaged tail is replayed from the logs.
export function validMonitorDelta(row){
  const entries=(xs,predicate)=>Array.isArray(xs)&&xs.every(x=>Array.isArray(x)&&x.length===2&&typeof x[0]==='string'&&predicate(x[1]));
  return row?.version===1&&row.ledger&&['sessions','codex','claude'].every(k=>entries(row.ledger[k],v=>v&&typeof v==='object'&&(k==='sessions'||v.usage&&v.session)))&&entries(row.files,v=>v&&Number.isSafeInteger(v.offset)&&v.offset>=0&&Number.isFinite(v.size)&&v.size>=v.offset);
}

// Legacy writers serialized an entire index as ONE JSONL line. Decode its four
// entry arrays incrementally instead of building/flattening a 230 MB string.
// Keep a transaction's entries until its closing brace is validated, so a broken
// record can never publish file positions without the matching usage data.
export async function* monitorDeltaRows(path){
  const headers=[/^\s*\{\s*"version"\s*:\s*1\s*,\s*"ledger"\s*:\s*\{\s*(?:"version"\s*:\s*1\s*,\s*)?"sessions"\s*:\s*\[/,
    /^\s*,\s*"codex"\s*:\s*\[/,/^\s*,\s*"claude"\s*:\s*\[/,/^\s*\}\s*,\s*"files"\s*:\s*\[/];
  let buffer='',stage=0,row=null,scan=0,depth=0,quoted=false,escaped=false,comma=false,afterComma=false;
  const resetEntry=()=>{scan=0;depth=0;quoted=false;escaped=false;};
  function* drain(eof=false){
    while(true){
      if(stage===-1){const n=buffer.indexOf('\n');if(n<0){buffer='';return;}buffer=buffer.slice(n+1);stage=0;}
      if(stage===0){buffer=buffer.trimStart();if(!buffer)return;}
      if([0,2,4,6].includes(stage)){
        const match=buffer.match(headers[stage/2]);
        if(match){if(stage===0)row={version:1,ledger:{sessions:[],codex:[],claude:[]},files:[]};buffer=buffer.slice(match[0].length);stage++;comma=false;afterComma=false;resetEntry();continue;}
        if(!eof&&buffer.length<1024&&!buffer.includes('\n'))return;
      }else if([1,3,5,7].includes(stage)){
        if(!scan){
          buffer=buffer.replace(/^[ \t\r]*/,'');if(!buffer){if(!eof)return;}
          else if(buffer[0]===']'&&!afterComma){buffer=buffer.slice(1);stage++;continue;}
          else if(comma&&buffer[0]===','){buffer=buffer.slice(1);comma=false;afterComma=true;continue;}
          else if(comma||buffer[0]!=='['){stage=-1;row=null;yield {invalid:true};continue;}
        }
        let complete=false,bad=false;
        for(;scan<buffer.length;scan++){
          const c=buffer[scan];if(c==='\n'){bad=true;break;}
          if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
          if(c==='"')quoted=true;else if(c==='['||c==='{')depth++;else if(c===']'||c==='}'){
            depth--;if(depth===0){
              try{const entry=JSON.parse(buffer.slice(0,scan+1));(stage===7?row.files:row.ledger[['sessions','codex','claude'][(stage-1)/2]]).push(entry);}catch{bad=true;break;}
              buffer=buffer.slice(scan+1);resetEntry();comma=true;afterComma=false;complete=true;break;
            }
          }
        }
        if(complete)continue;
        if(!bad&&!eof&&buffer.length<=8*1024*1024)return;
      }else if(stage===8){
        const match=buffer.match(/^[ \t\r]*\}/);if(match){buffer=buffer.slice(match[0].length);stage=9;continue;}
        if(!eof&&!buffer.includes('\n')&&buffer.length<1024)return;
      }else if(stage===9){
        buffer=buffer.replace(/^[ \t\r]*/,'');
        if(buffer[0]==='\n'||eof&&!buffer){if(buffer[0]==='\n')buffer=buffer.slice(1);const ready=row;row=null;stage=0;yield {row:ready};continue;}
        if(!buffer&&!eof)return;
      }
      stage=-1;row=null;resetEntry();yield {invalid:true};
    }
  }
  for await(const chunk of createReadStream(path,{encoding:'utf8',highWaterMark:65536})){buffer+=chunk;yield* drain();}
  yield* drain(true);
}

export async function replayMonitorDelta(dataRoot,name,ledger,files){
  if(typeof name!=='string'||basename(name)!==name||!/^[\w-]+\.jsonl$/.test(name))throw Error('Invalid monitor checkpoint filename');
  let bytes=0,rows=0,invalid=0;
  try{
    // Read byte size from the file metadata. Old releases wrote 230 MB JSON
    // lines; Buffer.byteLength on those strings triggers Electron/V8's fast API
    // lazy-deopt abort and needlessly scans every decoded character a second time.
    bytes=(await stat(join(dataRoot,name))).size;
    for await(const decoded of monitorDeltaRows(join(dataRoot,name))){
      const row=decoded.row;
      if(!validMonitorDelta(row)){invalid++;continue;}
      for(const kind of ['sessions','codex','claude'])for(const [key,value] of row.ledger[kind])ledger[kind].set(key,value);
      for(const [key,value] of row.files)files.set(key,value);rows++;
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return {bytes,rows,invalid};
}

export async function orphanMonitorDeltas(dataRoot){
  // Only v005 deltas have offsets from the current parser. v004 offsets must
  // still be rescanned when no v005 recovery data exists.
  try{return (await readdir(dataRoot)).filter(n=>/^monitor-deltas-v005-\d+\.jsonl$/.test(n)).sort((a,b)=>Number(a.match(/(\d+)\.jsonl$/)[1])-Number(b.match(/(\d+)\.jsonl$/)[1]));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
}
