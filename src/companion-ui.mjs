import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n.mjs';
import {CHARACTER_CATALOG} from './character-catalog.mjs';
import {GroupMentionInput} from './group-mention-input.mjs';
import {companionImage} from './companion-image.mjs';
import {plateVars} from './plate-colors.mjs';
import {Icon} from './ui-icons.mjs';
import {themeAsset,THEMES} from './appearance.mjs';
import {THEME_PALETTES} from './theme-palettes.mjs';
import {Segmented,Switch} from './ui-controls.mjs';
import {CompanionLifeCSS,MemoryPanel,GrowthPanel,LifeArchivesPanel,LifeRecoveryBanner,companionGrowthLocked} from './companion-life-ui.mjs';
export {LifeRecoveryBanner};

const h=React.createElement;
const F=React.Fragment;
const fieldGroups=[
 ['基本资料',[['intro','简介'],['identity','身份'],['background','背景经历']]],
 ['性格与表达',[['personality','性格'],['interests','兴趣'],['likes','喜欢'],['dislikes','不喜欢'],['tone','语气'],['selfAddress','自称'],['speechHabits','口头习惯']]],
 ['关系与开场',[['address','称呼用户'],['relationship','关系前提'],['meeting','相遇场景'],['greeting','开场白']]],
 ['形象',[['visual','CG 外貌描述'],['sprite','角色立绘'],['backgroundImage','角色背景'],['referenceImage','CG 参考图']]],
];
const imageFields=new Set(['sprite','backgroundImage','referenceImage']);
const modes=[['inherit','继承默认'],['custom','自定义'],['empty','主动清空']];
const groupModes=[['natural','自然接话'],['list','列表顺序'],['manual','手动点名'],['pool','轮换池']];
const groupModeHelp={
 natural:'自然接话：按点名和角色卡的健谈程度选人，每位入选成员本轮回复一次；无人入选时随机选一位，所以 0% 不等于静音。',
 list:'列表顺序：所有在场且未静音的成员按列表依次回复，不受健谈程度影响。',
 manual:'手动点名：仅输入 @ 并选择的成员回复，不受健谈程度影响；未点名时不会自动选人。',
 pool:'轮换池：每轮从在场且未静音的成员中按顺序选一位，不受健谈程度影响。',
};
const characterTalkativeness=value=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):.5;

export const CompanionCSS=CompanionLifeCSS+`
.buddy-title-edit{font:inherit;border:0;border-radius:8px;background:color-mix(in srgb,var(--buddy-surface2) 60%,transparent);cursor:pointer;padding:5px 10px;max-width:min(480px,70vw);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.buddy-title-edit span{opacity:.65;font-size:13px}.buddy-title-edit:hover{background:color-mix(in srgb,var(--buddy-surface2) 73%,transparent)}.buddy-title-edit:focus-visible{outline:2px solid var(--buddy-accent-text);outline-offset:2px}.buddy-dialog.buddy-title-dialog{width:min(500px,calc(100vw - 32px));height:fit-content;min-height:0;max-height:calc(100dvh - 32px);padding:22px;margin:auto;overflow:auto}.buddy-dialog.buddy-title-dialog h2{font-size:18px}.buddy-title-dialog .buddy-note{margin:12px 0}.buddy-title-dialog input{width:100%}.buddy-title-dialog .buddy-inline-actions{justify-content:flex-end;margin-top:16px}
.buddy-mention-menu{box-sizing:border-box;z-index:30000;overflow:auto;padding:6px;border:1px solid var(--buddy-border);border-radius:12px;background:var(--buddy-surface);color:var(--buddy-text);box-shadow:0 12px 35px #0007;font:14px/1.4 system-ui,sans-serif;overscroll-behavior:contain;scrollbar-width:thin}.buddy-mention-menu button{display:flex;width:100%;min-height:46px;align-items:center;gap:10px;padding:5px 8px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.buddy-mention-menu button[aria-selected=true]{background:color-mix(in srgb,currentColor 18%,transparent)}.buddy-mention-menu button>span:not(.buddy-mention-initial){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.buddy-mention-menu img,.buddy-mention-initial{width:34px;height:36px;flex:none;object-fit:contain;border-radius:5px;background:color-mix(in srgb,var(--buddy-text) 9%,transparent)}.buddy-mention-initial{display:grid;place-items:center}.buddy-mention-menu small{margin-left:auto;opacity:.7;font-size:10px}
.buddy-dialog{box-sizing:border-box;width:min(980px,calc(100vw - 32px));height:min(850px,calc(100dvh - 40px));max-height:calc(100dvh - 40px);max-width:calc(100vw - 32px);padding:0;border:1px solid var(--buddy-border);border-radius:18px;color:var(--buddy-text);background:var(--buddy-surface);font:14px/1.55 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 28px 90px #0008;user-select:text;overscroll-behavior:contain}
.buddy-dialog::backdrop{background:color-mix(in srgb,var(--buddy-bg) 74%,transparent);backdrop-filter:blur(4px)}
.buddy-dialog-shell{height:100%;display:flex;flex-direction:column;min-height:0}
.buddy-dialog-head{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:18px 22px;border-bottom:1px solid color-mix(in srgb,var(--buddy-muted) 23%,transparent);flex:none}
.buddy-dialog h2{margin:0;font-size:21px;line-height:1.4}.buddy-dialog h3{margin:0 0 12px;font-size:17px}.buddy-dialog h4{margin:0 0 10px;font-size:14px}
.buddy-dialog-head small{display:block;color:var(--buddy-muted);margin-top:4px}.buddy-dialog-close{width:36px;height:36px;font-size:22px;padding:0!important;flex:none}
.buddy-tabs{display:flex;gap:7px;padding:12px 22px 0;flex-wrap:wrap;flex:none}
.buddy-dialog-body{padding:20px 22px;min-height:0;overflow:auto;flex:1;overscroll-behavior:contain;scrollbar-color:#86b5c178 transparent;scrollbar-width:thin}
.buddy-dialog-foot{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:14px 22px;border-top:1px solid color-mix(in srgb,var(--buddy-muted) 23%,transparent);flex:none;background:color-mix(in srgb,var(--buddy-bg) 20%,transparent)}
.buddy-dialog button,.buddy-dialog input,.buddy-dialog textarea,.buddy-dialog select{font:inherit}.buddy-dialog button:where(:not([role]):not([class*=buddy-side]):not(.buddy-new):not(.buddy-icon):not(.buddy-link):not(.buddy-op):not(.buddy-chip):not(.buddy-pick):not(.buddy-ghost):not(.buddy-group-bg-card):not([class*=gx-]):not([class*=ui-])){display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--buddy-h-md);padding:0 14px;border:0;border-radius:var(--buddy-r-btn);background:var(--buddy-surface2);color:var(--buddy-text);box-shadow:inset 0 0 0 1px var(--buddy-border);font-weight:500;cursor:pointer}
.buddy-dialog button:where(:not([role]):not([class*=buddy-side]):not(.buddy-new):not(.buddy-icon):not(.buddy-link):not(.buddy-op):not(.buddy-chip):not(.buddy-pick):not(.buddy-ghost):not(.buddy-group-bg-card):not([class*=gx-]):not([class*=ui-])):hover:not(:disabled){background:color-mix(in srgb,var(--buddy-accent) 12%,var(--buddy-surface2))}.buddy-dialog button:disabled{opacity:.45;cursor:default}.buddy-dialog button:focus-visible,.buddy-dialog input:focus-visible,.buddy-dialog textarea:focus-visible,.buddy-dialog select:focus-visible,.buddy-group-panel button:focus-visible{outline:2px solid var(--buddy-accent-text);outline-offset:3px}
.buddy-primary{background:var(--buddy-accent)!important;color:var(--buddy-on-accent)!important;border-color:transparent!important;box-shadow:none!important;font-weight:600!important}.buddy-primary:hover:not(:disabled){background:var(--buddy-accent-hover)!important}.buddy-danger{color:var(--buddy-err)!important}.buddy-muted,.buddy-note{color:var(--buddy-muted);font-size:12px}.buddy-note{margin:8px 0;line-height:1.7}.buddy-error{color:var(--buddy-err);white-space:pre-wrap;overflow-wrap:anywhere}.buddy-status{min-height:20px;margin:0;font-size:12px;flex:1 1 200px}
.buddy-columns{display:grid;grid-template-columns:205px minmax(0,1fr);gap:20px;align-items:start}.buddy-sidebar{display:flex;flex-direction:column;gap:7px;position:sticky;top:0;max-height:100%;min-width:0}.buddy-sidebar-list{display:flex;flex-direction:column;gap:5px;max-height:46vh;overflow:auto;overscroll-behavior:contain}
.buddy-sidebar button{text-align:left;overflow-wrap:anywhere}.buddy-sidebar button[aria-current=true]{border-color:var(--buddy-accent-text);background:color-mix(in srgb,var(--buddy-accent) 33%,transparent)}.buddy-sidebar button small{display:block;color:var(--buddy-muted);font-size:11px}.buddy-count{font-variant-numeric:tabular-nums;font-size:12px;color:var(--buddy-muted)}.buddy-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.buddy-field{min-width:0;display:flex;flex-direction:column;gap:6px}.buddy-field-wide{grid-column:1/-1}
.buddy-field label,.buddy-field-label{font-size:13px;font-weight:650}.buddy-field input:not([type=checkbox]):not([type=range]),.buddy-field textarea,.buddy-field select,.buddy-search input,.buddy-search select{box-sizing:border-box;width:100%;min-width:0;border:1px solid color-mix(in srgb,var(--buddy-muted) 40%,transparent);border-radius:9px;background:color-mix(in srgb,var(--buddy-bg) 33%,transparent);color:inherit;padding:8px 10px;line-height:1.55}.buddy-field input:disabled,.buddy-field textarea:disabled{opacity:.5}.buddy-field textarea{min-height:90px;resize:vertical;white-space:pre-wrap}.buddy-field select option,.buddy-search select option{background:var(--buddy-surface2);color:var(--buddy-text)}.buddy-field-heading{display:flex;align-items:center;justify-content:space-between;gap:9px}.buddy-field-heading select{width:115px!important;padding:3px 6px!important;font-size:11px!important}.buddy-section{margin:0 0 24px;padding:0 0 20px;border:0;border-bottom:1px solid color-mix(in srgb,var(--buddy-muted) 20%,transparent);min-width:0}.buddy-section:last-child{margin-bottom:0}.buddy-section legend{margin-bottom:12px;font-size:15px;font-weight:700;color:var(--buddy-accent-text)}.buddy-check{display:flex;gap:9px;align-items:flex-start;cursor:pointer}.buddy-check input{margin-top:5px;accent-color:var(--buddy-accent-text);width:17px;height:17px;flex:none}
.buddy-image{display:flex;gap:10px;align-items:center;min-width:0}.buddy-image img{width:80px;height:100px;object-fit:contain;background:repeating-conic-gradient(var(--buddy-surface) 0% 25%,var(--buddy-surface2) 0% 50%) 50%/16px 16px;border-radius:7px}.buddy-image-name{overflow-wrap:anywhere;font-size:11px;color:var(--buddy-muted)}.buddy-example{padding:12px;border:1px solid color-mix(in srgb,var(--buddy-muted) 27%,transparent);border-radius:10px;margin-bottom:10px}.buddy-example-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.buddy-inline-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:12px 0}.buddy-search{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:15px}.buddy-search>input[type=search]{flex:1 1 180px}.buddy-search>input[type=date]{width:145px}.buddy-search select{width:auto}.buddy-empty{padding:35px 15px;border:1px dashed color-mix(in srgb,var(--buddy-muted) 40%,transparent);border-radius:12px;text-align:center;color:var(--buddy-muted);line-height:1.8}.buddy-list{display:flex;flex-direction:column;gap:9px}.buddy-conversation{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start;padding:12px;border:1px solid color-mix(in srgb,var(--buddy-muted) 27%,transparent);border-radius:11px}.buddy-conversation.active{border-color:var(--buddy-accent-text)}.buddy-conversation-title{display:block;font-weight:650;overflow-wrap:anywhere}.buddy-conversation small{display:block;margin-top:4px;color:var(--buddy-muted)}.buddy-conversation-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.buddy-message{padding:13px;border-left:3px solid var(--buddy-accent-text);background:color-mix(in srgb,var(--buddy-side-bg) 30%,transparent);border-radius:0 10px 10px 0}.buddy-message[data-role=user]{border-left-color:var(--buddy-accent-text)}.buddy-message-head{display:flex;gap:9px;justify-content:space-between;align-items:center}.buddy-message-body{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;line-height:1.8}.buddy-message-actions{display:flex;gap:7px;flex-wrap:wrap}.buddy-message-actions button{padding:3px 8px;font-size:12px}.buddy-message details{font-size:12px;color:var(--buddy-muted);white-space:pre-wrap}.buddy-members{display:flex;flex-direction:column;gap:8px}.buddy-member{padding:10px 12px;border:1px solid color-mix(in srgb,var(--buddy-muted) 27%,transparent);border-radius:10px}.buddy-member-head{display:flex;gap:10px;align-items:center;justify-content:space-between}.buddy-member-controls{display:flex;gap:12px;align-items:center;margin-top:8px;flex-wrap:wrap}.buddy-member-controls label{display:flex;align-items:center;gap:7px;font-size:12px}.buddy-member-controls input[type=range]{width:110px;accent-color:var(--buddy-accent-text)}.buddy-member-controls button{padding:3px 9px;font-size:12px}
.galgame-page .buddy-group-cast{inset:0 2% 0}.whg-top-actions{flex-wrap:wrap}.buddy-text-only-stage{align-items:center!important}.buddy-text-only-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:28px 35px;max-width:80%;border:1px solid color-mix(in srgb,var(--buddy-accent-text) 30%,transparent);border-radius:18px;background:color-mix(in srgb,var(--buddy-surface) 53%,transparent);color:var(--buddy-accent-text);text-align:center}.buddy-text-only-card strong{font-size:clamp(18px,2.3vw,30px);overflow-wrap:anywhere}.buddy-text-only-card span{font-size:13px;color:var(--buddy-muted)}.buddy-pet-note{max-width:300px;white-space:normal}.buddy-group-panel{z-index:4}.buddy-group-panel .whg-input{min-height:48px;resize:vertical;white-space:pre-wrap}.buddy-group-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;font-size:12px;color:var(--buddy-muted)}.buddy-group-controls{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.buddy-group-controls select{font:inherit;max-width:180px;border:1px solid color-mix(in srgb,var(--buddy-accent-text) 47%,transparent);border-radius:8px;padding:4px 8px;color:var(--buddy-accent-text);background:var(--buddy-surface2)}.buddy-group-mentions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.buddy-group-mentions button{font-size:12px;padding:4px 8px}.buddy-group-mentions button[aria-pressed=true]{border-color:var(--buddy-accent-text);background:color-mix(in srgb,var(--buddy-accent) 33%,transparent)}.buddy-group-cast{position:absolute;inset:90px 12px 190px;display:flex;justify-content:center;align-items:flex-end;gap:4px;pointer-events:none}.buddy-group-slot{flex:1 1 0;min-width:0;max-width:370px;height:100%;position:relative;display:flex;align-items:flex-end;justify-content:center}.buddy-group-slot img,.buddy-group-slot canvas{width:100%;height:100%;object-fit:contain;object-position:center bottom;filter:brightness(.8);transition:filter .2s}.buddy-group-slot[data-active=true] img,.buddy-group-slot[data-active=true] canvas{filter:none}.buddy-group-slot>span{position:absolute;bottom:0;padding:3px 9px;border-radius:20px;background:color-mix(in srgb,var(--buddy-side-bg) 67%,transparent);font-size:12px;color:var(--buddy-text)}.buddy-group-avatar{height:40%;width:80%;display:flex;align-items:center;justify-content:center;border:1px solid color-mix(in srgb,var(--buddy-accent-text) 40%,transparent);border-radius:20px;background:color-mix(in srgb,var(--buddy-surface2) 53%,transparent);color:var(--buddy-accent-text);font-size:32px;overflow:hidden}.buddy-group-panel .buddy-error{margin:6px 0;font-size:12px}.buddy-form-title{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}.buddy-form-title h3{margin-bottom:4px}
@media(max-width:700px){.buddy-dialog{width:calc(100vw - 16px);max-width:calc(100vw - 16px);height:calc(100dvh - 20px);max-height:calc(100dvh - 20px)}.buddy-dialog-head{padding:14px}.buddy-tabs{padding:10px 14px 0}.buddy-dialog-body{padding:15px 14px}.buddy-dialog-foot{padding:12px 14px}.buddy-columns{grid-template-columns:1fr;gap:15px}.buddy-sidebar{position:static}.buddy-sidebar-list{flex-direction:row;max-height:105px;overflow:auto}.buddy-sidebar button{flex:none;max-width:165px}.buddy-fields{grid-template-columns:1fr}.buddy-conversation{grid-template-columns:1fr}.buddy-conversation-actions{justify-content:flex-start}.buddy-group-cast{inset:115px 6px 215px}.buddy-group-slot>span{font-size:10px}}
`;

