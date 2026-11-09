import {locale,t} from './i18n.mjs';
import {networkErrorMessage} from './network-errors.mjs';
import {isVoiceEnginePackage,VOICE_SHARED_PACKAGE} from './voice/package-contract.mjs';
const errorMessages = {
  COMMUNITY_QUEUE_CAPACITY: ['维护记录已达到容量上限，暂不能新增任务；现有记录会保留。', 'The maintenance history is full. New tasks cannot be added; existing records are retained.'],
  COMMUNITY_SOURCE_UNAVAILABLE: ['此来源已停用、移除或暂不可用，请检查来源设置。', 'This source is disabled, removed or unavailable. Check the source settings.'],
  COMMUNITY_SOURCE_CHANGED: ['来源在读取期间发生变化，请重新检查来源后重试。', 'The source changed while loading. Check the source and try again.'],
};
export function pluginResult(value) {
  if (!value?.error) return value;
  const error = value.error;
  throw Object.assign(Error(typeof error === 'string' ? error : error.message ?? error.code ?? 'Extension request failed'), typeof error === 'object' ? {code: error.code, details: error.details,host:error.host??error.details?.host,retryOfficial:error.retryOfficial??error.details?.retryOfficial} : {});
}
export function pluginErrorText(error, language = locale()) { const code=error?.code??error?.error?.code;if(code?.startsWith('NETWORK_')||/^(PLUGIN_SOURCE_FETCH_FAILED|PLUGIN_DOWNLOAD_FAILED|DSH_COMPONENT_DOWNLOAD_|FFMPEG_COMPONENT_DOWNLOAD)/.test(code??''))return networkErrorMessage(code?.includes('TIMEOUT')?'NETWORK_TIMEOUT':code,{host:error?.host??error?.details?.host??error?.error?.host??error?.error?.details?.host??'',language,offline:true});const messages = errorMessages[code]; return messages ? messages[language === 'en' ? 1 : 0] : typeof error === 'string' ? error : error?.message ?? error?.error?.message ?? error?.code ?? 'Extension request failed'; }
// Catalog checks are metadata-only; never prepare components on page entry.
export function pluginSourcesNeedRefresh(state, now = Date.now()) {
  if (!Array.isArray(state?.sources)) return !state?.catalogAvailable;
  return state.sources.some(source => {
    if (source.sourceId === 'legacy' || source.enabled === false || source.removed) return false;
    const cached = Date.parse(source.cachedAt);
    return !Number.isFinite(cached) || cached > now + 60000 || now - cached >= 30 * 60 * 1000;
  });
}
export function pluginSourceId(row) { return row?.sourceId ?? row?.source?.sourceId ?? 'legacy'; }
export function pluginRowKey(row) { return [pluginSourceId(row), row.manifest.id, row.manifest.version].join(':'); }
export function pluginSearchText(row) { const m = row.manifest ?? {}; return [m.name, m.id, m.description, m.author, ...(m.tags ?? [])].filter(Boolean).join(' ').toLowerCase(); }
export function filterLegacyPlugins(rows, {query = '', sourceId = '', kind = 'all', page = 1, pageSize = 50, legacyOnly = false} = {}) {
  const needle = query.trim().toLowerCase(), matched = rows.filter(row => (!legacyOnly || !isVoiceEnginePackage(row.manifest.id) && row.manifest.id !== VOICE_SHARED_PACKAGE) && (!sourceId || pluginSourceId(row) === sourceId) && (kind === 'installed' ? row.installed : row.source?.enabled !== false && !row.source?.removed) && (kind === 'all' || kind === 'installed' || row.manifest.kind === kind) && (!needle || pluginSearchText(row).includes(needle)));
  pageSize = Math.min(50, Math.max(1, pageSize)); return {items: matched.slice((page - 1) * pageSize, page * pageSize), total: matched.length, page, pageSize};
}
export function pluginActivation(row, components) {
  const value=row.activation??{supported:false,usable:false,state:row.manifest?.kind==='runtime'?'dependency':'unverified'};
  if(pluginIsIncompatible(row))return {...value,...row.compatibility,usable:false,state:'incompatible'};
  if(value.state==='ready'&&(!value.usable||!row.installed||!row.current||!row.enabled))return {...value,usable:false,state:'unverified'};
  if (isVoiceEnginePackage(row.manifest?.id) && components !== undefined && value.state === 'ready' && components.ready !== true) return {...value,usable:false,state:components.state === 'verification-needed' ? 'verification-needed' : 'components-needed'};
  return value;
}
export function pluginIsIncompatible(row){return row?.compatible===false||row?.compatibility?.compatible===false||row?.activation?.state==='incompatible';}
export function pluginCompatibilityText(row){const value=row?.compatibility??row?.activation??row??{};return t('这个版本需要 AI 酱 {range}，现在是 {version}。').replace('{range}',value.requiredAppRange??row?.manifest?.appRange??'?').replace('{version}',value.currentAppVersion??row?.currentAppVersion??'?');}
export function pluginUpdateAvailable(update){return !!update?.to&&!update.incompatibleData&&!['queued','running','unavailable','interrupted-needs-user','incompatible'].includes(update.state);}
export function installedPluginRows(state) { return Object.entries(state?.installed ?? {}).flatMap(([id, installed]) => {const saved = installed.versions?.[installed.current]; if (!saved?.manifest) return [];return [{sourceId: installed.sourceId ?? saved.sourceId ?? 'legacy', source: installed.source ?? saved.source, manifest: saved.manifest, archive: saved.archive, current: true, installed: true, enabled: installed.enabled, previous: installed.previous, compatibility:installed.compatibility, compatible:installed.compatible??installed.compatibility?.compatible??saved.compatible??true, reasons:installed.compatibility?.reasons??saved.reasons??[], activation: installed.activation}];}); }
