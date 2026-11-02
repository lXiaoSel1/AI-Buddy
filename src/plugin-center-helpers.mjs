import {locale} from './i18n.mjs';
const errorMessages = {
  COMMUNITY_QUEUE_CAPACITY: ['维护记录已达到容量上限，暂不能新增任务；现有记录会保留。', 'The maintenance history is full. New tasks cannot be added; existing records are retained.'],
  COMMUNITY_SOURCE_UNAVAILABLE: ['此来源已停用、移除或暂不可用，请检查来源设置。', 'This source is disabled, removed or unavailable. Check the source settings.'],
  COMMUNITY_SOURCE_CHANGED: ['来源在读取期间发生变化，请重新检查来源后重试。', 'The source changed while loading. Check the source and try again.'],
};
export function pluginResult(value) {
  if (!value?.error) return value;
  const error = value.error;
  throw Object.assign(Error(typeof error === 'string' ? error : error.message ?? error.code ?? 'Extension request failed'), typeof error === 'object' ? {code: error.code, details: error.details} : {});
}
export function pluginErrorText(error, language = locale()) { const messages = errorMessages[error?.code ?? error?.error?.code]; return messages ? messages[language === 'en' ? 1 : 0] : typeof error === 'string' ? error : error?.message ?? error?.error?.message ?? error?.code ?? 'Extension request failed'; }
export function pluginSourceId(row) { return row?.sourceId ?? row?.source?.sourceId ?? 'legacy'; }
export function pluginRowKey(row) { return [pluginSourceId(row), row.manifest.id, row.manifest.version].join(':'); }
export function pluginSearchText(row) { const m = row.manifest ?? {}; return [m.name, m.id, m.description, m.author, ...(m.tags ?? [])].filter(Boolean).join(' ').toLowerCase(); }
export function filterLegacyPlugins(rows, {query = '', sourceId = '', kind = 'all', page = 1, pageSize = 50} = {}) {
  const needle = query.trim().toLowerCase(), matched = rows.filter(row => (!sourceId || pluginSourceId(row) === sourceId) && (kind === 'installed' ? row.installed : row.source?.enabled !== false && !row.source?.removed) && (kind === 'all' || kind === 'installed' || row.manifest.kind === kind) && (!needle || pluginSearchText(row).includes(needle)));
  pageSize = Math.min(50, Math.max(1, pageSize)); return {items: matched.slice((page - 1) * pageSize, page * pageSize), total: matched.length, page, pageSize};
}
export function pluginActivation(row) {
  const value=row.activation??{supported:false,usable:false,state:row.manifest?.kind==='runtime'?'dependency':'unverified'};
  if(value.state==='ready'&&(!value.usable||!row.installed||!row.current||!row.enabled))return {...value,usable:false,state:'unverified'};
  return value;
}
export function installedPluginRows(state) { return Object.entries(state?.installed ?? {}).flatMap(([id, installed]) => {const saved = installed.versions?.[installed.current]; if (!saved?.manifest) return [];return [{sourceId: installed.sourceId ?? saved.sourceId ?? 'legacy', source: installed.source ?? saved.source, manifest: saved.manifest, archive: saved.archive, current: true, installed: true, enabled: installed.enabled, previous: installed.previous, compatible: true, reasons: [], activation: installed.activation}];}); }