export function companionCharacterName(character){return String(character?.effective?.displayName||character?.effective?.name||character?.name||character?.id||'');}
export {companionImage};
// B2: a second truncation reaches the panel as MODEL_OUTPUT_TRUNCATED or its Chinese message.
export const modelOutputTruncated=value=>/MODEL_OUTPUT_TRUNCATED|回复被截断/.test(String(value?.code||'')+' '+String(value?.message??value??''));
export const modelErrorText=value=>modelOutputTruncated(value)?t('回复被截断，可以调高通用设置里的输出上限后重试'):String(value?.message??value??'');
// B3/B5: statuses in which the group round is still working and the panel keeps polling.
export const GROUP_BUSY_STATUSES=['queued','waiting-model','waiting-life-save','generating','running','preparing','awaiting-presentation'];
export function groupStatusText(runtime,name,now=Date.now()){
 if(runtime?.status==='waiting-model')return t('排队中')+(name?' · '+name:'');
 if(runtime?.status==='waiting-life-save'){const left=Number.isFinite(runtime.waitDeadline)?Math.max(0,Math.ceil((runtime.waitDeadline-now)/1000)):null;return t('正在保存人生存档，稍后自动发送')+(left!==null?' · '+t('最多 {n} 秒').replace('{n}',String(left)):'');}
 if(runtime?.status==='awaiting-presentation')return t('回复已就绪，关闭弹窗后呈现。');
 return t('{name} 正在回复…').replace('{name}',name||t('成员'));
}
export function companionCardDraft(character){
 const fields={};
 for(const[,list]of fieldGroups)for(const[key]of list){
  const saved=character?.fields?.[key];
  const defaultValue=character?.effective?.[key]??(key==='personality'?character?.effective?.persona:undefined)??'';
  fields[key]={mode:modes.some(([m])=>m===saved?.mode)?saved.mode:'inherit',value:String(saved?.value??defaultValue)};
 }
 const draft=character?.draft;
 return {id:character?.id||undefined,name:character?.name||'',avatar:character?.avatar||'',fields,examples:Array.isArray(character?.examples)?structuredClone(character.examples):[],modelBinding:{enabled:false,connectionId:'',...character?.modelBinding},...(draft&&typeof draft==='object'?structuredClone(draft):{}),talkativeness:characterTalkativeness(draft?.talkativeness??character?.talkativeness)};
}
export function groupCurrentMessage(companion){
 const message=companion?.groupRuntime?.currentMessage;
 // Only the server's committed, displayed message is exposed here. Never render queue drafts.
 return message&&typeof message.text==='string'?message:null;
}
export function activeCompanionGroup(companion){return companion?.groups?.find(row=>row.id===companion.activeGroupId)||null;}
const button=(label,onClick,props={})=>h('button',{type:'button',onClick,...props},t(label));
// Built-ins use their theme's centred head crop; custom characters their own avatar.
export const characterHead=(character,resolveArt)=>character&&THEMES[character.id]?'./'+themeAsset(character.id,'head.webp'):companionImage(character?.avatar,resolveArt);
const characterRole=character=>THEME_PALETTES.find(row=>row.id===character?.id)?.zh||'';
const face=(src,fallback,className='buddy-face')=>h('span',{className,'aria-hidden':true},src?h('img',{src,alt:'',draggable:false}):(fallback||'?').slice(0,1));
const sideItem=({key,current,head,title,sub,tag,onClick,...props})=>h('button',{type:'button',key,className:'buddy-side-item','aria-current':current,onClick,...props},head,h('span',null,h('b',null,title),sub&&h('small',null,sub)),tag&&h('span',{className:'ws-tag'},tag));
const personaFace=(persona,resolveArt,className='buddy-face')=>{const src=companionImage(persona?.avatar,resolveArt);return src?face(src,persona?.name,className):h('span',{className:className+' blank','aria-hidden':true},Icon('person',{size:className.includes('lg')?22:16}));};
const ghost=(icon,label,onClick,props={})=>h('button',{type:'button',className:'buddy-ghost',onClick,...props},icon&&Icon(icon,{size:14}),t(label));
const newButton=(label,onClick,props={})=>h('button',{type:'button',className:'buddy-new',onClick,...props},Icon('plus',{size:15}),t(label));
const note=text=>h('p',{className:'buddy-note'},t(text));
const empty=text=>h('div',{className:'buddy-empty'},t(text));
const errorText=error=>t(String(error?.message||error||''));
const dateLabel=value=>value?new Date(value).toLocaleString():'';
const change=(setter,key)=>event=>setter(old=>({...old,[key]:event.target.value}));
const imageInputTypes='image/png,image/jpeg,image/webp,image/avif';
async function readImage(file){
 if(!file)return null;
 if(!['image/png','image/jpeg','image/webp','image/avif'].includes(file.type))throw Error(t('请选择 PNG、JPEG、WebP 或 AVIF 图片。'));
 if(file.size>8*1024*1024)throw Error(t('图片不能超过 8 MiB。'));
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error(t('图片读取失败。')));reader.readAsDataURL(file);});
}
function downloadJson(data,name){
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
 const anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function TextField({label,value,onChange,multiline=false,wide=false,disabled=false,type='text',placeholder='',hint=''}){
 const id=React.useId();
 return h('div',{className:'buddy-field'+(wide?' buddy-field-wide':'')},h('label',{htmlFor:id},t(label),hint&&h('small',null,t(hint))),h(multiline?'textarea':'input',{id,value:value??'',onChange,disabled,placeholder:t(placeholder),...(multiline?{rows:3}:{type})}));
}
export function ImageField({label,value,onChange,disabled,resolveArt,onError}){
 const file=useRef(null),preview=companionImage(value,resolveArt);
 return h('div',{className:'buddy-field'},h('span',{className:'buddy-field-label'},t(label)),h('div',{className:'buddy-image'},preview&&h('img',{src:preview,alt:t(label),draggable:false}),h('div',null,h('input',{ref:file,type:'file',accept:imageInputTypes,hidden:true,onChange:async e=>{try{const result=await readImage(e.target.files?.[0]);if(result)onChange(result);}catch(error){onError(errorText(error));}finally{e.target.value='';}}}),button('选择图片',()=>file.current?.click(),{disabled,'aria-label':t(label)+' · '+t('选择图片')}),value&&button('移除',()=>onChange(''),{disabled}),!preview&&value&&h('small',{className:'buddy-image-name'},t('图片引用已保存')))));
}

function CharacterEditor({state,request,setFeedback,resolveArt,connections,onClose,initial=''}){
 const first=initial&&state.characters?.some(c=>c.id===initial)?initial:state.activeCharacterId||state.characters?.[0]?.id||'';
 const [selected,setSelected]=useState(first),[draft,setDraft]=useState(()=>companionCardDraft(state.characters?.find(c=>c.id===first))),[saving,setSaving]=useState(false);
 const character=selected.startsWith('draft:')?state.draftCharacters?.find(c=>c.id===selected.slice(6)):state.characters?.find(c=>c.id===selected);
 const locked=companionGrowthLocked(character)||companionGrowthLocked(state.characters?.find(c=>c.id===character?.id));
 const fieldLocked=key=>locked&&!['visual','sprite','backgroundImage','referenceImage'].includes(key);
 const choose=id=>{setSelected(id);const target=id.startsWith('draft:')?state.draftCharacters?.find(c=>c.id===id.slice(6)):state.characters?.find(c=>c.id===id);setDraft(companionCardDraft(target));setFeedback('');};
 const updateField=(key,patch)=>setDraft(old=>({...old,fields:{...old.fields,[key]:{...old.fields[key],...patch}}}));
 const save=async action=>{if(saving)return;setSaving(true);setFeedback('');try{const result=await request(action,{...draft});const id=result.card?.id||result.character?.id||result.characterId||draft.id;setFeedback(t(action==='companion-character-draft'?'草稿已保存，尚未应用。':'角色已保存。'));if(id){setSelected(action==='companion-character-draft'?'draft:'+id:id);const saved=result.card||result.companion?.characters?.find(c=>c.id===id);if(saved)setDraft(companionCardDraft(saved));}return{id,result};}catch(error){setFeedback(errorText(error),true);}finally{setSaving(false);}};
 return h('div',{className:'buddy-columns'},
  h('aside',{className:'buddy-sidebar'},newButton('新建角色',()=>choose(''),{'data-companion-new-character':true}),h('div',{className:'buddy-sidebar-list'},...(state.characters||[]).map(c=>sideItem({key:c.id,current:selected===c.id,'data-companion-character':c.id,head:face(characterHead(c,resolveArt),companionCharacterName(c)),title:companionCharacterName(c),sub:t(characterRole(c)),onClick:()=>choose(c.id)}))),...(state.draftCharacters||[]).map(c=>sideItem({key:'draft:'+c.id,current:selected==='draft:'+c.id,head:face(companionImage(c.avatar,resolveArt),c.name||'?'),title:c.name||t('未命名角色'),tag:t('草稿'),onClick:()=>choose('draft:'+c.id)}))),
  h('form',{onSubmit:e=>{e.preventDefault();void save('companion-character-save');},'aria-busy':saving},
   h('div',{className:'buddy-form-title'},character&&face(characterHead(character,resolveArt),companionCharacterName(character),'buddy-face lg'),h('div',{className:'spacer'},h('h3',null,character?companionCharacterName(character):t('新建角色')),h('span',{className:'buddy-muted'},character?.builtin?t('内置角色 · 可恢复默认人设'):t('自建角色 · 不自动生成图片或桌宠'))),character&&button('与这位聊天',async()=>{try{await request('companion-character-select',{id:character.id});onClose();}catch(error){setFeedback(errorText(error),true);}},{disabled:saving})),
   h('nav',{className:'buddy-jump','aria-label':t('跳到')},...[...fieldGroups.map(([title])=>title),'示例对话','模型关联'].map((title,i)=>h('button',{type:'button',key:title,onClick:e=>e.currentTarget.closest('form')?.querySelector('#buddy-card-sec-'+i)?.scrollIntoView({behavior:'smooth',block:'start'})},t(title)))),
   h('div',{className:'buddy-section buddy-fields'},h(TextField,{label:'名称',value:draft.name,onChange:change(setDraft,'name'),disabled:saving||locked}),h(ImageField,{label:'头像',value:draft.avatar,onChange:value=>setDraft(old=>({...old,avatar:value})),disabled:saving,resolveArt,onError:message=>setFeedback(message,true)})),
   ...fieldGroups.map(([title,fields],sectionIndex)=>h('fieldset',{key:title,id:'buddy-card-sec-'+sectionIndex,className:'buddy-section'},h('legend',null,t(title)),h('div',{className:'buddy-fields'},...fields.map(([key,label])=>{const item=draft.fields?.[key]||{mode:'inherit',value:''},displayValue=item.mode==='empty'?'':item.mode==='inherit'?(character?.defaults?.[key]??''):item.value;return h('div',{className:'buddy-field buddy-mode-'+item.mode,key},h('div',{className:'buddy-field-heading'},h('label',{htmlFor:'buddy-card-'+key},t(label)),h(Segmented,{size:'sm',label:t(label)+' · '+t('内容方式'),value:item.mode,disabled:saving||fieldLocked(key),options:modes.map(([mode,label])=>[mode,t(label)]),onChange:mode=>updateField(key,{mode})})),item.mode==='inherit'&&!imageFields.has(key)&&h('span',{className:'buddy-inherit-tag'},t('默认')),imageFields.has(key)?h(ImageField,{label,value:displayValue,onChange:value=>updateField(key,{value,mode:value?'custom':'empty'}),disabled:saving||fieldLocked(key)||item.mode!=='custom',resolveArt,onError:message=>setFeedback(message,true)}):h('textarea',{id:'buddy-card-'+key,rows:['visual','personality','background','greeting'].includes(key)?4:2,disabled:saving||fieldLocked(key)||item.mode!=='custom',value:displayValue,placeholder:item.mode==='inherit'&&!displayValue?t('默认人设里没有这一项'):undefined,onChange:e=>updateField(key,{value:e.target.value}),'aria-label':t(label)}),item.mode==='empty'&&h('small',{className:'buddy-muted'},t('此字段将明确留空，不继承默认内容。')));}),title==='性格与表达'&&h('div',{className:'buddy-field buddy-field-wide'},h('label',{htmlFor:'buddy-card-talkativeness'},t('健谈程度')+' · '+Math.round(draft.talkativeness*100)+'%'),h('input',{id:'buddy-card-talkativeness',type:'range',min:0,max:100,step:5,value:Math.round(draft.talkativeness*100),disabled:saving,'data-companion-card-talkativeness':true,'aria-describedby':'buddy-card-talkativeness-note','aria-valuetext':Math.round(draft.talkativeness*100)+'%',onChange:e=>setDraft(old=>({...old,talkativeness:Number(e.target.value)/100}))}),h('div',{className:'buddy-range-ends','aria-hidden':true},h('span',null,t('少说话')),h('span',null,t('爱接话'))),h('p',{id:'buddy-card-talkativeness-note',className:'buddy-note'},t('由玩家设定，适用于所有群聊的自然接话；其他发言方式不受影响。0% 不等于静音，若本轮无人入选仍会随机选一位。')))))),
   h('fieldset',{id:'buddy-card-sec-'+fieldGroups.length,className:'buddy-section'},h('legend',null,t('示例对话')),...(draft.examples||[]).map((row,index)=>h('div',{key:index,className:'buddy-example'},h('div',{className:'buddy-example-head'},h('span',null,t('示例')+' '+(index+1)),button('移除',()=>setDraft(old=>({...old,examples:old.examples.filter((_,i)=>i!==index)})),{disabled:saving||locked})),h('div',{className:'buddy-fields'},...[["scene","场景"],["speaker","发言者"],["text","内容"]].map(([key,label])=>h(TextField,{key,label,value:row[key],multiline:key==='text',wide:key==='text',disabled:saving||locked,onChange:e=>{const value=e.target.value;setDraft(old=>({...old,examples:old.examples.map((r,i)=>i===index?{...r,[key]:value}:r)}));}}))))),button('添加示例',()=>setDraft(old=>({...old,examples:[...(old.examples||[]),{scene:'',speaker:draft.name||'',text:''}]})),{disabled:saving||locked})),
   h('fieldset',{id:'buddy-card-sec-'+(fieldGroups.length+1),className:'buddy-section'},h('legend',null,t('模型关联')),h('label',{className:'buddy-check'},h('input',{type:'checkbox',checked:!!draft.modelBinding?.enabled,disabled:saving,onChange:e=>setDraft(old=>({...old,modelBinding:{...old.modelBinding,enabled:e.target.checked}}))}),t('为此角色使用指定聊天连接')),h('div',{className:'buddy-field'},h('select',{'aria-label':t('指定聊天连接'),disabled:saving||!draft.modelBinding?.enabled,value:draft.modelBinding?.connectionId||'',onChange:e=>setDraft(old=>({...old,modelBinding:{...old.modelBinding,connectionId:e.target.value}}))},h('option',{value:''},t('选择已有连接')),...connections.map(row=>h('option',{key:row.id,value:row.id},row.name+' · '+(row.model||''))))),note('默认沿用当前聊天连接。切换角色不会自动切换模型。')),
   locked&&note('成长人设只读；通过聊天沟通纠正。外观、模型连接和健谈程度仍可修改，重新填写人设请先归档并重置。'),
   note('没有桌宠资源的角色仍可文字聊天；桌宠保留当前可用形象。'),
   h('div',{className:'buddy-inline-actions buddy-sticky-actions'},button('保存草稿',()=>void save('companion-character-draft'),{disabled:saving}),h('button',{type:'submit',className:'buddy-primary',disabled:saving||!draft.name.trim(),'data-companion-save-character':true},t('保存')),button('保存并聊天',async()=>{const saved=await save('companion-character-save');if(saved?.id){try{await request('companion-character-select',{id:saved.id});onClose();}catch(error){setFeedback(errorText(error),true);}}},{disabled:saving||!draft.name.trim()}),character?.builtin&&button('恢复默认人设',()=>{const restored=companionCardDraft(character);for(const field of Object.values(restored.fields))field.mode='inherit';restored.examples=[];restored.modelBinding={enabled:false,connectionId:''};restored.talkativeness=.5;setDraft(restored);setFeedback(t('默认人设已载入草稿，保存后生效。'));},{disabled:saving||locked})),
  ));
}

function PersonaEditor({state,request,setFeedback,resolveArt}){
 const blank={name:'',nickname:'',avatar:'',relationships:{}};
 const [selected,setSelected]=useState(state.activePersonaId||''),[draft,setDraft]=useState(()=>structuredClone(state.personas?.find(p=>p.id===state.activePersonaId)||blank)),[saving,setSaving]=useState(false),[sourcePersonaId,setSourcePersonaId]=useState(state.activePersonaId||'');
 const role=state.characters?.find(c=>c.id===state.activeCharacterId),progress=state.relationship,defaultId=state.defaultPersonaId||'default',using=!!selected&&selected===state.activePersonaId;
 const choose=id=>{setSelected(id);setDraft(structuredClone(state.personas?.find(p=>p.id===id)||blank));setFeedback('');};
 const save=async()=>{setSaving(true);try{const result=await request('companion-persona-save',draft);const id=result.persona?.id||result.personaId||draft.id;if(id){setSelected(id);setDraft(structuredClone(result.persona||result.companion?.personas?.find(p=>p.id===id)||draft));}setFeedback(t('身份已保存。'));}catch(error){setFeedback(errorText(error),true);}finally{setSaving(false);}};
 const progressMode=async mode=>{try{if(mode==='shared'){await request('companion-relationship-mode',{characterId:state.activeCharacterId,mode:'shared',sourcePersonaId});setFeedback(t('已使用共用进度，数值不会相加。'));}else{await request('companion-relationship-mode',{characterId:state.activeCharacterId,mode:'independent'});setFeedback(t('已恢复此身份的独立进度。'));}}catch(error){setFeedback(errorText(error),true);}};
 const field=(key,label,props={})=>h(TextField,{key,label,value:draft[key],onChange:change(setDraft,key),disabled:saving,...props});
 const relation=(key,label,props={})=>h(TextField,{key,label,value:draft.relationships?.[state.activeCharacterId]?.[key]||'',disabled:saving,onChange:e=>{const value=e.target.value;setDraft(old=>({...old,relationships:{...old.relationships,[state.activeCharacterId]:{...old.relationships?.[state.activeCharacterId],[key]:value}}}));},...props});
 return h('div',{className:'buddy-columns'},
  h('aside',{className:'buddy-sidebar'},newButton('新建身份',()=>choose('')),h('div',{className:'buddy-sidebar-list'},...(state.personas||[]).map(p=>sideItem({key:p.id,current:selected===p.id,head:personaFace(p,resolveArt),title:p.name,sub:p.nickname?t('昵称：')+p.nickname:'',tag:p.id===defaultId?t('默认'):'',onClick:()=>choose(p.id)})))),
  h('form',{onSubmit:e=>{e.preventDefault();void save();},'aria-busy':saving},
   h('div',{className:'buddy-form-title'},personaFace(draft,resolveArt,'buddy-face lg'),h('div',{className:'spacer'},h('h3',null,selected?(draft.name||t('编辑我的身份')):t('新建身份')),selected&&h('small',{className:'buddy-muted'},using?t('正在使用 · 新会话会沿用这个身份'):t('切换后恢复此身份对应的会话和草稿'))),
    selected&&button('设为默认身份',async()=>{try{await request('companion-persona-save',{...draft,default:true});setFeedback(t('默认身份已保存。'));}catch(error){setFeedback(errorText(error),true);}},{disabled:saving||selected===state.defaultPersonaId}),
    selected&&h('button',{type:'button',disabled:saving||using,onClick:async()=>{try{await request('companion-persona-select',{id:selected});setFeedback(t('已切换身份，对话按身份隔离。'));}catch(error){setFeedback(errorText(error),true);}}},using&&Icon('check',{size:14}),t(using?'正在使用':'使用此身份'))),
   h('fieldset',{className:'buddy-section'},h('legend',null,t('关于我')),
    h('div',{className:'buddy-fields three'},field('name','管理名称'),field('nickname','对话昵称',{hint:'角色怎么叫你'}),field('occupation','职业／身份',{placeholder:'如：独立开发者'})),
    h('div',{className:'buddy-fields',style:{marginTop:14}},field('interests','兴趣',{placeholder:'如：游戏、摄影'}),h(ImageField,{label:'头像',value:draft.avatar,onChange:value=>setDraft(old=>({...old,avatar:value})),resolveArt,disabled:saving,onError:message=>setFeedback(message,true)}),field('background','背景',{multiline:true,placeholder:'想让角色知道的事'}),field('preferences','交流偏好',{multiline:true,placeholder:'比如：别太客气、可以开玩笑'}))),
   h('fieldset',{className:'buddy-section'},h('legend',null,role&&face(characterHead(role,resolveArt),companionCharacterName(role),'buddy-face sm'),t('对当前角色的专属关系')+' · '+companionCharacterName(role),h('small',null,t('只对这个角色生效'))),h('div',{className:'buddy-fields'},relation('address','专属称呼',{placeholder:'如：主人'}),relation('relationship','关系补充',{multiline:true,placeholder:'如：一起做项目的搭档'}))),
   h('fieldset',{className:'buddy-section'},h('legend',null,t('当前角色的关系进度')),
    h('div',{className:'buddy-scope'},h('div',null,h('small',null,companionCharacterName(role)),h('b',null,'Lv.'+(progress?.level??1)+' · '+t('好感')+' '+(progress?.affection??0))),
     h(Segmented,{size:'sm',label:t('当前角色的关系进度'),value:progress?.mode==='shared'?'shared':'independent',options:[['independent',t('独立进度')],['shared',t('共用进度')]],onChange:mode=>void progressMode(mode)}),
     h('label',{className:'buddy-scope-source'},t('共用进度的起点身份'),h('select',{'aria-label':t('共用进度的起点身份'),value:sourcePersonaId,disabled:progress?.mode==='shared',onChange:e=>setSourcePersonaId(e.target.value)},...(state.personas||[]).map(p=>h('option',{key:p.id,value:p.id},p.name))))),
    note('独立进度与共享进度分别保留；共用进度不会开放另一身份的聊天。')),
   note(t('新建会话沿用当前身份；未选择身份时使用默认身份。')+' '+t('默认身份')+'：'+(state.personas?.find(p=>p.id===state.defaultPersonaId)?.name||state.personas?.find(p=>p.id==='default')?.name||'')),
   h('div',{className:'buddy-inline-actions buddy-sticky-actions'},h('span',{className:'spacer'}),h('button',{type:'submit',className:'buddy-primary',disabled:saving||!draft.name?.trim()},t('保存身份'))),
 ));
}

// Skits were short scenes two or three characters played on their own; group chat replaced them in 1.9.0.
// Old scenes stay readable here (and can still get a group photo); new ones can no longer be made.
function OldSkits({request,onBack,onGroups}){
 const [log,setLog]=useState(null),[error,setError]=useState(''),[cgAvailable,setCgAvailable]=useState(false),[busy,setBusy]=useState('');
 const load=()=>request('side-story-log').then(result=>{setLog(Array.isArray(result?.skits)?result.skits:[]);setCgAvailable(!!result?.cgAvailable);setError('');}).catch(e=>setError(errorText(e)));
 useEffect(()=>{void load();},[]);
 const head=id=>THEMES[id]?h('img',{src:'./'+themeAsset(id,'head.webp'),alt:''}):null;
 const at=value=>dateLabel(Number(value)||0);
 const skits=log||[],times=skits.map(s=>Number(s.at)||0).filter(Boolean),range=times.length?at(Math.min(...times))+' – '+at(Math.max(...times)):'';
 return h('section',{className:'buddy-old-skits','data-old-skits':true},
  h('button',{type:'button',className:'gx-back',onClick:onBack},Icon('chevron',{size:14}),t('返回会话列表')),
  h('div',{className:'buddy-skits-head'},h('span',{className:'buddy-skits-ico','aria-hidden':true},Icon('ticket',{size:22})),h('div',{className:'spacer'},h('h3',null,t('以前的小剧场'),' ',h('span',{className:'ws-tag'},t('只读'))),h('small',null,log?skits.length+t(' 场')+(range?' · '+range:''):t('读取中…'))),onGroups&&h('button',{type:'button',className:'ui-btn sm',onClick:onGroups},Icon('chats',{size:14}),t('去群聊'))),
  h('div',{className:'ui-note'},Icon('info',{size:16}),h('div',null,h('b',null,t('小剧场已经由群聊接替。')),t('这里只保留以前演过的场次，不能再新建；想让几位角色一起聊，请用群聊。'))),
  error&&h('p',{role:'alert',className:'ws-errtxt'},t('小剧场记录读取失败：')+error),
  ...skits.map(skit=>{const cast=skit.cast||[],lines=skit.lines||[],status=skit.cgStatus;return h('article',{className:'buddy-skit',key:String(skit.id)},
   h('div',{className:'buddy-skit-h'},h('span',{className:'buddy-skit-faces'},...cast.map(m=>h('span',{key:m.id,className:'buddy-skit-face'},head(m.id)||String(m.name||'?').slice(0,1)))),h('b',null,cast.map(m=>m.name).join('、')),h('span',{className:'spacer'}),at(skit.at)),
   skit.seed&&h('p',{className:'buddy-skit-seed'},skit.seed),
   ...lines.map((line,i)=>h('p',{key:i},h('em',{style:{color:line.color||cast.find(m=>m.id===line.who||m.name===line.name)?.color||undefined}},line.name||t('旁白')),line.text||'')),
   h('div',{className:'buddy-skit-f'},h('span',{className:'spacer'},t('一场 · ')+lines.length+t(' 句')),
    status==='ready'?h('span',{className:'gx-back'},Icon('gallery',{size:14}),t('合影已生成 · 在图鉴里')):status==='trashed'?h('span',{className:'ws-muted'},t('合影已移入回收站')):['queued','generating'].includes(status)?h('span',{className:'ws-muted'},t('合影绘制中…')):cgAvailable?h('button',{type:'button',className:'ui-btn ghost sm',disabled:busy===skit.id,onClick:async()=>{setBusy(skit.id);try{const result=await request('skit-cg',{skitId:skit.id});if(result?.ok===false)throw Error(result.error||t('合影生成暂时失败'));await load();}catch(e){setError(errorText(e));}finally{setBusy('');}}},Icon('brush',{size:14}),status==='failed'?t('重试这场的合影 CG'):t('补一张合影 CG')):null));}),
  log&&!skits.length&&empty('没有以前的小剧场。'));
}
function MessageHistory({state,request,setFeedback,onGroups,resolveArt}){
 const [search,setSearch]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[archived,setArchived]=useState(false),[items,setItems]=useState(null),[editing,setEditing]=useState(null),[editText,setEditText]=useState(''),[saving,setSaving]=useState(false),[onlyFavorites,setOnlyFavorites]=useState(false),[title,setTitle]=useState(''),[renaming,setRenaming]=useState(false);
 const importRef=useRef(null),[skitCount,setSkitCount]=useState(0),[showSkits,setShowSkits]=useState(false),[viewId,setViewId]=useState(state.activeConversationId||''),[preview,setPreview]=useState(null);
 useEffect(()=>{let live=true;request('side-story-log').then(result=>{if(live)setSkitCount(Array.isArray(result?.skits)?result.skits.length:0);}).catch(()=>{});return()=>{live=false;};},[]);
 const conversations=items||state.conversations||[],listed=conversations.filter(row=>Boolean(row.archived)===archived);
 const active=state.activeConversationId,viewing=viewId||active||'',isActive=!!viewing&&viewing===active;
 const current=conversations.find(row=>row.id===viewing)||state.conversations?.find(row=>row.id===viewing);
 const characterOf=row=>state.characters?.find(c=>c.id===row?.characterId);
 useEffect(()=>{setViewId(active||'');},[active]);
 useEffect(()=>{setTitle(current?.title||'');setEditing(null);setRenaming(false);},[current?.id,current?.title]);
 // Another conversation is read through its export, which never switches the active one.
 useEffect(()=>{if(isActive||!viewing){setPreview(null);return;}let live=true;setPreview('loading');request('companion-conversation-export',{id:viewing}).then(result=>{const row=(result?.data||result?.export||result)?.conversations?.[0];if(live)setPreview(Array.isArray(row?.messages)?row.messages:[]);}).catch(error=>{if(live){setPreview([]);setFeedback(errorText(error),true);}});return()=>{live=false;};},[viewing,isActive]);
 useEffect(()=>{let active=true;const timer=setTimeout(()=>request('companion-conversation-list',{search,from,to,archived}).then(result=>{if(active)setItems(result.conversations||result.items||result.companion?.conversations||[]);}).catch(error=>{if(active)setFeedback(errorText(error),true);}),250);return()=>{active=false;clearTimeout(timer);};},[search,from,to,archived,state.activeConversationId,state.conversations?.length]);
 const messages=isActive?(state.messages||[]):Array.isArray(preview)?preview:[];
 const shown=messages.filter(row=>!onlyFavorites||row.favorite);
 const mutate=async(action,args,success)=>{try{const result=await request(action,args);setFeedback(t(success));return result;}catch(error){setFeedback(errorText(error),true);}};
 const who=row=>row.role==='user'?(state.personas?.find(p=>p.id===row.personaId)?.nickname||t('你')):companionCharacterName(characterOf(row));
 if(showSkits)return h(OldSkits,{request,onBack:()=>setShowSkits(false),onGroups});
 const role=characterOf(current);
 return h('div',{className:'buddy-columns buddy-history'},
  h('aside',{className:'buddy-sidebar'},
   h('label',{className:'buddy-searchbox'},Icon('search',{size:15}),h('input',{'aria-label':t('搜索会话与消息'),type:'search',placeholder:t('搜索会话与消息'),value:search,onChange:e=>setSearch(e.target.value)})),
   h('div',{className:'buddy-dates'},h('input',{'aria-label':t('开始日期'),type:'date',value:from,onChange:e=>setFrom(e.target.value)}),h('input',{'aria-label':t('结束日期'),type:'date',value:to,onChange:e=>setTo(e.target.value)})),
   h('div',{className:'buddy-chips'},h('button',{type:'button',className:'buddy-chip','aria-pressed':archived,onClick:()=>setArchived(value=>!value)},Icon('archive',{size:13}),t('已归档'))),
   newButton('新建会话',()=>void mutate('companion-conversation-new',{},'新会话已建立。')),
   h('div',{className:'buddy-sidebar-list'},...listed.map(row=>{const c=characterOf(row);return sideItem({key:row.id,current:row.id===viewing,head:face(characterHead(c,resolveArt),companionCharacterName(c)),title:row.title||t('未命名会话'),sub:[row.title&&row.title!==companionCharacterName(c)?companionCharacterName(c):'',state.personas?.find(p=>p.id===row.personaId)?.name,dateLabel(row.updatedAt)].filter(Boolean).join(' · '),tag:row.id===active?t('正在聊'):'',onClick:()=>setViewId(row.id)});}),listed.length===0&&empty('没有匹配的会话。')),
   !archived&&skitCount>0&&h(F,null,h('p',{className:'buddy-side-h'},t('以前的小剧场')),sideItem({key:'skits','data-old-skits-entry':true,head:h('span',{className:'buddy-face blank','aria-hidden':true},Icon('ticket',{size:15})),title:t('以前的小剧场'),sub:skitCount+t(' 场 · 只读'),onClick:()=>setShowSkits(true)}))),
  h('section',{className:'buddy-history-main'},
   current?h(F,null,
    h('div',{className:'buddy-form-title'},face(characterHead(role,resolveArt),companionCharacterName(role),'buddy-face lg'),
     h('div',{className:'spacer'},renaming?h('div',{className:'buddy-search'},h('input',{'aria-label':t('会话标题'),value:title,autoFocus:true,onChange:e=>setTitle(e.target.value)}),button('保存标题',async()=>{if(await mutate('companion-conversation-update',{id:current.id,title},'会话标题已保存。'))setRenaming(false);},{disabled:!title.trim()}),button('取消',()=>{setRenaming(false);setTitle(current.title||'');})):h('h3',null,current.title||t('未命名会话'),h('button',{type:'button',className:'buddy-icon','aria-label':t('改会话标题'),onClick:()=>setRenaming(true)},Icon('pencil',{size:14}))),
      h('small',{className:'buddy-muted'},[state.personas?.find(p=>p.id===current.personaId)?.name,isActive||Array.isArray(preview)?messages.length+t(' 条消息'):'',current.updatedAt?t('最近 ')+dateLabel(current.updatedAt):''].filter(Boolean).join(' · '))),
     ghost('download','导出',async()=>{const result=await mutate('companion-conversation-export',{id:current.id},'会话已导出。');if(result)downloadJson(result.data||result.export||result,'AI-Buddy-conversation-'+new Date().toISOString().slice(0,10)+'.json');}),
     ghost('archive',current.archived?'取消归档':'归档',async()=>{await mutate('companion-conversation-update',{id:current.id,archived:!current.archived},current.archived?'已取消归档。':'会话已归档，原文保留。');setItems(null);}),
     isActive?h('span',{className:'ws-tag'},t('正在聊')):button('继续这段对话',()=>void mutate('companion-conversation-select',{id:current.id},'已恢复会话。'),{className:'buddy-primary'})),
    h('div',{className:'buddy-history-filters'},h(Segmented,{size:'sm',label:t('消息筛选'),value:onlyFavorites?'favorite':'all',options:[['all',t('全部消息')],['favorite',t('仅收藏')]],onChange:value=>setOnlyFavorites(value==='favorite')}),h('span',{className:'spacer'}),h('span',{className:'buddy-switch-row'},t('允许更正我发的消息'),h(Switch,{checked:!!state.settings?.allowUserMessageEdit,label:t('允许更正我发的消息'),onChange:value=>void mutate('companion-settings',{allowUserMessageEdit:value},'消息更正设置已保存。')}))),
    !isActive&&h('div',{className:'ui-note'},Icon('info',{size:16}),h('div',null,t('这是只读预览；继续这段对话后可以收藏和更正。'))),
    preview==='loading'?h('div',{className:'buddy-empty'},t('读取中…')):h('div',{className:'buddy-msgs'},...shown.map(row=>{const mine=row.role==='user',c=characterOf(row);return h('article',{key:row.id,className:'buddy-message'+(mine?' me':''),'data-role':row.role},
     mine?personaFace(state.personas?.find(p=>p.id===row.personaId),resolveArt):face(characterHead(c,resolveArt),companionCharacterName(c)),
     h('div',{className:'buddy-message-main'},h('div',{className:'buddy-message-head'},h('strong',null,who(row)),h('small',{className:'buddy-muted'},dateLabel(row.createdAt))),
      editing===row.id?h(F,null,h('div',{className:'buddy-field'},h('textarea',{'aria-label':t('更正消息'),value:editText,onChange:e=>setEditText(e.target.value),rows:4})),h('div',{className:'buddy-inline-actions'},button('保存更正',async()=>{setSaving(true);const result=await mutate('companion-message-edit',{conversationId:state.activeConversationId,id:row.id,text:editText},'更正已保存，下次正常聊天时提供给模型。');setSaving(false);if(result)setEditing(null);},{disabled:saving||!editText.trim(),className:'buddy-primary'}),button('取消',()=>setEditing(null),{disabled:saving}))):h('p',{className:'buddy-message-body'},row.text),
      isActive&&h('div',{className:'buddy-message-actions'},h('button',{type:'button',className:'buddy-op','aria-pressed':!!row.favorite,onClick:()=>void mutate('companion-message-favorite',{conversationId:state.activeConversationId,id:row.id,value:!row.favorite},'收藏已更新。')},Icon('star',{size:13}),t(row.favorite?'已收藏':'收藏')),mine&&state.settings?.allowUserMessageEdit&&h('button',{type:'button',className:'buddy-op',onClick:()=>{setEditing(row.id);setEditText(row.text);}},Icon('pencil',{size:13}),t('更正'))),
      (row.revisions?.length>0||row.originalText&&row.originalText!==row.text)&&h('details',{className:'buddy-revisions'},h('summary',null,h('span',{className:'ws-tag'},t('已更正')),t('原文与更正记录')),h('p',null,row.originalText),...(row.revisions||[]).map((revision,index)=>h('p',{key:index},dateLabel(revision.at||revision.updatedAt||revision.createdAt)+'\n'+(revision.text||revision.previousText||''))))));}),shown.length===0&&empty(onlyFavorites?'还没有收藏的消息。':'还没有消息。'))
   ):empty('选一段会话查看消息。'),
   h('div',{className:'buddy-inline-actions buddy-sticky-actions'},h('span',{className:'buddy-note spacer'},t('更正保留原文和版本，不重新请求模型、不改变好感。AI 台词不能修改。')),ghost('upload','恢复会话',()=>importRef.current?.click()),h('input',{type:'file',accept:'.json,application/json',hidden:true,ref:importRef,onChange:async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>50*1024*1024)throw Error(t('恢复文件不能超过 50 MiB。'));await mutate('companion-conversation-import',{data:JSON.parse(await file.text())},'会话已恢复。');}catch(error){setFeedback(errorText(error),true);}finally{e.target.value='';}}}))),
 );
}

