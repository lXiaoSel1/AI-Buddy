// A response style is guidance, never an output budget or a character-card edit.
export const REPLY_STYLES=Object.freeze(['brief','natural','detailed']);
export const normalizeReplyStyle=value=>REPLY_STYLES.includes(value)?value:'natural';
export function resolveReplyStyle({globalStyle='natural',defaultStyle='inherit',conversationStyle='inherit'}={}){
 if(REPLY_STYLES.includes(conversationStyle))return {style:conversationStyle,source:'conversation'};
 if(REPLY_STYLES.includes(defaultStyle))return {style:defaultStyle,source:'qq-default'};
 return {style:normalizeReplyStyle(globalStyle),source:'global'};
}
export function replyStyleInstruction(value,language='zh-CN'){
 const style=normalizeReplyStyle(value);
 const description=language==='en'?{
  brief:'Reply style: brief. Give the direct answer first, then only the context needed to understand it. Prefer a compact response for ordinary conversation; omit repeated summaries, lengthy setup, and unrequested advice or follow-up questions. Keep necessary meaning complete.',
  natural:'Reply style: natural. Match the amount of detail to the topic’s complexity and the user’s engagement. Respond conversationally, adding reasons or examples where helpful; use multiple sentences or paragraphs when the topic calls for them.',
  detailed:'Reply style: detailed. Develop the response with relevant reasons, concrete details, examples, or steps as the topic calls for them. Connect the explanation clearly and use paragraphs for distinct points; avoid repetition, invented facts, and padding.',
 }:{
  brief:'回复风格：简短。先直接回答，再补理解所必需的信息。日常聊天优先紧凑表达，省去长铺垫、重复总结、未请求的建议和追问；必要意思仍须完整。',
  natural:'回复风格：自然。篇幅与话题复杂程度和用户投入相匹配，像日常交谈一样回应；有帮助时补理由或例子，需要时用多句、分段展开。',
  detailed:'回复风格：详细。按话题需要展开理由、具体细节、例子或步骤，说明各点之间的联系；不同要点适当分段，不重复、不编造事实、不凑长度。',
 };
 return description[style]+(language==='en'
  ?' Keep your character’s voice. The current user’s explicit request about length or detail takes precedence over this general style, including requests to expand a brief reply or shorten a detailed reply. This style imposes no fixed word, sentence, or token count.'
  :' 保留角色口吻；当前用户明确提出的篇幅或详略要求优先于这项一般风格，包括要求简短档展开说明、详细档压缩回应。不规定固定字数、句数或 token 数。');
}
