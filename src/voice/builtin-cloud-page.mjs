import React,{useEffect,useRef,useState} from 'react';
import {PET_CHARACTERS} from '../pet-characters.mjs';
import {CloudCharacterFace,CloudDesignDialog} from './cloud-design-ui.mjs';
import {builtinAsrPercent,builtinCloudStatus,hasCloudVoice,cloudVoiceKind,cloudVoiceLastUsed,voiceL as L,voiceName,VoiceButton,VoiceIcon,VoicePill,VoiceRow,VoiceSegment,VoiceSwitch,VoiceWhere} from './design-ui.mjs';

const h=React.createElement,F=React.Fragment;
const MODELS=['speech-2.8-turbo','speech-2.8-hd'];
const DEFAULT_PROVIDER='minimax-cn';
const CLOUD='cloud:';
const tone=phase=>({ready:'ok',off:'idle',checking:'busy','key-missing':'warn',quota:'warn'}[phase]??'err');
const getProviderName=id=>id==='minimax-global'?L('MiniMax 国际站','MiniMax international'):L('MiniMax 国内站','MiniMax China');
const requestError=()=>L('这次操作没有完成，请检查云配音状态。','This action could not be completed. Check the cloud voice status.');
const labelText=(zh,en)=>h('span',null,L(zh,en));
const selectCloudRoute=(act,providerId)=>act('builtin-cloud-route',{route:CLOUD+providerId,enabled:true});

function Alert({title,note,kind='warn',className='',action}){
 return h('div',{className:`ui-alert ${kind} ${className}`,role:kind==='err'?'alert':'status'},VoiceIcon(kind==='cv-info'?'info':'alert'),h('div',null,h('b',null,title),note&&h('span',null,note)),action);
}
function Action({children,...props}){return h(VoiceButton,{kind:'sm ghost',...props},children);}
function AccountDialog({cloud,onAction,onClose}){
 const [editing,setEditing]=useState(cloud.account?.id??null);
 const [providerId,setProviderId]=useState(cloud.providerId??DEFAULT_PROVIDER);
 const [name,setName]=useState(cloud.account?.name??L('我的 MiniMax','My MiniMax'));
 const [model,setModel]=useState(MODELS.includes(cloud.account?.model)?cloud.account.model:MODELS[0]);
 const [hasKey,setHasKey]=useState(false),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[confirmRemove,setConfirmRemove]=useState(null);
 const input=useRef(null),running=useRef(false);
 const change=fn=>event=>{fn(event.target.value);setResult(null);};
 function edit(account){
  setEditing(account?.id??null);setProviderId(account?.providerId??cloud.providerId??DEFAULT_PROVIDER);
  setName(account?.name??L('我的 MiniMax','My MiniMax'));setModel(account?.model??MODELS[0]);
  setConfirmRemove(null);setResult(null);setHasKey(false);if(input.current)input.current.value='';
 }
 async function execute(fn){
  if(running.current)return;
  running.current=true;setBusy(true);
  try{return await fn();}finally{running.current=false;setBusy(false);}
 }
 const call=save=>execute(async()=>{
  const key=input.current?.value.trim();if(!key)return;
  const answer=await onAction(save?'builtin-cloud-save':'builtin-cloud-probe',{
   providerId,model,key,...(save?{proof:result?.proof,name:name.trim(),...(editing?{accountId:editing}:{})}:{})
  });
  if(save&&answer?.ok===true){onClose();return;}
  setResult(answer??{status:'unavailable'});
 });
 const select=account=>execute(async()=>{
  const answer=await onAction('builtin-cloud-account-select',{accountId:account.id});
  if(!answer||answer.ok===false){setResult({status:'unavailable'});return;}
  edit(account);
 });
 const remove=account=>execute(async()=>{
  const answer=await onAction('builtin-cloud-account-remove',{accountId:account.id});
  if(!answer||answer.ok===false){setResult({status:'unavailable'});return;}
  if(editing===account.id)edit(null);else setConfirmRemove(null);
 });
 const successful=result?.ok===true&&!!result.proof;
 const feedback=result&&!successful?builtinCloudStatus({status:'unavailable',...result,enabled:true,account:{configured:true}}):null;
 const title=L('账号与 Key','Account & key');
 return h(CloudDesignDialog,{className:'bc-modal',title,subtitle:L('云配音用这个账号。请先选服务商。','Cloud voice uses this account. Choose the provider first.'),onClose:()=>!busy&&onClose(),width:640,
  footer:h(F,null,h(VoiceButton,{kind:'ghost',disabled:busy,onClick:onClose},L('取消','Cancel')),h(VoiceButton,{kind:'primary',disabled:busy||!successful||!name.trim(),onClick:()=>call(true)},L('保存','Save')))},
 (cloud.accounts?.length>0||editing)&&h('section',{className:'bc-accounts'},h('div',{className:'vx-sec-h'},h('h4',{className:'ws-sec'},L('已保存的云配音账号','Saved cloud accounts')),h(Action,{disabled:busy,onClick:()=>edit(null)},L('添加账号','Add account'))),
  h('ul',{className:'vx-cfglist'},cloud.accounts?.map(account=>h('li',{key:account.id,className:'vx-vrow'},VoiceIcon('key'),h('div',null,h('b',null,account.name||L('我的 MiniMax','My MiniMax')),h('small',null,getProviderName(account.providerId),' · ',account.model,account.last4?` · ••••${account.last4}`:'')),
   account.selected?h('span',{className:'ws-tag'},L('正在用','In use')):h(Action,{disabled:busy,onClick:()=>select(account)},L('选用','Use')),
   h(Action,{disabled:busy,onClick:()=>edit(account)},L('编辑','Edit')),
   h(Action,{disabled:busy,onClick:()=>setConfirmRemove(account)},L('删除','Delete'))))),
  confirmRemove&&h(Alert,{title:L('删除 {name}？','Delete {name}?',{name:confirmRemove.name??L('云配音账号','Cloud account')}),note:L('这会从本机移除账号配置。','This removes the account configuration from this PC.'),
   action:h('div',{className:'ws-row-btns'},h(Action,{disabled:busy,onClick:()=>setConfirmRemove(null)},L('取消','Cancel')),h(Action,{kind:'sm danger',disabled:busy,onClick:()=>remove(confirmRemove)},L('删除账号','Delete account')))})),
 h('div',{className:'vx-form vx-cfgform'},h('div',{className:'ws-fgrid'},
  h('label',{className:'ws-fld'},labelText('名字','Name'),h('input',{value:name,maxLength:80,disabled:busy,onChange:event=>setName(event.target.value)})),
  h('label',{className:'ws-fld'},labelText('服务商','Provider'),h('select',{disabled:busy,value:providerId,onChange:change(setProviderId)},
   h('option',{value:'minimax-cn'},L('MiniMax 国内站（api.minimax.cn）','MiniMax China (api.minimax.cn)')),h('option',{value:'minimax-global'},getProviderName('minimax-global')))),
  h('label',{className:'ws-fld'},labelText('模型','Model'),h('select',{disabled:busy,value:model,onChange:change(setModel)},MODELS.map(value=>h('option',{key:value,value},value)))),
  h('label',{className:'ws-fld'},h('span',null,'API Key'),h('input',{type:'password',ref:input,autoComplete:'off',spellCheck:false,disabled:busy,onChange:change(value=>setHasKey(!!value.trim()))}))),
 h('div',{className:'vx-test-row'},h(Action,{kind:'sm',icon:'retry',disabled:busy||!hasKey,onClick:()=>call(false)},L('测试连接','Test connection')),h('small',{className:'ws-muted'},providerId==='minimax-global'?L('会用很短的一句话试合成一次','Synthesises one very short line'):L('会用很短的一句话试合成一次，不到 1 分钱','Synthesises one very short line, under ¥0.01'))),
 successful&&h('p',{className:'vx-test ok',role:'status'},VoiceIcon('check-c'),L('连接正常，可以用了。','Connected and ready to use.')),
 feedback&&h(Alert,{kind:'err',title:feedback.reason??requestError(),note:feedback.phase==='key-invalid'?L('检查 Key 有没有复制完整、是不是这个站点（国内站或国际站）的 Key。','Check that the key was copied in full and belongs to the selected site.'):feedback.phase==='balance'?L('充值以后再测试。','Top up and test again.'):null}),
 h('p',{className:'settings-note'},VoiceIcon('shield',14),L('Key 只加密保存在这台电脑上，保存后不再显示。保存配置不会上传任何声音。','The key is stored encrypted on this PC only and is not shown again. Saving uploads no voice.'))));
}
function cloneReference(row){
 const plugin={breeze:['Breeze 语音插件','the Breeze Voice plugin'],gpt:['GPT-SoVITS 语音插件','the GPT-SoVITS Voice plugin']}[row?.referenceSource];
 if(row?.referenceAvailable!==true||!plugin||!(row.referenceDurationMs>0))return null;
 return {plugin:L(...plugin),durationMs:row.referenceDurationMs,version:row.referenceVersion};
}

