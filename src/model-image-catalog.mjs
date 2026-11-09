// Exact model identities checked against official documentation. This is model
// capability evidence, not a claim that an account or forwarding endpoint works.
const checkedAt='2026-11-08';
const source='official-documentation';
const row=(provider,model,imageInput,protocols,sourceUrl)=>Object.freeze({provider,model,imageInput,protocols:Object.freeze(protocols),source,sourceUrl,checkedAt});
const deepseek='https://api-docs.deepseek.com/guides/vision/';
const claude='https://platform.claude.com/docs/en/models/overview';
const qwen='https://help.aliyun.com/zh/model-studio/text-generation-model';
const qwenVision='https://help.aliyun.com/zh/model-studio/vision-model/';
const kimi='https://platform.kimi.ai/docs/guide/use-kimi-vision-model';
const minimax='https://platform.minimax.io/docs/api-reference/text-openai-api';
const doubao='https://docs.volcengine.com/docs/lake-ai-service/multi-modal-machine-learning-deep-thinking-doubao-seed-2?lang=en';
const deepseekProtocols=['openai-chat','openai-responses','anthropic-messages'];
export const MODEL_IMAGE_CATALOG=Object.freeze([
 row('deepseek','deepseek-flash','supported',deepseekProtocols,deepseek),
 row('deepseek','deepseek-v4-flash-vision-exp','supported',deepseekProtocols,deepseek),
 row('deepseek','deepseek-v4-flash','supported',deepseekProtocols,deepseek),
 row('deepseek','deepseek-v4-pro','unknown',[], 'https://api-docs.deepseek.com/'),
 row('openai','gpt-6.1-terra','supported',['openai-responses'],'https://developers.openai.com/api/docs/models/gpt-6.1-terra'),
 row('openai','gpt-6.1-sol','supported',['openai-responses'],'https://developers.openai.com/api/docs/models/gpt-6.1-sol'),
 row('openai','gpt-5.6-luna','supported',['openai-responses'],'https://developers.openai.com/api/docs/models/gpt-5.6-luna'),
 row('openai','gpt-6-astra','supported',['openai-responses'],'https://developers.openai.com/api/docs/models'),
 row('openai','gpt-6-luna','supported',['openai-responses'],'https://developers.openai.com/api/docs/models'),
 row('anthropic','claude-fable-5-1','supported',['anthropic-messages'],claude),
 row('anthropic','claude-opus-5-5','supported',['anthropic-messages'],claude),
 row('anthropic','claude-sonnet-5-5','supported',['anthropic-messages'],claude),
 row('anthropic','claude-haiku-5-5','supported',['anthropic-messages'],claude),
 row('google','gemini-3.8-flash','supported',['gemini-interactions'],'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash'),
 row('xai','grok-4.6','supported',['openai-responses'],'https://docs.x.ai/developers/models/grok-4.6'),
 row('xai','grok-4.7','supported',['openai-responses'],'https://docs.x.ai/developers/model-capabilities/images/understanding'),
 row('qwen','qwen3.8-max','supported',['openai-chat'],qwen),
 row('qwen','qwen3.8-flash','supported',['openai-chat'],qwen),
 row('qwen','qwen3.7-plus','supported',['openai-chat'],qwen),
 row('qwen','qwen3.5-plus','supported',['openai-chat'],qwenVision),
 row('qwen','qwen3-vl-plus','supported',['openai-chat'],qwenVision),
 row('qwen','qwen3-vl-flash','supported',['openai-chat'],qwenVision),
 row('moonshot','kimi-k3.1-pro','supported',['openai-chat'],kimi),
 row('moonshot','kimi-k3.1-pro-highspeed','supported',['openai-chat'],'https://platform.kimi.ai/docs/models'),
 row('moonshot','kimi-k3','supported',['openai-chat'],kimi),
 row('moonshot','kimi-k2.7-code','supported',['openai-chat'],kimi),
 row('moonshot','kimi-k2.6','supported',['openai-chat'],kimi),
 row('zhipu','glm-5.3-flash','supported',['openai-chat'],'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'),
 row('zhipu','glm-5.3-flashx','supported',['openai-chat'],'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'),
 row('zhipu','glm-4.6v','supported',['openai-chat'],'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v'),
 row('zhipu','glm-5.3','unsupported',[],'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3'),
 row('zhipu','glm-5.2','unsupported',[],'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2'),
 row('minimax','MiniMax-M3.1-Flash','supported',['openai-chat','anthropic-messages'],minimax),
 row('minimax','MiniMax-M3','supported',['openai-chat','anthropic-messages'],minimax),
 row('volcengine','doubao-seed-2-0-pro-260215','supported',['ark-chat'],doubao),
 row('volcengine','doubao-seed-2-0-lite-260215','supported',['ark-chat'],doubao),
 row('volcengine','doubao-seed-2-0-mini-260215','supported',['ark-chat'],doubao),
]);
const records=new Map(MODEL_IMAGE_CATALOG.map(record=>[record.provider+'\0'+record.model,record]));
const kinds={codex:'openai',openai:'openai',claude:'anthropic',gemini:'google',grok:'xai',kimi:'moonshot',deepseek:'deepseek',qwen:'qwen',minimax:'minimax',zhipu:'zhipu',volcengine:'volcengine'};
const hosts={
 'api.openai.com':'openai','api.anthropic.com':'anthropic','generativelanguage.googleapis.com':'google',
 'api.deepseek.com':'deepseek','api.x.ai':'xai','api.moonshot.ai':'moonshot','api.moonshot.cn':'moonshot','api.kimi.ai':'moonshot','api.kimi.com':'moonshot',
 'dashscope.aliyuncs.com':'qwen','dashscope-intl.aliyuncs.com':'qwen','dashscope-us.aliyuncs.com':'qwen',
 'open.bigmodel.cn':'zhipu','api.z.ai':'zhipu','api.minimax.io':'minimax','api.minimaxi.com':'minimax','ark.cn-beijing.volces.com':'volcengine',
};
const transports=new Set(['codex','chat-completions','responses','anthropic','gemini']);
function providerIdentity(profile){
 if(Object.hasOwn(kinds,profile?.kind))return kinds[profile.kind];
 try{const url=new URL(profile?.baseUrl);if(url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&Object.hasOwn(hosts,url.hostname))return hosts[url.hostname];}catch{}
 return null;
}
function protocolIdentity(protocol,provider){
 return protocol==='responses'?'openai-responses':protocol==='chat-completions'?provider==='volcengine'?'ark-chat':'openai-chat':protocol==='anthropic'?'anthropic-messages':protocol==='gemini'?'gemini-generate-content':null;
}
export function imageInputCapability(profile){
 const model=typeof profile?.model==='string'?profile.model:'',provider=providerIdentity(profile),protocol=profile?.protocol??profile?.kind??null;
 // One confirmed local spelling alias affects lookup only. Requests keep model.
 const catalogModel=provider==='xai'&&model==='grok4.6'?'grok-4.6':model;
 const selected=profile?.models?.find(record=>record.id===model||record.model===model),modalities=selected?.inputModalities??selected?.input_modalities;
 const declared=Array.isArray(modalities)&&modalities.every(value=>['text','image','audio','video'].includes(value))?modalities:null;
 const record=records.get(provider+'\0'+catalogModel),documented=record?.imageInput==='supported'||record?.imageInput==='unsupported';
 // Endpoint model-list metadata is a connection declaration, not a user image
 // ban or a replacement for a documented exact model's modality conclusion.
 const declaredImageInput=declared?declared.includes('image')?'supported':'unsupported':null,useDeclaration=!documented&&declared!==null;
 const imageInput=documented?record.imageInput:declaredImageInput??record?.imageInput??'unknown';
 // Native Codex has its own image URL input adapter in codex-provider.mjs.
 // Its transport evidence is independent of the HTTP Responses protocol.
 const documentedTransport=protocol==='codex'?profile?.kind==='codex'&&provider==='openai':record?.protocols.includes(protocolIdentity(protocol,provider))===true;
 const transportSupported=transports.has(protocol)&&(useDeclaration||documentedTransport);
 const reason=imageInput==='unknown'?'MODEL_IMAGE_CAPABILITY_UNKNOWN':imageInput==='unsupported'?'MODEL_IMAGE_UNSUPPORTED':!transportSupported?'MODEL_IMAGE_TRANSPORT_UNSUPPORTED':null;
 return {supported:reason===null,reason,imageInput,provider,model,catalogModel,protocol,transportSupported,transportSource:transportSupported?protocol==='codex'?'host-codex-image-adapter':useDeclaration?'model-catalog':'official-documentation':null,source:useDeclaration?'model-catalog':record?.source??'unknown',sourceUrl:useDeclaration?null:record?.sourceUrl??null,checkedAt:useDeclaration?null:record?.checkedAt??null,declaredImageInput,declarationSource:declared?'endpoint-model-catalog':null,declarationConflict:documented&&declaredImageInput!==null&&declaredImageInput!==record.imageInput};
}
