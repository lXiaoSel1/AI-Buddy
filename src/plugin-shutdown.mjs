export async function closePluginServices({voice,platform,attach=()=>{}}={}){
 await voice?.quiesce();
 try{await platform?.close();}
 catch(cause){
  try{const replacement=await platform.restoreAfterCloseFailure();await attach(replacement);}
  catch(recovery){throw Object.assign(new AggregateError([cause,recovery],'Plugin shutdown and recovery did not complete'),{code:'PLUGIN_SHUTDOWN_RECOVERY_FAILED',shutdownRecovery:'failed'});}
  throw Object.assign(cause,{shutdownRecovery:'restored'});
 }
}

export async function closeAppServices(steps,completed=new Set()){
 const errors=[],failedSteps=[];
 for(const[name,run]of steps){if(completed.has(name))continue;try{await run();completed.add(name);}catch(error){errors.push(error);failedSteps.push(name);}}
 if(errors.length)throw Object.assign(new AggregateError(errors,'Application services did not all close'),{code:'APP_SHUTDOWN_FAILED',failedSteps});
}

const shutdownLabels={prepare:'存档保存',plugins:'扩展服务','daily-cg':'每日 CG',rewards:'奖励记录',agents:'工作与协作','plugin-pages':'扩展页面',voice:'语音服务','plugin-usage':'扩展用量记录','pet-diagnostics':'桌宠诊断','data-import':'存档导入',buttons:'桌宠按键',trajectory:'桌宠轨迹',quotas:'额度查询',settings:'偏好设置','settings-write':'偏好设置写入',provider:'模型连接',cg:'CG 记录','work-ledger':'工作用量',game:'陪伴存档','work-sources':'工作来源',monitor:'用量监控','app-updates':'应用更新',network:'网络设置',control:'本地连接','deferred-stop':'定时保存'};

export function shutdownFailureDetail(error,t=value=>value,fallback='plugins'){
 const names=error.failedSteps?.length?error.failedSteps:[fallback],code=value=>/^[A-Z][A-Z0-9_]{0,79}$/.test(value?.code??'')?value.code:'SHUTDOWN_FAILED';
 return [t('以下步骤未完成：'),...names.map((name,index)=>'- '+t(shutdownLabels[name]??name)+' ('+code(error.errors?.[index]??error)+')')].join('\n');
}

// A missing persistence classification is deliberately treated as a save. Only
// explicitly non-saving cleanup may be bypassed after the user retries once.
export async function recoverAppShutdown({error,retry,finish,completed,steps,showMessageBox,onFailure=()=>{},t=value=>value}={}){
 const detail=error=>shutdownFailureDetail(error,t);
 const base={type:'error',title:t('退出未完成'),message:t('部分服务已经停止。重新打开后就能继续用。')};
 const choice=await showMessageBox({...base,detail:detail(error),buttons:[t('退出并重新打开'),t('稍后')],defaultId:0,cancelId:1});
 if(choice.response!==0)return false;
 try{await retry();}
 catch(error){
  onFailure(error);
  const saved=completed.has('prepare')&&completed.has('plugins')&&steps.every(([name,,persist=true])=>persist===false||completed.has(name));
  const choice=await showMessageBox({...base,message:t('以下步骤未完成：'),detail:detail(error),buttons:saved?[t('仍然重新打开'),t('稍后')]:[t('稍后')],defaultId:saved?1:0,cancelId:saved?1:0});
  if(!saved||choice.response!==0)return false;
 }
 try{await finish();return true;}
 catch(error){onFailure(error);await showMessageBox({...base,message:t('以下步骤未完成：'),detail:detail(error),buttons:[t('稍后')],defaultId:0,cancelId:0});return false;}
}