function MissingReference({onGetVoicePlugin}){
 return h(F,null,
  h(Alert,{className:'vx-compalert cv-needplug',title:L('参考录音在语音插件里','The reference recordings are in the voice plugin'),
   note:L('下载 Breeze 语音或 GPT-SoVITS 语音其中一个就行。只用它带的参考录音：不用准备声音模型、不用启动、不占显卡。','Download either Breeze Voice or GPT-SoVITS Voice. Only its reference recordings are used: no voice model, nothing to start, no GPU.'),
   action:h(Action,{kind:'sm primary',onClick:onGetVoicePlugin,disabled:!onGetVoicePlugin},L('去扩展中心下载','Get it in Extensions'))}),
  h('p',{className:'settings-note'},VoiceIcon('info',14),L('不想装插件，也可以选「用账号里已有的声音」，用 MiniMax 的系统音色。','Without the plugin you can still pick a MiniMax system voice under “Use a voice already in the account”.')));
}

function stopPreview(preview){
 if(!preview)return;
 preview.audio.onended=null;
 preview.audio.pause();
 preview.audio.removeAttribute('src');
 preview.audio.load();
 if(preview.url)URL.revokeObjectURL(preview.url);
}

function ReferencePreview({targetCharacterId,onAction,onError}){
 const active=useRef(null),[playing,setPlaying]=useState(false);
 useEffect(()=>()=>{const preview=active.current;active.current=null;stopPreview(preview);},[]);
 async function play(){
  const previous=active.current;
  const stop=preview=>{
   if(active.current!==preview)return;
   active.current=null;
   stopPreview(preview);
   setPlaying(false);
  };
  if(previous){stop(previous);return;}
  let preview=null;
  try{
   preview={audio:new Audio(),url:null};
   active.current=preview;setPlaying(true);
   const result=await onAction('builtin-cloud-reference-preview',{targetCharacterId});
   if(active.current!==preview)return;
   if(!(result?.pcmWav instanceof Uint8Array)||!result.pcmWav.length)throw new Error('Invalid preview');
   preview.url=URL.createObjectURL(new Blob([result.pcmWav],{type:'audio/wav'}));
   preview.audio.onended=()=>stop(preview);
   preview.audio.src=preview.url;
   await preview.audio.play();
  }catch{
   if(preview&&active.current!==preview)return;
   if(preview)stop(preview);
   onError(requestError());
  }
 }
 return h(Action,{icon:playing?'stop':'play','aria-label':playing?L('停止试听','Stop the reference'):L('试听参考录音','Play the reference'),onClick:play});
}

