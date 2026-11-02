import {mkdir,readdir,readFile,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const AGENT_TASK_STATUSES=Object.freeze(['queued','running','waiting-for-user','cancelling','paused-recoverable','completed','failed']);
const ACTIVE=new Set(['queued','running','waiting-for-user','cancelling']);
const IDENTIFIER=/^task-[a-zA-Z0-9-]{1,100}$/;
const SECRET_KEY=/^(?:api[-_]?key|secret|password|authorization|access[-_]?token|refresh[-_]?token|credential|credentials|env)$/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>structuredClone(value);

/** Storage is append-only: a token delta never rewrites companion snapshots. */
export function redactAgentValue(value,secrets=[]){
  if(typeof value==='string'){
    let text=value.replace(/\bBearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g,'[redacted]');
    for(const secret of secrets)if(typeof secret==='string'&&secret.length>=6)text=text.split(secret).join('[redacted]');
    return text;
  }
  if(Array.isArray(value))return value.map(item=>redactAgentValue(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!SECRET_KEY.test(key)).map(([key,item])=>[key,redactAgentValue(item,secrets)]));
  return value;
}
function reduceTask(state,record){
  if(record.type==='created')return {...copy(record.payload),events:[],revision:record.sequence,updatedAt:record.at};
  if(!state)throw Error('工作任务日志缺少创建记录');
  if(record.type==='patch')Object.assign(state,copy(record.payload));
  else state.events.push({...copy(record.payload),sequence:record.sequence,at:record.at});
  state.updatedAt=record.at;state.revision=record.sequence;return state;
}
export class AgentTaskStore {
  constructor({root,now=Date.now}={}){if(!root)throw Error('缺少工作任务存储目录');this.root=resolve(root);this.now=now;this.tasks=new Map();this.heads=new Map();this.tails=new Map();this.corrupt=new Map();this.initialized=false;}
  path(id){if(!IDENTIFIER.test(id??''))throw Error('工作任务 ID 无效');return join(this.root,id,'events.jsonl');}
  async init(){
    if(this.initialized)return this;await mkdir(this.root,{recursive:true});
    for(const entry of await readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!IDENTIFIER.test(entry.name))continue;
      let state=null,head={sequence:0,hash:null};
      try{
        const text=await readFile(this.path(entry.name),'utf8');
        for(const line of text.split('\n')){
          if(!line.trim())continue;const record=JSON.parse(line),{sha256,...body}=record;
          if(body.version!==1||body.sequence!==head.sequence+1||body.previous!==head.hash||sha256!==hash(JSON.stringify(body)))throw Error('日志来源校验失败');
          if(body.taskId!==entry.name)throw Error('日志任务身份不匹配');
          state=reduceTask(state,record);head={sequence:body.sequence,hash:sha256};
        }
        if(!state)throw Error('工作任务日志为空');this.tasks.set(entry.name,state);this.heads.set(entry.name,head);
      }catch(error){
        this.corrupt.set(entry.name,String(error.message));
        this.tasks.set(entry.name,{...(state??{id:entry.name,title:'不可读取的工作记录',events:[]}),status:'failed',journalError:String(error.message)});
      }
    }
    this.initialized=true;return this;
  }
  async write(id,type,payload){
    this.path(id);if(this.corrupt.has(id))throw Object.assign(Error('工作任务日志损坏，已保留原文件，请先恢复记录'),{code:'AGENT_JOURNAL_CORRUPT'});
    const previous=this.tails.get(id)??Promise.resolve();
    const result=previous.catch(()=>{}).then(async()=>{
      if(type==='created'&&this.tasks.has(id))throw Error('工作任务已存在');
      if(type!=='created'&&!this.tasks.has(id))throw Error('工作任务不存在');
      const head=this.heads.get(id)??{sequence:0,hash:null};
      const body={version:1,taskId:id,sequence:head.sequence+1,previous:head.hash,at:this.now(),type,payload:redactAgentValue(payload)};
      const record={...body,sha256:hash(JSON.stringify(body))};
      await mkdir(join(this.root,id),{recursive:true});const file=await open(this.path(id),'a');
      try{await file.writeFile(JSON.stringify(record)+'\n');await file.sync();}finally{await file.close();}
      this.tasks.set(id,reduceTask(this.tasks.get(id),record));this.heads.set(id,{sequence:record.sequence,hash:record.sha256});return copy(this.tasks.get(id));
    });this.tails.set(id,result);try{return await result;}finally{if(this.tails.get(id)===result)this.tails.delete(id);}
  }
  async create(task){const id=task.id??'task-'+randomUUID();if(!AGENT_TASK_STATUSES.includes(task.status??'queued'))throw Error('工作任务状态无效');return this.write(id,'created',{...copy(task),id,version:1,status:task.status??'queued',createdAt:this.now(),sessionId:null,turnCount:0});}
  async append(id,event){return this.write(id,'event',event);}
  async patch(id,patch){
    if(patch.status&&!AGENT_TASK_STATUSES.includes(patch.status))throw Error('工作任务状态无效');
    for(const field of ['id','version','events','scope','workspace','binding','createdAt','instruction','sourceEvidence','sourceGuidance','continuedFrom'])if(Object.hasOwn(patch,field))throw Error('不能更改工作任务的固定归属：'+field);
    return this.write(id,'patch',patch);
  }
  async verifyTask(id){
    if(this.corrupt.has(id))throw Object.assign(Error('工作任务原始日志损坏，原文件已保留'),{code:'AGENT_JOURNAL_CORRUPT'});
    let head={sequence:0,hash:null};
    try{for(const line of (await readFile(this.path(id),'utf8')).split('\n')){if(!line.trim())continue;const {sha256,...body}=JSON.parse(line);if(body.version!==1||body.taskId!==id||body.sequence!==head.sequence+1||body.previous!==head.hash||sha256!==hash(JSON.stringify(body)))throw Error('日志来源校验失败');head={sequence:body.sequence,hash:sha256};}
      const expected=this.heads.get(id);if(!expected||head.sequence!==expected.sequence||head.hash!==expected.hash)throw Error('日志与当前任务不一致');return copy(head);
    }catch(error){throw Object.assign(Error('工作任务原始日志校验失败，不能续建；原文件已保留'),{code:'AGENT_JOURNAL_CORRUPT',cause:error});}
  }
  get(id){return this.tasks.has(id)?copy(this.tasks.get(id)):null;}
  read(id){const task=this.get(id);if(!task)throw Error('工作任务不存在');return task;}
  list(scope={}){return [...this.tasks.values()].filter(task=>Object.entries(scope).every(([key,value])=>value==null||task.scope?.[key]===value||key==='workspaceId'&&task.workspace?.id===value)).map(task=>{const {events,...summary}=task;return copy({...summary,eventCount:events?.length??0});}).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0));}
  async recoverInterrupted(){
    const result=[];for(const task of this.tasks.values())if(ACTIVE.has(task.status)&&!this.corrupt.has(task.id)){
      const unknown=['running','waiting-for-user','cancelling'].includes(task.status);
      result.push(await this.patch(task.id,{status:'paused-recoverable',recoveryReason:'application-restarted',outcomeUnknown:unknown,pendingRequests:[],error:unknown?'应用已重启；上次操作结果待核对，不会自动重放。':null}));
    }return result;
  }
  async flush(){await Promise.all([...this.tails.values()]);}
}
export async function openAgentTaskStore(root,options={}){return new AgentTaskStore({root,...options}).init();}
