import {randomBytes} from 'node:crypto';
import {updateError} from './update-reservation.mjs';

const day=24*60*60_000,selection=/^[a-f0-9]{64}$/;
const activePhases=new Set(['initializing','checking','downloading','preparing','waiting-safe-point','applying','verifying']);
const progressPhases=new Map([
  ['update-download','downloading'],['download','downloading'],['downloading','downloading'],['extract','preparing'],['preparing','preparing'],
  ['waiting-safe-point','waiting-safe-point'],['committing','applying'],['verifying','verifying'],
]);
const measure=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const resultFields=result=>({...Object.fromEntries(['version','notes','installerBytes','downloadBytes','installBytes'].map(key=>[key,
  key.endsWith('Bytes')?measure(result[key]):typeof result[key]==='string'?result[key].slice(0,key==='notes'?4000:40):null])),requiresBootstrap:result.requiresBootstrap===true});

export function createUpdateService({version,build,supported,run,onChange=()=>{},load=()=>({}),save=async()=>{},now=Date.now}){
  let record=load()??{},selected=null,task=null,closed=false,started=false,timer=null,retryAt=0,receiptTimer=null,lastProgress=null;
  let state={version,build,revision:0,phase:supported?'idle':'bootstrap',checkedAt:record.checkedAt??null,
    automatic:record.automatic!==false,target:null,error:null,retryAction:null,progress:null,reasons:[],canCancel:false};
  const view=()=>structuredClone(state);
  const update=patch=>{state={...state,...patch,revision:state.revision+1};onChange(view());};
  let saveTail=Promise.resolve();
  const persist=patch=>{
    const pending=saveTail.then(async()=>{const next={...record,...patch};await save(next);record=next;});
    saveTail=pending.catch(()=>{});return pending;
  };
  function progress(event){
    const phase=progressPhases.get(event.phase);
    if(!phase)return;
    const at=now(),bytes=measure(event.bytes),total=measure(event.total);
    const elapsed=at-(lastProgress?.at??0),continued=lastProgress?.phase===phase&&bytes!==null&&lastProgress.bytes!==null&&total===lastProgress.total&&bytes>=lastProgress.bytes;
    if(continued&&elapsed<240&&bytes!==total)return;
    const bytesPerSecond=measure(event.bytesPerSecond)??(continued&&elapsed>0?Math.round((bytes-lastProgress.bytes)*1000/elapsed):null);
    lastProgress={at,phase,bytes,total};
    const reasons=Array.isArray(event.reasons)?event.reasons.slice(0,16).map(row=>typeof row==='string'?row:row?.capability).filter(code=>typeof code==='string').map(code=>({capability:code.slice(0,40)})):[];
    update({phase,canCancel:!['applying','verifying'].includes(phase),reasons,
      progress:{bytes,total,bytesPerSecond}});
  }
  function accept(result,op){
    if(result.ok!==true)throw Object.assign(updateError(result.code??'APP_UPDATE_FAILED'),{retryAfterMs:result.retryAfterMs});
    const {stage}=result;
    if(op==='status'&&['idle','current'].includes(stage)){if(state.phase==='initializing'||state.phase==='verifying')update({phase:stage,target:null,canCancel:false});return;}
    if(op==='status'&&stage==='applying'){
      update({phase:'verifying',target:resultFields(result),error:null,canCancel:false});return;
    }
    if(!['available','current','ready','completed','recovery-required','bootstrap'].includes(stage))throw updateError('APP_UPDATE_PROTOCOL');
    if(['available','ready'].includes(stage)&&(!selection.test(result.selectionId??'')||typeof result.version!=='string'))throw updateError('APP_UPDATE_PROTOCOL');
    if(['prepare','apply'].includes(op)&&result.selectionId!==selected)throw updateError('APP_UPDATE_PROTOCOL');
    if(stage==='available'||stage==='ready')selected=result.selectionId;
    else if(stage!=='completed')selected=null;
    const target=['available','ready','completed'].includes(stage)?resultFields(result):null;
    if(target&&op==='prepare'&&state.target){target.notes??=state.target.notes;target.installerBytes??=state.target.installerBytes;}
    update({phase:stage,target,error:stage==='recovery-required'?(result.code??'APP_UPDATE_RECOVERY_REQUIRED'):null,retryAction:null,progress:null,reasons:[],canCancel:false});
  }
  async function operate(op){
    if(task)throw updateError('APP_UPDATE_BUSY');
    if(op==='check'&&now()<retryAt)return view();
    const previous=state.phase;
    const controller=new AbortController(),nonce=randomBytes(32).toString('hex');
    task={op,controller,nonce};lastProgress=null;
    if(op!=='status')update({phase:op==='check'?'checking':op==='prepare'?'downloading':'waiting-safe-point',error:null,retryAction:null,progress:null,reasons:[],canCancel:true});
    try{
      if(op==='check'){
        const checkedAt=now();
        await persist({checkedAt});update({checkedAt});
      }
      const result=await run(op,{nonce,signal:controller.signal,onProgress:progress,...(['apply','prepare'].includes(op)?{selectionId:selected}:{})});
      accept(result,op);
    }catch(error){
      const cancelled=error.code==='APP_UPDATE_CANCELLED'||error.name==='AbortError';
      if(Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>0)retryAt=now()+Math.min(day,error.retryAfterMs);
      let phase='error';
      if(cancelled)phase=activePhases.has(previous)?'idle':previous;
      else if(error.code==='APP_UPDATE_BOOTSTRAP')phase='bootstrap';
      else if(error.code==='APP_UPDATE_RECOVERY_REQUIRED')phase='recovery-required';
      const clearTarget=phase==='recovery-required'||phase==='bootstrap'||(op==='check'&&!cancelled);
      update({phase,error:cancelled?null:error.code??'APP_UPDATE_FAILED',retryAction:phase==='error'?({prepare:'download',apply:'apply'}[op]??'check'):null,
        progress:null,reasons:[],canCancel:false,...(clearTarget?{target:null}:{})});
      if(clearTarget)selected=null;
    }finally{task=null;}
    return view();
  }
  async function action(command,value){
    if(command==='status')return view();
    if(command==='automatic'&&typeof value==='boolean'){
      await persist({automatic:value});update({automatic:value});return view();
    }
    if(command==='cancel'){
      if(state.canCancel)task?.controller.abort();
      return view();
    }
    if(closed||!supported||state.phase==='bootstrap'||state.phase==='recovery-required')throw updateError('APP_UPDATE_INVALID_STATE');
    if(command==='check')return operate('check');
    if(command==='download'&&selected&&!state.target?.requiresBootstrap&&(state.phase==='available'||state.retryAction==='download'))return operate('prepare');
    if(command==='apply'&&selected&&(state.phase==='ready'||state.retryAction==='apply'))return operate('apply');
    throw updateError('APP_UPDATE_INVALID_STATE');
  }
  function schedule(delay){
    if(closed)return;
    timer=setTimeout(async()=>{
      try{
        if(supported&&state.automatic&&!task&&!['ready','available','bootstrap','recovery-required'].includes(state.phase)&&
          (state.checkedAt===null||now()-state.checkedAt>=day))await operate('check');
      }finally{schedule(day);}
    },delay);
    timer.unref?.();
  }
  async function recoverStatus(attempt=0){
    if(closed||task)return;
    await operate('status');
    if(state.phase==='verifying'&&attempt<5&&!closed){receiptTimer=setTimeout(()=>void recoverStatus(attempt+1),2000);receiptTimer.unref?.();}
    else if(state.phase==='verifying')update({phase:'recovery-required',error:'APP_UPDATE_RECEIPT_PENDING'});
  }
  function start(){if(started||closed)return;started=true;if(supported){update({phase:'initializing'});void recoverStatus();}schedule(45_000);}
  function close({keepApply=false}={}){closed=true;clearTimeout(timer);clearTimeout(receiptTimer);if(!keepApply||task?.op!=='apply')task?.controller.abort();}
  return {view,action,start,close,permitsReservation:nonce=>task?.op==='apply'&&task.nonce===nonce&&!task.controller.signal.aborted};
}
