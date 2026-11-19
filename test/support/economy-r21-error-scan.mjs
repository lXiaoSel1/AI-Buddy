import {readFile} from 'node:fs/promises';
import {relative,resolve} from 'node:path';
import {build} from 'esbuild';

const projectRoot=resolve(import.meta.dirname,'../..');
const fromSrc=path=>resolve(projectRoot,'src',path);
// The trusted archive is loaded through a runtime URL. Its local rule-engine
// counterpart is an explicit graph root; caller admission is also covered.
const roots=[fromSrc('companion-economy-worker.mjs'),fromSrc('voice-games/rules/index.mjs'),
 fromSrc('companion-economy-worker-client.mjs'),fromSrc('companion-feeding.mjs')];
const relativePath=path=>relative(projectRoot,path).replaceAll('\\','/');
const literal=arg=>/^(['"])([A-Z][A-Z0-9_]+)\1$/.exec(arg.trim())?.[2];
// Prompt projection/model errors share a transitive import with the rule
// engine, but never validate a worker write or a lost-write receipt.
const nonEconomyCodes=new Map([
 ['GAME_CHAT_PROJECTION_DENIED','Public chat model projection only.'],
 ['GAME_MODEL_CARD_ENCODING','Model-facing card encoding only.'],
 ['GAME_MODEL_FORMAT','Untrusted model response parsing only.'],
 ['GAME_MODEL_MANAGEMENT_DATA_DENIED','Model prompt information boundary only.'],
 ['GAME_MODEL_PROJECTION_DENIED','Private model projection only.'],
 ['GAME_REPLAY_PROJECTION_DENIED','Post-settlement model review only.']
].map(([code,reason])=>['src/voice-games/prompts.mjs\0'+code,reason]));

const allowedDirectErrors=new Map([
 ['src/local-day.mjs\0\'Invalid local date\'','Invalid host clock fails closed before a day can be assigned.'],
 ['src/companion-economy-store.mjs\0\'经济资料目录须为绝对路径\'','Store-open path precondition, before a write is admitted.'],
 ['src/companion-economy-store.mjs\0\'重试批量无效\'','Read-only pending-meal pagination input.'],
 ['src/companion-economy-store.mjs\0\'积分流水分页无效\'','Read-only ledger pagination input.'],
 ['src/companion-feeding.mjs\0\'进食请求超时设置无效\'','Service startup configuration, before a request is admitted.'],
 ['src/companion-feeding.mjs\0\'饥饿计时器无效\'','Invalid monotonic clock fails closed before feeding work.'],
 ['src/companion-feeding.mjs\0\'投喂服务已经关闭\'','Closed-service admission fence; no write is submitted.']
]);

function argumentsAt(source,start){
 const args=[];let depth=0,begin=start,quote=null,escaped=false;
 for(let i=start;i<source.length;i++){
  const c=source[i];
  if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote=null;continue;}
  if(c==='\''||c==='"'||c==='`'){quote=c;continue;}
  if(c==='('||c==='['||c==='{'){depth++;continue;}
  if(c===')'||c===']'||c==='}'){
   if(c===')'&&depth===0){args.push(source.slice(begin,i).trim());return args;}
   depth--;continue;
  }
  if(c===','&&depth===0){args.push(source.slice(begin,i).trim());begin=i+1;}
 }
 throw Error('Unbalanced error call in scanned source');
}
function lineAt(source,index){return source.slice(0,index).split('\n').length;}

export async function scanEconomyErrorCodes({entryPoints=roots,sourceOverrides=new Map()}={}){
 const overrides=new Map([...sourceOverrides].map(([path,source])=>[resolve(path),source]));
 const graph=await build({absWorkingDir:projectRoot,entryPoints,bundle:true,write:false,metafile:true,outdir:resolve(projectRoot,'r21-scan-output'),
  platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'source-overlay',setup(api){
   api.onLoad({filter:/\.[cm]?js$/},args=>overrides.has(resolve(args.path))?{contents:overrides.get(resolve(args.path)),loader:'js'}:null);
  }}]});
 const paths=Object.keys(graph.metafile.inputs).map(path=>resolve(projectRoot,path));
 const files=paths.map(relativePath).sort(),codes=new Set(),uncoded=[];
 for(const path of paths){
  const name=relativePath(path),source=overrides.get(path)??await readFile(path,'utf8');
  const addCode=code=>{if(!nonEconomyCodes.has(name+'\0'+code))codes.add(code);};
  for(const match of source.matchAll(/\bcode\s*:\s*(['"])([A-Z][A-Z0-9_]+)\1/g))addCode(match[2]);
  for(const match of source.matchAll(/\bfail\s*\(/g)){
   const args=argumentsAt(source,match.index+match[0].length);
   const code=args.map(literal).find(Boolean);
   if(code)addCode(code);
   else uncoded.push(`${name}:${lineAt(source,match.index)}:fail without stable code`);
  }
  for(const match of source.matchAll(/\bthrow\s+(?:new\s+)?Error\s*\(/g)){
   const argument=argumentsAt(source,match.index+match[0].length)[0];
   if(!allowedDirectErrors.has(name+'\0'+argument))uncoded.push(`${name}:${lineAt(source,match.index)}:direct Error(${argument})`);
  }
 }
 return {files,codes:[...codes].sort(),uncoded:uncoded.sort(),exceptions:allowedDirectErrors};
}
