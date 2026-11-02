export function createWorkResumeConfirmation({dialog,BrowserWindow,language=()=> 'zh'}={}){
 const pending=new WeakSet(),fail=(message,code)=>Object.assign(Error(message),{code});
 return async({window,title,revision,paths,project})=>{
  const parent=window instanceof BrowserWindow?window:window?.getParentWindow?.();
  const current=()=>parent instanceof BrowserWindow&&!parent.isDestroyed()&&parent.isVisible()&&!parent.isMinimized()&&!window.isDestroyed?.()&&window.isVisible()&&(window===parent||window.getParentWindow?.()===parent);
  if(!current()||!parent.isFocused()||!window.isFocused())throw fail('Return to the visible work page to confirm the plan','WORK_USER_APPROVAL_REQUIRED');
  if(pending.has(parent))throw fail('A work confirmation is already open','WORK_APPROVAL_PENDING');
  pending.add(parent);
  try{
  const en=language()==='en';
  const result=await dialog.showMessageBox(parent,{type:'question',title:en?'Resume saved work':'继续原工作任务',message:en?'AI Buddy was updated. Confirm the saved plan for this version?':'AI 酱已更新。是否在当前版本上重新批准原计划？',detail:[String(title),String(project),en?'Plan revision '+revision:'计划第 '+revision+' 版',...paths.slice(0,10),paths.length>10?'…':'',en?'The team and approved scope were checked. Saved submissions will be verified before resuming.':'已核对团队和批准范围。继续时将先核验已提交的文件，再接着执行。'].filter(Boolean).join('\n'),buttons:en?['Confirm and continue','Cancel']:['确认并继续','取消'],defaultId:1,cancelId:1,noLink:true});
  if(result.response!==0)return false;
  // A native modal temporarily takes focus. Never bring an unrelated or hidden page to the front.
  for(let n=0;n<20&&current()&&!parent.isFocused();n++)await new Promise(r=>setTimeout(r,15));
  if(!current()||!parent.isFocused())return false;
  if(window!==parent&&!window.isFocused())window.focus();
  for(let n=0;n<20&&current()&&parent.isFocused()&&!window.isFocused();n++)await new Promise(r=>setTimeout(r,15));
  return current()&&parent.isFocused()&&window.isFocused();
  }finally{pending.delete(parent);}
 };
}
