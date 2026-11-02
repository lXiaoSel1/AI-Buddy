// Plain-language rows for the capability ids a plugin declares (approved design B3). Granting stays per id:
// the install page lists every declared id with its own checkbox; unknown ids are shown as they are.
import {locale} from './i18n.mjs';
const L=(zh,en)=>({zh,en});
const pick=value=>value&&(locale()==='en'?value.en:value.zh);
// tag: 'model' = calls your chat model; 'review' = touches an account, files or speaks for you
const CAPABILITIES={
 'social.context.read':['users',L('读取她的心情和记忆摘要','Read her mood and memory summary')],
 'activity.lease':['clock',L('申请一段活动时间（比如一起看视频）','Reserve an activity slot, such as watching together')],
 'activity.check':['clock',L('查看今天的活动额度还剩多少','Check how much of today’s activity quota is left')],
 'activity.finish':['clock',L('结束活动并记下结果','End an activity and record what happened')],
 'models.request':['sparkle',L('用你的聊天模型写回复或文字','Use your chat model to write replies or text'),'model'],
 'experience.append':['memory',L('把这次经历写进她的记忆','Add this experience to her memories')],
 'proactive.offer':['chats',L('准备想主动跟你说的话','Prepare things she wants to tell you')],
 'proactive.claim':['chats',L('在你允许的地方主动开口','Speak first where you allow it'),'review'],
 'search.native':['globe',L('用模型自带的联网搜索','Use the model’s own web search'),'model'],
 'owner.work.propose':['shield',L('可信主人通过私聊交代工作（计划仍要你批准）','A trusted owner can request work by DM (you still approve the plan)'),'review'],
 'owner.work.read':['shield',L('查看可信主人交代的工作进度','Read the progress of work a trusted owner asked for')],
 'owner.work.approve':['shield',L('转达可信主人对计划的批准','Pass on a trusted owner’s plan approval'),'review'],
 'owner.work.cancel':['shield',L('转达可信主人取消工作','Pass on a trusted owner’s cancellation')],
 'connections.request':['link',L('使用你连接的账号','Use an account you connected'),'review'],
 'connections.open':['link',L('打开你连接的账号','Open an account you connected'),'review'],
 'connections.events':['link',L('接收这个账号收到的新消息','Receive new messages on that account'),'review'],
 'connections.close':['link',L('断开账号连接','Close the account connection')],
 'ui.bubble':['hand',L('在桌宠上冒气泡','Show bubbles on the pet')],
 'ui.registerPage':['external',L('加一个自己的插件页面','Add its own plugin page')],
 'lifecycle.register':['power',L('跟着 AI 酱一起启动和退出','Start and stop with AI Buddy')],
 'characters.getContext':['users',L('读取参与角色的设定','Read the characters’ profiles')],
 'memory.appendEvent':['memory',L('把工作经历写进她的记忆','Add work to her memories')],
 'usage.record':['coin',L('记录用量','Record usage')],
 'notifications.publish':['info',L('发送完成和出错通知','Send done and error notices')],
 'work.host':['nav-work',L('在你选的项目文件夹里运行工作引擎','Run work engines in project folders you choose'),'review'],
 'tools.list':['terminal',L('查看可以使用的工具','See which tools it may use')],
 'tools.invoke':['terminal',L('使用工具：读写文件、运行命令','Use tools: read and write files, run commands'),'review'],
 'archive.read':['archive',L('读取归档的旧任务','Read archived tasks')],
 'archive.restore':['archive',L('恢复归档的旧任务','Restore archived tasks')],
};
const TAGS={model:L('会用模型','Uses model'),review:L('需要注意','Review')};
export function capabilityView(id){const row=CAPABILITIES[id];return row?{id,icon:row[0],label:pick(row[1]),tag:row[2]??null,tagLabel:pick(TAGS[row[2]])}:{id,icon:'plug',label:id,tag:null,tagLabel:null};}
// What the install page says about each official plugin (approved design B3, round 3).
const OFFICIAL={
 '@ai-buddy/bilibili-companion':{icon:'tv',name:L('B站陪伴','Bilibili Companion'),
  does:[['clock',L('每天按额度安排几段一起看的时间','Schedules a few watching slots a day, within a quota')],['memory',L('看完写看后感，记进她的经历','Writes notes afterwards and adds them to her experiences')],['send',L('可以帮你写评论，发不发由你定','Can draft comments; you decide whether they go out')]],
  need:[['link',L('B站账号','A Bilibili account'),L('装好后在「账号连接」里扫码','Scan a QR code under Accounts after installing')]],
  later:[['eye',L('观看和发评论分开授权，装好后在设置里分别打开','Watching and commenting are granted separately in its settings')],['send',L('发评论前怎么确认，在设置里选：先预览再发，或生成后直接发','How comments are confirmed is your choice in settings: preview first, or post directly')]],
  next:L('连接 B站账号','Connect Bilibili'),nextAction:'accounts'},
 '@ai-buddy/qq-connect':{icon:'chats',name:L('QQ连接','QQ Connect'),
  does:[['chats',L('选一位角色，替你回复你允许的人和群','A character answers the contacts and groups you allow')],['users',L('群里只在被 @ 时回复，主动开话题默认关闭','In groups she replies only when mentioned; starting topics is off by default')],['shield',L('可信主人可以私聊交代工作，计划仍要你批准','A trusted owner can request work by DM; you still approve the plan')]],
  need:[['link',L('QQ 账号','A QQ account'),L('装好后扫码登录；第一次扫码会下载 QQ 登录组件','Scan to sign in after installing; the first scan downloads the QQ sign-in component')]],
  later:[['chats',L('某个群要打开「安静时主动开话题」时','When you turn on quiet-time openers for a group')],['nav-work',L('可信主人交代的工作，每份计划都要你批准','Every plan from a trusted owner needs your approval')]],
  next:L('扫码登录 QQ','Sign in to QQ'),nextAction:'accounts'},
 '@ai-buddy/work-collaboration':{icon:'nav-work',name:L('工作与协作','Work'),
  does:[['users',L('几位角色一起做你的项目','Several characters work on your project together')],['file',L('每份计划先给你看，批准后才开始改文件','You see each plan first; files change only after you approve')],['info',L('完成和出错都会通知你','You are told when work finishes or fails')]],
  need:[['bolt',L('一个工作引擎','A work engine'),L('Codex、Claude 这类本机已登录的工作引擎','A work engine signed in on this PC, such as Codex or Claude')]],
  later:[['file',L('每个任务的计划，包括改过的每一版，都要你批准','Each task plan, and every revision of it, needs your approval')],['chats',L('工作引擎遇到要你决定的问题时，任务会停下来等你回答','When an engine needs a decision, the task waits for your answer')]],
  next:L('选择工作引擎','Choose an engine'),nextAction:'work'}
};
// One-line descriptions of the official plugins (design B1/B3 copy, contract C-6).
const DESCRIPTIONS={'@ai-buddy/bilibili-companion':L('角色陪你看 B站视频，看完聊聊，也可以帮你写评论。','Characters watch Bilibili videos with you, talk about them, and can draft comments.'),'@ai-buddy/qq-connect':L('让角色在 QQ 里回复你允许的人和群。','Lets a character answer the QQ contacts and groups you allow.'),'@ai-buddy/work-collaboration':L('几位角色一起做项目，每一步先给你看计划。','Characters work on your projects together; you approve each plan.')};
export function officialProfile(packageName){const p=OFFICIAL[packageName];if(!p)return null;const rows=list=>list.map(([icon,a,b])=>({icon,text:pick(a),sub:pick(b)}));return {icon:p.icon,name:pick(p.name),description:pick(DESCRIPTIONS[packageName]),does:rows(p.does),need:rows(p.need),later:rows(p.later),next:pick(p.next),nextAction:p.nextAction};}
export const pluginIcon=packageName=>OFFICIAL[packageName]?.icon??'plug';
export const pluginName=(packageName,fallback)=>pick(OFFICIAL[packageName]?.name)??fallback??packageName;
// A catalog work's own text in the current language: official plugins from an official source use the profile above;
// community works use their optional signed `locales.en` (C-6) and fall back to the original text.
export function workText(work,{official=false}={}){
 const en=locale()==='en',local=en?work?.locales?.en:null,profile=official&&OFFICIAL[work?.packageName];
 return {name:profile?pick(profile.name):local?.name??work?.name??work?.packageName??'',description:profile?pick(DESCRIPTIONS[work.packageName]):local?.description||work?.description||'',readme:local?.readme??work?.readme??null};
}
export const releaseNotes=release=>(locale()==='en'?release?.locales?.en?.notes:null)??release?.notes??null;
// The 1.9-era official extensions shown under Sources (B6); their manifests carry Chinese text only.
const LEGACY={'ai-buddy.kimi-engine':[L('Kimi 工作引擎','Kimi work engine'),L(null,'Engine for running work tasks with Kimi. You enable it; it never starts tasks on its own.')],'ai-buddy.kimi-runtime':[L('Kimi 2.3.1 Windows 运行引擎','Kimi 2.3.1 Windows runtime'),L(null,'Kimi’s official 2.3.1 package kept byte-for-byte; makes no model calls itself.')]};
export function legacyText(manifest,{official=false}={}){const row=official&&LEGACY[manifest?.id];return {name:row?pick(row[0]):manifest?.name??'',description:(row&&pick(row[1]))||manifest?.description||''};}
// Sizes as the design writes them: 48 KB, 8.7 MB.
export const formatBytes=bytes=>!Number.isFinite(bytes)||bytes<=0?'':bytes>=1e9?(bytes/1e9).toFixed(1)+' GB':bytes>=1e6?(bytes/1e6).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1e3))+' KB';
