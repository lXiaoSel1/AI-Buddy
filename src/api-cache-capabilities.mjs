import {presetFor} from './model-presets.mjs';

const PRIVATE_SESSION_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// https://platform.kimi.ai/docs/api/chat.md (2026-11-17)
const KIMI_WRITE_MODELS=new Set(['kimi-k3.1-pro','kimi-k3.1-pro-highspeed','kimi-k3']);

export function officialCacheProvider(profile){
  const preset=presetFor(profile.kind);
  if(!preset?.baseUrl||profile.protocol!==preset.protocol)return null;
  if(profile.baseUrl===preset.baseUrl||profile.kind==='kimi'&&profile.baseUrl==='https://api.moonshot.cn/v1')return profile.kind;
  return null;
}

export function supportsKimiCacheTtl(profile){
  return officialCacheProvider(profile)==='kimi'&&KIMI_WRITE_MODELS.has(profile.model);
}

const DEEPSEEK_LONG_HISTORY=new Set(['deepseek-flash','deepseek-v4-flash','deepseek-v4-pro']);
const STANDARD_HISTORY_PROVIDERS=new Set(['kimi','openai','grok','claude']);
const LONG_HISTORY=Object.freeze({triggerTokens:32000,targetTokens:12800,summaryMaxChars:1350,summaryMaxBytes:4096});
const STANDARD_HISTORY=Object.freeze({triggerTokens:16000,targetTokens:8000,summaryMaxChars:900,summaryMaxBytes:3072});
const DEFAULT_HISTORY=Object.freeze({triggerTokens:8000,targetTokens:3200,summaryMaxChars:600,summaryMaxBytes:2048});

function officialHistoryProvider(profile){
  if(profile.kind==='deepseek'&&
     (profile.protocol==='chat-completions'||profile.protocol==='responses')&&
     (profile.baseUrl==='https://api.deepseek.com'||profile.baseUrl==='https://api.deepseek.com/v1'))return 'deepseek';
  if(profile.kind==='openai'&&profile.protocol==='chat-completions'&&profile.baseUrl==='https://api.openai.com/v1')return 'openai';
  return officialCacheProvider(profile);
}

export function privateHistoryPolicy(profile){
  if(!profile)return DEFAULT_HISTORY;
  if(profile.kind==='codex'&&profile.protocol==='codex')return STANDARD_HISTORY;
  const provider=officialHistoryProvider(profile);
  if(provider==='deepseek'&&DEEPSEEK_LONG_HISTORY.has(profile.model))return LONG_HISTORY;
  return STANDARD_HISTORY_PROVIDERS.has(provider)?STANDARD_HISTORY:DEFAULT_HISTORY;
}

export function summaryCacheOptions(profile){
  const provider=officialCacheProvider(profile);
  if(provider==='deepseek')return {thinking:{type:'disabled'}};
  if(provider==='kimi'&&KIMI_WRITE_MODELS.has(profile.model))return {reasoning_effort:'low'};
  return {};
}

export function requestCacheOptions(profile,context){
  if(context?.version!==1||context.kind!=='private'||typeof context.sessionUuid!=='string'||!PRIVATE_SESSION_UUID.test(context.sessionUuid)||typeof context.scopeKey!=='string'||!context.scopeKey.trim())return {};
  const key=context.sessionUuid;
  switch(officialCacheProvider(profile)){
    case 'kimi': {
      const ttl=profile.kimiCacheTtl==='1h'&&supportsKimiCacheTtl(profile)?'1h':'5m';
      return {requestedCacheTtl:ttl,body:{prompt_cache_key:key,...(ttl==='1h'?{prompt_cache_options:{mode:'implicit',ttl}}:{})}};
    }
    // OpenAI routes newer models automatically and accepts the key for cache accounting.
    case 'openai': return {body:{prompt_cache_key:key}};
    case 'grok': return {headers:{'x-grok-conv-id':key}};
    case 'claude': return {body:{cache_control:{type:'ephemeral'}}};
    default: return {};
  }
}
