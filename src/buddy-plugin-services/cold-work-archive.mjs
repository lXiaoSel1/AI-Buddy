import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,mkdir} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {writeAtomic} from '../atomic-write.mjs';
import {workEvidenceHash,validateWorkEvidence} from '../companion-life-archive.mjs';
import {contextFailure} from './trusted-context.mjs';

const active=new Set(['queued','running','waiting-for-user','cancelling']);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const validTask=/^task-[a-zA-Z0-9-]{1,100}$/;
async function noLinks(path){
  let cursor=resolve(path);for(;;){try{const info=await lstat(cursor);if(info.isSymbolicLink())throw contextFailure('Archive path contains a link','BUDDY_ARCHIVE_PATH_DENIED');}catch(error){if(error.code!=='ENOENT')throw error;}const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
}
function readJournal(text,id){
  let task=null,sequence=0,previous=null;
  try{for(const line of text.split('\n')){
    if(!line.trim())continue;const record=JSON.parse(line),{sha256,...body}=record;
    if(body.version!==1||body.taskId!==id||body.sequence!==sequence+1||body.previous!==previous||sha256!==hash(body))throw Error('journal hash/sequence mismatch');
    if(body.type==='created'){if(task)throw Error('duplicate creation');task={...structuredClone(body.payload),events:[]};}
    else{if(!task)throw Error('missing creation');if(body.type==='patch')Object.assign(task,structuredClone(body.payload));else if(body.type==='event')task.events.push({...structuredClone(body.payload),sequence:body.sequence,at:body.at});else throw Error('unknown journal record');}
    sequence=body.sequence;previous=sha256;task.revision=sequence;task.updatedAt=body.at;
  }if(!task||task.id!==id)throw Error('missing task identity');return task;}
  catch(error){throw contextFailure('Cannot archive damaged task '+id+': '+error.message,'BUDDY_ARCHIVE_CORRUPT');}
}
function normalizedRestore(source,{characterId,lifeId,operationId,transactionId,sha256}){
  const task=structuredClone(source),id='task-'+hash([transactionId,source.id]).slice(0,40);
  return {...task,id,scope:{...task.scope,characterId,lifeId,operationId},status:'paused-recoverable',sessionId:null,archivedNativeSessionId:task.sessionId??task.archivedNativeSessionId??null,pendingRequests:[],restoredSessionPending:true,restorationComplete:false,originalCreatedAt:task.originalCreatedAt??task.createdAt,restoredFrom:{taskId:source.id,transactionId,sha256},outcomeUnknown:task.outcomeUnknown===true||active.has(task.status),recoveryReason:'cold-life-restore'};
}
/** Data only: this module never imports a task service, engine, queue or process API. */
export function createColdWorkArchiveBridge({legacyRoot,pendingRoot,readPluginEvidence=null,isPendingImported=null,isBusy=()=>false}={}){
  if(!isAbsolute(legacyRoot??'')||!isAbsolute(pendingRoot??''))throw contextFailure('Cold archive roots must be absolute','BUDDY_ARCHIVE_PATH_DENIED');
  legacyRoot=resolve(legacyRoot);pendingRoot=resolve(pendingRoot);let tail=Promise.resolve();
  function assertIdle(characterId){const busy=isBusy(characterId);if(busy&&typeof busy.then==='function')throw contextFailure('Archive busy check must be synchronous','BUDDY_ARCHIVE_BUSY');if(busy)throw contextFailure('Pause active character work before archiving','AGENT_LIFE_BUSY');}
  async function legacyTasks(scope){
    await noLinks(legacyRoot);let entries;try{entries=await readdir(legacyRoot,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const tasks=[];for(const entry of entries){if(!validTask.test(entry.name))continue;if(entry.isSymbolicLink())throw contextFailure('Task archive entry is a link','BUDDY_ARCHIVE_PATH_DENIED');if(!entry.isDirectory())continue;
      const path=join(legacyRoot,entry.name,'events.jsonl');await noLinks(path);const task=readJournal(await readFile(path,'utf8'),entry.name);
      if(task.scope?.characterId===scope.characterId&&task.scope?.lifeId===scope.lifeId&&(!scope.operationId||task.scope.operationId===scope.operationId)&&(!scope.personaId||task.scope.personaId===scope.personaId))tasks.push(task);
    }return tasks;
  }
  async function pendingRecords(){
    await noLinks(pendingRoot);let names;try{names=await readdir(pendingRoot);}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const result=[];for(const name of names.filter(n=>/^restore-[a-f0-9]{64}\.json$/.test(n))){const path=join(pendingRoot,name);await noLinks(path);const raw=JSON.parse(await readFile(path,'utf8')),{sha256,...body}=raw;if(body.version!==1||hash(body)!==sha256||body.executionAllowed!==false||!Array.isArray(body.tasks))throw contextFailure('Pending archive evidence is damaged','BUDDY_ARCHIVE_CORRUPT');result.push(raw);}return result;
  }
  async function snapshot(scope={}){
    if(typeof scope.characterId!=='string'||typeof scope.lifeId!=='string')throw contextFailure('Archive identity is required');assertIdle(scope.characterId);
    const fromPlugin=readPluginEvidence?await readPluginEvidence(structuredClone(scope)):null;
    let tasks;if(fromPlugin){validateWorkEvidence(fromPlugin,scope);tasks=structuredClone(fromPlugin.tasks);}else tasks=await legacyTasks(scope);
    for(const pending of await pendingRecords())if(pending.characterId===scope.characterId&&pending.lifeId===scope.lifeId&&(!scope.operationId||pending.operationId===scope.operationId)&&!await isPendingImported?.(pending))tasks.push(...structuredClone(pending.tasks));
    const byId=new Map();for(const task of tasks){const old=byId.get(task.id);if(old&&hash(old)!==hash(task))throw contextFailure('Archive task identity has conflicting evidence','BUDDY_ARCHIVE_CORRUPT');byId.set(task.id,task);}
    if(!byId.size)return null;const evidence={version:1,characterId:scope.characterId,lifeId:scope.lifeId,tasks:[...byId.values()].sort((a,b)=>a.id.localeCompare(b.id))};return {...evidence,sha256:workEvidenceHash(evidence)};
  }
  async function restoreOnce(spec){
    const {characterId,lifeId,operationId,transactionId,evidence}=spec;validateWorkEvidence(evidence,{characterId,lifeId});assertIdle(characterId);
    if(typeof transactionId!=='string'||!transactionId||typeof operationId!=='string'||!operationId)throw contextFailure('Archive restore transaction is required','BUDDY_ARCHIVE_INVALID');
    const tasks=evidence.tasks.map(source=>normalizedRestore(source,{characterId,lifeId,operationId,transactionId,sha256:evidence.sha256})),body={version:1,characterId,lifeId,operationId,transactionId,sourceEvidenceSha256:evidence.sha256,executionAllowed:false,tasks},record={...body,sha256:hash(body)};
    await noLinks(pendingRoot);await mkdir(pendingRoot,{recursive:true});const path=join(pendingRoot,'restore-'+hash(transactionId)+'.json');await noLinks(path);
    let existing;try{existing=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing){if(existing.sha256!==record.sha256||hash(Object.fromEntries(Object.entries(existing).filter(([key])=>key!=='sha256')))!==existing.sha256)throw contextFailure('Restore transaction has different evidence','BUDDY_ARCHIVE_CONFLICT');}
    else writeAtomic(path,JSON.stringify(record)+'\n');
    return {restoredTaskIds:tasks.map(t=>t.id),sha256:evidence.sha256,pendingImport:true,externalFilesChanged:false,executionAllowed:false};
  }
  function restore(spec={}){const copy=structuredClone(spec),result=tail.catch(()=>{}).then(()=>restoreOnce(copy));tail=result.catch(()=>{});return result;}
  return {assertIdle,snapshot,restore,pending:pendingRecords,flush:()=>tail};
}
