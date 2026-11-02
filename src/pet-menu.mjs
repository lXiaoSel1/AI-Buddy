// Native tray and pet context menus (design 5.5). They follow the system light/dark look, so only
// their contents change. Both return plain templates for Menu.buildFromTemplate, which keeps them testable.
import {t} from './i18n.mjs';

export function trayMenuTemplate({language='zh-CN',petVisible=true,gestureMode=false,open,setPetVisible,setGestureMode,quit}){
 const tr=text=>t(text,language);
 return [
  {label:tr('工作概览'),click:()=>open('overview')},
  {label:tr('工作任务'),click:()=>open('agent-tasks')},
  {label:tr('扩展中心'),click:()=>open('plugins')},
  {label:tr('通用设置'),click:()=>open('settings')},
  {label:tr('动作展示'),click:()=>open('actions')},
  {label:tr('打开 Galgame'),click:()=>open('galgame')},
  {type:'separator'},
  {label:tr('显示桌宠'),type:'checkbox',checked:petVisible!==false,click:item=>setPetVisible(item.checked)},
  {label:tr('拖动模式（整个窗口可拖动）'),type:'checkbox',checked:!!gestureMode,click:item=>setGestureMode(item.checked)},
  {type:'separator'},
  {label:tr('退出'),click:quit},
 ];
}

// While she sleeps, "let her nap" turns into "wake her up". The status bar can be brought back here.
// foods (from the backpack) and recent plugin messages only add their submenus when the caller has that data.
// Approved design C11: the Feed submenu title shows her fullness when known; Recent plugin messages shows how many.
export function petContextTemplate({language='zh-CN',asleep=false,showStatusBadge=true,open,sleep,wake,setStatusBadge,hidePet,foods,feedTarget,fullness,canFeed=true,feed,recent=[],openRecent}){
 const tr=text=>t(text,language),feedTitle=Number.isFinite(fullness)?tr('喂 {name} · 饱食 {n}').replace('{name}',feedTarget).replace('{n}',String(Math.round(fullness))):tr('喂给 {name}').replace('{name}',feedTarget);
 const feedMenu=Array.isArray(foods)?[{label:tr('投喂'),submenu:[...(foods.length?[...(feedTarget?[{label:feedTitle,enabled:false},{type:'separator'}]:[]),...foods.map(food=>({label:food.label,enabled:canFeed,click:()=>feed?.(food.id)})),{type:'separator'}]:[]),{label:tr('去商店买…'),click:()=>open('shop')}]}]:[];
 const recentMenu=recent.length?[{type:'separator'},{label:tr('最近的插件消息 · {n}').replace('{n}',String(recent.length)),submenu:recent.map(row=>({label:row.title,click:()=>openRecent?.(row)}))}]:[];
 return [
  {label:tr('打开工作空间'),click:()=>open('overview')},
  {label:tr('打开 Galgame'),click:()=>open('galgame')},
  ...feedMenu,
  {label:tr('商店'),click:()=>open('shop')},
  {label:tr('背包'),click:()=>open('backpack')},
  ...recentMenu,
  {type:'separator'},
  asleep?{label:tr('叫醒她'),click:wake}:{label:tr('让她睡一会儿'),click:sleep},
  {label:tr('显示状态条'),type:'checkbox',checked:showStatusBadge!==false,click:item=>setStatusBadge(item.checked)},
  {label:tr('隐藏桌宠'),click:hidePet},
 ];
}
