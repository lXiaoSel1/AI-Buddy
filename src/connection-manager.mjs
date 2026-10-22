import {t} from './i18n.mjs';
import React,{useEffect,useRef,useState} from 'react';
import {CG_PROTOCOL_NAMES} from './cg-presets.mjs';
import {profileEffort,effortChoices,effortProtocol,effortSupport} from './reasoning-settings.mjs';
import {DEFAULT_CONTEXT_TOKENS} from './context-capacity.mjs';
import {Icon} from './ui-icons.mjs';
import {Segmented,StatusPill} from './ui-controls.mjs';
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
 const begin=profile=>{const effort=profileEffort(profile),reset=!cg&&effort&&!effortChoices(profile).includes(effort)&&!(profile.kind==='codex'&&effortSupport(profile).source==='unknown');setDraft({...profile,...(!cg?{reasoningEffort:reset?null:effort}:{}),key:'',...(cg?{options:{references:true,size:'',quality:'auto',...profile.options}}:{})});setModels(profile.models??[]);setError('');setMessage(reset?t('原推理档位不适用于当前模型，已选模型默认；保存后生效。'):'');};
 function create(kind){const preset=view.presets.find(row=>row.kind===kind);begin({...preset,model:kind==='codex'?view.codexModel:cg&&kind==='wan'?'wan2.6-image':preset.model??'',keyConfigured:false,...(cg?{options:{references:preset.references,size:preset.protocol==='ark-images'?'2K':'',quality:'auto'}}:{})});}
 const change=(key,value)=>{if(!cg&&['baseUrl','protocol'].includes(key)){setModels([]);setDraft(previous=>({...previous,[key]:value,models:[],reasoningEffort:null}));}else setDraft(previous=>({...previous,[key]:value}));};
 function chooseModel(model){const next={...draft,model},effort=profileEffort(next),reset=!cg&&effort&&!effortChoices(next,models).includes(effort);setDraft({...next,...(reset?{reasoningEffort:null}:{})});if(reset)setMessage(t('原推理档位不适用于当前模型，已选模型默认；保存后生效。'));}
 const effortLevels=draft&&!cg?effortChoices(draft,models):[],configuredEffort=draft?profileEffort(draft):null;
 const option=(key,value)=>setDraft(previous=>({...previous,options:{...previous.options,[key]:value}}));
 async function reload(){const next=await api.get();setView(next);return next;}
 async function run(fn){if(running.current)return;running.current=true;setBusy(true);setError('');setMessage('');try{await fn();}catch(e){setError(e.message);}finally{running.current=false;setBusy(false);}}
 async function refreshModels(){const rows=await api.list(draft),effort=profileEffort(draft),reset=!cg&&effort&&!effortChoices(draft,rows).includes(effort);setModels(rows);if(reset)setDraft(previous=>({...previous,reasoningEffort:null}));setMessage((rows.length?t('已读取 {count} 个模型').replace('{count}',String(rows.length)):t('请手动填写模型 ID'))+(reset?' · '+t('原推理档位不适用于当前模型，已选模型默认；保存后生效。'):''));}
 // Upgrade an old Codex id/name-only cache in the editor without changing the
 // saved connection or starting a chat. The editor stays locked during lookup.
 useEffect(()=>{if(draft&&!cg&&draft.kind==='codex'&&effortSupport(draft,draft.models??[]).source==='unknown')void run(async()=>{try{await refreshModels();}catch(error){setDraft(previous=>previous?{...previous,reasoningEffort:null}:previous);throw error;}});},[!!draft]);
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
 function field(key,label,inputType='text',placeholder='',wide=false){return h('label',{className:'ws-fld model-field'+(wide?' ws-span2':'')},h('span',null,label),h('input',{...attr('field',key),type:inputType,value:draft[key]??'',disabled:locked,autoComplete:'off',spellCheck:false,placeholder,onChange:e=>key==='model'?chooseModel(e.target.value):change(key,e.target.value),...(key==='model'?{list:'whale-'+type+'-model-list'}:{})}));}
 const feedback=()=>h(React.Fragment,null,message&&h('p',{...attr('message'),role:'status',className:'ws-ok-text'},message),error&&h('p',{...attr('error'),className:'settings-error ws-errtxt',role:'alert'},error));
 const testOutput=()=>cg&&h(React.Fragment,null,testJob&&h('p',{...attr('test-status',testJob.status),className:'ws-muted'},t("测试图：")+jobNames[testJob.status]),image&&h('img',{...attr('test-image'),className:'api-test-image',src:image,alt:t("CG 连接测试图")}));
 if(!view)return h('p',null,t("正在读取配置…"));
 const presetName=profile=>t(view.presets.find(row=>row.kind===profile.kind)?.name);
 // small facts about a saved profile, shown as tags
 const tags=profile=>cg?[profile.options?.size,profile.options?.quality&&profile.options.quality!=='auto'&&t("质量 ")+profile.options.quality,profile.options?.references===false?t("纯文生图"):t("参考图 开")].filter(Boolean):['effort: '+(profileEffort(profile)??t("模型默认")),profile.contextTokens&&t("上下文 ")+Math.round(profile.contextTokens/1000)+'K',profile.keyConfigured&&t("Key 已保存")].filter(Boolean);
 const jobs=cg?view.jobs.filter(job=>job.kind!=='test'&&['queued','generating'].includes(job.status)).slice(0,3):[];
 return h('section',{className:'model-settings api-manager ws-stack',...attr('settings')},
  h('button',{...attr('new'),className:'ui-btn primary ws-head-action api-primary',disabled:busy,onClick:()=>create(view.presets[0].kind)},Icon('plus'),t("新增配置")),
  h('p',{className:'api-current ws-sr-only',...attr('current')},selected?t("当前使用：")+selected.name+' · '+selected.model:t("尚未配置，请新增配置")),
  view.busy&&h('div',{className:'ui-note',...attr('lock-reason')},Icon('info',{size:16}),h('div',null,h('b',null,lockReason),...jobs.map(job=>h('div',{key:job.id,className:'ws-muted'},job.label+' · '+jobNames[job.status])))),
  !view.busy&&jobs.length>0&&h('div',{className:'ui-note'},Icon('info',{size:16}),h('div',null,...jobs.map(job=>h('div',{key:job.id},job.label+' · '+jobNames[job.status])))),
  !view.profiles.length?h('div',{className:'ws-card ws-empty'},Icon('plug',{size:40}),h('b',null,cg?t("还没有 CG 绘图配置"):t("还没有聊天 API 配置")),h('p',null,cg?t("升级纪念图和群聊合影会用这里选中的配置。可以用本机 Codex 内置绘图，也可以填自己的绘图 API。"):t("Galgame 聊天、群聊和角色对话会用这里选中的配置。可以用本机 Codex 登录，也可以填自己的 API Key。")),h('button',{className:'ui-btn primary',disabled:busy,onClick:()=>create(view.presets[0].kind)},Icon('plus'),t("新增配置"))):
  h('div',{className:'ws-profiles api-profile-list'},...view.profiles.map(profile=>{const using=profile.id===view.activeId,off=busy||profile.locked;return h('article',{className:'ws-card ws-prof api-profile'+(using?' using':''),key:profile.id,...attr('profile',profile.id)},
   h('div',{className:'ws-src-head'},h('span',{className:'ws-tool-ico'},Icon(cg?'image':'terminal')),h('div',null,h('b',null,profile.name),h('small',null,presetName(profile)+' · '+(profile.model||t("未填写模型")))),using&&h(StatusPill,{tone:'ok'},t("正在使用"))),
   h('div',{className:'ws-tags'},...tags(profile).map((x,i)=>h('span',{key:i,className:'ws-tag'},x)),profile.locked&&h('span',{className:'ws-tag'},t("使用中，暂时锁定"))),
   h('div',{className:'ws-src-foot'},!using&&h('button',{...attr('use',profile.id),className:'ui-btn sm primary',disabled:busy||view.busy,onClick:()=>useProfile(profile)},t("使用此配置")),h('button',{...attr('edit',profile.id),className:'ui-btn sm',disabled:off,title:profile.locked?lockReason:undefined,onClick:()=>begin(profile)},t("编辑")),h('span',{className:'spacer'}),h('button',{...attr('remove',profile.id),className:'ui-icon-btn sm','aria-label':t("删除"),title:profile.locked?lockReason:t("删除"),disabled:off,onClick:()=>removeProfile(profile)},Icon('close',{size:15}))));})),
  !draft&&feedback(),!draft&&testOutput(),
  draft&&h('dialog',{ref:dialog,className:'ws-mdl api-dialog',...attr('dialog'),'aria-labelledby':'api-'+type+'-dialog-title',onCancel:e=>{e.preventDefault();if(!busy)setDraft(null);}},
   h('form',{className:'model-form ws-mdl-form',onSubmit:e=>{e.preventDefault();void save(true);}},
    h('header',null,h('h2',{id:'api-'+type+'-dialog-title'},draft.id?t("编辑配置"):t("新增配置")),h('span',{className:'ws-sub'},cg?t("CG 绘图"):t("聊天 API")),h('button',{type:'button',className:'ui-icon-btn','aria-label':t("关闭"),disabled:busy,onClick:()=>setDraft(null)},Icon('close',{size:18}))),
    h('div',{className:'stats-modal-body'},
     h('div',{className:'ws-fgroup'},h('h4',null,t("连接")),h('div',{className:'ws-fgrid'},field('name',t("配置名称")),
      h('label',{className:'ws-fld model-field'},h('span',null,t("提供方")),h('select',{...attr('field','kind'),value:draft.kind,disabled:locked,onChange:e=>{const preset=view.presets.find(row=>row.kind===e.target.value);begin({...preset,id:draft.id,model:e.target.value==='codex'?view.codexModel:cg&&e.target.value==='wan'?'wan2.6-image':preset.model??'',...(cg?{options:{references:preset.references}}:{})});}},...view.presets.map(preset=>h('option',{key:preset.kind,value:preset.kind},t(preset.name))))),
      draft.kind!=='codex'&&h(React.Fragment,null,field('baseUrl',t("服务地址"),'url','https://…/v1'),field('key','API Key','password',draft.keyConfigured?t("已保存；留空保留原 Key"):t("粘贴 API Key"))))),
     h('div',{className:'ws-fgroup'},h('h4',null,t("模型")),h('div',{className:'ws-fgrid'},
      h('div',{className:'ws-fld ws-span2'},h('span',null,t("模型 ID")),h('div',{className:'ws-inline'},!cg&&models.length>0&&h('select',{...attr('field','model-select'),'aria-label':t("可用模型"),value:models.some(row=>row.id===draft.model)?draft.model:'',disabled:locked,onChange:e=>chooseModel(e.target.value)},h('option',{value:'',disabled:true},t("选择模型，或在下方手动填写")),...models.map(row=>h('option',{key:row.id,value:row.id},row.name===row.id?row.id:row.name+' · '+row.id))),h('input',{...attr('field','model'),'aria-label':t("模型 ID"),value:draft.model??'',disabled:locked,autoComplete:'off',spellCheck:false,placeholder:t("从列表选择或手动填写"),list:'whale-'+type+'-model-list',onChange:e=>chooseModel(e.target.value)}),h('button',{type:'button',className:'ui-btn',...attr('action','list'),disabled:locked||(cg&&view.busy),onClick:()=>run(refreshModels)},Icon('refresh'),t("获取模型列表"))),h('small',null,models.length?t("已读取 {count} 个模型").replace("{count}",String(models.length))+t("，也可以手动填写"):t("从列表选择或手动填写"))),
      h('datalist',{id:'whale-'+type+'-model-list'},...models.map(model=>h('option',{key:model.id,value:model.id},model.name))),
      !cg&&h('div',{className:'ws-fld'},h('span',null,t("推理强度（effort）")),h(Segmented,{size:'sm',label:t("推理强度（effort）"),...attr('field','reasoningEffort'),value:effortLevels.includes(configuredEffort)?configuredEffort:'',disabled:locked||!effortProtocol(draft.protocol),options:[['',t("模型默认")],...effortLevels.map(value=>[value,value])],onChange:value=>change('reasoningEffort',value||null)}),h('small',null,t(!effortProtocol(draft.protocol)?"该原生协议暂不提供 effort 参数，使用模型默认。":effortSupport(draft,models).source==='unknown'?"尚未取得此模型的推理档位，仅提供模型默认。请获取模型列表。":"档位按当前模型的能力提供；模型默认不发送 effort 参数。"))),
      !cg&&h('label',{className:'ws-fld model-field'},h('span',null,t('上下文容量（tokens，可留空）')),h('input',{type:'number',min:2048,max:2000000,step:1,value:draft.contextTokens??'',disabled:locked,placeholder:t("留空 · 按模型目录（保守 {tokens}）").replace('{tokens}',String(DEFAULT_CONTEXT_TOKENS)),onChange:e=>change('contextTokens',e.target.value===''?null:Number(e.target.value))}),h('small',null,t('优先使用手动填写的容量，其次使用模型目录；未知时按默认 {tokens} tokens 规划并预留回复空间。').replace('{tokens}',DEFAULT_CONTEXT_TOKENS.toLocaleString()))),
      cg&&draft.protocol==='ark-images'&&h('p',{className:'ws-muted ws-span2'},t("请选择已开通的 Seedream 模型或绘图接入点 ID；支持文生图和角色参考图。")),
      cg&&h(React.Fragment,null,draft.kind!=='codex'&&h('label',{className:'ws-fld model-field'},h('span',null,t("图片尺寸（留空使用默认）")),h('input',{...attr('option','size'),value:draft.options.size,disabled:locked,placeholder:draft.protocol==='ark-images'?'2K / 2560x1440':draft.protocol==='gemini-images'?'1K / 2K':draft.protocol.startsWith('wan-')?'1280*720':'1536x1024 / auto',onChange:e=>option('size',e.target.value)})),draft.protocol==='openai-images'&&h('label',{className:'ws-fld model-field'},h('span',null,t("质量")),h('input',{...attr('option','quality'),value:draft.options.quality,disabled:locked,onChange:e=>option('quality',e.target.value)}))))),
     // the advanced strip appears only when it holds something
     (draft.kind!=='codex'||cg||draft.keyConfigured)&&h('details',{className:'ws-details ws-plain'},h('summary',null,Icon('chevron',{size:16}),cg?t("高级图片设置"):t("高级设置")),h('div',{className:'ws-fgrid ws-adv'},
      draft.kind!=='codex'&&h('label',{className:'ws-fld model-field'},h('span',null,cg?t("绘图协议"):t("接口协议")),h('select',{...attr('field','protocol'),value:draft.protocol,disabled:locked,onChange:e=>{change('protocol',e.target.value);if(!cg)change('reasoningEffort',null);if(cg)option('references',!e.target.value.startsWith('wan-t2i'));}},...Object.entries(cg?CG_PROTOCOL_NAMES:chatProtocols).map(([value,label])=>h('option',{key:value,value},t(label))))),
      cg&&h('label',{className:'ws-chk model-clear-key'},h('input',{...attr('option','references'),type:'checkbox',checked:draft.options.references&&!draft.protocol.startsWith('wan-t2i'),disabled:locked||draft.protocol.startsWith('wan-t2i'),onChange:e=>option('references',e.target.checked)}),h('span',null,h('b',null,t("使用角色参考图")),h('small',null,draft.options.references&&!draft.protocol.startsWith('wan-t2i')?t("参考图连接：保持角色外观。"):t("纯文生图连接：按角色外观描述绘制。")))),
      draft.keyConfigured&&h('label',{className:'ws-chk model-clear-key'},h('input',{type:'checkbox',checked:!!draft.clearKey,disabled:locked,onChange:e=>change('clearKey',e.target.checked)}),h('span',null,h('b',null,t("清除已保存的 Key")),h('small',null,t("保存后删除本机加密的 Key。")))))),
     h('div',{className:'ui-note'},Icon('info',{size:16}),h('div',null,cg?t("测试连接不出图；生成测试图会调用一次绘图服务。"):t("测试会发送一条很短的请求，用来确认地址、Key 和模型可用。"))),
     view.busy&&h('p',{className:'ws-muted'},lockReason),feedback(),testOutput()),
    h('footer',null,(cg||draft.kind!=='codex')&&h('button',{type:'button',className:'ui-btn',...attr('action',cg?'check':'test'),disabled:locked||(cg&&view.busy),onClick:()=>run(async()=>{const result=await api[cg?'check':'test'](draft);setMessage(result.message??t("连接成功"));})},cg?t("测试连接（不出图）"):t("测试连接（调用一次模型）")),cg&&h('button',{type:'button',className:'ui-btn',...attr('action','test-image'),disabled:locked||view.busy,onClick:()=>run(async()=>{const result=await api.testImage(draft);setImage(null);setTestId(result.id);await reload();setMessage(t("测试图已排队"));})},t("生成测试图")),
     h('span',{className:'spacer'}),h('button',{type:'button',className:'ui-btn',...attr('action','cancel'),disabled:busy,onClick:()=>setDraft(null)},t("取消")),h('button',{type:'button',className:'ui-btn',...attr('action','save'),disabled:locked,onClick:()=>save(false)},t("仅保存")),h('button',{type:'submit',className:'ui-btn primary',...attr('action','save-use'),disabled:locked||view.busy},t("保存并使用"))))));
}
