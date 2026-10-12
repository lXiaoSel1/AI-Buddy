import {connectionIdentity} from './service-identity.mjs';
import {CodexProvider} from './codex-provider.mjs';
import {mkdirSync,readFileSync,copyFileSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';

export function codexImageBytes(item,directory){
 if(item?.type!=='imageGeneration'||item.failure||!['completed','succeeded','success'].includes(String(item.status).toLowerCase()))throw Error('Codex 图像生成未完成');
 let data=String(item.result??'');
 if(data.startsWith('data:image/'))data=data.replace(/^data:image\/[-+\w.]+;base64,/,'');
 if(data.length>=64&&data.length<=48*1024*1024&&/^[A-Za-z0-9+/=\s]+$/.test(data))return Buffer.from(data,'base64');
 if(item.savedPath&&existsSync(item.savedPath)){
  const root=realpathSync(directory),path=realpathSync(item.savedPath),rel=relative(root,path);
  if(rel.startsWith('..')||isAbsolute(rel))throw Error('Codex 图片输出不在本次任务目录');
  return readFileSync(path);
 }
 throw Error('Codex 没有返回可读取的图片');
}
export class CodexImageProvider extends CodexProvider{
 constructor(options){super({...options,imageGeneration:true,clientInfo:{name:'whale_companion_cg',version:'1.4.0',title:'鲸鱼娘 CG 绘图'}});}
 async check(){this.setEnabled(true);await this.start();const capabilities=await this.request('modelProvider/capabilities/read',{},15000);if(!capabilities.imageGeneration)throw Error('当前 Codex 登录不支持内置图像生成');return {ok:true,message:'Codex 图像能力可用',imageGeneration:true};}
 async models(){await this.check();const result=await this.request('model/list',{limit:100},15000);return (result.data??[]).map(row=>({id:row.model??row.id,name:row.displayName??row.model??row.id})).filter(row=>row.id);}
 async generate(profile,{prompt,references=[],directory,signal,onSubmit=async()=>{}}){
  await this.check();mkdirSync(directory,{recursive:true});
  const refs=references.map((reference,index)=>{const path=join(directory,'codex-reference-'+index+'.png');copyFileSync(reference.path,path);return {type:'localImage',path};});
  const model=profile.model||this.defaultModel;
  const thread=await this.request('thread/start',{model,cwd:directory,ephemeral:true,approvalPolicy:'never',sandbox:'workspace-write',config:{project_root_markers:[],web_search:'disabled','features.image_generation':true,'features.shell_tool':false,'features.js_repl':false,'features.memories':false,'features.goals':false,'features.apply_patch_freeform':false,mcp_servers:{},apps:{_default:{enabled:false}}},baseInstructions:'你负责绘制 Galgame CG。必须使用内置 image_generation 生成一张完整图片。允许 image_generation；不使用命令、文件编辑、网页或外部工具。输入人物参考用于对应角色身份一致性；标为环境参考的图片仅提取环境，忽略其中人物；按提示词中逐图绑定说明使用。图片输出位于本次工作目录。生成一张即可。'},30000);
  const threadId=thread.thread.id;let turnId=null;
  await onSubmit();
  return new Promise((resolveResult,reject)=>{
   let finished=false,image=null,imageCalls=0;
   const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);this.notifications.delete(listener);signal?.removeEventListener('abort',abort);error?reject(error):resolveResult(image);};
   const interrupt=()=>{if(turnId)void this.request('turn/interrupt',{threadId,turnId},3000).catch(()=>{});};
   const abort=()=>{interrupt();done(Error('CG 生成已中断，请手动重试'));};
   const listener=message=>{
    const p=message.params??{};if(p.threadId&&p.threadId!==threadId)return;if(turnId&&p.turnId&&p.turnId!==turnId)return;
    if(message.method==='item/started'&&p.item?.type==='imageGeneration'){imageCalls++;this.audit({type:'cg-native-image-started',threadId,count:imageCalls});if(imageCalls>1){interrupt();done(Error('本次只生成一张 CG，请手动重试'));}}
    if(message.method==='item/completed'&&p.item?.type==='imageGeneration'){
     try{image={buffer:codexImageBytes(p.item,directory),revisedPrompt:p.item.revisedPrompt??null};}catch{done(Error(p.item.failure?.type==='usageLimitExceeded'?'Codex 图像额度不足':'Codex 没有返回可用图片'));}
    }
    if(message.method==='item/started'&&['commandExecution','fileChange','mcpToolCall','webSearch','dynamicToolCall'].includes(p.item?.type)){interrupt();done(Error('CG 会话尝试使用绘图之外的工具，已停止'));}
    if(message.method==='thread/tokenUsage/updated')this.onUsage({provider:'codex',connectionIdentity:connectionIdentity(profile),purpose:'cg',sessionId:threadId,model,usage:p.tokenUsage?.total??{}});
    if(message.method==='turn/completed')done(p.turn?.status==='failed'?Error('Codex 图像生成失败'):image?null:Error('Codex 没有返回图片，请检查所选模型'));
    if(message.method==='provider/error')done(Error('Codex 绘图进程已结束'));
   };
   const timer=setTimeout(abort,600000);this.notifications.add(listener);signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   this.request('turn/start',{threadId,input:[{type:'text',text:prompt+'\n请使用内置 image_generation 工具生成一张图片，优先横向16:9构图。'},...refs],cwd:directory,model,effort:'low',approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[resolve(directory)],networkAccess:true},summary:'concise'},60000).then(result=>{turnId=result.turn.id;},error=>{this.audit({type:'cg-native-start-error',reason:error.message.replace(/sk-[A-Za-z0-9_-]+|Bearer\s+\S+/g,'[redacted]').slice(0,500)});done(Error('Codex 绘图启动失败'));});
  });
 }
}
