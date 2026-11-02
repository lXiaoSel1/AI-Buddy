// Host callbacks travel only in the private request options. They never enter
// a wire request, a plugin response or an audit record.
const trustedSubmissionStates=new WeakMap();
export function getModelSubmissionState(error){const value=error&&typeof error==='object'?trustedSubmissionStates.get(error):null;return value?structuredClone(value):null;}

export function createModelSubmission(options,transport,metadata={}){
 let attempted=false,claimed=false,settled=false;
 const details={transport,...metadata},event=async(phase,extra={})=>{if(typeof options.onModelLifecycle==='function')await options.onModelLifecycle(structuredClone({phase,source:'core-transport',...details,...extra}));};
 const check=async()=>{if(options.signal?.aborted)throw Object.assign(Error('请求已取消'),{code:'ABORT_ERR'});if(typeof options.checkModelSubmit==='function')await options.checkModelSubmit();if(options.signal?.aborted)throw Object.assign(Error('请求已取消'),{code:'ABORT_ERR'});};
 return {
  details,
  get attempted(){return attempted;},
  prepare:()=>event('preparing'),
  async beforeSend(extra={}){
   Object.assign(details,extra);
   if(!claimed){if(typeof options.beforeModelSubmit==='function')await options.beforeModelSubmit();claimed=true;}
   await check();await event('send-attempt');await check();
  },
  attempt(){attempted=true;},
  confirm:extra=>event('confirmed',extra),
  evidence:evidence=>event('terminal-evidence',{evidence}),
  async complete(extra={}){if(settled)return;await event('complete',extra);settled=true;},
  async failure(value){
   const error=value instanceof Error?value:Error(String(value));if(settled)return error;
   const state={phase:attempted?'unknown':'not-sent',source:'core-transport',...details};
   trustedSubmissionStates.set(error,structuredClone(state));error.modelSubmission=structuredClone(state);settled=true;
   try{await event(state.phase,{error:{code:typeof error.code==='string'?error.code:null,message:error.message}});}catch(cause){error.lifecycleError={message:cause?.message??String(cause)};}
   return error;
  }
 };
}
