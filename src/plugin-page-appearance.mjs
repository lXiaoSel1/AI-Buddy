// Plugin pages run in DSH pages with no Buddy stylesheet or language. After each document loads (and
// whenever settings change) the host gives the page the current theme as --buddy-* custom properties and
// marks the root with data-buddy-theme / data-buddy-scheme / data-buddy-lang (plus data-buddy-embedded when
// the page sits inside the main window), then fires "ai-buddy:appearance". This is a page-level convention
// only: no bridge method, payload or permission changes.
import {resolvedTheme,themeVariables,themeScheme} from './appearance.mjs';

const NAME=/^--buddy-[a-z0-9-]+$/,VALUE=/^(?!.*\/\*)[^;{}<>\\]*$/;
export const PAGE_UI_FONT='"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif';
// DSH's own frame, menus and toasts read --dsw-* tokens declared on body (and body[data-ds-dark-theme]).
// Point the common ones at the Buddy theme; ":root body" outranks both DSH rules.
const DSW=[['alias-bg-base','bg'],['alias-bg-layer-1','surface'],['alias-bg-layer-2','surface2'],['alias-bg-layer-3','raised'],['alias-bg-overlay','dlg-bg'],['alias-bg-mask-1','scrim'],
 ['specific-sidebar-fill','side-bg'],['specific-sidebar-nav-item-active','side-active'],['specific-sidebar-nav-item-active-accent','side-accent'],['specific-menu','dlg-bg'],['menu-surface-fill','dlg-bg'],['specific-input-major','surface2'],
 ['alias-label-primary','text'],['alias-label-secondary','muted'],['alias-label-tertiary','muted'],['alias-label-caption','muted'],['alias-label-primary-inverted','on-accent'],['alias-link','accent-text'],
 ['alias-border-l1','border'],['alias-border-l2','border'],['alias-border-l3','border'],['alias-border-l4','border'],
 ['alias-brand-primary','accent'],['alias-brand-text','accent-text'],['alias-button-primary-fill','accent'],['alias-button-primary-hover','accent-hover'],
 ['alias-interactive-bg-hover','surface2'],['alias-interactive-bg-active','raised'],
 ['alias-state-error-primary','err'],['alias-state-success-primary','ok'],['alias-state-warn-primary','warn'],['font-family','f-ui']];
export const DSW_THEME_CSS=':root body,:root body[data-ds-dark-theme]{'+DSW.map(([token,buddy])=>`--dsw-${token}:var(--buddy-${buddy})`).join(';')+'}';
// Inside the main window only DSH's centre column (the plugin page) stays. DSH 0.2.1-rc.3 hashes its class
// names, so these rules use its stable attributes: the frame is the element with both a data-rightbar-col child
// and a child holding the main slot (:has() may not contain :has(), or Chromium drops the whole rule). Columns keep their grid tracks (width 0) so the page stays
// in the middle track; the drag handles are the frame's own [data-side] children (popovers also use data-side).
const FRAME=':has(>[data-rightbar-col]):has(>*>[data-slot="main"])',CENTER=FRAME+'>:has(>[data-slot="main"])';
// C-3 stop-gap: DSH's centre column is overflow:hidden, and the 2.0.1 Bilibili / QQ roots only have min-height:100%,
// so they could not scroll. The column scrolls now; its slot wrapper is display:contents, so the plugin root is the
// column's own flex item and keeps its full height. A root that scrolls itself (the work page: height:100%) never
// overflows the column, so there is no second scrollbar.
export const EMBEDDED_FRAME_CSS=[
 `html[data-buddy-embedded] ${FRAME}{grid-template-columns:0 minmax(0,1fr) 0!important;padding-top:0!important}`,
 `html[data-buddy-embedded] ${FRAME}>:has(>[data-slot="sidebar"]),html[data-buddy-embedded] ${FRAME}>[data-rightbar-col]{visibility:hidden!important;min-width:0!important;overflow:hidden!important;border:0!important}`,
 `html[data-buddy-embedded] ${FRAME}>[data-side],html[data-buddy-embedded] ${FRAME}>[data-shell-leading]{display:none!important}`,
 `html[data-buddy-embedded] ${CENTER}{border-radius:0!important;border-left:0!important}`,
 `html[data-buddy-embedded] ${CENTER}{overflow-y:auto!important;overscroll-behavior:contain}`,
 `html[data-buddy-embedded] ${CENTER}>[data-slot="main"]>*{flex-shrink:0}`].join('');
