export const CG_PROTOCOLS=Object.freeze(['openai-images','gemini-images','wan-image','wan-t2i','wan-t2i-legacy']);
export const CG_PROTOCOL_NAMES=Object.freeze({'openai-images':'OpenAI Images 兼容','gemini-images':'Gemini Interactions','wan-image':'万相图像生成与编辑','wan-t2i':'万相文生图异步','wan-t2i-legacy':'万相旧版文生图异步'});
export const CG_PRESETS=Object.freeze([
 {kind:'codex',name:'Codex 内置图像',protocol:'codex',baseUrl:'',references:true},
 {kind:'openai',name:'OpenAI Images',protocol:'openai-images',baseUrl:'https://api.openai.com/v1',references:true},
 {kind:'gemini',name:'Gemini / Nano Banana',protocol:'gemini-images',baseUrl:'https://generativelanguage.googleapis.com/v1beta',references:true},
 {kind:'wan',name:'通义万相',protocol:'wan-image',baseUrl:'https://dashscope.aliyuncs.com',references:true},
 {kind:'custom',name:'自定义绘图接口',protocol:'openai-images',baseUrl:'',references:false},
]);
export function cgOptions(value={}){
 const references=value.references!==false,size=String(value.size??'').trim(),quality=String(value.quality??'auto').trim();
 if(size.length>50||quality.length>30||!/^[-\w*:. ]*$/.test(size)||!/^[-\w]*$/.test(quality))throw Error('图片尺寸或质量参数无效');
 return {references,size,quality};
}