export function GroupEditor({state,request,setFeedback,resolveArt,onClose,onCard}){
 const fresh=()=>({sceneTemplate:'library',autoPhoto:false,name:'',memberIds:state.activeCharacterId?[state.activeCharacterId]:[],personaId:state.activePersonaId,scene:'',background:'',mode:'natural',mutedIds:[]});
 const groupDraft=group=>{const {talkativeness,...editable}=structuredClone(group||fresh());return editable;};
 const [selected,setSelected]=useState(state.activeGroupId||''),[draft,setDraft]=useState(()=>groupDraft(activeCompanionGroup(state))),[saving,setSaving]=useState(false);
 const choose=id=>{setSelected(id);setDraft(groupDraft(state.groups?.find(row=>row.id===id)));setFeedback('');};
 const toggleMember=(id,present)=>setDraft(old=>({...old,memberIds:present?[...new Set([...old.memberIds,id])]:old.memberIds.filter(v=>v!==id)}));
 const save=async enter=>{if(saving)return;setSaving(true);try{const result=await request('companion-group-save',draft);const id=result.group?.id||result.groupId||draft.id;if(id){setSelected(id);const saved=result.group||result.companion?.groups?.find(row=>row.id===id);setDraft(old=>saved?groupDraft(saved):{...old,id});}if(enter&&id){await request('companion-group-select',{id,entryCharacterId:state.activeCharacterId});onClose();}else setFeedback(t('群聊已保存。'));}catch(error){setFeedback(errorText(error),true);}finally{setSaving(false);}};
 const updatePresent=async(id,op)=>{try{const result=await request('companion-group-member',{id:selected,characterId:id,op});const group=result.companion?.groups?.find(row=>row.id===selected);if(group)setDraft(old=>({...old,memberIds:[...group.memberIds],mutedIds:[...group.mutedIds]}));setFeedback(t('成员状态已更新。'));}catch(error){setFeedback(errorText(error),true);}};
 const characterOf=id=>state.characters?.find(c=>c.id===id),label=c=>companionCharacterName(c)+(c.resourceInstalled===false?' · '+t('待安装'):'');
 const faces=(ids,n)=>h('span',{className:'buddy-faces','aria-hidden':true},...(ids||[]).slice(0,n).map(id=>h(F,{key:id},face(characterHead(characterOf(id),resolveArt),companionCharacterName(characterOf(id))))));
 const members=(state.characters||[]).filter(c=>draft.memberIds?.includes(c.id)),others=(state.characters||[]).filter(c=>!draft.memberIds?.includes(c.id));
 const modeName=mode=>t(groupModes.find(([value])=>value===mode)?.[1]||'自然接话');
 return h('div',{className:'buddy-columns'},
  h('aside',{className:'buddy-sidebar'},newButton('新建群聊',()=>choose('')),h('div',{className:'buddy-sidebar-list'},...(state.groups||[]).map(row=>sideItem({key:row.id,current:selected===row.id,head:faces(row.memberIds,2),title:row.name,sub:(row.memberIds?.length||0)+t(' 人')+' · '+modeName(row.mode),onClick:()=>choose(row.id)})))),
  h('form',{onSubmit:e=>{e.preventDefault();void save(false);},'aria-busy':saving},
   h('div',{className:'buddy-form-title'},members.length>0&&faces(draft.memberIds,4),h('div',{className:'spacer'},h('h3',null,selected?(draft.name||t('管理群聊')):t('新建群聊')),h('small',{className:'buddy-muted'},members.length+t(' 位成员')+' · '+(state.personas?.find(p=>p.id===draft.personaId)?.name||'')))),
   h('div',{className:'buddy-fields'},h(TextField,{label:'群名',value:draft.name,onChange:change(setDraft,'name'),disabled:saving}),h('div',{className:'buddy-field'},h('label',{htmlFor:'buddy-group-persona'},t('我的身份'),selected&&h('small',{className:'buddy-lock'},Icon('lock',{size:12}),t('建好后不能更换'))),h('select',{id:'buddy-group-persona',value:draft.personaId,onChange:change(setDraft,'personaId'),disabled:saving||!!selected},...(state.personas||[]).map(p=>h('option',{key:p.id,value:p.id},p.name)))),h(TextField,{label:'场景',value:draft.scene,onChange:change(setDraft,'scene'),multiline:true,wide:true,disabled:saving})),
   h('fieldset',{className:'buddy-section'},h('legend',null,t('发言方式')),h(Segmented,{size:'sm',label:t('发言方式'),value:draft.mode,disabled:saving,'data-companion-group-mode':true,options:groupModes.map(([value,label])=>[value,t(label)]),onChange:mode=>setDraft(old=>({...old,mode}))}),h('p',{className:'buddy-mode-help','data-companion-group-mode-help':true},t(groupModeHelp[draft.mode]||groupModeHelp.natural)),note('本轮名单按发言方式确定；后续回复仍需点击继续，不自动覆盖当前台词。')),
   h('fieldset',{className:'buddy-section'},h('legend',null,t('群聊成员'),h('small',null,t('健谈程度在管理角色的角色卡中设置，适用于所有群聊。'))),
    h('div',{className:'buddy-members'},...members.map(c=>{const id=c.id,muted=draft.mutedIds?.includes(id),talk=Math.round(characterTalkativeness(c.talkativeness)*100);return h('div',{className:'buddy-member',key:id},face(characterHead(c,resolveArt),companionCharacterName(c)),
      h('div',{className:'buddy-member-name'},h('b',null,label(c)),h('small',null,t(muted?'在场 · 静音':'在场'))),
      h('div',{className:'buddy-member-talk','data-companion-member-talkativeness':id},h('span',null,t('健谈程度')+' · '+talk+'%',onCard&&h('button',{type:'button',className:'buddy-link',onClick:()=>onCard(id)},t('去角色卡改'))),h('span',{className:'buddy-meter','aria-hidden':true},h('i',{style:{width:talk+'%'}}))),
      h('span',{className:'buddy-switch-row'},t('静音'),h(Switch,{checked:!!muted,disabled:saving,label:companionCharacterName(c)+' · '+t('静音'),onChange:checked=>setDraft(old=>({...old,mutedIds:checked?[...new Set([...old.mutedIds,id])]:old.mutedIds.filter(v=>v!==id)}))})),
      c.resourceInstalled===false&&button('补装角色',async()=>{try{await window.whale.resources.manage(id);}catch(error){setFeedback(errorText(error),true);}},{disabled:saving}),
      selected?ghost('','离开',()=>void updatePresent(id,'leave'),{disabled:saving}):h('button',{type:'button',className:'buddy-icon','aria-label':t('移出')+' · '+companionCharacterName(c),disabled:saving,onClick:()=>toggleMember(id,false)},Icon('close',{size:14})));}),
     members.length===0&&empty('还没有成员；点下面的角色加入。')),
    others.length>0&&h('div',{className:'buddy-member-add'},...others.map(c=>h('button',{type:'button',key:c.id,disabled:saving,onClick:()=>selected?void updatePresent(c.id,'join'):toggleMember(c.id,true)},face(characterHead(c,resolveArt),companionCharacterName(c)),'+ '+label(c)))),
    note('新成员不知道加入之前的内容，离开期间也不会自动获知。再次加入保留原先已知内容。')),
   h('fieldset',{className:'buddy-section'},h('legend',null,t('舞台')),h('div',{className:'buddy-fields'},h('div',{className:'buddy-field'},h('span',{className:'buddy-field-label'},t('场景样式')),h(Segmented,{size:'sm',label:t('场景样式'),value:draft.sceneTemplate||'library',disabled:saving,options:[['library',t('图书室围桌')],['plain',t('普通背景')]],onChange:value=>setDraft(old=>({...old,sceneTemplate:value}))}),h('span',{className:'buddy-switch-row',style:{marginTop:10}},t('结束本次聊天时自动合影'),h(Switch,{checked:!!draft.autoPhoto,disabled:saving,label:t('结束本次聊天时自动合影'),onChange:value=>setDraft(old=>({...old,autoPhoto:value}))}))),h(ImageField,{label:'群聊背景',value:draft.background,onChange:value=>setDraft(old=>({...old,background:value})),resolveArt,disabled:saving,onError:message=>setFeedback(message,true)}))),
   h('div',{className:'buddy-inline-actions buddy-sticky-actions'},h('span',{className:'buddy-note spacer'},t('群聊按当前身份保存。桌宠跟随进入时选中的角色，不随每条发言切换。')),selected&&ghost('download','导出群聊记录',async()=>{try{const result=await request('companion-group-export',{id:selected});downloadJson(result.data,'AI-Buddy-group-'+new Date().toISOString().slice(0,10)+'.json');setFeedback(t('群聊已导出；可在对话历史中恢复。'));}catch(error){setFeedback(errorText(error),true);}},{disabled:saving}),h('button',{type:'submit',disabled:saving||!draft.name.trim()||!draft.memberIds?.length},t('保存群聊')),button('保存并进入',()=>void save(true),{className:'buddy-primary',disabled:saving||!draft.name.trim()||!draft.memberIds?.length})),
 ));
}

