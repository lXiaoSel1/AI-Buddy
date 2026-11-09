import React,{useEffect,useId,useRef,useState} from 'react';
import {t,locale} from '../i18n.mjs';
import {CloudDesignDialog,CloudCharacterFace,cloudCharacterId,cloudCharacterLabel,cloudIcon} from './cloud-design-ui.mjs';

const h=React.createElement;
const emptyConnections={selectedId:null,items:[]};
const models=['speech-2.8-turbo','speech-2.8-hd'];
const pendingStates=new Set(['running','preparing','cancelling','cancel-requested']);
const batchBusy=batch=>batch?.running===true||pendingStates.has(batch?.state??batch?.status);
const freshDraft=()=>({name:'',provider:locale()==='en'?'minimax-global':'minimax',model:models[0],key:''});
const draftOf=row=>({...freshDraft(),id:row.id,name:row.name,provider:row.provider,model:row.model,configured:row.configured,originalProvider:row.provider,originalConfigured:row.configured});
const stageLabel=stage=>t(({ready:'已就绪，待试听',active:'已激活，待试听',activated:'已激活，待试听',reused:'已复用','reuse-existing':'已复用',prepared:'已准备，待激活','prepared-awaiting-activation':'已准备，待激活','prepared-awaiting-first-synthesis-and-listening':'已准备，待激活与试听',planned:'等待准备',pending:'等待准备','upload-confirmed':'参考音已上传',uploaded:'参考音已上传','clone-confirmed':'已克隆，待激活',cloned:'已克隆，待激活','activation-confirmed':'已激活，待核对','activation-confirmed-query-pending':'首次合成已确认，待查询核对','activation-pending':'待首次合成激活','upload-submitted':'已提交参考音上传','clone-submitted':'已提交克隆','activation-submitted':'已提交首次合成',unknown:'结果未知，待核对','remote-unknown':'结果未知，待核对',expired:'音色已过期','account-confirmation-required':'账号待核对','not-prepared':'尚未准备',failed:'失败',missing:'缺少声音档案','profile-missing':'缺少声音档案','profile-incomplete':'部分声音档案缺失',profileMissing:'声音档案缺失',cancelled:'已取消',interrupted:'已中断',activating:'参考录音已上传，正在激活',preparing:'正在准备',running:'正在准备',cancelling:'正在取消…','cancel-requested':'正在取消…',complete:'本批准备已结束',completed:'本批准备已结束',idle:'尚未准备'})[stage]??'等待核对');
const safeVoiceId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,256}$/.test(value)?value:'';
const categoryLabels={system_voice:'系统音色',voice_cloning:'克隆音色',voice_generation:'设计音色'};
const accountReasons={CLOUD_REMOTE_1008:'MiniMax 余额不足，请充值后手动重试',CLOUD_REMOTE_1004:'MiniMax 鉴权失败，请检查 API Key 和账号权限',CLOUD_REMOTE_1002:'MiniMax 请求频率受限，请稍后手动重试'};
export function cloudVoiceError(error){
  const code=/^(?:CLOUD|VOICE)_[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'';
  const message=accountReasons[code]??(code.startsWith('CLOUD_REMOTE')?'MiniMax 请求未成功，请检查账户状态和音色权限':typeof error?.message==='string'?error.message:typeof error==='string'?error:'云配音操作未完成，请检查配置后重试');
  return t(message)+(code?' · '+code:'');
}
const selectionOf=(state,selected)=>({scope:state?.scope,profileId:state?.profile?.id,profileVersion:state?.profile?.version,cloudConnectionId:selected?.id});
const selectionKeyOf=(state,selected,revision=0)=>JSON.stringify([revision,state?.selectedPackageId,state?.engine,selected,selectionOf(state,selected)]);

export function CloudVoiceConnectionEditor({draft,onChange,onSave,onCancel,busy=false,formId,actions=true}){
  const field=(name,label,type='text',placeholder='')=>h('label',{className:'ws-fld'},h('span',null,t(label)),h('input',{'data-cloud-field':name,'aria-label':t(label),type,value:draft[name]??'',autoComplete:'off',spellCheck:false,disabled:busy,placeholder:t(placeholder),onChange:e=>onChange({...draft,[name]:e.target.value})}));
  return h('form',{id:formId,className:'vx-form vx-cfgform','data-cloud-editor':true,onSubmit:e=>{e.preventDefault();if(!busy&&draft.name.trim()&&(draft.configured||draft.key.trim()))void onSave();}},
    h('h4',null,t(draft.id?'编辑配置':'新增配置')),
    h('div',{className:'ws-fgrid'},field('name','名字'),
      h('label',{className:'ws-fld model-field'},h('span',null,t('地区')),h('select',{'aria-label':t('云配音地区'),'data-cloud-field':'provider',value:draft.provider,disabled:busy,onChange:e=>onChange({...draft,provider:e.target.value,key:'',configured:e.target.value===draft.originalProvider&&draft.originalConfigured===true})},h('option',{value:'minimax'},t('中国大陆')),h('option',{value:'minimax-global'},t('国际')))),
      h('label',{className:'ws-fld'},h('span',null,t('模型')),h('select',{'aria-label':t('云配音模型'),'data-cloud-field':'model',value:draft.model,disabled:busy,onChange:e=>onChange({...draft,model:e.target.value})},...models.map(model=>h('option',{key:model,value:model},model)))),
      field('key','MiniMax API Key','password',draft.configured?'已保存；留空保留原 Key':'粘贴 API Key')),
    h('p',{className:'settings-note'},cloudIcon('shield',14),t('Key 加密保存在这台电脑上，保存后不会再显示。保存配置不会上传任何声音。'),' ',t('更改地区后，请填写该地区平台的 API Key')),
    actions&&h('div',{className:'ws-srow'},h('button',{type:'button',className:'ui-btn sm',disabled:busy,onClick:onCancel},t('取消')),h('button',{type:'submit',className:'ui-btn sm primary','data-cloud-save':true,disabled:busy||!draft.name.trim()||!draft.configured&&!draft.key.trim()},t('保存'))));
}

export function CloudVoiceConnectionManager({connections=emptyConnections,session,onClose,locked=false,error:sessionError=''}){
  const [draft,setDraft]=useState(freshDraft),[busy,setBusy]=useState(false),[error,setError]=useState(''),flight=useRef(false),formId=useId();
  async function run(op,payload,after){
    if(flight.current||locked)return;
    flight.current=true;setBusy(true);setError('');
    try{const result=await session?.runAction(op,payload);if(result===undefined)return;after?.(result);if(result.warningCode)setError(cloudVoiceError({code:result.warningCode,message:result.message}));}catch(error){setError(String(error?.message??error));}
    finally{flight.current=false;setBusy(false);}
  }
  const disabled=busy||locked;
  return h(CloudDesignDialog,{title:t('云配音配置'),onClose,subtitle:t('两个语音插件共用这些配置。'),footer:h(React.Fragment,null,h('button',{type:'button',className:'ui-btn ghost',onClick:onClose},t('取消')),h('button',{type:'submit',form:formId,className:'ui-btn primary','data-cloud-save':true,disabled:disabled||!draft.name.trim()||!draft.configured&&!draft.key.trim()},t('保存')))},
    h('div',{'data-cloud-manager':true},
      h('div',{className:'vx-cfglist'},...connections.items.map(row=>h('article',{className:'ws-card ws-prof'+(row.id===connections.selectedId?' using':''),key:row.id,'data-cloud-profile':row.id},
        h('div',{className:'ws-src-head'},h('div',null,h('b',null,row.name),h('small',null,'MiniMax · '+row.model)),row.id===connections.selectedId&&h('span',{className:'ws-tag'},t('正在使用'))),
        h('p',{className:'ws-muted'},t(row.configured?'Key 已保存':'需要 API Key')),
        h('div',{className:'ws-src-foot'},row.id!==connections.selectedId&&h('button',{type:'button',className:'ui-btn sm primary',disabled,'data-cloud-use':row.id,onClick:()=>run('cloud-connection-select',{id:row.id})},t('使用此配置')),
          h('button',{type:'button',className:'ui-btn sm',disabled,'data-cloud-edit':row.id,onClick:()=>setDraft(draftOf(row))},t('编辑')),
          h('button',{type:'button',className:'ui-btn sm ghost',disabled,'data-cloud-remove':row.id,onClick:()=>run('cloud-connection-remove',{id:row.id})},t('删除')))))),
      draft.id&&h('button',{type:'button',className:'ui-btn sm ghost','data-cloud-new':true,disabled,onClick:()=>setDraft(freshDraft())},t('新增配置')),
      h(CloudVoiceConnectionEditor,{draft,onChange:setDraft,busy:disabled,formId,actions:false,onCancel:()=>setDraft(freshDraft()),onSave:async()=>{
        const submitted={...(draft.id?{id:draft.id}:{}),name:draft.name.trim(),provider:draft.provider,model:draft.model,...(draft.key.trim()?{key:draft.key.trim()}:{})};
        // Do not retain the submitted password in the editor after IPC starts.
        setDraft(current=>({...current,key:''}));
        await run('cloud-connection-save',submitted,()=>setDraft(freshDraft()));
      }}),
      (error||sessionError)&&h('p',{role:'alert',className:'settings-error'},error||sessionError)));
}

const uniqueItems=batch=>{
  const rows=Array.isArray(batch?.items)?batch.items:Array.isArray(batch?.results)?batch.results:[];
  return [...new Map(rows.map((row,i)=>[row.characterId??row.id??i,row])).values()];
};
const rowStage=row=>row.status??row.state??row.stage;
const readyStates=new Set(['ready','active','activated','reused','reuse-existing']);
const busyRowStates=new Set(['preparing','running','activating','upload-submitted','clone-submitted','activation-submitted']);
const missingStates=new Set(['missing','profile-missing','profile-incomplete','profileMissing']);
const rowTone=row=>readyStates.has(rowStage(row))?'ok':busyRowStates.has(rowStage(row))?'busy':missingStates.has(rowStage(row))?'warn':['failed','unknown','remote-unknown','expired','account-confirmation-required','unavailable','activation-confirmed-query-pending'].includes(rowStage(row))?'warn':'idle';
const unpickable=row=>['ok','busy'].includes(rowTone(row))||missingStates.has(rowStage(row));
function CloudCharacterRows({items,currentId,selectedIds,onToggle,onReclone,locked=false}){
  return h('ul',{className:'vx-clist'+(onToggle?' pick':'')},...items.map(row=>{
    const id=cloudCharacterId(row),tone=rowTone(row),stage=rowStage(row),label=missingStates.has(stage)?t('还没有声音档案'):stage==='not-prepared'||stage==='idle'?t('还没准备'):stageLabel(stage);
    return h('li',{key:id,className:'vx-crow'+(id===currentId?' cur':'')},
      onToggle&&h('input',{type:'checkbox',className:'vx-chk','data-cloud-character':id,'aria-label':cloudCharacterLabel(row),checked:selectedIds.includes(id),disabled:locked||unpickable(row),onChange:e=>onToggle(id,e.target.checked)}),
      h(CloudCharacterFace,{row}),h('b',null,cloudCharacterLabel(row)),id===currentId&&!onToggle&&h('span',{className:'ws-tag'},t('当前角色')),h('span',{className:'mk-grow'}),
      h('small',{className:'vx-cst '+tone},tone==='busy'?h('span',{className:'ui-spinner','aria-hidden':true}):h('i',{className:'vx-vdot','aria-hidden':true}),label),
      stage==='expired'&&h('span',{className:'vx-cloud-row-error'},t('这个云端音色已经过期。')),
      stage==='expired'&&onReclone&&h('button',{type:'button',className:'ui-btn sm','data-cloud-reclone':id,disabled:locked,onClick:()=>onReclone(id)},t('重新克隆…')),
      (row.message||row.code)&&h('span',{className:'vx-cloud-row-error',role:stage==='failed'?'alert':undefined},cloudVoiceError(row)));
  }));
}

export function CloudVoiceBatchStatus({batch,design=false}){
  if(!batch)return null;
  const items=uniqueItems(batch),counts=batch.counts??{},total=batch.total??items.length;
  if(design)return h('div',{'data-cloud-batch':true,'aria-live':'polite'},h(CloudCharacterRows,{items}),batch.message&&h('p',{role:batch.state==='failed'?'alert':'status',className:'settings-note'},cloudVoiceError(batch)));
  return h('div',{'data-cloud-batch':true,'aria-live':'polite'},
    h('p',{role:'status'},stageLabel(batch.state??batch.status),total>0?' · '+t('本批角色：{count}').replace('{count}',String(total)):''),
    Object.keys(counts).length>0&&h('p',{className:'ws-muted'},...Object.entries(counts).filter(([,count])=>typeof count==='number'&&count>0).map(([stage,count],i)=>h('span',{key:stage},(i?' · ':'')+stageLabel(stage)+' '+count))),
    items.length>0&&h('ul',{className:'settings-note'},...items.map((row,i)=>h('li',{key:row.characterId??row.id??i},cloudCharacterLabel(row)+' · '+((row.state??row.status??row.stage)==='reuse-existing'?t('已复用'):stageLabel(row.state??row.status??row.stage)),(row.message||row.code)?' · '+(row.message||accountReasons[row.code]?cloudVoiceError(row):row.code):''))),
    batch.message&&h('p',{role:batch.state==='failed'?'alert':'status',className:'settings-note'},cloudVoiceError(batch)));
}

export function CloudVoiceSettings({snapshot,session,whereControl,browsedPackageId}){
  const state=snapshot?.state,connections=state?.cloudConnections??emptyConnections,selected=connections.items.find(row=>row.id===connections.selectedId),batch=snapshot?.cloudBatch??state?.cloudBatch;
  const [manage,setManage]=useState(false);
  const selectionUnavailable=!!browsedPackageId&&browsedPackageId!==state?.selectedPackageId,preparing=snapshot?.cloudBatchWorking||batchBusy(batch),locked=!!snapshot?.working||preparing||selectionUnavailable;
  const selectionKey=selectionKeyOf(state,selected,snapshot?.cloudSelectionRevision);
  return h('div',{className:'vx-cloud','data-cloud-voice-settings':true},
    selectionUnavailable&&h('p',{className:'settings-note',role:'status'},t('先启动此插件，再为它选择云端音色；浏览页签不会切换当前引擎。')),
    state?.cloud?.message&&h('p',{role:state.cloud.state==='ready'?'status':'alert',className:'settings-note'},cloudVoiceError(state.cloud)),
    h(CloudVoiceChoices,{key:selectionKey+':'+(browsedPackageId??''),selectionUnavailable,snapshot,session,state,selected,batch,selectionKey,locked,preparing,whereControl,onManage:()=>setManage(true)}),
    manage&&h(CloudVoiceConnectionManager,{connections,session,onClose:()=>setManage(false),locked:preparing,error:snapshot?.error}));
}

function CloudVoiceChoices({snapshot,session,state,selected,batch,selectionKey,locked,preparing,whereControl,onManage,selectionUnavailable=false}){
  const [voiceOpen,setVoiceOpen]=useState(false),[batchOpen,setBatchOpen]=useState(!!preparing),[batchProgress,setBatchProgress]=useState(!!preparing);
  const [voices,setVoices]=useState(null),[voiceId,setVoiceId]=useState(''),[search,setSearch]=useState(''),[category,setCategory]=useState(''),[voiceBusy,setVoiceBusy]=useState(false),[voiceMessage,setVoiceMessage]=useState(''),[voiceError,setVoiceError]=useState('');
  const [selectedIds,setSelectedIds]=useState([]),[confirm,setConfirm]=useState(false),[preview,setPreview]=useState(null),[previewBusy,setPreviewBusy]=useState(false),[previewError,setPreviewError]=useState('');
  const alive=useRef(true),voiceFlight=useRef(false),previewFlight=useRef(0),prepareFlight=useRef(false),choiceRevision=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const items=uniqueItems(batch),currentCharacter=items.find(row=>(row.characterId??row.id)===state?.scope?.characterId),characterLabel=currentCharacter?cloudCharacterLabel(currentCharacter):state?.characterName??state?.scope?.characterName??(state?.scope?.characterId?cloudCharacterLabel({characterId:state.scope.characterId}):t('尚未选择角色'));
  const expectedSelection=selectionOf(state,selected),isCurrent=()=>alive.current&&(!session?.snapshot||selectionKey===selectionKeyOf(session.snapshot().state,session.snapshot().state?.cloudConnections?.items?.find(row=>row.id===session.snapshot().state?.cloudConnections?.selectedId),session.snapshot().cloudSelectionRevision));
  const canQuery=!!selected?.configured&&!!state?.scope&&!!state?.profile?.id&&!locked;
  function actionError(error,fallback){return error?cloudVoiceError(error):session?.snapshot?.().error||t(fallback);}
  async function refreshVoices(){
    if(!canQuery||voiceFlight.current||!isCurrent())return;
    voiceFlight.current=true;setVoiceBusy(true);setVoices(null);setVoiceId('');setVoiceMessage('');setVoiceError('');
    try{
      const result=await session?.runAction('cloud-voices',{expectedSelection});
      if(!isCurrent())return;
      if(!Array.isArray(result)){setVoiceError(actionError(null,'音色列表读取失败，请手动重试'));return;}
      setVoices(result.filter(row=>safeVoiceId(row?.voiceId)).map(row=>({voiceId:row.voiceId,name:typeof row.name==='string'?row.name:row.voiceId,category:typeof row.category==='string'?row.category:''})));
    }catch(error){if(isCurrent())setVoiceError(actionError(error));}
    finally{voiceFlight.current=false;if(isCurrent())setVoiceBusy(false);}
  }
  async function bindVoice(nextVoiceId=voiceId){
    if(!canQuery||voiceFlight.current||!isCurrent()||!voices?.some(row=>row.voiceId===nextVoiceId))return;
    voiceFlight.current=true;setVoiceBusy(true);setVoiceMessage('');setVoiceError('');
    try{
      const result=await session?.runAction('cloud-bind',{voiceId:nextVoiceId,expectedSelection});
      if(!isCurrent())return;
      if(!result||result.state!=='ready'||result.voiceId!==nextVoiceId){setVoiceError(actionError(null,'音色绑定未完成，请核对当前角色状态'));return;}
      setVoiceId(nextVoiceId);setVoiceMessage(t('已绑定到当前角色：')+characterLabel+' · '+nextVoiceId);setPreview(null);previewFlight.current++;
    }catch(error){if(isCurrent())setVoiceError(actionError(error));}
    finally{voiceFlight.current=false;if(isCurrent())setVoiceBusy(false);}
  }
  function toggleCharacter(id,checked){
    if(locked||unpickable(items.find(row=>cloudCharacterId(row)===id)??{}))return;
    choiceRevision.current++;previewFlight.current++;setPreview(null);setPreviewError('');setPreviewBusy(false);
    setSelectedIds(current=>checked?[...current.filter(value=>value!==id),id]:current.filter(value=>value!==id));
  }
  async function previewBatch(){
    if(locked||!selected?.configured||!selectedIds.length||!isCurrent())return;
    const ids=[...selectedIds],ticket=++previewFlight.current,choice=choiceRevision.current;
    setConfirm(true);setPreview(null);setPreviewError('');setPreviewBusy(true);
    try{
      const result=await session?.runAction('cloud-batch-preview',{selectedCharacterIds:ids});
      if(!isCurrent()||ticket!==previewFlight.current||choice!==choiceRevision.current)return;
      const next=result?.cloudBatch??result?.batch??result,plan=next?.plan;
      if(!plan||!Array.isArray(plan.selectedCharacterIds)||plan.selectedCharacterIds.length!==ids.length||!ids.every(id=>plan.selectedCharacterIds.includes(id))||!plan.planHash){setPreviewError(actionError(null,'费用预览未完成，请关闭后重新确认'));return;}
      setPreview({batch:next,plan,ids,choice,binding:state?.cloud?.voiceId,expiresAt:Date.now()+5*60*1000});
    }catch(error){if(isCurrent()&&ticket===previewFlight.current)setPreviewError(actionError(error));}
    finally{if(isCurrent()&&ticket===previewFlight.current)setPreviewBusy(false);}
  }
  useEffect(()=>{
    if(!preview)return;
    const timer=setTimeout(()=>{setPreview(null);setPreviewError(t('费用预览已失效，请关闭后重新确认'));},Math.max(0,preview.expiresAt-Date.now()));
    return()=>clearTimeout(timer);
  },[preview]);
  const plan=preview?.plan,validPlan=!!plan&&preview.expiresAt>Date.now()&&preview.binding===state?.cloud?.voiceId&&preview.choice===choiceRevision.current&&selectedIds.length===preview.ids.length&&selectedIds.every(id=>preview.ids.includes(id))&&plan.blockedCount===0&&Number.isInteger(plan.cloneCount)&&plan.cloneCount>=0&&Number.isInteger(plan.activationCount)&&plan.activationCount>=0&&Number.isInteger(plan.reuseCount)&&plan.reuseCount>=0&&plan.selectedCount===selectedIds.length&&['CNY','USD'].includes(plan.pricing?.currency)&&Number.isFinite(plan.pricing?.cloneEstimate)&&plan.pricing.cloneEstimate>=0&&Number.isFinite(plan.pricing?.cloneUnitPrice)&&plan.pricing.cloneUnitPrice>=0&&typeof plan.pricing?.checkedOn==='string';
  async function prepareBatch(){
    if(locked||!validPlan||!selected?.configured||prepareFlight.current||!isCurrent())return;
    prepareFlight.current=true;const payload={selectedCharacterIds:[...preview.ids],planHash:plan.planHash,consentUpload:true,consentActivation:true};
    setConfirm(false);setPreview(null);setBatchProgress(true);setBatchOpen(true);try{await session?.runAction('cloud-batch-prepare',payload);}finally{prepareFlight.current=false;}
  }
  const filtered=voices?.filter(row=>(!category||row.category===category)&&(!search.trim()||(row.name+' '+row.voiceId).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))??[];
  const closeConfirm=()=>{previewFlight.current++;setConfirm(false);setPreview(null);setPreviewBusy(false);};
  const amount=plan?.pricing?.cloneEstimate,unitPrice=plan?.pricing?.cloneUnitPrice,currency=plan?.pricing?.currency,money=value=>typeof value==='number'&&Number.isFinite(value)?(currency==='CNY'?'¥':currency==='USD'?'US$':currency+' ')+value.toFixed(2):t('待核对');
  const sourceUrl=plan?.pricing?.sourceUrl,sourceAllowed=typeof sourceUrl==='string'&&/^https:\/\/platform\.minimax\.(?:cn|io)\/(?:docs\/pricing\/|subscribe\/token-plan(?:\?|$))/.test(sourceUrl);
  const readyCount=items.filter(row=>rowTone(row)==='ok').length,preparingCount=items.filter(row=>rowTone(row)==='busy').length;
  const batchRows=selectedIds.length?items.filter(row=>selectedIds.includes(cloudCharacterId(row))):items;
  const completed=batchRows.filter(row=>rowTone(row)==='ok').length,total=batchRows.length;
  const showProgress=preparing||batchProgress;
  const closeBatch=()=>{setBatchOpen(false);if(!preparing){setBatchProgress(false);setSelectedIds([]);}};
  const selectedCount=selectedIds.length,overviewPricing=batch?.plan?.pricing,overviewUnit=overviewPricing?.cloneUnitPrice??(selected?.provider==='minimax-global'?1.5:9.9),overviewCurrency=overviewPricing?.currency??(selected?.provider==='minimax-global'?'USD':'CNY');
  const estimate=(overviewCurrency==='USD'?'US$':'¥')+(selectedCount*overviewUnit).toFixed(2);
  const btn=(label,props={},icon)=>h('button',{type:'button',className:'ui-btn sm',...props},icon&&cloudIcon(icon),label);
  return h(React.Fragment,null,
    h('div',{className:'vx-cols'},
      h('section',{className:'ws-card vx-voices'},
        h('div',{className:'vx-sec-h'},h('h3',{className:'ws-sec'},t('角色的云端声音')),h('small',{className:'ws-muted'},t('{ready} 个已就绪 · {preparing} 个准备中').replace('{ready}',String(readyCount)).replace('{preparing}',String(preparingCount)))),
        h(CloudCharacterRows,{items,currentId:state?.scope?.characterId,locked,onReclone:id=>{if(locked)return;choiceRevision.current++;previewFlight.current++;setPreview(null);setPreviewError('');setSelectedIds([id]);setBatchProgress(false);setBatchOpen(true);setVoiceOpen(false);}}),
        h('div',{className:'vx-voices-f'},btn(t('给 {name} 换音色…').replace('{name}',characterLabel),{'data-cloud-open-voices':true,disabled:selectionUnavailable,onClick:()=>{setVoiceOpen(true);setBatchOpen(false);}},'speaker'),h('span',{className:'mk-grow'}),btn(t('批量准备…'),{className:'ui-btn sm primary','data-cloud-open-batch':true,disabled:selectionUnavailable,onClick:()=>{setBatchProgress(!!preparing);setBatchOpen(true);setVoiceOpen(false);}},'upload'))),
      h('div',{className:'vx-side'},whereControl,
        h('section',{className:'ws-card vx-cfg'},h('div',{className:'vx-sec-h'},h('h3',{className:'ws-sec'},t('云配音账号')),btn(t('管理配置'),{className:'ui-btn sm ghost','data-manage-connections':'voice',onClick:onManage},'sliders')),
          h('div',{className:'vx-cfgcard'},cloudIcon('key',18),h('div',null,h('b',null,selected?.name??t('尚未配置')),h('small',null,selected?'MiniMax · '+selected.model+' · '+t(selected.configured?'Key 已保存在本机':'需要 API Key'):t('还没有配置'))),selected&&h('span',{className:'ws-tag'},t('正在使用'))),
          h('ul',{className:'vx-price'},h('li',null,h('b',null,t('克隆音色')),h('span',null,t('每个 {price}，第一次用它合成时收取').replace('{price}',(overviewCurrency==='USD'?'US$':'¥')+overviewUnit.toFixed(2)))),h('li',{className:'ws-muted'},t('价格核对于 {date}，以 MiniMax 账户实际扣费为准。').replace('{date}',overviewPricing?.checkedOn??'2026-11-07'),' ',h('a',{href:selected?.provider==='minimax-global'?'https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise':'https://platform.minimax.cn/docs/pricing/overview',target:'_blank',rel:'noreferrer'},t('MiniMax 官方计费说明'))))))),
    voiceOpen&&h(CloudDesignDialog,{title:t('给 {name} 换云端音色').replace('{name}',characterLabel),subtitle:t('只改 {name}。用的是「{config}」。').replace('{name}',characterLabel).replace('{config}',selected?.name??t('尚未配置')),onClose:()=>setVoiceOpen(false),footer:btn(t('完成'),{className:'ui-btn primary',onClick:()=>setVoiceOpen(false)})},
      h('section',{'data-cloud-existing-voices':true},
        h('div',{className:'vx-vfilter'},h('div',{className:'ui-seg',role:'radiogroup','aria-label':t('音色分类')},...Object.entries({'':'全部',...categoryLabels}).map(([value,label])=>h('button',{key:value,type:'button',role:'radio','aria-checked':category===value,disabled:voiceBusy,onClick:()=>{setCategory(value);setVoiceId('');}},t(label)))),
          h('label',{className:'vx-search'},cloudIcon('search'),h('input',{'aria-label':t('搜索音色'),placeholder:t('搜索音色'),value:search,disabled:voiceBusy,onChange:e=>{setSearch(e.target.value);setVoiceId('');}})),
          btn(null,{className:'ui-icon-btn','aria-label':t('刷新音色列表'),title:t('刷新音色列表'),'data-cloud-voices-refresh':true,disabled:!canQuery||voiceBusy,onClick:refreshVoices},'refresh')),
        !voices&&!voiceBusy&&h('p',{className:'ws-muted'},t('刷新音色列表以读取当前账户的音色。')),
        h('ul',{className:'vx-vlist'},...filtered.slice().sort((a,b)=>Number(b.voiceId===state?.cloud?.voiceId)-Number(a.voiceId===state?.cloud?.voiceId)).map(row=>{const on=row.voiceId===(voiceId||state?.cloud?.voiceId);return h('li',{key:row.voiceId,className:'vx-vrow'+(on?' on':'')},cloudIcon('speaker'),h('div',null,h('b',null,row.name),h('small',null,t(categoryLabels[row.category]??'其他音色'),' · ',h('code',null,row.voiceId))),on?h('span',{className:'ws-tag'},t('正在用')):btn(t('用这个'),{'data-cloud-voice-bind':row.voiceId,disabled:!canQuery||voiceBusy,onClick:()=>bindVoice(row.voiceId)}));})),
        voices&&filtered.length===0&&h('p',{className:'ws-muted'},t('没有匹配的音色')),
        h('p',{className:'settings-note'},cloudIcon('info',14),t('选已有的系统音色不收克隆费，文字合成照常计费。换好以后在聊天里听一下。')),
        voiceMessage&&h('p',{role:'status'},voiceMessage),voiceError&&h('p',{role:'alert',className:'settings-error'},voiceError))),
    batchOpen&&!confirm&&h(CloudDesignDialog,{title:t(showProgress?'正在准备云端声音':'批量准备云端声音'),subtitle:showProgress?undefined:t('已就绪、准备中、没有声音档案的角色不能选。'),onClose:closeBatch,width:600,noActions:!showProgress,footer:showProgress?h(React.Fragment,null,preparing&&btn(t(snapshot?.cloudBatchCancelling?'正在取消…':'停止剩下的'),{className:'ui-btn ghost','data-cloud-cancel':true,disabled:!!snapshot?.cloudBatchCancelling,onClick:()=>void session?.runAction('cloud-batch-cancel',{})},'stop'),btn(t('关闭'),{className:'ui-btn primary',onClick:closeBatch})):null},
      h('section',{'data-cloud-clone-section':true},showProgress?h(React.Fragment,null,h(CloudVoiceBatchStatus,{batch:{...batch,items:batchRows},design:true}),h('div',{className:'vx-compprog'},h('div',{className:'ws-meter',role:'progressbar','aria-label':t('云端声音准备进度'),'aria-valuemin':0,'aria-valuemax':total||undefined,'aria-valuenow':total?completed:undefined},total?h('i',{style:{width:(completed/total*100)+'%'}}):null),h('small',{className:'ws-muted'},t('{done} / {total} 完成 · 可以关掉这个窗口，后台会继续').replace('{done}',String(completed)).replace('{total}',String(total))))):h(React.Fragment,null,
        h(CloudCharacterRows,{items,selectedIds,onToggle:toggleCharacter,locked}),
        h('div',{className:'vx-sum'},h('span',null,h('b',null,t('已选 {count} 个角色').replace('{count}',String(selectedCount))),' · ',t('预计克隆费 {amount}').replace('{amount}',estimate)),btn(t('下一步：确认费用'),{className:'ui-btn primary','data-cloud-prepare':true,disabled:locked||!selected?.configured||!selectedIds.length,onClick:previewBatch})),
        btn(t('核对准备状态'),{className:'ui-btn sm ghost','data-cloud-preview':true,disabled:!!snapshot?.working||selectionUnavailable,onClick:()=>{if(selectionUnavailable)return;setPreview(null);void session?.runAction('cloud-batch-reconcile',{});}})))),
    confirm&&h(CloudDesignDialog,{title:t('上传 {count} 个角色的声音到 MiniMax？').replace('{count}',String(selectedCount)),onClose:closeConfirm,width:600,footer:h(React.Fragment,null,btn(t('取消'),{className:'ui-btn ghost',onClick:closeConfirm}),btn(t('同意上传，开始准备'),{className:'ui-btn primary','data-cloud-confirm':true,disabled:locked||previewBusy||!validPlan||!selected?.configured,onClick:prepareBatch},'upload'))},
      h('p',null,t('会把下面 {count} 个角色的完整参考录音和文字上传到 MiniMax，并各合成一句来激活音色。').replace('{count}',String(selectedCount))),
      h('p',{className:'ws-muted'},t('本次使用配置：')+(selected?.name??t('尚未配置'))),
      h('div',{className:'vx-faces'},...selectedIds.map(id=>{const row=items.find(row=>cloudCharacterId(row)===id)??{characterId:id};return h('span',{key:id},h(CloudCharacterFace,{row}),cloudCharacterLabel(row));})),
      previewBusy&&h('p',{role:'status'},t('正在核对所选角色与费用…')),previewError&&h('p',{role:'alert',className:'settings-error'},previewError),
      plan&&h(React.Fragment,null,h('dl',{className:'vx-cost'},
        h('div',null,h('dt',null,t('新克隆音色')),h('dd',{'data-cloud-clone-count':true},String(plan.cloneCount))),
        h('div',null,h('dt',null,t('复用已有音色')),h('dd',null,String(plan.reuseCount))),
        h('div',null,h('dt',null,t('克隆音色费')),h('dd',{'data-cloud-cost':true},money(amount))),
        h('div',null,h('dt',null,t('激活用的文字合成')),h('dd',null,t('另按字数计费')))),
        h('p',{className:'settings-note'},t('首次合成激活：{count}').replace('{count}',String(plan.activationCount))+' · '+t('首次使用计费音色：{count}').replace('{count}',String(plan.firstUseCount??plan.activationCount))),
        h('p',{className:'settings-note'},t('每个首次使用音色参考价：')+money(unitPrice)),
        h('p',{className:'settings-note'},cloudIcon('info',14),t('参考估价，以 MiniMax 账户计费为准。已有克隆待激活音色的首次合成也收取音色费，文字合成费另外计算。')),
        h('p',{className:'settings-note'},t('价格核对日期：')+(plan.pricing?.checkedOn??t('待核对'))),sourceAllowed&&h('a',{href:sourceUrl,target:'_blank',rel:'noreferrer'},t('MiniMax 官方计费说明')),
        plan.blockedCount>0&&h('p',{role:'alert',className:'settings-error'},t('有 {count} 项状态无法确认，请先核对，暂不提交。').replace('{count}',String(plan.blockedCount))),
        plan.actions?.length>0&&h('ul',{className:'vx-cloud-plan-actions'},...plan.actions.map((row,index)=>h('li',{key:index},cloudCharacterLabel(items.find(item=>cloudCharacterId(item)===row.characterId)??row)+' · '+t(({'new-clone':'新增克隆',activation:'首次合成激活','reuse-existing':'复用已有音色','blocked-unknown':'状态待核对'})[row.action]??'状态待核对'),row.code?' · '+cloudVoiceError(row):'')))),
      h('p',{className:'settings-note'},t('取消只停止后续任务，已提交的克隆或合成可能仍完成或收费。完成后仍需核对激活状态并试听。'))));
}