function BatchDialog({cloud,onAction,onClose,onGetVoicePlugin}){
 const [selected,setSelected]=useState([]),[busy,setBusy]=useState(false),[result,setResult]=useState(null),[failed,setFailed]=useState(false),running=useRef(false);
 const accountRevision=useRef(cloud.accountRevision).current;
 const stale=accountRevision!==cloud.accountRevision;
 const rows=cloud.characters??[],label=L('批量准备云端声音','Prepare cloud voices');
 const hasReference=rows.some(cloneReference);
 const canPrepare=row=>!!cloneReference(row)&&!hasCloudVoice(row)&&!row.activationRecovery;
 const targets=selected.filter(id=>rows.some(row=>row.characterId===id&&canPrepare(row)));
 const checked=id=>targets.includes(id);
 const toggle=id=>setSelected(current=>current.includes(id)?current.filter(value=>value!==id):[...current,id]);
 async function prepare(){
  if(running.current||!targets.length||stale)return;
  running.current=true;setBusy(true);setFailed(false);
  try{
   const answer=await onAction('builtin-cloud-batch',{targetCharacterIds:targets,consentUpload:true,consentActivation:true,...(accountRevision?{accountRevision}:{})});
   if(Array.isArray(answer?.results))setResult(answer.results);else setFailed(true);
  }finally{running.current=false;setBusy(false);}
 }
 return h(CloudDesignDialog,{className:'bc-modal',title:label,onClose:()=>!busy&&onClose(),width:640,footer:h(F,null,
  h(VoiceButton,{kind:'ghost',disabled:busy,onClick:onClose},result?L('完成','Done'):L('取消','Cancel')),
  !result&&h(VoiceButton,{kind:'primary',icon:'upload',disabled:busy||stale||!targets.length||!cloud.account?.configured,onClick:prepare},L('克隆并使用','Clone and use')))},
  !hasReference&&!result&&h(MissingReference,{onGetVoicePlugin}),
  h('ul',{className:'vx-clist'},PET_CHARACTERS.map(character=>{
   const row=rows.find(item=>item.characterId===character.id),done=result?.find(item=>item.characterId===character.id),available=canPrepare(row);
   return h('li',{className:'vx-crow',key:character.id},h(CloudCharacterFace,{row:character}),h('b',null,voiceName(character.id)),h('span',{className:'mk-grow'}),
    h('small',{className:'ws-muted'},done?(done.ok?L('已准备','Prepared'):L('未完成','Incomplete')):hasCloudVoice(row)?L('正在用','In use'):row?.voiceId?cloudVoiceKind(row):available?L('可克隆','Ready to clone'):L('参考录音不可用','Reference unavailable')),
    h('input',{type:'checkbox','aria-label':voiceName(character.id),checked:checked(character.id),disabled:busy||!available||!!result,onChange:()=>toggle(character.id)}));
  })),
  !result&&hasReference&&h('p',{className:'settings-note'},VoiceIcon('shield',14),cloud.providerId==='minimax-global'?L('只上传你选中的录音并激活新音色。费用以 MiniMax 国际站为准。','Only the recordings you select will be uploaded and the new voices activated. MiniMax international pricing applies.'):L('只上传你选中的录音并激活新音色。MiniMax 每个收取 9.9 元，共 {amount} 元。','Only the recordings you select will be uploaded and the new voices activated. MiniMax charges ¥9.90 each, ¥{amount} total.',{amount:(targets.length*9.9).toFixed(2)})),
  (failed||stale)&&h(Alert,{kind:'err',title:stale?L('云配音账号已更换，请重新打开。','The cloud account changed. Reopen this dialog.'):requestError()}));
}