// The same stop-gap in a plugin's own window, only while the column holds a Bilibili or QQ page (DSH's own panels keep theirs).
const SOCIAL_ROOT=':is(.bili,.qq)';
export const WINDOW_PAGE_CSS=[
 `html:not([data-buddy-embedded]) ${FRAME}>:has(>[data-slot="main"]>${SOCIAL_ROOT}){overflow-y:auto!important;overscroll-behavior:contain}`,
 `html:not([data-buddy-embedded]) ${CENTER}>[data-slot="main"]>${SOCIAL_ROOT}{flex-shrink:0}`].join('');
// C-1: character faces as --buddy-face-<id>: url("data:image/…;base64,…"). These do not pass the theme value filter
// above: ids and data are checked on their own, and the rule stays bounded.
export const FACE_ID=/^[a-z0-9][a-z0-9-]{0,39}$/;
const FACE_DATA=/^data:image\/(?:webp|png|jpeg|avif);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const FACE_MAX_BYTES=64*1024,FACES_MAX_BYTES=1024*1024,FACES_MAX=48;
export const validFace=(id,data)=>typeof id==='string'&&FACE_ID.test(id)&&typeof data==='string'&&data.length<=FACE_MAX_BYTES&&FACE_DATA.test(data);
export function pluginFaceCss(faces){
 if(!faces||typeof faces!=='object')return '';
 const rows=[];let bytes=0;
 for(const id of Object.keys(faces).sort()){const data=faces[id];if(!validFace(id,data))continue;const row=`--buddy-face-${id}:url("${data}")`;if(rows.length>=FACES_MAX||bytes+row.length>FACES_MAX_BYTES)break;rows.push(row);bytes+=row.length;}
 return rows.length?':root{'+rows.join(';')+'}':'';
}
export const PORTRAIT_MAX_BYTES=128*1024,PORTRAITS_MAX_BYTES=1024*1024,PORTRAITS_MAX=24;
export const validPortrait=(id,data)=>typeof id==='string'&&FACE_ID.test(id)&&typeof data==='string'&&data.length<=PORTRAIT_MAX_BYTES&&FACE_DATA.test(data);
export function pluginPortraitCss(portraits){
 if(!portraits||typeof portraits!=='object')return '';
 const rows=[];let bytes=7;
 for(const id of Object.keys(portraits).sort()){const data=portraits[id];if(!validPortrait(id,data))continue;const row=`--buddy-portrait-${id}:url("${data}")`;if(rows.length>=PORTRAITS_MAX||bytes+row.length+(rows.length?1:0)>PORTRAITS_MAX_BYTES)break;bytes+=row.length+(rows.length?1:0);rows.push(row);}
 return rows.length?':root{'+rows.join(';')+'}':'';
}
export function pluginPageAppearance(preferences={},character='deepseek',{embedded=false,faces=null,portraits=null}={}){
 const theme=resolvedTheme(preferences,character),scheme=themeScheme(theme),lang=preferences.language==='en'?'en':'zh-CN';
 // appearance.css defines the UI font statically and theme heading fonts may fall back to it
 const declarations=['--buddy-f-ui:'+PAGE_UI_FONT,...Object.entries(themeVariables(theme)).filter(([name,value])=>NAME.test(name)&&VALUE.test(String(value))).map(([name,value])=>name+':'+value)];
 // --buddy-panel is the name the work page already reads for its card surface
 declarations.push('--buddy-panel:var(--buddy-surface)','color-scheme:'+scheme);
 // theme values sit in the first rule only; the rules after it are fixed text, then the checked faces
 return Object.freeze({theme,scheme,lang,embedded:embedded===true,css:':root{'+declarations.join(';')+'}'+DSW_THEME_CSS+(embedded===true?EMBEDDED_FRAME_CSS:WINDOW_PAGE_CSS)+pluginFaceCss(faces)+pluginPortraitCss(portraits)});
}
// DSH's first-use toast about its own default workspace ("无法创建默认工作区…") is about DSH's workspace list, which
// plugin pages do not show; it must not cover the plugin. Only that toast (DSH's Toast primitive, every DSH locale) is
// hidden; other toasts and the plugin's own messages are left alone. Installed once per document.
export const DSH_WORKSPACE_NAG=Object.freeze(["无法创建默认工作区，请通过“选择工作区”选择文件夹","Unable to create default workspace. Use Choose workspace to select a folder.","デフォルトのワークスペースを作成できません。ワークスペースを選択してフォルダーを選んでください。","No se puede crear el espacio de trabajo predeterminado. Utilice Elegir espacio de trabajo para seleccionar una carpeta.","Impossible de créer un espace de travail par défaut. Utilisez Choisir un espace de travail pour sélectionner un dossier.","Der Standardarbeitsbereich kann nicht erstellt werden. Verwenden Sie „Arbeitsbereich auswählen“, um einen Ordner auszuwählen.","Невозможно создать рабочую область по умолчанию. Используйте «Выбрать рабочее пространство», чтобы выбрать папку.","Não foi possível criar o espaço de trabalho padrão. Use Escolher espaço de trabalho para selecionar uma pasta."]);
export const DSH_NAG_GUARD=`(()=>{const b=document.body;if(!b||window.__buddyNagGuard)return;window.__buddyNagGuard=1;const texts=${JSON.stringify(DSH_WORKSPACE_NAG)},hide=n=>{if(n&&n.nodeType===1&&n.getAttribute('role')==='alert'&&(n.getAttribute('style')||'').includes('--dsh-toast-hold')&&texts.includes((n.textContent||'').trim()))n.style.setProperty('display','none','important');};for(const n of b.children)hide(n);new MutationObserver(list=>{for(const m of list)for(const n of m.addedNodes)hide(n);}).observe(b,{childList:true});})()`;
export function pluginPageAppearanceScript({theme,scheme,lang,embedded=false}){
 const detail=JSON.stringify({theme,scheme,lang,embedded:embedded===true});
 return `(()=>{const d=${detail},r=document.documentElement;r.dataset.buddyTheme=d.theme;r.dataset.buddyScheme=d.scheme;r.dataset.buddyLang=d.lang;if(d.embedded)r.dataset.buddyEmbedded='1';else delete r.dataset.buddyEmbedded;r.lang=d.lang;window.dispatchEvent(new CustomEvent('ai-buddy:appearance',{detail:d}));})();`+DSH_NAG_GUARD;
}
// Returns the key of the stylesheet now in the page, so the next call can replace it. Never throws:
// a page that is closing or refuses the script keeps working with its own styles.
export async function applyPluginPageAppearance(webContents,appearance,previousKey=null){
 if(!appearance||!webContents||webContents.isDestroyed?.()||typeof webContents.insertCSS!=='function')return previousKey;
 let key=previousKey;
 try{key=await webContents.insertCSS(appearance.css,{cssOrigin:'author'});if(previousKey&&previousKey!==key)await webContents.removeInsertedCSS?.(previousKey).catch?.(()=>{});}catch{return previousKey;}
 try{await webContents.executeJavaScript?.(pluginPageAppearanceScript(appearance),false);}catch{}
 return key;
}
