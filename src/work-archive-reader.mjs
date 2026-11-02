import {DatabaseSync} from 'node:sqlite';
import {readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createColdWorkArchiveBridge} from './buddy-plugin-services/cold-work-archive.mjs';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';

const fields=['characterId','personaId','lifeId','operationId'];
/** Read-only archive projection: imports no plugin, queue, engine or recovery. */
export function createWorkArchiveReader({dataRoot,isBusy=()=>false}={}){
  const legacyRoot=join(dataRoot,'agent-tasks'),pendingRoot=join(dataRoot,'work-archive-pending'),directory=join(dataRoot,'plugin-data','work-v1');
  const legacy=createColdWorkArchiveBridge({legacyRoot,pendingRoot,isBusy});
  async function read(scope){
    const existing=await legacy.snapshot(scope),tasks=new Map((existing?.tasks??[]).map(t=>[t.id,t]));let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return existing;throw e;}
    for(const entry of entries){if(!entry.isDirectory())continue;const path=join(directory,entry.name,'work-v1.sqlite');await assertPluginTreeNoLinks(path);try{await stat(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      const db=new DatabaseSync(path,{readOnly:true});try{
        if(!['1','2'].includes(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value))throw Object.assign(Error('Work archive database schema is not supported; data retained'),{code:'WORK_SCHEMA_UNSUPPORTED'});
        db.exec('BEGIN');const all=table=>db.prepare('SELECT body FROM '+table+' ORDER BY id').all().map(r=>JSON.parse(r.body)),projects=new Map(all('projects').map(r=>[r.id,r]));
        const related=Object.fromEntries(['plans','work_items','submissions','reviews','integration_runs','engine_runs','reports'].map(table=>[table,all(table)]));
        for(const task of all('tasks')){const direct=fields.every(k=>scope[k]==null||task.scope?.[k]===scope[k]),member=task.team?.find(m=>m.scope&&fields.every(k=>scope[k]==null||m.scope[k]===scope[k]));if(!direct&&!member)continue;const project=projects.get(task.projectId),events=db.prepare('SELECT cursor,body,previous,sha256 FROM task_events WHERE task_id=? ORDER BY cursor').all(task.id).map(row=>({...JSON.parse(row.body),cursor:row.cursor,previous:row.previous,sha256:row.sha256}));tasks.set(task.id,{...task,...(!direct?{scope:{...member.scope},scopeProjection:'member-evidence-only',executionAllowed:false,sessionId:null,archivedNativeSessionId:task.sessionId??task.archivedNativeSessionId??null}:{}),workspace:task.workspace??{id:task.projectId,path:project?.canonicalPath},events,workPlugin:{schemaVersion:1,sourceTaskId:task.id,originalTaskScope:structuredClone(task.scope),...(!direct?{scopeProjection:'member-evidence-only',executionAllowed:false}:{}),project,plans:related.plans.filter(r=>r.taskId===task.id),workItems:related.work_items.filter(r=>r.taskId===task.id),submissions:related.submissions.filter(r=>r.taskId===task.id),reviews:related.reviews.filter(r=>r.taskId===task.id),integrations:related.integration_runs.filter(r=>r.taskId===task.id),engineRuns:related.engine_runs.filter(r=>r.taskId===task.id),reports:related.reports.filter(r=>r.taskId===task.id)}});}
        db.exec('COMMIT');
      }finally{db.close();}
    }
    if(!tasks.size)return null;const evidence={version:1,characterId:scope.characterId,lifeId:scope.lifeId,tasks:[...tasks.values()].sort((a,b)=>a.id.localeCompare(b.id))};return {...evidence,sha256:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
  }
  // pending records are already included above by legacy.snapshot; the outer
  // bridge also deduplicates identical restore IDs and refuses conflicting data.
  async function isPendingImported(pending){let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return false;throw e;}for(const entry of entries){if(!entry.isDirectory())continue;const path=join(directory,entry.name,'work-v1.sqlite');await assertPluginTreeNoLinks(path);try{await stat(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}const db=new DatabaseSync(path,{readOnly:true});try{if(!['1','2'].includes(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value))throw Object.assign(Error('Work archive database schema is not supported; data retained'),{code:'WORK_SCHEMA_UNSUPPORTED'});const saved=db.prepare('SELECT body FROM archive_imports WHERE id=?').get('archive-'+createHash('sha256').update(pending.transactionId).digest('hex'));if(!saved)continue;const record=JSON.parse(saved.body);if(record.transactionId!==pending.transactionId||record.evidenceHash!==pending.sha256||record.executionAllowed!==false)continue;if(pending.tasks.every(task=>{const row=db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id);if(!row)return false;const current=JSON.parse(row.body);return fields.every(k=>current.scope?.[k]===task.scope?.[k]);}))return true;}finally{db.close();}}return false;}
  return createColdWorkArchiveBridge({legacyRoot,pendingRoot,readPluginEvidence:read,isPendingImported,isBusy});
}