function ChooseVoiceDialog({cloud,targetCharacterId,onAction,onClose,onGetVoicePlugin}){
 const [source,setSource]=useState('clone'),[filter,setFilter]=useState('all'),[query,setQuery]=useState(''),[voices,setVoices]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null),[activation,setActivation]=useState(null),running=useRef(false);
 const [abandonConfirmation,setAbandonConfirmation]=useState(null);
 const accountRevision=useRef(cloud.accountRevision).current;
 const stale=accountRevision!==cloud.accountRevision;
 const binding=cloud.characters?.find(row=>row.characterId===targetCharacterId);
 const reference=cloneReference(binding);
 const recovery=binding?.activationRecovery===true,cloneRecovery=binding?.cloneRecovery===true;
 const recoveryVoiceId=binding?.activationRecoveryVoiceId;
 const confirmation=recovery&&activation?.voiceId===recoveryVoiceId&&activation?.accountRevision===accountRevision?activation:null;
 const abandonToken=stale?null:confirmation?.abandonActivationToken;
 const confirmingAbandon=!!abandonToken&&abandonConfirmation===abandonToken;
 const selected=hasCloudVoice(binding)?binding.voiceId:null,name=voiceName(targetCharacterId),clone=source==='clone';
 const fetchVoices=async()=>{
  if(running.current)return;
  running.current=true;setBusy(true);setError(null);
  try{
   const answer=await onAction('builtin-cloud-voices',{}),items=Array.isArray(answer)?answer:answer?.voices;
   if(!Array.isArray(items)){setError(requestError());return;}
   setVoices(items.flatMap(row=>{const id=row?.voiceId??row?.voice_id;return typeof id==='string'&&id?[{...row,voiceId:id}]:[];}));
  }finally{running.current=false;setBusy(false);}
 };
 const useVoice=async(voiceId,recover=false)=>{
  if(running.current||stale||recover&&!recoveryVoiceId)return;
  running.current=true;setBusy(true);setError(null);
  try{
   const recoveryFields=recover?{expectedActivationVoiceId:recoveryVoiceId,...(confirmation?{confirmActivationVoiceId:confirmation.voiceId}:{})}:{};
   const patch={targetCharacterId,...(accountRevision?{accountRevision}:{}),...(voiceId?{voiceId}:{consentUpload:true,consentActivation:true}),...recoveryFields};
   const result=await onAction(voiceId?'builtin-cloud-bind':'builtin-cloud-clone',patch);
   if(result&&result.ok!==false){onClose();return;}
   if(!voiceId&&result?.state==='activation_confirmation'&&result.accountRevision===accountRevision&&typeof result.voiceId==='string'&&result.voiceId){
    const token=result.abandonActivationToken;
    setActivation({voiceId:result.voiceId,accountRevision:result.accountRevision,abandonActivationToken:typeof token==='string'&&token?token:null});return;
   }
   setActivation(null);
   setError(result?.message??requestError());
  }finally{running.current=false;setBusy(false);}
 };
 const abandonActivation=async()=>{
  if(running.current||!confirmingAbandon)return;
  running.current=true;setBusy(true);setError(null);
  try{
   const result=await onAction('builtin-cloud-abandon-activation',{targetCharacterId,accountRevision,expectedActivationVoiceId:recoveryVoiceId,abandonActivationToken:abandonToken});
   if(result?.ok===true){onClose();return;}
   setActivation(null);
   setAbandonConfirmation(null);
   setError(result?.message??requestError());
  }finally{running.current=false;setBusy(false);}
 };
 const filtered=voices?.filter(row=>(filter==='all'||row.kind===filter)&&`${row.name??row.voiceName??''} ${row.voiceId}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>Number(b.voiceId===selected)-Number(a.voiceId===selected));
 const choose=(id,icon,title,note)=>h('button',{type:'button',role:'radio','aria-checked':id===source,className:`vx-choice${id===source?' on':''}`,disabled:busy,onClick:()=>{setSource(id);setError(null);setActivation(null);if(id==='account'&&!voices)void fetchVoices();}},VoiceIcon(icon,20),h('span',null,h('b',null,title),h('small',null,note)));
 const fact=(title,content,action)=>h('li',null,h('b',null,title),h('span',null,content),action);
 if(confirmingAbandon){
  const back=()=>{if(!busy)setAbandonConfirmation(null);};
  return h(CloudDesignDialog,{className:'bc-modal',title:L('放弃这条记录？','Abandon this record?'),onClose:back,
   footer:h(F,null,h(VoiceButton,{kind:'ghost',disabled:busy,autoFocus:true,onClick:back},L('返回','Back')),
    h(VoiceButton,{kind:'danger',disabled:busy,onClick:abandonActivation},L('确认放弃','Confirm abandonment')))},
   h('p',null,L('如果它其实已经激活过，可能已经收过 9.9 元；放弃以后，这个角色可以用新的录音重新克隆。','If this voice was activated, MiniMax may already have charged ¥9.90. After you abandon this record, you can use a new recording to clone a voice for this character.')));
 }
 return h(CloudDesignDialog,{className:'bc-modal',title:L('给 {name} 选云端声音','Choose {name}’s cloud voice',{name}),subtitle:L('只改 {name}。用的是「我的 MiniMax」。','Only {name} changes. Uses “My MiniMax”.',{name}),width:680,onClose:()=>!busy&&onClose(),
  footer:clone?h(F,null,h(VoiceButton,{kind:'ghost',disabled:busy,onClick:onClose},L('取消','Cancel')),
   abandonToken?h(VoiceButton,{kind:'danger',disabled:busy,onClick:()=>setAbandonConfirmation(abandonToken)},L('放弃这条记录','Abandon this record')):
    h(VoiceButton,{kind:'primary',icon:'upload',disabled:busy||stale||!reference||recovery||!!confirmation||!cloud.account?.configured,onClick:()=>useVoice()},cloneRecovery?L('重新上传并克隆','Upload and clone again'):L('克隆并使用','Clone and use'))):h(VoiceButton,{kind:'primary',disabled:busy,onClick:onClose},L('完成','Done'))},
 h('div',{className:'vx-choices',role:'radiogroup','aria-label':L('声音从哪来','Voice source')},
  choose('clone','upload',L('用语音插件里的参考声音克隆（推荐）','Clone from the voice plugin’s reference (recommended)'),L('用语音插件里 {name} 的参考录音克隆一个 MiniMax 音色，声音最像她。','Clones a MiniMax voice from {name}’s recording in the voice plugin; sounds most like her.',{name})),
  choose('account','speaker',L('用账号里已有的声音','Use a voice already in the account'),L('系统音色不收克隆费；以前克隆过的音色可以直接用。','System voices have no clone fee; voices cloned before can be reused.'))),
 clone?h(F,null,cloneRecovery&&!stale&&h(Alert,{className:'vx-compalert',title:L('上次克隆结果未确认，可以重新上传。','The last clone result is unconfirmed. You can upload the recording again.')}),(recovery||confirmation)&&!stale&&h(Alert,{className:'vx-compalert',
  title:abandonToken?L('MiniMax 音色列表里没有找到这个音色','This voice was not found in the MiniMax voice list'):confirmation?L('MiniMax 未确认上次激活','MiniMax did not confirm the last activation'):L('上次激活结果还未确认','The last activation is still unconfirmed'),
  note:confirmation?L('重新激活的是同一个音色。首次使用时由 MiniMax 收费，同一个音色只收一次。','This retries activation for the same voice. MiniMax charges only once per voice, on first use.'):reference?L('先核对这个音色是否已经可用。','Check whether this voice is already available.'):
   L('可以核对或重新激活原音色，无需安装语音插件或重新上传录音。','You can check or reactivate the original voice without installing a voice plugin or uploading the recording again.'),
  action:h(Action,{kind:'sm primary',disabled:busy||!cloud.account?.configured||!recoveryVoiceId,onClick:()=>useVoice(null,true)},confirmation?L('重新激活','Activate again'):L('核对激活状态','Check activation status'))}),
  recovery?null:reference?h(F,null,h('ul',{className:'cv-facts'},
  fact(L('参考录音','Reference'),L('来自 {plugin} · {n} 秒 · 插件不用启动、不占显卡','From {plugin} · {n} s · the plugin does not need to run or use the GPU',{plugin:reference.plugin,n:Number((reference.durationMs/1000).toFixed(1))}),
   !stale&&h(ReferencePreview,{key:reference.plugin+':'+reference.version,targetCharacterId,onAction,onError:setError})),
  fact(L('费用','Cost'),cloud.providerId==='minimax-global'?L('费用以 MiniMax 国际站的计费说明为准。','See MiniMax international pricing for charges.'):L('9.9 元，第一次用这个音色合成时由 MiniMax 收取','¥9.90, charged by MiniMax the first time this voice is used')),
  fact(L('需要','Needs'),L('MiniMax 账号已实名认证，否则克隆会失败（2038）','An identity-verified MiniMax account, otherwise cloning fails (2038)')),
  fact(L('保留','Kept'),L('7 天没用会被 MiniMax 删除，删掉后再用要重新克隆','Deleted by MiniMax after 7 days unused; using it again means cloning again'))),
  h('p',{className:'settings-note'},VoiceIcon('shield',14),cloneRecovery?L('点「重新上传并克隆」后才会把这段参考录音上传到 MiniMax。','The reference recording is uploaded to MiniMax only after you press Upload and clone again.'):L('点「克隆并使用」后才会把这段参考录音上传到 MiniMax。','The reference recording is uploaded to MiniMax only after you press Clone and use.'))):h(MissingReference,{onGetVoicePlugin})):h(F,null,
  h('div',{className:'vx-vfilter'},h(VoiceSegment,{label:L('声音类型','Voice type'),value:filter,options:[['all',L('全部','All')],['system',L('系统音色','System')],['clone',L('克隆音色','Cloned')]],onChange:setFilter}),
   h('label',{className:'vx-search'},VoiceIcon('search'),h('input',{value:query,placeholder:L('搜索音色','Search voices'),'aria-label':L('搜索音色','Search voices'),onChange:event=>setQuery(event.target.value)})),
   h(Action,{icon:'retry','aria-label':L('刷新音色列表','Refresh voice list'),disabled:busy,onClick:fetchVoices})),
  busy&&h('p',{role:'status'},L('正在读取音色…','Loading voices…')),
  filtered&&h('ul',{className:'vx-vlist'},filtered.map(row=>h('li',{key:row.voiceId,className:'vx-vrow'+(row.voiceId===selected?' on':'')},VoiceIcon('speaker'),
    h('div',null,h('b',null,row.name??row.voiceName??row.voiceId),h('small',null,cloudVoiceKind(row),' · ',h('code',null,row.voiceId))),
    row.voiceId===selected?h('span',{className:'ws-tag'},L('正在用','In use')):h(Action,{kind:'sm',disabled:busy||stale,onClick:()=>useVoice(row.voiceId)},L('用这个','Use this'))))),
  filtered?.length===0&&h('p',{className:'ws-muted'},L('没有符合条件的声音。','No matching voices.'))),
 (error||stale)&&h(Alert,{kind:'err',title:stale?L('云配音账号已更换，请重新打开。','The cloud account changed. Reopen this dialog.'):error}));
}

function RecognitionCard({asr,onAction,working}){
 const busy=asr?.state==='downloading',ready=asr?.state==='ready',percent=builtinAsrPercent(asr);
 return h('section',{className:'ws-card vx-comps'},h('h3',{className:'ws-sec'},L('本机组件','Parts on this PC')),
  h('ul',{className:'vx-comp'},h('li',null,VoiceIcon('mic',18),h('div',null,h('b',null,L('语音识别','Speech recognition')),h('small',null,L('听懂你说的话，只用 CPU · 约 413 MB','Understands what you say, CPU only · about 413 MB'))),
   h(VoicePill,{tone:ready?'ok':busy?'busy':'warn'},ready?L('已就绪','Ready'):busy?L('准备中','Preparing'):L('需要准备','Needs setup')))),
  busy?h('div',{className:'vx-compprog'},h('div',{className:'ws-meter',role:'progressbar','aria-label':L('语音识别下载中','Downloading speech recognition'),'aria-valuenow':percent},h('i',{style:{width:`${percent??0}%`}})),
   h('small',{className:'ws-muted'},percent==null?'':`${percent}% · `,L('下载期间照常聊天，她的回复照常读出来','Chat and her voice work as usual meanwhile')),
   h(Action,{disabled:working,onClick:()=>onAction('builtin-cloud-asr',{action:'pause'})},L('暂停','Pause'))):!ready&&h(Alert,{className:'vx-compalert',title:L('语音识别还没准备好','Speech recognition is not ready'),
   note:L('只有对着麦克风说话（录音输入、Live）时才用到。云配音读她的回复不受影响。','Only needed when you talk into the mic (voice input, Live). Cloud voice reading her replies works without it.'),
   action:h(Action,{kind:'sm primary',disabled:working,onClick:()=>onAction('builtin-cloud-asr',{action:'resume'})},L('准备','Prepare'))}));
}
function AccountCard({cloud,status,onManage}){
 const global=cloud.providerId==='minimax-global';
 const price=(name,copy)=>h('li',null,h('b',null,name),h('span',null,copy));
 return h('section',{className:'ws-card vx-cfg'},h('div',{className:'vx-sec-h'},h('h3',{className:'ws-sec'},L('云配音账号','Cloud account')),h(Action,{icon:'sliders',onClick:onManage},L('管理','Manage'))),
  h('div',{className:'vx-cfgcard'},VoiceIcon('key',18),h('div',null,h('b',null,cloud.account?.name||L('我的 MiniMax','My MiniMax')),
   h('small',null,[getProviderName(cloud.providerId),cloud.account?.model??MODELS[0],cloud.account?.configured?L('Key 加密存在本机','Key encrypted on this PC'):L('还没填写 Key','No key yet')].join(' · '))),h(VoicePill,{tone:tone(status.phase)},status.phase==='ready'?L('就绪','Ready'):status.label)),
  h('ul',{className:'vx-price'},!global&&price(L('文字合成','Speech'),L('speech-2.8-turbo 每 1 万字符 2 元，1 个汉字算 2 个字符','speech-2.8-turbo: ¥2 per 10,000 characters; 1 Chinese character counts as 2')),
   !global&&price(L('克隆音色','Voice clone'),L('每个 9.9 元，第一次用它合成时收取；账号需要先实名认证','¥9.90 each, charged on first use; the account must be identity-verified')),
   price(L('保留期','Retention'),L('克隆音色 7 天没用会被 MiniMax 删除，再用要重新克隆','A cloned voice unused for 7 days is deleted by MiniMax and must be cloned again')),
   h('li',{className:'ws-muted'},L('价格和规则以 MiniMax 官方说明为准。','MiniMax’s own terms apply.'),' ',h('a',{href:global?'https://platform.minimax.io/docs/guides/pricing-paygo':'https://platform.minimax.cn/docs/guides/pricing-paygo',target:'_blank',rel:'noreferrer'},L('MiniMax 计费说明','MiniMax pricing')))));
}
function retentionReason(code){
 switch(code){
  case 'CLOUD_MINIMAX_AUTH':return L('Key 无效','Invalid key');
  case 'CLOUD_MINIMAX_BALANCE':return L('余额不足','Balance too low');
  case 'CLOUD_MINIMAX_QUOTA':return L('额度用完','Quota used up');
  case 'CLOUD_NETWORK':return L('网络连接失败','Network connection failed');
  case 'CLOUD_TIMEOUT':return L('请求超时','Request timed out');
  case 'CLOUD_MINIMAX_PARAMETERS':return L('请求参数不受支持','Unsupported request parameters');
  case 'CLOUD_MINIMAX_RATE_LIMIT':return L('请求过于频繁','Too many requests');
  case 'CLOUD_MINIMAX_SERVICE':return L('MiniMax 服务暂不可用','MiniMax service unavailable');
  case 'CLOUD_RETENTION_REJECTED':return L('MiniMax 拒绝了请求','MiniMax rejected the request');
  default:return L('结果未确认','Result unconfirmed');
 }
}

export function BuiltinCloudPage({snapshot,session,characterId,intent,onGetVoicePlugin}){
 const cloud=snapshot?.state?.builtinCloud;
 const [dialog,setDialog]=useState(intent?.account?'account':intent?.characterId??null),[error,setError]=useState(null);
 const pendingRetentions=useRef(new Set()),[keeping,setKeeping]=useState(()=>new Set());
 useEffect(()=>{setDialog(intent?.account?'account':intent?.characterId??null);},[intent]);
 if(!cloud)return h('div',{className:'ws-page vx-page',role:'status'},L('正在检查云配音…','Checking cloud voice…'));
 const status=builtinCloudStatus(cloud),providerId=cloud.providerId??DEFAULT_PROVIDER;
 const active=cloud.route?.startsWith(CLOUD),working=snapshot?.working;
 const current=PET_CHARACTERS.some(row=>row.id===characterId)?characterId:PET_CHARACTERS[0].id;
 const manage=()=>setDialog('account');
 const run=async(op,params={})=>{
  setError(null);
  try{const value=await session?.runAction(op,params);if(value?.ok===false&&value.state!=='activation_confirmation'&&value.message)setError(value.message);return value;}
  catch{setError(requestError());return null;}
 };
 if(cloud.storageIssue){
  const canReset=cloud.storageIssue.canReset===true,resetBusy=working||dialog==='resetting';
  const title={
   CLOUD_STORAGE_INVALID:L('云配音设置损坏，仍可使用本地语音','Cloud voice settings are damaged. Local voice is still available.'),
   CLOUD_STORAGE_NEWER:L('云配音设置来自更新版本，目前只读','These cloud voice settings were created by a newer version and are read-only.'),
  }[cloud.storageIssue.code]??L('暂时无法读取云配音设置，请稍后重试','Cloud voice settings are temporarily unavailable. Try again shortly.');
  const reset=async()=>{
   setDialog('resetting');
   const result=await run('builtin-cloud-reset',{confirm:true});
   setDialog(result&&result.ok!==false?null:'reset');
  };
  return h('div',{className:'ws-page vx-page bc-page','data-builtin-cloud-page':true},
   h('h2',{className:'ws-ptitle'},L('云配音','Cloud voice')),
   h(Alert,{kind:'warn',className:'vx-compalert',title,
    action:canReset&&h(Action,{kind:'sm primary',disabled:resetBusy,onClick:()=>setDialog('reset')},L('重置云配音设置','Reset cloud voice settings'))}),
   error&&h(Alert,{kind:'err',title:error}),
   canReset&&['reset','resetting'].includes(dialog)&&h(CloudDesignDialog,{className:'bc-modal',title:L('重置云配音设置？','Reset cloud voice settings?'),onClose:()=>!resetBusy&&setDialog(null),
    footer:h(F,null,h(VoiceButton,{kind:'ghost',disabled:resetBusy,onClick:()=>setDialog(null)},L('取消','Cancel')),h(VoiceButton,{kind:'primary',disabled:resetBusy,onClick:reset},L('重置设置','Reset settings')))},
    h('p',null,L('账号和角色声音要重新设置。已经克隆好的声音还在你的 MiniMax 账号里，之后用「用账号里已有的声音」可以接回来。','Set up your account and character voices again. Your cloned voices stay in your MiniMax account. To reconnect them, choose “Use a voice already in the account”.')),
    h('p',null,L('会建立新的云配音设置，保留原有文件。','New cloud voice settings will be created and the old files will be kept.'))));
 }
 const accountId=cloud.account?.id??cloud.accountRevision??providerId;
 const retentionKey=row=>JSON.stringify([providerId,accountId,row.voiceId]);
 const inFlight=row=>row.retentionInFlight===true||keeping.has(retentionKey(row));
 const keep=async row=>{
  const key=retentionKey(row);
  if(working||row.retentionInFlight||pendingRetentions.current.has(key))return;
  pendingRetentions.current.add(key);
  setKeeping(new Set(pendingRetentions.current));
  try{await run('builtin-cloud-retain',{targetCharacterId:row.characterId});}
  finally{pendingRetentions.current.delete(key);setKeeping(new Set(pendingRetentions.current));}
 };
 const keepAction=(row,kind='sm')=>{
  const busy=inFlight(row);
  return h(Action,{kind,disabled:working||busy,'aria-busy':busy,onClick:()=>void keep(row)},busy?L('正在保住…','Keeping voice…'):L('保住它','Keep it'));
 };
 const manualNotices=cloud.characters?.filter(row=>row.voiceId&&row.kind==='clone'&&(row.retentionIssue||cloud.autoRetain===false&&row.due))??[];
 const retentionNotice=row=>{
  const name=voiceName(row.characterId),issue=row.retentionIssue;
  let note=L('快到保留期限了。点「保住它」会用一句很短的话合成一次。','Its retention period is nearly up. Keep it synthesises one very short line.');
  if(issue){
   const reason=retentionReason(issue.reasonCode);
   if(issue.expired)note=L('自动保住没成功（{reason}），可能已经被 MiniMax 删除，点「重新检查」核对','Could not keep this voice automatically ({reason}). MiniMax may have deleted it. Choose “Check again” to verify.',{reason});
   else if(issue.daysRemaining===0)note=L('自动保住没成功（{reason}），今天会被 MiniMax 删除','Could not keep this voice automatically ({reason}). MiniMax will delete it today.',{reason});
   else note=L('自动保住没成功（{reason}），{days} 天后会被 MiniMax 删除','Could not keep this voice automatically ({reason}). MiniMax will delete it in {days} day(s).',{reason,days:issue.daysRemaining});
  }
  return h(Alert,{key:row.characterId,className:'vx-notice',
   title:issue?L('{name} 的克隆声音','{name}’s cloned voice',{name}):L('{name} 的克隆声音 6 天没用了','{name}’s cloned voice has not been used for 6 days',{name}),
   note,
   action:keepAction(row,'sm primary')});
 };
 const check=()=>run('builtin-cloud-probe',{providerId});
 const retention=h('div',{className:'ws-card vx-keepalive'},h(VoiceRow,{title:L('自动保住克隆声音','Keep cloned voices automatically'),note:L('快到 7 天没用时，自动用一句很短的话合成一次（每次不到 1 分钱）。只对你选过的角色声音生效。','When a cloned voice nears 7 days unused, synthesise one very short line (under ¥0.01 each time). Only for voices you chose.')},
  h(VoiceSwitch,{checked:cloud.autoRetain!==false,label:L('自动保住','Keep automatically'),disabled:working,onChange:enabled=>run('builtin-cloud-retention',{enabled})})));
 const retentionAttention=cloud.autoRetain!==false&&cloud.characters?.some(row=>row.due);
 const details=[['cloud',L('声音由 MiniMax 生成，按字数计费','MiniMax makes the voice, billed by characters')],['gpu',L('不用装本地语音插件，不占显卡','No local voice plugin, no GPU')],['mic',L('对着麦克风说话时，语音识别仍在本机','Your mic is still recognised on this PC')]];
 return h('div',{className:'ws-page vx-page bc-page','data-builtin-cloud-page':true},
  cloud.migration?.pending&&h(Alert,{kind:'cv-info',className:'vx-notice',title:L('云配音换到这里了','Cloud voice has moved here'),
   note:L('原来在语音插件里的云配音设置已经搬过来：{accounts} 个账号、{characters} 个角色的声音。原来的设置保留到下一个版本，可以回退。','Your cloud voice settings from the voice plugins were moved here: {accounts} account(s) and voices for {characters} character(s). The old settings are kept until the next version so you can roll back.',cloud.migration),
   action:h('button',{type:'button',className:'ui-icon-btn','aria-label':L('知道了','Got it'),disabled:working,onClick:()=>run('builtin-cloud-migration-ack')},VoiceIcon('close'))}),
  manualNotices.map(retentionNotice),
  retentionAttention&&retention,
  h('section',{className:'ws-card vx-engine'},h('div',{className:'vx-eng-main'},
   h('span',{className:'ext-logo vx-logo bc-logo','aria-hidden':true,style:{'--pl':'56px'}},VoiceIcon('cloud',28)),
   h('div',{className:'vx-eng-txt'},h('div',{className:'vx-eng-t'},h('h2',{className:'ws-ptitle'},L('云配音','Cloud voice')),h(VoicePill,{tone:tone(status.phase)},status.phase==='ready'?L('就绪','Ready'):status.label)),
    h('ul',{className:'vx-facts'},details.map(([icon,copy])=>h('li',{key:icon},VoiceIcon(icon,15),copy)))),
   h('div',{className:'ws-row-btns vx-eng-acts'},cloud.account?.configured&&(status.phase!=='ready'||manualNotices.some(row=>row.retentionIssue))&&h(VoiceButton,{kind:'ghost',icon:'retry',disabled:working,onClick:check},L('重新检查','Check again')),
    h(VoiceButton,{kind:cloud.account?.configured?'ghost':'primary',icon:'key',onClick:manage},L('账号与 Key','Account & key')))),
   status.reason&&h(Alert,{kind:'err',className:'vx-eng-alert',title:status.reason,note:L('她的回复先只显示文字。','Her replies are text only for now.')})),
  h('div',{className:'vx-cols'},h('section',{className:'ws-card vx-voices'},
   h('div',{className:'vx-sec-h'},h('h3',{className:'ws-sec'},L('角色的云端声音','Cloud voices')),h('small',{className:'ws-muted'},L('按「账号 + 角色」保存，和本地语音插件无关','Saved per account and character, separate from the local plugins'))),
   h('ul',{className:'vx-clist'},PET_CHARACTERS.map(character=>{
    const row=cloud.characters?.find(value=>value.characterId===character.id),last=row?.kind==='clone'&&cloudVoiceLastUsed(row);
    return h('li',{className:'vx-crow'+(character.id===current?' cur':''),key:character.id},h('button',{type:'button',className:'bc-character-select','aria-label':L('给 {name} 选声音','Choose voice for {name}',{name:voiceName(character.id)}),onClick:()=>setDialog(character.id)},h(CloudCharacterFace,{row:character}),h('b',null,voiceName(character.id))),
     character.id===current&&h('span',{className:'ws-tag'},L('当前角色','Current')),h('span',{className:'mk-grow'}),
     h('small',{className:`vx-cst ${row?.due||row?.voiceId&&!hasCloudVoice(row)?'warn':hasCloudVoice(row)?'ok':'idle'}`},h('i',{className:'vx-vdot'}),[cloudVoiceKind(row),last].filter(Boolean).join(' · ')),
     row?.voiceId&&row.kind==='clone'&&!row.retentionIssue&&(cloud.autoRetain===false&&row.due||inFlight(row))&&keepAction(row));
   })),
   h('div',{className:'vx-voices-f'},h(Action,{kind:'sm',icon:'speaker',onClick:()=>setDialog(current)},L('给 {name} 选声音…','Choose {name}’s voice…',{name:voiceName(current)})),h('span',{className:'mk-grow'}),h(Action,{kind:'sm primary',icon:'upload',onClick:()=>setDialog('batch')},L('批量准备…','Prepare several…')))),
   h('div',{className:'vx-side'},h(VoiceWhere,{provider:active?'minimax':'local',disabled:working,onChange:route=>route==='minimax'?selectCloudRoute(run,providerId):run('builtin-cloud-route',{route:`local:${snapshot?.state?.engine??'breeze'}`})}),
    h(AccountCard,{cloud,status,onManage:manage}),h(RecognitionCard,{asr:cloud.asr,onAction:run,working}))),
  !retentionAttention&&retention,
  error&&h(Alert,{kind:'err',title:error}),
  dialog==='account'?h(AccountDialog,{cloud,onAction:run,onClose:()=>setDialog(null)}):dialog==='batch'?h(BatchDialog,{cloud,onGetVoicePlugin,onAction:run,onClose:()=>setDialog(null)}):PET_CHARACTERS.some(row=>row.id===dialog)?h(ChooseVoiceDialog,{key:dialog,cloud,onGetVoicePlugin,targetCharacterId:dialog,onAction:run,onClose:()=>setDialog(null)}):null);
}
