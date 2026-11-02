import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';

/** An owned stdio JSON-RPC process. Never reads credentials or changes global configuration. */
export class HarnessRpcProcess extends EventEmitter {
  constructor({binary,args=[],cwd,env=process.env,spawnImpl=spawn,requestTimeoutMs=30000,maxLineBytes=8*1024*1024}) {
    super();Object.assign(this,{binary,args,cwd,env,spawnImpl,requestTimeoutMs,maxLineBytes});this.pending=new Map();this.serverRequests=new Map();this.nextId=1;this.child=null;this.closed=false;
  }
  async start(){
    if(this.closed)throw Error('工作执行器已关闭');if(this.child)return;if(this.starting)return this.starting;
    this.starting=(async()=>{
      if(typeof this.binary!=='string'||!this.binary)throw Error('未配置工作执行器');
      const child=this.spawnImpl(this.binary,this.args,{cwd:this.cwd,env:{...this.env},windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
      const failed=error=>{if(this.child!==child)return;this.child=null;this.lines?.close();this.fail(error);this.emit('disconnect',{message:error.message,code:error.code??'HARNESS_DISCONNECTED'});};
      child.once('error',()=>failed(Object.assign(Error('工作执行器启动失败'),{code:'HARNESS_START_FAILED'})));
      child.once('exit',(code,signal)=>failed(Object.assign(Error('工作执行器进程已结束'),{code:'HARNESS_EXIT',exitCode:code,signal})));
      child.stdin.on('error',()=>failed(Error('工作执行器输入通道已关闭')));
      // stderr may contain URLs or secrets. Consume it without persisting it.
      child.stderr.on('data',()=>{});
      this.lines=createInterface({input:child.stdout,crlfDelay:Infinity});this.lines.on('line',line=>{
        if(this.child!==child)return;
        if(Buffer.byteLength(line)>this.maxLineBytes){failed(Error('工作执行器协议消息过大'));child.kill();return;}
        let msg;try{msg=JSON.parse(line);}catch{this.emit('protocol-error',{code:'INVALID_JSON'});return;}
        if(msg===null||typeof msg!=='object'||Array.isArray(msg))return;
        if(msg.id!==undefined&&!msg.method){const request=this.pending.get(String(msg.id));if(!request)return;this.pending.delete(String(msg.id));clearTimeout(request.timer);if(msg.error)request.reject(Object.assign(Error(String(msg.error.message??'执行器请求失败')),{code:msg.error.code,data:msg.error.data}));else request.resolve(msg.result);return;}
        if(msg.id!==undefined&&typeof msg.method==='string'){if(this.serverRequests.has(String(msg.id)))return;this.serverRequests.set(String(msg.id),msg);this.emit('request',msg);return;}
        if(typeof msg.method==='string')this.emit('notification',msg);
      });
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('工作执行器启动失败')));});
    })();try{await this.starting;}finally{this.starting=null;}
  }
  write(message){if(!this.child||this.closed)throw Error('工作执行器尚未启动');this.child.stdin.write(JSON.stringify(message)+'\n');}
  request(method,params={},timeoutMs=this.requestTimeoutMs){
    if(!this.child||this.closed)return Promise.reject(Error('工作执行器尚未启动'));
    const id=this.nextId++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(String(id));reject(Object.assign(Error('工作执行器请求超时：'+method),{code:'HARNESS_TIMEOUT',method}));},timeoutMs);this.pending.set(String(id),{resolve,reject,timer});try{this.write({jsonrpc:'2.0',id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(String(id));reject(error);}});
  }
  notify(method,params={}){this.write({jsonrpc:'2.0',method,params});}
  respond({requestId,result,error}){const id=String(requestId),request=this.serverRequests.get(id);if(!request)throw Error('工作授权请求不存在或已处理');this.serverRequests.delete(id);this.write({jsonrpc:'2.0',id:request.id,...(error?{error}:{result:result??{}})});}
  fail(error){for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();this.serverRequests.clear();}
  dispose(){if(this.closed)return;this.closed=true;const child=this.child;this.child=null;this.lines?.close();this.fail(Object.assign(Error('工作执行器已关闭'),{code:'HARNESS_DISPOSED'}));if(child){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill();}}
}

/** Lazy, task-scoped adapters. A shared task never silently changes its backend. */
export class AgentRuntimeManager extends EventEmitter {
  constructor({factories={},idleMs=120000}={}){super();this.factories=new Map(Object.entries(factories));this.entries=new Map();this.idleMs=idleMs;this.closed=false;}
  register(kind,factory){if(this.factories.has(kind))throw Error('工作执行器已登记');if(typeof factory!=='function')throw Error('工作执行器工厂无效');this.factories.set(kind,factory);}
  async ensure(taskId,{kind,...options}){
    if(this.closed)throw Error('工作执行器管理器已关闭');if(typeof taskId!=='string'||!taskId)throw Error('工作任务 ID 无效');
    let entry=this.entries.get(taskId);if(entry){if(entry.kind!==kind)throw Error('现有工作任务不能静默更换执行器');clearTimeout(entry.timer);entry.timer=null;entry.users++;return entry.promise;}
    const factory=this.factories.get(kind);if(!factory)throw Object.assign(Error('工作引擎尚未安装或未启用'),{code:'HARNESS_UNAVAILABLE',kind});
    entry={kind,users:1,timer:null,adapter:null,promise:null};this.entries.set(taskId,entry);
    entry.promise=Promise.resolve().then(()=>factory(options)).then(adapter=>{if(this.closed||this.entries.get(taskId)!==entry){adapter.dispose();throw Error('工作执行器管理器已关闭');}entry.adapter=adapter;adapter.on('event',event=>this.emit('event',{...event,taskId}));return adapter;}).catch(error=>{if(this.entries.get(taskId)===entry)this.entries.delete(taskId);throw error;});return entry.promise;
  }
  release(taskId){const entry=this.entries.get(taskId);if(!entry)return;entry.users=Math.max(0,entry.users-1);if(entry.users||entry.timer)return;entry.timer=setTimeout(()=>{if(entry.users||this.entries.get(taskId)!==entry)return;if(entry.adapter?.busy){entry.timer=null;this.release(taskId);return;}this.entries.delete(taskId);entry.adapter?.dispose();},this.idleMs);entry.timer.unref?.();}
  async probe(kind,options={}){const factory=this.factories.get(kind);if(!factory)return {available:false,reason:'not-installed'};const adapter=await factory(options);try{return {available:true,...await adapter.probe()};}finally{adapter.dispose();}}
  dispose(){this.closed=true;for(const entry of this.entries.values()){clearTimeout(entry.timer);entry.adapter?.dispose();}this.entries.clear();}
}
