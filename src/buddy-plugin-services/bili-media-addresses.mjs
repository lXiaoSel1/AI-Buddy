const standardHost = /(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com)$/;
const mcdnHost = /(^|\.)mcdn\.bilivideo\.cn$/;
const edgeHost = /(^|\.)[a-z0-9-]+\.edge\.mountaintoys\.cn$/;

function denied() {
  return Object.assign(Error('BILI_MEDIA_ORIGIN'), {code:'BILI_MEDIA_ORIGIN'});
}

export function mediaUrl(raw) {
  if (typeof raw !== 'string' || !raw) throw denied();
  let url;
  try { url = new URL(raw); } catch { throw denied(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw denied();
  const {hostname, port} = url;
  const allowed = !port && (standardHost.test(hostname) || hostname === 'upos-hz-mirrorakam.akamaized.net') ||
    port === '8082' && mcdnHost.test(hostname) || port === '4483' && edgeHost.test(hostname);
  if (!allowed) throw denied();
  return url.href;
}

export function mediaCandidates(track, validate = mediaUrl) {
  if (!track) return [];
  const primary = track.baseUrl || track.base_url ? [track.baseUrl,track.base_url] : [track.url];
  const backups = [track.backupUrl, track.backup_url].flatMap(value => Array.isArray(value) ? value : []);
  const urls = new Map();
  for (const raw of [...primary, ...backups]) {
    if (typeof raw !== 'string' || !raw) continue;
    let url;
    try { url = validate(raw); }
    catch (error) {
      if (error.code !== 'BILI_MEDIA_ORIGIN') throw error;
      continue;
    }
    if (!urls.has(url)) {
      const endpoint = new URL(url);
      const port = Number(endpoint.port || 443);
      const priority = port === 8082 ? 1 : port === 4483 ? 2 : 0;
      urls.set(url, {url, port, priority, node: priority === 1 ? 'mcdn' : priority === 2 ? 'edge' : 'standard'});
    }
  }
  return [...urls.values()].sort((a,b) => a.priority - b.priority).slice(0,3);
}
