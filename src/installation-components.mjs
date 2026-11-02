// Core readiness must remain independent from a component waiting on the same
// installation lock held by the installer while it waits for core readiness.
export function extensionComponentStatus(snapshot){
 const service=snapshot?.service;
 if(!service)return {state:'initializing',usable:false,retryable:false,lastError:null};
 const error=service.lastError;
 return {state:service.state,usable:service.usable===true,retryable:service.retryable===true,lastError:error?{code:String(error.code??'PLUGIN_SERVICE_FAILED').slice(0,100),message:String(error.message??error).slice(0,500)}:null};
}
export function extensionOperationBusy(snapshot){return !!snapshot?.operation||snapshot?.service?.state==='recovering';}
