import {providerFor} from './token-types.mjs';
export const PLATFORM_NAMES=Object.freeze({openai:'OpenAI',anthropic:'Anthropic',google:'Google',zhipu:'智谱 / Z.ai',moonshot:'Moonshot / Kimi',deepseek:'DeepSeek',qwen:'阿里云百炼 / 通义',volcengine:'火山方舟 / 豆包',xai:'xAI / Grok',minimax:'MiniMax',openrouter:'OpenRouter',azure:'Azure',bedrock:'Amazon Bedrock',vertex:'Vertex AI',siliconflow:'硅基流动',groq:'Groq',mistral:'Mistral',together:'Together AI',fireworks:'Fireworks AI',deepinfra:'DeepInfra'});
const aliases={gemini:'google',claude:'anthropic',kimi:'moonshot',grok:'xai',wan:'qwen',alibaba:'qwen',aliyun:'qwen',dashscope:'qwen','z-ai':'zhipu','z.ai':'zhipu',zai:'zhipu',glm:'zhipu',zhipuai:'zhipu',moonshotai:'moonshot','amazon-bedrock':'bedrock','google-vertex':'vertex','azure-openai':'azure','togetherai':'together','fireworks-ai':'fireworks','deepseek-account':'deepseek','kimi-for-coding':'moonshot','zhipuai-coding-plan':'zhipu','minimax-coding-plan':'minimax'};
export function platformId(raw,sourceId='unscoped') {if(String(raw||'').startsWith('custom:'))return raw;const value=String(raw||'').trim().toLowerCase();if(!value||['unknown','codex','custom','openai-compatible','chat-completions','responses','openai-images'].includes(value))return value==='custom'?'custom:'+encodeURIComponent(sourceId)+':custom':'unknown';return aliases[value]|| (Object.hasOwn(PLATFORM_NAMES,value)||value.startsWith('custom:')?value:'custom:'+encodeURIComponent(sourceId)+':'+encodeURIComponent(value));}
export function platformLabel(id){return PLATFORM_NAMES[id]|| (id==='unknown'?'服务平台未确认':String(id||'服务平台未确认').startsWith('custom:')?decodeURIComponent(id.split(':').slice(2).join(':'))+'（自定义）':id);}
export const BILLING_ROUTES={unknown:'未确认',api:'API',subscription:'账号订阅',account:'账号模式','coding-plan':'Coding Plan',proxy:'中转 API'};
const hosts={ 'api.openai.com':'openai','api.anthropic.com':'anthropic','generativelanguage.googleapis.com':'google','api.deepseek.com':'deepseek','api.moonshot.ai':'moonshot','api.moonshot.cn':'moonshot','api.x.ai':'xai','dashscope.aliyuncs.com':'qwen','dashscope-intl.aliyuncs.com':'qwen','open.bigmodel.cn':'zhipu','api.z.ai':'zhipu','api.minimax.io':'minimax','api.minimaxi.com':'minimax','openrouter.ai':'openrouter','api.siliconflow.cn':'siliconflow','api.siliconflow.com':'siliconflow','api.groq.com':'groq','api.mistral.ai':'mistral','api.together.xyz':'together','api.together.ai':'together','api.fireworks.ai':'fireworks','api.deepinfra.com':'deepinfra','ark.cn-beijing.volces.com':'volcengine'};
export function connectionIdentity(profile){
 const source=profile.id||'connection',protocol=profile.protocol||profile.kind;
 if(profile.kind==='codex')return {version:1,profileId:source,protocol,servicePlatform:'unknown',channel:'codex',billingRoute:'unknown',basis:'Codex 本机登录；未提供服务平台'};
 let address='',host='',pathname='';try{const u=new URL(profile.baseUrl);host=u.hostname.toLowerCase();pathname=u.pathname;address=u.origin;}catch{}
 let platform=hosts[host]||(host.endsWith('.openai.azure.com')?'azure':host.endsWith('-aiplatform.googleapis.com')?'vertex':null);
 const servicePlatform=platform||'custom:'+encodeURIComponent(source)+':'+encodeURIComponent(host||'custom');
 const billingRoute=platform?(/coding/i.test(pathname)?'coding-plan':'api'):'proxy';
 return {version:1,profileId:source,protocol,servicePlatform,channel:'api',billingRoute,address,basis:'请求时保存的连接地址'};
}
export function resolveIdentity(row,source={}){
 const saved=row.connectionIdentity,raw=String(row.actualProvider&&row.actualProvider!=='unknown'?row.actualProvider:row.reportedProvider||'');
 const rawChannel=saved?.channel||row.rawChannel||raw||'unknown';
 let platform=saved?.servicePlatform||platformId(raw,row.sourceId||source.id),channel=saved?.channel||(raw==='codex'?'codex':raw==='deepseek-account'?'deepseek-account':raw||'unknown'),billingRoute=saved?.billingRoute||row.billingRoute||'unknown',basis=saved?.basis||(platform!=='unknown'?'日志提供方字段':'日志未提供服务平台'),assignment='recorded';
 // Old companion records stored connection kinds, not service addresses.
 if(row.tool==='companion'&&!saved){platform='unknown';basis='旧记录仅保存调用通道';}
 if(raw==='deepseek-account')billingRoute='account';
 if(/coding-plan|for-coding/.test(raw))billingRoute='coding-plan';
 if(platform==='unknown'&&source.aliasProvider){platform=platformId(source.aliasProvider,source.id);basis='来源设置：仅补充未知平台';assignment='user';}
 return {serviceProvider:platform,servicePlatform:platform,modelVendor:providerFor(String(row.model||'').split('/').at(-1)),rawProvider:raw,rawChannel,channel,billingRoute,identityBasis:basis,identityAssignment:assignment,connectionIdentity:saved};
}
export function platformCatalog(observed=[],custom={}){for(const id of observed)if(id.startsWith('custom:')){const raw=decodeURIComponent(id.split(':').slice(2).join(':'));if(custom[raw])custom={...custom,[id]:custom[raw]};}return [...new Set([...Object.keys(PLATFORM_NAMES),...observed,...Object.keys(custom)])].filter(id=>id!=='codex').map(id=>({id,name:custom[id]||platformLabel(id),observed:observed.includes(id)}));}