/** All mutations use the application game-action bridge; this is not an isolated mock UI. */
export function CompanionManager({state,request,panel='characters',onClose,resolveArt=()=>null}){
 const managerTabs=[['characters','管理角色','users'],['personas','我的身份','idcard'],['history','对话历史','clock'],['groups','群聊','chats'],['memory','长期记忆','memory'],['growth','人格自成长','sprout'],['lives','人生存档','archive']];
 const dialog=useRef(null),returnFocus=useRef(null),[active,setActive]=useState(panel),[cardFocus,setCardFocus]=useState(''),[feedback,setFeedbackState]=useState({text:'',error:false}),[connections,setConnections]=useState([]);
 const setFeedback=(text,error=false)=>setFeedbackState({text,error});
 useEffect(()=>{setActive(panel);},[panel]);
 useEffect(()=>{returnFocus.current=document.activeElement;dialog.current?.showModal();let live=true;window.whale?.models?.get?.().then(result=>{if(live)setConnections(result.profiles||[]);}).catch(()=>{});return()=>{live=false;dialog.current?.close();const target=returnFocus.current;if(target?.isConnected)target.focus({preventScroll:true});};},[]);
 if(!state)return null;
 return h('dialog',{id:'buddy-companion-dialog',ref:dialog,className:'buddy-dialog','aria-labelledby':'buddy-companion-title',onCancel:event=>{event.preventDefault();onClose();},onClick:event=>{if(event.target===dialog.current){const box=dialog.current.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)onClose();}},onWheel:event=>event.stopPropagation()},
  h('div',{className:'buddy-dialog-shell'},h('header',{className:'buddy-dialog-head'},h('div',null,h('h2',{id:'buddy-companion-title'},t('角色与对话')),h('small',null,t('角色、身份和历史分别保存，取消关闭不应用草稿。'))),h('button',{type:'button',className:'buddy-dialog-close ui-icon-btn','aria-label':t('关闭'),onClick:onClose},Icon('close',{size:18}))),h('nav',{className:'buddy-tabs',role:'tablist','aria-label':t('角色与对话')},...managerTabs.map(([id,label,icon])=>h('button',{type:'button',onClick:()=>{setActive(id);setFeedback('');},key:id,role:'tab','aria-selected':active===id,'aria-controls':'buddy-manager-'+id,tabIndex:active===id?0:-1,onKeyDown:e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const ids=managerTabs.map(([id])=>id),index=ids.indexOf(active);const next=e.key==='Home'?0:e.key==='End'?ids.length-1:(index+(e.key==='ArrowRight'?1:ids.length-1))%ids.length;setActive(ids[next]);setTimeout(()=>dialog.current?.querySelector('[role=tab][aria-selected=true]')?.focus(),0);}},h('span',{className:'buddy-tab-icon','aria-hidden':true},Icon(icon,{size:15})),t(label)))),h('div',{className:'buddy-dialog-body',id:'buddy-manager-'+active,role:'tabpanel',key:active},h(LifeRecoveryBanner,{state,request,setFeedback}),active==='characters'?h(CharacterEditor,{state,request,setFeedback,resolveArt,connections,onClose,initial:cardFocus}):active==='personas'?h(PersonaEditor,{state,request,setFeedback,resolveArt}):active==='history'?h(MessageHistory,{state,request,setFeedback,resolveArt,onGroups:()=>{setActive('groups');setFeedback('');}}):active==='memory'?h(MemoryPanel,{state,request,setFeedback,resolveArt}):active==='growth'?h(GrowthPanel,{state,request,setFeedback,resolveArt}):active==='lives'?h(LifeArchivesPanel,{state,request,setFeedback,resolveArt}):h(GroupEditor,{state,request,setFeedback,resolveArt,onClose,onCard:id=>{setCardFocus(id);setActive('characters');setFeedback('');}})),h('footer',{className:'buddy-dialog-foot'},h('p',{className:'buddy-status'+(feedback.error?' buddy-error':''),role:feedback.error?'alert':'status'},feedback.text||t('保存不调用模型。未应用的草稿在关闭后丢弃。')),button('关闭',onClose))),
 );
}

