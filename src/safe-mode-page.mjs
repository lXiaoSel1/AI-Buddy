import React from 'react';
import {t} from './i18n.mjs';
const h=React.createElement;
// B6: when the companion store cannot start, the panel opens at #safe-mode. Only the
// companion features stop; the pet and local usage monitoring keep working.
export function SafeModePage({settings,onPage,time=value=>value}){
 const failure=settings?.startupFailure;
 return h('section',{className:'card safe-mode','data-safe-mode':true},
  h('h1',null,t("陪伴功能已停用（安全模式）")),
  h('p',null,t("AI 酱启动时没能载入角色与对话的数据，所以 Galgame、角色管理、群聊和人生存档暂时停用。")),
  h('div',{className:'safe-mode-reason',role:'alert'},h('strong',null,t("原因")),h('p',null,failure?.message||t("未知原因")),failure?.at&&h('small',null,time(failure.at))),
  h('p',null,t("桌宠和用量监控照常可用。")),
  h('p',{className:'settings-note'},t("问题处理好后，重新启动 AI 酱即可恢复陪伴功能。")),
  h('div',{className:'settings-actions'},h('button',{onClick:()=>onPage('overview')},t("查看工作概览")),h('button',{onClick:()=>onPage('settings')},t("打开通用设置"))));
}
