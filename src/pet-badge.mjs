// What the pet's status bar and bubble say. No DOM here, so every state can be tested.
import {t} from './i18n.mjs';
import {APP_NAME} from './app-brand.mjs';
import {TOOL_NAMES} from './token-types.mjs';
import {THEME_PALETTES} from './theme-palettes.mjs';

// tone: idle | ok | warn | busy (spinner); icon replaces the dot while she sleeps or is held.
// Returns null while she is in the air: the bar would only fly along with her.
export function badgeText({snapshot={},interaction=null,demo='',rigPilot=null,language='zh-CN'}={}){
 const tr=text=>t(text,language),motion=interaction?.motion??{},phase=interaction?.phase;
 if(demo)return {tone:'ok',label:tr('演示'),detail:demo};
 if(['flying','landing'].includes(motion.mode))return null;
 if(motion.mode==='charging')return {icon:'hand',label:tr('松开左键抛出'),detail:tr('Esc 取消')};
 if(['pressed','dragging'].includes(motion.mode)&&motion.button===2)return {icon:'hand',label:tr('按住左键蓄力'),detail:tr('Esc 取消')};
 if(motion.mode==='dragging')return {icon:'hand',label:tr('拖着走'),detail:tr('松开放下')};
 if(phase==='sleep-enter'||phase==='asleep')return {icon:'moon',label:tr('睡着了'),detail:tr('点一下叫醒')};
 if(rigPilot!==null&&rigPilot!==undefined)return {tone:'ok',label:tr('工作动作小样'),detail:rigPilot+'%'};
 if(snapshot.indexing)return {tone:'busy',label:tr('正在整理本地记录'),detail:''};
 const sessions=snapshot.sessions||[],running=sessions.filter(s=>s.displayStatus==='running').length,waiting=sessions.find(s=>s.displayStatus==='waiting');
 if(running)return {tone:'ok',label:tr('工作中'),detail:tr('{n} 个会话').replace('{n}',String(running))};
 if(waiting)return {tone:'warn',label:tr('等你回应'),detail:tr(TOOL_NAMES[waiting.provider]||waiting.provider||'')};
 return {tone:'idle',label:tr(APP_NAME),detail:tr('陪着你')};
}

// Splits the one-line feedback text into who / what happened and a second line.
// kind: ok | err | say | info | plain. open names the workspace page a click leads to.
export function bubbleView(value={},{language='zh-CN'}={}){
 const tr=text=>t(text,language),text=String(value.text??'');
 let match=/^(.+?)完成任务啦，辛苦了～$/.exec(text);
 if(match)return {kind:'ok',icon:'check',title:tr('{tool} 完成任务啦').replace('{tool}',tr(match[1])),detail:tr('辛苦了～')};
 match=/^(.+?)日志记录了错误，点我查看。$/.exec(text);
 if(match)return {kind:'err',icon:'alert',title:tr('{tool} 的日志记录了错误').replace('{tool}',tr(match[1])),link:tr('点我查看 ›'),open:'tokens'};
 if(value.source==='chat-error')return {kind:'err',icon:'alert',title:tr('聊天暂时失败'),detail:tr('稍后再试，或去 Galgame 看原因。')};
 if(value.source==='dialog')return {kind:'say',name:THEME_PALETTES.find(row=>row.id===value.characterId)?.name||'',title:text};
 if(value.kind==='badge-hidden')return {kind:'info',icon:'info',title:tr('状态条已隐藏'),detail:tr('右键桌宠，或在通用设置 › 桌宠里重新打开。'),undo:tr('撤销')};
 return {kind:'plain',title:text};
}
