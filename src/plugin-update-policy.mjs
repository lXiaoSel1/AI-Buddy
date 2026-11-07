import {compareVersions, parsePluginVersion} from './plugin-manifest.mjs';

export function selectStableUpdate(releases, current, compatible, versionOf = value => value.version) {
  const newer = releases.filter(value => !parsePluginVersion(versionOf(value)).pre.length && compareVersions(versionOf(value), current) > 0)
    .sort((left, right) => compareVersions(versionOf(right), versionOf(left)));
  const target = newer.find(compatible);
  return target ? {target, compatible: true} : newer.length ? {target: newer[0], compatible: false} : null;
}

export function stablePatchUpdate(current, target) {
  const from = parsePluginVersion(current), to = parsePluginVersion(target);
  return !from.pre.length && !to.pre.length && from.core[0] === to.core[0] && from.core[1] === to.core[1] && to.core[2] > from.core[2];
}

export const legacyUpdateKey = (sourceId, id) => 'buddy-v1:' + sourceId + ':' + id;