export {CompanionGroupStage} from './group-stage-ui.mjs';

export function CompanionGroupDialogue({state,request,onManage,onPhoto,chat,onToggleChat,onApi}){
 const group=activeCompanionGroup(state),[text,setText]=useState(''),[bindings,setBindings]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[photoOpen,setPhotoOpen]=useState(false);
 useEffect(()=>{setText('');setBindings([]);setError('');},[group?.id]);
 const operationRef=useRef(null);
 const runtime=state?.groupRuntime||{};
 useEffect(()=>{if(!group||!GROUP_BUSY_STATUSES.includes(runtime.status))return;const timer=setInterval(()=>request('companion-state',{}).catch(()=>{}),900);return()=>clearInterval(timer);},[group?.id,runtime.status]);
 const [,setTick]=useState(0);
 useEffect(()=>{if(runtime.status!=='waiting-life-save'||!runtime.waitDeadline)return;const timer=setInterval(()=>setTick(v=>v+1),1000);return()=>clearInterval(timer);},[runtime.status,runtime.waitDeadline]);
 if(!group)return null;
 const message=groupCurrentMessage(state),member=state.characters?.find(c=>c.id===(message?.characterId||message?.speaker)),isRunning=busy||GROUP_BUSY_STATUSES.includes(runtime.status),canContinue=!!runtime.canContinue,canRetry=!!runtime.canRetry,hasQueue=!!runtime.queue?.length;
 const perform=async(action,args={})=>{if(operationRef.current&&action!=='companion-group-stop')return;const token={action};if(action!=='companion-group-stop')operationRef.current=token;setError('');if(action!=='companion-group-stop')setBusy(true);try{await request(action,{id:group.id,...args,...(action==='companion-group-send'?{clientRequestId:crypto.randomUUID()}: {})});if(action==='companion-group-send'){setText('');setBindings([]);}}catch(error){setError(errorText(error));}finally{if(operationRef.current===token){operationRef.current=null;setBusy(false);}}};
 const characterOf=id=>state.characters?.find(c=>c.id===id),nameOf=id=>companionCharacterName(characterOf(id))||t('成员');
 // This round: who already spoke since the last user message, who is next, who is still waiting.
 const queue=(runtime.queue||[]).filter(id=>typeof id==='string'),current=queue[0];
 const log=(state.groupMessages||[]).filter(m=>m.status!=='pending-presentation'),lastUser=log.map(m=>m.role).lastIndexOf('user');
 const spoken=lastUser<0?[]:log.slice(lastUser+1).filter(m=>m.role==='assistant'&&m.characterId).map(m=>m.characterId);
 const steps=[...spoken.map((id,i)=>({id,kind:'done',key:'d'+i})),...queue.map((id,i)=>({id,kind:i?'':isRunning?'busy':canRetry?'fail':'next',key:'q'+i}))];
 const roundDone=!isRunning&&!canContinue&&!canRetry&&!queue.length&&spoken.length>0;
 const offline=chat?chat.enabled===false:false,blocked=isRunning||canContinue||canRetry||offline,locked=isRunning||canContinue;
 const turn=step=>h('span',{key:step.key,className:'buddy-turn'+(step.kind?' '+step.kind:'')},step.kind==='busy'?h('span',{className:'ui-spinner','aria-hidden':true}):face(characterHead(characterOf(step.id)),nameOf(step.id),'buddy-face sm'),step.kind==='next'?t('下一位 ')+nameOf(step.id):step.kind==='busy'?nameOf(step.id)+t(' 正在回复'):nameOf(step.id),step.kind==='done'&&Icon('check',{size:13}));
 const round=(steps.length>0||isRunning||canContinue||canRetry||hasQueue)&&h('div',{className:'buddy-round','data-group-round':true},
  h('span',{className:'buddy-round-k'},t('本轮')),
  h('div',{className:'buddy-round-steps'},...steps.flatMap((step,i)=>i?[h('span',{key:'a'+i,className:'buddy-round-arrow','aria-hidden':true},'›'),turn(step)]:[turn(step)])),
  isRunning&&h('span',{className:steps.length?'buddy-sr':'buddy-muted',role:'status'},groupStatusText(runtime,nameOf(current))),
  h('span',{className:'spacer'}),
  roundDone?h('span',{className:'buddy-round-end'},t('本轮结束，发新消息开始下一轮')):h(F,null,
   (canContinue||isRunning)&&h('button',{type:'button',className:'gx-gbtn pri',disabled:isRunning,onClick:()=>void perform('companion-group-continue'),'data-companion-group-continue':true},t('继续 ▸')),
   !canRetry&&h('button',{type:'button',className:'gx-gbtn',disabled:!isRunning&&!canContinue&&!hasQueue,onClick:()=>void perform('companion-group-stop'),'data-companion-group-stop':true},Icon('stop',{size:13}),t('停止本轮'))));
 const problem=error||runtime.error,truncated=problem&&modelOutputTruncated(problem);
 const alert=problem||canRetry?h('div',{className:'gx-alert',role:'alert','data-group-error':true},Icon('alert',{size:16}),h('span',{className:'grow'},canRetry&&h('b',null,nameOf(current)+t(' 回复失败')),canRetry&&problem?' · ':'',problem?modelErrorText(problem):''),
   canRetry&&h('button',{type:'button',className:'gx-gbtn',disabled:isRunning,onClick:()=>void perform('companion-group-retry')},Icon('retry',{size:14}),t('重试 ')+nameOf(current)),
   canRetry&&h('button',{type:'button',className:'gx-gbtn',onClick:()=>void perform('companion-group-stop'),'data-companion-group-stop':true},Icon('stop',{size:13}),t('停止本轮')),
   truncated&&h('button',{type:'button',className:'gx-gbtn',onClick:()=>window.whale?.open?.('settings'),'data-open-output-limit':true},t('打开通用设置')))
  :offline?h('div',{className:'gx-alert info',role:'status'},Icon('globe',{size:16}),h('span',{className:'grow'},t('群聊离线 · 开启联网后使用成员 API')),onToggleChat&&h('button',{type:'button',className:'gx-gbtn pri',onClick:()=>onToggleChat()},t('开启联网聊天'))):null;
 const who=message?.role==='user'?'user':member?'character':'narrator';
 const placeholder=isRunning?t('等这一位说完…'):canRetry?t('先重试或停止本轮'):canContinue?t('点「继续」让下一位接话'):offline?t('开启联网聊天后就能回复'):t('发送群消息，输入 @ 点名成员');
 const send=()=>{if(text.trim()&&!blocked)void perform('companion-group-send',{text,mentionBindings:bindings});};
 return h('section',{id:'whg-panel',className:'whg-panel gx-dlg buddy-group-panel','aria-label':t('群聊对话'),'data-companion-group-dialogue':group.id},
  h('div',{className:'whg-plate gx-plate'+(who==='character'?'':' '+who),style:plateVars({who,characterId:member?.id,color:member?.color})},message?.role==='user'?(message?.personaName||message?.personaSnapshot?.nickname||state.personas?.find(p=>p.id===group.personaId)?.nickname||t('你')):(message?.characterName||(member?companionCharacterName(member):t('群聊')))),
  h('div',{className:'buddy-group-meta'},h('button',{type:'button',className:'gx-gbtn',disabled:locked,title:locked?t('本轮结束后可用'):undefined,onClick:()=>setPhotoOpen(true)},Icon('camera',{size:13}),t('合影 CG')),h('button',{type:'button',className:'gx-gbtn',disabled:locked,title:locked?t('本轮结束后可用'):undefined,onClick:()=>void perform('companion-group-end')},t('结束本次聊天'))),
  h('div',{className:'whg-line-now'+(message?'':' narrator'),key:message?.id||group.id,'aria-live':'polite'},message?.text||t('说点什么，开始这一轮群聊。')),
  !message&&!round&&h('p',{className:'buddy-group-hint'},t('发送后第一位会自动回复，后续成员点击“继续”接话。')),
  alert,round,
  h('div',{className:'whg-input-row gx-say'},h('div',{className:'gx-ta'+(blocked?' dis':'')},h(GroupMentionInput,{value:text,bindings,placeholder,onChange:(value,nextBindings)=>{setText(value);setBindings(nextBindings);},members:group.memberIds.map(id=>characterOf(id)).filter(Boolean),disabled:blocked,onSubmit:send}),h('small',{'aria-hidden':true},t('Enter 发送 · Shift+Enter 换行'))),
   h('button',{type:'button',className:'whg-send gx-send',disabled:blocked||!text.trim(),onClick:send},isRunning?h('span',{className:'ui-spinner','aria-hidden':true}):Icon('send',{size:15}),t('发送'))),
  photoOpen&&h(GroupPhotoDialog,{state,request,chat,onToggleChat,onApi,onClose:()=>setPhotoOpen(false),onPhoto}));
}

