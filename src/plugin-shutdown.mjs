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
