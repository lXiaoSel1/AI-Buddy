import {localEndpoint} from './buddy-plugin-services/social-accounts.mjs';

// Advanced connections may be mounted below /api rather than at the origin.
// Action names are internal identifiers, never URL paths supplied by a model.
export function qqOneBotUrl(endpoint,action){
 if(typeof action!=='string'||!/^[a-z][a-z0-9_]*$/.test(action))throw Object.assign(Error('QQ_ACTION_INVALID'),{code:'QQ_ACTION_INVALID'});
 const url=new URL(localEndpoint(endpoint,['http:','https:']));
 url.pathname=url.pathname.replace(/\/+$/,'')+'/'+action;return url;
}
