import {localEndpoint} from '../buddy-plugin-services/social-accounts.mjs';
import {manualQqSession} from '../qq-manual-connection.mjs';

const fail = code => { throw Object.assign(Error(code), {code}); };
const PLATFORMS = Object.freeze({'@ai-buddy/qq-connect': 'qq', '@ai-buddy/bilibili-companion': 'bilibili'});
/** 「检查并保存」 (B8): check an advanced connection before it is saved. Nothing is stored, enabled or sent;
 * the credential typed in (or, when editing, the one already saved) is used for this one check and never returned.
 * QQ: the configured loopback OneBot HTTP and WebSocket endpoints must answer as the given bot number.
 * Bilibili: a cookie is checked against Bilibili's own account endpoint; without one there is nothing to check. */
export async function checkSocialAccountDraft(input, {accounts, fetchImpl = globalThis.fetch, session = manualQqSession} = {}) {
  const platform = PLATFORMS[input?.pluginId];
  if (!platform || typeof input.accountId !== 'string' || !/^\d{1,20}$/.test(input.accountId.trim())) fail('SOCIAL_ACCOUNT_INVALID');
  const saved = input.ref ? accounts?.get?.(input.ref) : null;
  if (input.ref && (!saved || saved.pluginId !== input.pluginId)) fail('SOCIAL_ACCOUNT_UNKNOWN');
  const secret = input.secret ?? (saved ? accounts.secret(input.ref) : {});
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) fail('SOCIAL_SECRET_INVALID');
  const accountId = input.accountId.trim();
  if (platform === 'qq') {
    const draft = {accountId, httpUrl: localEndpoint(input.httpUrl ?? saved?.httpUrl, ['http:', 'https:']), webSocketUrl: localEndpoint(input.webSocketUrl ?? saved?.webSocketUrl, ['ws:', 'wss:'])};
    const live = session(draft, {accessToken: typeof secret.accessToken === 'string' ? secret.accessToken : ''});
    await live.verify(); await live.socket();
    return {checked: true, platform};
  }
  if (typeof secret.cookie !== 'string' || !secret.cookie) return {checked: false, platform, reason: 'no-cookie'};
  const response = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', {headers: {cookie: secret.cookie, referer: 'https://www.bilibili.com/'}, redirect: 'error', signal: AbortSignal.timeout(8000)});
  if (!response.ok) fail('SOCIAL_LOGIN_NETWORK_ERROR');
  const value = await response.json();
  if (value.code === -101) fail('SOCIAL_LOGIN_EXPIRED');
  if (value.code !== 0 || value.data?.isLogin !== true) fail('SOCIAL_LOGIN_NETWORK_ERROR');
  if (String(value.data.mid) !== accountId) fail('SOCIAL_LOGIN_IDENTITY_MISMATCH');
  return {checked: true, platform};
}
