import {cleanDialogueReferences} from './reply-references.mjs';
// Legacy host provenance was once prefixed to assistant examples. Only this
// precise, unquoted leading format is a presentation fallback; raw receipts stay intact.
const kinds=['character-statement','shared-dialogue','user-report','personal-activity','proactive-expression','selftalk','dream'];
const scopePattern=/^(?:personal|persona:[a-zA-Z0-9_.:-]{1,200}|group:[a-zA-Z0-9_.:-]{1,200}|work:[a-f0-9]{64}|social:[a-f0-9]{64})$/;
const scopePrefix=value=>['personal','persona:','group:','work:','social:'].some(base=>base.startsWith(value)||value.startsWith(base)&&(['work:','social:'].includes(base)?/^[a-f0-9]{0,64}$/:/^[a-zA-Z0-9_.:-]{0,200}$/).test(value.slice(base.length)));
const unknown='原始日期未知；迁移记录日 ';
function labelState(body){
 if(!body.startsWith('['))return {kind:'text'};
 let rest=body.slice(1);
 if(rest.startsWith('原')){if(unknown.startsWith(rest))return {kind:'pending'};if(!rest.startsWith(unknown))return {kind:'text'};rest=rest.slice(unknown.length);}
 const dateShape='dddd-dd-dd';for(let i=0;i<Math.min(rest.length,10);i++)if(dateShape[i]==='d'?!/[0-9]/.test(rest[i]):rest[i]!==dateShape[i])return {kind:'text'};
 if(rest.length<10)return {kind:'pending'};
 const day=rest.slice(0,10),date=new Date(day+'T12:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)return {kind:'text'};
 rest=rest.slice(10);if('; '.startsWith(rest))return {kind:'pending'};if(!rest.startsWith('; '))return {kind:'text'};rest=rest.slice(2);
 const separator=rest.indexOf('; ');if(separator<0)return {kind:kinds.some(kind=>(kind+'; ').startsWith(rest))?'pending':'text'};
 if(!kinds.includes(rest.slice(0,separator)))return {kind:'text'};rest=rest.slice(separator+2);
 const end=rest.indexOf(']');if(end<0)return {kind:scopePrefix(rest)||!rest?'pending':'text'};
 if(!scopePattern.test(rest.slice(0,end)))return {kind:'text'};
 return {kind:'label',length:body.length-rest.length+end+1};
}
function visible(raw,final,preserveLiteral){
 if(preserveLiteral)return raw;
 let value=raw;
 while(true){const leading=value.match(/^\s*/)[0],body=value.slice(leading.length),state=labelState(body);
  if(state.kind==='pending')return final?value:'';
  if(state.kind!=='label')return value;
  value=body.slice(state.length).replace(/^\s*/,'');
 }
}
// A user quoting this exact syntax is not an accidental machine-prefix leak.
export function replySourceLiteralRequested(query){
 const text=String(query??'');let complete=false;
 const intent=text.replace(/\[(?:原始日期未知；迁移记录日 )?\d{4}-\d{2}-\d{2}; [^\]\n]{1,300}\]/g,label=>{if(labelState(label).kind!=='label')return label;complete=true;return '〔内部标签〕';});
 if(!complete)return false;
 const negated=/(?:不要|别|禁止|无需|不用|不必|不准|不再|不想|不希望|停止|取消)[^。！？\n]{0,24}(?:原样|逐字|引用|照抄|复制|复述|输出|显示|出现|保留|标签|前缀)|\b(?:do\s+not|don't|never|avoid|stop|without)\b[^.!?\n]{0,32}\b(?:quot\w*|copy|reproduc\w*|print|output|show|include|keep|tag|label|prefix|verbatim|literal)\b/iu.test(intent);
 const removal=/(?:删(?:除|掉|去)?|去掉|移除|隐藏|过滤|清理)[^。！？\n]{0,24}(?:标签|前缀|来源)|(?:标签|前缀|来源)[^。！？\n]{0,24}(?:删(?:除|掉|去)?|去掉|移除|隐藏|过滤)|\b(?:remove|delete|omit|hide|strip)\b[^.!?\n]{0,32}\b(?:label|tag|prefix)\b/iu.test(intent);
 const complaint=/(?:为什么|为何|怎么|上次|刚才)[^。！？\n]{0,24}(?:又|引用|输出|显示)|(?:不(?:是|想要)|不是我要的)[^。！？\n]{0,16}(?:标签|内容)|\b(?:why|previously|last time)\b[^.!?\n]{0,40}\b(?:quote|label|tag|prefix)\b/iu.test(intent);
 if(negated||removal||complaint)return false;
 return /(?:^|[。！？\n])\s*(?:原样|逐字|引用|照抄|复制|复述)|(?:请(?:你)?|麻烦(?:你)?|帮我|能否|可以|给我|我要|我想|我需要|务必)\s*(?:原样|逐字|引用|照抄|复制|复述|(?:输出|展示|显示|保留)[^。！？\n]{0,16}(?:标签|前缀))|(?:把|将)[^。！？\n]{0,40}(?:原样|逐字|照抄)|(?:^|\b(?:please|could you|can you|would you|i (?:want|need) you to)\s+)\s*(?:literally\s+)?(?:quote|copy|reproduce|print|output|show|include|keep|return)\b/iu.test(intent);
}
export function filterReplySourceLabels(text,{preserveLiteral=false,requestText=''}={}){return cleanDialogueReferences(visible(String(text??''),true,preserveLiteral||replySourceLiteralRequested(requestText)),{preserveLiteral,requestText});}
export function createReplySourceFilter({preserveLiteral=false,requestText=''}={}){let raw='';const keep=preserveLiteral||replySourceLiteralRequested(requestText);return {feed(delta){raw+=String(delta??'');return cleanDialogueReferences(visible(raw,false,keep),{preserveLiteral,requestText,final:false});},finish(){return cleanDialogueReferences(visible(raw,true,keep),{preserveLiteral,requestText});}};}
