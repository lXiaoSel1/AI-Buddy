// Native tray and pet context menus (design 5.5). They follow the system light/dark look, so only
// their contents change. Both return plain templates for Menu.buildFromTemplate, which keeps them testable.
import {t} from './i18n.mjs';

export function trayMenuTemplate({language='zh-CN',petVisible=true,gestureMode=false,open,setPetVisible,setGestureMode,quit}){
 const tr=text=>t(text,language);
 return [
  {label:tr('工作概览'),click:()=>open('overview')},
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
export function petContextTemplate({language='zh-CN',asleep=false,showStatusBadge=true,open,sleep,wake,setStatusBadge,hidePet}){
 const tr=text=>t(text,language);
 return [
  {label:tr('打开工作空间'),click:()=>open('overview')},
  {label:tr('打开 Galgame'),click:()=>open('galgame')},
  {type:'separator'},
  asleep?{label:tr('叫醒她'),click:wake}:{label:tr('让她睡一会儿'),click:sleep},
  {label:tr('显示状态条'),type:'checkbox',checked:showStatusBadge!==false,click:item=>setStatusBadge(item.checked)},
  {label:tr('隐藏桌宠'),click:hidePet},
 ];
}
