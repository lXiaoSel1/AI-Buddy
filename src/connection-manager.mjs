import {t} from './i18n.mjs';
import React,{useEffect,useRef,useState} from 'react';
import {CG_PROTOCOL_NAMES} from './cg-presets.mjs';
const h=React.createElement;
const chatProtocols={get 'chat-completions'(){return t("OpenAI 兼容 Chat Completions")},responses:'OpenAI Responses',get gemini(){return t("Gemini 原生")},anthropic:'Claude Messages'};
const jobNames={get queued(){return t("排队中")},get generating(){return t("绘制中")},get ready(){return t("已完成")},get failed(){return t("失败")},get cancelled(){return t("已取消")}};
export function ConnectionManager({type,initial}){
 const cg=type==='cg',api=cg?window.whale.cg:window.whale.models;
 const [view,setView]=useState(initial),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[models,setModels]=useState([]),[testId,setTestId]=useState(null),[image,setImage]=useState(null);
 const dialog=useRef(null),running=useRef(false);
 const attr=(key,value=true)=>({['data-'+type+'-'+key]:value});
 useEffect(()=>{if(initial)setView(initial);},[initial]);
 useEffect(()=>{let active=true;api.get().then(value=>{if(active)setView(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 useEffect(()=>{if(draft&&dialog.current&&!dialog.current.open){dialog.current.showModal();dialog.current.querySelector('input')?.focus();}},[!!draft]);
 const testJob=view?.jobs?.find(job=>job.id===testId);
 useEffect(()=>{let active=true;if(testJob?.status==='ready')api.image(testId).then(value=>{if(active)setImage(value.dataUrl);}).catch(e=>{if(active)setError(e.message);});if(testJob?.status==='failed')setError(testJob.error);return()=>{active=false;};},[testId,testJob?.status]);
 const selected=view?.profiles.find(profile=>profile.id===view.activeId),locked=busy||!!view?.profiles.find(profile=>profile.id===draft?.id)?.locked;
 const lockReason=cg?t("CG 正在绘制，完成后可切换或修改使用中的配置。"):t("正在生成对话，完成后可切换或修改使用中的配置。");
 const begin=profile=>{setDraft({...profile,key:'',...(cg?{options:{references:true,size:'',quality:'auto',...profile.options}}:{})});setModels(profile.models??[]);setError('');setMessage('');};
 function create(kind){const preset=view.presets.find(row=>row.kind===kind);begin({...preset,model:kind==='codex'?view.codexModel:cg&&kind==='wan'?'wan2.6-image':preset.model??'',keyConfigured:false,...(cg?{options:{references:preset.references,size:preset.protocol==='ark-images'?'2K':'',quality:'auto'}}:{})});}
 const change=(key,value)=>setDraft(previous=>({...previous,[key]:value}));
 const option=(key,value)=>setDraft(previous=>({...previous,options:{...previous.options,[key]:value}}));
 async function reload(){const next=await api.get();setView(next);return next;}
 async function run(fn){if(running.current)return;running.current=true;setBusy(true);setError('');setMessage('');try{await fn();}catch(e){setError(e.message);}finally{running.current=false;setBusy(false);}}
 async function save(use){
  if(locked||(use&&view.busy))return;
  await run(async()=>{
   const saved=await api.save({...draft,models,useAfterSave:use});
   // Remove the submitted secret even when activation only partly succeeds.
   begin(saved);await reload();
   if(use){try{await api.activate(saved.id);}catch(e){await reload();setMessage(t("已保存，暂未使用"));setError(e.message);return;}}
   await reload();setDraft(null);setMessage(use?t("已保存并使用：")+saved.name:t("已保存，可在通用设置选择使用"));
  });
 }
 async function useProfile(profile){await run(async()=>{await api.activate(profile.id);await reload();setMessage(t("当前使用：")+profile.name);});}
 async function removeProfile(profile){await run(async()=>{await api.remove(profile.id);await reload();setMessage(t("配置已删除"));});}
 function field(key,label,inputType='text',placeholder=''){return h('label',{className:'model-field'},h('span',null,label),h('input',{...attr('field',key),type:inputType,value:draft[key]??'',disabled:locked,autoComplete:'off',spellCheck:false,placeholder,onChange:e=>change(key,e.target.value),...(key==='model'?{list:'whale-'+type+'-model-list'}:{})}));}
 const feedback=()=>h(React.Fragment,null,message&&h('p',{...attr('message'),role:'status'},message),error&&h('p',{...attr('error'),className:'settings-error',role:'alert'},error));
 const testOutput=()=>cg&&h(React.Fragment,null,testJob&&h('p',{...attr('test-status',testJob.status)},t("测试图：")+jobNames[testJob.status]),image&&h('img',{...attr('test-image'),className:'api-test-image',src:image,alt:t("CG 连接测试图")}));
 if(!view)return h('p',null,t("正在读取配置…"));
 return h('section',{className:'card model-settings api-manager',...attr('settings')},
  h('div',{className:'api-manager-heading'},h('div',null,h('h2',null,cg?t("CG 绘图配置"):t("聊天 API 配置")),h('p',{className:'settings-note'},t("选择使用与编辑配置分别操作。"))),h('button',{...attr('new'),className:'api-primary',disabled:busy,onClick:()=>create(view.presets[0].kind)},t("新增配置"))),
  h('p',{className:'api-current',...attr('current')},selected?t("当前使用：")+selected.name+' · '+selected.model:t("尚未配置，请新增配置")),
  h('div',{className:'api-profile-list'},...view.profiles.map(profile=>h('article',{className:'api-profile',key:profile.id,...attr('profile',profile.id)},
   h('div',{className:'api-profile-info'},h('strong',null,profile.name),h('span',null,t(view.presets.find(row=>row.kind===profile.kind)?.name)+' · '+(profile.model||t("未填写模型"))),profile.id===view.activeId&&h('b',{className:'api-current-badge'},t("正在使用")),profile.locked&&h('small',null,t("使用中，暂时锁定"))),
   h('div',{className:'settings-actions'},h('button',{...attr('use',profile.id),className:profile.id===view.activeId?'':'api-primary',disabled:busy||view.busy||profile.id===view.activeId,onClick:()=>useProfile(profile)},profile.id===view.activeId?t("当前使用"):t("使用此配置")),h('button',{...attr('edit',profile.id),disabled:busy||profile.locked,onClick:()=>begin(profile)},t("编辑")),h('button',{...attr('remove',profile.id),disabled:busy||profile.locked,onClick:()=>removeProfile(profile)},t("删除")))))),
  view.busy&&h('p',{className:'settings-note',...attr('lock-reason')},lockReason),
  !draft&&feedback(),!draft&&testOutput(),
  cg&&view.jobs.filter(job=>job.kind!=='test'&&['queued','generating'].includes(job.status)).slice(0,3).map(job=>h('p',{key:job.id,className:'settings-note'},job.label+' · '+jobNames[job.status])),
  draft&&h('dialog',{ref:dialog,className:'api-dialog',...attr('dialog'),'aria-labelledby':'api-'+type+'-dialog-title',onCancel:e=>{e.preventDefault();if(!busy)setDraft(null);}},
   h('form',{className:'model-form',onSubmit:e=>{e.preventDefault();void save(true);}},
    h('div',{className:'api-dialog-heading'},h('h2',{id:'api-'+type+'-dialog-title'},draft.id?t("编辑配置"):t("新增配置")),h('button',{type:'button','aria-label':t("关闭"),disabled:busy,onClick:()=>setDraft(null)},'×')),
    field('name',t("配置名称")),
    h('label',{className:'model-field'},h('span',null,t("提供方")),h('select',{...attr('field','kind'),value:draft.kind,disabled:locked,onChange:e=>{const preset=view.presets.find(row=>row.kind===e.target.value);begin({...preset,id:draft.id,model:e.target.value==='codex'?view.codexModel:cg&&e.target.value==='wan'?'wan2.6-image':preset.model??'',...(cg?{options:{references:preset.references}}:{})});}},...view.presets.map(preset=>h('option',{key:preset.kind,value:preset.kind},t(preset.name))))),
    draft.kind!=='codex'&&h(React.Fragment,null,field('baseUrl',t("服务地址"),'url','https://…/v1'),field('key','API Key','password',draft.keyConfigured?t("已保存；留空保留原 Key"):t("粘贴 API Key"))),
    field('model',t("模型 ID"),'text',t("从列表选择或手动填写")),cg&&draft.protocol==='ark-images'&&h('p',{className:'settings-note'},t("请选择已开通的 Seedream 模型或绘图接入点 ID；支持文生图和角色参考图。")),h('datalist',{id:'whale-'+type+'-model-list'},...models.map(model=>h('option',{key:model.id,value:model.id},model.name))),
    h('details',null,h('summary',null,cg?t("高级图片设置"):t("高级设置")),
     draft.kind!=='codex'&&h('label',{className:'model-field'},h('span',null,cg?t("绘图协议"):t("接口协议")),h('select',{...attr('field','protocol'),value:draft.protocol,disabled:locked,onChange:e=>{change('protocol',e.target.value);if(cg)option('references',!e.target.value.startsWith('wan-t2i'));}},...Object.entries(cg?CG_PROTOCOL_NAMES:chatProtocols).map(([value,label])=>h('option',{key:value,value},t(label))))),
     cg&&h(React.Fragment,null,h('label',{className:'model-clear-key'},h('input',{...attr('option','references'),type:'checkbox',checked:draft.options.references&&!draft.protocol.startsWith('wan-t2i'),disabled:locked||draft.protocol.startsWith('wan-t2i'),onChange:e=>option('references',e.target.checked)}),t("使用角色参考图")),h('p',{className:'settings-note'},draft.options.references&&!draft.protocol.startsWith('wan-t2i')?t("参考图连接：保持角色外观。"):t("纯文生图连接：按角色外观描述绘制。")),draft.kind!=='codex'&&h('label',{className:'model-field'},h('span',null,t("图片尺寸（留空使用默认）")),h('input',{...attr('option','size'),value:draft.options.size,disabled:locked,placeholder:draft.protocol==='ark-images'?'2K / 2560x1440':draft.protocol==='gemini-images'?'1K / 2K':draft.protocol.startsWith('wan-')?'1280*720':'1536x1024 / auto',onChange:e=>option('size',e.target.value)})),draft.protocol==='openai-images'&&h('label',{className:'model-field'},h('span',null,t("质量")),h('input',{...attr('option','quality'),value:draft.options.quality,disabled:locked,onChange:e=>option('quality',e.target.value)}))),
     draft.keyConfigured&&h('label',{className:'model-clear-key'},h('input',{type:'checkbox',checked:!!draft.clearKey,disabled:locked,onChange:e=>change('clearKey',e.target.checked)}),t("清除已保存的 Key"))),
    h('div',{className:'settings-actions'},h('button',{type:'button',...attr('action','list'),disabled:locked||(cg&&view.busy),onClick:()=>run(async()=>{const rows=await api.list(draft);setModels(rows);setMessage(rows.length?t("模型列表已读取"):t("请手动填写模型 ID"));})},t("获取模型列表")),
     (cg||draft.kind!=='codex')&&h('button',{type:'button',...attr('action',cg?'check':'test'),disabled:locked||(cg&&view.busy),onClick:()=>run(async()=>{const result=await api[cg?'check':'test'](draft);setMessage(result.message??t("连接成功"));})},cg?t("测试连接（不出图）"):t("测试连接（调用一次模型）"))),
    cg&&h('div',{className:'settings-actions'},h('button',{type:'button',...attr('action','test-image'),disabled:locked||view.busy,onClick:()=>run(async()=>{const result=await api.testImage(draft);setImage(null);setTestId(result.id);await reload();setMessage(t("测试图已排队"));})},t("生成测试图（调用一次绘图服务）"))),
    view.busy&&h('p',{className:'settings-note'},lockReason),feedback(),testOutput(),
    h('div',{className:'settings-actions api-form-footer'},h('button',{type:'submit',...attr('action','save-use'),className:'api-primary',disabled:locked||view.busy},t("保存并使用")),h('button',{type:'button',...attr('action','save'),disabled:locked,onClick:()=>save(false)},t("仅保存")),h('button',{type:'button',...attr('action','cancel'),disabled:busy,onClick:()=>setDraft(null)},t("取消"))))));
}
