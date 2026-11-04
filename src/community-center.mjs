import React, { useCallback, useEffect, useRef, useState } from "react";
import { PluginCenter } from "./plugin-center.mjs";
import { SocialAccounts } from "./social-accounts-ui.mjs";
import { pluginErrorText, pluginResult } from "./plugin-center-helpers.mjs";
import { locale, t as coreT } from "./i18n.mjs";
import { communityMessages, communityErrorText, communityCount } from "./community/messages.mjs";
import { Icon } from "./ui-icons.mjs";
import { StatusPill, Tabs, EmptyState, Menu, Switch } from "./ui-controls.mjs";
import { Dialog } from "./ui-dialog.mjs";
import { InstallPage, PluginLogo, installStage } from "./community-install-page.mjs";
import { WorkDetail, AuthorDialog } from "./community-detail.mjs";
import { OfflineImportDialog } from "./community-offline-dialog.mjs";
import { pluginName, workText, releaseNotes, legacyText, formatBytes } from "./community-capabilities.mjs";
import { EMBED_TARGETS, embedCapable, embedTargetFor } from "./plugin-embed-targets.mjs";
const h = React.createElement;
const t = (value) => locale() === "en" ? communityMessages[value] ?? coreT(value) : coreT(value);
const tn = (key, n) => communityCount(key, n, t);
// Two-language captions whose Chinese words already mean something else in en.json (「启用」 is the action "Enable").
const L = (zh, en) => locale() === "en" ? en : zh;
const fill = (text, values = {}) => Object.entries(values).reduce((value, [key, next]) => value.replaceAll("{" + key + "}", next), text);
const stages = { queued: "已排队", running: "正在维护", completed: "完成", failed: "失败", cancelled: "已取消", "needs-user": "需要重新确认", "interrupted-needs-user": "需要检查", "component-required": "需要准备运行组件" };
const stageTone = { queued: "idle", running: "busy", completed: "ok", failed: "err", cancelled: "idle", "needs-user": "warn", "interrupted-needs-user": "warn", "component-required": "warn" };
const categories = [["", "全部分类"], ["function", "功能与活动"], ["work-engine", "工作引擎"], ["character-motion", "角色与动作"], ["theme-scene", "主题与场景"], ["voice", "语音"]];
const SOCIAL_LOGIN = { "@ai-buddy/bilibili-companion": "bilibili", "@ai-buddy/qq-connect": "qq" };
const WORK = "@ai-buddy/work-collaboration";
const refs = (work) => ({ sourceId: work.sourceId, id: work.id });
const latestVersion = (work) => [...(work?.releases ?? [])].sort((a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0))[0]?.version;
const button = (label, onClick, props = {}) => h("button", { type: "button", className: "ui-btn", onClick, ...props }, t(label));
const errorText = (cause) => communityErrorText(cause?.code) ?? pluginErrorText(cause);
export function CommunityBusyNotice({pending = false, action, phase, maintenance}) {
  const active = maintenance?.jobs?.find(job => job.state === 'running');
  if (!pending && !active) return null;
  const labels = {'verifying-component': '正在核验 DSH 运行组件…', 'checking-plugin': '正在启动原生宿主并检查插件…', 'host-starting': '正在启动原生宿主并检查插件…', inspecting: '正在检查插件安装计划…', installing: '正在安装插件…', applying: '正在应用插件变更…'};
  // A running maintenance job on its own names its operation; a request of this page names what it is doing.
  const text = labels[phase] ?? (pending && action ? action : null) ?? (active?.operation === 'install' ? '正在安装插件…' : '正在处理插件请求…');
  return h('section', {className: 'ui-note ext-busy', role: 'status', 'aria-live': 'polite', 'aria-busy': true, 'data-community-operation-progress': phase ?? 'request'}, h('span', {className: 'ui-spinner', 'aria-hidden': true}), h('div', null, h('strong', null, t(text)), phase === 'verifying-component' && h('p', null, t('首次启动会完整核对运行组件，检查完成后将显示安装计划。'))));
}
function CommunityRuntimeNotice({ state, needed = false, technicalError, onPrepare, onLocal, busy = false }) {
  const show = needed || state?.ready === false, code = technicalError || state?.code;
  if (!show && !code) return null;
  return h(
    "div",
    { className: "ext-runtime" },
    show && h("div", { className: "ui-alert warn", "data-dsh-component-required": true }, Icon("bolt", { size: 16 }), h("div", null, h("strong", null, t("需要准备 DSH 运行组件")), h("p", null, t("原生插件需要匹配的运行组件。准备完成后可继续安装或打开插件。")), h("button", { type: "button", className: "ui-btn sm", onClick: onPrepare, disabled: busy }, t("准备运行组件")), onLocal && h("button", { type: "button", className: "ui-btn ghost sm", onClick: onLocal, disabled: busy }, t("从本地组件安装（高级）")))),
    code && h("details", null, h("summary", null, t("技术详情")), h("pre", null, (technicalError?.code ?? state?.code) + "\n" + (technicalError?.message ?? state?.message ?? "")))
  );
}
function CommunityCategoryOptions({ capabilities }) {
  return categories.map(([value, label]) => h("option", { key: value, value, disabled: !!value && capabilities?.[value]?.installable !== true }, t(label) + (value && capabilities?.[value]?.installable !== true ? " · " + t("尚未开放安装") : "")));
}
// B4: 运行中 / 加载中 / 已停用 / 加载失败. 「加载中」 is an enabled plugin that has not been loaded since this start.
export const runtimeLabel = (record) => record.runtimeVerified && record.enabled ? "运行中" : record.runtimeFailure || record.runtimeState === "failed" ? "加载失败" : record.enabled ? "加载中" : "已停用";
const runtimeTone = { "运行中": "ok", "加载失败": "err", "加载中": "info", "已停用": "idle" };
// compact: the installed list shows the enabled intent as its switch, so only the observed state is written out.
export function CommunityInstallationStatus({ record, compact = false }) {
  const label = runtimeLabel(record);
  return h(React.Fragment, null, h(StatusPill, { tone: runtimeTone[label], "data-dsh-runtime-state": record.runtimeState ?? (record.runtimeVerified ? "loaded" : "pending-load") }, t(label)), !compact && h("small", null, t(record.enabled ? "启用设置：已开启" : "启用设置：已关闭")), !compact && record.runtimeFailure && h("details", null, h("summary", null, t("技术详情")), h("pre", null, record.runtimeFailure.code + "\n" + record.runtimeFailure.message)));
}
// A load failure in one plain sentence (B4); the code and native message stay in 技术详情.
export const failureReason = (failure) => communityErrorText(failure?.code) ?? t("加载没有成功，原因写在技术详情里。");
/** The one line under an installed plugin (B4): what it is doing now, from data the host already has. */
export function installedSituation(record, { jobs = null, accounts = null } = {}) {
  const permissions = tn("{n} 项权限",record.grantedCapabilities?.length ?? 0);
  if (record.runtimeFailure || record.runtimeState === "failed") return failureReason(record.runtimeFailure);
  if (!record.enabled) return t("停用期间不会运行，记录和设置都保留") + " · " + permissions;
  if (record.packageName === WORK && jobs != null) return (jobs ? tn("{n} 个任务进行中",jobs) : t("没有进行中的任务")) + " · " + permissions;
  if (SOCIAL_LOGIN[record.packageName] && accounts) { const account = accounts.find((value) => value.pluginId === record.packageName && value.enabled); return (account ? t("已连接「{name}」").replace("{name}", account.label) : t("还没有连接账号")) + " · " + permissions; }
  return permissions;
}
// 「上次检查：今天 19:32」 (B5)
export function checkedLabel(date, now = new Date()) {
  const time = date.toLocaleTimeString(locale() === "en" ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit" }), day = (value) => value.toDateString();
  return day(date) === day(now) ? t("今天 {time}").replace("{time}", time) : (date.getMonth() + 1) + "-" + String(date.getDate()).padStart(2, "0") + " " + time;
}
const nameOf = (packageKey, installed) => pluginName(installed?.find((value) => value.packageKey === packageKey)?.packageName ?? packageKey?.split(":").at(-1));
/** What a maintenance record says (B5): why it waits, what failed and whether the old version is kept, or when it finished. */
export function maintenanceNote(job, { ahead = null, kept = false } = {}) {
  const error = job.error && (communityErrorText(job.error.code) ?? job.error.message);
  if (job.state === "queued") return job.waitingReason === "active-work" ? t("等工作任务停下来后再进行，不会打断正在进行的任务。") : ahead ? t("排在「{name}」之后。").replace("{name}", ahead) : t("马上开始。");
  if (job.state === "running") return t("正在进行，这一步不能取消。");
  if (job.state === "needs-user") return error ?? t("来源、权限或资料变了，需要你重新确认。");
  if (job.state === "interrupted-needs-user") return t("上次维护被中断，需要先检查实际状态。");
  if (job.state === "failed") return (error ?? t("没有完成。")) + (job.operation === "install" && kept ? " " + t("原来的版本保留着。") : "");
  if (job.state === "cancelled") return t("已取消。");
  if (job.state === "completed") { const at = job.updatedAt ? checkedLabel(new Date(job.updatedAt)) + " · " : "", done = { install: "装好了 {version}", enable: "已启用", disable: "已停用", rollback: "回退到了 {version}", uninstall: "已卸载" }[job.operation]; return at + (done ? t(done).replace("{version}", job.version ?? "") : t("完成")); }
  return "";
}
// Review 中-3: 「查看」 for records that need a decision (needs-user, interrupted, failures that are not plain retries) only opens
// the plan review or the normal confirmation; 「重试」 is offered only for failures that can safely run again.
const RETRYABLE = new Set(["COMMUNITY_INSTALLATION_CHANGED", "PLUGIN_BUSY", "DSH_PACKAGE_DOWNLOAD_FAILED", "MAINTENANCE_FAILED", "DSH_OPERATION_FAILED", "DSH_INSTALL_CANCELLED", "DSH_ACTIVATION_FAILED", "DSH_ENABLE_UNCONFIRMED", "DSH_RUNTIME_NOT_READY", "DSH_COMPONENT_REQUIRED"]);
export const maintenanceAction = (job) => ["needs-user", "interrupted-needs-user"].includes(job.state) ? "review" : job.state === "failed" ? RETRYABLE.has(job.error?.code) ? "retry" : "review" : null;
export function MaintenanceRow({ job, installed, ahead, busy, onCancel, onRetry, onReview }) {
  const name = job.packageKey?.split(":").at(-1), kept = !!installed?.some((value) => value.packageKey === job.packageKey);
  const action = { install: "安装", enable: "启用", disable: "停用", uninstall: "卸载", rollback: "回退" }[job.operation] ?? job.operation;
  const next = maintenanceAction(job);
  return h("div", { className: "ext-qrow", "data-maintenance-state": job.state },
    h(PluginLogo, { packageName: name, size: 32 }),
    h("div", { className: "ext-ir-main" }, h("b", null, pluginName(name) + " · " + t(action) + (job.version && ["install", "rollback"].includes(job.operation) ? " " + job.version : "")), h("small", { className: "ext-cap", role: job.error ? "status" : undefined }, maintenanceNote(job, { ahead, kept })),
      job.error && h("details", { className: "ext-tech" }, h("summary", null, t("技术详情")), h("code", null, job.error.code + "\n" + (job.error.message ?? "")))),
    h(StatusPill, { tone: stageTone[job.state] ?? "idle" }, t(stages[job.state] ?? job.state)),
    ["queued", "needs-user"].includes(job.state) && h("button", { type: "button", className: "ui-btn ghost sm", disabled: busy, onClick: () => onCancel(job) }, t("取消这次维护")),
    next && h("button", { type: "button", className: "ui-btn sm", disabled: busy, "data-maintenance-action": next, onClick: () => next === "retry" ? onRetry(job) : onReview(job) }, Icon(next === "retry" ? "refresh" : "eye", { size: 14 }), t(next === "retry" ? "重试" : "查看")));
}
export function UpdateCard({ update, record, busy, onReview }) {
  const name = record?.packageName ?? update.packageKey.split(":").at(-1), changes = (update.changes ?? []).filter((row) => releaseNotes(row));
  return h("article", { className: "ws-card ext-upd", "data-update": update.packageKey }, h(PluginLogo, { packageName: name, size: 44 }),
    h("div", { className: "ext-ir-main" },
      h("div", { className: "ext-row" }, h("b", null, pluginName(name)), h("span", { className: "ext-cap" }, update.from + " → " + update.to), !["available", "needs-user"].includes(update.state) && stages[update.state] && h(StatusPill, { tone: stageTone[update.state] ?? "idle" }, t(stages[update.state])), update.addedCapabilities?.length > 0 && h(StatusPill, { tone: "warn" }, tn("新增 {n} 项权限",update.addedCapabilities.length)), update.incompatibleData && h(StatusPill, { tone: "warn" }, t("资料版本变化"))),
      changes.length > 0 && h("details", { className: "ext-tech ext-changes", open: true }, h("summary", null, t("更新内容")), h("ul", { className: "ext-bul" }, ...changes.map((row) => h("li", { key: row.version }, Icon("check", { size: 14 }), h("span", null, (changes.length > 1 ? row.version + " · " : "") + releaseNotes(row)))))),
      update.addedCapabilities?.length > 0 && h("small", { className: "ext-cap" }, t("新增能力需要重新确认")), update.incompatibleData && h("small", { className: "ext-cap" }, t("资料版本变化，暂不自动更新。")), update.error && h("small", { className: "ext-cap", role: "status" }, communityErrorText(update.error.code) ?? update.error.message)),
    h("button", { type: "button", className: "ui-btn primary", disabled: busy || update.incompatibleData || update.state === "queued", onClick: () => onReview(update) }, t("查看并更新…")));
}
function Stars({ value }) {
  return h("span", { className: "ext-stars", "aria-label": t("{n} 星").replace("{n}", value.toFixed(1)) }, Icon("star", { size: 13 }), value.toFixed(1));
}
/** G2 entry point: scroll an installed plugin's row into view, focus it and mark it (data-reveal) for a moment. */
function revealInstalledRecord(packageName, root = globalThis.document) {
  const row = [...(root?.querySelectorAll?.("[data-dsh-record]") ?? [])].find((node) => node.dataset.dshRecord?.endsWith(":" + packageName));
  if (!row) return false;
  row.scrollIntoView?.({ block: "center" });
  if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");
  row.focus?.({ preventScroll: true });
  row.setAttribute("data-reveal", "");
  setTimeout(() => row.removeAttribute("data-reveal"), 2400);
  return true;
}
const tabLabel = (label, count) => count ? h(React.Fragment, null, label, h("span", { className: "ext-tabn" }, count)) : label;
function CommunityComponentPreparation({ working, busy, onPrepare, onLocal, onCancel, onBack }) {
  return h("div", { className: "ext-col", "data-runtime-step": working ? "preparing" : "ask" },
    h("div", { className: "ext-row" }, working ? h("span", { className: "ui-spinner", "aria-hidden": true }) : Icon("bolt", { size: 18 }), h("b", null, t("第一次使用，先准备运行组件"))),
    working ? h(React.Fragment, null, h("span", { className: "ws-meter ext-indet", role: "progressbar", "aria-label": t("正在核对并安装运行组件…"), "aria-busy": true }, h("b", null)), h("p", { className: "ext-cap", role: "status" }, t(working.cancelling ? "正在取消…" : "正在核对并安装运行组件…") + (working.bytes ? " · " + formatBytes(working.bytes) : "")), h("p", { className: "ext-cap" }, t("准备完成后自动继续；取消会停止本次准备。")),
      h("button", { type: "button", className: "ui-btn ghost", disabled: !!working.cancelling, onClick: onCancel }, t(working.cancelling ? "正在取消…" : "取消准备")),
      h("details", { className: "ext-tech" }, h("summary", null, t("技术详情")), h("code", null, ["Node " + working.nodeVersion, "DSH " + working.sourceCommit, working.sha256].filter((value) => value && !/undefined/.test(value)).join("\n"))))
      : h(React.Fragment, null, h("p", { className: "ext-cap" }, t("只需要这一次，以后的插件直接用。版本和校验值已锁定，准备好后自动继续安装。")), h("div", { className: "ws-row-btns" }, h("button", { type: "button", className: "ui-btn primary", disabled: busy, onClick: onPrepare }, t("准备运行组件…")), h("button", { type: "button", className: "ui-btn ghost", disabled: busy, onClick: onLocal }, t("从本地组件安装（高级）")), onBack && h("button", { type: "button", className: "ui-btn ghost", disabled: busy, onClick: onBack }, t("取消")))));
}
export function hostComponentIntent(value){return value?.kind==='host-component-required'&&value.component==='ffmpeg'?{tab:'installed',component:'ffmpeg'}:null;}
export function CommunityHostDependencies({plan,working,ffmpeg,dsh,onCancel,onNotice,onPrepare,onReturn,repair=false}={}){
 const components=plan?.hostComponents??(repair&&ffmpeg?.descriptor?[{id:'ffmpeg',label:'B站视频组件（FFmpeg）',version:ffmpeg.version,url:ffmpeg.descriptor.url,ready:ffmpeg.state==='ready'&&ffmpeg.verified===true,downloadBytes:ffmpeg.downloadBytes}]:[]),phases={waiting:'等待当前活动结束', 'preparing-dsh':'准备运行组件', 'preparing-ffmpeg':'准备视频组件', 'checking-plugin':'核对插件', 'installing-plugin':'安装插件'};
 const standalone=repair&&['preparing','cancelling'].includes(ffmpeg?.state),active=standalone||['preparing','handing-off','cancelling'].includes(working?.state),progress=standalone||working?.phase==='preparing-ffmpeg'?ffmpeg:dsh?.installation;
 return h('section',{className:'ws-card ext-card','data-host-components':true,'data-host-dependency-state':standalone?ffmpeg.state:working?.state??'plan','data-host-dependency-phase':standalone?'preparing-ffmpeg':working?.phase??'plan'},
  h('h3',{className:'ws-sec'},t('插件需要的宿主组件')),h('p',{className:'ext-cap'},t('确认安装后自动准备缺少的组件，再安装插件；不会登录、观看或调用模型。')),
  ...components.map(component=>{const current=component.id==='ffmpeg'?ffmpeg:dsh,currentReady=current?.state==='ready'&&(component.id!=='ffmpeg'||current.verified===true),ready=current?currentReady:component.ready,changed=component.ready&&current&&!currentReady;return h('div',{key:component.id,className:'ext-col','data-host-component':component.id,'data-component-ready':ready?'true':'false'},h('b',null,t(component.label)),h('span',null,component.version),h('span',null,changed?t('组件状态已变化，需要刷新计划并重新确认。'):ready?t(component.ready?'已核验，可复用，0 下载':'组件已准备完成'):t('需要下载')+' '+formatBytes(component.downloadBytes)),h('small',null,component.url),h('button',{type:'button',className:'ui-btn ghost sm',onClick:()=>onNotice?.(component.id)},t('来源与许可证')));}),
  active&&h('div',{role:'status','aria-live':'polite'},h('b',null,t(working?.state==='cancelling'||ffmpeg?.state==='cancelling'?'正在取消组件准备':standalone?'准备视频组件':phases[working?.phase]??'正在准备宿主组件')),Number.isFinite(progress?.receivedBytes)&&h('span',null,' '+formatBytes(progress.receivedBytes)+' / '+formatBytes(progress.totalBytes??0)),h('button',{type:'button',className:'ui-btn',onClick:onCancel},t('取消本次安装'))),
  working?.state==='failed'&&h('p',{role:'alert'},t(working.phase==='installing-plugin'?'插件任务已交给安装队列，请查看实际结果。':'组件准备未完成，插件尚未安装。')),
  repair&&h('div',{'data-bili-component-repair':true},ffmpeg?.state==='checking'&&h('p',{role:'status'},t('正在核验本地视频组件，尚未下载。')),h('p',null,t('视频组件缺失或损坏。准备完成后返回B站页面，由原按钮重新开始。')),h('button',{type:'button',className:'ui-btn',disabled:active||ffmpeg?.state==='checking',onClick:onPrepare},t('重新准备视频组件')),ffmpeg?.state==='ready'&&h('button',{type:'button',className:'ui-btn primary',onClick:onReturn},t('返回B站页面'))));
}
function CommunityCenter({ api = globalThis.window?.whale?.plugins, files = globalThis.window?.whale?.pluginFiles, workApi = globalThis.window?.whale?.work, onManage, onStatus, onPage, intent } = {}) {
  const [tab, setTab] = useState("community"), [state, setState] = useState(null), [listing, setListing] = useState({ items: [], total: 0, page: 1, pageSize: 24 }), [query, setQuery] = useState(""), [category, setCategory] = useState(""), [sort, setSort] = useState("recommended"), [favoritesOnly, setFavoritesOnly] = useState(false), [page, setPage] = useState(1), [revision, setRevision] = useState(0), [pending, setPending] = useState(0), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [detail, setDetail] = useState(null), [author, setAuthor] = useState(null), [plan, setPlan] = useState(null), [granted, setGranted] = useState([]), [updates, setUpdates] = useState(null), [checkedAt, setCheckedAt] = useState(null), [sourceId, setSourceId] = useState("official"), [catalogUrl, setCatalogUrl] = useState(""), [reviewUrl, setReviewUrl] = useState(""), [catalogDialog, setCatalogDialog] = useState(false), [reviewDraft, setReviewDraft] = useState(null), [reviewStatus, setReviewStatus] = useState(null);
  const [componentNeeded, setComponentNeeded] = useState(false), [componentWorking, setComponentWorking] = useState(null), [technicalError, setTechnicalError] = useState(null), [pendingAction, setPendingAction] = useState("");
  const [installFor, setInstallFor] = useState(null), [menuFor, setMenuFor] = useState(null), [cardMenu, setCardMenu] = useState(null), [filterMenu, setFilterMenu] = useState(false), [confirm, setConfirm] = useState(null), [loginRequest, setLoginRequest] = useState(null);
  const [workStatus, setWorkStatus] = useState(null), [accounts, setAccounts] = useState(null), [legacyInstalled, setLegacyInstalled] = useState([]), [engines, setEngines] = useState(null);
  const [offlinePreview, setOfflinePreview] = useState(null), [reviewCandidates, setReviewCandidates] = useState(null), [catalogLoading, setCatalogLoading] = useState(false);
  const mediaChecked=useRef(false),mounted = useRef(false), searchGeneration = useRef(0), detailGeneration = useRef(0), continuation = useRef(null);
  const say = (text, values) => setNotice(fill(t(text), values));
  const call = useCallback(async (request) => {
    if (!api) throw Error(t("扩展服务尚未就绪"));
    return pluginResult(await api.action(request));
  }, [api]);
  const refreshState = useCallback(async () => {
    const value = await call({ action: "community-status" });
    if (mounted.current) setState(value);
    return value;
  }, [call]);
  // "Open" goes to the plugin's page in the main window (approved design G); a version that cannot be shown
  // there yet, or a host without page navigation, keeps the plugin's own window.
  function openPage(record) {
    const target = embedTargetFor(record.packageName);
    if (target && onPage && embedCapable(target, record.exactVersion)) { onPage(EMBED_TARGETS[target].page); return; }
    void run(() => call({ action: "dsh-open-client", packageKey: record.packageKey }));
  }
  async function run(fn) {
    setPending((value) => value + 1);
    setPendingAction('正在处理插件请求…');
    setError("");
    setTechnicalError(null);
    try {
      const result = await fn();
      if (mounted.current) {
        await refreshState();
        setRevision((value) => value + 1);
      }
      return result;
    } catch (cause) {
      if (mounted.current) {
        if (["DSH_RUNTIME_NOT_READY", "DSH_RUNTIME_HASH_MISMATCH", "DSH_COMPONENT_REQUIRED"].includes(cause.code)) {
          continuation.current = fn;
          setComponentNeeded(true);
          setError(t("需要准备 DSH 运行组件，完成后将继续当前操作。"));
          setTechnicalError({ code: cause.code, message: pluginErrorText(cause) });
        } else if(cause.code?.startsWith('FFMPEG_COMPONENT_')||cause.code==='HOST_DEPENDENCY_BUSY'){
          setError(t(cause.code==='FFMPEG_COMPONENT_CANCELLED'?'已取消组件准备。':cause.code==='HOST_DEPENDENCY_BUSY'?'另一项组件准备正在进行，请等待或取消。':'视频组件尚未就绪，请在当前页面重新准备。'));setTechnicalError({code:cause.code,message:pluginErrorText(cause)});
        } else {
          setError(errorText(cause));
          if (cause.code) setTechnicalError({ code: cause.code, message: pluginErrorText(cause) });
        }
      }
    } finally {
      if (mounted.current) setPending((value) => Math.max(0, value - 1));
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refreshState().catch((cause) => mounted.current && setError(errorText(cause)));
    setCatalogLoading(true);
    void call({ action: "community-open" }).then((value) => {
      if (!mounted.current) return;
      if (value.snapshot) setState(value.snapshot);
      setRevision((value) => value + 1);
      if (value.results?.some((row) => row.error && row.error.code !== "COMMUNITY_SOURCE_UNAVAILABLE")) say("部分来源未部署或暂时无法读取，已保留验证缓存。");
    }, (cause) => { if (mounted.current) setError(errorText(cause)); }).finally(() => { if (mounted.current) setCatalogLoading(false); });
    const off = api?.onUpdate?.((value) => {
      if (mounted.current) {
        setState(value);
        setRevision((value2) => value2 + 1);
      }
    });
    return () => {
      mounted.current = false;
      searchGeneration.current++;
      detailGeneration.current++;
      off?.();
    };
  }, [api, refreshState]);
  useEffect(()=>{if(mediaChecked.current||!state?.mediaComponents?.ffmpeg||!state?.dsh?.installed?.some(record=>record.packageName==='@ai-buddy/bilibili-companion'))return;mediaChecked.current=true;void call({action:'bili-component-status'}).then(()=>refreshState(),cause=>{if(mounted.current)setTechnicalError({code:cause.code,message:pluginErrorText(cause)});});},[api,!!state?.mediaComponents?.ffmpeg,state?.dsh?.installed?.length]);
  useEffect(() => {
    setPage(1);
  }, [query, category, sort, favoritesOnly]);
  useEffect(() => {
    if (tab !== "community") return;
    const generation = ++searchGeneration.current;
    const timer = setTimeout(() => {
      void call({ action: "community-search", query, category, sort, favoritesOnly, page, pageSize: 24 }).then((value) => {
        if (mounted.current && generation === searchGeneration.current) setListing(value);
      }, (cause) => {
        if (mounted.current && generation === searchGeneration.current) setError(errorText(cause));
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [tab, query, category, sort, favoritesOnly, page, revision, call]);
  // B4: the installed list reads what each plugin is doing (work tasks, connected accounts) and the 1.9-era extensions.
  useEffect(() => {
    if (tab !== "installed" || !api) return;
    let live = true;
    void workApi?.status?.().then((value) => live && setWorkStatus(value), () => {});
    void call({ action: "social-accounts-list" }).then((value) => live && setAccounts(value?.accounts ?? null), () => {});
    void call({ action: "search", query: "", kind: "installed", page: 1, pageSize: 50 }).then((value) => live && setLegacyInstalled(Array.isArray(value?.items) ? value.items : []), () => {});
    return () => { live = false; };
  }, [tab, revision, api]);
  // The sidebar footer (A2) shows how many plugins are installed and whether updates were found.
  useEffect(() => {
    if (state) onStatus?.({ plugins: { installed: state.dsh?.installed?.length ?? 0, updates: updates == null ? null : updates.length } });
  }, [state, updates]);
  function sourceOf(id) {
    return state?.sources?.find((value) => value.sourceId === id);
  }
  function sourceName(id) {
    const name = sourceOf(id)?.name;
    return name ? t(name) : t("来源待确认");
  }
  // official: the official source, or a source whose key may use the reserved @ai-buddy/ names (validation runs)
  const officialSourceId = (id) => !!sourceOf(id)?.official || !!state?.community?.sources?.find((row) => row.sourceId === id)?.officialScope, officialWork = (work) => officialSourceId(work.sourceId);
  async function showDetails(work) {
    const generation = ++detailGeneration.current;
    setAuthor(null);
    setReviewStatus(null);
    const value = await call({ action: "community-details", ...refs(work) });
    if (generation === detailGeneration.current && mounted.current) {
      setReviewDraft([...(state?.community?.pendingReviews ?? [])].reverse().find((draft) => draft.key === value.work.key) ?? null);
      setDetail(value);
    }
  }
  async function showAuthor(work) {
    const value = await call({ action: "community-author", sourceId: work.sourceId, id: work.authorId });
    setAuthor({ ...value, sourceId: work.sourceId, works: value.works.map((item) => ({ ...item, officialSource: officialWork(item) })) });
  }
  async function follow(sourceKey, enabled) {
    await call({ action: "community-follow", key: sourceKey, enabled });
    setAuthor((value) => value && { ...value, followed: enabled });
    setDetail((value) => value && { ...value, followed: enabled });
  }
  async function prepare(work, version) {
    setPendingAction('正在检查插件安装计划…');
    const value = await call({ action: "dsh-plan", ...refs(work), version });
    setGranted((value.priorGrantedCapabilities ?? []).filter(capability => value.declaredCapabilities?.includes(capability)));
    setPlan(value);
  }
  // Each plugin has its own install page (B3); it opens first and the plan fills it in.
  function openInstall(work, version) {
    detailGeneration.current++;
    setDetail(null);
    setAuthor(null);
    setPlan(null);
    setGranted([]);
    setEngines(null);
    setInstallFor({ work, packageName: work.packageName, sourceId: work.sourceId, version, submitted: false });
    void run(() => prepare(work, version));
  }
  // A3: the catalog does not list the plugin yet (not online). The same page opens and offers the signed file instead of a dead end.
  function openUnavailable(packageName) {
    setPlan(null);
    setGranted([]);
    setInstallFor({ work: { packageName }, packageName, sourceId: null, submitted: false, unavailable: true });
  }
  async function detailsWork(sourceIdValue, id) {
    const value = await call({ action: "community-details", sourceId: sourceIdValue, id });
    return { ...value.work, authorName: value.author?.name ?? null, authorLogin: value.author?.githubLogin ?? null };
  }
  // B6: a signed plugin file chosen in the host's own dialog. The host verifies it; the normal install page follows.
  // B6 / review 中-1: the host checks the file and returns a preview; it is stored only after the confirmation dialog.
  async function importPackage() {
    if (!files?.choosePackage) throw Object.assign(Error(t("这个版本还不能从文件安装插件")), { code: "COMMUNITY_OFFLINE_UNAVAILABLE" });
    setPendingAction("正在核对插件包…");
    const value = pluginResult(await files.choosePackage());
    if (value && !value.cancelled) setOfflinePreview({ ...value, forPackage: installFor?.packageName ?? null, forSource: installFor?.sourceId ?? null });
  }
  async function confirmImport(preview) {
    setOfflinePreview(null);
    const value = await call({ action: "community-offline-confirm", importId: preview.importId });
    // Review 低-4: open a plugin only from the source the page was for (or, for an official plugin, the official source).
    const fits = (work) => work.packageName === preview.forPackage && (preview.forSource ? work.sourceId === preview.forSource : officialSourceId(work.sourceId));
    const pick = value.works?.find(fits) ?? (value.works?.length === 1 && !preview.forPackage ? value.works[0] : null);
    if (pick) { openInstall(await detailsWork(pick.sourceId, pick.id), pick.version); return; }
    setInstallFor(null);
    setTab("community");
    if (value.works?.length) say("已核对 {n} 个插件包，在「发现」里选一个安装。", { n: value.works.length });
    else say("签名目录已导入。");
  }
  async function enableRecord(record){
    const result=await call({action:'dsh-enable',packageKey:record.packageKey});
    if(result?.dependencyPlan){const value=result.dependencyPlan;setGranted(value.priorGrantedCapabilities);setPlan(value);setInstallFor({work:{packageName:record.packageName},packageName:record.packageName,sourceId:record.sourceId,submitted:false,enabling:true});return false;}return true;
  }
  async function cancelHostDependencies(){const hostActive=['preparing','handing-off','cancelling'].includes(state?.hostDependencies?.state),value=await call(hostActive?{action:'host-dependency-cancel',operationId:state?.hostDependencies?.operationId}:{action:'bili-component-cancel',operationId:state?.mediaComponents?.ffmpeg?.operationId});if(value.cancelling||value.cancelled)say('正在取消组件准备');await refreshState();}
  async function install() {
    if (!plan) return;
    setPendingAction('正在提交插件安装请求…');
    const request = plan.packageRef ? { action: "dsh-install", planId: plan.planId, grantedCapabilities: granted } : { action: "install", planId: plan.planId };
    const result = await call(request);
    if(plan.operation==='enable'){setPlan(null);setInstallFor(null);setTab('installed');say('启用请求已记录。');return;}
    const keeps = communityUpgradeKeepsEnabled(plan, granted);
    setPlan(null);
    setInstallFor((value) => value && { ...value, submitted: true, granted });
    say(keeps ? "升级请求已记录；兼容检查通过后将保留启用设置。" : result?.job?.state === "queued" ? "安装请求已记录；工作繁忙时会排队。安装后仍需明确启用。" : "安装请求已提交。");
  }
  // The host owns the pinned online descriptor; advanced local input uses its native file picker.
  // Only a completed component preparation resumes the interrupted action.
  async function prepareComponent(localArchive = false) {
    setPendingAction('正在准备运行组件…');
    const value = await call({ action: "dsh-component-plan", ...localArchive ? { localArchive: true } : {} });
    if (value.cancelled) return;
    setComponentWorking({ bytes: value.bytes, nodeVersion: value.nodeVersion, sourceCommit: value.sourceCommit, sha256: value.sha256 });
    try {
      const result = await call({ action: "dsh-component-install", planId: value.planId });
      if (result.state !== "ready") throw Error(t("运行组件尚未准备完成"));
    } catch (cause) {
      if (cause.code !== "ABORT_ERR") throw cause;
      if (mounted.current) { setComponentNeeded(true); say("已取消准备运行组件。"); }
      return;
    } finally { if (mounted.current) setComponentWorking(null); }
    setComponentNeeded(false);
    say("DSH 运行组件已准备完成。");
    const next = continuation.current;
    continuation.current = null;
    if (next) await next();
    else await call({ action: "dsh-probe" });
  }
  async function cancelComponent() {
    try { const value = await call({ action: "dsh-component-cancel" }); if (value.cancelled && mounted.current) setComponentWorking((current) => current && { ...current, cancelling: true }); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
  }
  async function checkUpdates() {
    const value = await call({ action: "community-check-updates" });
    setUpdates(value.updates);
    setCheckedAt(new Date());
  }
  async function updateAll() {
    const value = await call({ action: "community-update-all" });
    setUpdates(value.updates);
    setCheckedAt(new Date());
    const queued = value.updates.filter((row) => row.state === "queued").length, review = value.updates.filter((row) => row.state === "needs-user").length;
    say(review ? "已开始更新 {n} 个插件；{m} 个有新增权限，需要你逐个查看。" : "已开始更新 {n} 个插件。", { n: queued, m: review });
  }
  async function reviewUpdate(update) {
    openInstall(await detailsWork(update.sourceId, update.workId), update.to);
  }
  // Review 中-3: a maintenance record never re-queues itself. Install rows and rows whose source or plan changed open the plan
  // review for that version; uninstall and roll back use their confirmation; anything else shows the plugin's row (after a
  // fresh check when the last run was interrupted), where the normal switch and menu apply.
  async function openPlanFor(job, version) {
    const [, source, name] = job.packageKey.split(":"), found = await call({ action: "community-search", query: "", category: "", sort: "recommended", favoritesOnly: false, page: 1, pageSize: 50 }), work = found.items?.find((item) => item.packageName === name && item.sourceId === source);
    if (work) openInstall(work, version); else say("目录里没有找到这个插件的更新来源。");
  }
  const jobRecord = (job) => state?.dsh?.installed?.find((value) => value.packageKey === job.packageKey);
  function showRecord(job, probe = false) {
    void run(async () => { if (probe) await call({ action: "dsh-probe" }); setTab("installed"); setTimeout(() => revealInstalledRecord(job.packageKey.split(":").at(-1)), 50); });
  }
  function reviewJob(job) {
    const record = jobRecord(job);
    if (job.operation === "install") return void run(() => openPlanFor(job, job.version));
    if (/SOURCE_CHANGED|PLAN_CHANGED/.test(job.error?.code ?? "")) return void run(() => openPlanFor(job, record?.exactVersion));
    if (["uninstall", "rollback"].includes(job.operation) && record && job.state !== "interrupted-needs-user") return setConfirm({ kind: job.operation, record });
    showRecord(job, job.state === "interrupted-needs-user");
  }
  function retryJob(job) {
    const record = jobRecord(job);
    if (job.operation === "install") return void run(() => openPlanFor(job, job.version));
    if (["uninstall", "rollback"].includes(job.operation)) return record ? setConfirm({ kind: job.operation, record }) : showRecord(job);
    void run(() => call({ action: "dsh-" + job.operation, packageKey: job.packageKey }));
  }
  // Deep link from the work tasks page (A3): open this plugin's install page, from the catalog when it lists it.
  useEffect(() => {
    if (!intent) return;
    if (intent.tab) setTab(intent.tab);
    if(intent.component==='ffmpeg'){void call({action:'bili-component-status'}).then(()=>refreshState()).catch(cause=>setError(errorText(cause)));setTimeout(()=>document.querySelector('[data-bili-component-repair]')?.scrollIntoView?.({block:'center'}),100);}
    if (!intent.install) return;
    setTab("community");
    void run(async () => {
      const value = await call({ action: "community-search", query: "", category: "", sort: "recommended", favoritesOnly: false, page: 1, pageSize: 50 });
      const work = value.items?.find((item) => item.packageName === intent.install);
      if (!mounted.current) return;
      if (work) openInstall(work);
      else openUnavailable(intent.install);
    });
  }, [intent?.at]);
  const installedRecord = (packageName, source) => state?.dsh?.installed?.find((record) => record.packageName === packageName && (!source || record.sourceId === source));
  // G2 「在扩展中心查看」 entry point: intent {packageName} (optionally with tab) opens that plugin's own details sheet (B2)
  // when a verified catalog lists it; otherwise the Installed tab shows, with its row brought into view.
  async function openRecordDetails(packageName) {
    const record = installedRecord(packageName), value = await call({ action: "community-search", query: "", category: "", sort: "recommended", favoritesOnly: false, page: 1, pageSize: 50 });
    const work = value.items?.find((item) => item.packageName === packageName && (!record || item.sourceId === record.sourceId));
    if (work) { await showDetails(work); return true; }
    setTab("installed");
    return false;
  }
  const handledRecordIntent = useRef(null);
  useEffect(() => { if (!intent?.packageName || !state || handledRecordIntent.current === intent.at) return; handledRecordIntent.current = intent.at; void run(() => openRecordDetails(intent.packageName)); }, [intent?.at, !!state]);
  useEffect(() => { if (intent?.packageName && tab === "installed" && state) revealInstalledRecord(intent.packageName); }, [intent?.at, tab, !!state]);
  const jobFor = (packageName) => [...(state?.maintenance?.jobs ?? [])].reverse().find((job) => job.packageKey?.endsWith(":" + packageName));
  // The Work install page lists the engines this PC already has (丙7): host file checks plus the 1.9 Kimi extension state.
  const installRecord = installFor ? installedRecord(installFor.packageName, installFor.sourceId) : null;
  useEffect(() => {
    if (installFor?.packageName !== WORK || !installRecord || engines) return;
    let live = true;
    void (async () => {
      const found = (await files?.workEngines?.().catch(() => null))?.engines ?? [];
      const legacy = await call({ action: "search", query: "kimi", kind: "all", page: 1, pageSize: 50 }).catch(() => null), kimi = (legacy?.items ?? []).find((row) => row.manifest?.id === "ai-buddy.kimi-engine");
      const rows = [...found, ...kimi ? [{ engine: "kimi", version: kimi.manifest.version, state: kimi.compatible === false ? "incompatible" : kimi.installed ? "installed" : "available" }] : []];
      if (live && mounted.current) setEngines(rows);
    })();
    return () => { live = false; };
  }, [installFor?.packageName, !!installRecord]);
  const busy = pending > 0;
  function workCard(work) {
    const record = installedRecord(work.packageName, work.sourceId), version = latestVersion(work), official = officialWork(work), text = workText(work, { official });
    const installable = !(busy || work.status === "withdrawn" || !["function", "work-engine"].includes(work.category));
    return h(
      "article",
      { key: work.key, className: "ws-card ext-pcard", "data-community-work": work.id, "data-community-source": work.sourceId },
      h(PluginLogo, { packageName: work.packageName, size: 48 }),
      h("div", { className: "ext-pc-main" },
        h("div", { className: "ext-row" }, h("button", { type: "button", className: "ext-pc-n", onClick: () => void run(() => showDetails(work)) }, text.name), official && h("span", { className: "ws-tag" }, t("官方")), work.backend !== "dsh" && h("span", { className: "ws-tag" }, t("Buddy 扩展"))),
        h("small", { className: "ext-cap" }, [work.authorName ?? work.authorLogin ?? work.authorId, version].filter(Boolean).join(" · ") + (work.stale ? " · " + t("离线缓存，统计可能过期") : "")),
        h("p", { className: "ext-pc-d" }, text.description),
        h("div", { className: "ext-pc-stats" }, work.rating?.mean == null ? h("span", null, t("暂无评价")) : h(React.Fragment, null, h(Stars, { value: work.rating.mean }), h("span", null, tn("{n} 人评价",work.rating.count) + (work.rating.insufficientSample ? " · " + t("样本较少") : ""))), work.statistics?.downloadCount90d != null && h("span", null, "· " + t("近 90 天下载 {n}").replace("{n}", work.statistics.downloadCount90d)), work.backend === "dsh" && h("span", null, "· " + tn("{n} 项权限",currentCapabilities(work).length))),
        work.statusReason && h("p", { role: "status", className: "ext-cap" }, work.statusReason)
      ),
      h("div", { className: "ext-pc-act" },
        record ? h("button", { type: "button", className: "ui-btn", disabled: busy || !record.enabled, onClick: () => openPage(record) }, Icon("external", { size: 16 }), t("打开")) : h("button", { type: "button", className: "ui-btn primary", disabled: !installable, onClick: () => openInstall(work) }, Icon("download", { size: 16 }), t("安装…")),
        h("button", { type: "button", className: "ui-icon-btn" + (work.favorite ? " ext-fav-on" : ""), "aria-pressed": !!work.favorite, "aria-label": t(work.favorite ? "取消收藏" : "收藏作品"), title: t(work.favorite ? "取消收藏" : "收藏作品"), onClick: () => void run(() => call({ action: "community-favorite", key: work.key, enabled: !work.favorite })) }, Icon("star", { size: 16 })),
        h("div", { className: "ext-menuwrap" }, h("button", { type: "button", className: "ui-icon-btn", "aria-haspopup": "menu", "aria-expanded": cardMenu === work.key, "aria-label": t("更多"), title: t("更多"), onClick: () => setCardMenu(cardMenu === work.key ? null : work.key) }, Icon("more", { size: 16 })),
          cardMenu === work.key && h(Menu, { label: t("更多"), onClose: () => setCardMenu(null), items: [{ label: t("查看详情"), icon: "info", onSelect: () => void run(() => showDetails(work)) }, { label: t("作者作品页"), icon: "users", onSelect: () => void run(() => showAuthor(work)) }] }))
      )
    );
  }
  const currentCapabilities = (work) => [...(work.releases ?? [])].sort((a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0))[0]?.package?.capabilities ?? [];
  function installedRow(record) {
    const label = runtimeLabel(record), open = menuFor === record.packageKey, policy = state?.community?.updatePolicies?.[record.packageKey] ?? "manual", update = updates?.find((value) => value.packageKey === record.packageKey), job = jobFor(record.packageName), working = job && ["queued", "running"].includes(job.state);
    const items = [
      { label: t("更新方式：手动更新"), icon: "sliders", checked: policy === "manual", onSelect: () => void run(() => call({ action: "community-set-update-policy", packageKey: record.packageKey, policy: "manual" })) },
      { label: t("更新方式：自动更新，新增能力仍需确认"), icon: "sliders", checked: policy === "auto", onSelect: () => void run(() => call({ action: "community-set-update-policy", packageKey: record.packageKey, policy: "auto" })) },
      { label: t("在浏览器打开"), icon: "external", disabled: !record.enabled, onSelect: () => void run(() => call({ action: "dsh-open-client", packageKey: record.packageKey, external: true })) },
      "separator",
      record.previous && { label: t("回退到上一个版本…"), icon: "retry", onSelect: () => setConfirm({ kind: "rollback", record }) },
      { label: t("卸载（保留数据）…"), icon: "close", danger: true, onSelect: () => setConfirm({ kind: "uninstall", record }) }
    ].filter(Boolean);
    return h("article", { className: "ws-card ext-irow", key: record.packageKey, "data-dsh-record": record.packageKey },
      h(PluginLogo, { packageName: record.packageName, size: 44 }),
      h("div", { className: "ext-ir-main" },
        h("div", { className: "ext-row" }, h("b", null, pluginName(record.packageName)), h("span", { className: "ext-cap" }, record.exactVersion), record.localBundled && h("span", { className: "ext-cap" }, L("本地随附", "Bundled locally")), working ? h(StatusPill, { tone: "busy" }, t(job.operation === "install" ? "正在安装" : "正在维护")) : h(CommunityInstallationStatus, { record, compact: true }), update && h("button", { type: "button", className: "ws-tag ext-tagbtn", onClick: () => setTab("updates") }, t("有更新 {v}").replace("{v}", update.to))),
        h("small", { className: "ext-cap", "data-installed-situation": true }, installedSituation(record, { jobs: workStatus ? (workStatus.jobs ?? []).length : null, accounts })),
        label === "加载失败" && record.runtimeFailure && h("details", { className: "ext-tech" }, h("summary", null, t("技术详情")), h("code", null, record.runtimeFailure.code + "\n" + record.runtimeFailure.message))),
      h("div", { className: "ext-row" },
        h("span", { className: "ext-cap" }, L("启用", "Enabled")), h(Switch, { checked: !!record.enabled, disabled: busy, label: t(record.enabled ? "停用" : "启用") + " · " + pluginName(record.packageName), onChange: () => void run(() => record.enabled ? call({action:"dsh-disable",packageKey:record.packageKey}) : enableRecord(record)) }),
        h("button", { type: "button", className: "ui-btn", disabled: !record.enabled || busy, onClick: () => openPage(record) }, Icon("external", { size: 16 }), t("打开")),
        !record.localBundled && h("div", { className: "ext-menuwrap" }, h("button", { type: "button", className: "ui-icon-btn", "aria-haspopup": "menu", "aria-expanded": open, "aria-label": t("更多") + " · " + pluginName(record.packageName), title: t("更多"), onClick: () => setMenuFor(open ? null : record.packageKey) }, Icon("more", { size: 16 })),
          open && h(Menu, { label: t("更多"), className: "ext-menu-r", onClose: () => setMenuFor(null), items }))));
  }
  // B4 keep: an installed 1.9-era extension is listed as it is (Kimi 1.0.0 stays 「不兼容」 and is managed under Sources).
  function legacyRow(row) {
    const m = row.manifest, text = legacyText(m, { official: ["official", "legacy"].includes(row.sourceId ?? "legacy") }), incompatible = row.compatible === false;
    return h("article", { className: "ws-card ext-irow", key: "legacy:" + m.id, "data-legacy-installed": m.id },
      h("span", { className: "ext-logo", style: { "--pl": "44px" }, "aria-hidden": true }, Icon(m.kind === "runtime" ? "terminal" : "bolt", { size: 22 })),
      h("div", { className: "ext-ir-main" }, h("div", { className: "ext-row" }, h("b", null, text.name), h("span", { className: "ext-cap" }, m.version), incompatible ? h(StatusPill, { tone: "warn" }, t("不兼容")) : h(StatusPill, { tone: row.enabled ? "ok" : "idle" }, t(row.enabled ? "已启用" : "已安装")), h("span", { className: "ws-tag" }, t("旧扩展"))),
        h("small", { className: "ext-cap" }, incompatible ? t("暂不兼容当前版本的 AI 酱，数据和启用意图都保留着。") : t("1.9 时代的扩展，在「来源与旧扩展」里管理。"))),
      h("button", { type: "button", className: "ui-btn ghost sm", onClick: () => setTab("sources") }, t("在来源里管理")));
  }
  if (!api) return h("div", { className: "ws-page" }, h("div", { className: "ws-page-head" }, h("div", null, h("h2", { className: "ws-ptitle" }, t("扩展中心")))), h("div", { className: "ui-alert warn", role: "status" }, Icon("alert", { size: 16 }), h("div", null, t("扩展服务尚未就绪"))));
  const installed = state?.dsh?.installed ?? [], jobs = state?.maintenance?.jobs ?? [];
  const tabs = [["community", t("发现"), "search"], ["installed", tabLabel(t("已安装"), installed.length + legacyInstalled.length), "check"], ["updates", tabLabel(t("更新与维护"), updates?.length ?? 0), "refresh"], ["accounts", t("账号连接"), "link"], ["sources", t("来源与旧扩展"), "archive"]];
  const hostDependencyCard=h(CommunityHostDependencies,{plan,working:state?.hostDependencies,ffmpeg:state?.mediaComponents?.ffmpeg,dsh:state?.dshComponent,onCancel:()=>void cancelHostDependencies(),onNotice:component=>void call({action:'host-dependency-open-link',component,kind:'notice'}),onReturn:()=>onPage?.(EMBED_TARGETS.bilibili.page),repair:!plan&&installed.some(record=>record.packageName==='@ai-buddy/bilibili-companion')&&!!state?.mediaComponents?.ffmpeg&&state.mediaComponents.ffmpeg.state!=='ready',onPrepare:()=>void run(async()=>{await call({action:'bili-component-prepare',repair:true});say('视频组件已准备完成，请返回B站页面重新开始。');onPage?.(EMBED_TARGETS.bilibili.page);})});
  const runtimeCard = h(CommunityComponentPreparation, { working: componentWorking, busy, onPrepare: () => void run(prepareComponent), onLocal: () => void run(() => prepareComponent(true)), onCancel: () => void cancelComponent(), onBack: installFor ? () => { continuation.current = null; setComponentNeeded(false); setInstallFor(null); } : null });
  const catalogForm = catalogDialog && h(Dialog, { title: t("接入已签名的社区目录"), onClose: () => setCatalogDialog(false), busy, "data-catalog-dialog": true, footer: h(React.Fragment, null, h("span", { className: "spacer" }), h("button", { type: "button", className: "ui-btn ghost", disabled: busy, onClick: () => setCatalogDialog(false) }, t("取消")), h("button", { type: "button", className: "ui-btn primary", disabled: busy || !catalogUrl.trim(), onClick: () => void run(async () => { await call({ action: "community-load-catalog", sourceId, url: catalogUrl, ...reviewUrl ? { reviewUrl } : {} }); setCatalogDialog(false); say("社区目录已接入。"); }) }, t("验证并读取社区目录"))) },
    h("p", { className: "ext-cap" }, t("社区目录复用已信任来源的公钥，不会信任目录正文提供的新公钥。")),
    h("div", { className: "ext-form" }, h("label", { className: "ws-fld" }, h("span", null, t("已信任来源")), h("select", { value: sourceId, onChange: (event) => setSourceId(event.target.value) }, ...(state?.sources ?? []).filter((source) => source.sourceId !== "legacy" && !source.removed).map((source) => h("option", { key: source.sourceId, value: source.sourceId }, t(source.name))))), h("label", { className: "ws-fld" }, h("span", null, t("社区目录地址")), h("input", { type: "url", value: catalogUrl, onChange: (event) => setCatalogUrl(event.target.value) })), h("label", { className: "ws-fld" }, h("span", null, t("评价索引地址（可选）")), h("input", { type: "url", value: reviewUrl, onChange: (event) => setReviewUrl(event.target.value) }))));
  const offlineDialog = offlinePreview && h(OfflineImportDialog, { preview: offlinePreview, sourceName: offlinePreview.sourceId ? sourceName(offlinePreview.sourceId) : null, busy, onConfirm: () => void run(() => confirmImport(offlinePreview)), onCancel: () => { void call({ action: "community-offline-cancel", importId: offlinePreview.importId }).catch(() => {}); setOfflinePreview(null); } });
  // B3: the plugin's own install page replaces the tab content while it is open.
  if(installFor&&plan?.operation==='enable')return h('div',{className:'ws-page ext-page','data-enable-dependency-plan':true},error&&h('p',{role:'alert'},error),hostDependencyCard,h('button',{type:'button',className:'ui-btn primary',disabled:busy,onClick:()=>void run(install)},t('准备组件并启用')),h('button',{type:'button',className:'ui-btn',disabled:busy,onClick:()=>{setPlan(null);setInstallFor(null);}},t('取消')));
  if (installFor) {
    const record = installRecord, job = installFor.submitted ? jobFor(installFor.packageName) : null, failedJob = job?.error ? { ...job, error: { ...job.error, text: communityErrorText(job.error.code) ?? job.error.message } } : job;
    const stage = record && installFor.submitted ? "installed" : installFor.submitted ? "installing" : installStage({ plan, runtimeNeeded: componentNeeded || !!componentWorking, job: null, record: null, unavailable: installFor.unavailable });
    const loginNext = (packageName) => { setInstallFor(null); setTab("accounts"); if (SOCIAL_LOGIN[packageName] && officialSourceId(installFor.sourceId)) setLoginRequest({ platform: SOCIAL_LOGIN[packageName], at: Date.now() }); };
    return h("div", { className: "ws-page ext-page community-center", "data-community-center": true },
      error && stage !== "runtime" && h("div", { role: "alert", className: "ui-alert warn" }, Icon("alert", { size: 16 }), h("div", null, error)),
      notice && h("div", { role: "status", className: "ui-note" }, Icon("info", { size: 16 }), h("div", null, notice)),
      plan?.hostComponents&&hostDependencyCard,
      h(InstallPage, { work: installFor.work, source: installFor.sourceId ? sourceOf(installFor.sourceId) : null, official: installFor.sourceId ? officialSourceId(installFor.sourceId) : false, plan, granted: installFor.submitted ? installFor.granted ?? granted : granted, onGrant: setGranted, keepsEnabled: communityUpgradeKeepsEnabled(plan, granted), stage, runtime: runtimeCard, job: failedJob, record, busy, engines, catalogOnline: !!state?.community?.configured,
        onBack: () => { setInstallFor(null); setPlan(null); setNotice(""); },
        onInstall: () => void run(install),
        onCancelPlan: () => { setPlan(null); setInstallFor(null); },
        onEnable: () => void run(async () => { if(!await enableRecord(record))return; if (installFor.packageName === WORK) { if (onPage) onPage("agent-tasks"); else await workApi?.open?.(); } else if (SOCIAL_LOGIN[installFor.packageName] && officialSourceId(installFor.sourceId)) loginNext(installFor.packageName); }),
        onOpen: () => openPage(record),
        onNext: () => loginNext(installFor.packageName),
        onRetry: () => { setInstallFor((value) => ({ ...value, submitted: false })); void run(() => prepare(installFor.work, installFor.version)); },
        onImport: () => void run(importPackage),
        onAddCatalog: () => { setInstallFor(null); setTab("sources"); setCatalogDialog(true); } }),
      catalogForm, offlineDialog);
  }
  const sourcesExtras = { catalog: { configured: !!state?.community?.configured, works: state?.community?.works ?? 0, rows: state?.community?.sources ?? [] }, busy, onSetCatalog: () => setCatalogDialog(true), onRefreshCatalog: () => void run(async () => { const result = await call({ action: "community-refresh" }); const failures = result.results?.filter((value) => value.error); say(failures?.length ? "部分来源未部署或暂时无法读取，已保留验证缓存。" : "社区索引已刷新。"); }), onImport: () => void run(importPackage), onExport: () => void run(exportPreferences), onImportPreferences: () => void run(importPreferences) };
  async function exportPreferences() { if (!files?.preferences) throw Error(t("扩展服务尚未就绪")); const value = pluginResult(await files.preferences("export")); if (value?.saved) say("收藏与关注已导出到文件。"); }
  async function importPreferences() { if (!files?.preferences) throw Error(t("扩展服务尚未就绪")); const value = pluginResult(await files.preferences("import")); if (value && !value.cancelled) say("已合并导入收藏与关注。"); }
  const runningJob = jobs.find((job) => job.state === "running"), eligible = (updates ?? []).filter((row) => row.state === "available").length;
  return h(
    "div",
    { className: "ws-page ext-page community-center", "data-community-center": true },
    h("div", { className: "ws-page-head" }, h("div", null, h("h2", { className: "ws-ptitle" }, t("扩展中心")), h("p", { className: "ws-meta" }, t("安装、更新和管理插件。插件装好后不会自动启用。"))),
      h("div", { className: "ws-row-btns" }, h("button", { type: "button", className: "ui-btn", disabled: busy, onClick: () => { setTab("updates"); void run(checkUpdates); } }, Icon("refresh", { size: 16 }), t("检查更新")), h("button", { type: "button", className: "ui-btn ghost", disabled: busy, onClick: () => void run(() => call({ action: "dsh-probe" })) }, Icon("bolt", { size: 16 }), t("运行组件")))),
    h(Tabs, { tabs, active: tab, onSelect: setTab, label: t("插件社区导航"), idPrefix: "ext-tab" }),
    error && h("div", { role: "alert", className: "ui-alert warn" }, Icon("alert", { size: 16 }), h("div", null, error)),
    notice && h("div", { role: "status", className: "ui-note" }, Icon("info", { size: 16 }), h("div", null, notice)),
    // B1: a running maintenance job is announced on 「更新与维护」 (and on its plugin's row), not over every tab.
    h(CommunityBusyNotice, { pending: busy && !componentWorking, action: pendingAction, phase: state?.dsh?.state?.phase, maintenance: tab === "updates" ? state?.maintenance : null }),
    h(CommunityRuntimeNotice, { state: state?.dsh?.state, needed: componentNeeded, technicalError, onPrepare: () => void run(prepareComponent), onLocal: () => void run(() => prepareComponent(true)), busy }),
    installed.some(record=>record.packageName==="@ai-buddy/bilibili-companion")&&!!state?.mediaComponents?.ffmpeg&&state.mediaComponents.ffmpeg.state!=="ready"&&hostDependencyCard,
    componentWorking && h("section", { className: "ws-card ext-card" }, runtimeCard),
    tab === "community" && h(
      "section",
      { className: "ext-col", id: "ext-tab-community", role: "tabpanel" },
      h("div", { className: "ext-filters" }, h("label", { className: "ws-inp ext-search" }, Icon("search", { size: 16 }), h("input", { type: "search", placeholder: t("搜索插件"), "aria-label": t("搜索社区作品"), value: query, onChange: (event) => setQuery(event.target.value) })), h("select", { className: "ext-select", value: category, "aria-label": t("社区分类"), onChange: (event) => setCategory(event.target.value) }, h(CommunityCategoryOptions, { capabilities: state?.community?.categoryCapabilities })), h("select", { className: "ext-select", value: sort, "aria-label": t("社区排序"), onChange: (event) => setSort(event.target.value) }, h("option", { value: "recommended" }, t("按真实数据推荐")), h("option", { value: "new" }, t("最新作品")), h("option", { value: "stars" }, t("五星评价"))), h("button", { type: "button", className: "ws-chip", "aria-pressed": favoritesOnly, onClick: () => setFavoritesOnly((value) => !value) }, Icon("star", { size: 14 }), t("只看收藏")),
        h("div", { className: "ext-menuwrap" }, h("button", { type: "button", className: "ui-icon-btn", "aria-haspopup": "menu", "aria-expanded": filterMenu, "aria-label": t("更多"), title: t("更多"), onClick: () => setFilterMenu(!filterMenu) }, Icon("more", { size: 16 })),
          filterMenu && h(Menu, { label: t("更多"), className: "ext-menu-r", onClose: () => setFilterMenu(false), items: [{ label: t("刷新目录与评价"), icon: "refresh", disabled: busy, onSelect: sourcesExtras.onRefreshCatalog }, "separator", { label: t("导出收藏与关注…"), icon: "download", disabled: busy, onSelect: sourcesExtras.onExport }, { label: t("导入收藏与关注…"), icon: "upload", disabled: busy, onSelect: sourcesExtras.onImportPreferences }] }))),
      !listing.total && !state?.community?.configured ? h("div", { className: "ws-card" }, h(EmptyState, { icon: "archive", title: t(catalogLoading ? "正在读取社区目录…" : "社区目录暂时无法读取"), action: h("div", { className: "ws-row-btns" }, h("button", { type: "button", className: "ui-btn primary", disabled: busy || catalogLoading, onClick: sourcesExtras.onRefreshCatalog }, Icon("refresh", { size: 16 }), t("刷新目录与评价")), h("button", { type: "button", className: "ui-btn ghost", onClick: () => { setTab("sources"); setCatalogDialog(true); } }, t("添加社区目录地址"))) }, t("请检查网络后刷新目录。已验证的缓存和本地安装的插件会继续保留。")))
        : !listing.total ? h("div", { className: "ws-card" }, h(EmptyState, { icon: "search", title: t("暂无符合条件的作品。") }))
        : h("div", { className: "ext-pgrid" }, ...listing.items.map(workCard)),
      listing.total > listing.pageSize && h("div", { className: "ext-pager" }, button("上一页", () => setPage((value) => Math.max(1, value - 1)), { disabled: page <= 1 }), h("span", { className: "ext-cap" }, page + " / " + Math.ceil(listing.total / listing.pageSize)), button("下一页", () => setPage((value) => value + 1), { disabled: page * listing.pageSize >= listing.total }))
    ),
    tab === "installed" && h("section", { className: "ext-col", "data-dsh-installed": true, id: "ext-tab-installed", role: "tabpanel" }, installed.length || legacyInstalled.length ? [...installed.map(installedRow), ...legacyInstalled.map(legacyRow)] : h("div", { className: "ws-card" }, h(EmptyState, { icon: "nav-plugins", title: t("还没有安装插件"), action: h("button", { type: "button", className: "ui-btn primary", onClick: () => setTab("community") }, t("去发现插件")) }, t("装好的插件会出现在这里，启用、打开和卸载都在这一页。")))),
    tab === "updates" && h("section", { className: "ext-col", id: "ext-tab-updates", role: "tabpanel" },
      h("div", { className: "ws-card ext-card ext-between" }, h("div", null, h("b", null, updates == null ? t("还没检查更新") : updates.length ? tn("有 {n} 个更新",updates.length) : t("全部是最新的")), checkedAt && h("small", { className: "ext-cap", style: { display: "block" } }, t("上次检查：{time}").replace("{time}", checkedLabel(checkedAt)))),
        h("div", { className: "ws-row-btns" }, h("button", { type: "button", className: "ui-btn ghost", disabled: busy, onClick: () => void run(checkUpdates) }, Icon("refresh", { size: 16 }), t("检查更新")), updates?.length > 0 && h("button", { type: "button", className: "ui-btn primary", disabled: busy || !eligible, title: eligible ? undefined : t("每个更新都要你先查看"), onClick: () => void run(updateAll) }, t("全部更新")))),
      ...(updates ?? []).map((update) => h(UpdateCard, { key: update.packageKey, update, record: installed.find((value) => value.packageKey === update.packageKey), busy, onReview: (value) => void run(() => reviewUpdate(value)) })),
      h("h3", { className: "ws-sec" }, t("维护记录")),
      jobs.length ? h("div", { className: "ws-card ext-qlist" }, ...jobs.slice().reverse().map((job) => { const before = jobs.filter((value) => value.state === "queued" && Date.parse(value.createdAt) < Date.parse(job.createdAt)).at(-1) ?? (job.state === "queued" && runningJob) ?? null; return h(MaintenanceRow, { key: job.id, job, installed, ahead: before ? nameOf(before.packageKey, installed) : null, busy,
        onCancel: (value) => void run(() => call({ action: "community-cancel-maintenance", id: value.id })),
        onRetry: retryJob,
        onReview: reviewJob }); }))
        : h("p", { className: "ext-cap" }, t("还没有维护记录。"))),
    tab === "accounts" && h("section", { className: "ext-col", id: "ext-tab-accounts", role: "tabpanel" }, h(SocialAccounts, { api, openLogin: loginRequest, onOpenPlugin: (packageName) => { const record = installedRecord(packageName); if (record?.enabled) openPage(record); else setTab("installed"); } })),
    tab === "sources" && h("section", { className: "ext-col", id: "ext-tab-sources", role: "tabpanel" }, h(PluginCenter, { api, onManage, embedded: true, extras: sourcesExtras })),
    catalogForm, offlineDialog,
    detail && h(WorkDetail, { key: detail.work.key, detail, source: sourceOf(detail.work.sourceId), official: officialSourceId(detail.work.sourceId), busy, candidates: reviewCandidates, installed: installedRecord(detail.work.packageName, detail.work.sourceId), draft: reviewDraft, reviewStatus,
      onClose: () => { detailGeneration.current++; setDetail(null); },
      onInstall: (work, version) => openInstall({ ...work, authorName: detail.author?.name ?? null, authorLogin: detail.author?.githubLogin ?? null }, version),
      onOpen: () => openPage(installedRecord(detail.work.packageName, detail.work.sourceId)),
      onAuthor: (work) => void run(() => showAuthor(work)),
      onFollow: (enabled) => void run(() => follow(detail.work.sourceId + ":" + detail.work.authorId, enabled)),
      onLink: (kind) => void run(() => call({ action: "community-open-link", ...refs(detail.work), kind })),
      onReadmeLink: (url) => void run(() => call({ action: "community-open-readme-link", ...refs(detail.work), url })),
      onReview: ({ stars, text }) => void run(async () => { const value = await call({ action: "community-review-draft", ...refs(detail.work), stars, text }); setReviewDraft(value.draft); setReviewStatus(null); await call({ action: "community-open-review", draftId: value.draft.id }); }),
      onCheck: () => void run(async () => { const value = await call({ action: "community-find-review", draftId: reviewDraft.id }); setReviewStatus(value.status); setReviewCandidates(value.candidates ?? null); }),
      onCheckLink: (url) => void run(async () => { const value = await call({ action: "community-check-review", ...refs(detail.work), url }); setReviewStatus(value.status === "indexed" ? "indexed" : "submitted-pending-sync"); }) }),
    author && h(AuthorDialog, { author: author.author, followed: author.followed, works: author.works, busy, onClose: () => setAuthor(null), onFollow: (enabled) => void run(() => follow(author.sourceId + ":" + author.author.id, enabled)), onOpen: (work) => { setAuthor(null); void run(() => showDetails(work)); } }),
    confirm && h(Dialog, { title: confirm.kind === "uninstall" ? t("卸载 {name}？").replace("{name}", pluginName(confirm.record.packageName)) : t("回退 {name}？").replace("{name}", pluginName(confirm.record.packageName)), onClose: () => setConfirm(null), busy,
      footer: h(React.Fragment, null, h("span", { className: "spacer" }), h("button", { type: "button", className: "ui-btn ghost", disabled: busy, onClick: () => setConfirm(null) }, t("取消")), h("button", { type: "button", className: "ui-btn " + (confirm.kind === "uninstall" ? "danger" : "primary"), disabled: busy, onClick: () => void run(async () => { await call({ action: confirm.kind === "uninstall" ? "dsh-uninstall" : "dsh-rollback", packageKey: confirm.record.packageKey }); setConfirm(null); }) }, confirm.kind === "uninstall" ? t("卸载，保留数据") : t("回退代码"))) },
      h("p", null, confirm.kind === "uninstall" ? t("插件会停用并删除，个人数据、聊天记录和账号连接都保留，以后重新安装可以接着用。") : t("回到上一个版本的代码，个人数据不变。")))
  );
}
export {
  CommunityCategoryOptions,
  CommunityComponentPreparation,
  CommunityCenter,
  CommunityRuntimeNotice,
  revealInstalledRecord
};
export const communityUpgradeKeepsEnabled=(plan,granted)=>plan?.priorEnabled===true&&plan.priorDataSchemaVersion===plan.packageRef?.dataSchemaVersion&&Array.isArray(granted)&&granted.every(capability=>plan.priorGrantedCapabilities?.includes(capability));