const groupPhotoPlannerValue=binding=>binding?.enabled===true?String(binding.connectionId||''):'';
export const groupPhotoPlannerBinding=value=>value?{enabled:true,connectionId:String(value)}:{enabled:false,connectionId:null};
const plannerLabel=row=>[row?.name,row?.model,row?.reasoningEffort?t('推理强度（effort）')+': '+row.reasoningEffort:null].filter(Boolean).join(' · ');
// Two steps: (1) a chat connection writes the scene prompt, (2) the CG connection draws it.
export function GroupPhotoPlannerFields({planner,value,onChange,disabled=false,onEnableChat,onOpenApi,onOpenCg}){
 const id=React.useId(),options=planner?.options||[],savedValue=groupPhotoPlannerValue(planner?.binding),selected=value?options.find(row=>row.id===value):null;
 const missing=value&&!selected,invalid=missing||selected?.available===false;
 const effective=value?(selected||{connectionId:value}):savedValue===value?planner?.effective:null;
 const error=missing?t('所选提示词连接已不存在，请重新选择。'):selected?.error||(!value&&savedValue===value?planner?.effective?.error:'');
 const offline=planner?.enabled===false&&!error,saved=value===savedValue&&!error;
 return h('section',{className:'buddy-pipe','data-group-photo-planner':true},
  h('div',{className:'buddy-pipe-steps'},
   h('div',{className:'buddy-step on'+(error?' err':'')},
    h('label',{className:'buddy-step-h',htmlFor:id},h('b',null,'1'),t('写画面提示词'),h('small',null,t('提示词策划模型'))),
    h('select',{id,'aria-label':t('提示词策划模型'),'data-group-photo-planner-select':true,value,disabled,onChange:e=>onChange(e.target.value),'aria-describedby':id+'-help','aria-invalid':invalid||undefined},
     h('option',{value:''},t('自动（沿用入口角色／全局规则）')),
     missing&&h('option',{value},t('已失效的连接')+' · '+value),
     ...options.map(row=>h('option',{key:row.id,value:row.id,disabled:row.available===false&&row.id!==value},plannerLabel(row)+(row.available===false?' · '+t('不可用'):'')))),
    effective&&plannerLabel(effective)&&h('p',{className:'buddy-note','data-group-photo-effective-planner':true},t('本次策划模型')+'：'+plannerLabel(effective)),
    !effective&&!value&&note('保存或生成时按入口角色／全局规则解析。'),
    error?h('p',{className:'buddy-error',role:'alert'},Icon('alert',{size:13}),errorText(error)):saved&&h('span',{className:'buddy-ok'},Icon('check',{size:12}),t('已为这个群保存'))),
   h('span',{className:'buddy-pipe-arrow','aria-hidden':true},Icon('chevron',{size:16})),
   h('div',{className:'buddy-step'},
    h('span',{className:'buddy-step-h'},h('b',null,'2'),t('出图'),h('small',null,t('CG 绘图连接'))),
    h('p',{id:id+'-help',className:'buddy-note'},t('只选择写提示词使用的聊天连接；实际出图仍使用 CG 绘图连接。按群保存，不改变角色或全局聊天设置。')),
    onOpenCg&&h('button',{type:'button',className:'buddy-link',onClick:onOpenCg},t('在 API 配置里改')))),
  offline&&h('div',{className:'gx-alert '+(value?'warn':'info'),'data-group-photo-planner-offline':true},Icon(value?'alert':'globe',{size:16}),h('span',{className:'grow'},t(value?'联网聊天未开启：请先开启后再使用指定的策划模型。':'联网聊天未开启：本次使用本地提示词；开启后才调用所选策划模型。')),onEnableChat&&h('button',{type:'button',className:'gx-gbtn',onClick:onEnableChat},t('开启联网聊天'))),
  (invalid||offline&&!!value)&&h('div',{className:'buddy-inline-actions buddy-pipe-fix'},invalid&&onOpenApi&&h('button',{type:'button',onClick:onOpenApi},t('去 API 配置')),h('button',{type:'button',disabled,onClick:()=>onChange('')},t('改回自动'))),
  note('新合影使用所选策划模型；已有任务和重试保留原任务的模型与提示词。'),
 );
}
function GroupPhotoDialog({state,request,onClose,onPhoto,chat,onToggleChat,onApi}){
 const dialog=useRef(null),focus=useRef(null),token=useRef(null),operation=useRef(null),first=useRef(true),[preview,setPreview]=useState(null),[selected,setSelected]=useState([]),[plannerValue,setPlannerValue]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const group=activeCompanionGroup(state),chatOn=chat?chat.enabled!==false:null;
 const existing=preview&&[...(group.photos||[])].reverse().find(p=>p.range?.start===preview.range.start&&p.range?.end===preview.range.end&&p.characterIds?.length===selected.length&&p.characterIds.every(id=>selected.includes(id)));
 const options=preview?.planner?.options||[],usable=value=>!value||options.some(row=>row.id===value&&row.available!==false);
 const plannerInvalid=!usable(plannerValue),plannerOffline=preview?.planner?.enabled===false&&!!plannerValue;
 useEffect(()=>{focus.current=document.activeElement;dialog.current.showModal();return()=>{dialog.current?.close();focus.current?.isConnected&&focus.current.focus();};},[]);
 // Turning online chat on changes which planner applies, so the planner part is read again; the cast stays as chosen.
 useEffect(()=>{let live=true;request('companion-group-photo-preview',{id:group.id}).then(r=>{if(r.ok===false)throw Error(r.error);if(!live)return;if(first.current){first.current=false;setPreview(r.photo);setSelected(r.photo.characterIds);setPlannerValue(groupPhotoPlannerValue(r.photo.planner?.binding));}else setPreview(old=>old?{...old,planner:r.photo.planner}:r.photo);}).catch(e=>{if(live)setError(errorText(e));});return()=>{live=false;};},[group.id,chatOn]);
 // A planner choice is saved for this group as soon as it is made.
 const savePlanner=async value=>{if(operation.current||!preview||!usable(value))return;operation.current='save';setBusy(true);setError('');try{const r=await request('companion-group-photo-planner',{id:group.id,binding:groupPhotoPlannerBinding(value)});if(r.ok===false)throw Error(r.error);if(!r.photoPlanner)throw Error(t('提示词模型选择未返回，请重试。'));setPreview(old=>({...old,planner:r.photoPlanner}));setPlannerValue(groupPhotoPlannerValue(r.photoPlanner.binding));}catch(e){setError(errorText(e));}finally{operation.current=null;setBusy(false);}};
 const choosePlanner=value=>{token.current=null;setPlannerValue(value);setError('');void savePlanner(value);};
 const submit=async(regenerate=false)=>{if(operation.current||!preview||plannerInvalid)return;operation.current='submit';setBusy(true);setError('');token.current??=crypto.randomUUID();try{const r=await request('companion-group-photo',{id:group.id,characterIds:selected,range:preview.range,regenerate,clientRequestId:token.current,plannerBinding:groupPhotoPlannerBinding(plannerValue)});if(r.ok===false)throw Error(r.error);onClose();onPhoto?.(r.photo?.cgId);}catch(e){setError(errorText(e));}finally{operation.current=null;setBusy(false);}};
 const close=()=>{if(!operation.current)onClose();};
 return h('dialog',{ref:dialog,className:'buddy-dialog buddy-group-modal buddy-group-photo','aria-label':t('群聊合影 CG'),onKeyDownCapture:e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}},onCancel:e=>{e.preventDefault();close();}},
  h('header',null,h('h2',null,t('群聊合影 CG')),h('button',{type:'button',className:'buddy-dialog-close ui-icon-btn','aria-label':t('关闭')+' · '+t('群聊合影 CG'),disabled:busy,onClick:close},Icon('close',{size:18}))),
  h('div',{className:'buddy-group-modal-body'},
   note('依据本次已呈现的群聊内容设计。所选人物都使用自己的参考图，镜头外的参与者也在名单中。'),
   preview?h(F,null,
    h('p',{className:'buddy-photo-count'},h('b',null,t('{messages} 条对话 · {members} 位参与者').replace('{messages}',String(preview.messageCount)).replace('{members}',String(preview.characterIds.length))),' · ',t('点头像取消')),
    h('div',{className:'buddy-photo-parts'},...preview.characterIds.map(id=>{const on=selected.includes(id),c=state.characters?.find(x=>x.id===id);return h('button',{type:'button',key:id,'aria-pressed':on,disabled:busy,onClick:()=>{token.current=null;setSelected(old=>on?old.filter(x=>x!==id):[...old,id]);}},face(characterHead(c),companionCharacterName(c),'buddy-face sm'),companionCharacterName(c),on&&Icon('check',{size:14}));})),
    h('h4',{className:'buddy-subhead'},t('画面怎么生成')),
    h(GroupPhotoPlannerFields,{planner:preview.planner,value:plannerValue,onChange:choosePlanner,disabled:busy,onEnableChat:onToggleChat,onOpenApi:onApi?()=>{close();onApi('model');}:undefined,onOpenCg:onApi?()=>{close();onApi('cg');}:undefined}))
   :!error&&h('p',{className:'buddy-muted',role:'status'},t('读取中…')),
   existing&&h('div',{className:'gx-alert info'},Icon('info',{size:16}),h('span',{className:'grow'},t('这段对话已经有合影。查看不会发请求；重新生成会按上面的设置调用一次。已经在跑的任务和重试仍用原来的模型和提示词。'))),
   busy&&h('p',{role:'status',className:'buddy-muted'},t(operation.current==='save'?'正在保存选择…':'正在提交合影任务…')),
   error&&h('p',{className:'buddy-error',role:'alert'},error)),
  h('footer',{className:'buddy-group-modal-foot'},existing&&h('button',{type:'button',className:'whg-btn buddy-ghost',disabled:busy,onClick:()=>{if(operation.current)return;onClose();onPhoto?.(existing.cgId);}},t('查看已有合影')),h('span',{className:'spacer'}),h('button',{type:'button',className:'whg-btn',disabled:busy,onClick:close},t('取消')),
   h('button',{type:'button',className:'whg-btn buddy-primary',disabled:busy||!preview||!selected.length||plannerInvalid||plannerOffline,title:plannerOffline?t('先开启联网聊天'):undefined,onClick:()=>void submit(!!existing)},Icon('camera',{size:15}),t(busy&&operation.current==='submit'?'正在提交…':existing?'重新生成一张':'生成合影'))));
}
