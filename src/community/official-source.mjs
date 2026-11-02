import {pluginSourceFingerprint} from '../plugin-sources.mjs';

export const OFFICIAL_COMMUNITY_CATALOG_URL = 'https://raw.githubusercontent.com/lXiaoSel1/AI-Buddy-Extensions/main/community/catalog-v1.json';
export const OFFICIAL_COMMUNITY_DESCRIPTOR_ID = 'ai-buddy.extensions';
export const OFFICIAL_COMMUNITY_FINGERPRINT = 'SHA256:ovVyMUaJlXZUkPRLjf4QBOlZUQ6Dm4Op83kvQAFvT7g';
const descriptorUrl = 'https://raw.githubusercontent.com/lXiaoSel1/AI-Buddy-Extensions/main/source.json';
const catalogUrl = 'https://raw.githubusercontent.com/lXiaoSel1/AI-Buddy-Extensions/main/catalog.json';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFLmFoAgOaffTLAwNJ+U1v0MK4iaTHbMZ+BjaidVla05';
// This alias belongs only to the exact built-in source. Remote metadata never extends this trust tuple.
export function isOfficialCommunitySource(source) {
  if (source?.sourceId !== 'official' || source.url !== descriptorUrl || source.catalogUrl !== catalogUrl || source.keyId !== 'ai-buddy-release' || source.publicKey !== publicKey || source.keyFingerprint !== OFFICIAL_COMMUNITY_FINGERPRINT || ![OFFICIAL_COMMUNITY_DESCRIPTOR_ID, 'ai-buddy-official'].includes(source.descriptorId)) return false;
  try { return pluginSourceFingerprint(source.publicKey) === OFFICIAL_COMMUNITY_FINGERPRINT; } catch { return false; }
}
export const normalizeCommunitySource = source => isOfficialCommunitySource(source) ? {...source, descriptorId: OFFICIAL_COMMUNITY_DESCRIPTOR_ID} : source;
