export const CG_PROTOCOLS=Object.freeze(['openai-images','ark-images','gemini-images','wan-image','wan-t2i','wan-t2i-legacy']);
export const CG_PROTOCOL_NAMES=Object.freeze({'openai-images':'OpenAI Images 兼容','ark-images':'火山方舟 Seedream','gemini-images':'Gemini Interactions','wan-image':'万相图像生成与编辑','wan-t2i':'万相文生图异步','wan-t2i-legacy':'万相旧版文生图异步'});
export const CG_PRESETS=Object.freeze([
 {kind:'codex',name:'Codex 内置图像',protocol:'codex',baseUrl:'',references:true},
 {kind:'openai',name:'OpenAI Images',protocol:'openai-images',baseUrl:'https://api.openai.com/v1',references:true},
 {kind:'ark',name:'火山方舟 / Seedream',protocol:'ark-images',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'doubao-seedream-4-0-20260415',references:true},
 {kind:'gemini',name:'Gemini / Nano Banana',protocol:'gemini-images',baseUrl:'https://generativelanguage.googleapis.com/v1beta',references:true},
 {kind:'wan',name:'通义万相',protocol:'wan-image',baseUrl:'https://dashscope.aliyuncs.com',references:true},
 {kind:'custom',name:'自定义绘图接口',protocol:'openai-images',baseUrl:'',references:false},
]);
// Upgrade only the known official route. Custom gateways choose their protocol explicitly.
export function cgProtocol(profile){
 if(profile.protocol==='openai-images')try{const url=new URL(profile.baseUrl);if(url.hostname==='ark.cn-beijing.volces.com'&&url.pathname.replace(/\/$/,'')==='/api/v3')return 'ark-images';}catch{}
 return profile.protocol;
}
export function arkReferenceLimit(model){return /seedream-(4-0|4-5|5-0-lite|5-0-260128)/i.test(model??'')?14:10;}
export function cgOptions(value={}){
 const references=value.references!==false,size=String(value.size??'').trim(),quality=String(value.quality??'auto').trim();
 if(size.length>50||quality.length>30||!/^[-\w*:. ]*$/.test(size)||!/^[-\w]*$/.test(quality))throw Error('图片尺寸或质量参数无效');
 return {references,size,quality};
}
