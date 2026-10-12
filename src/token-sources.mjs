import {join,resolve,isAbsolute} from 'node:path';
import {stat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createSnapshotStorage,readJson} from './storage.mjs';
import {TOOL_NAMES,PROVIDER_NAMES,FORMATS} from './token-types.mjs';
export {TOOL_NAMES,PROVIDER_NAMES,FORMATS,providerFor} from './token-types.mjs';
const idFor=(tool,path)=>'auto-'+createHash('sha256').update(tool+':'+resolve(path).toLowerCase()).digest('hex').slice(0,20);
export function defaultTokenSources({home,env=process.env,dataRoot}){
 const list=[],add=(tool,path,extra={})=>list.push({id:idFor(tool,path),tool,name:TOOL_NAMES[tool],path:resolve(path),enabled:true,automatic:true,...extra});
 const codex=env.CODEX_HOME||join(home,'.codex'),claude=env.CLAUDE_CONFIG_DIR||join(home,'.claude');
 add('codex',join(codex,'sessions'));add('codex',join(codex,'archived_sessions'));add('claude',join(claude,'projects'));
 add('gemini',join(env.GEMINI_CLI_HOME||home,'.gemini','tmp'));
 for(const base of new Set([env.KIMI_CODE_HOME||join(home,'.kimi-code'),env.KIMI_HOME||join(home,'.kimi')]))add('kimi',join(base,'sessions'));
 add('opencode',env.OPENCODE_DB||join(env.XDG_DATA_HOME||join(home,'.local','share'),'opencode'));
 for(const editor of ['Code','Code - Insiders','VSCodium','Cursor'])for(const [tool,extension] of [['cline','saoudrizwan.claude-dev'],['roo','rooveterinaryinc.roo-cline']])add(tool,join(env.APPDATA||join(home,'AppData','Roaming'),editor,'User','globalStorage',extension));
 add('cline',join(home,'.cline','data','sessions'));
 add('dsh',join(env.DSH_HOME||join(home,'.dsh'),'sessions'));
 if(dataRoot)for(const file of ['api-usage.jsonl','cg-usage.jsonl'])add('companion',join(dataRoot,file),{name:file==='api-usage.jsonl'?'鲸鱼娘聊天 API':'鲸鱼娘 CG',purpose:file.startsWith('cg')?'cg':'galgame'});
 return list;
}
export function validateSource(draft){
 if(!draft||!Object.hasOwn(TOOL_NAMES,draft.tool))throw Error('请选择工具类型');
 if(typeof draft.path!=='string'||!isAbsolute(draft.path.trim()))throw Error('请选择绝对路径');
 const format=draft.format||'auto';if(!FORMATS.includes(format))throw Error('不支持的文件格式');
 if(draft.tool==='dsh'&&!['auto','jsonl','jsonl.zstd'].includes(format))throw Error('Harness 请选择自动或 JSONL 格式');
 const mapping={};for(const [key,value] of Object.entries(draft.mapping||{})){if(!['id','sessionId','timestamp','model','provider','workspace','input','output','cacheRead','cacheWrite','reasoning','total','status'].includes(key))throw Error('不支持的映射字段');if(typeof value!=='string'||value.length>200||!/^[$\w.\[\]-]*$/.test(value))throw Error('字段路径格式无效');mapping[key]=value;}
 if(draft.tool==='custom'&&!Object.keys(mapping).some(k=>['input','output','total'].includes(k)))throw Error('请映射至少一个用量字段');
 const recordsPath=String(draft.recordsPath||'');if(recordsPath&&!/^[$\w.\[\]-]+$/.test(recordsPath))throw Error('记录路径格式无效');
 const table=String(draft.table||'');if(table&&!/^[\w-]+$/.test(table))throw Error('表名称无效');
 const mode=draft.tool==='dsh'?'request':draft.mode||'request';if(!['request','cumulative'].includes(mode))throw Error('计数模式无效');
 if(mode==='cumulative'&&(!mapping.sessionId||!mapping.timestamp))throw Error('累计计数需要会话 ID 和时间字段');
 return {id:typeof draft.id==='string'?draft.id:randomUUID(),name:String(draft.name||TOOL_NAMES[draft.tool]).trim().slice(0,80),tool:draft.tool,path:resolve(draft.path.trim()),format,enabled:draft.enabled!==false,automatic:draft.automatic===true,mapping,recordsPath,table,mode,cacheIncluded:draft.cacheIncluded!==false,reasoningIncluded:draft.reasoningIncluded!==false,aliasProvider:String(draft.aliasProvider||'').slice(0,80),overlapGroup:String(draft.overlapGroup||'').slice(0,80),primary:draft.primary!==false};
}
export class TokenSources {
 constructor({dataRoot,home,env=process.env,roots}){this.store=createSnapshotStorage(join(dataRoot,'token-sources.json'));this.defaults=defaultTokenSources({dataRoot,home,env});this.explicitRoots=roots;this.statuses=new Map();this.tail=Promise.resolve();}
 async init(){this.state=await readJson(this.store,{version:1,autoDiscover:this.explicitRoots===undefined,sources:[],aliases:{}});return this;}
 list(){
  const saved=new Map(this.state.sources.map(s=>[s.id,s])),list=[];
  if(this.explicitRoots===undefined)for(const item of this.defaults)if(this.state.autoDiscover||item.tool==='companion')list.push(saved.get(item.id)||item);
  if(this.explicitRoots)for(const item of this.explicitRoots)list.push({id:idFor(item.provider,item.path),tool:item.provider,path:resolve(item.path),name:TOOL_NAMES[item.provider]||item.provider,enabled:true,automatic:true});
  for(const item of saved.values())if(!list.some(s=>s.id===item.id))list.push(item);
  const paths=new Set();return list.filter(s=>{const key=s.tool+':'+resolve(s.path).toLowerCase();if(paths.has(key))return false;paths.add(key);return true;});
 }
 async view(){const sources=[];for(const s of this.list()){let exists=false,error='';try{await stat(s.path);exists=true;}catch(e){if(e.code!=='ENOENT')error='无读取权限';}const status=this.statuses.get(s.id);sources.push({...s,status:!s.enabled?'已停用':error||(!exists?'目录不存在':status?.message||'等待首次请求'),...status,exists});}return {...this.state,sources,tools:TOOL_NAMES,providers:{...PROVIDER_NAMES,...this.state.aliases}};}
 async action(action,args={}){const run=async()=>{const previous=structuredClone(this.state);try{
  if(action==='get')return this.view();
  if(action==='save'){const s=validateSource(args);const old=this.list().find(x=>x.id===s.id);if(old?.automatic)s.automatic=true;const physical=await realpath(s.path).catch(()=>s.path);for(const other of this.list()){if(other.id===s.id||!other.enabled)continue;const path=await realpath(other.path).catch(()=>other.path);if(path.toLowerCase()===physical.toLowerCase())throw Error('这个路径已有数据源，请编辑原配置');}this.state.sources=this.state.sources.filter(x=>x.id!==s.id);this.state.sources.push(s);}
  else if(action==='toggle'||action==='remove'){const old=this.list().find(s=>s.id===args.id);if(!old)throw Error('数据源不存在');this.state.sources=this.state.sources.filter(s=>s.id!==args.id);if(action==='toggle'||old.automatic)this.state.sources.push({...old,enabled:action==='toggle'?args.enabled===true:false});}
  else if(action==='auto')this.state.autoDiscover=args.enabled===true;
  else if(action==='alias'){if(typeof args.id!=='string'||!args.id.trim()||args.id.length>160||typeof args.name!=='string'||!args.name.trim())throw Error('请填写 ID 和显示名称');if(args.kind==='model')this.state.modelAliases={...this.state.modelAliases,[args.id.trim()]:args.name.trim().slice(0,80)};else{if(!/^[\w.-]{1,80}$/.test(args.id))throw Error('提供方 ID 格式无效');this.state.aliases={...this.state.aliases,[args.id]:args.name.trim().slice(0,80)};}}
  else if(action==='import'){if(args.version!==1||!Array.isArray(args.sources)||args.sources.length>100)throw Error('模板格式无效');for(const item of args.sources){const s=validateSource({...item,id:randomUUID(),automatic:false});if(this.list().some(o=>o.path.toLowerCase()===s.path.toLowerCase()))continue;this.state.sources.push(s);}for(const [key,values] of Object.entries({aliases:args.aliases,modelAliases:args.modelAliases})){if(values){if(typeof values!=='object'||Array.isArray(values)||Object.keys(values).length>200)throw Error('别名格式无效');for(const [id,name] of Object.entries(values)){if(id.length>160||typeof name!=='string'||name.length>80)throw Error('别名格式无效');}this.state[key]={...this.state[key],...values};}}}
  else if(action==='export')return {version:1,sources:this.state.sources.filter(s=>!s.automatic).map(({path,id,...s})=>({...s,enabled:false,path:''})),aliases:this.state.aliases,modelAliases:this.state.modelAliases||{}};
  else throw Error('不支持的操作');
  await this.store.writeText(JSON.stringify(this.state));return this.view();
 }catch(error){this.state=previous;throw error;}};const result=this.tail.then(run,run);this.tail=result.catch(()=>{});return result;}
}
